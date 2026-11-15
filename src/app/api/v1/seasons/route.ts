import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { withCache, invalidate } from '@/lib/cache';

// ============================================================
// GET /api/v1/seasons — list all seasons (public, cached 60s)
// POST /api/v1/seasons — create a season (admin, busts cache)
// ============================================================

const SEASONS_CACHE_KEY = 'seasons:list';
const SEASONS_CACHE_TTL = 60_000;

export async function GET() {
  try {
    // C4 查询投影瘦身：公开列表只返回消费端字段（header/footer 用 id/name/status/startAt，
    // 管理端另用 endAt）；createdAt 不下发——golden 键形比对通过后收窄。
    const seasons = await withCache(SEASONS_CACHE_KEY, SEASONS_CACHE_TTL, () =>
      db.season.findMany({
        orderBy: { startAt: 'desc' },
        select: { id: true, name: true, startAt: true, endAt: true, status: true },
      }),
    );
    return NextResponse.json({ seasons });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch seasons' }, { status: 500 });
  }
}

// AUTH V2.0 安全修复专项（2026-11-11）：赛季结构变更=配置写入，限 OWNER/ADMIN
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { name, startAt, endAt, status } = body;

    if (!name || !startAt) {
      return NextResponse.json({ error: 'name and startAt are required' }, { status: 400 });
    }

    // If creating an ACTIVE season, deactivate any existing ACTIVE season
    if (status === 'ACTIVE') {
      await db.season.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'ENDED' },
      });
    }

    const season = await db.season.create({
      data: {
        name: String(name),
        startAt: new Date(startAt),
        endAt: endAt ? new Date(endAt) : null,
        status: status || 'UPCOMING',
      },
    });

    await db.operationLog.create({
      data: {
        type: 'create',
        detail: `admin → season · ${season.name} (${season.status})`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Bust the cached seasons list so the new season shows up immediately.
    invalidate(SEASONS_CACHE_KEY);

    return NextResponse.json({ season });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create season' }, { status: 500 });
  }
}
