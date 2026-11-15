// ============================================================
// Scoring Engine — single source of truth for player score calculation
// ============================================================
// P1 fix (audit P1-4): previously getPlayerModeScore / getPlayerTotalScore /
// getTierScore were duplicated in page.tsx and api/v1/stats/route.ts, risking
// drift when the scoring rules change. This module is the single source.
//
// Both client (PlayerData from store) and server (ParsedPlayer from Prisma)
// consume the same helpers via the ScoredPlayer interface.

import {
  NORMAL_MODES,
  NORMAL_TIER_SCORES,
  JIAHAO_TIER_SCORES,
  type GameMode,
  type BoardMode,
  type Tier,
  type NormalTier,
  type JiahaoTier,
} from './constants';

// Minimal structural interface — any object with these fields can be scored.
// Works for both client PlayerData and server ParsedPlayer.
export interface ScoredPlayer {
  id: string;
  name: string;
  tiers?: Record<string, string>;
  overrideScores?: Record<string, number | null>;
  stats?: Record<string, { kills: number; deaths: number; wins: number; matches: number }>;
  likes?: number;
  emotionText?: string | null;
  tagStyle?: import('./tag-styles').TagStyle | null;  // 玩家个性标签样式（XtLeaderboard 徽章渲染用）
}

// --- Tier score lookup (mode-aware: 娱乐模式 JIAHAO/BIRD 用 LZ/LL 嘉豪积分表) ---
export function getTierScore(mode: string, tier: string | null): number {
  if (!tier) return 0;
  if (mode === 'JIAHAO' || mode === 'BIRD') return JIAHAO_TIER_SCORES[tier as JiahaoTier] ?? 0;
  return NORMAL_TIER_SCORES[tier as NormalTier] ?? 0;
}

// --- Player's score for a single game mode (override > tier > 0) ---
export function getPlayerModeScore(player: ScoredPlayer, mode: GameMode | string): number {
  const override = player.overrideScores?.[mode];
  if (override !== null && override !== undefined) return override;
  const tier = player.tiers?.[mode];
  if (!tier) return 0;
  return getTierScore(mode, tier as Tier);
}

// --- 玩家在某模式是否有段位（或管理员覆写分）---
// 段位是管理员手写的唯一权威值；覆写分是管理员直接指定的分数。
// 两者皆无 → 该模式积分为 0，不应出现在该模式榜单上（2026-10 修复：
// 修复前 0 分玩家会 clutter 单模式榜，截图反馈：嘉豪榜仅 2 人有段位却显示 9 人）。
export function hasModePresence(player: ScoredPlayer, mode: string): boolean {
  const override = player.overrideScores?.[mode];
  if (override !== null && override !== undefined) return true;
  return !!player.tiers?.[mode];
}

// --- 玩家是否在任意普通模式有段位（总榜门槛）---
// 总榜积分 = 11 个普通模式段位分之和（2026-10 接入 DSMP/矛锤/矿车，均沿用
// 统一 NORMAL_TIER_SCORES 点数表，无新增计分标准）；JIAHAO 不计入总榜。
// 全无段位 → 总分 0，不应出现在总榜。
export function hasAnyNormalModePresence(player: ScoredPlayer): boolean {
  return NORMAL_MODES.some(m => hasModePresence(player, m));
}

// --- Player's total score across all normal modes (JIAHAO excluded) ---
export function getPlayerTotalScore(player: ScoredPlayer): number {
  return NORMAL_MODES.reduce((sum, mode) => sum + getPlayerModeScore(player, mode), 0);
}

// --- Player's score for a board mode (TOTAL / EMOTION / specific GameMode) ---
export function getPlayerBoardScore(player: ScoredPlayer, mode: BoardMode): number {
  if (mode === 'TOTAL') return getPlayerTotalScore(player);
  if (mode === 'EMOTION') return player.likes || 0;
  return getPlayerModeScore(player, mode as GameMode);
}

