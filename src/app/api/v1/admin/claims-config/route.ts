import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// GET/PUT /api/v1/admin/claims-config — 认领机制功能开关（工单 2026-11-12）
// ------------------------------------------------------------
// 开关存储：Config 表 key='feature_claim'（'on' = 开启）。
// 此前只能经 env FEATURE_CLAIM 或手工改库开启，管理员后台无入口——
// 认领通道直达上线后，开关必须可视化可操作。
// 权限：读 = VIEWER+；写 = OWNER/ADMIN。写操作入 OperationLog 审计。
// ============================================================

const KEY = 'feature_claim';

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;
  const row = await db.config.findUnique({ where: { key: KEY } }).catch(() => null);
  return NextResponse.json({ enabled: row?.value === 'on' });
}

export async function PUT(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    const body = await req.json();
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled 必须为布尔值' }, { status: 400 });
    }
    const prev = await db.config.findUnique({ where: { key: KEY } });
    await db.config.upsert({
      where: { key: KEY },
      update: { value: body.enabled ? 'on' : 'off' },
      create: { key: KEY, value: body.enabled ? 'on' : 'off' },
    });
    await db.operationLog.create({
      data: {
        type: 'update',
        detail: `claim-feature-${body.enabled ? 'on' : 'off'} · 认领机制开关${body.enabled ? '开启' : '关闭'}`,
        adminKey: admin.username,
        beforeData: prev ? JSON.stringify({ value: prev.value }) : null,
        afterData: JSON.stringify({ value: body.enabled ? 'on' : 'off' }),
        ip: req.headers.get('x-forwarded-for') || 'unknown',
      },
    }).catch(() => {});
    return NextResponse.json({ success: true, enabled: body.enabled });
  } catch {
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}
