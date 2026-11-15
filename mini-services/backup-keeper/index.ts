// ============================================================
// GOATB backup-keeper —— 唯一常驻备份调度器（2026-11-05 架构纠错版）
// ============================================================
// 架构裁定（本轮验收基线）：
//   - 全系统只有本进程注册「每小时第 1 分钟」备份调度。
//     Next.js 侧（instrumentation / db.ts / auto-backup.ts）一律不注册
//     定时器；instrumentation 仅作为监督者在本进程死亡时拉起本服务。
//   - 执行体 = 子进程 `bun run scripts/protect-db.ts`
//     （闸门 → VACUUM 快照 → AES-256-GCM 加密 → 本地+OSS 双副本 →
//       SHA-256 回读校验 → 清单更新 → 本地轮换）。
//     备份锁（BACKUP.lock）由执行体统一收口，跨进程互斥。
//
// 调度语义：
//   1) 每小时第 1 分钟（XX:01:00 本地时间）触发，链式 setTimeout
//      绝对墙钟对齐（不用相对间隔）
//   2) 20s 巡检兜底：错过定时器 / 失败重试 / 启动补位三合一 ——
//      「当前小时桶尚无 valid 备份」即补跑，同桶最多 3 次、间隔 ≥10min
//   3) 恢复避让：BACKUP-PAUSED.json 存在时不触发（执行体同样自检）
//   4) 单实例：/tmp/goatb-keeper.lock（O_EXCL + pid + bootId + 心跳 mtime）
//   5) 心跳：KEEPER-STATUS.json 每 60s 刷新（含 pid），
//      供 instrumentation 监督者判定生死
//   6) dev 看门狗：每 20s 探测 127.0.0.1:3000，连续失败拉起 `bun run dev`
//   7) 健康端点：0.0.0.0:3010（网关 ?XTransformPort=3010）
//   8) 一次性验证模式：GOATB_KEEPER_ONCE=1（配合 GOATB_KEEPER_FORCE=1
//      可绕过桶判定，仍受暂停标记与备份锁约束）——仅供运维验证，
//      生产备份绝不依赖该模式
// ============================================================

import path from 'node:path';
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';

// ---------- 定位项目根（backup-core 常量依赖 cwd，先校正再动态加载） ----------
const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..');
process.chdir(PROJECT_ROOT);

const { pidAlive, hostBootId, isBackupPaused, readPauseReason } = await import('../../scripts/lib/backup-core');
const { latestHourMark, nextHourMark, bucketSatisfied } = await import('./schedule-core');
const { readAutoSaveEnabled, nextFiveMinuteMark, AUTO_SAVE_INTERVAL_MIN, AUTO_SAVE_CONFIG_KEY } = await import('./auto-save-core');
// 自动存档停机标记（管理员指令 2026-11-10）：纯 node:fs，Bun/Node 双运行时可用
const { readAutosaveHalt } = await import('../../scripts/lib/autosave-halt');

