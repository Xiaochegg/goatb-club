// ============================================================
// Tier Command · 收集表 ingest 归档管线（TIER_RECORD_RECOGNITION_REBUILD_V1）
// ------------------------------------------------------------
// 管理员批复 2026-11-09「批准」（Phase 0/1 报告 §三 方案 + §四 决策点全按建议项 + §五 安全预案）：
//   - 信源 = 收集表 d5roro（决策点 1-A）；整理表 y344e4 现行 sync 通道零改动；
//   - v3.1 墓碑适配（决策点 2）：容忍 K/L/M 三个「已删除」墓碑表头列 +
//     过滤整行墓碑行（跳过并留数，绝不静默）；
//   - 687 历史数据（决策点 4）：按现存实际行建链，无导出件不恢复历史；
//   - 双方胜场独立两列（H=被测玩家 / I=考核员），任何链路不得互换/相加/补 0；
//   - 击杀/死亡：文档无对应列 → 全部记录显式「缺失」，绝不补 0、绝不从胜场推算，
//     不写 Player.stats（决策点 5：胜场仅归档+展示，不改评分公式红线）；
//   - 幂等：rowFingerprint @unique（DB 层硬保证）——同一来源行重复同步十次
//     仅产生一次合并增量；
//   - 合并：标准化业务字段【全部一致】才合并（dupSourceCount/dupSourcesJson 聚合
//     于保留行；后到来源行 mergeState=MERGED_DUPLICATE + mergedIntoId），
//     任一字段不同 = 独立记录，一条不丢；提交者/提交时间仅审计，不参与判定；
//   - 排序四层（§3.4）：玩家名 → 考核组合 → 测试日期(旧→新) → 提交者兜底
//     （在 ledger 读取端实施，本层提供 sortLedgerRecords 纯函数）；
//   - 玩家识别（§3.2 玩家名称优先）：F 列被测玩家 = 主分组键；精确/trim 匹配
//     Player.name；0 命中=NOT_FOUND（绝不自动创建）；多命中=NAME_AMBIGUOUS；
//     同 testeeId+同日+同考核员+同项目 但原段位候选互异 → UNCERTAIN（整组人工核对）；
//   - 垃圾行：SUSPECTED_GARBAGE 进待核对队列，绝不自动删除；
//   - 4GB 内存纪律：单次拉取 ~KB 级、逐行流式处理、分批事务（≤200 行/批）。
// 本文件不触 Player.tiers（归档写入走 ledger-approve 人工审批链）。
// ============================================================

import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import {
  fetchTabSnapshot,
  TIER_DOC_ID,
  TencentDocError,
  OPENDOC_END_ROW_INGEST,
} from './tencent-doc-client';
import {
  decodeRelatedSheet,
  type DecodedSheet,
} from './protobuf-parse';
import { buildTickets, type TierTicketRow } from './pipeline';
import { TICKET_COLUMNS } from './column-map';

/** 收集表 tab id（决策点 1-A：ingest 信源；P0 报告 §1.2 实测） */
export const TIER_DOC_TAB_COLLECT = 'd5roro';

/** 单批事务行数上限（4GB 内存纪律：SQLite 单写者，小批多提交） */
const TX_BATCH_SIZE = 200;

// ---------- 状态枚举（与 prisma 注释对齐） ----------

export type LedgerMergeState = 'UNIQUE' | 'MERGED_DUPLICATE';
export type LedgerProcessState =
  | 'SYNCED'         // 已读取（已入台账，未完成深处理——当前实现不落此态，保留枚举位）
  | 'MERGED'         // 已合并（MERGED_DUPLICATE 行的 processState）
  | 'PENDING_REVIEW' // 待核对（无效行/疑似垃圾/身份歧义）
  | 'READY'          // 待归档（有效且识别完成，等待管理员审批）
  | 'ARCHIVED'       // 已归档（管理员审批写入完成）
  | 'ARCHIVE_FAILED';// 同步失败（记录级落库失败）
export type LedgerMatchState = 'MATCHED' | 'NOT_FOUND' | 'NAME_AMBIGUOUS' | 'UNCERTAIN';
export type LedgerConfirmState = 'NONE' | 'PLAYER_PENDING' | 'CONFIRMED' | 'DISPUTED';

// ---------- v3.1 墓碑适配（决策点 2） ----------

