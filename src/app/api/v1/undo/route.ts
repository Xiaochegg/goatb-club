import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// POST /api/v1/undo?logId=X
// Revert a mutation by restoring the beforeData snapshot.
// Supports 'update' (restore old field values) and 'delete' (re-create entity).
// The undo itself is logged — auditors can see "admin reverted log X".
// ============================================================

// AUTH V2.0 安全修复专项（2026-11-11）：撤销变更=破坏性写操作，限 OWNER/ADMIN
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const logId = req.nextUrl.searchParams.get('logId');
    if (!logId) {
      return NextResponse.json({ error: 'logId is required' }, { status: 400 });
    }

    const log = await db.operationLog.findUnique({ where: { id: logId } });
    if (!log) {
      return NextResponse.json({ error: 'Log not found' }, { status: 404 });
    }
    if (!log.beforeData) {
      return NextResponse.json({ error: 'This log has no before-snapshot (cannot undo)' }, { status: 400 });
    }

    const before = JSON.parse(log.beforeData);
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    let result: Record<string, unknown> = {};

    if (log.type === 'delete') {
      // Re-create the deleted entity (restore original id)
      const restored = await db.player.create({
        data: {
          id: before.id,
          name: before.name,
          avatarUrl: before.avatarUrl,
          tiers: before.tiers,
          overrideScores: before.overrideScores,
          stats: before.stats,
          likes: before.likes,
          emotionText: before.emotionText,
        },
      }).catch((err: unknown) => {
        // If id collision (entity already restored), try without fixed id
        if (String(err).includes('Unique')) {
          return db.player.create({
            data: {
              name: before.name + ' (restored)',
              avatarUrl: before.avatarUrl,
              tiers: before.tiers,
              overrideScores: before.overrideScores,
              stats: before.stats,
              likes: before.likes,
              emotionText: before.emotionText,
            },
          });
        }
        throw err;
      });
      result = { restored: true, playerId: restored.id };
    } else if (log.type === 'update') {
      // Restore old field values on the entity
      const entityId = log.sessionId;
      if (!entityId) {
        return NextResponse.json({ error: 'Log has no entity link (sessionId)' }, { status: 400 });
      }
      const existing = await db.player.findUnique({ where: { id: entityId } });
      if (!existing) {
        return NextResponse.json({ error: 'Entity no longer exists (was it deleted after this update?)' }, { status: 404 });
      }
      await db.player.update({
        where: { id: entityId },
        data: {
          name: before.name,
          avatarUrl: before.avatarUrl,
          tiers: before.tiers,
          overrideScores: before.overrideScores,
          stats: before.stats,
          likes: before.likes,
          emotionText: before.emotionText,
        },
      });
      result = { reverted: true, playerId: entityId };
    } else {
      return NextResponse.json({ error: `Undo not supported for log type '${log.type}'` }, { status: 400 });
    }

    // Log the undo action itself (auditable)
    await db.operationLog.create({
      data: {
        type: 'update',
        detail: `admin → UNDO · reverted log ${logId} (${log.type} · ${log.detail})`,
        scoreChange: null,
        adminKey: 'admin',
        ip,
      },
    }).catch(() => {});

    // Undo restored/reverted player data → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to undo' }, { status: 500 });
  }
}
