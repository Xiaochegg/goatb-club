import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { ALL_MODES, type BoardMode } from '@/lib/constants';
import { getPlayerBoardScore, getSortedPlayers, computeTieRanks, type ScoredPlayer } from '@/lib/scoring';
import { toLegacyTiersMap } from '@/lib/tiers';

// ============================================================
// POST /api/v1/rank-snapshots
// Capture a rank snapshot for every player across all modes.
// This is the foundation of real rank-change tracking (spec §9).
// Run periodically (manual for now; cron in production) — diffing
// consecutive snapshots yields the true rank delta, replacing the
// fake getRankChange() hash.
// ============================================================

// AUTH V2.0 安全修复专项（2026-11-11）：全量快照写入限 OWNER/ADMIN（VIEWER 只读）
export async function POST() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    // C4 查询投影瘦身：快照计算只消费 7 个字段，不再全行拖拽凭据列（golden 键形不变）
    const rawPlayers = await db.player.findMany({
      select: {
        id: true,
        name: true,
        tiers: true,
        overrideScores: true,
        stats: true,
        likes: true,
        emotionText: true,
      },
    });
    const players: ScoredPlayer[] = rawPlayers.map(p => ({
      id: p.id,
      name: p.name,
      // P1-4（审计 2026-11-13）：统一走 toLegacyTiersMap —— RAW 解析新格式段位时
      // score/rank 全 0/乱序（与 dashboard 同根因）。与前台榜单同源解析后，
      // 快照 score 与真实榜完全一致。
      tiers: toLegacyTiersMap(p.tiers),
      overrideScores: JSON.parse(p.overrideScores || '{}'),
      stats: JSON.parse(p.stats || '{}'),
      likes: p.likes,
      emotionText: p.emotionText,
    }));

    const modes: BoardMode[] = ['TOTAL', ...ALL_MODES];
    const snapshots: Array<{
      playerId: string;
      mode: string;
      rank: number;
      score: number;
    }> = [];

    for (const mode of modes) {
      const sorted = getSortedPlayers(players, mode, true, '');
      // P2-7（审计 2026-11-13）：序数排名(i+1) → 密集排名(1,1,2)，与前台三榜
      // 同算法（computeTieRanks）。此前并列玩家的快照名次与主榜不一致，
      // 历史曲线对并列玩家会显示虚高/虚低的名次跳动。
      const ranks = computeTieRanks(sorted, (p) => getPlayerBoardScore(p, mode));
      sorted.forEach((p, i) => {
        snapshots.push({
          playerId: p.id,
          mode,
          rank: ranks[i],
          score: getPlayerBoardScore(p, mode),
        });
      });
    }

    // Batch insert (SQLite has a 999-param limit, so chunk it)
    const CHUNK = 400;
    for (let i = 0; i < snapshots.length; i += CHUNK) {
      await db.rankSnapshot.createMany({ data: snapshots.slice(i, i + CHUNK) });
    }

    await db.operationLog.create({
      data: {
        type: 'recalc',
        detail: `admin → rank snapshot · ${snapshots.length} entries across ${modes.length} modes`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      captured: snapshots.length,
      modes: modes.length,
      players: players.length,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to capture snapshots' }, { status: 500 });
  }
}

// ============================================================
// GET /api/v1/rank-snapshots?playerId=X&mode=Y&limit=30
// Return rank history for a player/mode (for the RANK HISTORY chart, spec §8)
// ============================================================

export async function GET(req: Request) {
  const url = new URL(req.url);
  const playerId = url.searchParams.get('playerId');
  const mode = url.searchParams.get('mode') || 'TOTAL';
  const limit = parseInt(url.searchParams.get('limit') || '30');

  if (!playerId) {
    return NextResponse.json({ error: 'playerId is required' }, { status: 400 });
  }

  try {
    const snapshots = await db.rankSnapshot.findMany({
      where: { playerId, mode },
      orderBy: { createdAt: 'desc' },
      take: limit,
      // C4 查询投影瘦身：响应只消费 rank/score/createdAt 三字段
      select: { rank: true, score: true, createdAt: true },
    });

    // Return oldest-first for charting
    return NextResponse.json({
      history: snapshots.reverse().map(s => ({
        rank: s.rank,
        score: s.score,
        at: s.createdAt,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch snapshots' }, { status: 500 });
  }
}
