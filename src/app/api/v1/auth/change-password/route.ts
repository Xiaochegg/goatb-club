import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, hashPassword } from '@/lib/password';
import { getCurrentPlayer, setPlayerCookie } from '@/lib/player-auth';

// ============================================================
// POST /api/v1/auth/change-password — 登录玩家修改自己的密码
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）
// ------------------------------------------------------------
// 工单依据：三「首次登录后强制修改」的落点接口 + PHASE 5 三「密码修改后的
//   旧会话失效」在本阶段一并落地。
// 流程：登录态（getCurrentPlayer）→ 验证当前密码（临时密码或原密码）→
//   新密码（≥6 位，与注册同口径）→ scrypt 落库（仅存哈希）→
//   mustChangePassword=false（强制改密闭环）→ sessionEpoch+1（旧会话全部
//   失效，包括可能已泄漏的既有 cookie）→ 同响应重新签发当前会话 cookie
//   （epoch 新值，用户无感续期）→ 审计。
// 限流：5 次/15min/IP（与登录同款，纵深防护：即使会话被盗也无法无限暴力
//   尝试当前密码）。
// 前端约束：mustChangePassword=true 时由 PlayerAuthModal 强制改密视图调用，
//   改密成功前不可跳过（工单「首次登录后强制修改」）。
// ============================================================

const changeAttempts = new Map<string, { count: number; lastAttempt: number }>();

export async function POST(req: NextRequest) {
  const player = await getCurrentPlayer();
  if (!player) {
    return NextResponse.json({ error: '请先登录' }, { status: 401 });
  }

  try {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = changeAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429 });
    }

    const { currentPassword, newPassword } = await req.json();
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: '当前密码和新密码均为必填' }, { status: 400 });
    }
    if (String(newPassword).length < 6) {
      return NextResponse.json({ error: '新密码至少 6 位' }, { status: 400 });
    }
    // P3-23（审计 2026-11-13）：上限 128 与注册同口径（防超长密码 scrypt CPU 放大）
    if (String(newPassword).length > 128) {
      return NextResponse.json({ error: '新密码长度需在 6-128 位之间' }, { status: 400 });
    }
    if (String(newPassword) === String(currentPassword)) {
      return NextResponse.json({ error: '新密码不能与当前密码相同' }, { status: 400 });
    }

    // 身份与当前密码核验（identity 不含哈希，按 id 重查全行）
    const row = await db.player.findUnique({ where: { id: player.id } });
    if (!row || !row.passwordHash) {
      return NextResponse.json({ error: '账号状态异常，请重新登录' }, { status: 401 });
    }
    if (!verifyPassword(String(currentPassword), row.passwordHash)) {
      changeAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });
      return NextResponse.json({ error: '当前密码不正确' }, { status: 401 });
    }

    // 改密：仅存哈希 + 清除强制标记 + epoch+1（撤销全部旧会话）
    const newEpoch = row.sessionEpoch + 1;
    await db.player.update({
      where: { id: row.id },
      data: {
        passwordHash: hashPassword(String(newPassword)),
        mustChangePassword: false,
        sessionEpoch: newEpoch,
      },
    });

    // 同响应重签当前会话（新 epoch）：旧 cookie 值全部失效，当前设备无感续期
    await setPlayerCookie(row.id, newEpoch);
    changeAttempts.delete(ip);

    await db.operationLog
      .create({
        data: {
          type: 'info',
          detail: `password-changed · ${row.name} · self-service`,
          scoreChange: null,
          adminKey: row.name,
          ip,
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: '修改失败' }, { status: 500 });
  }
}
