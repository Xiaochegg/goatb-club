// ============================================================
// Tier Command · 10 列语义映射与字段解析（P1-B 纯内存解析器；
//   2026-11-05 文档 v3 结构适配：13 物理列 → 10 业务列 + 3 无表头尾列）
// ------------------------------------------------------------
// 列结构（文档 v3 实测 2026-11-05T19:29Z，表头以「前缀匹配」做结构漂移守卫）：
//   A0 提交者（自动）        <author>   字符串
//   B1 提交时间（自动）      <time>     IEEE754 double（Excel 序列，yyyy/m/d h:mm:ss）
//   C2 测试项目（必填）      RADIO      字符串（单选）
//   D3 测试日期（必填）      DATE       IEEE754 double（Excel 序列，yyyy年m月d日）
//   E4 考核员游戏id+tier等级（必填） SIMPLE 自由文本
//     （内部 key 仍为 tester = 执行考核的一方；写榜对象不变，仍为 F 列测试者）
//   F5 测试者游戏id+原tier等级（必填）SIMPLE 自由文本 —— 同上
//   G6 测试tier（必填）      RADIO      字符串（单选预设，tier 首选信源）
//   H7 测试者胜场（必填）    SIMPLE     v3：被测玩家（测试者）胜场，独立数值列；
//     表头标必填但可能缺填 → required=false + 空值 warn（不拦截，人工核对）
//   I8 考核员胜场（必填）    SIMPLE     v3：执行考核方胜场，独立数值列（同上）
//   J9 测试评价              SIMPLE     v3：评价文字，纯透传（无校验）
//
// v2→v3 变更（2026-11-05 管理员文档结构调整，见 docs/TIER_LATEST_DOCUMENT_SCHEMA_AUDIT.md）：
//   - v2 的 H「测试比分」/I「测试录屏」（软删除列）与 J「测试评价（残留）」三列已从文档消失；
//   - 胜场两列 K/L → H/I（左移 3 列），评价列 M → J（同左移）；
//   - K/L/M 成为无表头尾列：不得自动成为业务字段；其中非空数据格
//     （如历史残留）必须产生映射外警告，绝不静默丢弃；
//   - v2 三个 legacy 字段（score/recording/legacyReview）在 TierTicketRow 中
//     恒为空串保留（下游兼容），绝不把新列值填入旧字段；
//   - 内容指纹 cfp1 槽位不变（legacyScore/recording 槽以空串参与哈希，
//     与 v2 快照中已空的历史 H/I 槽同值 → 内容未变的行可精确匹配继承）。
// 指纹版本 v2→v3：cells 从 13 列变 10 列 + 版本前缀隔离哈希空间，
//   同物理行哈希必然变化 —— 跨世代继承由 T4 审批继承状态机按 cfp1 内容指纹
//   裁决（A 继承/B 重审/C 人工/D 新增/LEGACY 人工核验），见 approval-inheritance.ts。
//
// ⑤⑥ 解析纪律（补证3 结论，不写死）：
//   - 默认按「独立单值列」处理，语义=游戏 id，不预设格内必含 tier；
//   - 防御性拆分：仅当格内命中 tier 词表 token 且位于某分隔段末尾时拆出
//     tier 候选（分隔符含空白/逗号/加号/顿号/斜杠）；不按 '+' 硬切（游戏 id 可含 +）；
//   - v2 原段位标注（2026-11-05）：词表 token 未命中时，段尾「未定级/无」
//     作为原段位标注拆出（列头「游戏id+原tier等级」规格；行4~6 实测样本）；
//   - tier 取值链：⑦列 RADIO 为首选信源；⑤⑥拆出值仅作 advisory 候选，
//     不猜测、不覆盖（用户已确认决策 2026-11-04）。
// tier 校验纪律（用户已确认决策）：严格按 constants.ts 词表
//   （NORMAL_TIERS + JIAHAO_TIERS），大小写不敏感，归一化大写。
// 日期：Excel 序列 naive 钟面还原（1899-12-30 纪元，UTC 分量即文档显示值，
//   不引入时区换算 —— 46330.633→2026-11-04 15:11:33 与浏览器渲染逐字一致）。
// 纯函数、零 IO、零写库。
// ============================================================

