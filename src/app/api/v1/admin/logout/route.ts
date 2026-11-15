import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// ============================================================
// POST /api/v1/admin/logout
// 清除管理员 cookie，退出登录
// ============================================================

const ADMIN_COOKIE_NAME = 'beclub_admin';

export async function POST() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(ADMIN_COOKIE_NAME);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Logout failed' }, { status: 500 });
  }
}
