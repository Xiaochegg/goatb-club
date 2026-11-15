// ============================================================
// W1-T2 · 参评资格判定（应用层纯函数）
// ============================================================
// 门槛：玩家在所有模式的总有效场次 >= MIN_MATCHES（默认 5，Config 可调）
// 0W0L 玩家（场次 0）不算有效参评，进未参评区
//
// 纯函数：输入 player + minMatches，输出 boolean。无副作用，可单测。
// 兼容新旧 tiers 格式（不依赖 tiers，只用 stats）。
// JIAHAO 与 EMOTION 不受影响：JIAHAO 的 stats 仍计入总场次；EMOTION 走 likes，不经过本函数。

import type { ScoredPlayer } from './scoring';

/** 计算玩家所有模式的总场次 */
export function getTotalMatches(player: Pick<ScoredPlayer, 'stats'>): number {
  if (!player.stats) return 0;
  let total = 0;
  for (const s of Object.values(player.stats)) {
    if (s && typeof s.matches === 'number') total += s.matches;
  }
  return total;
}

/** 计算玩家所有模式的总胜场 */
export function getTotalWins(player: Pick<ScoredPlayer, 'stats'>): number {
  if (!player.stats) return 0;
  let total = 0;
  for (const s of Object.values(player.stats)) {
    if (s && typeof s.wins === 'number') total += s.wins;
  }
  return total;
}

/** 计算玩家所有模式的总败场（matches - wins，不小于 0） */
export function getTotalLosses(player: Pick<ScoredPlayer, 'stats'>): number {
  return Math.max(getTotalMatches(player) - getTotalWins(player), 0);
}

/**
 * 判定玩家是否有效参评
 * @param player 玩家数据（只需 stats 字段）
 * @param minMatches 最低场次门槛（默认 5，从 Config 读取）
 * @returns true = 有效参评（进主榜单），false = 未参评（进折叠区）
 */
export function isEligible(player: Pick<ScoredPlayer, 'stats'>, minMatches: number = 5): boolean {
  const total = getTotalMatches(player);
  const wins = getTotalWins(player);
  const losses = getTotalLosses(player);
  // 双条件：场次达标 AND 有胜负记录（防止只刷败场不赢的异常数据）
  return total >= minMatches && (wins + losses) > 0;
}

/** 批量统计：有效参评数 / 未参评数 */
export function getEligibilityStats(players: Pick<ScoredPlayer, 'stats'>[], minMatches: number = 5) {
  let eligible = 0;
  let ineligible = 0;
  for (const p of players) {
    if (isEligible(p, minMatches)) eligible++;
    else ineligible++;
  }
  return {
    total: players.length,
    eligible,
    ineligible,
  };
}
