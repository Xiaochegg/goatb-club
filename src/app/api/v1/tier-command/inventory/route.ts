// ============================================================
// Tier Command · 双表 dry-run 盘点端点（R3，管理员批复 2026-11-07）
// ------------------------------------------------------------
// GET /api/v1/tier-command/inventory?tab=<id?>
//   鉴权：requireRole('OWNER','ADMIN')（与 sync 同门禁）
//   参数：tab 可选（默认 y344e4 整理表；687 收集表 = d5roro）
//   行为：opendoc 只读拉取指定 tab → protobuf 解码 → raw 矩阵盘点返回。
//         同响应附带文档级 tab 清单（header[0].d[]），供客户端发起另一表拉取。
// 纪律（批复 + 双 tab 审计 §4）：
//   - 纯只读：不写库、不写 Config、不改腾讯文档；与同步语义完全解耦
//     （盘点永不触发 HEADER_DRIFT 拒绝 —— 盘点要看见原貌，687 表也能看）；
//   - 限频：沿用进程内 10s 最小间隔（P0.6 §1.3）；waitRateLimit 等待窗口
//     （上限 15s）仍不足时返回 429 + retryAfterMs（客户端倒计时重试）；
//   - 30s 进程内结果缓存：防止连点重复拉取。
// 响应 notes（不阻断）：
//   - 墓碑表头检测：687 表 3 个「已删除」列 → 明示 v3 守卫若指向此表将整批拒绝；
//   - 分页守卫：max_row 超出拉取窗口时明示未拉全。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  fetchTabSnapshot,
  TencentDocError,
  rateLimitRemainingMs,
  TIER_DOC_TAB_ID,
  type DocTabInfo,
} from '@/lib/tier-command/tencent-doc-client';
import { decodeRelatedSheet, type DecodedSheet } from '@/lib/tier-command/protobuf-parse';
import { buildTabInventory, type InventoryRow } from '@/lib/tier-command/tab-inventory';

export const dynamic = 'force-dynamic';

/** tab id 形态守卫（实测形态如 y344e4 / d5roro；防注入任意 query 进参数组） */
const TAB_ID_RE = /^[a-zA-Z0-9]{4,16}$/;
const MAX_ROWS_RETURNED = 60;    // 与 opendoc 拉取窗口（endrow=60）对齐
const MEMCACHE_TTL_MS = 30_000;  // 进程内结果缓存：防连点重复拉取

interface InventoryEntry {
  tabId: string;
  tabName: string;
  sheetTitle: string | null;
  headers: string[];
  rowCount: number;
  rows: InventoryRow[];
  notes: string[];
}

interface InventoryResponsePayload {
  ok: true;
  fetchedAt: string;
  targetTabId: string;
  tabs: DocTabInfo[];
  inventory: InventoryEntry;
}

function badRequest(message: string) {
  return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message }, { status: 400 });
}

function errorResponse(code: string, message: string, status: number, detail?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, code, message, ...detail }, { status });
}

const memcache = new Map<string, { at: number; payload: InventoryResponsePayload }>();

function notesFor(tabId: string, sheet: DecodedSheet, maxRow: number, endRowRequested: number): string[] {
  const notes: string[] = [];
  const tombstones = sheet.headers.filter(h => (h ?? '').includes('已删除'));
  if (tombstones.length > 0) {
    notes.push(
      `检测到 ${tombstones.length} 个「已删除」墓碑表头列（${tombstones.map(t => `「${t}」`).join('、')}）：` +
      `本表为 v2 世代表单结构残留；现行 v3 同步守卫若指向此表将整批拒绝（HEADER_DRIFT，设计内保护），切换目标需先行 v3.1 适配（当前批复：不切换）`,
    );
  }
  if (maxRow - 1 > endRowRequested - 1) {
    notes.push(`文档实际行数（${maxRow - 1}）超出拉取窗口（${endRowRequested - 1}），本盘点仅含窗口内行`);
  }
  for (const a of sheet.anomalies.slice(0, 5)) notes.push(`结构异常：${a}`);
  if (tabId !== TIER_DOC_TAB_ID) {
    notes.push('本表非现行同步目标（同步恒指向 y344e4 整理表）；本盘点为只读展示，不产生任何同步/写库行为');
  }
  return notes;
}

export async function GET(request: Request) {
  // 1. 鉴权（OWNER / ADMIN，与 sync 同门禁）
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  // 2. 参数
  const url = new URL(request.url);
  const tabParam = url.searchParams.get('tab');
  const tabId = tabParam && tabParam !== '' ? tabParam : TIER_DOC_TAB_ID;
  if (!TAB_ID_RE.test(tabId)) return badRequest('tab 参数形态不合法');

  // 3. 进程内短缓存
  const cached = memcache.get(tabId);
  if (cached && Date.now() - cached.at < MEMCACHE_TTL_MS) {
    return NextResponse.json(cached.payload);
  }

  // 4. 只读拉取（命中限频先等待窗口，上限 15s；仍不足 → 429 + retryAfterMs）
  let snapshot;
  try {
    snapshot = await fetchTabSnapshot(tabId, { waitRateLimit: true, maxWaitMs: 15_000 });
  } catch (err) {
    if (err instanceof TencentDocError) {
      if (err.code === 'RATE_LIMITED') {
        return errorResponse('RATE_LIMITED', '文档拉取限频窗口未过，请稍后自动重试', 429,
          { retryAfterMs: Math.max(rateLimitRemainingMs(), 1000) });
      }
      const permissionCodes = new Set(['HTTP_401', 'BLANKPAGE']);
      return errorResponse(
        permissionCodes.has(err.code) ? 'DOC_PERMISSION_DENIED' : 'DOC_FETCH_FAILED',
        permissionCodes.has(err.code)
          ? '文档不可读：权限可能已收紧或参数组失效'
          : '拉取腾讯文档失败（网络/超时/响应结构异常），请稍后重试',
        502,
        { detail: { docErrorCode: err.code } },
      );
    }
    return errorResponse('DOC_FETCH_FAILED', '拉取腾讯文档失败（未知异常）', 502);
  }

  // 5. 解码（多块显式拒绝，与 sync 同纪律）
  let sheet: DecodedSheet;
  try {
    if (snapshot.relatedSheets.length !== 1) {
      throw new Error(`related_sheet 块数=${snapshot.relatedSheets.length}（非 1，需显式处理策略）`);
    }
    sheet = decodeRelatedSheet(snapshot.relatedSheets[0]!);
  } catch (err) {
    return errorResponse('PARSE_FAILED', '文档数据块解码失败（zlib/protobuf 层异常）', 500, {
      detail: { reason: err instanceof Error ? err.message : 'unknown decode error' },
    });
  }

  // 6. 盘点构建（raw 原貌；永不触发 HEADER_DRIFT）
  const inv = buildTabInventory(tabId, sheet);
  const tabName = snapshot.tabs.find(t => t.id === tabId)?.name ?? '';
  const payload: InventoryResponsePayload = {
    ok: true,
    fetchedAt: snapshot.fetchedAt,
    targetTabId: tabId,
    tabs: snapshot.tabs,
    inventory: {
      tabId,
      tabName,
      sheetTitle: inv.sheetTitle,
      headers: inv.headers,
      rowCount: inv.rows.length,
      rows: inv.rows.slice(0, MAX_ROWS_RETURNED),
      notes: notesFor(tabId, sheet, snapshot.maxRow, snapshot.endRowRequested),
    },
  };
  memcache.set(tabId, { at: Date.now(), payload });
  return NextResponse.json(payload);
}
