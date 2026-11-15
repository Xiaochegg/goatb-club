import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { computeRating, type RatingBreakdown } from '@/lib/scoring';
import { DEFAULT_RATING_WEIGHTS, CONFIG_KEYS, type RatingWeights, type PlayerStats } from '@/lib/constants';

// ============================================================
// GET /api/v1/players/[id]/rating-breakdown
// W3-T2: 返回玩家在某模式的战绩评分明细（透明公示）
// Query: mode=SHIELD|CRYSTAL|...（默认 TOTAL=聚合所有模式）
// W3-T5: 权重从 Config.rating_weights 读取，后台可调
// ============================================================

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'TOTAL';

    const player = await db.player.findUnique({ where: { id } });
    if (!player) {
      return NextResponse.json({ error: 'Player not found' }, { status: 404 });
    }

    const stats: Record<string, PlayerStats> = JSON.parse(player.stats || '{}');

    // 聚合 stats（TOTAL=所有模式加总，单模式=该模式）
    let agg: PlayerStats = { kills: 0, deaths: 0, wins: 0, matches: 0 };
    if (mode === 'TOTAL') {
      Object.values(stats).forEach(s => {
        if (s) {
          agg.kills += s.kills || 0;
          agg.deaths += s.deaths || 0;
          agg.wins += s.wins || 0;
          agg.matches += s.matches || 0;
        }
      });
    } else {
      agg = stats[mode] || agg;
    }

    // W3-T5: 权重从 Config.rating_weights 读取，解析失败回落默认
    let weights: RatingWeights = DEFAULT_RATING_WEIGHTS;
    const wRow = await db.config.findUnique({ where: { key: CONFIG_KEYS.RATING_WEIGHTS } });
    if (wRow?.value) {
      try {
        const parsed = JSON.parse(wRow.value);
        if (parsed && typeof parsed.kills === 'number') {
          // Config 存 {kills, deaths, wins, matches, opponentStrength}
          weights = { ...DEFAULT_RATING_WEIGHTS, ...parsed };
        }
      } catch {}
    }

    const breakdown: RatingBreakdown = computeRating(agg, weights);

    return NextResponse.json({
      mode,
      stats: agg,
      breakdown,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to compute rating breakdown' }, { status: 500 });
  }
}
