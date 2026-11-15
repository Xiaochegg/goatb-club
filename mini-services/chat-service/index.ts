// ============================================================
// GOATB chat-service — 独立 socket.io mini service（端口 3003）
// 协议（与前端 src/app/page.tsx ChatModal 消费端对齐，勿改字段名）：
//   client → server:
//     live    { type, payload }   原样广播（上线/下线等轻信号）
//     message { text, sender }    校验后服务端补 id 再广播
//   server → client:
//     message { id, text, sender, at }   聊天消息（新消息 + 历史回放同构）
//     recent  ChatMessage[]        连接时回放最近 50 条（裸数组，与 page.tsx
//                                  ChatModal 的 setMessages(msgs) 对齐；
//                                  Phase 0 修复：原实现误包 {items} 导致
//                                  messages.map is not a function 崩溃）
//     online  number              当前连接数（裸数字，对齐 setOnlineCount；
//                                  Phase 0 修复：原实现误包 {count} 导致
//                                  在线人数显示异常）
//   HTTP  GET /health → { ok, uptime, connections, recentCount }
// 说明：路径保持 socket.io 默认（前端 io("/?XTransformPort=3003") 经
// Caddy 网关转发），不要加自定义 path。
// ============================================================
// 2026-11-05 常驻值守扩展：
//   本进程是平台 dev.sh 启动期托管的唯一常驻业务进程（bun --hot），
//   其子进程继承「启动期」生命周期。因此本文件额外内嵌 GOATB 值守块：
//     1) 每小时第 1 分钟执行 protect-db 完整备份
//        （跨进程认领 + 清单 10 分钟新鲜度判据，与 dev 内调度器 /
//          backup-keeper mini-service 互斥，宁多备不漏备）
//     2) 启动补位（≥30min 无有效备份时立即补跑）
//     3) dev 看门狗：127.0.0.1:3000 连续 2 次探测不通 → 拉起 bun run dev
//        （子进程继承本进程生命周期 → 常驻，站点自动复活）
//   热重载安全：
//     - 聊天接线前先探测 :3003 —— 已被占用（热重载场景）则完全跳过接线，
//       沿用既有实例（旧闭包继续服务聊天），绝不重复 listen 造成
//       EADDRINUSE 崩掉唯一常驻进程
//     - 值守块用 globalThis.__goatbKeeperLoaded 守卫，热重载不叠加定时器
// ============================================================
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const PORT = 3003;
const MAX_RECENT = 50;
const MAX_TEXT = 500;
const MAX_SENDER = 40;

interface ChatMessage {
  id: string;
  text: string;
  sender: string;
  at: number;
}

// ---------- 端口探测（热重载安全的关键） ----------
async function isPortUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return res.status > 0; // 任何 HTTP 响应都算占用
  } catch {
    return false; // 连接拒绝 = 空闲
  }
}

const g = globalThis as Record<string, unknown> & { __goatbKeeperLoaded?: boolean };
const portBusy = await isPortUp(PORT);

