import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// DELETE /api/v1/sandbox/clear
// Remove all demo players (name prefixed with "[DEMO]").
// Real players are never touched.
// ============================================================

const DEMO_PREFIX = '[DEMO]';

// AUTH V2.0 安全修复专项（2026-11-11）：批量清除限 OWNER/ADMIN（VIEWER 只读）
export async function DELETE() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    // Count first for the audit record
    const count = await db.player.count({
      where: { name: { startsWith: DEMO_PREFIX } },
    });

    const result = await db.player.deleteMany({
      where: { name: { startsWith: DEMO_PREFIX } },
    });

    await db.operationLog.create({
      data: {
        type: 'delete',
        detail: `admin → sandbox clear · removed ${result.count} demo players`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Demo players removed → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ success: true, deleted: result.count, had: count });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear sandbox data' }, { status: 500 });
  }
}