// ---------- 常量 ----------
const PORT = 3010;
const AUTO_DB_PATH = path.join(PROJECT_ROOT, 'db/custom.db'); // 自动存档开关读取源（每轮新鲜读）
const MANIFESTS = [
  path.join(PROJECT_ROOT, 'backups/LATEST-BACKUP-INFO.json'),
  path.join(PROJECT_ROOT, 'upload/goatb-backups/LATEST-BACKUP-INFO.json'),
];
const STATUS_FILE = path.join(PROJECT_ROOT, 'upload/goatb-backups/KEEPER-STATUS.json');
const SINGLETON_LOCK = '/tmp/goatb-keeper.lock';
const SINGLETON_STALE_MS = 15 * 60_000;   // 心跳 mtime 超时视为陈旧（心跳 60s 刷）
const EXEC_TIMEOUT_MS = 180_000;          // protect-db 子进程上限
const RETRY_SPACING_MS = 10 * 60_000;     // 同桶失败重试最小间隔
const MAX_ATTEMPTS_PER_BUCKET = 3;        // 同桶最多尝试次数
const WATCHDOG_INTERVAL_MS = 20_000;      // 巡检/看门狗周期
const HEARTBEAT_MS = 60_000;              // 状态文件心跳周期
const WATCHDOG_FAILS_TO_REVIVE = 2;       // 连续失败次数阈值
const REVIVE_COOLDOWN_MS = 3 * 60_000;    // dev 复活冷却
const WATCHDOG_GRACE_MS = 15_000;         // 启动宽限
// ---------- 方案C（批示「c」 trace 1a1cf86a8dee8aa9）：每日代码 bundle ----------
const CODE_BUNDLE_DIR = path.join(PROJECT_ROOT, 'upload/goatb-backups');
const CODE_BUNDLE_CLAIM = '/tmp/goatb-code-bundle.claim';
const CODE_BUNDLE_CLAIM_TTL_MS = 22 * 60 * 60_000; // 22h 认领 ≈ 每日一发（claim 持久于 /tmp，重启不重跑）
const CODE_BUNDLE_FAIL_SPACING_MS = 10 * 60_000;   // 失败重试最小间隔（防 20s 巡检连打）
const CODE_BUNDLE_KEEP = 7;                        // 滚动保留份数（实测单份 ≈63MB，上限 ≈450MB）
const CODE_BUNDLE_BASELINE = 'goatb-code-20261105-170547.bundle'; // 基线手工作品，永久豁免剪枝
const CODE_BUNDLE_PATTERN = /^goatb-code-\d{8}-\d{6}\.bundle$/;
const CODE_BUNDLE_TIMEOUT_MS = 300_000;

// ---------- 状态 ----------
const bootAt = new Date();
let nextRunAt: Date | null = null;
let bucketMark: Date | null = null;
let bucketAttempts = 0;
let lastAttemptAt = 0;
let inFlight = false;
let lastBeatAt = 0;
let lastRun: Record<string, unknown> | null = null;
const history: Record<string, unknown>[] = [];
let devRevivals = 0;
let lastReviveAt = 0;
let watchdogFails = 0;
// 自动存档（管理员开关，默认关）运行时事实（透出到 KEEPER-STATUS.json / 健康端点）
let autoSaveEnabled = false;
let autoCheckedAt: string | null = null;
let autoNextRunAt: Date | null = null;
let autoLastRunAt: string | null = null;
let autoLastTrigger: string | null = null;
// 停机拒绝计数（管理员指令 2026-11-10「直接拒绝5分钟保存一次的请求」的可观测事实）
let autoHaltRejects = 0;
let autoLastRejectAt: string | null = null;
// 方案C 运行时事实（透出到 KEEPER-STATUS.json / 健康端点）
let codeBundleInFlight = false;
let lastCodeBundleFailAt = 0;
let codeBundleState: Record<string, unknown> = {
  lastRunAt: null as string | null,
  lastFile: null as string | null,
  lastSizeBytes: null as number | null,
  lastError: null as string | null,
};

// ---------- 方案C：认领 / 剪枝 / 执行 ----------
async function codeBundleClaimOnce(ttlMs: number): Promise<boolean> {
  try {
    const now = Date.now();
    try {
      const prev = Number(readFileSync(CODE_BUNDLE_CLAIM, 'utf8').trim() || '0');
      if (prev && now - prev < ttlMs) return false;
    } catch { /* 无认领记录 */ }
    writeFileSync(CODE_BUNDLE_CLAIM, String(now));
    return true;
  } catch {
    return false; // 认领文件写不进 → 宁跳过（下一轮 20s 巡检再试），避免双跑
  }
}

