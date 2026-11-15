import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { bustPlayerCaches } from '@/lib/cache';

// POST /api/v1/players/[id]/like - Like a player (rate-limited per IP)
// Rate limit: 1 like per 3 seconds per IP to prevent spam inflation

const likeTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 3000;

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ip = getClientIp(req);
    const now = Date.now();
    const lastLike = likeTimestamps.get(ip) || 0;
    if (now - lastLike < RATE_LIMIT_MS) {
      return NextResponse.json(
        { error: '操作过于频繁，请稍后再试', code: 'RATE_LIMITED' },
        { status: 429 }
      );
    }

    // AU 审计修复（2026-11）：玩家存在性校验提前 —— 此前 404（玩家不存在/
    // id 拼错）也会写入限流时间戳，白耗 3s 额度；校验通过才记账。
    const player = await db.player.findUnique({ where: { id } });
    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 });

    likeTimestamps.set(ip, now);

    // Clean up old entries periodically (keep map small)
    if (likeTimestamps.size > 1000) {
      for (const [key, ts] of likeTimestamps) {
        if (now - ts > 60000) likeTimestamps.delete(key);
      }
    }

    const updated = await db.player.update({
      where: { id },
      data: { likes: { increment: 1 } },
    });
    // Bust cached player lists + stats so the new like count shows up.
    bustPlayerCaches();
    return NextResponse.json({ likes: updated.likes });
  } catch {
    return NextResponse.json({ error: 'Failed to like player' }, { status: 500 });
  }
}
