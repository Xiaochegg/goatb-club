// ============================================================
// W1-T1b · Tier 结构升级（应用层，零 schema 变更）
// ============================================================
// 旧 tiers JSON: { SHIELD: "HT1", CRYSTAL: "LT2" }
// 新 tiers JSON: { SHIELD: { tier: "HT1", source: "legacy", updatedAt: "2026-..." }, ... }
//
// 策略：
// - Prisma 字段 tiers 仍是 String（SQLite），零 drop 零迁移风险
// - 本模块是读写 tiers 的唯一入口，向后兼容旧格式（读时自动升级，写时落新格式）
// - JIAHAO（LZ/LL 系）与 EMOTION 完全不受影响（它们走 likes/emotionText，不经过 tiers 解析）
//
// 回滚：若需退回旧格式，调用 downgradeAllTiers(json) 即可（见本模块底部）

export type TierSource = 'auto' | 'manual' | 'legacy';

export interface ModeTier {
  tier: string;
  source: TierSource;
  updatedAt: string;       // ISO 8601
}

export type TiersMap = Record<string, ModeTier>;

// 旧格式类型（值是字符串）
type LegacyTiersMap = Record<string, string>;

/** 判断 tiers JSON 是否已是新格式（至少一个值是对象） */
export function isUpgradedTiers(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const vals = Object.values(parsed);
    if (vals.length === 0) return true;  // 空对象视为已升级
    return typeof vals[0] === 'object';
  } catch {
    return false;
  }
}

/** 读 tiers JSON（兼容旧格式，读时自动升级但不写回） */
export function parseTiers(raw: string | null | undefined): TiersMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: TiersMap = {};
    for (const [mode, val] of Object.entries(parsed)) {
      if (typeof val === 'string') {
        // 旧格式 → 升级
        result[mode] = { tier: val, source: 'legacy', updatedAt: '1970-01-01T00:00:00.000Z' };
      } else if (typeof val === 'object' && val !== null && 'tier' in val) {
        result[mode] = val as ModeTier;
      }
      // 其他类型跳过
    }
    return result;
  } catch {
    return {};
  }
}

/** 序列化 tiers 为新格式 JSON 字符串 */
export function serializeTiers(tiers: TiersMap): string {
  return JSON.stringify(tiers);
}

/** 设置某模式的 tier（新格式，source=manual） */
export function setModeTier(
  tiers: TiersMap,
  mode: string,
  tier: string,
  source: TierSource = 'manual',
): TiersMap {
  return {
    ...tiers,
    [mode]: { tier, source, updatedAt: new Date().toISOString() },
  };
}

/** 批量升级旧格式 tiers 为新格式（回填 source='legacy'） */
export function upgradeLegacyTiers(raw: string | null | undefined): string {
  const tiers = parseTiers(raw);
  return serializeTiers(tiers);
}

/** 回滚：把新格式降级回旧格式（应急用） */
export function downgradeTiers(raw: string | null | undefined): string {
  const tiers = parseTiers(raw);
  const legacy: LegacyTiersMap = {};
  for (const [mode, mt] of Object.entries(tiers)) {
    legacy[mode] = mt.tier;
  }
  return JSON.stringify(legacy);
}

/**
 * 把 tiers JSON（新或旧格式）转为旧格式对象 Record<string,string>
 * 用途：API 层返回给前端时降级，前端代码零改动
 * （DB 存新格式 {tier,source,updatedAt}，API 返回旧格式 {tier:"HT1"}）
 * W3 需要 source 时走专用 API 字段，不经过此降级
 */
export function toLegacyTiersMap(raw: string | null | undefined): Record<string, string> {
  const tiers = parseTiers(raw);
  const legacy: Record<string, string> = {};
  for (const [mode, mt] of Object.entries(tiers)) {
    legacy[mode] = mt.tier;
  }
  return legacy;
}

/**
 * 把 DB player 对象的 tiers 字段降级为旧格式 JSON 字符串
 * 用途：players API 返回前调用，前端 JSON.parse 后得到旧格式 Record<string,string>
 * 加法式改造：不改 player 其他字段，只重写 tiers 字符串
 */
export function normalizePlayerTiers<T extends { tiers: string }>(player: T): T {
  return { ...player, tiers: JSON.stringify(toLegacyTiersMap(player.tiers)) };
}

/** 批量降级 */
export function normalizePlayersTiers<T extends { tiers: string }>(players: T[]): T[] {
  return players.map(normalizePlayerTiers);
}

/** 取某模式的 tier 值（字符串或 null） */
export function getModeTier(raw: string | null | undefined, mode: string): string | null {
  const tiers = parseTiers(raw);
  return tiers[mode]?.tier ?? null;
}

/** 取某模式的 source（用于 UI 显示数据来源） */
export function getModeTierSource(raw: string | null | undefined, mode: string): TierSource | null {
  const tiers = parseTiers(raw);
  return tiers[mode]?.source ?? null;
}
