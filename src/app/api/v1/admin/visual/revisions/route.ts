import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeVisualConfig, serializeVisualConfig } from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 版本历史与回滚（任务书 §7.4 / §十七）
// GET  /api/v1/admin/visual/revisions?playerId=xxx   版本列表（VIEWER+）
// POST /api/v1/admin/visual/revisions                回滚（OWNER/ADMIN）
//      body: { revisionId, summary? }
// ------------------------------------------------------------
// 回滚语义：取历史快照 → 作为【新草稿】并【发布】→ 产生更高版本号；
// 历史行绝不覆盖/删除（append-only），失败保留当前版本。
// ============================================================

export async function GET(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;

  const playerId = req.nextUrl.searchParams.get('playerId');
  const scope = playerId
    ? { playerId }
    : { playerId: null, presetId: null }; // 不带 playerId = 全局快照历史

  const revisions = await db.visualRevision.findMany({
    where: scope,
    orderBy: { version: 'desc' },
    take: 50,
    select: {
      id: true, playerId: true, presetId: true, version: true,
      configSnapshot: true, changedBy: true, changeSummary: true, createdAt: true,
    },
  });
  return NextResponse.json({
    revisions: revisions.map(r => ({
      id: r.id,
      playerId: r.playerId,
      presetId: r.presetId,
      version: r.version,
      changedBy: r.changedBy,
      changeSummary: r.changeSummary,
      createdAt: r.createdAt,
      config: safeJson(r.configSnapshot),
    })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const ip = req.headers.get('x-forwarded-for') || 'unknown';

  try {
    const body = await req.json();
    const { revisionId } = body ?? {};
    if (!revisionId || typeof revisionId !== 'string') {
      return NextResponse.json({ error: 'revisionId 为必填' }, { status: 400 });
    }

    const revision = await db.visualRevision.findUnique({ where: { id: revisionId } });
    if (!revision) return NextResponse.json({ error: '版本记录不存在' }, { status: 404 });
    if (!revision.playerId) {
      return NextResponse.json({ error: '全局快照回滚请走全局配置接口' }, { status: 400 });
    }

    const player = await db.player.findUnique({ where: { id: revision.playerId }, select: { id: true, name: true } });
    if (!player) return NextResponse.json({ error: '目标玩家已不存在' }, { status: 404 });

    const safeConfig = sanitizeVisualConfig(safeJson(revision.configSnapshot));
    const serialized = serializeVisualConfig(safeConfig);
    if (!serialized) return NextResponse.json({ error: '历史快照非法' }, { status: 500 });

    const prev = await db.playerVisualConfig.findUnique({ where: { playerId: player.id } });
    const nextVersion = (prev?.version ?? 0) + 1;

    await db.playerVisualConfig.upsert({
      where: { playerId: player.id },
      create: {
        playerId: player.id, presetId: prev?.presetId ?? null, enabled: prev?.enabled ?? true,
        draftConfig: serialized, config: serialized,
        status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
      },
      update: {
        draftConfig: serialized, config: serialized,
        status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
      },
    });
    await db.visualRevision.create({
      data: {
        playerId: player.id, version: nextVersion, configSnapshot: serialized,
        changedBy: admin.username,
        changeSummary: `回滚至 v${revision.version}${body?.summary ? ' · ' + String(body.summary).slice(0, 100) : ''}`,
      },
    });
    await db.operationLog.create({
      data: {
        type: 'VISUAL',
        detail: `visual-rollback · ${player.name} · v${revision.version} → v${nextVersion}`,
        adminKey: admin.username, ip,
        beforeData: prev ? JSON.stringify({ version: prev.version }) : null,
        afterData: JSON.stringify({ version: nextVersion, rolledBackFrom: revision.version }),
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, version: nextVersion, rolledBackFrom: revision.version });
  } catch {
    return NextResponse.json({ error: '回滚失败（当前版本已保留）' }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
