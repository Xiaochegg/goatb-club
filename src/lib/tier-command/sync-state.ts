// ============================================================
// Tier Command · 同步指纹持久层（P1-C，Config 单 key JSON 过渡）
// ------------------------------------------------------------
// 已确认决策（用户 2026-11-04 拍板，不改 schema）：
//   - 持久化载体：Config 表单 key（key 固定 tier_command_sync_state），
//     value = JSON，不改 Prisma schema、不建新表；
//   - 跨重启幂等：指纹 sha256(P1-B fingerprintTicket 规格) → 已见即 duplicate；
//   - 写入用 prisma.$transaction 读-改-写，避免并发丢数据；
//   - 保留策略：最多 2000 条指纹，按 lastSeenAt 裁剪；
//   - dryRun=true 不写 Config；
//   - Config 写入失败不让整次同步失败：降级为内存幂等，
//     返回 warnings 标记 CONFIG_WRITE_FAILED（由调用方负责）。
// value 结构：
//   { version:1, updatedAt,
//     fingerprints: { [sha256]: { firstSeenAt, lastSeenAt, rowIndex, tier, status,
//                                 targetName?, approved?, contentSnapshot? } } }
// 零业务解释：本层只存取指纹，不判断 READY/INVALID 语义（status 原样透传）。
//
// T3 存储兼容（2026-11-05，方案 A 第二版 §六）：
//   - 新增可选字段 contentSnapshot（T1 TierContentSnapshot，cfp1 内容指纹 +
//     14 逻辑字段原始值）——属 Config JSON value 的结构演进，不动 Prisma schema：
//     · 旧条目（无该字段）→ 读取端得 undefined，按「无快照」处理，绝不猜测回填；
//     · 新代码读旧数据 ✓（可选缺省）；旧代码读新数据 ✓（旧 parseSyncState 直接
//       cast 透传未知字段，不擦除）；
//     · version 保持 1（本层 parse 从不校验 version，字段为装饰性；演进由
//       可选字段兼容承担，无需 bump）；
//     · 回滚 = 旧代码忽略该字段，数据无损；无需任何数据迁移。
//   - 合并语义（mergeFingerprintEntry 纯函数，mergeSyncState 消费）：
//     firstSeenAt / approved / contentSnapshot —— 已有值优先（历史审批与快照
//     绝不被后续同步覆盖）；lastSeenAt / rowIndex / tier / status / targetName
//     —— 同步侧刷新优先（与既有行为一致）；
//     reviewRejected / rollback（管理员操作事实，拒绝/回档路由直写）——
//     已有值优先（同步永不覆盖管理员决定；撤销后为 null，保持 null）；
//     dupKey（R2 多字段重复检测组合键，派生字段）—— 同步侧刷新优先。
//     inheritanceState / legacyApprovedUnverified（T4 新增，派生判定字段）——
//     同步侧刷新优先（每次同步重算，随最新判定走）；
//     supersededBy（T4 新增，历史事实字段）—— 已有值优先（取代标记不可撤销，
//     只增不删，审计可追）。
//   - 本层不做生产数据迁移（T8 负责）；不判断继承语义（T4 状态机负责）。
// ============================================================

import { db } from '@/lib/db';
import type { TierContentSnapshot } from './content-fingerprint';

export const TIER_SYNC_STATE_KEY = 'tier_command_sync_state';

/** 审批标记引用（approved 与 legacyApprovedUnverified 共用结构） */
export type TierApprovedRef = NonNullable<SyncStateFingerprintEntry['approved']>;

/** 保留策略上限：按 lastSeenAt 升序裁剪，仅留最近 N 条 */
export const TIER_SYNC_STATE_MAX_FINGERPRINTS = 2000;

