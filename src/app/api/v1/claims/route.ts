import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentPlayer } from '@/lib/player-auth';
import { getCurrentAdmin } from '@/lib/auth';

// ============================================================
// 认领机制（claim-mechanism）— /api/v1/claims
// 适配本项目「Player 即账号」模型（无独立 User 表）：
//   · 发起者 = 已登录 Player 条目（有 email/passwordHash）
//   · 目标   = 无凭据条目（passwordHash === null，管理员手工代录、
//     无人认领；匿名或带占位邮箱均可，占位邮箱在审批通过时替换）
//   · 审批通过 = 凭据转移到目标条目（claimer 壳条目转回匿名），
//     效果等价于 User→Player 绑定：一人一条、重登后身份跟随
// 开关：env FEATURE_CLAIM=on 或 Config key feature_claim=on（默认 OFF）
// 红线：认领不改任何分数/段位/感动榜数据，只做身份绑定
// 准确度修复（批示 trace 1a1d027ae7f6abd1）：可认领判据 email===null
// → passwordHash===null，带「占位邮箱」的代录条目不再被误判为已认领。
// ============================================================

/** 功能开关：env FEATURE_CLAIM 或 Config 表 feature_claim，任一为 "on" 即开启 */
async function isClaimEnabled(): Promise<boolean> {
  if (process.env.FEATURE_CLAIM === 'on') return true;
  try {
    const row = await db.config.findUnique({ where: { key: 'feature_claim' } });
    return row?.value === 'on';
  } catch {
    return false;
  }
}

// P2-10（审计 2026-11-13）：POST 提交补 IP 限流（5 次/15min，与 register-claim
// 同规格独立桶）——原实现仅有 pending 去重，登录用户可循环提交/拒绝制造
// 无界 CLAIM 行。申请阶段仍零 Player 行写入（红线不变）。
const claimPostAttempts = new Map<string, { count: number; lastAttempt: number }>();

// ------------------------------------------------------------
// POST — 提交认领请求（需登录）
// 边界：401 未登录 / 403 开关 OFF / 404 条目不存在 /
//       409 已被认领 / 409 目标已有 pending / 409 本人已有 pending
// ------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    if (!(await isClaimEnabled())) {
      return NextResponse.json({ error: '认领功能未开启' }, { status: 403 });
    }
    const me = await getCurrentPlayer();
    if (!me) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    // P2-10：IP 限流（在身份判定后、业务写入前收口）
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = claimPostAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429 });
    }
    claimPostAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });

    const body = await req.json().catch(() => null);
    const playerId = body?.playerId;
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: '缺少 playerId' }, { status: 400 });
    }

    const target = await db.player.findUnique({ where: { id: playerId } });
    if (!target) {
      return NextResponse.json({ error: '该条目不存在' }, { status: 404 });
    }
    // 无凭据即可认领（管理员代录条目，含占位邮箱形态）；有凭据 = 真账号
    if (target.passwordHash) {
      return NextResponse.json({ error: '该条目已被认领' }, { status: 409 });
    }

    const dupTarget = await db.operationLog.findFirst({
      where: { type: 'CLAIM', playerId, status: 'pending' },
    });
    if (dupTarget) {
      return NextResponse.json({ error: '该条目已有待审批的认领请求' }, { status: 409 });
    }
    const dupSelf = await db.operationLog.findFirst({
      where: { type: 'CLAIM', actorId: me.id, status: 'pending' },
    });
    if (dupSelf) {
      return NextResponse.json({ error: '你已有一条待审批的认领请求' }, { status: 409 });
    }

    const claim = await db.operationLog.create({
      data: {
        type: 'CLAIM',
        detail: `claim · ${me.name} → ${target.name}`,
        actorId: me.id,
        playerId: target.id,
        status: 'pending',
        // 提交时快照：认领者邮箱供管理员线下核实身份
        beforeData: JSON.stringify({ claimerName: me.name, claimerEmail: me.email, targetName: target.name }),
        ip,
      },
    });

    return NextResponse.json({ ok: true, claimId: claim.id });
  } catch (error) {
    console.error('[claims] POST 提交失败:', error);
    return NextResponse.json({ error: '提交认领请求失败' }, { status: 500 });
  }
}

// ------------------------------------------------------------
// GET — 认领请求列表
//   管理员：全部（?status=pending|approved|rejected 过滤），含认领者邮箱
//   普通用户：自己的（actorId 或 playerId 命中）+ 可认领条目列表
//   未登录：401
// ------------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    if (!(await isClaimEnabled())) {
      return NextResponse.json({ error: '认领功能未开启' }, { status: 403 });
    }
    const admin = await getCurrentAdmin();
    const player = admin ? null : await getCurrentPlayer();
    if (!admin && !player) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const statusFilter = req.nextUrl.searchParams.get('status');
    const where = admin
      ? { type: 'CLAIM', ...(statusFilter ? { status: statusFilter } : {}) }
      : { type: 'CLAIM', OR: [{ actorId: player!.id }, { playerId: player!.id }] };

    const logs = await db.operationLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // 补齐双方名字（OperationLog 只存 id；条目可能已被管理员删除 → 显示占位）
    const ids = [...new Set(logs.flatMap((l) => [l.actorId, l.playerId].filter((v): v is string => !!v)))];
    const related = ids.length
      ? await db.player.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(related.map((p) => [p.id, p]));

    const claims = logs.map((l) => {
      const actor = l.actorId ? byId.get(l.actorId) : undefined;
      const target = l.playerId ? byId.get(l.playerId) : undefined;
      // register-direct（工单 2026-11-12）：无壳账号的直达认领，申请信息
      // 在 beforeData 快照；邮箱/备注仅管理员可见（核实身份用）
      let direct: { claimEmail?: string; claimerNote?: string | null } | null = null;
      if (!l.actorId) {
        try { direct = JSON.parse(l.beforeData || '{}'); } catch { direct = {}; }
      }
      return {
        id: l.id,
        status: l.status,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        detail: l.detail,
        actorId: l.actorId,
        actorName: actor?.name ?? (direct ? '注册直达认领' : '（条目已删除）'),
        // 认领者邮箱仅管理员可见（核实身份用），普通用户不下发
        actorEmail: admin ? (actor?.email ?? direct?.claimEmail ?? null) : undefined,
        claimerNote: admin ? (direct?.claimerNote ?? null) : undefined,
        targetId: l.playerId,
        targetName: target?.name ?? '（条目已删除）',
        // 目标条目当前邮箱仅管理员可见：展示将被替换的占位邮箱（匿名代录为 null）
        targetEmail: admin ? (target?.email ?? null) : undefined,
      };
    });

    // 普通用户附「可认领条目」列表（无凭据条目 = passwordHash 为 null；
    // 含匿名与占位邮箱两种代录形态，同批准确度修复）
    let claimable: { id: string; name: string }[] | undefined;
    if (player) {
      const anon = await db.player.findMany({
        where: { passwordHash: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      });
      claimable = anon;
    }

    return NextResponse.json({ enabled: true, claims, claimable: claimable ?? null });
  } catch (error) {
    console.error('[claims] GET 列表失败:', error);
    return NextResponse.json({ error: '获取认领列表失败' }, { status: 500 });
  }
}
