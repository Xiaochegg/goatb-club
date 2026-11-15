// ============================================================
// Tier Command · 工单解析管线（P1-B 纯内存，零写库）
// ------------------------------------------------------------
// 职责：把 DecodedSheet（protobuf 层输出）变成「校验过、可审计、可去重」的
//       工单行（TierTicketRow）。本层不触 DB、不写任何持久层 ——
//       玩家匹配只消费调用方传入的只读玩家清单（{id,name}[]）。
//
// v3 适配（2026-11-05，文档 13 物理列 → 10 业务列 + 3 无表头尾列）：
//   - 列左移：胜场 K/L → H/I，评价 M → J（语义不变，仅物理列位变化）；
//   - v2 legacy 字段（score/recording/legacyReview）在 TierTicketRow 中
//     恒为空串保留（下游 UI/审批继承/cfp1 零改动），绝不把新列值填入旧字段；
//   - 映射外非空数据格（如行 7 的 K/L/M=114/514/9178）→ OUT_OF_MAP_NONEMPTY
//     警告：疑似垃圾/残留数据不作为业务字段，绝不静默丢弃；
//   - 指纹 v2→v3：cells 维度 13→10 + 版本前缀隔离哈希空间，同物理行哈希必然
//     变化 —— 跨世代水印/审批继承由 T4 状态机按 cfp1 内容指纹裁决
//     （见 approval-inheritance.ts / sync route）。
//
// v2 适配（2026-11-04 晚，文档 9 列→13 列）历史记录见 git a157b07 之前版本。
//
// 已确认决策（用户 2026-11-04 拍板，docs/tier-command-p1a-precheck.md §4）：
//   1. 幂等：P1-B 仅内存（createTicketSession 进程内 Set；
//      P1-C 起 Config 单 key JSON 过渡，不改 schema）；
//   2. 玩家不存在：跳过并标记「待建条目」（PLAYER_MISSING + pendingEntry），
//      绝不自动创建；
//   3. tier 校验：constants.ts 词表，大小写不敏感，归一化大写；
//      ⑦列 RADIO 为首选信源，⑤⑥拆出 token 仅 advisory，不猜测。
// 指纹（P0.6 规格 v2）：sha256(版本 | 行号 + 提交者 + 提交时间 + 全单元格内容)。
// ============================================================

import { createHash } from 'node:crypto';
import type { DecodedSheet, DecodedCell } from './protobuf-parse';
import {
  TICKET_COLUMNS,
  verifyHeaderStructure,
  normalizeTier,
  parseIdPlusTierCell,
  parseWinsCell,
  excelSerialToParts,
  isPlausibleExcelSerial,
  modeHintFromProject,
  type WinsParse,
  type TicketColumnDef,
} from './column-map';
import type { Tier } from '../constants';
import type { ContentSnapshotInput } from './content-fingerprint';

// ---------- 类型 ----------

export type TicketStatus = 'READY' | 'PLAYER_MISSING' | 'INVALID';

export type IssueLevel = 'error' | 'warn' | 'info';

export interface TicketIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

export interface ExcelTimeField {
  serial: number;
  isoNaive: string;
  display: string;
}

export interface PlayerMatchResult {
  status: 'MATCHED' | 'MISSING' | 'NOT_APPLICABLE';
  playerId: string | null;
  playerName: string | null;
  /** 玩家不存在 → 待建条目（决策 2：跳过并标记，不自动创建） */
  pendingEntry: boolean;
}

export interface IdCellParse {
  gameId: string;
  tierCandidateNormalized: Tier | null; // 仅 advisory
  tierCandidateRaw: string | null;
  splitApplied: boolean;
  matched: PlayerMatchResult;
}

