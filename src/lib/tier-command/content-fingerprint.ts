// ============================================================
// Tier Command · 内容指纹与工单内容快照（T1：contentFingerprint 独立模块）
// ------------------------------------------------------------
// 目标（方案 A 第二版 §一）：把「工单内容」与「物理行号」解耦，为审批继承
//   状态机（T4 A/B/C/D 四态）与审批接口完整快照校验（T5）提供可持久化、
//   可 diff、可复核的内容标识。本模块只定义与计算，不改任何既有逻辑。
//
// 与既有指纹的关系（两套并行、语义不同）：
//   - 行指纹（pipeline.fingerprintTicket，v2）：sha256(v2|行号|提交者|时间|13格)
//     —— 含物理行号，标识「同一物理行是否见过」，继续作为水位主键；
//   - 内容指纹（本模块 cfp1）：不含行号、字段名入哈希、类型感知 ——
//     标识「同一逻辑工单内容」，用于跨行/跨世代内容关联。
//
// cfp1 规范化规则（方案 A 第二版 §一 8 项要求逐条落实）：
//   ① 不含物理行号 —— 输入契约（ContentSnapshotInput）中根本没有行号字段；
//   ② 字段名参与规范化 —— canonical 串逐槽嵌入字段名（见 CONTENT_FP_FIELDS）；
//   ③ 保留原始值 —— 文本不折叠大小写/全半角/内部空白；仅去控制字符 +
//      哈希前 trim 首尾（首尾空白为表格录入噪声，纳入会导致虚假 CONTENT_STALE）；
//   ④ 类型感知 —— 每槽带类型标签：n=数值 / d=日期钟面 / s=文本 / t=词表 tier /
//      e=空格 / z=缺失（absent），NULL、空串、数字、文字四态两两可区分；
//   ⑤ 日期与数字规范化 —— 日期：Excel 序列 → naive 钟面显示串（B 列到秒、
//      D 列到日，复用 column-map.excelSerialToParts，亚秒浮点噪声不影响指纹，
//      与文档渲染逐字一致）；数字：胜场按非负整数十进制（'007'≡'7'），
//      非数字形态保留原文（s: 标签，绝不静默转 0）；
//   ⑥ 新旧字段映射 —— v1 9 列 / v2 13 列 → 14 逻辑字段；v1 世代无 K/L/M/J
//      数据 → 以 z:（absent）参与哈希，与空格（e:）严格区分；
//   ⑦ 防字段顺序变化误判 —— 槽位顺序由代码固定 + 字段名嵌入哈希，
//      「值换槽」必然产生不同哈希（例：考核员/测试者互换可被检出）；
//   ⑧ 业务字段不忽略 —— 12 个哈希槽覆盖方案定义的 14 逻辑字段：E/F 拆分出的
//      「考核员/测试者 ID + 原段位」以原始格整体入哈希（拆分结果仅入快照供
//      diff 展示）。理由：拆分依赖解析器版本，若拆分值入哈希，解析器升级会
//      静默改变全部历史指纹；原始格哈希的检测能力是两个拆分字段的超集。
//
// J 列（legacyReview，软删残留列）：仅入快照、不入哈希 —— 该列已从表单删除，
//   不可能产生新提交，且 v1 世代水位无此列数据，入哈希会破坏新旧内容映射；
//   人工审核信源为 M 列（review，已入哈希）。快照仍保留 J 原文供 UI 展示。
//
// 两个哈希：
//   contentFp       = 'cfp1:'   + sha256('cfp1'   + 12 槽) —— 含提交时间；
//   contentFpNoTime = 'cfp1nt:' + sha256('cfp1nt' + 11 槽) —— 去掉 submittedAt 槽，
//     用于「同内容不同提交时间」的重复提交/重新提交关联（T4 状态机消费）。
//
// 纯函数、零 IO、零写库（与 column-map 同纪律）。
// ============================================================

import { createHash } from 'node:crypto';
import {
  normalizeTier,
  parseIdPlusTierCell,
  parseWinsCell,
  excelSerialToParts,
  isPlausibleExcelSerial,
} from './column-map';

// ---------- 版本与序列化符号 ----------