/**
 * 整行墓碑检测（v3.1，真实数据实测修正 2026-11-09）：
 * 【十业务列 C-J（index 2..9）全部非空且均完全等于「已删除」】→ 整行墓碑。
 * （实测形态：A 提交者/B 提交时间为自动列保留原值，C-J 被表单删除操作
 *   批量填入「已删除」——全行扫描版判定会因 A/B 有值而漏检，实测已纠。
 *   K/L/M 墓碑表头尾列不参与判定（本就是已删除列）。
 *   部分业务列为「已删除」的普通行不满足条件，按正常管线解析——
 *   若业务字段不可解析自然进待核对，绝不静默丢弃。）
 */
export function isTombstoneRow(rawCells: string[]): boolean {
  let nonEmpty = 0;
  for (let c = 2; c <= 9; c++) {
    const t = (rawCells[c] ?? '').trim();
    if (!t) return false; // 业务列必须非空且全为「已删除」
    nonEmpty += 1;
    if (t !== '已删除') return false;
  }
  return nonEmpty === 8;
}

/** 全空行（表单空行；不入台账，单独计数警告） */
export function isEmptyRow(rawCells: string[]): boolean {
  return rawCells.every(c => (c ?? '').trim() === '');
}

/**
 * v3.1 表头视图变换（纯函数，不改原始 sheet）：
 * 收集表 d5roro 实测 13 物理列 = 10 业务列（A-J 与现行 TICKET_COLUMNS 同布局）+
 * 3 个「已删除」墓碑表头尾列（测试比分（已删除）/测试评价（已删除）/测试录屏…（已删除））。
 * 现行 verifyHeaderStructure 对「映射后非空表头」整批拒绝（防新增列静默丢弃）——
 * 该守卫对收集表会误拒墓碑列。本变换仅把【含「已删除」字样的尾列表头】视空后
 * 交给现行 buildTickets 复用（A-J 解析纪律、E/F 防御拆分、指纹 v3 全部原样生效）；
 * 墓碑列的【非空数据格】仍由管线 OUT_OF_MAP_NONEMPTY 警告审计（如 konglong 行
 * K/L/M=114/514/9178）——不是业务字段，也绝不静默。
 * 其余非空尾列表头（非墓碑）不被本变换掩盖 → 表头漂移守卫照常整批拒绝。
 */
export function stripTombstoneHeaderColumns(sheet: DecodedSheet): {
  viewSheet: DecodedSheet;
  tombstoneHeaderCols: number[];
  otherExtraHeaderCols: Array<{ col: number; header: string }>;
} {
  const headers = [...sheet.headers];
  const tombstoneHeaderCols: number[] = [];
  const otherExtraHeaderCols: Array<{ col: number; header: string }> = [];
  for (let i = TICKET_COLUMNS.length; i < headers.length; i++) {
    const h = (headers[i] ?? '').trim();
    if (!h) continue;
    if (h.includes('已删除')) {
      tombstoneHeaderCols.push(i);
      headers[i] = ''; // 视图置空（原始 sheet.headers 不动）
    } else {
      otherExtraHeaderCols.push({ col: i, header: h });
    }
  }
  return {
    viewSheet: { ...sheet, headers },
    tombstoneHeaderCols,
    otherExtraHeaderCols,
  };
}

// ---------- 标准化机制（§3.5：原始值永不被破坏，仅比较键归一） ----------

/**
 * 文本标准化（仅用于比较/分组键，不回写原文）：
 * trim → 去零宽字符（\u200b-\u200d\uFEFF）→ NFKC 折叠（全半角/中文标点）→
 * 内部连续空白折叠为单个空格。
 */