export interface TierTicketRow {
  /** sheet 行号（1 = 第一条数据行，与腾讯文档行号一致） */
  sheetRow: number;
  submitter: string | null;
  submittedAt: ExcelTimeField | null;
  project: {
    raw: string;
    modeHint: ReturnType<typeof modeHintFromProject>;
  };
  testDate: ExcelTimeField | null;
  tester: IdCellParse;   // E列 考核员（执行考核的一方；内部 key 沿用 tester）
  testee: IdCellParse;   // F列 测试者（被测玩家；写榜对象）
  testTier: {
    raw: string;
    normalized: Tier | null; // 仅当 ⑦列命中词表
  };
  /** v2 legacy：H 测试比分 —— v3 文档已无此列，恒空串；仅为下游兼容保留，
   *  绝不把新列值（胜场）填入旧字段 */
  score: {
    raw: string;
    patternOk: boolean | null;
  };
  /** v2 legacy：I 测试录屏 —— v3 文档已无此列，恒空串 */
  recording: string;
  /** v2 legacy：J 测试评价（已删除残留列）—— v3 文档已无此列，恒空串 */
  legacyReview: { raw: string };
  /** v3：H列 测试者胜场（被测玩家；比分信源，advisory，自 v2 K 列左移） */
  testeeWins: WinsParse;
  /** v3：I列 考核员胜场（执行考核方；同上，自 v2 L 列左移） */
  testerWins: WinsParse;
  /** v3：J列 测试评价（活跃列）——纯透传，无校验（自 v2 M 列左移） */
  review: { raw: string };
  fingerprint: string;
  /** T4：10 列原始格文本（与 fingerprintTicket 的 cells 输入同源同序；
   *  供 content-fingerprint 组装 ContentSnapshotInput（E/F 原始格必需，
   *  槽位 index 4/5 与 v2 同位不受列左移影响）） */
  cellTexts: string[];
  status: TicketStatus;
  pendingEntry: boolean;
  issues: TicketIssue[];
}

export interface BuildTicketsOptions {
  /** 只读玩家清单（调用方从 DB 读出后传入；管线自身零 DB 访问） */
  players: Array<{ id: string; name: string }>;
}

export interface BuildTicketsResult {
  tickets: TierTicketRow[];
  summary: {
    totalDataRows: number;
    ready: number;
    playerMissing: number;
    invalid: number;
    duplicateFingerprintsInBatch: number;
  };
  /** 表头结构漂移（非空 = 整批拒绝，tickets 为空） */
  headerMismatches: Array<{ index: number; expected: string; actual: string | null }>;
  /** 跨层透传的结构异常（protobuf 层 anomalies + 本层新增） */
  anomalies: string[];
}

// ---------- 指纹（P0.6 规格：行号 + 提交者 + 提交时间 + 全单元格内容） ----------

// v3（2026-11-05）：文档 13 物理列 → 10 业务列，cells 维度 13→10 + 版本前缀
// 'v3' 隔离哈希空间 —— 同物理行哈希必然变化；跨世代水印/审批继承由 T4
// 审批继承状态机按 cfp1 内容指纹裁决（见 approval-inheritance.ts / sync route）。
// v2 世代历史条目与其键永久保留（审计纪律：只增不删）。
const FINGERPRINT_VERSION = 'v3';

export function fingerprintTicket(input: {
  sheetRow: number;
  submitter: string;
  submittedAtSerial: number | null;
  cells: string[];
}): string {
  return createHash('sha256')
    .update(
      `${FINGERPRINT_VERSION}|${input.sheetRow}|${input.submitter}|${input.submittedAtSerial ?? ''}|${input.cells.join('\u0001')}`,
    )
    .digest('hex');
}

// ---------- 玩家匹配（只读语义） ----------

