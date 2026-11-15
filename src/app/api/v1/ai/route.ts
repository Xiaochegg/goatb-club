import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// R3-T3 下架（批复 2026-11-08）：AI 聊天助手已下架（前端入口全部移除）。
// 本使能开关同时拦截直接 API 调用；恢复上架 = 翻回 true + 还原前端三处入口
// （Dock 按钮 / 命令面板 open-ai / page.tsx 渲染行），下方原始逻辑零改动留档。
// ============================================================
const AI_ASSISTANT_ENABLED = false;

// POST /api/v1/ai - AI chat using z-ai-web-dev-sdk LLM (rate-limited)
// Rate limit: 10 requests per 60 seconds per IP
const aiRequestTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = aiRequestTimestamps.get(ip) || [];
  const recent = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  aiRequestTimestamps.set(ip, recent);
  return true;
}

export async function POST(req: NextRequest) {
  // R3-T3 下架闸门：功能已下架，返回明确的服务退役响应（绝不静默 404）
  if (!AI_ASSISTANT_ENABLED) {
    return NextResponse.json(
      { error: 'AI 助手已下架（管理员批复 2026-11-08）', code: 'SERVICE_RETIRED' },
      { status: 503 },
    );
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' },
      { status: 429 }
    );
  }

  try {
    const body = await req.json();
    const { messages, systemPrompt } = body;

    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const sdk = await ZAI.create();

    const defaultSystem = `你是GOATB社区排榜的AI助手。你了解以下信息：
- GOATB是一个Minecraft游戏社区
- 排行榜有普通模式11个：盾斧(SHIELD)、水晶(CRYSTAL)、剑斗(SWORD)、钻石药水(DIAMOND_POTION)、合金药水(ALLOY_POTION)、重锤(MACE)、BUHC、SMP、DSMP、矛锤(SPEAR_MACE)、矿车(MINECART)；娱乐模式2个：嘉豪(JIAHAO)、小鸟(BIRD)
- 普通模式段位：HT1(40分) > LT1(35) > HT2(25) > LT2(20) > HT3(15) > LT3(10) > HT4(7) > LT4(5) > HT5(3) > LT5(1)
- 娱乐模式（嘉豪/小鸟）共用嘉豪积分段位：LZ1/LL1(4550) > LZ2/LL2(3650) > LZ3/LL3(2750) > LZ4/LL4(1850) > LZ5/LL5(950)
- 总榜是11个普通模式段位分之和；嘉豪/小鸟为娱乐模式，不计入总榜
- 小鸟模式规则：小鸟闯关达成全三星（★★★）才能上榜，积分沿用嘉豪积分
- 感动榜是单独的非积分排行榜
请用简洁友好的中文回答问题。`;

    const allMessages = [
      { role: 'system' as const, content: systemPrompt || defaultSystem },
      ...(messages || []),
    ];

    const result = await sdk.chat.completions.create({
      messages: allMessages,
      stream: false,
      thinking: { type: 'disabled' },
    });

    // Extract text content from the OpenAI-compatible response
    let content = '';
    if (result?.choices?.[0]?.message?.content) {
      content = result.choices[0].message.content;
    } else if (typeof result === 'string') {
      content = result;
    } else if (result?.content) {
      content = result.content;
    } else {
      content = JSON.stringify(result);
    }

    return new Response(content, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'AI service error';
    console.error('[AI Route Error]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
