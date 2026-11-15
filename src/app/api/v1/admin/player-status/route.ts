import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// POST /api/v1/admin/player-status — 管理员禁用 / 恢复玩家账号
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）
// ------------------------------------------------------------
// 工单依据：二「禁用或恢复用户账号」；三「支持撤销旧会话」。
// 语义：
//   disable：disabledAt=now + sessionEpoch+1 → 该账号①立即无法登录（login 403）
//     ②既有会话立即失效（getCurrentPlayer 阻断 + 签名绑 epoch 双保险）；
//   restore：disabledAt=null → 可重新正常登录（历史值不清档，审计链完整）。
// 边界（防误伤，工单五「不得重写原有管理员后台」精神）：
//   - 仅适用于 passwordHash 非空的真实注册账号（匿名榜单条目无账号语义，400）；
//   - 本接口只作用于 Player（玩家），AdminUser 管理员体系零触碰；
//   - 权限 requireRole('OWNER','ADMIN')（敏感操作，与密码重置同级；
//     MODERATOR/VIEWER 不可，工单四「服务端验证」）。
// 审计：OperationLog type='update'，含禁用/恢复原因（禁用原因经请求参数，
//   落审计不入 Player 行——schema 无该列，最小增量）。
// ============================================================

export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    const { playerId, action, reason } = await req.json();
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }
    if (action !== 'disable' && action !== 'restore') {
      return NextResponse.json({ error: 'action 必须为 disable 或 restore' }, { status: 400 });
    }

    const player = await db.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return NextResponse.json({ error: '玩家不存在' }, { status: 404 });
    }
    if (!player.passwordHash) {
      return NextResponse.json(
        { error: '该条目不是注册账号（匿名榜单条目），无账号可禁用/恢复' },
        { status: 400 },
      );
    }

    const ip = req.headers.get('x-forwarded-for') || 'unknown';

    if (action === 'disable') {
      if (player.disabledAt) {
        return NextResponse.json({ error: '该账号已处于禁用状态' }, { status: 400 });
      }
      const nowDate = new Date();
      await db.player.update({
        where: { id: player.id },
        data: { disabledAt: nowDate, sessionEpoch: { increment: 1 } }, // epoch+1：旧会话立即失效
      });
      const reasonBrief = String(reason || '').trim().slice(0, 100) || '未填写';
      await db.operationLog
        .create({
          data: {
            type: 'update',
            detail: `account-disabled · ${player.name} · reason: ${reasonBrief}`,
            scoreChange: null,
            adminKey: admin.username,
            beforeData: JSON.stringify({ name: player.name, disabledAt: null }),
            afterData: JSON.stringify({ name: player.name, disabledAt: nowDate.toISOString() }),
            ip,
            sessionId: player.id,
          },
        })
        .catch(() => {});
      return NextResponse.json({ success: true, action, playerName: player.name });
    }

    // restore
    if (!player.disabledAt) {
      return NextResponse.json({ error: '该账号未被禁用' }, { status: 400 });
    }
    await db.player.update({
      where: { id: player.id },
      data: { disabledAt: null },
    });
    await db.operationLog
      .create({
        data: {
          type: 'update',
          detail: `account-restored · ${player.name}`,
          scoreChange: null,
          adminKey: admin.username,
          beforeData: JSON.stringify({ name: player.name, disabledAt: player.disabledAt.toISOString() }),
          afterData: JSON.stringify({ name: player.name, disabledAt: null }),
          ip,
          sessionId: player.id,
        },
      })
      .catch(() => {});
    return NextResponse.json({ success: true, action, playerName: player.name });
  } catch (error) {
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}
