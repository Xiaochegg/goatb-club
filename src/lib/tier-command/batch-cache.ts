// ============================================================
// Tier Command · 同步批次快照缓存（R3「清空→自动化缓存导入」，批复 2026-11-07）
// ------------------------------------------------------------
// 批复原文要点：「加一个自动化缓存导入 每当检测到清空时重置」
// 机制：
//   - 每次真实同步（非 dryRun）解析到 >0 行后，把本次展示行载荷原样落盘
//     （Config 单 key JSON，与 tier_command_sync_state 同载体纪律）；
//   - 同步时检测到文档被清空（0 数据行且表头为空，isSheetWiped）→
//     自动回退展示上次快照（rows 原样透传），水位/审批/文档零改动；
//   - 清空态绝不写水位、绝不写本缓存（快照语义 = 「最后一次非空实时批次」）。
// 本层零业务解释：rows 结构由调用方（sync route SyncRowPayload）定义，
// 本层按 unknown[] 原样存取；坏 JSON 防御式返回 null，绝不抛错阻断同步主流程。
// ============================================================

import { db } from '@/lib/db';

export const TIER_BATCH_CACHE_KEY = 'tier_command_batch_cache';

export interface TierBatchCacheValue {
  version: 1;
  savedAt: string; // ISO（快照定格时刻 = 该次同步时刻）
  tabId: string;   // 快照来源 tab（应恒为 y344e4；防御式记录）
  schemaVersion: string;
  rowCount: number;
  /** SyncRowPayload[] 原样透传（本层不解释） */
  rows: unknown[];
}

/** 防御式读取：缺 key / 坏 JSON / 结构不符 → null（调用方按「无缓存」处理） */
export async function readBatchCache(): Promise<TierBatchCacheValue | null> {
  try {
    const row = await db.config.findUnique({ where: { key: TIER_BATCH_CACHE_KEY } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<TierBatchCacheValue> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.rows)) return null;
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      tabId: typeof parsed.tabId === 'string' ? parsed.tabId : '',
      schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : '',
      rowCount: typeof parsed.rowCount === 'number' ? parsed.rowCount : parsed.rows.length,
      rows: parsed.rows,
    };
  } catch {
    return null; // 坏 JSON：按无缓存处理（清空时降级为「无法自动导入」警告路径）
  }
}

/** 写入快照（整 key 覆盖；调用方仅在非 dryRun 且解析 >0 行时调用） */
export async function writeBatchCache(value: TierBatchCacheValue): Promise<void> {
  await db.config.upsert({
    where: { key: TIER_BATCH_CACHE_KEY },
    create: { key: TIER_BATCH_CACHE_KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
}