export function normalizeText(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 键用小写形态（原文保留大小写） */
function normKey(raw: string | null | undefined): string {
  return normalizeText(raw).toLowerCase();
}

// ---------- 合并键（§3.3 严格完全相同才合并） ----------

/**
 * 标准化业务键（bizKey）：参与判定字段 = testeeId, examinerId, project,
 * testDateIso(到日), testTierNorm（词表外用标准化原文兜底）, testerWins,
 * assessorWins, reviewNorm, 双方原段位候选。
 * 提交者/提交时间【不参与】（仅来源审计）；输出 sha256 hex。
 */
export function buildBizKey(input: {
  testeeId: string;
  examinerId: string;
  project: string;
  testDateIso: string | null;
  testTierNorm: string | null;
  testTierRaw: string;
  testerWins: number | null;
  assessorWins: number | null;
  review: string;
  examinerTierCand: string | null;
  testeeTierCand: string | null;
}): string {
  const tierPart = input.testTierNorm ?? `RAW:${normKey(input.testTierRaw)}`;
  const winsPart = (v: number | null) => (v === null ? '' : String(v));
  const canon = [
    normKey(input.testeeId),
    normKey(input.examinerId),
    normKey(input.project),
    input.testDateIso ? input.testDateIso.slice(0, 10) : '',
    tierPart,
    winsPart(input.testerWins),
    winsPart(input.assessorWins),
    normKey(input.review),
    input.examinerTierCand ? normKey(input.examinerTierCand) : '',
    input.testeeTierCand ? normKey(input.testeeTierCand) : '',
  ].join('\u0001');
  return createHash('sha256').update(`bizkey-v1|${canon}`).digest('hex');
}

// ---------- 排序（§3.4 固定四层，与提交者解耦） ----------

export interface LedgerSortRecord {
  testeeId: string;        // ① 玩家名称（标准化后）
  examinerId: string;      // ② 考核组合（examinerId；组内 testeeId 恒同）
  testDateIso: string | null; // ③ 测试日期（旧→新）
  submitter: string;       // ④ 提交者（仅稳定兜底）
  submittedAtIso: string | null;
}

/**
 * 四层排序纯函数：① 玩家名（zh collation）→ ② 考核组合 → ③ 测试日期旧→新 →
 * ④ 提交者/提交时间兜底。后台台账与玩家侧视图统一消费。
 */
export function sortLedgerRecords<T extends LedgerSortRecord>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const g1 = a.testeeId.localeCompare(b.testeeId, 'zh-Hans-CN');
    if (g1 !== 0) return g1;
    const g2 = a.examinerId.localeCompare(b.examinerId, 'zh-Hans-CN');
    if (g2 !== 0) return g2;
    const d1 = a.testDateIso ?? '';
    const d2 = b.testDateIso ?? '';
    if (d1 !== d2) return d1 < d2 ? -1 : 1; // 旧→新
    const s1 = (a.submitter || '').localeCompare(b.submitter || '', 'zh-Hans-CN');
    if (s1 !== 0) return s1;
    const t1 = a.submittedAtIso ?? '';
    const t2 = b.submittedAtIso ?? '';
    if (t1 !== t2) return t1 < t2 ? -1 : 1;
    return 0;
  });
}

// ---------- 类型 ----------

export interface IngestWarning { code: string; message: string }

export interface IngestStats {
  docRowCount: number;      // 文档数据行总数（含墓碑/空行/垃圾）
  tombstoneRows: number;    // 整行墓碑（跳过并留数）
  emptyRows: number;        // 全空行（跳过并警告）
  validRows: number;        // 进入台账的有效解析行
  garbageRows: number;      // 疑似垃圾行（进待核对，不删除）
  newRecords: number;       // 本次新建台账行数
  mergedDupes: number;      // 本次新并入保留行的重复来源数
  idempotentHits: number;   // 幂等命中（rowFingerprint 已存在）
  playerGroupCount: number; // 保留行按被测玩家去重数
  readyCount: number;
  pendingReviewCount: number;
  matchedCount: number;
  notFoundCount: number;
  ambiguousCount: number;
  uncertainCount: number;
  /** 击杀/死亡缺失数（信源不存在 → 恒=台账保留行总数，如实显示，绝不补 0） */
  killsDeathsMissingCount: number;
}

export interface IngestResult {
  ok: boolean;
  dryRun: boolean;
  batchId: string | null;
  fetchedAt: string;
  docId: string;
  tabId: string;
  maxRow: number;
  endRowRequested: number;
  stats: IngestStats;
  warnings: string[];
}

interface ParsedRowPlan {
  ticket: TierTicketRow;
  rawCells: string[];
  bizKey: string;
  suspectGarbage: boolean;
  matchState: LedgerMatchState;
  matchedPlayerId: string | null;
}

// ---------- 玩家识别（§3.2：玩家名称优先） ----------

/**
 * 被测玩家识别：
 * - 精确匹配 name === testeeId（Player.name @unique → 至多 1 条）→ MATCHED；
 * - trim 匹配：trimmed 命中恰 1 条 → MATCHED；命中多条 → NAME_AMBIGUOUS；
 * - 0 命中 → NOT_FOUND（待建条目；绝不自动创建，与现行管线决策 2 一致）。
 * 考核员（E 列）同样识别但不阻断状态（审计字段）。
 */
function identifyPlayer(
  gameId: string,
  exactIndex: Map<string, string>,
  trimIndex: Map<string, string[]>,
): { matchState: LedgerMatchState; matchedPlayerId: string | null } {
  const name = gameId.trim();
  if (!name) return { matchState: 'NOT_FOUND', matchedPlayerId: null };
  const exact = exactIndex.get(name);
  if (exact) return { matchState: 'MATCHED', matchedPlayerId: exact };
  const hits = trimIndex.get(name) ?? [];
  if (hits.length === 1) return { matchState: 'MATCHED', matchedPlayerId: hits[0]! };
  if (hits.length > 1) return { matchState: 'NAME_AMBIGUOUS', matchedPlayerId: null };
  return { matchState: 'NOT_FOUND', matchedPlayerId: null };
}