export interface SyncStateFingerprintEntry {
  firstSeenAt: string; // ISO
  lastSeenAt: string;  // ISO
  rowIndex: number;    // sheet 行号（1 = 第一条数据行）
  tier: string | null; // 归一化大写 tier（G 列信源；未命中词表为 null）
  status: string;      // TierStatus 透传：READY | PLAYER_MISSING | INVALID
  /** P2：同步时定格的被测玩家（⑥列 F）游戏 id —— 写榜对象服务端真值（防 UI 篡改）；旧行为 null */
  targetName?: string | null;
  /** P2：审批写入后回填（幂等拦截依据）；null/缺省 = 未审批 */
  approved?: {
    at: string;          // ISO 审批时刻
    by: string;          // 操作人用户名
    tier: string;        // 实际写入的 tier
    mode: string;        // 实际写入的模式（GameMode）
    playerId: string | null;
    playerName: string;
    created: boolean;    // 是否由工单自动创建玩家
    logId: string | null; // OperationLog id（审计联动）
  } | null;
  /** T3：工单内容快照（cfp1：contentFp/contentFpNoTime + 14 逻辑字段原始值）。
   *  可选演进字段：旧行缺省（undefined）=「无快照」，读取端绝不猜测回填；
   *  同步管线提供时落盘；已有值在合并时优先（防后续同步覆盖）。 */
  contentSnapshot?: TierContentSnapshot | null;
  /** T4：最近一次同步的继承状态机判定（A_INHERITED/B_CONTENT_CHANGED/
   *  C_AMBIGUOUS/D_NO_MATCH/LEGACY_UNVERIFIED）。派生字段，随同步刷新；
   *  旧行缺省 = 尚未经状态机判定。approve 链（T5）据此实施分级拦截。 */
  inheritanceState?: string | null;
  /** T4：LEGACY_UNVERIFIED 态下的历史原审批对象（内容不可核实需人工确认）；
   *  仅存证，不等于 approved（不触发 ALREADY_APPROVED 硬拦截）。 */
  legacyApprovedUnverified?: TierApprovedRef | null;
  /** T4：被取代标记 —— 当同内容（同 contentFp）工单移动到其他物理行时，
   *  旧键标记 supersededBy=新行指纹键（内容谱系延续）；
   *  已取代条目不再参与内容匹配索引（防止单逻辑工单多键导致的永久歧义），
   *  但条目本身与 approved 保留（审计纪律：只标记不删除）。 */
  supersededBy?: string | null;
  /** R2（2026-11-06）：管理员拒绝标记 —— 拒绝后该记录不再是写入候选，
   *  跨同步持久（仅管理员显式撤销恢复）；同步不覆盖、不删除。
   *  不删腾讯文档原始数据、不影响该测试者未来新记录。 */
  reviewRejected?: {
    at: string;          // ISO 拒绝时刻
    by: string;          // 操作人用户名
    reason: string | null; // 拒绝原因（可空）
  } | null;
  /** R2：回档标记 —— 该工单的写入已被回档恢复（approved 保留作历史事实，
   *  但不再触发 ALREADY_APPROVED 硬拦截；重新写入须显式确认）。 */
  rollback?: {
    at: string;          // ISO 回档时刻
    by: string;          // 操作人用户名
    sourceLogId: string; // 被回档的 OperationLog id（审计联动）
  } | null;
  /** R2：多字段重复检测组合键（测试者+测试日期+考核者+项目+tier），
   *  派生字段随同步刷新；供疑似重复比对（识别已写入记录防重复录入）。 */
  dupKey?: string | null;
}

export interface SyncStateValue {
  version: 1;
  updatedAt: string;
  fingerprints: Record<string, SyncStateFingerprintEntry>;
}

// ---------- 序列化 / 反序列化（防御式：坏 JSON 不抛，按空态处理） ----------

export function parseSyncState(raw: string | null | undefined): SyncStateValue {
  const fallback: SyncStateValue = { version: 1, updatedAt: '', fingerprints: {} };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncStateValue> | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.fingerprints || typeof parsed.fingerprints !== 'object') {
      return fallback;
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      fingerprints: parsed.fingerprints as Record<string, SyncStateFingerprintEntry>,
    };
  } catch {
    return fallback; // 坏 JSON：不抛、按空态处理（首次幂等失效可接受，不阻断同步）
  }
}