import {
  NORMAL_TIERS,
  JIAHAO_TIERS,
  ALL_MODES,
  MODE_LABELS,
  type Tier,
  type GameMode,
} from '../constants';

// ---------- 列定义 ----------

export type TicketColumnKind =
  | 'auto-author'          // A 提交者（自动）
  | 'auto-datetime'        // B 提交时间（自动）
  | 'radio-project'        // C 测试项目
  | 'date'                 // D 测试日期
  | 'simple-id'            // E/F 游戏 id（+可选 tier token）
  | 'radio-tier'           // G 测试tier
  | 'simple-wins'          // H/I 胜场（v3 比分信源，自 v2 K/L 左移）
  | 'simple-review';       // J 测试评价（v3 活跃列，自 v2 M 左移）

export interface TicketColumnDef {
  index: number;
  letter: string;
  key:
    | 'submitter' | 'submittedAt' | 'project' | 'testDate'
    | 'tester' | 'testee' | 'testTier'
    | 'testeeWins' | 'testerWins' | 'review';
  /** 表头结构漂移守卫用的前缀（真实表头以前缀开头即认为结构未变） */
  headerPrefix: string;
  kind: TicketColumnKind;
  required: boolean;
}

/** 当前适配的文档结构版本（随 TICKET_COLUMNS 同步演进；sync 响应 meta 透出） */
export const TICKET_SCHEMA_VERSION = 'v3';

/**
 * v3 十列布局（2026-11-05 文档实测）。
 * 纪律：映射之外的物理列（如 v3 的 K/L/M 无表头尾列）不是业务字段 ——
 *   空表头永不自动成为有效字段；映射外非空数据格由管线产生警告。
 */
export const TICKET_COLUMNS: TicketColumnDef[] = [
  { index: 0,  letter: 'A', key: 'submitter',   headerPrefix: '提交者',          kind: 'auto-author',   required: false },
  { index: 1,  letter: 'B', key: 'submittedAt', headerPrefix: '提交时间',        kind: 'auto-datetime', required: false },
  { index: 2,  letter: 'C', key: 'project',     headerPrefix: '测试项目',        kind: 'radio-project', required: true },
  { index: 3,  letter: 'D', key: 'testDate',    headerPrefix: '测试日期',        kind: 'date',          required: true },
  { index: 4,  letter: 'E', key: 'tester',      headerPrefix: '考核员游戏id',    kind: 'simple-id',     required: true },
  { index: 5,  letter: 'F', key: 'testee',      headerPrefix: '测试者游戏id',    kind: 'simple-id',     required: true },
  { index: 6,  letter: 'G', key: 'testTier',    headerPrefix: '测试tier',        kind: 'radio-tier',    required: true },
  { index: 7,  letter: 'H', key: 'testeeWins',  headerPrefix: '测试者胜场',      kind: 'simple-wins',   required: false },
  { index: 8,  letter: 'I', key: 'testerWins',  headerPrefix: '考核员胜场',      kind: 'simple-wins',   required: false },
  { index: 9,  letter: 'J', key: 'review',      headerPrefix: '测试评价',        kind: 'simple-review', required: false },
];

/**
 * 表头结构漂移守卫：逐列前缀比对，任何不匹配=文档结构变更 → 整批拒绝。
 * 增列防静默：若文档在映射列之后还出现非空表头（新增列），同样视为漂移
 * （防「新增列内容被静默丢弃」）；尾部全空表头不告警（v3 的 K/L/M 无表头尾列
 * 即属此形态，max_col 虚胖容忍）——但其非空【数据】格由管线另行警告。
 */
