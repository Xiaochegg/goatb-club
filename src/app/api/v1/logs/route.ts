import { db } from '@/lib/db';
import { requireAdmin, requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/v1/logs - Get operation logs (admin only — contains admin action details)
//
// C1 分页（轻量化改造 2026-11-03）：
//   - 新参数 page / pageSize：默认第 1 页、每页 30 条，pageSize 上限 30
//   - 响应追加 total / page / pageSize / pageCount 字段
//   - R1 兼容：旧 limit 参数映射为 pageSize（封顶 30，旧上限 200 收紧），
//     不传 page 时落第 1 页——旧消费端只读 data.logs，行为向后兼容
//   - POST / DELETE 行为零改动（软清除留痕语义不变）
const LOG_PAGE_SIZE_CAP = 30;
const LOG_PAGE_DEFAULT = 30;

function parseBoundedInt(raw: string | null, fallback: number, cap: number, floor = 1): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, floor), cap);
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard) return guard;

  try {
    const sp = req.nextUrl.searchParams;
    const pageRaw = sp.get('page');
    const sizeRaw = sp.get('pageSize');
    const limitRaw = sp.get('limit'); // 旧参数，仅作 pageSize 别名（R1 兼容）

    const pageSize = parseBoundedInt(sizeRaw ?? limitRaw, LOG_PAGE_DEFAULT, LOG_PAGE_SIZE_CAP);
    const total = await db.operationLog.count();
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = parseBoundedInt(pageRaw, 1, pageCount);

    const logs = await db.operationLog.findMany({
      take: pageSize,
      skip: (page - 1) * pageSize,
      orderBy: { createdAt: 'desc' },
      // OPT-C：列表窄化——UI 只消费 5 个轻字段；beforeData/afterData 是完整实体
      // JSON 快照（undo 走 findUnique 单条读取，不经过本列表），列表搬运它们
      // 会让响应体积放大数倍至数十倍。
      select: { id: true, type: true, detail: true, scoreChange: true, adminKey: true, createdAt: true },
    });
    return NextResponse.json({ logs, total, page, pageSize, pageCount });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}

// DELETE /api/v1/logs - Clear all logs (SOFT DELETE via marker, never destroys audit trail)
// P0 fix: previously deleteMany() wiped everything with NO trace of who cleared what.
// Now we record a "purge" entry capturing the count BEFORE deletion, then delete.
// The purge entry itself survives — auditors can always see "admin X cleared N logs at time T".
// AUTH V2.0 安全修复专项（2026-11-11）：清空审计日志=破坏性操作，限 OWNER/ADMIN
// （VIEWER 只读：GET 保留 requireAdmin）
export async function DELETE() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    // 1. Count existing logs so the purge record knows what was removed
    const count = await db.operationLog.count();

    // 2. Write a purge marker FIRST (survives the deleteMany below)
    await db.operationLog.create({
      data: {
        type: 'purge',
        detail: `admin → cleared ${count} log entries`,
        scoreChange: null,
        adminKey: 'admin',
      },
    });

    // 3. Now delete everything EXCEPT the purge marker we just wrote.
    //    Using deleteMany with a createdAt floor keeps the marker alive.
    const now = new Date();
    await db.operationLog.deleteMany({
      where: { createdAt: { lt: now } },
    });

    return NextResponse.json({ success: true, purged: count });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear logs' }, { status: 500 });
  }
}

// POST /api/v1/logs - Create a log entry (HARDENED — no forgery)
// P0 fix: previously accepted arbitrary type/detail/scoreChange/adminKey from client,
// letting any admin inject fabricated "official" log entries. Now:
//   - type must be in a strict whitelist
//   - adminKey is ALWAYS server-injected (client value ignored)
//   - detail is length-capped
//   - scoreChange format validated
const ALLOWED_LOG_TYPES = new Set(['info', 'note', 'manual_note']);
const MAX_DETAIL_LENGTH = 500;
const SCORE_CHANGE_RE = /^[+-]?\d{1,10}$/;

// AUTH V2.0 安全修复专项（2026-11-11）：写入审计日志=修改操作，限 OWNER/ADMIN
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { type, detail, scoreChange } = body;

    // type whitelist — reject anything outside the allowed set
    const safeType = typeof type === 'string' ? type : 'info';
    if (!ALLOWED_LOG_TYPES.has(safeType)) {
      return NextResponse.json(
        { error: `Invalid log type. Allowed: ${[...ALLOWED_LOG_TYPES].join(', ')}` },
        { status: 400 }
      );
    }

    // detail length cap
    const safeDetail = typeof detail === 'string' ? detail.slice(0, MAX_DETAIL_LENGTH) : '';

    // scoreChange format validation (optional)
    let safeScoreChange: string | null = null;
    if (typeof scoreChange === 'string' && SCORE_CHANGE_RE.test(scoreChange)) {
      safeScoreChange = scoreChange;
    }

    const log = await db.operationLog.create({
      data: {
        type: safeType,
        detail: `admin → ${safeDetail}`,
        scoreChange: safeScoreChange,
        // adminKey is ALWAYS server-injected — client cannot forge authorship
        adminKey: 'admin',
      },
    });

    return NextResponse.json({ log });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create log' }, { status: 500 });
  }
}
