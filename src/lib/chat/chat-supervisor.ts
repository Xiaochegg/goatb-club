// ============================================================
// chat-service 监督者（审计 P1-5 修复，批示「执行全部」2026-11-13）
// ============================================================
// 职责边界（与 backup-keeper 的 keeper-supervisor 同模式）：
//   - 本模块只做「chat-service 是否存活 → 不存活则拉起」这一件事。
//   - 绝不实现任何聊天逻辑：socket.io 服务唯一入口是
//     mini-services/chat-service/index.ts（独立常驻 Bun 进程）。
//   - 存活判据：GET http://127.0.0.1:3003/health 返回 200（chat-service
//     自带 /health 端点，Phase 0 修复模式）。
//   - 拉起方式：detached + unref（子进程脱管，dev 退出不影响）。
//   - 防重复：globalThis 单例 + /tmp 认领文件（60s TTL）双重防线；
//     chat-service 自身还有端口探测（:3003 已占用则跳过接线）兜底，
//     即使多入口并发拉起也不会 EADDRINUSE 崩溃。
//   - 本模块运行于 node 运行时，绝不 import 任何 bun 专属模块。
// 审计依据：chat-service 未运行时前端 Dock 聊天入口常驻可点 →
//   消息链路死（P1-5「运行时可用性 FAIL」）。监督后 dev 重启/容器
//   重置场景自动把聊天服务带回。
// ============================================================

import { openSync, writeSync, closeSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHAT_HEALTH_URL = 'http://127.0.0.1:3003/health';
const SPAWN_CLAIM_FILE = '/tmp/goatb-chat-spawn.claim';
const SPAWN_CLAIM_TTL_MS = 60_000;

const g = globalThis as unknown as { __goatbChatSupervised?: boolean };

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

/** chat-service 是否存活（/health 200 = 在位；任何网络错误 = 不在位） */
async function chatAlive(): Promise<boolean> {
  try {
    const res = await fetch(CHAT_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 检查并在缺位时拉起（无 once-guard，供周期监督调用；认领文件防并发） */
export async function checkChatAlive(): Promise<boolean> {
  try {
    if (await chatAlive()) return true;
    if (!claimSpawnOnce()) return false; // 其他入口刚拉起过，静默
    const child = spawn('bun', ['mini-services/chat-service/index.ts'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[chat-supervisor] 巡检发现 chat-service 缺位 → 已拉起（pid=${child.pid}，detached）`);
    return true;
  } catch (e) {
    console.warn(`[chat-supervisor] 巡检拉起失败（不影响服务）：${(e as Error).message}`);
    return false;
  }
}

/** 在 Next.js 服务启动时调用；幂等，可安全重复调用 */
export async function ensureChatAlive(): Promise<void> {
  if (g.__goatbChatSupervised) return;
  g.__goatbChatSupervised = true;
  try {
    if (await chatAlive()) {
      console.log('[chat-supervisor] chat-service 存活（:3003 /health 200），无需拉起');
      return;
    }
    if (!claimSpawnOnce()) {
      console.log('[chat-supervisor] 其他入口刚拉起过 chat-service（认领文件持有中），跳过');
      return;
    }
    const child = spawn('bun', ['mini-services/chat-service/index.ts'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[chat-supervisor] chat-service 不在位 → 已拉起（pid=${child.pid}，detached）`);
  } catch (e) {
    console.warn(`[chat-supervisor] 拉起失败（不影响正常服务）：${(e as Error).message}`);
  }
}
