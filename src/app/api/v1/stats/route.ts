import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  ALL_MODES, NORMAL_TIER_SCORES, JIAHAO_TIER_SCORES,
  TIER_COLORS, CONFIG_KEYS, type NormalTier, type JiahaoTier,
} from '@/lib/constants';
import { parseTagStyles, type TagStyle } from '@/lib/tag-styles';
import {
  getPlayerModeScore,
  getPlayerTotalScore,
  computeTieRanks,
  type ScoredPlayer,
} from '@/lib/scoring';
import { toLegacyTiersMap } from '@/lib/tiers';
import { withCache } from '@/lib/cache';

// ============================================================
// GET /api/v1/stats — Real data analytics endpoint
// Returns aggregate stats, score distribution, tier distribution,
// mode leaderboard, and top players.
//
// Cache: 30s TTL with stale-while-revalidate. This is the single
// biggest sandbox win — stats scans the whole player table and
// runs heavy aggregation; caching collapses N concurrent requests
// into 1 DB round-trip.
// ============================================================

interface ParsedPlayer extends ScoredPlayer {
  avatarUrl: string | null;
}

function parsePlayer(p: Record<string, unknown>): ParsedPlayer {
  return {
    id: p.id as string,
    name: p.name as string,
    avatarUrl: (p.avatarUrl as string) || null,
    // W1-T1b: DB 存新格式 {SHIELD:{tier,source,updatedAt}}，降级回旧格式 {SHIELD:"HT1"}
    // 供 scoring.ts / 前端零改动消费。source/updatedAt 保留在 DB，W3 走专用 API 取。
    tiers: toLegacyTiersMap((p.tiers as string) || '{}'),
    overrideScores: JSON.parse((p.overrideScores as string) || '{}'),
    stats: JSON.parse((p.stats as string) || '{}'),
    likes: (p.likes as number) || 0,
    emotionText: (p.emotionText as string) || null,
  };
}

const STATS_CACHE_KEY = 'stats:overview';
const STATS_CACHE_TTL = 30_000; // 30s

