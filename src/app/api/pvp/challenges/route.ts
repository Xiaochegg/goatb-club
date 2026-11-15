import { db } from '@/lib/db';
import { getCurrentPlayer } from '@/lib/player-auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  PVP_LIMITS,
  isChallengeableMode,
  normalizeNotes,
  validateRequestId,
  validateScheduledAt,
  validateTz,
} from '@/lib/pvp';
import { serializeRows, serializeRow, sweepExpiredChallenges } from '@/lib/pvp-server';

// ============================================================
// /api/pvp/challenges —— 玩家约战（登录态）
//   POST 创建（requestId 幂等；服务端全量校验；限流；绝不写 Player.stats）
//   GET  我的约战（box=incoming|outgoing；?request_id= 结果未知恢复查询）
// ============================================================

// 发起冷却（内存级，惯例同 auth/login 限流；单进程内有效）
const createCooldown = new Map<string, number>();

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return 'unknown';
  return xff.split(',')[0].trim() || 'unknown';
}

// ---------- POST：创建约战 ----------

export async function POST(req: NextRequest) {
  try {
    const me = await getCurrentPlayer();
    if (!me) {
      return NextResponse.json({ error: '请先登录玩家账号后再发起约战', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '请求格式无效' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    // 1) 幂等键
    const ridErr = validateRequestId(b.requestId);
    if (ridErr) return NextResponse.json({ error: ridErr }, { status: 400 });
    const requestId = (b.requestId as string).trim();

    // 2) 幂等优先：同一 requestId 已存在 → 返回原工单（绝不产生第二张）
    const existing = await db.pvpChallenge.findUnique({ where: { requestId } });
    if (existing) {
      if (existing.challengerId !== me.id) {
        return NextResponse.json({ error: 'requestId 冲突（已被其他请求占用）' }, { status: 409 });
      }
      const view = await serializeRow(existing, me.id);
      return NextResponse.json({ ok: true, challenge: view, deduplicated: true });
    }

    // 3) 对手：存在 + 已注册 + 不是自己
    const opponentId = typeof b.opponentId === 'string' ? b.opponentId.trim() : '';
    if (!opponentId) return NextResponse.json({ error: '请选择对手' }, { status: 400 });
    if (opponentId === me.id) {
      return NextResponse.json({ error: '不能对自己发起约战' }, { status: 400 });
    }
    const opponent = await db.player.findUnique({ where: { id: opponentId } });
    if (!opponent || !opponent.email || !opponent.passwordHash) {
      return NextResponse.json({ error: '对手不存在或未注册（无法回应约战）' }, { status: 400 });
    }

    // 4) 模式：词表校验（单一来源 constants.ALL_MODES）
    if (!isChallengeableMode(b.modeId)) {
      return NextResponse.json({ error: '比赛模式无效' }, { status: 400 });
    }

    // 5) 时间：服务端重新校验（拒绝过去 / 超远期）
    const sched = validateScheduledAt(b.scheduledAt);
    if (sched.error || !sched.value) {
      return NextResponse.json({ error: sched.error ?? '预约时间无效' }, { status: 400 });
    }
    const tz = validateTz(b.timezone, b.tzOffsetMinutes);

    // 6) 备注
    const note = normalizeNotes(b.notes);
    if (note.error) return NextResponse.json({ error: note.error }, { status: 400 });

    // 7) 限流：冷却 + 未终结上限 + 同对手同模式重复 pending
    const now = Date.now();
    const last = createCooldown.get(me.id) ?? 0;
    if (now - last < PVP_LIMITS.CREATE_COOLDOWN_MS) {
      return NextResponse.json(
        { error: '发送太频繁，请稍后再发起', code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
    const openCount = await db.pvpChallenge.count({
      where: { challengerId: me.id, status: { in: ['pending', 'accepted'] } },
    });
    if (openCount >= PVP_LIMITS.MAX_OPEN_OUTGOING) {
      return NextResponse.json(
        { error: `您已有 ${openCount} 场未完成的约战（上限 ${PVP_LIMITS.MAX_OPEN_OUTGOING}），请先处理后再发起` },
        { status: 429 },
      );
    }
    const dup = await db.pvpChallenge.findFirst({
      where: { challengerId: me.id, opponentId, modeId: b.modeId, status: 'pending' },
      select: { id: true },
    });
    if (dup) {
      return NextResponse.json(
        { error: '已有一张同对手同模式的等待回应工单，请勿重复发起', code: 'DUPLICATE' },
        { status: 409 },
      );
    }

    // 8) 创建（pending；来源 IP 留痕）
    const row = await db.pvpChallenge.create({
      data: {
        requestId,
        challengerId: me.id,
        opponentId,
        modeId: b.modeId,
        scheduledAt: sched.value,
        timezone: tz.timezone,
        tzOffsetMinutes: tz.tzOffsetMinutes,
        notes: note.value,
        status: 'pending',
        ip: getClientIp(req),
      },
    });
    createCooldown.set(me.id, now);

    const view = await serializeRow(row, me.id);
    return NextResponse.json({ ok: true, challenge: view });
  } catch {
    return NextResponse.json({ error: '创建约战失败' }, { status: 500 });
  }
}

// ---------- GET：我的约战 / requestId 恢复查询 ----------

export async function GET(req: NextRequest) {
  try {
    const me = await getCurrentPlayer();
    if (!me) {
      return NextResponse.json({ error: '请先登录玩家账号', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    await sweepExpiredChallenges();

    const url = new URL(req.url);

    // 结果未知恢复：按 requestId 查询（不创建新工单）
    const rid = url.searchParams.get('request_id');
    if (rid) {
      const row = await db.pvpChallenge.findUnique({ where: { requestId: rid.trim() } });
      if (!row || row.challengerId !== me.id) {
        return NextResponse.json({ error: '未找到该请求', code: 'NOT_FOUND' }, { status: 404 });
      }
      const view = await serializeRow(row, me.id);
      return NextResponse.json({ ok: true, challenge: view });
    }

    const box = url.searchParams.get('box') ?? 'all';
    const where = {
      OR: [{ challengerId: me.id }, { opponentId: me.id }],
      ...(box === 'incoming' ? { opponentId: me.id } : {}),
      ...(box === 'outgoing' ? { challengerId: me.id } : {}),
    };

    const [rows, incomingPending] = await Promise.all([
      db.pvpChallenge.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      db.pvpChallenge.count({ where: { opponentId: me.id, status: 'pending' } }),
    ]);

    const challenges = await serializeRows(rows, me.id);
    return NextResponse.json(
      { ok: true, challenges, incomingPending },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: '约战列表加载失败' }, { status: 500 });
  }
}
