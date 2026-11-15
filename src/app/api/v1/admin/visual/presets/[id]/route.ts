import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  sanitizeVisualConfig as sanitize, serializeVisualConfig, VISUAL_CONFIG_MAX_BYTES,
} from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 单个预设操作
// PUT    /api/v1/admin/visual/presets/[id]    修改预设（OWNER/ADMIN）
// DELETE /api/v1/admin/visual/presets/[id]    删除预设（内置预设禁删）
// POST   /api/v1/admin/visual/presets/[id]    将玩家当前配置另存为该预设副本
//        body: { action: 'save-from-player', playerId }
// ------------------------------------------------------------
// 预设删除：playerConfigs FK 为 SetNull → 玩家配置回落全局默认（继承链），
// 不删玩家数据。内置预设（isBuiltin）可编辑不可删除。
// ============================================================

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const { id } = await ctx.params;

  try {
    const body = await req.json();
    const preset = await db.visualPreset.findUnique({ where: { id } });
    if (!preset) return NextResponse.json({ error: '预设不存在' }, { status: 404 });

    const data: { name?: string; description?: string | null; config?: string; updatedBy?: string } = {};
    if (body?.name !== undefined) {
      const name = String(body.name).trim().slice(0, 40);
      if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
      const dup = await db.visualPreset.findUnique({ where: { name } });
      if (dup && dup.id !== id) return NextResponse.json({ error: '预设名称已存在' }, { status: 409 });
      data.name = name;
    }
    if (body?.description !== undefined) {
      data.description = body.description === null ? null : String(body.description).trim().slice(0, 120);
    }
    if (body?.config !== undefined) {
      const safeConfig = sanitize(body.config);
      const serialized = serializeVisualConfig(safeConfig);
      if (serialized === null) {
        return NextResponse.json({ error: `配置超过体积限制（${VISUAL_CONFIG_MAX_BYTES} 字节）` }, { status: 400 });
      }
      data.config = serialized;
    }
    data.updatedBy = admin.username;

    await db.visualPreset.update({ where: { id }, data });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const { id } = await ctx.params;

  const preset = await db.visualPreset.findUnique({ where: { id }, include: { _count: { select: { playerConfigs: true } } } });
  if (!preset) return NextResponse.json({ error: '预设不存在' }, { status: 404 });
  if (preset.isBuiltin) return NextResponse.json({ error: '内置预设不可删除（可编辑覆盖）' }, { status: 400 });

  await db.visualPreset.delete({ where: { id } });
  await db.operationLog.create({
    data: {
      type: 'VISUAL',
      detail: `visual-preset-delete · 「${preset.name}」 · 解除关联 ${preset._count.playerConfigs} 个玩家配置`,
      adminKey: admin.username,
      ip: _req.headers.get('x-forwarded-for') || 'unknown',
    },
  }).catch(() => {});
  return NextResponse.json({ success: true, detachedPlayers: preset._count.playerConfigs });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const { id } = await ctx.params;

  try {
    const body = await req.json();
    if (body?.action !== 'save-from-player') {
      return NextResponse.json({ error: 'action 必须为 save-from-player' }, { status: 400 });
    }
    const { playerId } = body;
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }

    const preset = await db.visualPreset.findUnique({ where: { id } });
    if (!preset) return NextResponse.json({ error: '目标预设不存在' }, { status: 404 });

    // 玩家当前已发布配置 → 覆盖预设内容（玩家独立覆盖不反向改变预设，
    // 此处是管理员【显式】的另存动作，语义相反方向，允许）
    const pvc = await db.playerVisualConfig.findUnique({ where: { playerId } });
    const source = pvc?.config ?? '{}';
    const safeConfig = sanitizeVisualConfig(safeJson(source));
    const serialized = serializeVisualConfig(safeConfig);
    if (serialized === null) return NextResponse.json({ error: '玩家配置非法' }, { status: 400 });

    await db.visualPreset.update({
      where: { id },
      data: { config: serialized, updatedBy: admin.username },
    });
    await db.operationLog.create({
      data: {
        type: 'VISUAL',
        detail: `visual-preset-save-from-player · 「${preset.name}」 ← playerId=${playerId}`,
        adminKey: admin.username,
        ip: req.headers.get('x-forwarded-for') || 'unknown',
      },
    }).catch(() => {});
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: '另存失败' }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
