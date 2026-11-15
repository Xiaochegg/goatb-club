import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// GET /api/v1/admin/player-account?playerId=xxx — 玩家账号安全信息（管理员）
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）
// ------------------------------------------------------------
// 工单依据：二「按邮箱搜索用户 / 查看用户账号基本信息 / 查看密码重置时间」。
// 设计：
//   - 专用管理接口（requireAdmin 全护），不改动公开 GET /api/v1/players 的
//     白名单剥离口径（SR-02 回归面零触碰）；
//   - 返回账号安全画像：邮箱/注册时间/末次登录/密码重置时间/强制改密标记/
//     禁用状态/是否有密码——passwordHash 与 sessionEpoch 任何情况绝不返回
//     （工单三「管理员不能查看用户原始密码」+ 哈希本身亦不出）；
//   - 「按邮箱搜索」：GET /api/v1/players（管理员视角）本就返回 email 字段
//     （sanitizePlayerOutput 管理员分支，既有能力），后台列表已可按邮箱过滤；
//     对无 email 的匿名条目，本接口也能返回基础画像供身份核实。
// ============================================================

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard) return guard;

  try {
    const playerId = req.nextUrl.searchParams.get('playerId');
    if (!playerId) {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }

    const player = await db.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return NextResponse.json({ error: '玩家不存在' }, { status: 404 });
    }

    return NextResponse.json({
      account: {
        id: player.id,
        name: player.name,
        email: player.email,
        role: player.role,
        isRegistered: Boolean(player.passwordHash),
        createdAt: player.createdAt ? player.createdAt.toISOString() : null,
        lastLoginAt: player.lastLoginAt ? player.lastLoginAt.toISOString() : null,
        passwordResetAt: player.passwordResetAt ? player.passwordResetAt.toISOString() : null,
        mustChangePassword: player.mustChangePassword,
        disabledAt: player.disabledAt ? player.disabledAt.toISOString() : null,
        // 邮箱验证流程已退役（PHASE 3，台账 R2-1）；历史值原样展示供核实
        emailVerifiedAt: player.emailVerifiedAt ? player.emailVerifiedAt.toISOString() : null,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
