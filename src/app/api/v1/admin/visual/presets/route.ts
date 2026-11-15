import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  sanitizeVisualConfig, serializeVisualConfig, VISUAL_CONFIG_MAX_BYTES,
} from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 视觉预设中心
// GET  /api/v1/admin/visual/presets          预设清单（VIEWER+）
// POST /api/v1/admin/visual/presets          新建预设（OWNER/ADMIN）
// ------------------------------------------------------------
// 预设只保存受控配置参数（sanitize 白名单），绝不保存可执行代码。
// name ≤40 / description ≤120 / config ≤16KB。
// ============================================================

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;

  const presets = await db.visualPreset.findMany({
    orderBy: [{ isBuiltin: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { playerConfigs: true } } },
  });
  return NextResponse.json({
    presets: presets.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      config: safeJson(p.config),
      isBuiltin: p.isBuiltin,
      createdBy: p.createdBy,
      updatedAt: p.updatedAt,
      assignedCount: p._count.playerConfigs,
    })),
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) : '';
    const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 120) : null;
    if (!name) return NextResponse.json({ error: '预设名称为必填（≤40 字）' }, { status: 400 });

    const safeConfig = sanitizeVisualConfig(body?.config);
    const serialized = serializeVisualConfig(safeConfig);
    if (serialized === null) {
      return NextResponse.json({ error: `配置超过体积限制（${VISUAL_CONFIG_MAX_BYTES} 字节）` }, { status: 400 });
    }

    const dup = await db.visualPreset.findUnique({ where: { name } });
    if (dup) return NextResponse.json({ error: '预设名称已存在' }, { status: 409 });

    const created = await db.visualPreset.create({
      data: { name, description, config: serialized, isBuiltin: false, createdBy: admin.username },
    });
    // P3-22（审计 2026-11-13）：预设创建补 OperationLog（同组其他写操作均有，
    // 唯 POST 缺口；type=VISUAL 与 presets/[id]、publish 等同族）。
    await db.operationLog
      .create({
        data: {
          type: 'VISUAL',
          detail: `visual-preset create · ${created.name} · by ${admin.username}`,
          scoreChange: null,
          adminKey: admin.username,
        },
      })
      .catch(() => {});
    return NextResponse.json({ success: true, id: created.id, name: created.name });
  } catch {
    return NextResponse.json({ error: '创建失败' }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
