import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentPlayer, setPlayerCookie } from '@/lib/player-auth';

// ============================================================
// POST /api/v1/auth/logout-others — 退出除当前设备外的全部会话
// AUTH V2.0 会话安全中心（批示「并行完成」2026-11-11）
// ------------------------------------------------------------
// 语义（GitHub「Sign out other sessions」同款）：sessionEpoch+1 撤销该玩家
//   全部既有会话 → 同响应重签当前会话 cookie（epoch 新值，当前设备无感续期）
//   → 其余设备即刻 401。与 change-password 同款「epoch 全撤销 + 当前无感
//   续期」模式（PHASE 3 先例），不新增签名体格式。
// 不要求密码的依据（SC-D2）：自害面极小（结果=自己重新登录一次，不丢数据、
//   不改凭证）+ 限流 + 审计兜底；管理员重置密码（epoch 事件源）另有鉴权。
// beclub_sess 标记不轮换的原因（SC-D3）：重签非登录——设备列表=登录史，
//   不补行、不改行；标记非凭证，旧标记行继续匹配「本机」，当前设备的
//   ledger 历史与 current 标记不受本次操作影响。
// 限流：5 次/15min/IP（内存 Map，键 x-forwarded-for，对齐 change-password
//   范本结构）。口径说明（与范本的一处刻意差异，如实入档批次报告）：
//   本端点无密码核验步——「调用本身」即一次尝试，因此每次到达业务逻辑的
//   调用（成功与否）都计入窗口计数；不采用范本的成功后 delete(ip) 清零
//   （该清零在 change-password 的语义是「密码试错计数随成功归位」，失败驱动；
//   若照搬，本端点的合法凭证持有者可无限次调用，限流器永不触发，
//   SC-D2 的「限流兜底」即失效）。窗口：count>=5 且 15min 内 → 429。
// 审计：每次成功撤销写 OperationLog（type info，adminKey=玩家名）。
// ============================================================

const logoutOthersAttempts = new Map<string, { count: number; lastAttempt: number }>();

export async function POST(req: NextRequest) {
  const player = await getCurrentPlayer();
  if (!player) {
    return NextResponse.json({ error: '请先登录' }, { status: 401 });
  }

  try {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = logoutOthersAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429 });
    }
    // 计数含成功调用（见顶部限流口径说明）
    logoutOthersAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });

    // 身份重查（identity 不含哈希，按 id 重查全行，同 change-password）
    const row = await db.player.findUnique({ where: { id: player.id } });
    if (!row || !row.passwordHash) {
      return NextResponse.json({ error: '账号状态异常，请重新登录' }, { status: 401 });
    }

    // epoch+1：撤销该玩家全部既有会话（包括可能已泄漏的 cookie）
    const newEpoch = row.sessionEpoch + 1;
    await db.player.update({
      where: { id: row.id },
      data: { sessionEpoch: newEpoch },
    });

    // 同响应重签当前会话（新 epoch）：当前设备无感续期；
    // beclub_sess 标记不动（SC-D3，见顶部注释）
    await setPlayerCookie(row.id, newEpoch);

    await db.operationLog
      .create({
        data: {
          type: 'info',
          detail: `session-others-revoked · ${row.name} · self-service`,
          scoreChange: null,
          adminKey: row.name,
          ip,
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}
