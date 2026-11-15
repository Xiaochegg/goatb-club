// ============================================================
// Tier Command · 双表六分类核对端点（TIER_WORKSPACE_V2）
// ------------------------------------------------------------
// GET /api/v1/tier-command/inventory-compare
//   鉴权：requireRole('OWNER','ADMIN')（与 sync/inventory 同门禁）
//   行为：串行只读拉取【整理表 y344e4】与【收集表 d5roro】→ 各自独立解码
//         盘点 → 六分类比对（两表相同/仅收集表/仅整理表/内容存在差异/
//         身份待确认/重复记录）→ 一次返回。
// 纪律（工单最高优先级 + R3 批复沿用）：
//   - 双表分别读取：每张表独立的连接状态/工作表名/实际读取数量/最近读取
//     时间/读取是否成功；任一表读取失败如实标注（绝不把失败显示为成功，
//     绝不把未读取的表显示为已核对）——两表都成功才产出比对结果；
//   - 纯只读：不写库、不写 Config、不改腾讯文档；与同步语义完全解耦
//     （现有单表同步通道零改动、单表 inventory 端点零改动）；
//   - 不拼接两表：比对 = 多重集匹配 + 弱键字段级 diff（tab-inventory V2 纯函数）；
//   - 不重复归档：本端点零写库，归档仍走既有 ingest/ledger-approve 链路；
//   - 身份待确认：对两表「测试者」列应用名称与 Tier 分离识别视图
//     （identity.ts 纯函数；词表外 MT 只提示，不创建等级）；
//   - 限频：沿用进程内 10s 最小间隔；waitRateLimit 等待窗口（上限 15s）
//     仍不足时该表如实标读取失败（管理员稍后重试）；30s 进程内缓存防连点。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  fetchTabSnapshot,
  TencentDocError,
  TIER_DOC_TAB_ID,
} from '@/lib/tier-command/tencent-doc-client';
import { decodeRelatedSheet } from '@/lib/tier-command/protobuf-parse';
import {
  buildTabInventory,
  compareInventoriesV2,
  type InventoryRow,
  type TabInventory,
} from '@/lib/tier-command/tab-inventory';
import {
  resolveIdentity,
  buildIdentityIndex,
  type IdentityPlayerIndex,
} from '@/lib/tier-command/identity';

export const dynamic = 'force-dynamic';

/** 拉取窗口与单表 inventory 端点对齐（默认 60 行；盘点展示原貌，不做全量解析） */
const MAX_ROWS_RETURNED = 60;
const MEMCACHE_TTL_MS = 30_000;

interface TabReadResult {
  tabId: string;
  tabName: string;
  ok: boolean;
  fetchedAt: string | null;
  rowCount: number | null;
  headers: string[] | null;
  rows: InventoryRow[];
  identityUncertain: IdentityUncertainRow[];
  notes: string[];
  error: string | null;
  docErrorCode: string | null;
}

interface IdentityUncertainRow {
  tabId: string;
  rowIndex: number;
  rawName: string;
  note: string;
}

interface ComparePayload {
  ok: true;
  fetchedAt: string;
  tabs: Array<TabReadResult>;
  /** 两表都成功时存在；任一失败 → null（绝不对残缺数据下比对结论） */
  comparison: null | {
    identical: boolean;
    matchedCount: number;
    onlyLedger: Array<{ rowIndex: number; preview: string }>;
    onlyCollect: Array<{ rowIndex: number; preview: string }>;
    contentDiff: Array<{ rowALabel: string; rowBLabel: string; diffs: Array<{ label: string; a: string; b: string }> }>;
    identityUncertain: IdentityUncertainRow[];
    duplicatesLedger: Array<{ count: number; preview: string }>;
    duplicatesCollect: Array<{ count: number; preview: string }>;
  };
  notes: string[];
}

function rowPreview(r: InventoryRow): string {
  const vals = r.cells.map(c => (c ?? '').trim()).filter(v => v !== '');
  return vals.length > 0 ? vals.slice(0, 6).join(' · ') : '（整行空白）';
}