async function computeStats() {
  // C4 查询投影瘦身（轻量化改造 2026-11-03）：computeStats 只消费 8 个字段，
  // 此前 findMany() 全行扫描会把 email/passwordHash/role/lastLoginAt 等
  // 凭据/敏感列一并拖入内存。收窄后响应 golden 键形不变（键比对见 C 阶段记录），
  // 但每次聚合不再搬运凭据列——小表省内存，大表省 IO。
  const rawPlayers = await db.player.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      tiers: true,
      overrideScores: true,
      stats: true,
      likes: true,
      emotionText: true,
    },
  });
  const players = rawPlayers.map(p => parsePlayer(p as unknown as Record<string, unknown>));

  if (players.length === 0) {
    return {
      overview: { totalPlayers: 0, totalScore: 0, avgScore: 0, totalLikes: 0, topPlayer: null },
      scoreDistribution: [],
      tierDistribution: [],
      modeLeaders: [],
      topPlayers: [],
      emotionCount: 0,
    };
  }

  // ── Overview ──
  const totalScore = players.reduce((s, p) => s + getPlayerTotalScore(p), 0);
  const totalLikes = players.reduce((s, p) => s + (p.likes || 0), 0);
  const scored = players.map(p => ({ p, score: getPlayerTotalScore(p) })).sort((a, b) => b.score - a.score);
  const topPlayer = scored[0] ? { id: scored[0].p.id, name: scored[0].p.name, score: scored[0].score } : null;
  const emotionCount = players.filter(p => p.emotionText).length;

  // ── Score distribution (histogram buckets) ──
  const buckets = [
    { label: '0-50', min: 0, max: 50, count: 0 },
    { label: '51-100', min: 51, max: 100, count: 0 },
    { label: '101-200', min: 101, max: 200, count: 0 },
    { label: '201-500', min: 201, max: 500, count: 0 },
    { label: '500+', min: 501, max: Infinity, count: 0 },
  ];
  scored.forEach(({ score }) => {
    const b = buckets.find(b => score >= b.min && score <= b.max);
    if (b) b.count++;
  });

  // ── Tier distribution (count per tier across all modes) ──
  const tierDistMap: Record<string, number> = {};
  players.forEach(p => {
    ALL_MODES.forEach(m => {
      const t = p.tiers?.[m];
      if (t) tierDistMap[t] = (tierDistMap[t] || 0) + 1;
    });
  });
  const tierDistribution = Object.entries(tierDistMap)
    .map(([tier, count]) => ({ tier, count, color: TIER_COLORS[tier] || '#888' }))
    .sort((a, b) => b.count - a.count);

  // ── Mode leaders (top player per mode) ──
  // 玩家个性标签样式：与 /api/v1/players 同源（Config.player_tag_styles），
  // 让侧栏 Mode Kings 榜首徽章与榜单行一致展示个性化光效。
  let tagStyles: Record<string, TagStyle> = {};
  try {
    const styleRow = await db.config.findUnique({
      where: { key: CONFIG_KEYS.PLAYER_TAG_STYLES },
      select: { value: true },
    });
    tagStyles = parseTagStyles(styleRow?.value);
  } catch { /* 配置缺失时降级为无个性化样式 */ }
  const modeLeaders = ALL_MODES.map(mode => {
    const modeScored = players
      .map(p => ({ p, score: getPlayerModeScore(p, mode) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const leader = modeScored[0];
    return {
      mode,
      leader: leader ? { id: leader.p.id, name: leader.p.name, score: leader.score, tier: leader.p.tiers?.[mode] || null, tagStyle: tagStyles[leader.p.id] ?? null } : null,
      participantCount: modeScored.length,
    };
  });

  // ── Top 10 players by total score ──
  // P2-7（审计 2026-11-13）：序数排名 → 密集排名（与主榜 computeTieRanks 同算法）。
  // 在全量 scored 上先算名次再切 Top10，并列玩家名次与主榜一致
  // （旧实现 i+1 会把并列后的第三名标成 #3，主榜却显示 #2）。
  const denseRanks = computeTieRanks(scored, ({ score }) => score);
  const topPlayers = scored.slice(0, 10).map(({ p, score }, i) => ({
    rank: denseRanks[i],
    id: p.id,
    name: p.name,
    score,
    likes: p.likes || 0,
    level: Math.floor(score / 100) + 1,
    bestTier: ALL_MODES.reduce<string | null>((best, m) => {
      const t = p.tiers?.[m];
      if (!t) return best;
      if (!best) return t;
      return (NORMAL_TIER_SCORES[t as NormalTier] ?? JIAHAO_TIER_SCORES[t as JiahaoTier] ?? 0) >
        (NORMAL_TIER_SCORES[best as NormalTier] ?? JIAHAO_TIER_SCORES[best as JiahaoTier] ?? 0) ? t : best;
    }, null),
  }));

  // ── Aggregate K/D and win rate ──
  const aggStats = { kills: 0, deaths: 0, wins: 0, matches: 0 };
  players.forEach(p => {
    ALL_MODES.forEach(m => {
      const s = p.stats?.[m];
      if (s) {
        aggStats.kills += s.kills || 0;
        aggStats.deaths += s.deaths || 0;
        aggStats.wins += s.wins || 0;
        aggStats.matches += s.matches || 0;
      }
    });
  });
  const kd = aggStats.deaths === 0 ? (aggStats.kills > 0 ? Infinity : 0) : aggStats.kills / aggStats.deaths;
  const winRate = aggStats.matches === 0 ? 0 : (aggStats.wins / aggStats.matches) * 100;

  return {
    overview: {
      totalPlayers: players.length,
      totalScore,
      avgScore: Math.round(totalScore / players.length),
      totalLikes,
      emotionCount,
      topPlayer,
      aggStats: {
        ...aggStats,
        kd: kd === Infinity ? '∞' : kd.toFixed(2),
        winRate: winRate.toFixed(1) + '%',
      },
    },
    scoreDistribution: buckets,
    tierDistribution,
    modeLeaders,
    topPlayers,
  };
}

export async function GET() {
  try {
    const payload = await withCache(STATS_CACHE_KEY, STATS_CACHE_TTL, computeStats);
    return NextResponse.json(payload);
  } catch (error) {
    console.error('Stats API error:', error);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
