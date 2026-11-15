import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/password';
import { randomInt } from 'node:crypto';

// ============================================================
// POST /api/v1/admin/password-reset — 管理员为指定玩家重置密码
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）
// ------------------------------------------------------------
// 工单依据：二「为指定用户重置密码」；三「临时密码必须：安全随机生成 /
//   仅展示一次 / 仅存储哈希 / 首次登录后强制修改 / 支持撤销旧会话」。
// 安全实现：
//   - 临时密码 = crypto.randomInt over 54 字符去混淆集 × 10 位（≈57.4-bit 熵），
//     明文【仅本次响应返回一次】，服务端只存 scrypt 哈希（passwordHash 覆盖），
//     绝不入库明文/入日志/入审计 detail（SR-06）；
//   - mustChangePassword=true → 玩家下次登录后前端强制改密（不可跳过）；
//   - sessionEpoch+1 → 该玩家全部既有 HMAC 会话立即失效（撤销旧会话，
//     不改 Cookie 格式，见批次报告 HMAC 演进专章）；
//   - passwordResetAt=now → 后台「密码重置时间」数据源（工单二）；
//   - 副作用明示：原密码立即失效（被临时密码覆盖），属重置语义预期。
// 权限：requireRole('OWNER','ADMIN')——服务端验证（工单四），MODERATOR/VIEWER
//   与普通用户一律 401/403；响应口径与全站一致。
// 频控：每管理员 20 次/小时（内存 Map，防滥用）。
// 审计：OperationLog type='update'，before/after 快照不含 passwordHash。
// ============================================================

const RESET_CHARSETS = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'; // 54 chars
const TEMP_PASSWORD_LENGTH = 10;
const RESETS_PER_HOUR = 20;

const adminResetAttempts = new Map<string, { count: number; windowStart: number }>();

function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += RESET_CHARSETS[randomInt(RESET_CHARSETS.length)];
  }
  return out;
}

export async function POST(req: NextRequest) {
  // 权限守卫（服务端硬校验；普通用户/匿名此处即被拦截）
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;

  try {
    // 频控：每管理员 20 次/小时
    const now = Date.now();
    const rec = adminResetAttempts.get(admin.username);
    if (rec && now - rec.windowStart < 60 * 60 * 1000 && rec.count >= RESETS_PER_HOUR) {
      return NextResponse.json({ error: '操作过于频繁：请稍后再试' }, { status: 429 });
    }

    const { playerId } = await req.json();
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }

    const player = await db.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return NextResponse.json({ error: '玩家不存在' }, { status: 404 });
    }
    // 仅真实注册账号可重置（匿名榜单条目无密码体系）
    if (!player.passwordHash || !player.email) {
      return NextResponse.json(
        { error: '该条目不是注册账号（无邮箱/密码），无法重置密码' },
        { status: 400 },
      );
    }

    // 生成临时密码 + 原子更新（仅存哈希；epoch+1 撤销旧会话）
    const tempPassword = generateTempPassword();
    const nowDate = new Date();
    const updated = await db.player.update({
      where: { id: player.id },
      data: {
        passwordHash: hashPassword(tempPassword),
        mustChangePassword: true,
        passwordResetAt: nowDate,
        sessionEpoch: { increment: 1 },
      },
    });

    // 频控计数（成功才计入）
    if (rec && now - rec.windowStart < 60 * 60 * 1000) {
      adminResetAttempts.set(admin.username, { count: rec.count + 1, windowStart: rec.windowStart });
    } else {
      adminResetAttempts.set(admin.username, { count: 1, windowStart: now });
    }

    // 审计（绝不记录临时密码明文——SR-06）
    await db.operationLog
      .create({
        data: {
          type: 'update',
          detail: `password-reset · ${player.name} · temp password issued (show-once, must-change)`,
          scoreChange: null,
          adminKey: admin.username,
          beforeData: JSON.stringify({ name: player.name, email: player.email }),
          afterData: JSON.stringify({
            name: player.name,
            email: player.email,
            mustChangePassword: true,
            passwordResetAt: nowDate.toISOString(),
          }),
          ip: req.headers.get('x-forwarded-for') || 'unknown',
          sessionId: player.id,
        },
      })
      .catch(() => {});

    // 明文临时密码：仅此一次随响应返回，管理员线下交付玩家
    return NextResponse.json({
      success: true,
      playerName: updated.name,
      playerEmail: updated.email,
      tempPassword,
      note: '临时密码仅本次显示，关闭后不可再查看；请提醒玩家登录后立即设置新密码。',
    });
  } catch (error) {
    return NextResponse.json({ error: '重置失败' }, { status: 500 });
  }
}