function matchPlayer(gameId: string, players: Array<{ id: string; name: string }>): PlayerMatchResult {
  const name = gameId.trim();
  if (!name) {
    return { status: 'NOT_APPLICABLE', playerId: null, playerName: null, pendingEntry: false };
  }
  const exact = players.find(p => p.name === name);
  if (exact) {
    return { status: 'MATCHED', playerId: exact.id, playerName: exact.name, pendingEntry: false };
  }
  const trimmed = players.find(p => p.name.trim() === name);
  if (trimmed) {
    return { status: 'MATCHED', playerId: trimmed.id, playerName: trimmed.name, pendingEntry: false };
  }
  // 决策 2：玩家不存在 → 跳过并标记「待建条目」，绝不自动创建
  return { status: 'MISSING', playerId: null, playerName: name, pendingEntry: true };
}

// ---------- 单元格取值辅助 ----------

function cellText(cell: DecodedCell | undefined): string {
  if (!cell) return '';
  if (cell.kind === 'string') return cell.text ?? '';
  if (cell.kind === 'number') return String(cell.number);
  return '';
}

function hasValue(cell: DecodedCell | undefined): boolean {
  return !!cell && cell.kind !== 'empty' && cell.kind !== 'unknown' &&
    (cell.kind === 'number' ? Number.isFinite(cell.number) : (cell.text ?? '').trim().length > 0);
}

// ---------- 主构建函数 ----------

