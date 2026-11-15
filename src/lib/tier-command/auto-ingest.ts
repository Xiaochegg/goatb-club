// ============================================================
// Tier Command · 收集表自动同步调度器（AUTO-INGEST SCHEDULER）
// ------------------------------------------------------------
// 管理员指令（IM 2026-11-09）：「自动存档」必须是服务端常开定时器 ——
//   不依赖任何设备的登录状态；开关+间隔持久化在 Config；重新部署/重启后
//   自动检测持久化状态并恢复运行，开机立即先拉一轮（把群里收集表内容
//   自动倒进台账）。
// 实现：
//   - 定时器跑在本进程内（src/instrumentation.ts 注册，boot 时 ensure 启动）；
//   - 复用 ingestCollectSheet 既有幂等管线（rowFingerprint DB 层硬保证，
//     重复拉取仅计数，绝不重复累计）；
//   - 间隔可选 5/10/30/60 分钟（Config tier_auto_ingest_interval_min，默认 10）；
//   - 开关 Config tier_auto_ingest_enabled（'on'/'off'，默认 off ——
//     由管理员在后台按下按钮显式开启，符合「放个按钮让它开着」）；
//   - 最近一次运行结果持久化 Config tier_auto_ingest_last_run（含失败 ——
//     失败批次不落 TierSyncBatch 行，必须在此留痕，绝不假报成功）；
//   - busy 互斥：同一时刻至多一个 tick 在跑（定时器/开机/手动开启三源共用）；
//   - 边界（治理红线，不可动摇）：自动同步只到「台账入库+识别整理」为止；
//     写玩家档案（Player.tiers）永远走 ledger-approve 人工逐条审批 +
//     玩家确认环节。本模块绝不触碰 Player 表。
// ============================================================

import { db } from '@/lib/db';
import { ingestCollectSheet } from './ingest';
import { TencentDocError } from './tencent-doc-client';

const KEY_ENABLED = 'tier_auto_ingest_enabled';
const KEY_INTERVAL = 'tier_auto_ingest_interval_min';
const KEY_LAST_RUN = 'tier_auto_ingest_last_run';

export const ALLOWED_INTERVALS = [5, 10, 30, 60] as const;
export type AutoIngestInterval = (typeof ALLOWED_INTERVALS)[number];

export type AutoTrigger = 'boot' | 'timer' | 'manual-toggle' | 'manual-api';

export interface AutoIngestLastRun {
  at: string;              // ISO 时间
  ok: boolean;
  code?: string;           // 失败时的错误码（TencentDocError.code 或 INTERNAL）
  message?: string;        // 失败原因（绝不假报成功）
  trigger: AutoTrigger;    // 本轮由谁触发
  newRecords?: number;     // 成功时：本轮新建台账记录数
  mergedDupes?: number;    // 成功时：本轮合并重复数
  idempotentHits?: number; // 成功时：幂等命中数
  readyCount?: number;     // 成功时：台账当前待归档总数
  pendingReviewCount?: number; // 成功时：台账当前待核对总数
}

export interface AutoIngestStatus {
  enabled: boolean;
  intervalMin: AutoIngestInterval;
  schedulerRunning: boolean;  // 定时器是否在运行
  busy: boolean;              // 当前是否正在拉取
  nextRunAt: string | null;   // 下次定时拉取时间（未开启时 null）
  lastRun: AutoIngestLastRun | null;
}

// ---------- 运行时状态（挂 globalThis：dev 热重载/多模块实例防双注册） ----------

interface RuntimeState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  intervalMin: AutoIngestInterval | null;
  busy: boolean;
  lastRun: AutoIngestLastRun | null;
  nextRunAt: string | null;
}

const G = globalThis as unknown as { __tierAutoIngest?: RuntimeState };

function state(): RuntimeState {
  if (!G.__tierAutoIngest) {
    G.__tierAutoIngest = {
      started: false, timer: null, intervalMin: null,
      busy: false, lastRun: null, nextRunAt: null,
    };
  }
  return G.__tierAutoIngest;
}

// ---------- Config 持久化 ----------