/** 单表只读拉取 + 解码 + 盘点（失败如实返回，绝不伪装成功） */
async function readTab(tabId: string, fallbackName: string, idIndex: IdentityPlayerIndex): Promise<TabReadResult> {
  try {
    const snapshot = await fetchTabSnapshot(tabId, { waitRateLimit: true, maxWaitMs: 15_000 });
    if (snapshot.relatedSheets.length !== 1) {
      return {
        tabId, tabName: fallbackName, ok: false, fetchedAt: snapshot.fetchedAt, rowCount: null,
        headers: null, rows: [], identityUncertain: [], notes: [],
        error: `数据块数=${snapshot.relatedSheets.length}（非 1，需显式处理策略）`, docErrorCode: null,
      };
    }
    const sheet = decodeRelatedSheet(snapshot.relatedSheets[0]!);
    const inv = buildTabInventory(tabId, sheet);
    const tabName = snapshot.tabs.find(t => t.id === tabId)?.name ?? fallbackName;
    const notes: string[] = [];
    const tombstones = sheet.headers.filter(h => (h ?? '').includes('已删除'));
    if (tombstones.length > 0) {
      notes.push(`检测到 ${tombstones.length} 个「已删除」墓碑表头列（v2 残留），不参与业务比对`);
    }
    if (snapshot.maxRow - 1 > snapshot.endRowRequested - 1) {
      notes.push(`文档实际行数（${snapshot.maxRow - 1}）超出拉取窗口（${snapshot.endRowRequested - 1}），本盘点仅含窗口内行`);
    }
    for (const a of sheet.anomalies.slice(0, 3)) notes.push(`结构异常：${a}`);
    // 身份待确认：测试者列（F5，cells[5]）应用名称与 Tier 分离识别视图
    const identityUncertain: IdentityUncertainRow[] = [];
    for (const r of inv.rows) {
      const rawName = (r.cells[5] ?? '').trim();
      if (!rawName) continue;
      const v = resolveIdentity(rawName, idIndex);
      if (v.needsReview && v.reviewNote) {
        identityUncertain.push({ tabId, rowIndex: r.rowIndex, rawName, note: v.reviewNote });
      }
    }
    return {
      tabId,
      tabName,
      ok: true,
      fetchedAt: snapshot.fetchedAt,
      rowCount: inv.rows.length,
      headers: inv.headers,
      rows: inv.rows.slice(0, MAX_ROWS_RETURNED),
      identityUncertain,
      notes,
      error: null,
      docErrorCode: null,
    };
  } catch (err) {
    if (err instanceof TencentDocError) {
      const permissionCodes = new Set(['HTTP_401', 'BLANKPAGE']);
      return {
        tabId, tabName: fallbackName, ok: false, fetchedAt: null, rowCount: null, headers: null,
        rows: [], identityUncertain: [], notes: [],
        error: permissionCodes.has(err.code)
          ? '文档不可读：权限可能已收紧或参数组失效'
          : '拉取腾讯文档失败（网络/超时/响应结构异常）',
        docErrorCode: err.code,
      };
    }
    return {
      tabId, tabName: fallbackName, ok: false, fetchedAt: null, rowCount: null, headers: null,
      rows: [], identityUncertain: [], notes: [],
      error: '拉取腾讯文档失败（未知异常）', docErrorCode: null,
    };
  }
}

const memcache = new Map<string, { at: number; payload: ComparePayload }>();

export async function GET() {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  // 进程内短缓存（防连点；缓存键 v2）
  const cached = memcache.get('v2');
  if (cached && Date.now() - cached.at < MEMCACHE_TTL_MS) {
    return NextResponse.json(cached.payload);
  }

  // 榜单玩家索引（只读；身份待确认分类用）
  const players = await db.player.findMany({ select: { id: true, name: true } });
  const idIndex = buildIdentityIndex(players.map(p => ({ id: p.id, name: p.name })));

  // 串行拉两表（限频纪律：fetchTabSnapshot 内部等待窗口；两表天然错峰）
  const ledgerTab = await readTab(TIER_DOC_TAB_ID, '整理表（同步目标）', idIndex);
  const collectTab = await readTab('d5roro', '收集表（关联表）', idIndex);

  const notes: string[] = [
    '双表核对为独立只读辅助模块：不写库、不改文档、不改变单表同步通道（同步恒指向整理表 y344e4）',
  ];

  let comparison: ComparePayload['comparison'] = null;
  if (ledgerTab.ok && collectTab.ok && ledgerTab.headers !== null && collectTab.headers !== null) {
    const ledgerInv: TabInventory = {
      tabId: ledgerTab.tabId, sheetTitle: null, headers: ledgerTab.headers,
      rows: ledgerTab.rows, blockRowMax: null, anomalies: [],
    };
    const collectInv: TabInventory = {
      tabId: collectTab.tabId, sheetTitle: null, headers: collectTab.headers,
      rows: collectTab.rows, blockRowMax: null, anomalies: [],
    };
    const cmp = compareInventoriesV2(ledgerInv, collectInv);
    const hasWindowCut = ledgerTab.rows.length < (ledgerTab.rowCount ?? 0) || collectTab.rows.length < (collectTab.rowCount ?? 0);
    if (hasWindowCut) {
      notes.push(`本次比对仅覆盖展示窗口（每表前 ${MAX_ROWS_RETURNED} 行预览）；完整行数以各表「实际读取数量」为准`);
    }
    comparison = {
      identical: cmp.identical,
      matchedCount: cmp.matchedCount,
      onlyLedger: cmp.onlyA.map(r => ({ rowIndex: r.rowIndex, preview: rowPreview(r) })),
      onlyCollect: cmp.onlyB.map(r => ({ rowIndex: r.rowIndex, preview: rowPreview(r) })),
      contentDiff: cmp.contentDiff.map(p => ({
        rowALabel: `整理表 行${p.rowA.rowIndex}`,
        rowBLabel: `收集表 行${p.rowB.rowIndex}`,
        diffs: p.diffCols.map(d => ({ label: d.label, a: d.a, b: d.b })),
      })),
      identityUncertain: [...ledgerTab.identityUncertain, ...collectTab.identityUncertain].slice(0, 40),
      duplicatesLedger: cmp.duplicatesA.map(g => ({ count: g.rows.length, preview: rowPreview(g.rows[0]!) })),
      duplicatesCollect: cmp.duplicatesB.map(g => ({ count: g.rows.length, preview: rowPreview(g.rows[0]!) })),
    };
  } else {
    notes.push('至少一张工作表读取失败 —— 本次不产出比对结论（绝不对残缺数据下结论）');
  }

  const payload: ComparePayload = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    tabs: [ledgerTab, collectTab],
    comparison,
    notes,
  };
  memcache.set('v2', { at: Date.now(), payload });
  return NextResponse.json(payload);
}
