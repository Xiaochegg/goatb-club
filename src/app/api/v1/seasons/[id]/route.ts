import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { invalidate } from '@/lib/cache';

// ============================================================
// PATCH /api/v1/seasons/[id] — update a season (admin)
// DELETE /api/v1/seasons/[id] — delete a season (admin)
// ============================================================

// AUTH V2.0 安全修复专项（2026-11-11）：赛季变更限 OWNER/ADMIN（VIEWER 只读）
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const { id } = await params;
    const body = await req.json();
    const { name, startAt, endAt, status } = body;

    // If activating a season, deactivate any existing ACTIVE season
    if (status === 'ACTIVE') {
      await db.season.updateMany({
        where: { status: 'ACTIVE', NOT: { id } },
        data: { status: 'ENDED' },
      });
    }

    const season = await db.season.update({
      where: { id },
      data: {
        ...(name && { name: String(name) }),
        ...(startAt && { startAt: new Date(startAt) }),
        ...(endAt !== undefined && { endAt: endAt ? new Date(endAt) : null }),
        ...(status && { status }),
      },
    });

    await db.operationLog.create({
      data: {
        type: 'update',
        detail: `admin → season · ${season.name} → ${status || 'updated'}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Season list changed → bust the cached seasons list.
    invalidate('seasons:list');
    return NextResponse.json({ season });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update season' }, { status: 500 });
  }
}

// AUTH V2.0 安全修复专项（2026-11-11）：赛季删除限 OWNER/ADMIN（VIEWER 只读）
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const { id } = await params;
    const season = await db.season.delete({ where: { id } });

    await db.operationLog.create({
      data: {
        type: 'delete',
        detail: `admin → season · ${season.name} deleted`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Season list changed → bust the cached seasons list.
    invalidate('seasons:list');
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to delete season' }, { status: 500 });
  }
}
