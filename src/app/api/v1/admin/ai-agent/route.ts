import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdmin } from '@/lib/auth';

// ============================================================
// POST /api/v1/admin/ai-agent
// ============================================================
// Proxy route that forwards admin AI assistant requests to the
// mini-service on port 3004. This exists because:
//   1. The browser may access the site directly via :3000 (dev)
//      or via the :81 gateway — the XTransformPort query trick
//      only works through the gateway.
//   2. This route works in BOTH cases by doing a server-side
//      fetch to localhost:3004 (no gateway needed).
//
// Auth: verified here via getCurrentAdmin() (same as all admin
// routes). The mini-service also verifies independently, but
// this gate prevents unauthenticated users from even reaching
// the service.
//
// Body: { task: string }
// Returns: { ok, admin, answer, trace, iterations } from agent
// ============================================================

const AGENT_URL = 'http://localhost:3004/chat';

// ============================================================
// R3-T3 下架（批复 2026-11-08）：管理后台「AI 助手」已下架（页签已移除）。
// 本使能开关同时拦截直接 API 调用；恢复上架 = 翻回 true + 回填页签/渲染行，
// 下方代理逻辑零改动留档（mini-service 端口 3004 现状：未随仓库存在）。
// ============================================================
const ADMIN_AI_AGENT_ENABLED = false;

export async function POST(req: NextRequest) {
  // R3-T3 下架闸门：功能已下架，返回明确的服务退役响应（绝不静默 404）
  if (!ADMIN_AI_AGENT_ENABLED) {
    return NextResponse.json(
      { error: 'AI 助手已下架（管理员批复 2026-11-08）', code: 'SERVICE_RETIRED' },
      { status: 503 },
    );
  }

  // 1. Verify admin
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: '未登录管理员账号或会话已过期' }, { status: 401 });
  }

  // 2. Parse task
  let body: { task?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  const task = (body.task || body.message || '').trim();
  if (!task) {
    return NextResponse.json({ error: '缺少 task 字段' }, { status: 400 });
  }

  // 3. Forward to mini-service (server-to-server, no gateway needed)
  //    Pass the admin cookie through so the agent service can
  //    independently verify admin identity (defense in depth).
  try {
    const cookieHeader = req.headers.get('cookie') || '';
    const agentRes = await fetch(AGENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ task }),
    });

    if (!agentRes.ok) {
      const errText = await agentRes.text().catch(() => '');
      return NextResponse.json(
        { error: `AI 助手服务返回 ${agentRes.status}: ${errText.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const data = await agentRes.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json(
      { error: `AI 助手服务不可用（端口 3004 未启动?）: ${msg}` },
      { status: 502 }
    );
  }
}

// GET — health probe (returns agent service status)
export async function GET() {
  // R3-T3 下架闸门（与 POST 同语义）
  if (!ADMIN_AI_AGENT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'AI 助手已下架（管理员批复 2026-11-08）', code: 'SERVICE_RETIRED' },
      { status: 503 },
    );
  }

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }
  try {
    const res = await fetch('http://localhost:3004/');
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, agent: data });
    }
    return NextResponse.json({ ok: false, error: `HTTP ${res.status}` }, { status: 502 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : '服务不可用' },
      { status: 502 }
    );
  }
}