export const CFP_VERSION = 'cfp1';

/** 槽位分隔符（canonical 串内），内容侧已净化控制字符，不会碰撞 */
const FS = '\u001f';
/** 字段名-值分隔符 */
const NVS = '\u0002';
/** 控制字符净化（含 FS/NVS 本身，杜绝内容注入哈希结构） */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function sanitizeText(raw: string): string {
  return String(raw ?? '').replace(CONTROL_RE, '');
}

// ---------- 类型（快照值容器：全部 JSON 可序列化，供 T3 入水位 / T6 diff 展示） ----------

/** 文本类值：text=有内容 / empty=空格 / absent=缺失（v1 世代无此列） */
export interface CfpTextValue {
  kind: 'text' | 'empty' | 'absent';
  /** 原格文本（仅去控制字符，未 trim；供 UI 原样展示与 diff） */
  raw: string;
}

/** 日期时间值（B 提交时间 kind='datetime' / D 测试日期 kind='date'）；
 *  serial=null → absent（B/D 为自动/日期控件列，空格与缺失不可区分，统一 z:） */
export interface CfpDateTimeValue {
  kind: 'datetime' | 'date' | 'absent';
  serial: number | null;
  /** naive 钟面显示串：'2026-11-04 15:11:33' / '2026-11-03'；absent 为 null */
  display: string | null;
  /** Excel 序列合理性窗口校验（advisory，供 UI 提示；不影响指纹） */
  plausible: boolean;
}

/** E/F 人员格：原始格整体入哈希；ID/原段位拆分仅入快照（解析器升级不扰动指纹） */
export interface CfpPersonValue {
  kind: 'text' | 'empty' | 'absent';
  raw: string;
  gameId: string;
  /** 未归一化的原段位 token（advisory；null=未拆出） */
  tierCandidate: string | null;
  splitApplied: boolean;
}

/** G 目标 tier：tier=词表命中（normalized 大写）/ text=词表未命中（保留原文）/ empty / absent */
export interface CfpTierValue {
  kind: 'tier' | 'text' | 'empty' | 'absent';
  raw: string;
  normalized: string | null;
}

/** K/L 胜场：number=非负整数 / text=形态异常（保留原文，绝不静默转 0）/ empty / absent */
export interface CfpWinsValue {
  kind: 'number' | 'text' | 'empty' | 'absent';
  raw: string;
  value: number | null;
  /** true=非负整数形态；false=异常形态；null=空格；absent 时恒 null */
  patternOk: boolean | null;
}

/** 工单内容快照（T3 起持久化于水位条目；T5 审批校验、T6 diff 展示的数据载体） */
export interface TierContentSnapshot {
  cfpVersion: typeof CFP_VERSION;
  submitter: CfpTextValue;      // A
  submittedAt: CfpDateTimeValue; // B
  project: CfpTextValue;        // C
  testDate: CfpDateTimeValue;   // D
  tester: CfpPersonValue;       // E（考核员；ID/原段位拆分入快照）
  testee: CfpPersonValue;       // F（测试者/写榜对象；同上）
  targetTier: CfpTierValue;     // G
  legacyScore: CfpTextValue;    // H（软删残留）
  recording: CfpTextValue;      // I（软删残留）
  testeeWins: CfpWinsValue;     // K 测试者胜场
  testerWins: CfpWinsValue;     // L 考核员胜场
  review: CfpTextValue;         // M 新版测试评价（活跃）
  /** J 旧版测试评价（软删残留）：仅入快照供展示，不入哈希（见文件头说明） */
  legacyReview: CfpTextValue;
  /** 内容指纹（含提交时间）：'cfp1:<64hex>' */
  contentFp: string;
  /** 内容指纹（不含提交时间）：'cfp1nt:<64hex>' */
  contentFpNoTime: string;
}

