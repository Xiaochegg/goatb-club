// ============================================================
// Tier Command · 双表 dry-run 盘点纯函数层（R3，管理员批复 2026-11-07）
// ------------------------------------------------------------
// 批复原文要点：
//   「如果是重复的话，你看他表格是一比一全部都是重复的话，那就直接放一个就行，
//     两个都要看两个表都要看」
// 即：① 两表内容 1:1 重复 → 维持单表同步（y344e4 整理表）即可；
//     ② 双表都必须可随时查看（盘点能力，只读）。
// 纪律（沿用双 tab 审计 docs/TIER_TWO_TAB_STRUCTURE_AUDIT.md §4）：
//   - 仍只同步 y344e4；不自动跨表取数；不改腾讯文档本身；
//   - 盘点 = 只读 raw 矩阵展示 + 业务列内容比对，零业务解释、零写库、零写文档。
// 比对口径：
//   - 仅按 v3 十业务列（A-J，cells[0..9]）规范化（去全部空白）后比对；
//   - 687 表 K/L/M「已删除」墓碑列（v2 世代残留表头/值）不参与比对
//     （整理表无这三列业务值，纳入会把墓碑残留误判为差异）。
// 本层纯函数、零 IO、零状态；DecodedSheet 由调用方解码后传入。
// ============================================================

import type { DecodedSheet } from './protobuf-parse';

export interface InventoryRow {
  rowIndex: number;   // sheet 行号（1 = 第一条数据行）
  cells: string[];    // 原始单元格文本（含空串；宽度 = 表头列数与数据列数的最大值）
  joined: string;     // 原始拼接（\u0001 分隔；展示预览用）
}

export interface TabInventory {
  tabId: string;
  sheetTitle: string | null;
  headers: string[];
  rows: InventoryRow[];
  blockRowMax: number | null;
  anomalies: string[];
}

/** 单元格文本投影（与 pipeline.cellText 同口径：string→text / number→String(number)） */
function cellText(cell: DecodedSheet['rows'][number][number] | undefined): string {
  if (!cell) return '';
  if (cell.kind === 'string') return cell.text ?? '';
  if (cell.kind === 'number') return String(cell.number);
  return '';
}

/**
 * 从解码后的 sheet 构建 raw 盘点矩阵（不解释、不校验、不拒绝 —— 盘点永远展示原貌，
 * 与同步管线的 HEADER_DRIFT 守卫语义无关；687 表须能被完整看见）。
 */
export function buildTabInventory(
  tabId: string,
  sheet: DecodedSheet,
): TabInventory {
  const width = Math.max(sheet.headers.length, ...sheet.rows.map(r => r.length), 0);
  const rows: InventoryRow[] = sheet.rows.map((row, i) => {
    const cells: string[] = [];
    for (let c = 0; c < width; c++) cells.push(cellText(row[c]));
    return { rowIndex: sheet.rowNumbers[i] ?? i + 1, cells, joined: cells.join('\u0001') };
  });
  return {
    tabId,
    sheetTitle: sheet.sheetTitle,
    headers: [...sheet.headers],
    rows,
    blockRowMax: sheet.blockRowMax,
    anomalies: [...sheet.anomalies],
  };
}

// ---------- 双表内容比对 ----------

export interface InventoryComparison {
  /** 两表数据行一比一全部重复（按业务列内容，顺序无关、行号无关） */
  identical: boolean;
  matchedCount: number;
  onlyA: InventoryRow[]; // 仅整理表（A）有
  onlyB: InventoryRow[]; // 仅对照表（B）有
}

/** 规范化：去全部空白（CJK 安全），墓碑残留/手敲空格不造成伪差异 */
function bizKey(row: InventoryRow): string {
  return row.cells.slice(0, 10).join('\u0001').replace(/\s+/g, '');
}

/**
 * 双表业务列内容比对（多重集匹配：同内容多行逐一消耗，不因重复行误判）。
 * identical 判定要求两表数据行数一致且全部匹配（空表不算 identical）。
 */
export function compareInventories(a: TabInventory, b: TabInventory): InventoryComparison {
  const pool = new Map<string, InventoryRow[]>();
  for (const r of b.rows) {
    const k = bizKey(r);
    const arr = pool.get(k);
    if (arr) arr.push(r);
    else pool.set(k, [r]);
  }
  const consumedB = new Set<InventoryRow>();
  const onlyA: InventoryRow[] = [];
  let matchedCount = 0;
  for (const r of a.rows) {
    const arr = pool.get(bizKey(r));
    const hit = arr?.find(c => !consumedB.has(c));
    if (hit) {
      consumedB.add(hit);
      matchedCount += 1;
    } else {
      onlyA.push(r);
    }
  }
  const onlyB = b.rows.filter(r => !consumedB.has(r));
  return {
    identical: a.rows.length > 0 && a.rows.length === b.rows.length && onlyA.length === 0 && onlyB.length === 0,
    matchedCount,
    onlyA,
    onlyB,
  };
}