if (!portBusy) {
  // ===== 正常冷启动：完整聊天接线（协议与 Phase 0 修复保持不变） =====
  const recent: ChatMessage[] = [];
  const startedAt = Date.now();

  // 单一 node:http 服务器同时承载 socket.io 与 /health（Phase 0 修复模式）
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          connections: io.engine.clientsCount,
          recentCount: recent.length,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    // 连接回放：历史（裸数组）+ 在线人数（裸数字）——与 page.tsx ChatModal 消费端对齐
    socket.emit('recent', recent);
    io.emit('online', io.engine.clientsCount);

    // 轻信号（进入/离开等）：原样广播给其他客户端
    socket.on('live', (data: unknown) => {
      if (data && typeof data === 'object') {
        socket.broadcast.emit('live', data);
      }
    });

    // 聊天消息：校验 → 服务端生成 id → 全员广播（含自己回显）
    socket.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const { text, sender } = raw as { text?: unknown; sender?: unknown };
      if (typeof text !== 'string' || !text.trim()) return;
      const cleanText = text.trim().slice(0, MAX_TEXT);
      const cleanSender =
        typeof sender === 'string' && sender.trim()
          ? sender.trim().slice(0, MAX_SENDER)
          : '匿名';
      const msg: ChatMessage = {
        id: randomUUID(),
        text: cleanText,
        sender: cleanSender,
        at: Date.now(),
      };
      recent.push(msg);
      if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
      io.emit('message', msg);
    });

    socket.on('disconnect', () => {
      io.emit('online', io.engine.clientsCount);
    });
  });

  // P1-2 同口径（审计 2026-11-13）：绑定 127.0.0.1 —— 服务唯一消费方是
  // Caddy 网关（localhost 转发）与本机监督者（/health 探活），不对外网暴露。
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[chat-service] socket.io listening on 127.0.0.1:${PORT} (path /socket.io)`);
  });

  process.on('SIGTERM', () => {
    httpServer.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    httpServer.close(() => process.exit(0));
  });
} else {
  console.log(
    '[chat-service] :3003 已被占用（bun --hot 热重载场景）—— 聊天功能由既有实例继续服务，本次评估仅激活值守扩展',
  );
}

// ============================================================
// 常驻值守扩展（globalThis 守卫：热重载/重复评估不叠加定时器）
// ============================================================
if (!g.__goatbKeeperLoaded) {
  g.__goatbKeeperLoaded = true;

  const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..'); // mini-services/chat-service → 项目根
  const HOUR_MARK_MINUTE = 1;
  const FRESH_SKIP_WINDOW_MS = 10 * 60_000;
  const BOOT_CATCHUP_DELAY_MS = 20_000;
  const BOOT_FRESH_WINDOW_MS = 30 * 60_000;
  const SPAWN_TIMEOUT_MS = 180_000;
  const WATCHDOG_INTERVAL_MS = 20_000;
  const WATCHDOG_FAILS_TO_REVIVE = 2;
  const REVIVE_COOLDOWN_MS = 3 * 60_000;
  const WATCHDOG_GRACE_MS = 15_000;
  const MANIFESTS = [
    path.join(PROJECT_ROOT, 'backups/LATEST-BACKUP-INFO.json'),
    path.join(PROJECT_ROOT, 'upload/goatb-backups/LATEST-BACKUP-INFO.json'),
  ];
  const STATUS_FILE = path.join(PROJECT_ROOT, 'upload/goatb-backups/KEEPER-STATUS.json');

  const keeperBootAt = new Date();
  let nextRunAt: Date | null = null;
  let lastRun: Record<string, unknown> | null = null;
  const history: Record<string, unknown>[] = [];
  let devRevivals = 0;
  let lastReviveAt = 0;
  let watchdogFails = 0;

  const klog = (msg: string) => console.log(`[keeper] ${new Date().toISOString()} ${msg}`);

  /** 跨进程认领（/tmp claim 文件）：与 dev 内调度器、backup-keeper 互斥 */
  async function claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const p = path.join('/tmp', `${key}.claim`);
    try {
      const now = Date.now();
      try {
        const prev = Number((await readFile(p, 'utf8')).trim() || '0');
        if (prev && now - prev < ttlMs) return false;
      } catch { /* 无认领记录 */ }
      await writeFile(p, String(now));
      return true;
    } catch {
      return true; // 写不了认领文件时宁放行（宁多备不漏备）
    }
  }

  interface ManifestSummary {
    latestValid: string | null;
    newestValidEntry: { file: string; encryptedAt: string; status: string } | null;
  }

  async function readManifestSummary(): Promise<ManifestSummary> {
    let best: { updatedAt: string; latestValid: string | null; newestValidEntry: ManifestSummary['newestValidEntry'] } | null = null;
    for (const p of MANIFESTS) {
      try {
        if (!existsSync(p)) continue;
        const m = JSON.parse(await readFile(p, 'utf8'));
        if (m?.version !== 1) continue;
        const valid = Array.isArray(m.backups)
          ? (m.backups.find((b: Record<string, unknown>) => b?.status === 'valid') ?? null)
          : null;
        const cand = {
          updatedAt: String(m.updatedAt ?? ''),
          latestValid: (m.latestValid ?? null) as string | null,
          newestValidEntry: valid ? {
            file: String(valid.file ?? ''),
            encryptedAt: String(valid.encryptedAt ?? ''),
            status: 'valid',
          } : null,
        };
        if (!best || cand.updatedAt > best.updatedAt) best = cand;
      } catch { /* 跳过损坏清单 */ }
    }
    return {
      latestValid: best?.latestValid ?? null,
      newestValidEntry: best?.newestValidEntry ?? null,
    };
  }

  async function persistStatus(): Promise<void> {
    try {
      await mkdir(path.dirname(STATUS_FILE), { recursive: true });
      const manifest = await readManifestSummary();
      await writeFile(STATUS_FILE, JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: 'chat-service-embedded-keeper',
        bootAt: keeperBootAt.toISOString(),
        nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
        lastRun,
        devRevivals,
        lastReviveAt: lastReviveAt ? new Date(lastReviveAt).toISOString() : null,
        watchdogConsecutiveFails: watchdogFails,
        manifestLatestValid: manifest.latestValid,
        history: history.slice(0, 12),
      }, null, 2));
    } catch (e) {
      klog(`⚠ 状态文件写入失败（不影响备份本体）：${(e as Error).message}`);
    }
  }

  async function runProtectDb(trigger: string): Promise<void> {
    const startedAt = new Date().toISOString();
    klog(`▶ [${trigger}] 启动 protect-db 子进程…`);
    let out = '';
    let code: number | null = -1;
    let timedOut = false;
    try {
      const proc = Bun.spawn(['bun', 'run', 'scripts/protect-db.ts'], {
        cwd: PROJECT_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const killer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(9); } catch { /* ignore */ }
      }, SPAWN_TIMEOUT_MS);
      const [o, e] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      code = await proc.exited;
      clearTimeout(killer);
      out = `${o}\n${e}`.trim();
    } catch (e) {
      out = `spawn error: ${(e as Error).message}`;
    }

    const manifest = await readManifestSummary();
    const newest = manifest.newestValidEntry;
    const producedNew = newest
      ? new Date(newest.encryptedAt).getTime() >= new Date(startedAt).getTime() - 2000
      : false;
    const rec = {
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      exitCode: code,
      timedOut,
      outcome: producedNew ? 'valid' : (code === 0 ? 'no-new-valid' : 'error'),
      backupFile: producedNew ? newest?.file : undefined,
      latestValid: manifest.latestValid,
      outputTail: out.split('\n').filter(Boolean).slice(-6).join('\n'),
    };
    lastRun = rec;
    history.unshift(rec);
    if (history.length > 12) history.length = 12;
    const mark = rec.outcome === 'valid' ? '✅' : rec.outcome === 'no-new-valid' ? '⚠' : '✗';
    klog(`${mark} [${trigger}] code=${code} outcome=${rec.outcome} file=${rec.backupFile ?? '-'} timedOut=${timedOut}`);
    if (rec.outcome === 'error') klog(`✗ [${trigger}] 输出尾部：\n${rec.outputTail}`);
    await persistStatus();
  }

  async function scheduledBackup(trigger: 'hourly' | 'boot'): Promise<void> {
    try {
      const m = await readManifestSummary();
      if (m.newestValidEntry?.encryptedAt) {
        const age = Date.now() - new Date(m.newestValidEntry.encryptedAt).getTime();
        const window = trigger === 'boot' ? BOOT_FRESH_WINDOW_MS : FRESH_SKIP_WINDOW_MS;
        if (age >= 0 && age < window) {
          klog(`⏭ [${trigger}] 跳过：${Math.round(age / 1000)}s 前已有有效备份（${m.newestValidEntry.file}）`);
          return;
        }
      }
      if (!(await claimOnce('goatb-backup', 120_000))) {
        klog(`⏭ [${trigger}] 跳过：他方进程正在备份（认领文件持有中）`);
        return;
      }
      await runProtectDb(trigger);
    } catch (e) {
      klog(`✗ [${trigger}] 异常（不中断调度）：${(e as Error).message}`);
    }
  }

  function scheduleNextHourly(): void {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(HOUR_MARK_MINUTE, 0, 0);
    if (next.getTime() <= now.getTime()) next.setHours(next.getHours() + 1);
    nextRunAt = next;
    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      await scheduledBackup('hourly');
      scheduleNextHourly();
    }, delay);
    klog(`⏰ 已排定下次自动备份：${next.toLocaleString()}（每小时第 ${HOUR_MARK_MINUTE} 分钟）`);
  }

  async function isDevUp(): Promise<boolean> {
    try {
      const res = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(8000) });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  async function reviveDev(): Promise<void> {
    const now = Date.now();
    if (now - lastReviveAt < REVIVE_COOLDOWN_MS) {
      klog('⏭ dev 复活冷却中，本次跳过');
      return;
    }
    if (!(await claimOnce('goatb-dev-revive', REVIVE_COOLDOWN_MS))) {
      klog('⏭ dev 复活请求被他方认领，本次跳过');
      return;
    }
    lastReviveAt = now;
    devRevivals += 1;
    klog(`🚑 dev 连续 ${WATCHDOG_FAILS_TO_REVIVE} 次探测失败 → 拉起 bun run dev（第 ${devRevivals} 次）`);
    try {
      const proc = Bun.spawn(['bun', 'run', 'dev'], {
        cwd: PROJECT_ROOT,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      proc.unref();
    } catch (e) {
      klog(`✗ dev 拉起失败：${(e as Error).message}`);
    }
    await persistStatus();
  }

  async function watchdogLoop(): Promise<void> {
    await new Promise(r => setTimeout(r, WATCHDOG_GRACE_MS));
    klog(`🐕 dev 看门狗开始值守（每 ${WATCHDOG_INTERVAL_MS / 1000}s 探测 127.0.0.1:3000）`);
    for (;;) {
      try {
        const up = await isDevUp();
        if (up) {
          if (watchdogFails > 0) klog('✓ dev 恢复正常');
          watchdogFails = 0;
        } else {
          watchdogFails += 1;
          klog(`✗ dev 探测失败（连续 ${watchdogFails}/${WATCHDOG_FAILS_TO_REVIVE}）`);
          if (watchdogFails >= WATCHDOG_FAILS_TO_REVIVE) {
            await reviveDev();
            watchdogFails = 0;
          }
        }
      } catch (e) {
        klog(`⚠ 看门狗异常（继续值守）：${(e as Error).message}`);
      }
      await new Promise(r => setTimeout(r, WATCHDOG_INTERVAL_MS));
    }
  }

  klog(`🛡 值守块加载（PROJECT_ROOT=${PROJECT_ROOT}）—— 每小时第 ${HOUR_MARK_MINUTE} 分钟备份 + dev 看门狗`);
  scheduleNextHourly();
  setTimeout(() => { void scheduledBackup('boot'); }, BOOT_CATCHUP_DELAY_MS);
  void watchdogLoop();
  void persistStatus();
}