/** 构建输入：v2 管线全部字段可填；v1 世代映射场景将缺失列置 null（→ absent） */
export interface ContentSnapshotInput {
  submitter: string | null;         // A 原格
  submittedAtSerial: number | null; // B Excel 序列
  project: string | null;           // C 原格
  testDateSerial: number | null;    // D Excel 序列
  testerCell: string | null;        // E 原始格（考核员 id+原段位）
  testeeCell: string | null;        // F 原始格（测试者 id+原段位）
  targetTierRaw: string | null;     // G 原格
  legacyScore: string | null;       // H 原格
  recording: string | null;         // I 原格
  legacyReview: string | null;      // J 原格（仅快照）
  testeeWinsRaw: string | null;     // K 原格
  testerWinsRaw: string | null;     // L 原格
  review: string | null;            // M 原格
}

// ---------- 哈希槽位（顺序由代码固定；字段名入哈希，防顺序/换槽误判） ----------

/**
 * cfp1 的 12 个哈希槽（固定顺序）。14 逻辑字段 → 12 槽的映射：
 *   考核员 ID + 考核员原段位 → testerCell（E 原始格整体）
 *   测试者 ID + 测试者原段位 → testeeCell（F 原始格整体）
 * J 列（legacyReview）仅入快照、不入哈希。
 */
export const CONTENT_FP_FIELDS = [
  'submitter',
  'submittedAt',
  'project',
  'testDate',
  'testerCell',
  'testeeCell',
  'targetTier',
  'legacyScore',
  'recording',
  'testeeWins',
  'testerWins',
  'review',
] as const;

export type ContentFpField = (typeof CONTENT_FP_FIELDS)[number];

// ---------- 值构建 ----------

function textValue(raw: string | null): CfpTextValue {
  if (raw === null) return { kind: 'absent', raw: '' };
  const clean = sanitizeText(raw);
  return { kind: clean.trim() === '' ? 'empty' : 'text', raw: clean };
}

function dateTimeValue(serial: number | null, kind: 'datetime' | 'date'): CfpDateTimeValue {
  if (serial === null || !Number.isFinite(serial)) {
    return { kind: 'absent', serial: null, display: null, plausible: false };
  }
  const parts = excelSerialToParts(serial, kind);
  return { kind, serial, display: parts.display, plausible: isPlausibleExcelSerial(serial) };
}

function personValue(raw: string | null): CfpPersonValue {
  if (raw === null) return { kind: 'absent', raw: '', gameId: '', tierCandidate: null, splitApplied: false };
  const clean = sanitizeText(raw);
  if (clean.trim() === '') return { kind: 'empty', raw: clean, gameId: '', tierCandidate: null, splitApplied: false };
  const parsed = parseIdPlusTierCell(clean);
  return { kind: 'text', raw: clean, gameId: parsed.gameId, tierCandidate: parsed.tierCandidate, splitApplied: parsed.splitApplied };
}

function tierValue(raw: string | null): CfpTierValue {
  if (raw === null) return { kind: 'absent', raw: '', normalized: null };
  const clean = sanitizeText(raw);
  if (clean.trim() === '') return { kind: 'empty', raw: clean, normalized: null };
  const normalized = normalizeTier(clean);
  return normalized
    ? { kind: 'tier', raw: clean, normalized }
    : { kind: 'text', raw: clean, normalized: null };
}

function winsValue(raw: string | null): CfpWinsValue {
  if (raw === null) return { kind: 'absent', raw: '', value: null, patternOk: null };
  const clean = sanitizeText(raw);
  if (clean.trim() === '') return { kind: 'empty', raw: clean, value: null, patternOk: null };
  const parsed = parseWinsCell(clean);
  return parsed.patternOk === true
    ? { kind: 'number', raw: clean, value: parsed.value, patternOk: true }
    : { kind: 'text', raw: clean, value: null, patternOk: false };
}

// ---------- 槽位标签（类型感知的 canonical 编码） ----------

function textTag(v: CfpTextValue): string {
  if (v.kind === 'absent') return 'z:';
  if (v.kind === 'empty') return 'e:';
  return `s:${v.raw.trim()}`;
}

function dateTimeTag(v: CfpDateTimeValue): string {
  return v.kind === 'absent' ? 'z:' : `d:${v.display ?? ''}`;
}

function personTag(v: CfpPersonValue): string {
  if (v.kind === 'absent') return 'z:';
  if (v.kind === 'empty') return 'e:';
  return `s:${v.raw.trim()}`;
}