// ---------- 主流程 ----------

export interface IngestOptions {
  dryRun?: boolean;
}

export interface IngestSheetMeta {
  docId: string;
  tabId: string;
  fetchedAt: string;
  maxRow: number;
  endRowRequested: number;
}

/**
 * 收集表 ingest：真实拉取 d5roro → 解码 → ingestDecodedSheet（核心流程）。
 * dryRun=true 全程内存执行（不写任何表），返回与真实执行同构统计。
 * （核心流程独立导出 = 可测试注入点：测试用真实拉取数据在内存构造变体，
 *   绝不伪造网络层/绝不模拟数据冒充真实读取；测试痕迹验毕即删。）
 */
export async function ingestCollectSheet(opts: IngestOptions = {}): Promise<IngestResult> {
  // ① 真实拉取收集表（endRow=1000：P0 报告 §1.5 实证一次拉全量；越界守卫保留）
  const snapshot = await fetchTabSnapshot(TIER_DOC_TAB_COLLECT, {
    endRow: OPENDOC_END_ROW_INGEST,
    waitRateLimit: true,
    maxWaitMs: 15_000,
  });
  if (snapshot.tabId !== TIER_DOC_TAB_COLLECT) {
    // 响应携带 tab 与请求不符（理论上不可能）→ 显式失败，绝不张冠李戴
    throw new TencentDocError('NO_RELATED_SHEET', `响应 tab=${snapshot.tabId} 与请求 ${TIER_DOC_TAB_COLLECT} 不符`);
  }

  // ② 解码
  if (snapshot.relatedSheets.length !== 1) {
    throw new TencentDocError('NO_RELATED_SHEET', `related_sheet 块数=${snapshot.relatedSheets.length}（非 1，需显式处理策略）`);
  }
  const sheet = decodeRelatedSheet(snapshot.relatedSheets[0]!);

  return ingestDecodedSheet(sheet, {
    docId: TIER_DOC_ID,
    tabId: TIER_DOC_TAB_COLLECT,
    fetchedAt: snapshot.fetchedAt,
    maxRow: snapshot.maxRow,
    endRowRequested: snapshot.endRowRequested,
  }, opts);
}

/**
 * ingest 核心流程（解碼后 sheet → 墓碑过滤 → 现行管线解析（v3.1 视图适配）→
 * 标准化 → 玩家识别 → 幂等落库（rowFingerprint 查重 + bizKey 合并）→ 批次日志。
 * 行为与 ingestCollectSheet 全量一致；meta 由调用方供给（真实快照或测试真实数据变体）。
 */