// --- Sort players for a given board mode, with optional search + smart filters ---
// tierFilter: if set, only show players who have this tier in any mode
// statusFilter: 'all' | 'up' | 'down' | 'active' (active = has stats in current mode)
export function getSortedPlayers<T extends ScoredPlayer>(
  players: T[],
  mode: BoardMode,
  highFirst: boolean,
  search: string,
  options?: { tierFilter?: string | null; statusFilter?: 'all' | 'up' | 'down' | 'active' },
): T[] {
  let filtered = players;
  if (search) {
    filtered = filtered.filter(p => p.name.includes(search));
  }
  // 2026-10 修复：玩家必须在该模式有段位（或覆写分）才出现在该模式榜单上。
  // 0 分玩家不再 clutter 单模式榜/总榜。EMOTION 走点赞，不经过段位门槛。
  if (mode === 'TOTAL') {
    filtered = filtered.filter(p => hasAnyNormalModePresence(p));
  } else if (mode !== 'EMOTION') {
    const m = mode as string;
    filtered = filtered.filter(p => hasModePresence(p, m));
  }
  const tierFilter = options?.tierFilter ?? null;
  if (tierFilter) {
    filtered = filtered.filter(p => {
      const tiers = p.tiers || {};
      return Object.values(tiers).includes(tierFilter);
    });
  }
  const statusFilter = options?.statusFilter ?? 'all';
  if (statusFilter === 'active' && mode !== 'TOTAL' && mode !== 'EMOTION') {
    const m = mode as string;
    filtered = filtered.filter(p => {
      const s = p.stats?.[m];
      return s && s.matches > 0;
    });
  }

  if (mode === 'EMOTION') {
    // 感动榜（点赞榜）：纯按点赞数降序排序（2026-10 用户修正）。
    // 修复前：有感动文字的按 likes 排前、无文字的按总积分排后——
    // 导致 0 赞玩家凭总积分混进前三（用户截图反馈：第一名仅 1 赞，第二三名 0 赞）。
    // 现规则：likes DESC → 名字字母序破平。同赞数由 computeTieRanks 处理同名次。
    const cmpName = (a: T, b: T) => a.name.localeCompare(b.name, 'zh-Hans-CN');
    return [...filtered].sort((a, b) => ((b.likes || 0) - (a.likes || 0)) || cmpName(a, b));
  }
  const scored = filtered.map(p => ({
    player: p,
    score: getPlayerBoardScore(p, mode),
  }));
  // OPT：破平评分惰性记忆化——原实现 comparator 内直接调 getBoardRatingScore
  // （每次构造完整 breakdown 对象），大量并列时同一玩家被重复计算 O(n log n) 次；
  // 无并列时本就 0 次。缓存后每玩家至多 1 次，两端都最优。
  const ratingCache = new Map<T, number>();
  const ratingOf = (p: T): number => {
    let r = ratingCache.get(p);
    if (r === undefined) { r = getBoardRatingScore(p, mode); ratingCache.set(p, r); }
    return r;
  };
  // 排序规则（2026-10 用户需求）：积分优先；积分相同→ 战绩评分高者在前；
  // 评分也相同→ 名字字母序。同名次由 computeTieRanks 在展示层处理。
  scored.sort((a, b) => {
    const primary = highFirst ? b.score - a.score : a.score - b.score;
    if (primary !== 0) return primary;
    const rA = ratingOf(a.player);
    const rB = ratingOf(b.player);
    if (rA !== rB) return rB - rA;
    return a.player.name.localeCompare(b.player.name, 'zh-Hans-CN');
  });
  return scored.map(s => s.player);
}