export function buildTickets(sheet: DecodedSheet, opts: BuildTicketsOptions): BuildTicketsResult {
  const anomalies: string[] = [...sheet.anomalies];

  // 0. 表头结构守卫：漂移即整批拒绝（结构变更时解析语义不可信）
  const headerCheck = verifyHeaderStructure(sheet.headers);
  if (!headerCheck.ok) {
    return {
      tickets: [],
      summary: { totalDataRows: sheet.rows.length, ready: 0, playerMissing: 0, invalid: 0, duplicateFingerprintsInBatch: 0 },
      headerMismatches: headerCheck.mismatches,
      anomalies,
    };
  }

  const colByIndex = new Map<number, TicketColumnDef>(TICKET_COLUMNS.map(c => [c.index, c]));
  const tickets: TierTicketRow[] = [];
  const seenInBatch = new Set<string>();
  let duplicateFingerprintsInBatch = 0;

  for (const row of sheet.rows) {
    const sheetRow = row[0]?.row ?? -1;
    const issues: TicketIssue[] = [];
    let invalid = false;

    const get = (key: TicketColumnDef['key']): DecodedCell | undefined => {
      const def = TICKET_COLUMNS.find(c => c.key === key)!;
      return row[def.index];
    };

    // A 提交者 / B 提交时间（自动列：空只 warn）
    const submitterRaw = cellText(get('submitter')).trim();
    const submitter = submitterRaw || null;
    if (!submitter) {
      issues.push({ level: 'warn', code: 'SUBMITTER_EMPTY', message: 'A列 提交者为空（自动列，通常不会发生）' });
    }

    let submittedAt: ExcelTimeField | null = null;
    const submittedAtCell = get('submittedAt');
    if (submittedAtCell?.kind === 'number' && submittedAtCell.number !== null && isPlausibleExcelSerial(submittedAtCell.number)) {
      submittedAt = excelSerialToParts(submittedAtCell.number, 'datetime');
    } else {
      issues.push({ level: 'warn', code: 'SUBMITTED_AT_UNPARSABLE', message: `B列 提交时间不可解析（kind=${submittedAtCell?.kind ?? 'empty'}）` });
    }

    // C 测试项目（advisory 模式提示，不写死）
    const projectRaw = cellText(get('project')).trim();
    if (!projectRaw && colByIndex.get(2)!.required) {
      issues.push({ level: 'error', code: 'PROJECT_EMPTY', message: 'C列 测试项目（必填）为空' });
      invalid = true;
    }
    const modeHint = projectRaw ? modeHintFromProject(projectRaw) : { mode: null, confidence: 'none' as const };
    if (projectRaw && modeHint.confidence !== 'exact') {
      issues.push({
        level: 'info',
        code: 'PROJECT_MODE_HINT',
        message: `C列 测试项目 '${projectRaw}' → 模式提示 ${modeHint.mode ?? '无'}（confidence=${modeHint.confidence}；仅提示，正式映射待 AI/人工阶段）`,
      });
    }

    // D 测试日期
    let testDate: ExcelTimeField | null = null;
    const dateCell = get('testDate');
    if (dateCell?.kind === 'number' && dateCell.number !== null && isPlausibleExcelSerial(dateCell.number)) {
      testDate = excelSerialToParts(dateCell.number, 'date');
    } else {
      issues.push({ level: 'error', code: 'TEST_DATE_INVALID', message: `D列 测试日期（必填）不可解析（kind=${dateCell?.kind ?? 'empty'}）` });
      invalid = true;
    }

    // E/F 游戏 id 列（防御性拆分 + 只读匹配）
    const parseIdColumn = (key: 'tester' | 'testee', label: string): IdCellParse => {
      const cell = get(key);
      const rawText = cellText(cell).trim();
      if (!rawText) {
        issues.push({ level: 'error', code: `${label}_EMPTY`, message: `${label}列（必填）为空` });
        invalid = true;
        return {
          gameId: '', tierCandidateRaw: null, tierCandidateNormalized: null, splitApplied: false,
          matched: { status: 'NOT_APPLICABLE', playerId: null, playerName: null, pendingEntry: false },
        };
      }
      const parsed = parseIdPlusTierCell(rawText);
      if (parsed.splitApplied) {
        issues.push({
          level: 'info',
          code: `${label}_TIER_TOKEN_SPLIT`,
          message: `${label}列 防御性拆分生效：id='${parsed.gameId}' tier候选='${parsed.tierCandidate}'（仅 advisory，tier 信源仍为 G 列）`,
        });
      }
      const candidateNormalized = normalizeTier(parsed.tierCandidate);
      if (parsed.tierCandidate && !candidateNormalized) {
        issues.push({
          level: 'warn',
          code: `${label}_TIER_TOKEN_UNKNOWN`,
          message: `${label}列 拆出的 tier 候选 '${parsed.tierCandidate}' 不在词表（不猜测）`,
        });
      }
      // token 存在但未拆出（段尾规则不满足）→ 人工知晓
      if (!parsed.splitApplied && /(HT|LT|LZ|LL)\s*[1-5]/i.test(rawText)) {
        issues.push({
          level: 'warn',
          code: `${label}_TIER_TOKEN_UNPARSED`,
          message: `${label}列 疑似含 tier token 但不在分隔段末尾，未拆分：'${rawText}'（需人工确认）`,
        });
      }
      return {
        gameId: parsed.gameId || rawText,
        tierCandidateRaw: parsed.tierCandidate,
        tierCandidateNormalized: candidateNormalized,
        splitApplied: parsed.splitApplied,
        matched: matchPlayer(parsed.gameId || rawText, opts.players),
      };
    };
    const tester = parseIdColumn('tester', 'E');
    const testee = parseIdColumn('testee', 'F');

    // G 测试tier（首选信源；决策 3）
    const tierRaw = cellText(get('testTier')).trim();
    const tierNormalized = normalizeTier(tierRaw);
    if (!tierRaw) {
      issues.push({ level: 'error', code: 'TIER_EMPTY', message: 'G列 测试tier（必填）为空' });
      invalid = true;
    } else if (!tierNormalized) {
      issues.push({ level: 'error', code: 'TIER_NOT_IN_VOCAB', message: `G列 测试tier '${tierRaw}' 不在 constants.ts 词表（大小写不敏感校验失败，不猜测）` });
      invalid = true;
    }

    // H/I 胜场（v3 比分信源，自 v2 K/L 左移）：空 → warn（表单必填项缺填，
    // 人工核对）；非数字形态 → warn；不拦截（advisory）
    const parseWinsCol = (key: 'testeeWins' | 'testerWins', letter: string, label: string): WinsParse => {
      const parsed = parseWinsCell(cellText(get(key)));
      if (!parsed.raw) {
        issues.push({ level: 'warn', code: `${letter}_WINS_EMPTY`, message: `${letter}列 ${label}为空（表单必填项缺填，请人工核对）` });
      } else if (parsed.patternOk === false) {
        issues.push({ level: 'warn', code: `${letter}_WINS_PATTERN`, message: `${letter}列 ${label} '${parsed.raw}' 非非负整数形态（advisory，不拦截）` });
      }
      return parsed;
    };
    const testeeWins = parseWinsCol('testeeWins', 'H', '测试者胜场');
    const testerWins = parseWinsCol('testerWins', 'I', '考核员胜场');

    // J 测试评价（v3 活跃列，自 v2 M 左移）：纯透传，无校验
    const reviewRaw = cellText(get('review')).trim();

    // v2 legacy 字段恒空（v3 文档无对应物理列，明确不回填）：
    //   score/recording/legacyReview 仅为下游（sync route 快照槽位/UI）兼容保留
    const scoreRaw = '';
    const scorePatternOk = null;
    const recording = '';
    const legacyReviewRaw = '';

    // 未知/空类型格审计
    for (const cell of row) {
      const def = colByIndex.get(cell.col);
      if (!def) continue;
      if (cell.kind === 'unknown') {
        issues.push({ level: 'error', code: 'CELL_UNKNOWN', message: `${def.letter}${cell.col}列 引用无法解入两池（见 anomalies）` });
        invalid = true;
      } else if (cell.kind === 'empty' && def.required) {
        // required 列整格缺失（映射表无此格）
        issues.push({ level: 'error', code: 'CELL_MISSING', message: `${def.letter}${cell.col}列（${def.headerPrefix}…，必填）整格缺失` });
        invalid = true;
      }
    }

    // v3 映射外审计：物理列超出映射范围（如 K/L/M 无表头尾列）的非空数据格 →
    // 警告（疑似垃圾/残留数据，不作为业务字段，绝不静默丢弃）。
    // 注：映射外【表头】非空已在 verifyHeaderStructure 守卫中整批拒绝。
    for (const cell of row) {
      if (cell.col < TICKET_COLUMNS.length) continue;
      const text = cellText(cell).trim();
      if (text) {
        issues.push({
          level: 'warn',
          code: 'OUT_OF_MAP_NONEMPTY',
          message: `映射外第 ${cell.col + 1} 列（无表头尾列，非业务字段）存在非空数据 '${text.slice(0, 40)}'（疑似垃圾/残留数据，请人工确认）`,
        });
      }
    }

    // 指纹 + 批内去重（cellTexts 同源透出：T4 内容快照组装依赖 E/F 原始格）
    const cellTexts = TICKET_COLUMNS.map(c => cellText(row[c.index]));
    const fingerprint = fingerprintTicket({
      sheetRow,
      submitter: submitter ?? '',
      submittedAtSerial: submittedAt?.serial ?? null,
      cells: cellTexts,
    });
    if (seenInBatch.has(fingerprint)) {
      duplicateFingerprintsInBatch += 1;
      issues.push({ level: 'warn', code: 'DUPLICATE_IN_BATCH', message: '与本批前序行指纹相同（同格内容重复提交）' });
    }
    seenInBatch.add(fingerprint);

    // 玩家匹配汇总：⑤⑥任一缺失 → PLAYER_MISSING（待建条目；决策 2）
    const missingPlayers = [tester, testee].filter(p => p.matched.status === 'MISSING');
    let status: TicketStatus;
    if (invalid) {
      status = 'INVALID';
    } else if (missingPlayers.length > 0) {
      status = 'PLAYER_MISSING';
    } else {
      status = 'READY';
    }
    if (missingPlayers.length > 0) {
      issues.push({
        level: 'info',
        code: 'PLAYER_PENDING_ENTRY',
        message: `玩家不存在 → 待建条目（跳过，不自动创建）：${missingPlayers.map(p => p.matched.playerName).join('、')}`,
      });
    }

    tickets.push({
      sheetRow,
      submitter,
      submittedAt,
      project: { raw: projectRaw, modeHint },
      testDate,
      tester,
      testee,
      testTier: { raw: tierRaw, normalized: tierNormalized },
      score: { raw: scoreRaw, patternOk: scorePatternOk },
      recording,
      legacyReview: { raw: legacyReviewRaw },
      testeeWins,
      testerWins,
      review: { raw: reviewRaw },
      fingerprint,
      cellTexts,
      status,
      pendingEntry: missingPlayers.length > 0,
      issues,
    });
  }

  return {
    tickets,
    summary: {
      totalDataRows: sheet.rows.length,
      ready: tickets.filter(t => t.status === 'READY').length,
      playerMissing: tickets.filter(t => t.status === 'PLAYER_MISSING').length,
      invalid: tickets.filter(t => t.status === 'INVALID').length,
      duplicateFingerprintsInBatch,
    },
    headerMismatches: [],
    anomalies,
  };
}

