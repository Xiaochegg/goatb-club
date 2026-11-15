import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { isPvpStatus } from '@/lib/pvp';
import { serializeRows, sweepExpiredChallenges } from '@/lib/pvp-server';

// ============================================================
// GET /api/v1/admin/pvp/challenges —— 约战工单管理（只读；工单 §11）
// 门禁：OWNER / ADMIN / MODERATOR。**只读** —— 管理员可查看但绝不代替
// 玩家接受/拒绝（不得绕过玩家确认机制，工单 §11 明文）。
// 惰性过期清扫后返回：状态筛选 + 玩家名搜索 + 分页 + 状态计数。
// ============================================================

export async function GET(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    await sweepExpiredChallenges();

    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status') ?? '';
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const pageRaw = Number(url.searchParams.get('page') ?? '1');
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    const pageSizeRaw = Number(url.searchParams.get('pageSize') ?? '20');
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(Math.trunc(pageSizeRaw), 5), 100) : 20;

    // 玩家名搜索 → 先解析为 id 集合（名称仅显示用途，不作为身份依据）
    let nameIds: string[] | null = null;
    if (q) {
      const hits = await db.player.findMany({
        where: { name: { contains: q } },
        select: { id: true },
        take: 100,
      });
      nameIds = hits.map(h => h.id);
      if (nameIds.length === 0) {
        return NextResponse.json(
          { ok: true, items: [], counts: {}, total: 0, page, pageSize },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    const where = {
      ...(isPvpStatus(statusParam) && statusParam ? { status: statusParam } : {}),
      ...(nameIds ? { OR: [{ challengerId: { in: nameIds } }, { opponentId: { in: nameIds } }] } : {}),
    };

    const [rows, total, group] = await Promise.all([
      db.pvpChallenge.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      db.pvpChallenge.count({ where }),
      db.pvpChallenge.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const counts: Record<string, number> = {};
    for (const g of group) counts[g.status] = g._count._all;

    const items = await serializeRows(rows, '__admin_viewer__');
    return NextResponse.json(
      { ok: true, items, counts, total, page, pageSize },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: '约战工单加载失败' }, { status: 500 });
  }
}
