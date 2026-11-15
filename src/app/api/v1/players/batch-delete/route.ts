import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// POST /api/v1/players/batch-delete
// Body: { ids: string[] }
// Removes multiple players in one transaction. RankSnapshot rows
// cascade-delete via Prisma (onDelete: Cascade in schema).
// Writes ONE OperationLog row (not N) to keep the op-log clean.
// ============================================================

const MAX_BATCH = 200; // SQLite param limit safety

// AUTH V2.0 安全修复专项（2026-11-11）：批量删除限 OWNER/ADMIN（VIEWER 只读）
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const rawIds = Array.isArray(body?.ids) ? body.ids : null;
    if (!rawIds) {
      return NextResponse.json({ error: 'ids must be a string array' }, { status: 400 });
    }

    // Dedup + cap + coerce
    const ids = Array.from(new Set(rawIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) {
      return NextResponse.json({ error: 'No valid ids provided' }, { status: 400 });
    }
    if (ids.length > MAX_BATCH) {
      return NextResponse.json({ error: `Batch too large (max ${MAX_BATCH})` }, { status: 400 });
    }

    // Snapshot names for the audit record (before delete)
    const targets = await db.player.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const targetNames = targets.map(t => t.name);

    const result = await db.player.deleteMany({
      where: { id: { in: ids } },
    });

    const ip = req.headers.get('x-forwarded-for') || 'unknown';

    await db.operationLog.create({
      data: {
        type: 'delete',
        detail: `admin → batch delete · ${result.count} player(s)`,
        scoreChange: null,
        adminKey: 'admin',
        beforeData: JSON.stringify({ ids, names: targetNames }),
        ip,
      },
    }).catch(() => null);

    // Players removed → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({
      success: true,
      deleted: result.count,
      requested: ids.length,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to batch delete players' }, { status: 500 });
  }
}
