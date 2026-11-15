import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

// ============================================================
// GET /api/pvp/players —— 约战对手候选（公开只读，最小字段白名单）
// 仅返回「已注册」玩家（email+passwordHash 齐备）——未注册条目无法
// 登录回应约战，列为候选只会产生必然过期的僵尸请求（任务书 §7.2
// 「排除不符合业务规则的账号」的落地）。绝不输出 email/passwordHash/role。
// ============================================================

export async function GET() {
  try {
    const players = await db.player.findMany({
      where: { email: { not: null }, passwordHash: { not: null } },
      select: { id: true, name: true, avatarUrl: true, tiers: true },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return NextResponse.json(
      {
        players: players.map(p => ({
          id: p.id,
          name: p.name,
          avatarUrl: p.avatarUrl,
          tiers: typeof p.tiers === 'string' ? safeParse(p.tiers) : {},
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: '玩家列表加载失败' }, { status: 500 });
  }
}

function safeParse(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
