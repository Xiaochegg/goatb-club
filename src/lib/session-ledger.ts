import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { db } from '@/lib/db';

// ============================================================
// AUTH V2.0 会话安全中心（管理员批示「并行完成」2026-11-11）
// 登录设备台账（SessionLedger）+ 会话展示标记（beclub_sess cookie）
// ------------------------------------------------------------
// 背景（方案 docs/PLAN-auth-v2-session-center-p3-p6-p7-2026-11-11.md §1.1/§1.2）：
//   登录/注册成功时生成 32-hex 随机标记：① 写 SessionLedger 行 sessMark
//   ② 设 beclub_sess cookie（httpOnly/lax/path=/，7 天，secure 随环境，
//   与 player-auth.ts setPlayerCookie 同款）。设备列表用「行 sessMark ===
//   当前 cookie」判定「本机」。
// 安全语义（不可动摇）：
//   beclub_sess 是「非凭证」——不参与会话验签（auth 链路与它零耦合），
//   仅用于设备列表的本机标记展示；泄露无害（不可用于伪造会话）。
//   真凭证仍是 beclub_player（HMAC 签名绑 sessionEpoch）。
// 纪律：
//   - best-effort：台账写入 / cookie 设置任何失败都绝不阻断登录主链路
//     （登录成功优先，留痕失败静默）；调用方仍可再叠加 .catch 兜底。
//   - 仅玩家轨写入（管理员轨登录审计已入 OperationLog，SC-D1）。
//   - append-only 审计语义：不更新/不删除台账行；玩家删除后留痕；
//     功能上线前的既有会话不回填（不虚构历史）。
//   - 「退出其他设备」（logout-others）不轮换本标记（SC-D3：重签非登录，
//     列表=登录史，不补行、不改行）。
// ============================================================

const SESS_MARKER_COOKIE = 'beclub_sess';

export interface SessionMarkerContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** 登录/注册成功后调用：生成会话标记 → 写台账行 → 设 beclub_sess cookie（全部 best-effort） */
export async function issueSessionMarker(playerId: string, ctx: SessionMarkerContext = {}) {
  try {
    const mark = randomBytes(16).toString('hex'); // 32-hex 展示标记（非凭证）
    // 台账写入 best-effort：失败绝不阻断登录（不抛出）
    await db.sessionLedger
      .create({
        data: {
          subjectType: 'player',
          subjectId: playerId,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          sessMark: mark,
        },
      })
      .catch(() => {});
    // cookie 设置同样 best-effort（无请求上下文等场景静默放弃，不影响登录）
    try {
      const cookieStore = await cookies();
      cookieStore.set(SESS_MARKER_COOKIE, mark, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60, // 7 天
        path: '/',
        sameSite: 'lax',
      });
    } catch {
      // 留痕标记失败不影响登录（非凭证，见顶部安全语义）
    }
  } catch {
    // 整体兜底：任何异常都不得向登录/注册主链路传播
  }
}

/** 读当前请求的会话标记（beclub_sess cookie 值），无则 undefined —— 仅用于「本机」标记比对 */
export async function getSessionMarker(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESS_MARKER_COOKIE)?.value;
}
