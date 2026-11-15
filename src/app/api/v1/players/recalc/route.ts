import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// POST /api/v1/players/recalc - Recalculate all player scores
// Scores are derived from tiers (client-side), so server-side recalc
// just re-reads all players and validates that their tier/override JSON
// is well-formed, re-stringifying it to a canonical form if needed.
// AUTH V2.0 安全修复专项（2026-11-11）：批量重算限 OWNER/ADMIN（VIEWER 只读）
export async function POST() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const players = await db.player.findMany();
    let recalced = 0;

    for (const p of players) {
      try {
        const tiers = JSON.parse(p.tiers || '{}');
        const overrideScores = JSON.parse(p.overrideScores || '{}');
        const stats = JSON.parse(p.stats || '{}');

        const tiersStr = JSON.stringify(tiers);
        const overrideStr = JSON.stringify(overrideScores);
        const statsStr = JSON.stringify(stats);

        // Re-write canonical JSON if any field has drifted
        if (tiersStr !== p.tiers || overrideStr !== p.overrideScores || statsStr !== p.stats) {
          await db.player.update({
            where: { id: p.id },
            data: {
              tiers: tiersStr,
              overrideScores: overrideStr,
              stats: statsStr,
            },
          });
        }
        recalced++;
      } catch {
        // skip malformed rows
      }
    }

    await db.operationLog.create({
      data: {
        type: 'recalc',
        detail: `admin → recalc · ${recalced}/${players.length} players`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Scores/tiers may have changed → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ success: true, count: recalced, total: players.length });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to recalc' }, { status: 500 });
  }
}
