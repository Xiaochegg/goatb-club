import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  sanitizeVisualConfig, serializeVisualConfig, parseVisualConfig, VISUAL_CONFIG_MAX_BYTES,
} from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 管理端玩家配置草稿
// GET    /api/v1/admin/visual/config?playerId=xxx   读取草稿+已发布+预设
// PUT    /api/v1/admin/visual/config                保存草稿（sanitize + 16KB 硬限）
// DELETE /api/v1/admin/visual/config?playerId=xxx   清除个人覆盖（回落预设/全局）
// ------------------------------------------------------------
// 权限：读 = VIEWER+；写/清 = OWNER/ADMIN（requireRole 服务端裁决，
// 不依赖前端按钮隐藏——任务书 §十三）。
// 更新失败保留上一版本（Prisma 单行更新原子性保证）。
// ============================================================

const WRITE_ROLES = ['OWNER', 'ADMIN'] as const;

export async function GET(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;
  const playerId = req.nextUrl.searchParams.get('playerId') || '';
  if (!playerId) return NextResponse.json({ error: 'playerId 必填' }, { status: 400 });

  const pvc = await db.playerVisualConfig.findUnique({
    where: { playerId },
    include: { preset: { select: { id: true, name: true } } },
  });
  if (!pvc) return NextResponse.json({ exists: false });

  return NextResponse.json({
    exists: true,
    playerId,
    enabled: pvc.enabled,
    status: pvc.status,
    version: pvc.version,
    presetId: pvc.presetId,
    presetName: pvc.preset?.name ?? null,
    draft: parseVisualConfig(pvc.draftConfig) ?? sanitizeVisualConfig({}),
    published: parseVisualConfig(pvc.config),
    updatedBy: pvc.updatedBy,
    updatedAt: pvc.updatedAt,
  });
}

export async function PUT(req: NextRequest) {
  const guard = await requireRole(...WRITE_ROLES);
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    const body = await req.json();
    const { playerId, config, enabled, presetId } = body ?? {};
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }
    const player = await db.player.findUnique({ where: { id: playerId }, select: { id: true } });
    if (!player) return NextResponse.json({ error: '玩家不存在' }, { status: 404 });

    // 服务端 Schema 验证 + 白名单 + 钳制（任务书 §十二/§十三）
    const safeConfig = sanitizeVisualConfig(config);
    const serialized = serializeVisualConfig(safeConfig);
    if (serialized === null) {
      return NextResponse.json(
        { error: `配置超过体积限制（${VISUAL_CONFIG_MAX_BYTES} 字节）`, code: 'TOO_LARGE' },
        { status: 400 },
      );
    }

    // 预设引用校验（存在性；playerId 唯一行 upsert）
    let presetRef: string | null | undefined = undefined;
    if (presetId !== undefined) {
      if (presetId === null) presetRef = null;
      else {
        const preset = await db.visualPreset.findUnique({ where: { id: String(presetId) } });
        if (!preset) return NextResponse.json({ error: '预设不存在' }, { status: 400 });
        presetRef = preset.id;
      }
    }

    const prev = await db.playerVisualConfig.findUnique({ where: { playerId } });
    const nextStatus = prev?.status === 'PUBLISHED' ? 'DIRTY' : prev?.status ?? 'DRAFT_ONLY';

    const saved = await db.playerVisualConfig.upsert({
      where: { playerId },
      create: {
        playerId,
        enabled: enabled !== false,
        draftConfig: serialized,
        config: '{}',
        status: 'DRAFT_ONLY',
        presetId: presetRef ?? null,
        updatedBy: admin.username,
      },
      update: {
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        draftConfig: serialized,
        status: nextStatus,
        presetId: presetRef,
        updatedBy: admin.username,
      },
      include: { preset: { select: { name: true } } },
    });

    return NextResponse.json({
      success: true,
      status: saved.status,
      version: saved.version,
      presetName: saved.preset?.name ?? null,
    });
  } catch {
    return NextResponse.json({ error: '保存失败（上一版本已保留）' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireRole(...WRITE_ROLES);
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const playerId = req.nextUrl.searchParams.get('playerId') || '';
  if (!playerId) return NextResponse.json({ error: 'playerId 必填' }, { status: 400 });

  const prev = await db.playerVisualConfig.findUnique({ where: { playerId } });
  if (!prev) return NextResponse.json({ success: true, cleared: false });

  await db.playerVisualConfig.delete({ where: { playerId } });
  await db.operationLog.create({
    data: {
      type: 'VISUAL',
      detail: `visual-clear-override · playerId=${playerId} · 回落预设/全局默认`,
      adminKey: admin.username,
      ip: req.headers.get('x-forwarded-for') || 'unknown',
    },
  }).catch(() => {});
  return NextResponse.json({ success: true, cleared: true });
}