/** 仅剪本家族（goatb-code-\d{8}-\d{6}.bundle）超出保留份数的旧份；基线手工 bundle 永久豁免 */
async function pruneCodeBundles(): Promise<number> {
  try {
    const files = (await readdir(CODE_BUNDLE_DIR))
      .filter((f) => CODE_BUNDLE_PATTERN.test(f) && f !== CODE_BUNDLE_BASELINE)
      .sort()      // 文件名含时间戳：字典序 = 时间序（旧→新）
      .reverse();  // 新→旧
    let removed = 0;
    for (const f of files.slice(CODE_BUNDLE_KEEP)) {
      await rm(path.join(CODE_BUNDLE_DIR, f), { force: true });
      removed += 1;
    }
    if (removed) log(`🧹 [code-bundle] 滚动剪枝：清理 ${removed} 份超限旧 bundle（保留最近 ${CODE_BUNDLE_KEEP} 份，基线豁免）`);
    return removed;
  } catch { return 0; } // 剪枝失败不影响备份本体
}

async function maybeRunCodeBundle(trigger: string): Promise<void> {
  if (codeBundleInFlight) return;
  if (isBackupPaused()) return; // 恢复/维护期间避让
  if (Date.now() - lastCodeBundleFailAt < CODE_BUNDLE_FAIL_SPACING_MS) return;
  if (!(await codeBundleClaimOnce(CODE_BUNDLE_CLAIM_TTL_MS))) return;
  codeBundleInFlight = true;
  const startedAt = new Date().toISOString();
  const ts = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const file = `goatb-code-${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}.bundle`;
  const out = path.join(CODE_BUNDLE_DIR, file);
  log(`▶ [code-bundle/${trigger}] git bundle create ${file} …`);
  try {
    const proc = Bun.spawn(['git', '-C', PROJECT_ROOT, 'bundle', 'create', out, '--all'], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const killer = setTimeout(() => {
      try { proc.kill(9); } catch { /* ignore */ }
    }, CODE_BUNDLE_TIMEOUT_MS);
    const [, errOut] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(killer);
    if (code === 0) {
      const size = statSync(out).size;
      codeBundleState = { lastRunAt: startedAt, lastFile: file, lastSizeBytes: size, lastError: null };
      log(`✅ [code-bundle/${trigger}] ${file} (${(size / 1048576).toFixed(1)}MB)`);
      await pruneCodeBundles();
    } else {
      const tail = errOut.split('\n').filter(Boolean).slice(-2).join(' | ');
      codeBundleState = { ...codeBundleState, lastRunAt: startedAt, lastError: `exit=${code} ${tail}` };
      lastCodeBundleFailAt = Date.now();
      // 失败即释放认领：下轮巡检按失败间隔重试，避免 22h 空窗
      try { rmSync(CODE_BUNDLE_CLAIM, { force: true }); } catch { /* ignore */ }
      log(`✗ [code-bundle/${trigger}] bundle 失败 exit=${code}：${tail}`);
    }
  } catch (err) {
    codeBundleState = { ...codeBundleState, lastRunAt: startedAt, lastError: (err as Error).message };
    lastCodeBundleFailAt = Date.now();
    try { rmSync(CODE_BUNDLE_CLAIM, { force: true }); } catch { /* ignore */ }
    log(`✗ [code-bundle/${trigger}] 异常：${(err as Error).message}`);
  } finally {
    codeBundleInFlight = false;
    void persistStatus();
  }
}

function log(msg: string): void {
  console.log(`[keeper] ${new Date().toISOString()} ${msg}`);
}

// ---------- 清单摘要（只读 fs，无 DB 依赖） ----------
interface ManifestSummary {
  latestValid: string | null;
  newestValidEntry: { file: string; encryptedAt: string } | null;
}

async function readManifestSummary(): Promise<ManifestSummary> {
  let best: { updatedAt: string; latestValid: string | null; newestValidEntry: ManifestSummary['newestValidEntry'] } | null = null;
  for (const p of MANIFESTS) {
    try {
      if (!existsSyncSafe(p)) continue;
      const m = JSON.parse(await readFile(p, 'utf8'));
      if (m?.version !== 1) continue;
      const valid = Array.isArray(m.backups)
        ? (m.backups.find((b: any) => b?.status === 'valid') ?? null)
        : null;
      const cand = {
        updatedAt: String(m.updatedAt ?? ''),
        latestValid: (m.latestValid ?? null) as string | null,
        newestValidEntry: valid ? {
          file: String(valid.file ?? ''),
          encryptedAt: String(valid.encryptedAt ?? ''),
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

function existsSyncSafe(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

// ---------- 单实例锁（O_EXCL + pid + bootId + 心跳 mtime） ----------
function acquireSingletonLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(SINGLETON_LOCK, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, bootAt: bootAt.toISOString(), bootId: hostBootId() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
      let prev: { pid?: number; bootId?: string } | null = null;
      let mtimeAge = Infinity;
      try {
        prev = JSON.parse(readFileSync(SINGLETON_LOCK, 'utf8'));
        mtimeAge = Date.now() - statSync(SINGLETON_LOCK).mtimeMs;
      } catch { /* 锁损坏或被删 → 视为陈旧 */ }
      const stale = !prev
        || prev.bootId !== hostBootId()
        || !pidAlive(Number(prev.pid))
        || mtimeAge > SINGLETON_STALE_MS;
      if (!stale) return false;
      log(`♻️ 旧单例锁陈旧（pid=${prev?.pid} mtimeAge=${Math.round(mtimeAge / 1000)}s）→ 夺取`);
      try { rmSync(SINGLETON_LOCK, { force: true }); } catch { return false; }
    }
  }
  return false;
}

function touchSingletonLock(): void {
  try {
    // 仅当自己持有心跳锁时续期（重写内容，保持 pid 真实）
    const prev = JSON.parse(readFileSync(SINGLETON_LOCK, 'utf8'));
    if (prev?.pid === process.pid) {
      const fd = openSync(SINGLETON_LOCK, 'w');
      writeSync(fd, JSON.stringify({ pid: process.pid, bootAt: bootAt.toISOString(), bootId: hostBootId() }));
      closeSync(fd);
    }
  } catch { /* ignore */ }
}

// ---------- 状态落盘（KEEPER-STATUS.json，OSS 持久层） ----------
async function persistStatus(): Promise<void> {
  try {
    await mkdir(path.dirname(STATUS_FILE), { recursive: true });
    const manifest = await readManifestSummary();
    await writeFile(STATUS_FILE, JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      bootAt: bootAt.toISOString(),
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      bucket: bucketMark ? { mark: bucketMark.toISOString(), attempts: bucketAttempts } : null,
      inFlight,
      lastRun,
      history: history.slice(0, 12),
      devRevivals,
      lastReviveAt: lastReviveAt ? new Date(lastReviveAt).toISOString() : null,
      watchdogConsecutiveFails: watchdogFails,
      manifestLatestValid: manifest.latestValid,
      codeBundle: codeBundleState,
      autoSave: {
        enabled: autoSaveEnabled,
        intervalMin: AUTO_SAVE_INTERVAL_MIN,
        configKey: AUTO_SAVE_CONFIG_KEY,
        checkedAt: autoCheckedAt,
        nextRunAt: autoNextRunAt ? autoNextRunAt.toISOString() : null,
        lastRunAt: autoLastRunAt,
        lastTrigger: autoLastTrigger,
        halt: readAutosaveHalt(),
        haltRejects: autoHaltRejects,
        lastRejectAt: autoLastRejectAt,
      },
    }, null, 2));
    lastBeatAt = Date.now();
  } catch (e) {
    log(`⚠ 状态文件写入失败（不影响备份本体）：${(e as Error).message}`);
  }
}

// ---------- 执行备份（子进程，锁在执行体内部收口） ----------
async function runProtectDb(trigger: string): Promise<void> {
  const startedAt = new Date().toISOString();
  log(`▶ [${trigger}] 启动 protect-db 子进程…`);
  let out = '';
  let code: number | null = -1;
  let timedOut = false;
  try {
    const proc = Bun.spawn(['bun', 'run', 'scripts/protect-db.ts', `--trigger=${trigger}`], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const killer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(9); } catch { /* ignore */ }
    }, EXEC_TIMEOUT_MS);
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

  // 结果以清单事实为准（不解析子进程输出）
  const manifest = await readManifestSummary();
  const newest = manifest.newestValidEntry;
  const producedNew = newest ? new Date(newest.encryptedAt).getTime() >= new Date(startedAt).getTime() - 2000 : false;
  const outcome = code === 3 ? 'skipped-busy'
    : code === 4 ? 'skipped-paused'
    : producedNew ? 'valid'
    : (code === 0 ? 'no-new-valid' : 'error');
  const rec = {
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(startedAt).getTime(),
    exitCode: code,
    timedOut,
    outcome,
    backupFile: producedNew ? newest?.file : undefined,
    latestValid: manifest.latestValid,
    outputTail: out.split('\n').filter(Boolean).slice(-6).join('\n'),
  };
  lastRun = rec;
  history.unshift(rec);
  if (history.length > 12) history.length = 12;
  const mark = outcome === 'valid' ? '✅'
    : outcome.startsWith('skipped') ? '⏭'
    : outcome === 'no-new-valid' ? '⚠' : '✗';
  log(`${mark} [${trigger}] code=${code} outcome=${outcome} file=${rec.backupFile ?? '-'} timedOut=${timedOut} 耗时=${rec.durationMs}ms`);
  if (outcome === 'error') log(`✗ [${trigger}] 输出尾部：\n${rec.outputTail}`);
  await persistStatus();
}

// ---------- 桶判定触发（唯一入口：定时 / 巡检 / 补位共用） ----------
async function maybeRunBucket(trigger: string, opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return;
  if (isBackupPaused()) {
    log(`⏸ [${trigger}] 备份暂停中（${readPauseReason()}）—— 本次跳过`);
    return;
  }
  const mark = latestHourMark();
  if (!bucketMark || bucketMark.getTime() !== mark.getTime()) {
    bucketMark = mark;
    bucketAttempts = 0;
  }
  if (!opts.force) {
    const m = await readManifestSummary();
    if (bucketSatisfied(m.newestValidEntry?.encryptedAt, mark)) return;
    if (bucketAttempts >= MAX_ATTEMPTS_PER_BUCKET) {
      log(`⏭ [${trigger}] 本小时已尝试 ${bucketAttempts} 次仍未产出有效备份，等待下一小时`);
      return;
    }
    if (bucketAttempts > 0 && Date.now() - lastAttemptAt < RETRY_SPACING_MS) return;
  }
  bucketAttempts += 1;
  lastAttemptAt = Date.now();
  inFlight = true;
  try {
    await runProtectDb(trigger);
  } catch (e) {
    log(`✗ [${trigger}] 执行异常（不中断调度）：${(e as Error).message}`);
  } finally {
    inFlight = false;
    void persistStatus();
  }
}

// ---------- 自动存档（管理员开关，默认关；每轮新鲜读 Config，无缓存） ----------
async function maybeRunAutoSave(trigger: string): Promise<void> {
  if (inFlight) return;              // 与小时桶共用互斥（同一时刻至多一个备份）
  if (isBackupPaused()) {            // 恢复/维护期间避让
    autoSaveEnabled = readAutoSaveEnabled(AUTO_DB_PATH);
    autoCheckedAt = new Date().toISOString();
    return;
  }
  const enabled = readAutoSaveEnabled(AUTO_DB_PATH); // ← 每轮新鲜读库：开关即时生效，绝不缓存
  autoSaveEnabled = enabled;
  autoCheckedAt = new Date().toISOString();
  if (!enabled) { autoNextRunAt = null; return; }
  // 自动存档停机检查（管理员指令 2026-11-10）：标记存在 = 内容曾被侵犯（reject/quarantine），
  // 直接拒绝本轮 5 分钟保存请求，等待管理员核实（核实后停机自动关闭，调度链不受影响）
  const halt = readAutosaveHalt();
  if (halt) {
    autoHaltRejects += 1;
    autoLastRejectAt = new Date().toISOString();
    log(`🛑 [${trigger}] 自动存档已停机（${halt.gateStatus}: ${halt.reason}）—— 本次 5 分钟请求已拒绝（累计 ${autoHaltRejects} 次），等待管理员核实`);
    void persistStatus();
    return;
  }
  inFlight = true;
  try {
    await runProtectDb(trigger);
    autoLastRunAt = new Date().toISOString();
    autoLastTrigger = trigger;
  } catch (e) {
    log(`✗ [${trigger}] 执行异常（不中断调度）：${(e as Error).message}`);
  } finally {
    inFlight = false;
    void persistStatus();
  }
}

function scheduleNextAutoSave(): void {
  const next = nextFiveMinuteMark();
  autoNextRunAt = next;
  const delay = Math.max(1000, next.getTime() - Date.now());
  setTimeout(() => {
    void maybeRunAutoSave('auto-5min').catch((e) => log(`✗ auto-5min 异常：${(e as Error).message}`));
    scheduleNextAutoSave(); // 链式续排
  }, delay);
  log(`⏱ 自动存档调度就绪：下一轮 ${next.toISOString()}（每 ${AUTO_SAVE_INTERVAL_MIN} 分钟；开关每轮新鲜读 Config.${AUTO_SAVE_CONFIG_KEY}，默认关）`);
}

// ---------- 每小时第 1 分钟定时器（链式，绝对墙钟对齐） ----------
function scheduleNextHourly(): void {
  const next = nextHourMark();
  nextRunAt = next;
  const delay = Math.max(250, next.getTime() - Date.now());
  setTimeout(() => {
    void maybeRunBucket('hourly').catch((e) => log(`✗ hourly 异常：${(e as Error).message}`));
    scheduleNextHourly(); // 链式续排
  }, delay);
  log(`⏰ 已排定下次自动备份：${next.toISOString()}（每小时第 1 分钟）`);
}

// ---------- dev 看门狗 ----------
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
    log(`⏭ dev 复活冷却中，本次跳过`);
    return;
  }
  lastReviveAt = now;
  devRevivals += 1;
  log(`🚑 dev 连续 ${WATCHDOG_FAILS_TO_REVIVE} 次探测失败 → 拉起 bun run dev（第 ${devRevivals} 次）`);
  try {
    const proc = Bun.spawn(['bun', 'run', 'dev'], {
      cwd: PROJECT_ROOT,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    proc.unref();
  } catch (e) {
    log(`✗ dev 拉起失败：${(e as Error).message}`);
  }
  await persistStatus();
}

async function maintenanceLoop(): Promise<void> {
  await new Promise(r => setTimeout(r, WATCHDOG_GRACE_MS));
  log(`🐕 巡检循环开始（每 ${WATCHDOG_INTERVAL_MS / 1000}s：桶补位兜底 + dev 探测 + 心跳）`);
  for (;;) {
    try {
      // 1) 桶补位兜底：定时器被错过 / 失败重试 / 启动补位 三合一
      await maybeRunBucket('hourly-recovery');

      // 1.5) 方案C（批示「c」 trace 1a1cf86a8dee8aa9）：每日代码 bundle
      //      22h 认领 ≈ 每日一发；与 DB 备份无共锁（git 对象 vs sqlite）
      void maybeRunCodeBundle('maintenance-tick');

      // 2) dev 看门狗
      const up = await isDevUp();
      if (up) {
        if (watchdogFails > 0) log(`✓ dev 恢复正常`);
        watchdogFails = 0;
      } else {
        watchdogFails += 1;
        log(`✗ dev 探测失败（连续 ${watchdogFails}/${WATCHDOG_FAILS_TO_REVIVE}）`);
        if (watchdogFails >= WATCHDOG_FAILS_TO_REVIVE) {
          await reviveDev();
          watchdogFails = 0;
        }
      }

      // 3) 心跳（KEEPER-STATUS.json + 单例锁 mtime 续期）
      if (Date.now() - lastBeatAt >= HEARTBEAT_MS) {
        touchSingletonLock();
        await persistStatus();
      }
    } catch (e) {
      log(`⚠ 巡检异常（继续值守）：${(e as Error).message}`);
    }
    await new Promise(r => setTimeout(r, WATCHDOG_INTERVAL_MS));
  }
}

// ---------- 健康端点 ----------
function startHealthServer(): void {
  try {
    Bun.serve({
      port: PORT,
      // P1-2（审计 2026-11-13）：0.0.0.0 → 127.0.0.1 —— 本端点暴露 pid/bootAt/
      // 备份清单/巡检历史等内部运行时态，仅本机监督链路（supervisor 用状态文件、
      // Caddy 经 localhost 代理）需要访问；绑回环后外部网络面不可达。
      hostname: '127.0.0.1',
      async fetch() {
        const manifest = await readManifestSummary();
        return Response.json({
          ok: true,
          service: 'backup-keeper',
          pid: process.pid,
          bootAt: bootAt.toISOString(),
          nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
          bucket: bucketMark ? { mark: bucketMark.toISOString(), attempts: bucketAttempts } : null,
          inFlight,
          lastRun,
          devRevivals,
          watchdogConsecutiveFails: watchdogFails,
          manifestLatestValid: manifest.latestValid,
          codeBundle: codeBundleState,
          autoSave: {
            enabled: autoSaveEnabled,
            intervalMin: AUTO_SAVE_INTERVAL_MIN,
            checkedAt: autoCheckedAt,
            nextRunAt: autoNextRunAt ? autoNextRunAt.toISOString() : null,
            lastRunAt: autoLastRunAt,
            lastTrigger: autoLastTrigger,
            halt: readAutosaveHalt(),
            haltRejects: autoHaltRejects,
            lastRejectAt: autoLastRejectAt,
          },
          history: history.slice(0, 6),
        });
      },
    });
    log(`🩺 健康端点就绪：127.0.0.1:${PORT}（仅本机可达）`);
  } catch (e) {
    log(`✗ 健康端点启动失败（可能有另一实例）：${(e as Error).message}`);
  }
}

// ---------- 入口 ----------
const ONCE = process.env.GOATB_KEEPER_ONCE === '1';
const FORCE = process.env.GOATB_KEEPER_FORCE === '1';

if (ONCE) {
  // 一次性验证模式：不占单例锁、不起健康端点、不起定时器。
  // 仍受暂停标记与备份锁（protect-db 内部）约束。
  log(`🧪 一次性模式（force=${FORCE}）`);
  await maybeRunBucket(FORCE ? 'once-force' : 'once', { force: FORCE });
  log(`🧪 一次性模式结束`);
  process.exit(0);
}

if (!acquireSingletonLock()) {
  log(`⏭ 已有 backup-keeper 实例在运行（/tmp/goatb-keeper.lock）—— 本实例退出`);
  process.exit(0);
}

log(`🛡 backup-keeper 启动（pid=${process.pid}，PROJECT_ROOT=${PROJECT_ROOT}）；方案C 代码 bundle 已挂载（22h 认领 ≈ 每日一发，保留 ${CODE_BUNDLE_KEEP} 份 + 基线豁免）`);
startHealthServer();
scheduleNextHourly();
scheduleNextAutoSave();
void maintenanceLoop();
await persistStatus();
