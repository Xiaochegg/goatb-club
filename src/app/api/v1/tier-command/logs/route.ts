// ============================================================
// Tier Command · 审批历史日志 API（UI 收尾：总览日志只读接入）
// ------------------------------------------------------------
// GET /api/v1/tier-command/logs
//   鉴权：requireRole('OWNER','ADMIN')
//   只读：查询 OperationLog 中 detail 以「tier-command」开头的审计记录
//   （审批写榜 / 回档 / 拒绝 / 撤销拒绝四类），倒序取最近 30 条。
//   本接口绝不写入任何数据；行级字段解析失败时降级返回原文。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DETAIL_PREFIX = 'tier-command';
const LOG_LIMIT = 30;

// 审批写榜 detail 落库范式（见 approve/route.ts）：
// tier-command 工单审批 · 行{rowIndex} · 指纹 {fp12} · {playerName} · {mode} {old}→{new}[ · 由工单自动创建玩家] · 操作人 {operator}
const APPROVE_DETAIL_RE =
  /^tier-command 工单审批 · 行(\d+) · 指纹 ([0-9a-f]+) · (.+) · ([A-Z_]+) (\S+)→(\S+)(?: · 由工单自动创建玩家)? · 操作人 (.+)$/;

interface ParsedDetail {
  rowIndex: number;
  fingerprintShort: string;
  playerName: string;
  mode: string;
  tierFrom: string;
  tierTo: string;
  created: boolean;
}

function parseApproveDetail(detail: string): ParsedDetail | null {
  const m = APPROVE_DETAIL_RE.exec(detail);
  if (!m) return null;
  return {
    rowIndex: Number(m[1]),
    fingerprintShort: m[2],
    playerName: m[3],
    mode: m[4],
    tierFrom: m[5],
    tierTo: m[6],
    created: detail.includes('由工单自动创建玩家'),
  };
}

type LogKind = 'approve' | 'rollback' | 'reject' | 'restore';

function kindOf(detail: string): LogKind | null {
  if (detail.startsWith('tier-command 工单审批')) return 'approve';
  if (detail.startsWith('tier-command 回档')) return 'rollback';
  if (detail.startsWith('tier-command 拒绝')) return 'reject';
  if (detail.startsWith('tier-command 撤销拒绝')) return 'restore';
  return null;
}

export async function GET() {
  // a. 验权（OWNER / ADMIN）——与 sync / approve 同级
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  // b. 只读查询：工单模块全部审计日志（审批/回档/拒绝/撤销拒绝），最近 30 条
  const logs = await db.operationLog.findMany({
    where: { detail: { startsWith: DETAIL_PREFIX } },
    orderBy: { createdAt: 'desc' },
    take: LOG_LIMIT,
    select: { id: true, detail: true, adminKey: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    logs: logs.map(l => {
      const kind = kindOf(l.detail);
      const parsed = kind === 'approve' ? parseApproveDetail(l.detail) : null;
      return {
        id: l.id,
        at: l.createdAt.toISOString(),
        operator: l.adminKey ?? '未知',
        kind,
        rowIndex: parsed?.rowIndex ?? null,
        playerName: parsed?.playerName ?? null,
        mode: parsed?.mode ?? null,
        tierTo: parsed?.tierTo ?? null,
        created: parsed?.created ?? false,
        detail: l.detail, // 原文兜底：前端在解析字段缺失时降级展示
      };
    }),
  });
}