function upsertConfig(key: string, value: string) {
  return db.config.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function readEnabled(): Promise<boolean> {
  const row = await db.config.findUnique({ where: { key: KEY_ENABLED } });
  return row?.value === 'on';
}

async function readInterval(): Promise<AutoIngestInterval> {
  const row = await db.config.findUnique({ where: { key: KEY_INTERVAL } });
  const n = row ? Number.parseInt(row.value, 10) : NaN;
  return (ALLOWED_INTERVALS as readonly number[]).includes(n) ? (n as AutoIngestInterval) : 10;
}

async function readLastRun(): Promise<AutoIngestLastRun | null> {
  const row = await db.config.findUnique({ where: { key: KEY_LAST_RUN } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as AutoIngestLastRun;
  } catch {
    return null; // 持久化数据损坏时不假装有历史
  }
}

// ---------- 定时器 ----------

function stopTimer(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  s.nextRunAt = null;
}

function scheduleTimer(intervalMin: AutoIngestInterval): void {
  const s = state();
  stopTimer();
  s.intervalMin = intervalMin;
  s.nextRunAt = new Date(Date.now() + intervalMin * 60_000).toISOString();
  s.timer = setInterval(() => {
    void runAutoIngestTick('timer');
  }, intervalMin * 60_000);
}

async function refreshSchedule(): Promise<void> {
  const enabled = await readEnabled();
  const interval = await readInterval();
  if (enabled) scheduleTimer(interval);
  else stopTimer();
}

// ---------- 核心 tick（三源共用：boot / timer / 手动开启） ----------

export async function runAutoIngestTick(trigger: AutoTrigger): Promise<AutoIngestLastRun> {
  const s = state();
  if (s.busy) {
    // 互斥：上一轮未结束不叠加（幂等管线保证下轮会补齐，绝不丢数据）
    return s.lastRun ?? {
      at: new Date().toISOString(), ok: false, code: 'BUSY',
      message: '上一轮自动同步仍在执行，本轮跳过（数据不会丢，下轮自动补齐）', trigger,
    };
  }
  s.busy = true;
  try {
    const r = await ingestCollectSheet({ dryRun: false });
    const info: AutoIngestLastRun = {
      at: new Date().toISOString(), ok: true, trigger,
      newRecords: r.stats.newRecords,
      mergedDupes: r.stats.mergedDupes,
      idempotentHits: r.stats.idempotentHits,
      readyCount: r.stats.readyCount,
      pendingReviewCount: r.stats.pendingReviewCount,
    };
    s.lastRun = info;
    await upsertConfig(KEY_LAST_RUN, JSON.stringify(info));
    return info;
  } catch (err) {
    let code = 'INTERNAL';
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof TencentDocError) {
      code = err.code;
      message = err.message;
    }
    const info: AutoIngestLastRun = { at: new Date().toISOString(), ok: false, code, message, trigger };
    s.lastRun = info;
    try {
      await upsertConfig(KEY_LAST_RUN, JSON.stringify(info));
    } catch {
      // 持久化失败不掩盖主错误——运行时内存里仍有 lastRun
    }
    return info;
  } finally {
    s.busy = false;
    if (s.timer && s.intervalMin) {
      s.nextRunAt = new Date(Date.now() + s.intervalMin * 60_000).toISOString();
    }
  }
}

// ---------- boot 恢复（src/instrumentation.ts 调用） ----------

export async function ensureAutoIngestStarted(): Promise<void> {
  const s = state();
  if (s.started) return; // 防双注册（dev 热重载/多实例导入）
  s.started = true;
  try {
    s.lastRun = await readLastRun();
    const enabled = await readEnabled();
    if (enabled) {
      const interval = await readInterval();
      scheduleTimer(interval);
      // 重新部署/重启后自动检测持久化开关 → 立即先拉一轮（延迟 8s 等 DB/网络就绪；
      // 失败仅留痕，绝不影响服务器启动）
      setTimeout(() => { void runAutoIngestTick('boot'); }, 8_000);
    }
  } catch (e) {
    console.error('[tier-auto-ingest] 启动恢复失败（不影响服务器启动）:', e);
  }
}

// ---------- 管理操作（API 路由调用） ----------

export async function setAutoIngestConfig(input: {
  enabled?: boolean;
  intervalMin?: number;
}): Promise<{ run: AutoIngestLastRun | null }> {
  if (input.intervalMin !== undefined) {
    if (!(ALLOWED_INTERVALS as readonly number[]).includes(input.intervalMin)) {
      throw new Error(`非法间隔：${input.intervalMin}（可选 ${ALLOWED_INTERVALS.join('/')} 分钟）`);
    }
    await upsertConfig(KEY_INTERVAL, String(input.intervalMin));
  }
  if (input.enabled !== undefined) {
    await upsertConfig(KEY_ENABLED, input.enabled ? 'on' : 'off');
  }
  await refreshSchedule();
  // 开启（或对已开启状态做任何设置变更）→ 立即拉一轮，管理员立刻看到最新台账
  if (input.enabled === true && !state().busy) {
    return { run: await runAutoIngestTick('manual-toggle') };
  }
  return { run: null };
}

export async function getAutoIngestStatus(): Promise<AutoIngestStatus> {
  const s = state();
  const [enabled, intervalMin] = [await readEnabled(), await readInterval()];
  return {
    enabled,
    intervalMin,
    schedulerRunning: s.timer !== null,
    busy: s.busy,
    nextRunAt: s.timer ? s.nextRunAt : null,
    lastRun: s.lastRun ?? (await readLastRun()),
  };
}
