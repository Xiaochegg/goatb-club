import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/v1/admin/status
// Public endpoint — tells the login UI whether the system has
// AdminUser accounts (→ show username field) or is in legacy
// password-only mode (→ show password field only).
// P3-19（审计 2026-11-13）：不再下发管理员账号数量 count —— 布尔量
// 已满足登录 UI 判定，具体数量属内部信息不应公开探测。
// （grep 全库：本端点当前无前端消费方，收敛零连带。）
export async function GET() {
  try {
    const count = await db.adminUser.count();
    return NextResponse.json({
      hasAdminUsers: count > 0,
    });
  } catch {
    return NextResponse.json({ hasAdminUsers: false });
  }
}