export function verifyHeaderStructure(headers: string[]): { ok: boolean; mismatches: Array<{ index: number; expected: string; actual: string | null }> } {
  const mismatches: Array<{ index: number; expected: string; actual: string | null }> = [];
  for (const col of TICKET_COLUMNS) {
    const actual = headers[col.index] ?? null;
    if (actual === null || !actual.startsWith(col.headerPrefix)) {
      mismatches.push({ index: col.index, expected: col.headerPrefix, actual });
    }
  }
  const extras = headers.slice(TICKET_COLUMNS.length).filter(h => h && h.trim().length > 0);
  if (extras.length > 0) {
    mismatches.push({ index: TICKET_COLUMNS.length, expected: '（无更多列）', actual: extras.join('、') });
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ---------- tier 归一化（词表校验，大小写不敏感 → 大写） ----------

const TIER_VOCAB: ReadonlySet<string> = new Set([...NORMAL_TIERS, ...JIAHAO_TIERS]);

/** tier 词表归一化：trim → 去内部空白 → 大写 → 词表命中；不命中返回 null（不猜测）。 */
export function normalizeTier(raw: string | null | undefined): Tier | null {
  if (!raw) return null;
  const up = String(raw).trim().replace(/\s+/g, '').toUpperCase();
  return TIER_VOCAB.has(up) ? (up as Tier) : null;
}

/** 段位 token（补证3 防御拆分用）：HT/LT/LZ/LL × 1-5，大小写不敏感，允许 token 内空白 */
export const TIER_TOKEN_RE = /(HT|LT|LZ|LL)\s*[1-5]/i;

// ---------- ⑤⑥ 防御性拆分 ----------

export interface IdPlusTierParse {
  gameId: string;
  tierCandidate: string | null;   // 未归一化的原始 token（归一化交给 normalizeTier）
  splitApplied: boolean;          // 是否触发了防御性拆分
}

/**
 * ⑤⑥单元格解析（补证3 规则，不写死）：
 * 1. 默认整格 = 游戏 id（实测样本格内仅 id、无 tier token）；
 * 2. 若格内命中 tier token 且该 token 恰好结束某个「分隔段」，
 *    则拆出 tier 候选，余串（去掉悬挂分隔符）为游戏 id；
 * 3. token 必须处于段尾（其后到下一个分隔符之间为空），否则视为 id 的一部分不拆
 *    （例：'LT5大师' 中 token 后还有文字 → 不拆，整格仍为 id，并靠 issues 提示人工）；
 * 4. v2 列头规格（「游戏id+原tier等级」）扩展（2026-11-05）：词表 token 未命中时，
 *    再按「原段位标注」扫描 —— 未定级/无（被测玩家尚无段位时的填写形态，
 *    行4~6 实测样本）。拆出候选不进词表 → 走既有 warn（人工知晓），不猜测。
 */
export function parseIdPlusTierCell(raw: string): IdPlusTierParse {
  const text = String(raw ?? '').trim();
  if (!text) return { gameId: '', tierCandidate: null, splitApplied: false };

  // 词表 tier token（HT/LT/LZ/LL × 1-5）
  const tokenRe = new RegExp(TIER_TOKEN_RE.source, 'gi');
  let lastSegmentEndMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const after = match.index + match[0].length;
    const prevChar = match.index > 0 ? text[match.index - 1]! : '';
    const nextChar = after < text.length ? text[after]! : '';
    const boundaryStart = match.index === 0 || /[\s,，、;；|/／+＋]/.test(prevChar);
    const segmentEnd = nextChar === '' || /[\s,，、;；|/／+＋]/.test(nextChar);
    if (boundaryStart && segmentEnd) {
      lastSegmentEndMatch = match;
    }
  }

  // v2 原段位标注扫描（未定级/无）：仅在词表 token 未命中时启用
  if (!lastSegmentEndMatch) {
    const annoRe = /(未定级|无)/gi;
    let annoMatch: RegExpExecArray | null;
    while ((annoMatch = annoRe.exec(text)) !== null) {
      const after = annoMatch.index + annoMatch[0].length;
      const prevChar = annoMatch.index > 0 ? text[annoMatch.index - 1]! : '';
      const nextChar = after < text.length ? text[after]! : '';
      const boundaryStart = annoMatch.index === 0 || /[\s,，、;；|/／+＋]/.test(prevChar);
      const segmentEnd = nextChar === '' || /[\s,，、;；|/／+＋]/.test(nextChar);
      if (boundaryStart && segmentEnd) {
        lastSegmentEndMatch = annoMatch;
        break; // 首个段尾标注即用（标注不会像 tier token 一样多值连排）
      }
    }
  }

  if (!lastSegmentEndMatch) {
    return { gameId: text, tierCandidate: null, splitApplied: false };
  }

  const m = lastSegmentEndMatch;
  const token = m[0];
  let head = text.slice(0, m.index);
  const tail = text.slice(m.index + token.length);
  // 去掉拆分后悬挂在 id 末尾/候选头部的分隔符（含 +）
  head = head.replace(/[\s,，、;；|/／+＋]+$/u, '');
  const gameId = head.trim();
  return { gameId, tierCandidate: token.replace(/\s+/g, ''), splitApplied: true };
}

// ---------- 胜场（v2 新比分信源） ----------

export interface WinsParse {
  raw: string;
  /** 非负整数解析值；null = 空格（未填）或非数字形态 */
  value: number | null;
  /** true=非负整数；false=非数字形态；null=空格（不适用） */
  patternOk: boolean | null;
}

/** 胜场格解析：空格 → 不适用（历史行常态）；非负整数 → 命中；其余 → 形态异常（advisory） */
export function parseWinsCell(raw: string): WinsParse {
  const text = String(raw ?? '').trim();
  if (!text) return { raw: text, value: null, patternOk: null };
  if (/^\d+$/.test(text)) return { raw: text, value: Number(text), patternOk: true };
  return { raw: text, value: null, patternOk: false };
}

// ---------- Excel 序列日期（naive 钟面还原，零时区换算） ----------

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // 1899-12-30（Excel 1900 体系补 1900-02-29 bug 的业界标准纪元）

export interface ExcelDateParts {
  serial: number;
  /** naive ISO：'2026-11-04T15:11:33'（datetime）/ '2026-11-03T00:00:00'（date）——无时区后缀 */
  isoNaive: string;
  /** 文档显示风格：'2026-11-04 15:11:33' / '2026-11-03' */
  display: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function excelSerialToParts(serial: number, kind: 'datetime' | 'date'): ExcelDateParts {
  const ms = Math.round(serial * 86_400_000);
  const d = new Date(EXCEL_EPOCH_UTC_MS + ms);
  const dateStr = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (kind === 'date') {
    return { serial, isoNaive: `${dateStr}T00:00:00`, display: dateStr };
  }
  const timeStr = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return { serial, isoNaive: `${dateStr}T${timeStr}`, display: `${dateStr} ${timeStr}` };
}

/** 序列合理性窗口（2009-01-01 .. 2064-12-31）——明显越界视为不可信日期 */
export function isPlausibleExcelSerial(serial: number): boolean {
  return Number.isFinite(serial) && serial >= 39814 && serial <= 60076;
}

// ---------- 测试项目 → 模式提示（仅 advisory，AI/人工阶段定夺，不写死） ----------

export interface ModeHint {
  mode: GameMode | null;
  confidence: 'exact' | 'label' | 'fuzzy' | 'none';
}

/** 'uhc' → fuzzy 'BUHC'；'盾斧' → label 'SHIELD'；'SHIELD' → exact。仅提示，不做决定。 */
export function modeHintFromProject(raw: string): ModeHint {
  const text = String(raw ?? '').trim();
  if (!text) return { mode: null, confidence: 'none' };
  const up = text.toUpperCase();
  const exact = (ALL_MODES as string[]).find(m => m === up);
  if (exact) return { mode: exact as GameMode, confidence: 'exact' };
  const labelHit = (ALL_MODES as GameMode[]).find(m => MODE_LABELS[m] === text);
  if (labelHit) return { mode: labelHit, confidence: 'label' };
  const fuzzy = (ALL_MODES as string[]).find(m => m.includes(up) || up.includes(m));
  if (fuzzy) return { mode: fuzzy as GameMode, confidence: 'fuzzy' };
  return { mode: null, confidence: 'none' };
}

// ---------- 比分（v2 legacy 保留） ----------

/**
 * v2 legacy：'5:0' / '5：0'（全角冒号容忍）——v2 H「测试比分」列的形态校验。
 * v3 文档已无比分合并列，管线不再调用；保留定义用于 v2 世代数据的
 * 审计/迁移工具复现（advisory 语义，不作为入库条件）。
 */
export function isScorePattern(raw: string): boolean {
  return /^\s*\d+\s*[:：]\s*\d+\s*$/.test(String(raw ?? ''));
}
