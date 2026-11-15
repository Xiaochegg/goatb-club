import { NextResponse } from 'next/server';
import { clearPlayerCookie } from '@/lib/player-auth';

// ============================================================
// POST /api/v1/auth/logout
// 玩家退出登录
// ============================================================

export async function POST() {
  try {
    await clearPlayerCookie();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: '退出失败' }, { status: 500 });
  }
}
