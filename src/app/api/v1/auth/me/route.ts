import { NextResponse } from 'next/server';
import { getCurrentPlayer } from '@/lib/player-auth';

// ============================================================
// GET /api/v1/auth/me
// 返回当前登录玩家信息（或 null）
// ============================================================

export async function GET() {
  try {
    const player = await getCurrentPlayer();
    return NextResponse.json({ player });
  } catch (error) {
    return NextResponse.json({ player: null }, { status: 500 });
  }
}
