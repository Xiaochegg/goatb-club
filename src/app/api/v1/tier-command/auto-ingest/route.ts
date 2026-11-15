// ============================================================
// Tier Command · 收集表自动同步开关/状态 API（AUTO-INGEST CONTROL）
// ------------------------------------------------------------
// GET  /api/v1/tier-command/auto-ingest
//   鉴权：requireRole('OWNER','ADMIN')
//   返回：AutoIngestStatus（开关/间隔/定时器状态/下次运行/最近一次运行结果）
//
// POST /api/v1/tier-command/auto-ingest
//   鉴权：requireRole('OWNER','ADMIN')
//   入参：{ enabled?: boolean, intervalMin?: 5|10|30|60 }
//   行为：持久化 Config（重启后自动恢复）→ 重排定时器 →
//         开启时立即拉一轮（复用 ingestCollectSheet 幂等管线）
//   纪律：仅写台账（TierTicketRecord/TierSyncBatch），绝不触碰 Player 表；
//         失败如实返回（绝不假报成功）。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { TencentDocError } from '@/lib/tier-command/tencent-doc-client';
import {
  getAutoIngestStatus,
  setAutoIngestConfig,
  ALLOWED_INTERVALS,
} from '@/lib/tier-command/auto-ingest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;
  try {
    const status = await getAutoIngestStatus();
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  let body: { enabled?: boolean; intervalMin?: number } | null = null;
  try {
    body = (await request.json()) as { enabled?: boolean; intervalMin?: number } | null;
  } catch {
    body = null;
  }
  if (!body || (body.enabled === undefined && body.intervalMin === undefined)) {
    return NextResponse.json(
      { ok: false, message: `入参不合法：需要 enabled 和/或 intervalMin（可选 ${ALLOWED_INTERVALS.join('/')}）` },
      { status: 400 },
    );
  }

  try {
    const { run } = await setAutoIngestConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      intervalMin: typeof body.intervalMin === 'number' ? body.intervalMin : undefined,
    });
    const status = await getAutoIngestStatus();
    return NextResponse.json({
      ok: true,
      status,
      run,
      message: run
        ? (run.ok
          ? `自动同步已${status.enabled ? '开启' : '更新'}并完成即时拉取：新建 ${run.newRecords ?? 0} · 合并重复 ${run.mergedDupes ?? 0} · 幂等命中 ${run.idempotentHits ?? 0}`
          : `自动同步已开启，但本次即时拉取失败：[${run.code}] ${run.message ?? ''}（已留痕，定时器会按间隔自动重试）`)
        : `设置已保存（${status.enabled ? `每 ${status.intervalMin} 分钟自动拉取` : '自动同步已停止'}）`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isDocError = err instanceof TencentDocError;
    return NextResponse.json(
      { ok: false, message, code: isDocError ? err.code : undefined },
      { status: isDocError ? 502 : 400 },
    );
  }
}
