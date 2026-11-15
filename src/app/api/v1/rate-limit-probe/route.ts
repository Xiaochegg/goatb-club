import { NextResponse } from 'next/server';
import { apiGate } from '@/lib/api-gate';

// ============================================================
// W4 · 限流探针端点（临时取证用，可保留为健康探针）
// ============================================================
// GET /api/v1/rate-limit-probe
// 在 apiGate 网关之后、任何 Prisma 查询之前直接返回 200。
// 用途：连续 curl 验证 HTTP 链路限流真实生效（不碰 DB，避免 OOM）。
// OPEN 模式下同 IP 第 21 次请求起返回 429。
// ============================================================

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // 复用 apiGate 网关逻辑（三态 + 限流 + AI 黑名单 + 蜜罐）
  const result = await apiGate(url.pathname, req.headers, ip);
  if (!result.allowed) {
    return NextResponse.json(result.body, { status: result.status });
  }

  // 网关放行后直接返回，不查 DB
  return NextResponse.json({
    ok: true,
    ip,
    timestamp: Date.now(),
    message: 'rate-limit-probe (no DB access)',
  });
}