export async function ingestDecodedSheet(
  sheet: DecodedSheet,
  meta: IngestSheetMeta,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const dryRun = opts.dryRun === true;
  const warnings: string[] = [];

  // ③ 越界守卫（分页窗口语义与现行 sync 相同）
  if (meta.maxRow - 1 > meta.endRowRequested - 1) {
    warnings.push(`文档实际行数（${meta.maxRow - 1}）超出拉取窗口（${meta.endRowRequested - 1}），存在未拉取行 — 需人工扩窗`);
  }

  // ④ v3.1 墓碑表头适配（视图变换；非墓碑额外列仍会被表头守卫整批拒绝）
  const { viewSheet, tombstoneHeaderCols, otherExtraHeaderCols } = stripTombstoneHeaderColumns(sheet);
  if (tombstoneHeaderCols.length > 0) {
    warnings.push(
      `v3.1 墓碑适配：尾列 ${tombstoneHeaderCols.map(c => `#${c + 1}`).join('、')} 表头含「已删除」（v2 残留列）——` +
      '不作为业务字段；其非空数据格仍产生映射外警告（绝不静默）',
    );
  }

  // ⑤ 原始矩阵提取（13 列原样存证）+ 整行墓碑/空行过滤（跳过并留数，绝不静默）
  const width = Math.max(sheet.headers.length, ...sheet.rows.map(r => r.length), 0);
  const rawRows: Array<{ sheetRow: number; cells: string[] }> = sheet.rows.map((row, i) => {
    const cells: string[] = [];
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      cells.push(!cell ? '' : cell.kind === 'string' ? (cell.text ?? '') : cell.kind === 'number' ? String(cell.number) : '');
    }
    return { sheetRow: sheet.rowNumbers?.[i] ?? row[0]?.row ?? i + 1, cells };
  });
  const tombstoneRows = rawRows.filter(r => isTombstoneRow(r.cells));
  const emptyRows = rawRows.filter(r => isEmptyRow(r.cells) && !isTombstoneRow(r.cells));
  const tombstoneRowSet = new Set(tombstoneRows.map(r => r.sheetRow));
  const emptyRowSet = new Set(emptyRows.map(r => r.sheetRow));
  if (tombstoneRows.length > 0) {
    warnings.push(`跳过整行墓碑 ${tombstoneRows.length} 行（sheet 行 ${tombstoneRows.map(r => r.sheetRow).join('、')}；已删除标记行，不入台账）`);
  }
  if (emptyRows.length > 0) {
    warnings.push(`跳过全空行 ${emptyRows.length} 行（sheet 行 ${emptyRows.map(r => r.sheetRow).join('、')}）`);
  }

  // ⑥ 现行管线解析（视图 sheet：A-J 全纪律复用；墓碑列数据格 → OUT_OF_MAP 警告）
  const players = await db.player.findMany({ select: { id: true, name: true } });
  const built = buildTickets(viewSheet, { players });
  if (built.headerMismatches.length > 0) {
    // 非墓碑结构漂移：整批拒绝（与现行 sync 同语义，绝不静默解析）
    throw new TencentDocError('NO_TEXT_BLOCK', `表头结构漂移：${JSON.stringify(built.headerMismatches)}`);
  }

  // ⑦ 玩家识别索引（精确 + trim 多命中检测）
  const exactIndex = new Map<string, string>();
  const trimIndex = new Map<string, string[]>();
  for (const p of players) {
    exactIndex.set(p.name, p.id);
    const t = p.name.trim();
    if (!t) continue;
    const arr = trimIndex.get(t) ?? [];
    arr.push(p.id);
    trimIndex.set(t, arr);
  }

  // ⑧ 逐行标准化 + 业务键（墓碑/空行已过滤；全部非墓碑行参与合并判定）
  const plans: ParsedRowPlan[] = [];
  for (const t of built.tickets) {
    if (tombstoneRowSet.has(t.sheetRow) || emptyRowSet.has(t.sheetRow)) continue;
    const rawRow = rawRows.find(r => r.sheetRow === t.sheetRow);
    // v3.1 修正（真实数据实测）：K/L/M 墓碑列的非空格（如 v2 比分残留 '5:0'、
    // 录屏确认文案「是的，我已知晓」）是 v2 世代正常工单的残留，【不】作为垃圾
    // 判定依据（管线 OUT_OF_MAP_NONEMPTY 警告对其不敏感化，改由下方汇总留痕）；
    // 垃圾判定规则 G1（清晰可验证，不武断）：测试项目标准化后 === 'test'
    // （测试表单的典型残留，P0 实测 konglong 行）。
    const outOfMapCols = t.issues
      .filter(i => i.code === 'OUT_OF_MAP_NONEMPTY')
      .map(i => /第 (\d+) 列/.exec(i.message)?.[1])
      .filter((x): x is string => !!x);
    const tombstoneColResidue = outOfMapCols.length > 0;
    if (tombstoneColResidue) {
      warnings.push(`行 ${t.sheetRow}：墓碑列（${outOfMapCols.map(c => `第${c}列`).join('、')}）存在 v2 世代残留数据（不入业务字段，已在案备查）`);
    }
    const suspectGarbage = normalizeText(t.project.raw).toLowerCase() === 'test';
    const testeeIdent = identifyPlayer(t.testee.gameId, exactIndex, trimIndex);
    const bizKey = buildBizKey({
      testeeId: t.testee.gameId,
      examinerId: t.tester.gameId,
      project: t.project.raw,
      testDateIso: t.testDate?.isoNaive ?? null,
      testTierNorm: t.testTier.normalized,
      testTierRaw: t.testTier.raw,
      testerWins: t.testeeWins.value,     // H 列 = 被测玩家胜场（tester_wins 口径）
      assessorWins: t.testerWins.value,   // I 列 = 考核员胜场（assessor_wins 口径）
      review: t.review.raw,
      examinerTierCand: t.tester.tierCandidateRaw,
      testeeTierCand: t.testee.tierCandidateRaw,
    });
    plans.push({
      ticket: t,
      rawCells: rawRow?.cells ?? [],
      bizKey,
      suspectGarbage,
      matchState: testeeIdent.matchState,
      matchedPlayerId: testeeIdent.matchedPlayerId,
    });
  }

  // ⑨ UNCERTAIN 同名身份冲突（§3.2.3）：同 testeeId+同日+同考核员+同项目，
  //    组内被测玩家原段位候选【非空且互异】→ 无法确证同一玩家 → 整组人工核对。
  //    幂等：对本次涉及的全部分组重算；仅触碰未归档行（ARCHIVED/ARCHIVE_FAILED 不动）。
  const groupKeyOf = (p: ParsedRowPlan) =>
    [
      normKey(p.ticket.testee.gameId),
      p.ticket.testDate?.isoNaive?.slice(0, 10) ?? '',
      normKey(p.ticket.tester.gameId),
      normKey(p.ticket.project.raw),
    ].join('\u0001');
  const planGroups = new Map<string, ParsedRowPlan[]>();
  for (const p of plans) {
    const k = groupKeyOf(p);
    const arr = planGroups.get(k) ?? [];
    arr.push(p);
    planGroups.set(k, arr);
  }
  const uncertainGroupKeys = new Set<string>();
  for (const [k, group] of planGroups) {
    const cands = new Set(group.map(p => (p.ticket.testee.tierCandidateRaw ? normKey(p.ticket.testee.tierCandidateRaw) : '')));
    const nonEmpty = [...cands].filter(c => c !== '');
    if (nonEmpty.length > 1) uncertainGroupKeys.add(k); // 互异非空候选 → 冲突
  }
  for (const p of plans) {
    if (uncertainGroupKeys.has(groupKeyOf(p))) {
      p.matchState = 'UNCERTAIN';
    }
  }

  // ⑩ 状态判定（落库前内存态）：INVALID/垃圾/歧义 → 待核对；其余 → 待归档
  for (const p of plans) {
    const invalid = p.ticket.status === 'INVALID';
    const pending = invalid || p.suspectGarbage ||
      p.matchState === 'NAME_AMBIGUOUS' || p.matchState === 'UNCERTAIN';
    p.ticket.status = pending ? 'INVALID' : 'READY'; // 复用 TierTicketRow.status 承载
    if (invalid && p.suspectGarbage) {
      warnings.push(`行 ${p.ticket.sheetRow}：解析失败且疑似垃圾/残留数据（进待核对队列，绝不自动删除）`);
    } else if (p.suspectGarbage) {
      warnings.push(`行 ${p.ticket.sheetRow}：疑似垃圾/残留数据（映射外非空格；进待核对队列，绝不自动删除）`);
    } else if (p.matchState === 'NAME_AMBIGUOUS') {
      warnings.push(`行 ${p.ticket.sheetRow}：被测玩家「${p.ticket.testee.gameId}」匹配到多个榜单条目（同名歧义）→ 待核对`);
    } else if (p.matchState === 'UNCERTAIN') {
      warnings.push(`行 ${p.ticket.sheetRow}：同玩家同日同考核员同项目出现互异原段位候选（身份无法确证）→ 待核对`);
    }
  }

  // ⑪ 幂等落库（dryRun 跳过写；分批事务 ≤200 行）
  const stats: IngestStats = {
    docRowCount: built.summary.totalDataRows,
    tombstoneRows: tombstoneRows.length,
    emptyRows: emptyRows.length,
    validRows: plans.length,
    garbageRows: plans.filter(p => p.suspectGarbage).length,
    newRecords: 0,
    mergedDupes: 0,
    idempotentHits: 0,
    playerGroupCount: new Set(plans.map(p => normKey(p.ticket.testee.gameId))).size,
    readyCount: plans.filter(p => p.ticket.status === 'READY').length,
    pendingReviewCount: plans.filter(p => p.ticket.status === 'INVALID').length,
    matchedCount: plans.filter(p => p.matchState === 'MATCHED').length,
    notFoundCount: plans.filter(p => p.matchState === 'NOT_FOUND').length,
    ambiguousCount: plans.filter(p => p.matchState === 'NAME_AMBIGUOUS').length,
    uncertainCount: plans.filter(p => p.matchState === 'UNCERTAIN').length,
    killsDeathsMissingCount: 0, // 落库后按保留行数回填（文档无击杀/死亡列 → 恒缺失）
  };

  const nowIso = new Date().toISOString();
  let batchId: string | null = null;

  if (!dryRun) {
    // ⑪-a 批次日志先行（ok=true 先记，落库异常时更新为 false —— 失败批次可追溯）
    const batch = await db.tierSyncBatch.create({
      data: {
        fetchedAt: new Date(meta.fetchedAt),
        docId: TIER_DOC_ID,
        tabId: TIER_DOC_TAB_COLLECT,
        docRowCount: stats.docRowCount,
        validRows: stats.validRows,
        tombstoneRows: stats.tombstoneRows,
        garbageRows: stats.garbageRows,
        newRecords: 0,
        mergedDupes: 0,
        idempotentHits: 0,
        stateJson: JSON.stringify(warnings),
        ok: true,
      },
    });
    batchId = batch.id;

    // ⑪-b 逐行幂等落库（rowFingerprint 唯一约束 = DB 层幂等硬保证；
    //     bizKey 命中既有保留行 → MERGED_DUPLICATE 并入，绝不重复累计任何数值）
    for (let i = 0; i < plans.length; i += TX_BATCH_SIZE) {
      const slice = plans.slice(i, i + TX_BATCH_SIZE);
      await db.$transaction(async tx => {
        for (const p of slice) {
          const t = p.ticket;
          const fp = t.fingerprint;

          // 幂等命中：同来源行已入台账 → 计数不写（同一条同步十次仅一条）
          const existingFp = await tx.tierTicketRecord.findUnique({ where: { rowFingerprint: fp } });
          if (existingFp) {
            stats.idempotentHits += 1;
            continue;
          }

          // 合并判定：同 bizKey 保留行存在 → 本行并入（MERGED_DUPLICATE）
          const keeper = await tx.tierTicketRecord.findFirst({
            where: { bizKey: p.bizKey, mergeState: 'UNIQUE' },
            orderBy: { createdAt: 'asc' },
          });

          const baseData = {
            batchId: batch.id,
            docId: TIER_DOC_ID,
            tabId: TIER_DOC_TAB_COLLECT,
            sourceRow: t.sheetRow,
            rowFingerprint: fp,
            rawCellsJson: JSON.stringify(p.rawCells),
            submitterRaw: t.submitter ?? '',
            submittedAtRaw: t.submittedAt?.display ?? '',
            projectRaw: t.project.raw,
            testDateRaw: t.testDate?.display ?? '',
            examinerRaw: t.cellTexts[4] ?? '',
            testeeRaw: t.cellTexts[5] ?? '',
            testTierRaw: t.testTier.raw,
            testerWinsRaw: t.testeeWins.raw,
            assessorWinsRaw: t.testerWins.raw,
            reviewRaw: t.review.raw,
            submitterNorm: normalizeText(t.submitter),
            submittedAtIso: t.submittedAt?.isoNaive ?? null,
            testDateIso: t.testDate?.isoNaive ?? null,
            examinerId: t.tester.gameId,
            examinerTierCand: t.tester.tierCandidateRaw,
            testeeId: t.testee.gameId,
            testeeTierCand: t.testee.tierCandidateRaw,
            testTierNorm: t.testTier.normalized,
            testerWins: t.testeeWins.value,
            assessorWins: t.testerWins.value,
            reviewNorm: normalizeText(t.review.raw),
            bizKey: p.bizKey,
            matchState: p.matchState,
            matchedPlayerId: p.matchedPlayerId,
            suspectGarbage: p.suspectGarbage,
            processState: p.ticket.status === 'READY' ? 'READY' as const : 'PENDING_REVIEW' as const,
            confirmState: 'NONE' as const,
          };

          if (keeper) {
            // 重复来源 → MERGED_DUPLICATE 行（mergedIntoId 指向保留行）+ 保留行聚合
            await tx.tierTicketRecord.create({
              data: {
                ...baseData,
                mergeState: 'MERGED_DUPLICATE',
                mergedIntoId: keeper.id,
                dupSourceCount: 1,
                dupSourcesJson: JSON.stringify([{
                  sourceRow: t.sheetRow,
                  rowFingerprint: fp,
                  submitter: t.submitter ?? '',
                  submittedAt: t.submittedAt?.isoNaive ?? null,
                  batchId: batch.id,
                  mergedAt: nowIso,
                }]),
                processState: 'MERGED',
              },
            });
            const sources = JSON.parse(keeper.dupSourcesJson || '[]') as unknown[];
            sources.push({
              sourceRow: t.sheetRow,
              rowFingerprint: fp,
              submitter: t.submitter ?? '',
              submittedAt: t.submittedAt?.isoNaive ?? null,
              batchId: batch.id,
              mergedAt: nowIso,
            });
            await tx.tierTicketRecord.update({
              where: { id: keeper.id },
              data: {
                dupSourceCount: { increment: 1 },
                dupSourcesJson: JSON.stringify(sources),
              },
            });
            stats.mergedDupes += 1;
          } else {
            // 全新业务键 → UNIQUE 保留行（首来源同时登记入 dupSourcesJson）
            await tx.tierTicketRecord.create({
              data: {
                ...baseData,
                mergeState: 'UNIQUE',
                dupSourceCount: 1,
                dupSourcesJson: JSON.stringify([{
                  sourceRow: t.sheetRow,
                  rowFingerprint: fp,
                  submitter: t.submitter ?? '',
                  submittedAt: t.submittedAt?.isoNaive ?? null,
                  batchId: batch.id,
                  mergedAt: nowIso,
                }]),
              },
            });
            stats.newRecords += 1;
          }
        }
      });
    }

    // ⑪-c UNCERTAIN 跨批次整组修正（新行把历史同组行拉入待核对；已归档行不动并警告）
    if (uncertainGroupKeys.size > 0) {
      for (const k of uncertainGroupKeys) {
        const [testeeK, dateK, examinerK, projectK] = k.split('\u0001');
        const groupRows = await db.tierTicketRecord.findMany({
          where: {
            mergeState: 'UNIQUE',
            testeeId: { not: '' },
            testDateIso: dateK ? { startsWith: dateK.slice(0, 10) } : undefined,
            processState: { in: ['READY', 'PENDING_REVIEW', 'SYNCED'] },
          },
        });
        const inGroup = groupRows.filter(r =>
          r.testeeId.trim().toLowerCase() === testeeK &&
          (r.testDateIso ?? '').slice(0, 10) === dateK &&
          r.examinerId.trim().toLowerCase() === examinerK &&
          normalizeText(r.projectRaw).toLowerCase() === projectK);
        if (inGroup.length > 1) {
          const cands = new Set(inGroup.map(r => normalizeText(r.testeeTierCand ?? '').toLowerCase()).filter(c => c !== ''));
          if (cands.size > 1) {
            await db.tierTicketRecord.updateMany({
              where: { id: { in: inGroup.map(r => r.id) } },
              data: { matchState: 'UNCERTAIN', processState: 'PENDING_REVIEW' },
            });
            warnings.push(`分组（${testeeK} · ${dateK} · ${examinerK}）跨批次出现互异原段位候选：${inGroup.length} 行整组转入待核对（已归档行不受影响）`);
          }
        }
      }
    }

    // ⑪-d 批次日志回填终值
    await db.tierSyncBatch.update({
      where: { id: batch.id },
      data: {
        newRecords: stats.newRecords,
        mergedDupes: stats.mergedDupes,
        idempotentHits: stats.idempotentHits,
        stateJson: JSON.stringify(warnings),
      },
    });
  }

  // ⑫ 保留行统计（落库后从 DB 取真实台账口径；dryRun 用本批内存口径）
  if (!dryRun) {
    const keepers = await db.tierTicketRecord.findMany({
      where: { mergeState: 'UNIQUE' },
      select: { id: true, processState: true, matchState: true, testeeId: true },
    });
    stats.playerGroupCount = new Set(keepers.map(k => normalizeText(k.testeeId).toLowerCase())).size;
    stats.readyCount = keepers.filter(k => k.processState === 'READY').length;
    stats.pendingReviewCount = keepers.filter(k => k.processState === 'PENDING_REVIEW').length;
    stats.matchedCount = keepers.filter(k => k.matchState === 'MATCHED').length;
    stats.notFoundCount = keepers.filter(k => k.matchState === 'NOT_FOUND').length;
    stats.ambiguousCount = keepers.filter(k => k.matchState === 'NAME_AMBIGUOUS').length;
    stats.uncertainCount = keepers.filter(k => k.matchState === 'UNCERTAIN').length;
    stats.killsDeathsMissingCount = keepers.length; // 文档无击杀/死亡列 → 全部保留行显式缺失
  } else {
    // dryRun：无历史台账可并，本批全部有效解析行均属「缺失」口径
    stats.killsDeathsMissingCount = plans.length;
  }

  // 批内重复指纹提示（同格内容重复提交，现行管线已计数）
  if (built.summary.duplicateFingerprintsInBatch > 0) {
    warnings.push(`本批内 ${built.summary.duplicateFingerprintsInBatch} 行指纹完全相同（同格内容重复提交；幂等键保证仅一次落库）`);
  }
  for (const a of built.anomalies) warnings.push(`结构异常：${a}`);

  return {
    ok: true,
    dryRun,
    batchId,
    fetchedAt: meta.fetchedAt,
    docId: meta.docId,
    tabId: meta.tabId,
    maxRow: meta.maxRow,
    endRowRequested: meta.endRowRequested,
    stats,
    warnings,
  };
}
