// ============================================================
// GOATB 备份管理入口（2026-11-05 架构纠错版）
// ============================================================
// 职责边界（重要）：
//   - 本模块不再注册任何定时器。全系统唯一的「每小时第 1 分钟」
//     调度器是独立常驻进程 mini-services/backup-keeper；
//     其复活由 src/instrumentation.ts 监督。
//   - 本模块只保留两个能力：
//     1) getAutoBackupStatus() —— 透出 keeper 心跳 + 清单摘要
//        （供 GET /api/v1/admin/backup）
//     2) triggerAutoBackup(trigger) —— 管理员/前端发起的一次完整备份
//        （供 POST /api/v1/admin/backup；trigger ∈ manual/page-enter/auto-on，
//         执行体 = protect-db 子进程，锁与暂停避让由执行体统一收口）
//   - 三者均为管理员主动运维动作，不属于「调度器」，
//     不违反调度器单入口原则；真正的 5 分钟自动存档调度在
//     backup-keeper（每轮新鲜读 Config 开关，默认关）。
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'path';
// 自动存档停机标记（管理员指令 2026-11-10）：纯 node:fs 双运行时模块
// （backup-core 依赖 bun:sqlite 不可被 Node 侧导入，故停机模块独立成库）
import { readAutosaveHalt, type AutosaveHalt } from '../../../scripts/lib/autosave-halt';

// ---------- 路径常量 ----------
const PROJECT_ROOT = process.cwd();
const MANIFEST_LOCAL = path.join(PROJECT_ROOT, 'backups/LATEST-BACKUP-INFO.json');
const MANIFEST_OSS = path.join(PROJECT_ROOT, 'upload/goatb-backups/LATEST-BACKUP-INFO.json');
const KEEPER_STATUS_FILE = path.join(PROJECT_ROOT, 'upload/goatb-backups/KEEPER-STATUS.json');
const SCRIPT = 'scripts/protect-db.ts';
const SPAWN_TIMEOUT_MS = 180_000; // 子进程上限（VACUUM + OSS 回读留足余量）

export type BackupTrigger = 'manual' | 'page-enter' | 'auto-on';

export interface AutoBackupRunRecord {
  trigger: BackupTrigger;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  outcome?: 'valid' | 'quarantine' | 'reject' | 'error' | 'unknown';
  backupFile?: string;
  latestValid?: string | null;
  playerCount?: number;
  outputTail?: string;
}

