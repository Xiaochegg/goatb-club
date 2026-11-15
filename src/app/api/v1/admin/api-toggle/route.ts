import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, requireRole } from '@/lib/auth';
import { clearApiStateCache, logApiEvent } from '@/lib/api-gate';
import { CONFIG_KEYS, type ApiGateState } from '@/lib/constants';

// ============================================================
// W4-T1/T2/T3 · API 开关管理
// GET  /api/v1/admin/api-toggle — 当前状态
// POST /api/v1/admin/api-toggle — 切换状态 { state: OFF|WHITELIST|OPEN, tempOpenMinutes?: number }
//   tempOpenMinutes: 临时开启 N 分钟后自动回落 OFF（W4-T3）
// ============================================================

export async function GET() {
  const guard = await requireAdmin();
  if (guard) return guard;
  const row = await db.config.findUnique({ where: { key: CONFIG_KEYS.PUBLIC_API } });
  const state = (row?.value as ApiGateState) || 'OFF';
  // 检查是否有临时开启的过期时间
  const expiryRow = await db.config.findUnique({ where: { key: 'public_api_expires' } });
  const expiresAt = expiryRow?.value || null;
  return NextResponse.json({ state, expiresAt });
}

// AUTH V2.0 安全修复专项（2026-11-11）：切换 API 网关状态=配置写入，限 OWNER/ADMIN
// （对齐 canEditConfig，spec §19；GET 保留 requireAdmin 只读）
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  try {
    const body = await req.json();
    const { state, tempOpenMinutes } = body;
    if (!['OFF', 'WHITELIST', 'OPEN'].includes(state)) {
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }
    // 护栏 1：临时开启上限 7 天（10080 分钟），防误填永久打开
    if (typeof tempOpenMinutes === 'number' && tempOpenMinutes > 10080) {
      return NextResponse.json({ error: 'tempOpenMinutes 超过 7 天上限（10080 分钟）' }, { status: 400 });
    }
    const before = await db.config.findUnique({ where: { key: CONFIG_KEYS.PUBLIC_API } });
    const beforeVal = before?.value || 'OFF';

    await db.config.upsert({
      where: { key: CONFIG_KEYS.PUBLIC_API },
      update: { value: state },
      create: { key: CONFIG_KEYS.PUBLIC_API, value: state },
    });

    // 临时开启：设置过期时间
    let expiresAt = null;
    if (state !== 'OFF' && typeof tempOpenMinutes === 'number' && tempOpenMinutes > 0) {
      expiresAt = new Date(Date.now() + tempOpenMinutes * 60_000).toISOString();
      await db.config.upsert({
        where: { key: 'public_api_expires' },
        update: { value: expiresAt },
        create: { key: 'public_api_expires', value: expiresAt },
      });
    } else {
      // 清除过期时间
      await db.config.deleteMany({ where: { key: 'public_api_expires' } }).catch(() => null);
    }

    clearApiStateCache(); // 热生效
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    await logApiEvent(
      'api_toggle',
      `admin → public_api ${beforeVal}→${state}${tempOpenMinutes ? ` (temp ${tempOpenMinutes}min)` : ''}`,
      ip,
      JSON.stringify({ state: beforeVal }),
      JSON.stringify({ state, expiresAt }),
    );
    return NextResponse.json({ state, expiresAt });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to toggle API' }, { status: 500 });
  }
}
