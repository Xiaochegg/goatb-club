import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { signSessionId, verifySessionId } from '@/lib/session';

// ============================================================
// 玩家自助认证（方案 A）
// 复用 scrypt（src/lib/password.ts）+ HMAC 签名 cookie 模式
// 玩家注册后可登录认领自己的 Player 条目，但积分/段位/战绩仍由管理员操作
// 自审核 P0 修复：cookie 由裸 Player.id 改为签名值（Player.id 公开可见，裸存可被冒充）
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）：
//   1) 验签绑定 sessionEpoch（管理员重置密码/禁用账号 → epoch+1 → 旧会话全部失效，
//      工单三「支持撤销旧会话」）；legacy 分支由 session.ts 内部兼容读。
//   2) 禁用账号访问阻断：disabledAt 非空 → 即使签名有效也视为未登录
//      （工单 PHASE 5 三「账号禁用后的访问阻断」在本阶段一并落地）。
//   3) mustChangePassword 输出：临时密码登录后前端强制改密的依据。
// ============================================================

const PLAYER_COOKIE_NAME = 'beclub_player';

export interface PlayerIdentity {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt?: string | null;
  lastLoginAt?: string | null;
  // UNIFIED ACCOUNT V1 P1：邮箱验证态（null = 未验证；PHASE 3 起验证流程退役，
  // 字段与历史值原样保留，不再新增写入）
  emailVerifiedAt?: string | null;
  // AUTH V2.0 PHASE 3：true = 当前密码为管理员重置的临时密码，登录后必须强制改密
  mustChangePassword?: boolean;
}

async function getCookieValue(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(PLAYER_COOKIE_NAME)?.value;
}

/** 从 cookie 解析当前登录玩家（验签[绑 epoch]后查库 + 禁用阻断），或 null */
export async function getCurrentPlayer(): Promise<PlayerIdentity | null> {
  const cookieVal = await getCookieValue();
  if (!cookieVal) return null;
  try {
    // cookie 明文段即 id（HMAC 只保证不可伪造，不隐藏 id——与历史行为一致）；
    // 先查该玩家当前 epoch，再验签（签名输入含 epoch），失败回退 legacy。
    const idPart = cookieVal.slice(0, cookieVal.lastIndexOf('.'));
    const row = idPart
      ? await db.player.findUnique({ where: { id: idPart }, select: { sessionEpoch: true } }).catch(() => null)
      : null;
    const playerId = await verifySessionId(cookieVal, row?.sessionEpoch ?? 0);
    if (!playerId) return null;
    const player = await db.player.findUnique({ where: { id: playerId } });
    if (player && player.email && player.passwordHash) {
      // 禁用账号访问阻断：签名再有效也不认（工单 PHASE 5 三，本阶段落地）
      if (player.disabledAt) return null;
      return {
        id: player.id,
        name: player.name,
        email: player.email,
        role: player.role,
        createdAt: player.createdAt ? player.createdAt.toISOString() : null,
        lastLoginAt: player.lastLoginAt ? player.lastLoginAt.toISOString() : null,
        emailVerifiedAt: player.emailVerifiedAt ? player.emailVerifiedAt.toISOString() : null,
        mustChangePassword: player.mustChangePassword,
      };
    }
  } catch {
    // DB error → fall through
  }
  return null;
}

/** 设置玩家登录 cookie（HMAC 签名值[绑当前 epoch]，防伪造） */
export async function setPlayerCookie(playerId: string, epoch = 0) {
  const cookieStore = await cookies();
  cookieStore.set(PLAYER_COOKIE_NAME, await signSessionId(playerId, epoch), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60, // 7 天
    path: '/',
    sameSite: 'lax',
  });
}

/** 清除玩家登录 cookie */
export async function clearPlayerCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(PLAYER_COOKIE_NAME);
}

export const PLAYER_COOKIE = PLAYER_COOKIE_NAME;

/**
 * 公开输出的玩家字段白名单剥离（自审核 P0 修复）。
 * 修复前：findMany 全字段直出，passwordHash/email/role/lastLoginAt 泄露给任何访客。
 * 管理员登录时可保留 email/role 供后台使用；passwordHash 任何情况都不出。
 * AUTH V2.0 PHASE 3：新增安全面列（sessionEpoch/mustChangePassword/disabledAt/
 * passwordResetAt）对任何身份一律剥离——账号安全状态仅经 admin/player-account
 * 专用接口按需返回（SR-02 扩展口径；工单三「管理员不能查看用户原始密码」的
 * 延伸：会话纪元等安全内部态同样不公开）。
 */
export function sanitizePlayerOutput<
  T extends {
    passwordHash?: string | null; email?: string | null; role?: string; lastLoginAt?: Date | null;
    sessionEpoch?: number; mustChangePassword?: boolean; disabledAt?: Date | null; passwordResetAt?: Date | null;
  },
>(p: T, opts: { isAdmin: boolean }): Omit<T, 'passwordHash' | 'lastLoginAt' | 'sessionEpoch' | 'mustChangePassword' | 'disabledAt' | 'passwordResetAt'> & { email?: string | null } {
  const {
    passwordHash: _ph, lastLoginAt: _ll,
    sessionEpoch: _se, mustChangePassword: _mcp, disabledAt: _da, passwordResetAt: _pra,
    ...rest
  } = p;
  if (!opts.isAdmin) {
    const { email: _em, role: _ro, ...pub } = rest;
    // 类型断言：TS 无法从泛型 Omit 推导 spread 结果与返回签名兼容（既有噪音，
    // 本批以单行断言归零触碰文件 tsc 错误；运行时行为不变）
    return pub as Omit<T, 'passwordHash' | 'lastLoginAt'> & { email?: string | null };
  }
  return rest;
}
