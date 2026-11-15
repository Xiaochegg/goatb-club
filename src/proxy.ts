// ============================================================
// W4 · Next.js Proxy — API 网关（轻量版，4GB 环境适配）
// ============================================================
// Next.js 16 proxy 约定
// 只匹配 /api/v1/rate-limit-probe（限流取证端点）
//
// 设计说明：
// 原版三态网关在每个 API 请求查 Prisma（Config.public_api），
// 4GB 环境下连续请求导致 Prisma 连接异常 + 进程崩溃。
// 改为：proxy 只拦截限流探针（不查 DB 的内存限流），
// 三态网关逻辑保留在 api-gate.ts 供 W4 管理后台 API 调用，
// 不在 proxy 层对每个请求执行。
//
// AI UA 黑名单 + 蜜罐 在 proxy 层执行（不查 DB，零开销）
// 三态开关 + Key 校验 + 限流 通过 /api/v1/admin/* 管理后台使用

import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const headers = req.headers;
  const ip = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // AI UA 黑名单（所有请求生效，不查 DB）
  const ua = headers.get('user-agent');
  const AI_UA = ['gptbot', 'chatgpt-user', 'claudebot', 'claude-web', 'ccbot',
    'google-extended', 'perplexitybot', 'bytespider', 'applebot-extended', 'anthropic-ai', 'cohere-ai'];
  if (ua && AI_UA.some(b => ua.toLowerCase().includes(b))) {
    return NextResponse.json({ error: 'Forbidden', code: 'AI_BOT_BLOCKED' }, { status: 403 });
  }

  // 蜜罐 _sig（不查 DB）
  const sig = headers.get('x-sig') || req.nextUrl.searchParams.get('_sig');
  if (sig) {
    return NextResponse.json({ error: 'Forbidden', code: 'CANARY_TRIGGERED' }, { status: 403 });
  }

  // 限流探针：内存限流（不查 DB，避免 Prisma 崩溃）
  if (pathname === '/api/v1/rate-limit-probe') {
    // 简单内存计数器
    const now = Date.now();
    const key = `probe-${ip}`;
    if (!globalThis.__probeCounter) globalThis.__probeCounter = new Map();
    const counter = globalThis.__probeCounter;
    const entry = counter.get(key);
    if (!entry || now - entry.ts > 60000) {
      counter.set(key, { count: 1, ts: now });
    } else {
      entry.count++;
      if (entry.count > 20) {
        return NextResponse.json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }, { status: 429 });
      }
    }
    return NextResponse.json({ ok: true, ip, ts: now });
  }

  // 其他请求全部放行（三态网关逻辑不在 proxy 层执行，避免 Prisma 崩溃）
  return NextResponse.next();
}
