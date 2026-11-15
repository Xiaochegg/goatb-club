import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// 赞助祝福语接口（工单 2026-11-09：赞助弹窗右下角「送祝福」→ 后台可查）
//
// 动机（管理员原话）：以免外界说「圈钱」——用户可在赞助弹窗写祝福话语，
// 提交进后台，管理员可见。
//
// 固定形式：
//   POST   公开     { content, nickname? } → 入库 SponsorBlessing（NEW）
//   GET    管理员   列表（createdAt desc）+ 未读数 + 总数
//   PATCH  管理员   标已读（{ ids?: string[] } 或 { markAllRead: true }）
//   DELETE 管理员   ?id= 删除单条
//
// 防滥用：内容 1..100 字、署名 ≤20 字；同 IP 60 秒内限 1 条（DB 计数）。
// IP 存储惯例与 OperationLog.ip 一致（x-forwarded-for）。
// ============================================================

const CONTENT_MAX = 100;
const NICKNAME_MAX = 20;
const RATE_WINDOW_MS = 60_000; // 同 IP 60 秒 1 条

/** IP 提取（惯例同 players/[id]/like：xff 首段） */
function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return 'unknown';
  return xff.split(',')[0].trim() || 'unknown';
}

// ------------------------------------------------------------
// POST /api/v1/sponsor/blessings —— 公开提交祝福
// ------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }

    // 内容：trim 后 1..100 字
    const rawContent = typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content : '';
    const content = rawContent.replace(/\s+/g, ' ').trim();
    if (!content) {
      return NextResponse.json({ error: '祝福内容不能为空' }, { status: 400 });
    }
    if (content.length > CONTENT_MAX) {
      return NextResponse.json({ error: `祝福内容最长 ${CONTENT_MAX} 字` }, { status: 400 });
    }

    // 署名：可选，trim 后 ≤20 字，空 → null（匿名）
    const rawNick = typeof (body as { nickname?: unknown }).nickname === 'string'
      ? (body as { nickname: string }).nickname : '';
    const nickname = rawNick.trim().slice(0, NICKNAME_MAX) || null;

    // 限流：同 IP 60 秒 1 条
    const ip = getClientIp(req);
    const recent = await db.sponsorBlessing.count({
      where: { ip, createdAt: { gte: new Date(Date.now() - RATE_WINDOW_MS) } },
    });
    if (recent > 0) {
      return NextResponse.json(
        { error: '发送太频繁，稍后再来送祝福吧' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }

    await db.sponsorBlessing.create({
      data: { content, nickname, ip },
    });

    // 响应不回传任何敏感字段（ip 不出接口）
    return NextResponse.json({ ok: true, message: '祝福已送达，感谢支持！' });
  } catch {
    return NextResponse.json({ error: 'Failed to send blessing' }, { status: 500 });
  }
}

// ------------------------------------------------------------
// GET /api/v1/sponsor/blessings?limit=50 —— 管理员列表 + 未读数
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;

    const [items, unread, total] = await Promise.all([
      db.sponsorBlessing.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, content: true, nickname: true, status: true, createdAt: true },
      }),
      db.sponsorBlessing.count({ where: { status: 'NEW' } }),
      db.sponsorBlessing.count(),
    ]);

    return NextResponse.json(
      { items, unread, total, limit },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Failed to fetch blessings' }, { status: 500 });
  }
}

// ------------------------------------------------------------
// PATCH /api/v1/sponsor/blessings —— 管理员标已读（单条/批量/全部）
// body: { ids?: string[], markAllRead?: boolean }
// ------------------------------------------------------------
export async function PATCH(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }
    const { ids, markAllRead } = body as { ids?: unknown; markAllRead?: unknown };

    let updated = 0;
    if (markAllRead === true) {
      const r = await db.sponsorBlessing.updateMany({
        where: { status: 'NEW' },
        data: { status: 'READ' },
      });
      updated = r.count;
    } else if (Array.isArray(ids) && ids.length > 0) {
      const idList = ids.filter((v): v is string => typeof v === 'string').slice(0, 200);
      if (idList.length === 0) {
        return NextResponse.json({ error: '无可更新项' }, { status: 400 });
      }
      const r = await db.sponsorBlessing.updateMany({
        where: { id: { in: idList }, status: 'NEW' },
        data: { status: 'READ' },
      });
      updated = r.count;
    } else {
      return NextResponse.json({ error: '需提供 ids 或 markAllRead' }, { status: 400 });
    }

    if (updated > 0) {
      await db.operationLog.create({
        data: {
          type: 'update',
          detail: `admin → 祝福语标已读（${updated} 条${markAllRead === true ? '，全部' : ''}）`,
          adminKey: guard.admin?.username ?? 'admin',
        },
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, updated });
  } catch {
    return NextResponse.json({ error: 'Failed to update blessings' }, { status: 500 });
  }
}

// ------------------------------------------------------------
// DELETE /api/v1/sponsor/blessings?id=xxx —— 管理员删除单条
// ------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: '缺少 id 参数' }, { status: 400 });
    }

    const existing = await db.sponsorBlessing.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: '祝福语不存在或已删除' }, { status: 404 });
    }

    await db.sponsorBlessing.delete({ where: { id } });

    await db.operationLog.create({
      data: {
        type: 'delete',
        detail: `admin → 祝福语删除（${existing.nickname ?? '匿名'}：${existing.content.slice(0, 20)}${existing.content.length > 20 ? '…' : ''}）`,
        adminKey: guard.admin?.username ?? 'admin',
      },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to delete blessing' }, { status: 500 });
  }
}