function tierTag(v: CfpTierValue): string {
  if (v.kind === 'absent') return 'z:';
  if (v.kind === 'empty') return 'e:';
  if (v.kind === 'tier') return `t:${v.normalized ?? ''}`;
  return `s:${v.raw.trim()}`;
}

function winsTag(v: CfpWinsValue): string {
  if (v.kind === 'absent') return 'z:';
  if (v.kind === 'empty') return 'e:';
  if (v.kind === 'number') return `n:${v.value ?? ''}`;
  return `s:${v.raw.trim()}`;
}

function slotTag(field: ContentFpField, s: TierContentSnapshot): string {
  switch (field) {
    case 'submitter': return textTag(s.submitter);
    case 'submittedAt': return dateTimeTag(s.submittedAt);
    case 'project': return textTag(s.project);
    case 'testDate': return dateTimeTag(s.testDate);
    case 'testerCell': return personTag(s.tester);
    case 'testeeCell': return personTag(s.testee);
    case 'targetTier': return tierTag(s.targetTier);
    case 'legacyScore': return textTag(s.legacyScore);
    case 'recording': return textTag(s.recording);
    case 'testeeWins': return winsTag(s.testeeWins);
    case 'testerWins': return winsTag(s.testerWins);
    case 'review': return textTag(s.review);
  }
}

// ---------- canonical 串与哈希 ----------

/**
 * cfp1 canonical 串（调试/审计/测试可导出）：
 *   `cfp1\u001fsubmitter\u0002s:... \u001fproject\u0002s:...`（槽位序 = CONTENT_FP_FIELDS）
 * includeTime=false 时版本前缀改用 'cfp1nt' 且跳过 submittedAt 槽。
 */
export function contentCanonicalString(
  snapshot: TierContentSnapshot,
  opts?: { includeTime?: boolean },
): string {
  const includeTime = opts?.includeTime !== false;
  const parts: string[] = [includeTime ? CFP_VERSION : `${CFP_VERSION}nt`];
  for (const field of CONTENT_FP_FIELDS) {
    if (field === 'submittedAt' && !includeTime) continue;
    parts.push(`${field}${NVS}${slotTag(field, snapshot)}`);
  }
  return parts.join(FS);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- 主构建函数 ----------

/** 由原始单元格值组装内容快照并计算双指纹（纯函数，可重复调用） */
export function buildContentSnapshot(input: ContentSnapshotInput): TierContentSnapshot {
  const snapshot: TierContentSnapshot = {
    cfpVersion: CFP_VERSION,
    submitter: textValue(input.submitter),
    submittedAt: dateTimeValue(input.submittedAtSerial, 'datetime'),
    project: textValue(input.project),
    testDate: dateTimeValue(input.testDateSerial, 'date'),
    tester: personValue(input.testerCell),
    testee: personValue(input.testeeCell),
    targetTier: tierValue(input.targetTierRaw),
    legacyScore: textValue(input.legacyScore),
    recording: textValue(input.recording),
    testeeWins: winsValue(input.testeeWinsRaw),
    testerWins: winsValue(input.testerWinsRaw),
    review: textValue(input.review),
    legacyReview: textValue(input.legacyReview),
    contentFp: '',
    contentFpNoTime: '',
  };
  snapshot.contentFp = `cfp1:${sha256Hex(contentCanonicalString(snapshot, { includeTime: true }))}`;
  snapshot.contentFpNoTime = `cfp1nt:${sha256Hex(contentCanonicalString(snapshot, { includeTime: false }))}`;
  return snapshot;
}

// ---------- 校验（T5 审批接口完整快照校验的底座） ----------

/**
 * 用「当前从文档重新解析出的原始值」复算内容指纹，与持久化快照比对。
 * 两者一致 ⇔ 快照以来文档内容未发生任何变化（14 逻辑字段全等）。
 */
export function verifyContentSnapshot(input: ContentSnapshotInput, snapshot: TierContentSnapshot): boolean {
  const rebuilt = buildContentSnapshot(input);
  return rebuilt.contentFp === snapshot.contentFp && rebuilt.contentFpNoTime === snapshot.contentFpNoTime;
}
