import { db } from '@/lib/db';
import { requireRole, getCurrentAdmin } from '@/lib/auth';
import { sanitizePlayerOutput } from '@/lib/player-auth';
import { normalizePlayersTiers, upgradeLegacyTiers } from '@/lib/tiers';
import { NextRequest, NextResponse } from 'next/server';
import { withCache, bustPlayerCaches } from '@/lib/cache';
import { CONFIG_KEYS } from '@/lib/constants';
import { parseTagStyles } from '@/lib/tag-styles';

// GET /api/v1/players - List players with search (name OR uuid) + limit
// Query params:
//   search — matches name (contains) OR id (contains, for UUID lookup)
//   limit  — max results (default 50, capped 200)
// 自审核 P0 修复：公开响应剥离 passwordHash/email/role/lastLoginAt（管理员保留 email/role）
//
// Cache: 15s TTL, keyed by (search, limit, role) so public visitors share
// one cached page and admin sees a separate (email-inclusive) cache. This
// is the leaderboard's hottest endpoint — collapsing concurrent loads is
// the biggest DB-pressure win in the sandbox.
export async function GET(req: NextRequest) {
  try {
    const search = req.nextUrl.searchParams.get('search') || '';
    const limitRaw = parseInt(req.nextUrl.searchParams.get('limit') || '50');
    const limit = Math.min(Math.max(limitRaw || 50, 1), 200);

    const where = search
      ? { OR: [{ name: { contains: search } }, { id: { contains: search } }] }
      : undefined;

    const isAdmin = (await getCurrentAdmin()) !== null;
    const cacheKey = `players:list:${search}:${limit}:${isAdmin ? 'admin' : 'public'}`;

    const players = await withCache(cacheKey, 15_000, async () => {
      const rows = await db.player.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      // W1-T1b: DB 存新格式 tiers，返回前降级回旧格式（前端零改动）
      const normalized = normalizePlayersTiers(rows);
      // 注入玩家个性标签样式（Config.player_tag_styles 单 JSON 键，不改 Schema）
      const styleRow = await db.config.findUnique({ where: { key: CONFIG_KEYS.PLAYER_TAG_STYLES } });
      const styles = parseTagStyles(styleRow?.value);
      return normalized.map((p) => {
        const out = sanitizePlayerOutput(p, { isAdmin });
        const ts = styles[p.id];
        return ts ? { ...out, tagStyle: ts } : { ...out, tagStyle: null };
      });
    });

    return NextResponse.json({ players });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch players' }, { status: 500 });
  }
}

// POST /api/v1/players - Create a new player
// AUTH V2.0 安全修复专项（2026-11-11）：RBAC 升格——VIEWER 只读，创建限
// OWNER/ADMIN/MODERATOR（对齐 canEditPlayers，spec §19）
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { name, avatarUrl, tiers, overrideScores, stats, emotionText } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Player name is required' }, { status: 400 });
    }

    const existing = await db.player.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return NextResponse.json({ error: 'Player name already exists' }, { status: 409 });
    }

    const player = await db.player.create({
      data: {
        name: name.trim(),
        avatarUrl: avatarUrl || null,
        // W1-T1b 修正: 写入路径统一升级 — 前端传旧格式 {SHIELD:"HT1"}，
        // upgradeLegacyTiers 自动包装为新格式 {SHIELD:{tier,source:'manual',updatedAt}}
        tiers: tiers ? upgradeLegacyTiers(JSON.stringify(tiers)) : '{}',
        overrideScores: overrideScores ? JSON.stringify(overrideScores) : '{}',
        stats: stats ? JSON.stringify(stats) : '{}',
        emotionText: emotionText || null,
      },
    });
    const playerNormalized = normalizePlayersTiers([player])[0];

    await db.operationLog.create({
      data: {
        type: 'create',
        detail: `admin → player · ${player.name}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // New player added → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ player: playerNormalized });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create player' }, { status: 500 });
  }
}