export function serializeSyncState(state: SyncStateValue): string {
  return JSON.stringify(state);
}

// ---------- 读 ----------

export async function readSyncState(): Promise<SyncStateValue> {
  const row = await db.config.findUnique({ where: { key: TIER_SYNC_STATE_KEY } });
  return parseSyncState(row?.value ?? null);
}

// ---------- 写（事务读-改-写，避免并发丢数据） ----------

export interface MergeSyncStateResult {
  state: SyncStateValue;
  /** 本次实际新写入的指纹数（写入前 state 中不存在的） */
  added: number;
}

/**
 * 单条指纹合并（T3 抽取为纯函数，便于兼容性测试；mergeSyncState 消费）。
 * 优先级纪律（与既有行为逐字段一致 + T3 新增字段同纪律）：
 *   - 已有值优先（历史不可被同步覆盖）：firstSeenAt / approved / contentSnapshot；
 *   - 同步侧刷新优先：lastSeenAt / rowIndex / tier / status / targetName。
 *   注：approved/contentSnapshot 的「已有值」指非 null 的既有对象；
 *   existing 为 null/undefined 时采纳 incoming（迁移继承/首次落盘通道）。
 */
export function mergeFingerprintEntry(
  existing: SyncStateFingerprintEntry | undefined,
  incoming: SyncStateFingerprintEntry,
  nowIso: string,
): SyncStateFingerprintEntry {
  return {
    firstSeenAt: existing?.firstSeenAt ?? incoming.firstSeenAt ?? nowIso,
    lastSeenAt: incoming.lastSeenAt ?? nowIso,
    rowIndex: incoming.rowIndex,
    tier: incoming.tier ?? null,
    status: incoming.status,
    targetName: incoming.targetName ?? existing?.targetName ?? null,
    // 审批标记透传：已审批行重新同步时不丢（lastSeenAt 刷新不覆盖 approved）
    approved: existing?.approved ?? incoming.approved ?? null,
    // T3：内容快照同纪律——已有快照优先（同 fp ⇒ 同内容，先到先存防覆盖）
    contentSnapshot: existing?.contentSnapshot ?? incoming.contentSnapshot ?? null,
    // T4：继承判定为派生字段，随同步刷新（incoming 优先，缺省回退 existing）
    inheritanceState: incoming.inheritanceState ?? existing?.inheritanceState ?? null,
    legacyApprovedUnverified: incoming.legacyApprovedUnverified ?? existing?.legacyApprovedUnverified ?? null,
    // T4：取代标记为历史事实，已有值优先（不可撤销）
    supersededBy: existing?.supersededBy ?? incoming.supersededBy ?? null,
    // R2：管理员拒绝/回档为操作事实，已有值优先（同步永不覆盖管理员决定；
    // 撤销后 existing 为 null → 保持 null，不会被复活）
    reviewRejected: existing?.reviewRejected ?? incoming.reviewRejected ?? null,
    rollback: existing?.rollback ?? incoming.rollback ?? null,
    // R2：重复检测组合键为派生字段，同步侧刷新优先
    dupKey: incoming.dupKey ?? existing?.dupKey ?? null,
  };
}

/**
 * 保留策略裁剪（T3 抽取为纯函数）：按 lastSeenAt 升序排序，仅保留最近 max 条。
 * 注意：裁剪只看 lastSeenAt，不豁免 approved 条目（既有策略，2000 上限内不现实触发）。
 */
export function pruneSyncStateFingerprints(
  state: SyncStateValue,
  max: number = TIER_SYNC_STATE_MAX_FINGERPRINTS,
): SyncStateValue {
  const keys = Object.keys(state.fingerprints);
  if (keys.length > max) {
    keys.sort((a, b) =>
      (state.fingerprints[a]?.lastSeenAt || '').localeCompare(state.fingerprints[b]?.lastSeenAt || ''),
    );
    for (const k of keys.slice(0, keys.length - max)) {
      delete state.fingerprints[k];
    }
  }
  return state;
}