export interface AutoBackupStatus {
  enabled: boolean;
  scheduler: string;
  schedulerPid: number | null;
  schedulerHeartbeatAt: string | null;
  startedAt: string | null;
  nextRunAt: string | null;
  lastRun: AutoBackupRunRecord | null;
  history: AutoBackupRunRecord[]; // keeper 最近 12 次
  manifestLatestValid: string | null;
  manifestUpdatedAt: string | null;
  autoSave: KeeperStatusFile['autoSave']; // 5 分钟自动存档事实（keeper 透出）
  autosaveHalt: AutosaveHalt | null;      // 停机标记事实（管理员核实前，自动家族请求被拒绝）
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface ManifestSummary {
  latestValid: string | null;
  updatedAt: string | null;
  newestEntry: {
    file: string;
    encryptedAt: string;
    status: string;
    playerCount?: number;
    trigger?: string;
  } | null;
  newestValidEntry: ManifestSummary['newestEntry'] | null;
}

/** 读取合并后的备份清单摘要（本地 + OSS，取 updatedAt 较新者；纯 fs，无 DB 依赖） */
export async function readManifestSummary(): Promise<ManifestSummary> {
  let best: { updatedAt: string; latestValid: string | null; newestEntry: ManifestSummary['newestEntry']; newestValidEntry: ManifestSummary['newestValidEntry'] } | null = null;
  for (const p of [MANIFEST_LOCAL, MANIFEST_OSS]) {
    try {
      if (!existsSync(p)) continue;
      const m = JSON.parse(await readFile(p, 'utf8'));
      if (m?.version !== 1) continue;
      const entryOf = (b: any): ManifestSummary['newestEntry'] => b ? {
        file: String(b.file ?? ''),
        encryptedAt: String(b.encryptedAt ?? ''),
        status: String(b.status ?? ''),
        playerCount: Number(b?.sourceStats?.Player ?? 0),
        trigger: b?.trigger ? String(b.trigger) : undefined,
      } : null;
      const cand = {
        updatedAt: String(m.updatedAt ?? ''),
        latestValid: (m.latestValid ?? null) as string | null,
        newestEntry: entryOf(Array.isArray(m.backups) ? m.backups[0] : null),
        newestValidEntry: entryOf(Array.isArray(m.backups) ? m.backups.find((b: any) => b?.status === 'valid') : null),
      };
      if (!best || cand.updatedAt > best.updatedAt) best = cand;
    } catch { /* 清单损坏时跳过该份 */ }
  }
  return {
    latestValid: best?.latestValid ?? null,
    updatedAt: best?.updatedAt ?? null,
    newestEntry: best?.newestEntry ?? null,
    newestValidEntry: best?.newestValidEntry ?? null,
  };
}

interface KeeperStatusFile {
  pid?: number;
  updatedAt?: string;
  bootAt?: string;
  nextRunAt?: string | null;
  lastRun?: AutoBackupRunRecord | null;
  history?: AutoBackupRunRecord[];
  autoSave?: {
    enabled: boolean;
    intervalMin?: number;
    configKey?: string;
    checkedAt?: string | null;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastTrigger?: string | null;
  } | null;
}

async function readKeeperStatus(): Promise<KeeperStatusFile | null> {
  try {
    if (!existsSync(KEEPER_STATUS_FILE)) return null;
    statSync(KEEPER_STATUS_FILE); // 确认可 stat（OSS 挂载健康）
    return JSON.parse(await readFile(KEEPER_STATUS_FILE, 'utf8')) as KeeperStatusFile;
  } catch {
    return null;
  }
}

/** 供 API 查询的状态：keeper 心跳事实 + 清单事实（无进程内状态） */
export async function getAutoBackupStatus(): Promise<AutoBackupStatus> {
  const manifest = await readManifestSummary();
  const keeper = await readKeeperStatus();
  const pid = Number(keeper?.pid);
  const alive = Number.isFinite(pid) && pid > 0 && pidAlive(pid);
  const fresh = !!keeper?.updatedAt
    && Number.isFinite(Date.parse(keeper.updatedAt))
    && Date.now() - Date.parse(keeper.updatedAt) < 15 * 60_000;
  return {
    enabled: alive && fresh,
    scheduler: 'mini-services/backup-keeper（唯一常驻调度器，每小时第 1 分钟）',
    schedulerPid: alive ? pid : null,
    schedulerHeartbeatAt: keeper?.updatedAt ?? null,
    startedAt: keeper?.bootAt ?? null,
    nextRunAt: keeper?.nextRunAt ?? null,
    lastRun: keeper?.lastRun ?? null,
    history: Array.isArray(keeper?.history) ? keeper!.history!.slice(0, 12) : [],
    manifestLatestValid: manifest.latestValid,
    manifestUpdatedAt: manifest.updatedAt,
    autoSave: keeper?.autoSave ?? null,
    autosaveHalt: readAutosaveHalt(),
  };
}

// ---------- 管理员/前端触发（manual / page-enter / auto-on 共用单飞） ----------
let apiTriggerInFlight = false;

export async function triggerAutoBackup(trigger: BackupTrigger): Promise<
  AutoBackupRunRecord | { skipped: true; reason: string }
> {
  // 自动存档停机（管理员指令 2026-11-10）：自动家族请求直接拒绝，等待管理员核实；
  // 手动（manual）永不拦截（2026-11-09 既有裁定不变），且手动有效备份会自动关闭停机。
  if (trigger !== 'manual') {
    const halt = readAutosaveHalt();
    if (halt) {
      return { skipped: true, reason: `自动存档已停机（${halt.gateStatus}）：${halt.reason} —— 本次请求已拒绝，等待管理员核实` };
    }
  }
  if (apiTriggerInFlight) {
    return { skipped: true, reason: 'another api-triggered backup is running (single-flight lock)' };
  }
  apiTriggerInFlight = true;
  const rec: AutoBackupRunRecord = { trigger, startedAt: new Date().toISOString() };
  try {
    const result = await new Promise<{ code: number | null; timedOut: boolean; out: string }>((resolve) => {
      let out = '';
      let settled = false;
      let child;
      try {
        // 线上服务运行于 node 运行时 → 绝不能用 process.execPath，
        // 必须从 PATH 找 bun（protect-db.ts 依赖 bun:sqlite 与 bun 运行时）
        child = spawn('bun', ['run', SCRIPT, `--trigger=${trigger}`], {
          cwd: PROJECT_ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: -1, timedOut: false, out: `spawn error: ${(e as Error).message}` });
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ code: null, timedOut: true, out: `${out}\n[auto-backup] 子进程超时（${SPAWN_TIMEOUT_MS / 1000}s）已强杀` });
      }, SPAWN_TIMEOUT_MS);

      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, timedOut: false, out: `${out}\nspawn error: ${e.message}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false, out });
      });
    });

    rec.exitCode = result.code;
    rec.timedOut = result.timedOut;
    rec.finishedAt = new Date().toISOString();
    rec.durationMs = new Date(rec.finishedAt).getTime() - new Date(rec.startedAt).getTime();
    rec.outputTail = result.out.split('\n').filter(Boolean).slice(-8).join('\n');

    // 互斥/避让由执行体（protect-db）判定，这里按退出码转译
    if (result.code === 3) {
      return { skipped: true, reason: '备份锁被占用（他方正在备份，本次未执行）' };
    }
    if (result.code === 4) {
      return { skipped: true, reason: '备份已暂停（恢复/维护中，本次未执行）' };
    }

    // 结果以清单为准（不解析子进程输出格式，直接读事实）
    const manifest = await readManifestSummary();
    rec.latestValid = manifest.latestValid ?? undefined;
    if (manifest.newestEntry) {
      rec.backupFile = manifest.newestEntry.file;
      rec.outcome = manifest.newestEntry.status === 'valid' ? 'valid'
        : manifest.newestEntry.status === 'quarantine' ? 'quarantine' : 'unknown';
      rec.playerCount = manifest.newestEntry.playerCount;
      // 清单最新条目若不是本次产物（时间早于 startedAt），说明未产出任何备份
      if (new Date(manifest.newestEntry.encryptedAt).getTime() < new Date(rec.startedAt).getTime() - 2000) {
        rec.outcome = 'error';
        rec.outputTail = `${rec.outputTail ?? ''}\n[auto-backup] 清单无新条目 —— protect-db 可能未产出备份`.trim();
      }
    } else {
      rec.outcome = 'error';
    }
    return rec;
  } finally {
    apiTriggerInFlight = false;
  }
}