// --- 破平用的战绩评分（2026-10 排名并列规则）---
// TOTAL 榜：聚合全部普通模式 stats 后计算；单模式榜：该模式 stats；
// EMOTION：破平退化为总积分。与详情弹窗“战绩评分”同一公式（computeRating）。
export function getBoardRatingScore(player: ScoredPlayer, mode: BoardMode | string): number {
  if (mode === 'EMOTION') return getPlayerTotalScore(player);
  if (mode === 'TOTAL') {
    const agg = { kills: 0, deaths: 0, wins: 0, matches: 0 };
    NORMAL_MODES.forEach(m => {
      const st = player.stats?.[m];
      if (st) { agg.kills += st.kills; agg.deaths += st.deaths; agg.wins += st.wins; agg.matches += st.matches; }
    });
    return computeRating(agg).total;
  }
  return computeRating(player.stats?.[mode]).total;
}

// --- 并列感知排名（密集排名 1,1,2,2,3,3）---
// 同积分 → 同名次（并列第一），下一名紧接（不跳号）。
// 2026-10 用户修正：从竞赛排名(1,1,3)改为密集排名(1,1,2)——
// 双#1之后下一名应为#2，而非跳到#3。
// sorted 必须已按 scoreOf 的展示顺序排好；scoreOf 必须与排序主键一致。
export function computeTieRanks<T>(sorted: T[], scoreOf: (p: T) => number): number[] {
  const ranks: number[] = [];
  let prevScore: number | null = null;
  let currentRank = 0;
  sorted.forEach((p) => {
    const s = scoreOf(p);
    if (prevScore === null || s !== prevScore) {
      currentRank += 1;
      prevScore = s;
    }
    ranks.push(currentRank);
  });
  return ranks;
}

// ============================================================
// W3 · 战绩评分（透明公示公式）
// ============================================================
// 与 tier-based score 并行：tier-based 用于段位榜排序（保留不变），
// 战绩评分用于详情弹窗"评分明细"展示 + RATING tooltip，让评分可解释。
//
// 公式（卡点③预批 + 用户修正）：
//   Rating = 基础分 + 1000 × 场次因子 × (0.40×K + 0.25×D + 0.20×W + 0.15×M)
//   - 基础分 = 1200
//   - 场次因子 = 1 - e^(-matches/30)  （0场=0, 30场≈0.63, 100场≈0.96）
//   - K = KD标准化 = min(kills/max(deaths,1), 3) / 3  （KD封顶3，归一化0-1）
//   - D = 死亡标准化 = 1 - min(deaths/matches, 1)  （场均死亡越低越好）
//   - W = 胜率 = wins / max(matches,1)
//   - M = 场次饱和 = 场次因子本身（场次越多贡献越高）
//
// 权重存 Config.rating_weights 可后台调（W3-T5）。
// isEligible 门槛（MIN_MATCHES=5）独立生效，0场次玩家 Rating=基础分1200。

import {
  RATING_BASE,
  RATING_KD_CAP,
  DEFAULT_RATING_WEIGHTS,
  type RatingWeights,
} from './constants';

export interface RatingBreakdown {
  base: number;                    // 基础分 1200
  matchFactor: number;             // 场次因子 1-e^(-m/30)
  components: {
    kills: { raw: number; normalized: number; weight: number; contribution: number; label: string; detail: string };
    deaths: { raw: number; normalized: number; weight: number; contribution: number; label: string; detail: string };
    wins: { raw: number; normalized: number; weight: number; contribution: number; label: string; detail: string };
    matches: { raw: number; normalized: number; weight: number; contribution: number; label: string; detail: string };
    opponentStrength: { raw: number; normalized: number; weight: number; contribution: number; label: string; detail: string };
  };
  weightedSum: number;             // 加权和 0-1
  total: number;                   // 最终 Rating
  formula: string;                 // 公式文本
}

/** 场次因子 1 - e^(-matches/30) */
export function matchFactor(matches: number): number {
  return 1 - Math.exp(-matches / 30);
}

