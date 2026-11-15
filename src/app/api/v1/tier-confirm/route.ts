// ============================================================
// 玩家成长记录确认 API（TIER_RECORD_RECOGNITION_REBUILD_V1 §3.7）
// ------------------------------------------------------------
// GET  /api/v1/tier-confirm
//   鉴权：getCurrentPlayer()（玩家登录态）
//   返回：当前玩家名下的 Tier 测试记录（待确认 / 已确认 / 有异议）
//
// POST /api/v1/tier-confirm
//   鉴权：getCurrentPlayer()
//   入参：{ recordId, action: 'confirm' | 'dispute', reason? }
//   硬约束：
//     - 仅本人：服务端强校验 record.matchedPlayerId === player.id
//       （匹配在归档审批时由管理员依据 F 列被测玩家落定，玩家无法自选记录）；
//     - 仅 ARCHIVED 且 PLAYER_PENDING 态可操作（幂等：已确认拒绝二次确认；
//       已异议的记录等管理员处理，玩家不能反复改判）；
//     - 异议原因必填（服务端校验非空）；
//     - 记录永不因超时自动删除（本端点无任何删除路径）；
//     - confirm → CONFIRMED（记录确认时间，进入正式成长记录序列）；
//       dispute → DISPUTED（异议队列，等管理员处理）；
//     - 每次操作落 OperationLog（type=TIER_CONFIRM / TIER_DISPUTE，审计留痕）；
//     - 确认/异议不改动 Player.tiers / Player.stats（档案写入仅在管理员
//       审批时发生；本端点是确认环节，不是写榜环节）。
// ============================================================

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentPlayer } from '@/lib/player-auth';

export const dynamic = 'force-dynamic';

// ---------- GET：我的确认列表 ----------

export async function GET() {
  const player = await getCurrentPlayer();
  if (!player) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: '未登录 — 请先登录玩家账号' }, { status: 401 });
  }

  const records = await db.tierTicketRecord.findMany({
    where: { matchedPlayerId: player.id, processState: 'ARCHIVED', confirmState: { in: ['PLAYER_PENDING', 'CONFIRMED', 'DISPUTED'] } },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({
    ok: true,
    records: records.map(r => ({
      id: r.id,
      // 业务字段（原始 + 标准化；双方胜场独立展示，绝不混淆/相加）
      project: r.projectRaw,
      testDate: r.testDateIso ? r.testDateIso.slice(0, 10) : r.testDateRaw,
      examinerId: r.examinerId,
      testeeId: r.testeeId,
      testTier: r.testTierNorm ?? r.testTierRaw,
      testerWins: r.testerWins,     // 被测玩家（本人）胜场；null = 未填
      assessorWins: r.assessorWins, // 考核员胜场；null = 未填
      review: r.reviewNorm || r.reviewRaw,
      // 击杀/死亡：文档未提供（显式缺失，绝不补 0）
      killsDeaths: { available: false, note: '文档未提供' },
      // 来源（任务书：确认页显示来源 = Tier 测试工单 + 行号）
      source: { kind: 'tier_test_ticket' as const, docTab: r.tabId, sourceRow: r.sourceRow, submittedAt: r.submittedAtRaw },
      confirmState: r.confirmState,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      disputedAt: r.disputedAt?.toISOString() ?? null,
    })),
  });
}

// ---------- POST：确认 / 异议 ----------

interface ConfirmBody {
  recordId?: string;
  action?: 'confirm' | 'dispute';
  reason?: string;
}

export async function POST(request: Request) {
  const player = await getCurrentPlayer();
  if (!player) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: '未登录 — 请先登录玩家账号' }, { status: 401 });
  }

  let body: ConfirmBody | null = null;
  try {
    body = (await request.json()) as ConfirmBody | null;
  } catch {
    body = null;
  }
  const recordId = typeof body?.recordId === 'string' ? body.recordId : '';
  const action = body?.action;
  if (!recordId || (action !== 'confirm' && action !== 'dispute')) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: '请求参数不合法（缺 recordId 或 action）' }, { status: 400 });
  }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (action === 'dispute' && !reason) {
    return NextResponse.json({ ok: false, code: 'REASON_REQUIRED', message: '提出异议必须填写原因' }, { status: 400 });
  }

  // 仅本人：matchedPlayerId 必须等于当前登录玩家（服务端强校验）
  const record = await db.tierTicketRecord.findUnique({ where: { id: recordId } });
  if (!record || record.matchedPlayerId !== player.id) {
    return NextResponse.json({ ok: false, code: 'FORBIDDEN', message: '该记录不属于当前登录玩家（仅本人可确认）' }, { status: 403 });
  }
  if (record.processState !== 'ARCHIVED' || record.confirmState !== 'PLAYER_PENDING') {
    const why = record.confirmState === 'CONFIRMED'
      ? '该记录已确认过（幂等拦截，严禁重复确认）'
      : record.confirmState === 'DISPUTED'
        ? '该记录已进入异议队列，等待管理员处理'
        : '该记录当前不在待确认状态';
    return NextResponse.json({ ok: false, code: 'NOT_PENDING', message: why }, { status: 409 });
  }

  const now = new Date();
  if (action === 'confirm') {
    await db.$transaction(async tx => {
      await tx.tierTicketRecord.update({
        where: { id: record.id },
        data: { confirmState: 'CONFIRMED', confirmedAt: now },
      });
      await tx.operationLog.create({
        data: {
          type: 'TIER_CONFIRM',
          detail: `玩家确认成长记录 · ${player.name} · 台账记录 ${record.id.slice(0, 8)} · 来源行 ${record.sourceRow} · ${record.projectRaw} ${record.testTierNorm ?? record.testTierRaw}`,
          adminKey: null,
          sessionId: player.id,
          ip: request.headers.get('x-forwarded-for') || 'unknown',
        },
      });
    });
    return NextResponse.json({
      ok: true,
      action,
      confirmState: 'CONFIRMED',
      message: '已确认：该记录已进入你的正式成长记录序列',
    });
  }

  // dispute
  await db.$transaction(async tx => {
    await tx.tierTicketRecord.update({
      where: { id: record.id },
      data: { confirmState: 'DISPUTED', disputedAt: now, disputeReason: reason },
    });
    await tx.operationLog.create({
      data: {
        type: 'TIER_DISPUTE',
        detail: `玩家对成长记录提出异议 · ${player.name} · 台账记录 ${record.id.slice(0, 8)} · 来源行 ${record.sourceRow} · ${record.projectRaw} ${record.testTierNorm ?? record.testTierRaw} · 原因：${reason}`,
        adminKey: null,
        sessionId: player.id,
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      },
    });
  });
  return NextResponse.json({
    ok: true,
    action,
    confirmState: 'DISPUTED',
    message: '异议已提交：记录进入待核对队列，等待管理员处理（记录不会被删除）',
  });
}
