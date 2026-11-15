import { db } from '@/lib/db';
import { requireRole, getCurrentAdmin } from '@/lib/auth';
import { sanitizePlayerOutput } from '@/lib/player-auth';
import { normalizePlayersTiers, upgradeLegacyTiers } from '@/lib/tiers';
import { NextRequest, NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// GET /api/v1/players/[id]
// 自审核 P0 修复：公开响应剥离 passwordHash/email/role/lastLoginAt（管理员保留 email/role）
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const player = await db.player.findUnique({ where: { id } });
    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 });
    // W1-T1b: 降级 tiers 为旧格式返回
    const playerNormalized = normalizePlayersTiers([player])[0];
    const isAdmin = (await getCurrentAdmin()) !== null;
    return NextResponse.json({ player: sanitizePlayerOutput(playerNormalized, { isAdmin }) });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch player' }, { status: 500 });
  }
}

// PUT /api/v1/players/[id]
// Records before/after snapshots in OperationLog for Undo support (spec §16).
// AUTH V2.0 安全修复专项（2026-11-11）：VIEWER 只读，编辑限
// OWNER/ADMIN/MODERATOR（canEditPlayers，spec §19）
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    const { id } = await params;
    const body = await req.json();
    const { name, avatarUrl, tiers, overrideScores, stats, likes, emotionText } = body;

    const existing = await db.player.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Player not found' }, { status: 404 });

    // Capture BEFORE snapshot for undo
    const beforeSnapshot = {
      name: existing.name,
      avatarUrl: existing.avatarUrl,
      tiers: existing.tiers,
      overrideScores: existing.overrideScores,
      stats: existing.stats,
      likes: existing.likes,
      emotionText: existing.emotionText,
    };

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;
    if (tiers !== undefined) data.tiers = upgradeLegacyTiers(JSON.stringify(tiers));
    if (overrideScores !== undefined) data.overrideScores = JSON.stringify(overrideScores);
    if (stats !== undefined) data.stats = JSON.stringify(stats);
    if (likes !== undefined) data.likes = likes;
    if (emotionText !== undefined) data.emotionText = emotionText;

    const player = await db.player.update({ where: { id }, data });

    // AFTER snapshot
    const afterSnapshot = {
      name: player.name,
      avatarUrl: player.avatarUrl,
      tiers: player.tiers,
      overrideScores: player.overrideScores,
      stats: player.stats,
      likes: player.likes,
      emotionText: player.emotionText,
    };

    const ip = req.headers.get('x-forwarded-for') || 'unknown';

    const log = await db.operationLog.create({
      data: {
        type: 'update',
        detail: `admin → player · ${player.name}`,
        scoreChange: null,
        adminKey: 'admin',
        beforeData: JSON.stringify(beforeSnapshot),
        afterData: JSON.stringify(afterSnapshot),
        ip,
        sessionId: id, // link log to the entity for targeted undo
      },
    }).catch(() => null);

    // Player data changed → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ player: normalizePlayersTiers([player])[0], logId: log?.id || null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update player' }, { status: 500 });
  }
}

// DELETE /api/v1/players/[id]
// Records full entity snapshot in beforeData for restore-on-undo.
// AUTH V2.0 安全修复专项（2026-11-11）：删除限 OWNER/ADMIN（canDeletePlayers，spec §19）
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const { id } = await params;
    const player = await db.player.delete({ where: { id } });

    const beforeSnapshot = {
      id: player.id,
      name: player.name,
      avatarUrl: player.avatarUrl,
      tiers: player.tiers,
      overrideScores: player.overrideScores,
      stats: player.stats,
      likes: player.likes,
      emotionText: player.emotionText,
    };

    const ip = req.headers.get('x-forwarded-for') || 'unknown';

    const log = await db.operationLog.create({
      data: {
        type: 'delete',
        detail: `admin → player · ${player.name}`,
        scoreChange: null,
        adminKey: 'admin',
        beforeData: JSON.stringify(beforeSnapshot),
        ip,
        sessionId: id,
      },
    }).catch(() => null);

    // Player deleted → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ player: normalizePlayersTiers([player])[0], logId: log?.id || null });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete player' }, { status: 500 });
  }
}