/**
 * TierTicketRow → ContentSnapshotInput（sync route 与迁移验证共用的唯一映射源；
 * 列位与 TICKET_COLUMNS 固定映射，表头守卫保证）。
 * v3 纪律：legacyScore/recording/legacyReview 三槽读取管线 legacy 恒空字段
 * （绝不把 H/I/J 新列值填入旧字段）；三槽以空串参与 cfp1 哈希，与 v2 快照中
 * 已空的历史 H/I 槽同值 —— 内容未变的行跨世代精确匹配。
 * E/F 原始格取 cellTexts[4]/[5]：v2/v3 同位，不受胜场/评价列左移影响。
 */
export function ticketToSnapshotInput(t: TierTicketRow): ContentSnapshotInput {
  return {
    submitter: t.submitter,
    submittedAtSerial: t.submittedAt?.serial ?? null,
    project: t.project.raw,
    testDateSerial: t.testDate?.serial ?? null,
    testerCell: t.cellTexts[4] ?? '',   // E 考核员原始格
    testeeCell: t.cellTexts[5] ?? '',   // F 测试者原始格
    targetTierRaw: t.testTier.raw,
    legacyScore: t.score.raw,
    recording: t.recording,
    legacyReview: t.legacyReview.raw,
    testeeWinsRaw: t.testeeWins.raw,
    testerWinsRaw: t.testerWins.raw,
    review: t.review.raw,
  };
}

