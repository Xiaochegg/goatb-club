import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifySessionId } from '@/lib/session';

// ============================================================
// Server-side admin authentication — AdminUser table only
// 自审核 P0 修复：
//   1) 移除 legacy cookie='1' 分支（此前任何人设 beclub_admin=1 即获 ADMIN 权限）
//   2) cookie 值改为 HMAC 签名，验签通过才查库（防伪造）
// 2026-11 环境兼容修复：
//   部分访问环境（纯 HTTP 的生产构建 / 预览页 iframe 第三方 cookie 拦截）
//   会导致浏览器不存/不回传 SameSite=Lax cookie → 登录后全部 401。
//   增加 X-Admin-Token 请求头回退：登录响应 JSON 返回同一 HMAC 签名值，
//   前端存 sessionStorage 并在管理请求上附带；验签逻辑与 cookie 完全一致，
//   不降低安全性（签名不可伪造，secret 在 DB Config，不入代码/日志）。
// AUTH V2.0 PHASE 4（管理员批示「p4」2026-11-11）—— 管理员轨接入统一会话底座：
//   验签绑定 AdminUser.sessionEpoch（与玩家轨 getCurrentPlayer 完全同构：
//   先查库读当前纪元 → verifySessionId(cred, epoch)，签名输入含纪元）。
//   当前 epoch 恒 0（无事件源），行为与接线前逐字节等效；任何未来凭证事件
//   将该值 +1 即刻撤销该管理员全部会话（含 cookie 与 X-Admin-Token 两条
//   凭证面），无需改代码。legacy 旧格式兼容读由 session.ts 内部保留。
//   方案：docs/PLAN-auth-v2-phase4-admin-unified-session-2026-11-11.md
// ============================================================

const ADMIN_COOKIE_NAME = 'beclub_admin';
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export type AdminRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'VIEWER';

export interface AdminIdentity {
  id: string;
  username: string;
  role: AdminRole;
  source: 'table';
}

// --- Read the admin credential: HttpOnly cookie 优先，无 cookie 时回退 X-Admin-Token 头 ---
async function getCookieValue(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_COOKIE_NAME)?.value;
}

async function getHeaderValue(): Promise<string | undefined> {
  try {
    const h = await headers();
    return h.get(ADMIN_TOKEN_HEADER) || undefined;
  } catch {
    return undefined; // 非 request 上下文（极少）
  }
}

// --- Resolve the current admin identity from cookie/header, or null ---
export async function getCurrentAdmin(): Promise<AdminIdentity | null> {
  const cookieVal = await getCookieValue();
  const cred = cookieVal || (await getHeaderValue());
  if (!cred) return null;

  // PHASE 4 纪元绑定：先按凭证明文段（=id）读该管理员当前 sessionEpoch，
  // 再验签（签名输入含 epoch；查库失败回退 0，与玩家轨 .catch(() => null) 同款）。
  // cookie 与 X-Admin-Token 两条凭证面在此汇合，语义一致。
  const idPart = cred.slice(0, cred.lastIndexOf('.'));
  const row = idPart
    ? await db.adminUser
        .findUnique({ where: { id: idPart }, select: { sessionEpoch: true } })
        .catch(() => null)
    : null;

  // 验签：凭据必须是 signSessionId 签发的 id.mac，否则直接拒绝
  const userId = await verifySessionId(cred, row?.sessionEpoch ?? 0);
  if (!userId) return null;

  try {
    const user = await db.adminUser.findUnique({ where: { id: userId } });
    if (user) {
      return {
        id: user.id,
        username: user.username,
        role: user.role as AdminRole,
        source: 'table',
      };
    }
  } catch {
    // DB error → fall through
  }
  return null;
}

// --- Backward-compatible boolean check ---
export async function isAdmin(): Promise<boolean> {
  return (await getCurrentAdmin()) !== null;
}

// --- Backward-compatible guard (any admin role) ---
export async function requireAdmin(): Promise<NextResponse | null> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: '未授权 — 请先登录管理员账号', code: 'UNAUTHORIZED' },
      { status: 401 }
    );
  }
  return null;
}

// --- Role-based guard (spec §19) ---
// Returns null if the current admin has one of the allowed roles,
// or a 403 NextResponse if their role is insufficient.
// Example: requireRole('OWNER', 'ADMIN') — only OWNER and ADMIN pass.
export async function requireRole(...allowedRoles: AdminRole[]): Promise<{
  admin: AdminIdentity;
  response: null;
} | {
  admin: null;
  response: NextResponse;
}> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return {
      admin: null,
      response: NextResponse.json(
        { error: '未授权 — 请先登录管理员账号', code: 'UNAUTHORIZED' },
        { status: 401 }
      ),
    };
  }
  if (!allowedRoles.includes(admin.role)) {
    return {
      admin: null,
      response: NextResponse.json(
        { error: `权限不足 — 需要 ${allowedRoles.join(' 或 ')} 角色`, code: 'FORBIDDEN' },
        { status: 403 }
      ),
    };
  }
  return { admin, response: null };
}

// --- Role hierarchy for UI hints (higher = more powerful) ---
export const ROLE_RANK: Record<AdminRole, number> = {
  VIEWER: 1,
  MODERATOR: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function canManageUsers(role: AdminRole): boolean {
  return role === 'OWNER';
}
export function canEditPlayers(role: AdminRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MODERATOR';
}
export function canDeletePlayers(role: AdminRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
export function canEditConfig(role: AdminRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