// ---------- V2 六分类比对（TIER_WORKSPACE_V2：读取端纯函数，零 IO 零写库） ----------
// 工单要求的核对分类：
//   两表相同 / 仅收集表存在 / 仅整理表存在 / 内容存在差异 / 身份待确认 / 重复记录
// 纪律：
//   - 「内容存在差异」= 弱键（测试者 F5 + 测试日期 D3 + 测试项目 C2）可配对但
//     业务列内容不同的行 —— 弱键空值绝不配对（防误配）；差异列逐列列出；
//   - 「重复记录」= 同表内业务键完全一致的重复行组（多重集语义）；
//   - 「身份待确认」不在本函数内（需要 Player 词表索引，由调用方按 identity 层裁决）。

/** v3 十业务列展示标签（工单 K/D 语义：H 列=K·击杀、I 列=D·死亡，均归属测试者） */
export const INVENTORY_BIZ_LABELS = [
  '提交者', '提交时间', '测试项目', '测试日期', '考核员',
  '测试者', '测试tier', 'K·击杀', 'D·死亡', '测试评价',
] as const;

export interface InventoryFieldDiff { col: number; label: string; a: string; b: string }

export interface InventoryContentDiffPair {
  rowA: InventoryRow;   // 整理表侧行
  rowB: InventoryRow;   // 收集表侧行
  diffCols: InventoryFieldDiff[];
}

export interface InventoryDupGroup { key: string; rows: InventoryRow[] }

export interface InventoryComparisonV2 {
  identical: boolean;
  matchedCount: number;
  onlyA: InventoryRow[];            // 仅整理表
  onlyB: InventoryRow[];            // 仅收集表
  contentDiff: InventoryContentDiffPair[];
  duplicatesA: InventoryDupGroup[]; // 整理表内重复
  duplicatesB: InventoryDupGroup[]; // 收集表内重复
}

/** 弱键：测试者(F5)+测试日期(D3)+测试项目(C2)；任一为空 → 不参与弱匹配（防误配） */
function weakKey(row: InventoryRow): string | null {
  const f = (row.cells[5] ?? '').replace(/\s+/g, '');
  const d = (row.cells[3] ?? '').replace(/\s+/g, '');
  const c = (row.cells[2] ?? '').replace(/\s+/g, '');
  if (!f || !c) return null; // 日期允许缺（部分历史行无日期）；测试者与项目必须非空
  return `${f}\u0001${d}\u0001${c}`;
}

/** 表内重复组（业务键完全一致；组大小 >1 才算重复） */
function findDupGroups(rows: InventoryRow[]): InventoryDupGroup[] {
  const map = new Map<string, InventoryRow[]>();
  for (const r of rows) {
    const k = bizKey(r);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, arr]) => ({ key, rows: arr }));
}

/** V2 六分类比对（多重集完全匹配 → 弱键字段级 diff → 余量归类） */
export function compareInventoriesV2(a: TabInventory, b: TabInventory): InventoryComparisonV2 {
  const base = compareInventories(a, b);

  // 弱键配对：整理表余行 ↔ 收集表余行（1:1 消耗）
  const bPool = new Map<string, InventoryRow[]>();
  for (const r of base.onlyB) {
    const k = weakKey(r);
    if (!k) continue;
    const arr = bPool.get(k);
    if (arr) arr.push(r);
    else bPool.set(k, [r]);
  }
  const consumedB = new Set<InventoryRow>();
  const contentDiff: InventoryContentDiffPair[] = [];
  const restOnlyA: InventoryRow[] = [];
  for (const ra of base.onlyA) {
    const k = weakKey(ra);
    const hit = k ? bPool.get(k)?.find(c => !consumedB.has(c)) : undefined;
    if (hit) {
      consumedB.add(hit);
      const diffCols: InventoryFieldDiff[] = [];
      for (let c = 0; c < 10; c++) {
        const va = (ra.cells[c] ?? '').replace(/\s+/g, '');
        const vb = (hit.cells[c] ?? '').replace(/\s+/g, '');
        if (va !== vb) diffCols.push({ col: c, label: INVENTORY_BIZ_LABELS[c] ?? `第${c + 1}列`, a: (ra.cells[c] ?? '').trim(), b: (hit.cells[c] ?? '').trim() });
      }
      contentDiff.push({ rowA: ra, rowB: hit, diffCols });
    } else {
      restOnlyA.push(ra);
    }
  }
  const restOnlyB = base.onlyB.filter(r => !consumedB.has(r));

  return {
    identical: base.identical,
    matchedCount: base.matchedCount,
    onlyA: restOnlyA,
    onlyB: restOnlyB,
    contentDiff,
    duplicatesA: findDupGroups(a.rows),
    duplicatesB: findDupGroups(b.rows),
  };
}

// ---------- 清空判定（同步链路「清空→自动缓存导入」共用） ----------

/**
 * 表单是否已被清空：无任何数据行，且表头行亦无任何非空白内容。
 * 区分两种保护语义（绝不可混同）：
 *   - true  = 「清空」：表头都没了 → 触发自动缓存导入（管理员批复行为）；
 *   - false + 表头漂移 = 「结构变更/指向错误表」→ 维持 HEADER_DRIFT 整批拒绝（保护不放松）。
 */
export function isSheetWiped(sheet: Pick<DecodedSheet, 'headers' | 'rows'>): boolean {
  if (sheet.rows.length > 0) return false;
  return sheet.headers.every(h => (h ?? '').trim() === '');
}