/**
 * 合并一批指纹并持久化。
 * - 事务内重读-合并-写回：以事务内读到的为准，避免读-写窗口内丢其他写入；
 * - 逐条合并语义见 mergeFingerprintEntry（历史审批/快照不可覆盖）；
 * - 裁剪：合并后按 lastSeenAt 升序排序，仅保留最近 MAX 条（pruneSyncStateFingerprints）；
 * - 不在本层捕获异常：调用方需自行将写失败降级为内存幂等 + CONFIG_WRITE_FAILED 警告。
 */
export async function mergeSyncState(
  entries: Record<string, SyncStateFingerprintEntry>,
  nowIso: string,
): Promise<MergeSyncStateResult> {
  const state = await db.$transaction(async tx => {
    const row = await tx.config.findUnique({ where: { key: TIER_SYNC_STATE_KEY } });
    const current = parseSyncState(row?.value ?? null);
    let added = 0;
    for (const [fp, entry] of Object.entries(entries)) {
      if (!current.fingerprints[fp]) added += 1;
      current.fingerprints[fp] = mergeFingerprintEntry(current.fingerprints[fp], entry, nowIso);
    }
    pruneSyncStateFingerprints(current);
    current.updatedAt = nowIso;
    await tx.config.upsert({
      where: { key: TIER_SYNC_STATE_KEY },
      create: { key: TIER_SYNC_STATE_KEY, value: serializeSyncState(current) },
      update: { value: serializeSyncState(current) },
    });
    return { state: current, added };
  });
  return state;
}

// ---------- 定向修改（拒绝/回档路由用：事务读-改-写，不刷新 lastSeenAt） ----------

export interface MutateSyncStateEntriesResult {
  /** 实际存在的键（未知的键不修改，由调用方按 FINGERPRINT_UNKNOWN 报告） */
  applied: string[];
}

/**
 * 定向修改若干指纹条目（管理员操作落盘通道：拒绝/撤销拒绝/回档标记）。
 * - 事务内重读-改-写，与 mergeSyncState 同并发纪律；
 * - mutator 返回 null → 删除该键？禁止：审计纪律只增不删，mutator 必须返回对象；
 * - 不触碰 lastSeenAt（那是同步管线的职责）；
 * - 同样执行保留策略裁剪（维持上限不变）；
 * - 不在本层捕获异常：调用方需自行处理写失败（返回 5xx，绝不假报成功）。
 */
export async function mutateSyncStateEntries(
  mutator: (entry: SyncStateFingerprintEntry, fp: string) => SyncStateFingerprintEntry,
  keys: string[],
  nowIso: string,
): Promise<MutateSyncStateEntriesResult> {
  const applied = await db.$transaction(async tx => {
    const row = await tx.config.findUnique({ where: { key: TIER_SYNC_STATE_KEY } });
    const current = parseSyncState(row?.value ?? null);
    const touched: string[] = [];
    for (const fp of keys) {
      const entry = current.fingerprints[fp];
      if (!entry) continue; // 未知键不动，由调用方按行报告
      current.fingerprints[fp] = mutator(structuredClone(entry), fp);
      touched.push(fp);
    }
    if (touched.length > 0) {
      pruneSyncStateFingerprints(current);
      current.updatedAt = nowIso;
      await tx.config.upsert({
        where: { key: TIER_SYNC_STATE_KEY },
        create: { key: TIER_SYNC_STATE_KEY, value: serializeSyncState(current) },
        update: { value: serializeSyncState(current) },
      });
    }
    return touched;
  });
  return { applied };
}

// ---------- 幂等判定辅助 ----------

/** 指纹是否已见过（跨重启持久水位） */
export function isKnownFingerprint(state: SyncStateValue, fingerprint: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.fingerprints, fingerprint);
}
