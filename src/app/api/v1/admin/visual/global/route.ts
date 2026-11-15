import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  sanitizeVisualConfig, serializeVisualConfig, parseVisualConfig, VISUAL_CONFIG_MAX_BYTES,
} from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 全局默认视觉配置（继承链第 1 层）
// GET /api/v1/admin/visual/global   读取（VIEWER+）
// PUT /api/v1/admin/visual/global   更新（OWNER/ADMIN）+ VisualRevision 快照
// ------------------------------------------------------------
// 存于既有 Config 表 key='visual_global_default'（不新增表）；
// 适用于没有任何个人/预设配置的全部玩家。
// ============================================================

const CONFIG_KEY = 'visual_global_default';

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;

  const row = await db.config.findUnique({ where: { key: CONFIG_KEY } });
  return NextResponse.json({ config: row ? parseVisualConfig(row.value) : null });
}

export async function PUT(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    const body = await req.json();
    const safeConfig = sanitizeVisualConfig(body?.config);
    const serialized = serializeVisualConfig(safeConfig);
    if (serialized === null) {
      return NextResponse.json({ error: `配置超过体积限制（${VISUAL_CONFIG_MAX_BYTES} 字节）` }, { status: 400 });
    }

    const prev = await db.config.findUnique({ where: { key: CONFIG_KEY } });
    await db.config.upsert({
      where: { key: CONFIG_KEY },
      update: { value: serialized },
      create: { key: CONFIG_KEY, value: serialized },
    });

    // 快照进版本历史（playerId/presetId 均空 = 全局快照语义）
    const lastRev = await db.visualRevision.findFirst({
      where: { playerId: null, presetId: null },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await db.visualRevision.create({
      data: {
        playerId: null, presetId: null,
        version: (lastRev?.version ?? 0) + 1,
        configSnapshot: serialized,
        changedBy: admin.username,
        changeSummary: typeof body?.summary === 'string' ? body.summary.slice(0, 120) : '更新全局默认视觉',
      },
    });
    await db.operationLog.create({
      data: {
        type: 'VISUAL',
        detail: 'visual-global-update · 全局默认视觉配置更新（作用于全部未覆盖玩家）',
        adminKey: admin.username,
        ip: req.headers.get('x-forwarded-for') || 'unknown',
        beforeData: prev ? JSON.stringify({ bytes: prev.value.length }) : null,
        afterData: JSON.stringify({ bytes: serialized.length }),
      },
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}
