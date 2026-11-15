import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/password';
import { setPlayerCookie } from '@/lib/player-auth';
import { issueSessionMarker } from '@/lib/session-ledger';

// ============================================================
// POST /api/v1/auth/login
// 玩家登录：email + password
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）增量：
//   1) 禁用账号拦截：disabledAt 非空 → 403（密码验证通过后仍拒绝登录，
//      工单「禁用或恢复用户账号」的登录侧闭环）；
//   2) 会话签名绑定 sessionEpoch（管理员重置密码/禁用 → epoch+1 → 旧会话失效）；
//   3) 响应下发 mustChangePassword：临时密码首登后前端强制改密的依据
//      （工单三「首次登录后强制修改」）。
// ============================================================

const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429 });
    }

    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: '邮箱和密码均为必填' }, { status: 400 });
    }

    const player = await db.player.findFirst({
      where: { email: String(email).toLowerCase() },
    });
    if (!player || !player.passwordHash || !verifyPassword(String(password), player.passwordHash)) {
      loginAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });
      // P2-11（审计 2026-11-13）：玩家登录失败补留痕（对齐 admin/login 的
      // login-fail 留痕口径：type=warn、含账号与 ip、绝不记密码；仅 401
      // 路径记录，429 不记录防锁定期轰炸放大审计面。体量受既有 5 次/
      // 15min/IP 限流约束，单 IP 单窗口至多 6 行。）
      await db.operationLog
        .create({
          data: {
            type: 'warn',
            detail: `login-fail · ${String(email).trim().slice(0, 64)} · ip=${ip}`,
            scoreChange: null,
            adminKey: String(email).trim().slice(0, 64),
            ip,
          },
        })
        .catch(() => {});
      return NextResponse.json({ error: '邮箱或密码错误' }, { status: 401 });
    }

    // 禁用账号拦截（工单 PHASE 3 二「禁用」）：密码正确也拒绝，不泄露更多状态
    if (player.disabledAt) {
      loginAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });
      return NextResponse.json(
        { error: '该账号已被禁用：请联系管理员申请恢复', code: 'ACCOUNT_DISABLED' },
        { status: 403 },
      );
    }

    await db.player.update({ where: { id: player.id }, data: { lastLoginAt: new Date() } });
    // 会话签名绑定当前 epoch：后续管理员重置密码/禁用 → epoch+1 → 本会话失效
    await setPlayerCookie(player.id, player.sessionEpoch);
    // AUTH V2.0 会话安全中心：留痕+标记（best-effort，失败不阻断）
    await issueSessionMarker(player.id, { ip, userAgent: req.headers.get('user-agent') }).catch(() => {});
    loginAttempts.delete(ip);

    return NextResponse.json({
      success: true,
      // player 内联 mustChangePassword：前端 setPlayer 一体承接（store 单一事实源）
      player: { id: player.id, name: player.name, email: player.email, mustChangePassword: player.mustChangePassword },
    });
  } catch (error) {
    return NextResponse.json({ error: '登录失败' }, { status: 500 });
  }
}