// ---------- 内存幂等会话（决策 1：P1-B 仅内存） ----------

export interface TicketSessionProcessResult {
  fresh: TierTicketRow[];
  duplicates: TierTicketRow[];
}

export interface TicketSession {
  /** 已见指纹（只读视图） */
  readonly seen: ReadonlySet<string>;
  /** 对一批工单做去重：批内先去重，再跨批比对会话水位 */
  process(tickets: TierTicketRow[]): TicketSessionProcessResult;
}

/**
 * 进程内存幂等会话。
 * ⚠ 生命周期 = 进程内存：重启即清空（会重新全量视为新工单）——
 *   这是用户拍板的 P1-B 边界；持久化去重水位由 P1-C 的 Config 单 key JSON 承接。
 */
export function createTicketSession(): TicketSession {
  const seen = new Set<string>();
  return {
    get seen(): ReadonlySet<string> {
      return seen;
    },
    process(tickets: TierTicketRow[]): TicketSessionProcessResult {
      const fresh: TierTicketRow[] = [];
      const duplicates: TierTicketRow[] = [];
      for (const t of tickets) {
        if (seen.has(t.fingerprint)) {
          duplicates.push(t);
        } else {
          seen.add(t.fingerprint);
          fresh.push(t);
        }
      }
      return { fresh, duplicates };
    },
  };
}
