import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

// ============================================================
// GET /api/pvp/health —— 无副作用健康检查（工单 §9.4）
// 用途：管理后台「API 测试」按钮与前端探活；绝不触碰工单创建接口。
// 返回：{ ok, db, time }；db=false 仅表示台账查询异常，接口本体仍可达。
// ============================================================

export async function GET() {
  let dbOk = false;
  try {
    await db.pvpChallenge.count();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return NextResponse.json(
    { ok: true, db: dbOk, time: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
