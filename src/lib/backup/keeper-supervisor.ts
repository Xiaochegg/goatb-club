// ============================================================
// backup-keeper 监督者（2026-11-05 架构纠错）
// ============================================================
// 职责边界（重要）：
//   - 本模块只做「 keeper 是否存活 → 不存活则拉起」这一件事。
//   - 绝不注册任何备份定时器：全系统唯一调度器是
//     mini-services/backup-keeper（独立常驻 Bun 进程）。
//   - 平台事实：容器重置时项目目录被整体重建（仅 upload/ 挂载幸存），
//     容器内进程不可能存活；本监督者覆盖「重置后 dev 被拉起」的场景
//     —— dev 一启动就把 keeper 带回来，keeper 启动后按小时桶补位。
//   - 拉起方式：detached + unref（子进程脱管，dev 退出不影响 keeper）。
//   - 防重复：globalThis 单例 + /tmp 认领文件（60s TTL）+
//     keeper 自身的单例锁（/tmp/goatb-keeper.lock）三重防线。
//   - 本模块运行于 node 运行时，绝不 import scripts/lib/backup-core
//     （其依赖 bun:sqlite）。
// ============================================================

import { existsSync, readFileSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const KEEPER_STATUS_FILE = path.join(process.cwd(), 'upload/goatb-backups/KEEPER-STATUS.json');
const SPAWN_CLAIM_FILE = '/tmp/goatb-keeper-spawn.claim';
const SPAWN_CLAIM_TTL_MS = 60_000;
const HEARTBEAT_FRESH_MS = 15 * 60_000; // 心跳超过 15 分钟视为失联（正常 60s 一跳）

const g = globalThis as unknown as { __goatbKeeperSupervised?: boolean };

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 认领拉起权（/tmp O_EXCL + TTL，防 dev 多 worker / 多入口同时拉起） */
function claimSpawnOnce(): boolean {
  try {
    const fd = openSync(SPAWN_CLAIM_FILE, 'wx');
    writeSync(fd, String(Date.now()));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
    try {
      const t = Number(readFileSync(SPAWN_CLAIM_FILE, 'utf8').trim());
      const age = Date.now() - (Number.isFinite(t) ? t : 0);
      if (age < SPAWN_CLAIM_TTL_MS) return false;
      rmSync(SPAWN_CLAIM_FILE, { force: true });
      return claimSpawnOnce();
    } catch {
      return false;
    }
  }
}

interface KeeperStatusFile {
  pid?: number;
  updatedAt?: string;
  bootAt?: string;
  nextRunAt?: string | null;
}

function readKeeperStatus(): KeeperStatusFile | null {
  try {
    if (!existsSync(KEEPER_STATUS_FILE)) return null;
    return JSON.parse(readFileSync(KEEPER_STATUS_FILE, 'utf8')) as KeeperStatusFile;
  } catch {
    return null;
  }
}

/** keeper 是否存活：状态文件里 pid 活着 且 心跳新鲜 */
function keeperAlive(): boolean {
  const k = readKeeperStatus();
  if (!k?.pid) return false;
  const pid = Number(k.pid);
  if (!pidAlive(pid)) return false;
  if (!k.updatedAt) return false;
  const beat = Date.parse(k.updatedAt);
  return Number.isFinite(beat) && Date.now() - beat < HEARTBEAT_FRESH_MS;
}

/** 检查并在缺位时拉起（无 once-guard，供周期监督调用；认领文件防并发）。
 *  在位时静默返回 true；拉起时打印一次日志。 */
export function checkKeeperAlive(): boolean {
  try {
    if (keeperAlive()) return true;
    if (!claimSpawnOnce()) return false; // 其他入口刚拉起过，静默
    const child = spawn('bun', ['mini-services/backup-keeper/index.ts'], {
      cwd: process.cwd(),
      detached: true,   // 脱离 dev 进程组：dev 退出/重启不影响 keeper
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[keeper-supervisor] 巡检发现 keeper 缺位 → 已拉起（pid=${child.pid}，detached）`);
    return true;
  } catch (e) {
    console.warn(`[keeper-supervisor] 巡检拉起失败（不影响服务）：${(e as Error).message}`);
    return false;
  }
}

/** 在 Next.js 服务启动时调用；幂等，可安全重复调用 */
export function ensureKeeperAlive(): void {
  if (g.__goatbKeeperSupervised) return;
  g.__goatbKeeperSupervised = true;
  try {
    if (keeperAlive()) {
      const k = readKeeperStatus();
      console.log(`[keeper-supervisor] backup-keeper 存活（pid=${k?.pid}，心跳=${k?.updatedAt}），无需拉起`);
      return;
    }
    if (!claimSpawnOnce()) {
      console.log('[keeper-supervisor] 其他入口刚拉起过 keeper（认领文件持有中），跳过');
      return;
    }
    const child = spawn('bun', ['mini-services/backup-keeper/index.ts'], {
      cwd: process.cwd(),
      detached: true,   // 脱离 dev 进程组：dev 退出/重启不影响 keeper
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[keeper-supervisor] backup-keeper 不在位 → 已拉起（pid=${child.pid}，detached）`);
  } catch (e) {
    console.warn(`[keeper-supervisor] 拉起失败（不影响正常服务）：${(e as Error).message}`);
  }
}

/** 供 API/诊断读取 keeper 心跳（纯 fs） */
export function readKeeperHeartbeat(): { pid: number | null; alive: boolean; updatedAt: string | null; bootAt: string | null } {
  const k = readKeeperStatus();
  const pid = Number(k?.pid);
  const alive = Number.isFinite(pid) && pid > 0 && pidAlive(pid)
    && !!k?.updatedAt && Date.now() - Date.parse(k.updatedAt) < HEARTBEAT_FRESH_MS;
  return { pid: Number.isFinite(pid) ? pid : null, alive, updatedAt: k?.updatedAt ?? null, bootAt: k?.bootAt ?? null };
}
