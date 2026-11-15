import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentPlayer } from '@/lib/player-auth';
import { getSessionMarker } from '@/lib/session-ledger';

// ============================================================
// GET /api/v1/auth/sessions — 会话安全中心：登录设备台账 + 安全状态
// AUTH V2.0 会话安全中心（批示「并行完成」2026-11-11）
// ------------------------------------------------------------
// 契约（方案 §1.3，前后端并行开发依据）：
//   登录态（getCurrentPlayer）→ 200：
//     security = { lastLoginAt, passwordResetAt, mustChangePassword, disabled }
//     sessions = SessionLedger 该玩家最近 20 行（createdAt 倒序），每行
//     { id, ip, userAgent, createdAt, current }；
//     current = 行 sessMark === beclub_sess cookie（「本机」标记，非凭证比对）。
//   无登录 → 401 {"error":"请先登录"}（照抄既有 auth 路由口径）。
// 纪律：
//   - 只读接口：不写台账、不写任何状态（append-only 语义不被读取路径破坏）。
//   - sessMark 明文绝不出响应体（本机判定在服务端完成，泄露面最小化）；
//     台账行不外泄 subjectId（路径已限定当前玩家）。
//   - 不回填历史：功能上线前的既有会话无台账行（不虚构）。
// ============================================================

export async function GET() {
  try {
    const player = await getCurrentPlayer();
    if (!player) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    // 安全状态：查 Player 全行（PHASE 3 新增安全面列按需返回的唯一出口之一）
    const row = await db.player.findUnique({ where: { id: player.id } });
    if (!row) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    // 设备台账：本玩家最近 20 行，createdAt 倒序（R6：不加索引，表极小）
    const ledgerRows = await db.sessionLedger.findMany({
      where: { subjectType: 'player', subjectId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const marker = await getSessionMarker();
    const sessions = ledgerRows.map(r => ({
      id: r.id,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      current: !!r.sessMark && r.sessMark === marker,
    }));

    return NextResponse.json({
      success: true,
      security: {
        lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
        passwordResetAt: row.passwordResetAt ? row.passwordResetAt.toISOString() : null,
        mustChangePassword: !!row.mustChangePassword,
        disabled: !!row.disabledAt,
      },
      sessions,
    });
  } catch {
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
