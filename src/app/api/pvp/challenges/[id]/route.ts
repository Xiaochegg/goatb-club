import { db } from '@/lib/db';
import { getCurrentPlayer } from '@/lib/player-auth';
import { NextRequest, NextResponse } from 'next/server';
import { PVP_LIMITS, canTransition, type PvpStatus } from '@/lib/pvp';
import { serializeRow } from '@/lib/pvp-server';

// ============================================================
// /api/pvp/challenges/[id] —— 单张工单（登录态、仅参与双方可见/可操作）
//   GET  详情（结果恢复 / 状态查询）
//   POST 回应 { action: 'accept' | 'reject' | 'cancel' }
//     accept  : 仅对手，pending，且预约时间仍在未来
//     reject  : 仅对手，pending
//     cancel  : 仅发起方，pending
//   状态机单向（canTransition）；绝不触碰 Player.stats。
// ============================================================

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentPlayer();
    if (!me) return NextResponse.json({ error: '请先登录玩家账号', code: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;

    const row = await db.pvpChallenge.findUnique({ where: { id } });
    if (!row || (row.challengerId !== me.id && row.opponentId !== me.id)) {
      return NextResponse.json({ error: '工单不存在或无权查看' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, challenge: serializeRow(row, me.id) });
  } catch {
    return NextResponse.json({ error: '加载失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentPlayer();
    if (!me) return NextResponse.json({ error: '请先登录玩家账号', code: 'UNAUTHORIZED' }, { status: 401 });
    const { id } = await params;

    const body = await req.json().catch(() => null);
    const action = (body as { action?: unknown } | null)?.action;
    if (action !== 'accept' && action !== 'reject' && action !== 'cancel') {
      return NextResponse.json({ error: 'action 无效' }, { status: 400 });
    }

    const row = await db.pvpChallenge.findUnique({ where: { id } });
    if (!row) return NextResponse.json({ error: '工单不存在' }, { status: 404 });

    const from = row.status as PvpStatus;
    const to = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled';

    // 权限：accept/reject 仅对手；cancel 仅发起方
    if (action === 'cancel') {
      if (row.challengerId !== me.id) {
        return NextResponse.json({ error: '只有发起方可以取消' }, { status: 403 });
      }
    } else {
      if (row.opponentId !== me.id) {
        return NextResponse.json({ error: '只有被约战的玩家可以接受或拒绝' }, { status: 403 });
      }
    }

    // 状态机：单向、仅 pending 可操作
    if (!canTransition(from, to)) {
      return NextResponse.json({ error: `当前状态（${row.status}）不允许该操作`, code: 'BAD_STATE' }, { status: 409 });
    }

    // accept 额外校验：预约时间必须仍在未来（过期宽限内判 expired）
    if (action === 'accept') {
      const deadline = row.scheduledAt.getTime() + PVP_LIMITS.EXPIRE_GRACE_MINUTES * 60_000;
      if (Date.now() > deadline) {
        await db.pvpChallenge.update({
          where: { id: row.id },
          data: { status: 'expired', closedAt: new Date() },
        });
        return NextResponse.json({ error: '预约时间已过，工单已自动过期', code: 'EXPIRED' }, { status: 409 });
      }
      if (row.scheduledAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: '预约时间已到，无法再接受；请让对方重新发起' }, { status: 409 });
      }
    }

    const updated = await db.pvpChallenge.update({
      where: { id: row.id },
      data: {
        status: to,
        respondAt: action === 'accept' || action === 'reject' ? new Date() : row.respondAt,
        closedAt: to === 'accepted' ? null : new Date(),
      },
    });

    return NextResponse.json({ ok: true, challenge: serializeRow(updated, me.id) });
  } catch {
    return NextResponse.json({ error: '操作失败' }, { status: 500 });
  }
}