/** 计算战绩评分 + 明细 */
export function computeRating(
  stats: { kills: number; deaths: number; wins: number; matches: number } | undefined | null,
  weights: RatingWeights = DEFAULT_RATING_WEIGHTS,
): RatingBreakdown {
  const s = stats || { kills: 0, deaths: 0, wins: 0, matches: 0 };
  const m = Math.max(s.matches, 0);
  const mf = matchFactor(m);

  // K: KD 标准化（封顶3，归一化0-1）
  const kdRaw = s.kills / Math.max(s.deaths, 1);
  const kdCapped = Math.min(kdRaw, RATING_KD_CAP);
  const kNorm = kdCapped / RATING_KD_CAP;

  // D: 死亡标准化（场均死亡越低越好，0死=1分，1场死1次=0分）
  const deathsPerMatch = m > 0 ? s.deaths / m : 0;
  const dNorm = 1 - Math.min(deathsPerMatch, 1);

  // W: 胜率
  const wNorm = m > 0 ? s.wins / m : 0;

  // M: 场次饱和 = 场次因子
  const mNorm = mf;

  // O: 对手强度 — 当前数据模型无对手记录，权重 0，贡献恒 0（W3-fix-B 诚实标注）
  const oNorm = 0;

  // 各维度贡献 = round(1000 × 场次因子 × 标准化值 × 权重)
  // total = 基础分 + Σ 贡献（消除四舍五入误差，面板数字 100% 可复现）
  const kContrib = Math.round(1000 * mf * kNorm * weights.kills);
  const dContrib = Math.round(1000 * mf * dNorm * weights.deaths);
  const wContrib = Math.round(1000 * mf * wNorm * weights.wins);
  const mContrib = Math.round(1000 * mf * mNorm * weights.matches);
  const oContrib = Math.round(1000 * mf * oNorm * weights.opponentStrength);

  const total = RATING_BASE + kContrib + dContrib + wContrib + mContrib + oContrib;
  const weightedSum = kNorm * weights.kills + dNorm * weights.deaths + wNorm * weights.wins + mNorm * weights.matches + oNorm * weights.opponentStrength;

  return {
    base: RATING_BASE,
    matchFactor: mf,
    components: {
      kills: {
        raw: s.kills,
        normalized: Number(kNorm.toFixed(3)),
        weight: weights.kills,
        contribution: kContrib,
        label: '击杀效率',
        detail: `KD = ${s.kills}/${Math.max(s.deaths, 1)} = ${kdRaw.toFixed(2)}，封顶 ${RATING_KD_CAP}，归一化 ${kNorm.toFixed(3)}`,
      },
      deaths: {
        raw: s.deaths,
        normalized: Number(dNorm.toFixed(3)),
        weight: weights.deaths,
        contribution: dContrib,
        label: '生存能力',
        detail: `场均死亡 ${deathsPerMatch.toFixed(2)}，生存分 ${dNorm.toFixed(3)}`,
      },
      wins: {
        raw: s.wins,
        normalized: Number(wNorm.toFixed(3)),
        weight: weights.wins,
        contribution: wContrib,
        label: '胜率',
        detail: `${s.wins}/${m} = ${(wNorm * 100).toFixed(1)}%`,
      },
      matches: {
        raw: m,
        normalized: Number(mNorm.toFixed(3)),
        weight: weights.matches,
        contribution: mContrib,
        label: '场次饱和',
        detail: `场次因子 1-e^(-${m}/30) = ${mf.toFixed(3)}`,
      },
      opponentStrength: {
        raw: 0,
        normalized: 0,
        weight: weights.opponentStrength,
        contribution: oContrib,
        label: '对手强度',
        detail: `权重 ${weights.opponentStrength}（待 MatchHistory 表引入后启用，当前无法计算）`,
      },
    },
    weightedSum: Number(weightedSum.toFixed(3)),
    total,
    formula: `Rating = 1200 + Σ(各维度贡献)，各维度贡献 = 1000 × 场次因子 × 标准化值 × 权重`,
  };
}

