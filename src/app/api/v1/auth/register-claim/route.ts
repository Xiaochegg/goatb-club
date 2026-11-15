import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/password';
import { findPlayerByGameName } from '@/lib/game-name';

// ============================================================
// POST /api/v1/auth/register-claim — 注册直达认领（工单 2026-11-12）
// ------------------------------------------------------------
// 背景：管理员先代录了成员名字（虚拟邮箱匿名条目）→ 玩家注册时写正式
// 邮箱 + 相同游戏ID → 旧流程 409 死路（要求「登录后认领」，但玩家尚无
// 账号可登录）。本端点打通直达通道：
//   注册撞名（匿名条目）→ 玩家直接提交认领申请（email + password +
//   游戏ID）→ 管理员后台确认 → 虚拟邮箱替换为玩家正式邮箱 + 凭据落位
//   （PATCH /api/v1/claims/[id] approve 的 register-direct 分支）。
// 安全设计：
//   - 密码只存 scrypt 哈希（pendingCredentials.claimPasswordHash），
//     绝不入明文日志；
//   - 邮箱撞车：与注册同口径（已有账号占用 → 静默统一文案，不泄露存在性）；
//   - 防重复：同目标 pending 唯一 + 同邮箱 pending 唯一；
//   - 限流：5 次 / 15 分钟 / IP（与 register 同规格独立桶）；
//   - 开关：与认领机制共用 feature_claim（env FEATURE_CLAIM 或 Config）。
// 红线：申请阶段不创建/不修改任何 Player 行，榜单数据零触碰。
// ============================================================

const claimAttempts = new Map<string, { count: number; lastAttempt: number }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function isClaimEnabled(): Promise<boolean> {
  if (process.env.FEATURE_CLAIM === 'on') return true;
  try {
    const row = await db.config.findUnique({ where: { key: 'feature_claim' } });
    return row?.value === 'on';
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await isClaimEnabled())) {
      return NextResponse.json({ error: '认领功能未开启，请联系管理员' }, { status: 403 });
    }

    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = claimAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请稍后再试' }, { status: 429 });
    }
    claimAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });

    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 100) : '';

    if (!email || !password || !name) {
      return NextResponse.json({ error: '邮箱、密码、游戏ID 均为必填' }, { status: 400 });
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密码至少 6 位' }, { status: 400 });
    }

    // 目标条目：必须存在且仍无凭据（管理员代录；匿名或占位邮箱均可认领）
    // 准确度修复（批示 2026-11-12 trace 1a1d027ae7f6abd1）：目标重查改用
    // 两级匹配（防御性归一兑底）；已绑定判据改 passwordHash —— 带「占位
    // 邮箱（虚拟邮箱）」的代录条目不再被误判为已绑定，审批通过时占位
    // 邮箱将被替换为玩家正式邮箱（对应用户批示「替换其虚拟邮箱」）。
    const target = await findPlayerByGameName(name);
    if (!target) {
      return NextResponse.json({ error: '榜单中没有该游戏ID的条目，可直接注册' }, { status: 404 });
    }
    if (target.passwordHash) {
      return NextResponse.json({ error: '该条目已绑定账号，请直接登录' }, { status: 409 });
    }

    // 邮箱占用校验（批示 trace 1a1d04505a0fd5e9「不管什么邮箱都可以认领」）：
    // 仅当邮箱被「真账号」（有 passwordHash）持有时静默拦截（防枚举口径不变，
    // 该玩家本就有登录路径可走 ClaimModal）；邮箱撞「占位条目」（无凭据代录，
    // 含目标条目自身的占位邮箱）一律放行 —— 管理员审批是最终人工闸门。
    const emailTaken = await db.player.findFirst({ where: { email } });
    if (emailTaken && emailTaken.passwordHash) {
      return NextResponse.json(
        {
          success: false,
          neutral: true,
          error: '注册请求已处理：该邮箱可能已注册，请直接使用邮箱与密码登录；若忘记密码，请联系管理员申请重置。',
        },
        { status: 200 },
      );
    }

    // 防重复：同目标 pending 唯一
    const dupTarget = await db.operationLog.findFirst({
      where: { type: 'CLAIM', playerId: target.id, status: 'pending' },
    });
    if (dupTarget) {
      return NextResponse.json({ error: '该条目已有待审批的认领请求，请耐心等待管理员处理' }, { status: 409 });
    }
    // 防重复：同邮箱 pending 唯一（存于 pendingCredentials.claimEmail）
    const dupEmail = await db.operationLog.findFirst({
      where: { type: 'CLAIM', status: 'pending', beforeData: { contains: `"claimEmail":"${email}"` } },
    });
    if (dupEmail) {
      return NextResponse.json({ error: '该邮箱已有一条待审批的认领申请' }, { status: 409 });
    }

    // 只存哈希，明文密码绝不入库/入日志
    const claimPasswordHash = hashPassword(password);

    const claim = await db.operationLog.create({
      data: {
        type: 'CLAIM',
        detail: `claim-register · ${target.name}`,
        actorId: null, // 注册直达：无壳账号，凭据在 pendingCredentials
        playerId: target.id,
        status: 'pending',
        beforeData: JSON.stringify({
          channel: 'register-direct',
          claimEmail: email,
          claimPasswordHash,
          claimerNote: note || null,
          targetName: target.name,
        }),
        ip,
      },
    });

    return NextResponse.json({ ok: true, claimId: claim.id });
  } catch (error) {
    console.error('[register-claim] 提交失败:', error);
    return NextResponse.json({ error: '提交认领申请失败' }, { status: 500 });
  }
}
