// ============================================================
// Tier Command · 审批继承状态机（T4，方案 A 第二版 §二/§三/§四）
// ------------------------------------------------------------
// 职责：对每张工单，基于「内容指纹（T1 cfp1）」与持久水位（T3 存储）判定
//       历史审批关联分类，取代被禁用的旧行号+targetName 直接继承路径
//       （旧路径缺陷见安全审计报告：行号漂移 fail-open / 同位改内容错误继承 /
//       legacy 索引后写覆盖）。
//
// 四态语义（+legacyUnverified）：
//   A_INHERITED        唯一匹配且内容完全一致（contentFp 命中且唯一）
//                      → 允许继承原审批标记（仅此态自动继承）
//   B_CONTENT_CHANGED  历史关联但内容不同（仅提交时间不同 / 同槽位编辑 /
//                      历史无快照但 tier 实证变更）
//                      → 标记内容变更 + 变更字段清单，需重新审核，绝不自动继承
//   C_AMBIGUOUS        多个匹配来源（水位多条同内容 / 同对象多条历史 /
//                      批内内容重复）
//                      → 人工核对，禁止自动继承
//   D_NO_MATCH         无可靠匹配 → 不继承，按新工单处理
//   LEGACY_UNVERIFIED  命中唯一历史条目（对象+tier 关联），但历史条目无内容
//                      快照（v1/v2 世代存量），无法核实内容一致性
//                      → 保留原审批信息（legacyApprovedUnverified）+ 要求人工核验；
//                        绝不自动继承 approved（由 T5 审批接口强制显式确认）
//
// 匹配优先级（唯一性逐级判定，任何一级歧义即 C）：
//   1. contentFp 精确匹配（含提交时间的完整内容一致）
//   2. contentFpNoTime 匹配（仅提交时间不同 → 疑似重复提交，B）
//   3. 同槽位编辑关联（rowIndex + 写榜对象相同的历史快照条目 → 全量 diff，B）
//   4. 存量无快照条目关联（写榜对象 + tier 关联；行号仅辅助定位不上屏）
//   5. 无关联 → D
//
// 行号纪律（方案 A 第二版 §二硬约束）：rowIndex 只用于「同槽位编辑」的关联
//   信号与定位展示，绝不作为审批继承依据（内容一致性由 contentFp 唯一裁决）。
//
// 审计纪律：不删除、不覆盖任何历史条目与其 approved 标记；本模块纯函数、零 IO。
// ============================================================

import { CFP_VERSION, type TierContentSnapshot } from './content-fingerprint';
import type { SyncStateValue, SyncStateFingerprintEntry, TierApprovedRef } from './sync-state';

// ---------- 类型 ----------

export type InheritanceState =
  | 'A_INHERITED'
  | 'B_CONTENT_CHANGED'
  | 'C_AMBIGUOUS'
  | 'D_NO_MATCH'
  | 'LEGACY_UNVERIFIED';

/** 内容变更 diff 项（B 态；T6 UI 直接渲染） */
export interface ContentDiffItem {
  /** 逻辑字段 key（snapshot 字段名） */
  field: string;
  /** 中文列标（UI 展示） */
  label: string;
  /** 历史值（人类可读；空 → '(空)'） */
  oldDisplay: string;
  /** 当前值 */
  newDisplay: string;
  /** true=该字段不参与 cfp1 哈希（仅 legacyReview(J列)） */
  informationalOnly: boolean;
}

export interface InheritanceDecision {
  state: InheritanceState;
  /** 参与判定的历史指纹键（D 态为空数组） */
  matchedKeys: string[];
  /** 匹配方式（审计/UI 展示「历史审批来源」） */
  matchedBy: 'contentExact' | 'contentNoTime' | 'slotEdit' | 'legacyHint' | 'none';
  /** A 态唯一可自动继承的审批标记（其余态恒 null） */
  inheritedApproved: TierApprovedRef | null;
  /** LEGACY_UNVERIFIED 态：历史原审批对象（内容不可核实，需人工确认后由 T5 放行） */
  legacyApprovedUnverified: TierApprovedRef | null;
  /** B 态：内容变更字段清单（时间-only / 全量 diff / 部分核实） */
  changedFields: ContentDiffItem[];
  /** C 态歧义描述（其余态 null） */
  ambiguity: string | null;
  /** true=本张与批内另一张内容完全相同（同 contentFp 第二次出现） */
  duplicateInBatch: boolean;
  /** 关联历史条目的 firstSeenAt（D 态 null；供水位延续时间线） */
  matchedFirstSeenAt: string | null;
  /** 人类可读判定说明（进同步 warnings / UI 详情） */
  summary: string;
}

export interface ClassifyTicketArgs {
  /** 物理行号（仅定位/关联信号，不作继承依据） */
  rowIndex: number;
  /** 写榜对象（F 列解析 gameId；legacy 关联主信号） */
  targetName: string;
  /** 当前工单内容快照（T1 buildContentSnapshot 产物） */
  snapshot: TierContentSnapshot;
}

// ---------- diff（B 态内容变更检测） ----------

const FIELD_LABELS: Record<string, string> = {
  submitter: '提交者(A)',
  submittedAt: '提交时间(B)',
  project: '测试项目(C)',
  testDate: '测试日期(D)',
  tester: '考核员(E)',
  testee: '测试者(F)',
  targetTier: '目标tier(G)',
  legacyScore: '历史比分(H)',
  recording: '录屏确认(I)',
  testeeWins: '测试者胜场(K)',
  testerWins: '考核员胜场(L)',
  review: '测试评价(M)',
  legacyReview: '旧版评价(J·不入指纹)',
};

function displayText(raw: string | null | undefined): string {
  const t = String(raw ?? '').trim();
  return t === '' ? '(空)' : t;
}

function displayDateTime(v: { display: string | null } | undefined): string {
  return v?.display ?? '(空)';
}

function displayWins(v: { kind: string; value: number | null; raw: string } | undefined): string {
  if (!v || v.kind === 'absent') return '(缺失)';
  if (v.kind === 'empty') return '(空)';
  if (v.kind === 'number') return String(v.value ?? '');
  return `${v.raw}（非数字形态）`;
}

function displayTier(v: { kind: string; raw: string; normalized: string | null } | undefined): string {
  if (!v || v.kind === 'absent') return '(缺失)';
  if (v.kind === 'empty') return '(空)';
  return v.kind === 'tier' ? `${v.normalized}` : `${v.raw}（词表外）`;
}

function displayPerson(v: { gameId: string; tierCandidate: string | null } | undefined): string {
  if (!v) return '(缺失)';
  const id = displayText(v.gameId);
  return v.tierCandidate ? `${id}（候选 ${v.tierCandidate}）` : id;
}

/** 14 逻辑字段全量 diff（B 态 changedFields 数据源；只列有差异的字段） */
export function diffContentSnapshots(oldSnap: TierContentSnapshot, newSnap: TierContentSnapshot): ContentDiffItem[] {
  const out: ContentDiffItem[] = [];
  const push = (field: string, informationalOnly: boolean, oldD: string, newD: string) => {
    if (oldD !== newD) {
      out.push({ field, label: FIELD_LABELS[field] ?? field, oldDisplay: oldD, newDisplay: newD, informationalOnly });
    }
  };

  push('submitter', false, displayText(oldSnap.submitter?.raw), displayText(newSnap.submitter?.raw));
  push('submittedAt', false, displayDateTime(oldSnap.submittedAt), displayDateTime(newSnap.submittedAt));
  push('project', false, displayText(oldSnap.project?.raw), displayText(newSnap.project?.raw));
  push('testDate', false, displayDateTime(oldSnap.testDate), displayDateTime(newSnap.testDate));
  push('tester', false, displayPerson(oldSnap.tester), displayPerson(newSnap.tester));
  push('testee', false, displayPerson(oldSnap.testee), displayPerson(newSnap.testee));
  push('targetTier', false, displayTier(oldSnap.targetTier), displayTier(newSnap.targetTier));
  push('legacyScore', false, displayText(oldSnap.legacyScore?.raw), displayText(newSnap.legacyScore?.raw));
  push('recording', false, displayText(oldSnap.recording?.raw), displayText(newSnap.recording?.raw));
  push('testeeWins', false, displayWins(oldSnap.testeeWins), displayWins(newSnap.testeeWins));
  push('testerWins', false, displayWins(oldSnap.testerWins), displayWins(newSnap.testerWins));
  push('review', false, displayText(oldSnap.review?.raw), displayText(newSnap.review?.raw));
  push('legacyReview', true, displayText(oldSnap.legacyReview?.raw), displayText(newSnap.legacyReview?.raw));
  return out;
}

// ---------- 状态机 ----------

interface IndexEntry {
  key: string;
  entry: SyncStateFingerprintEntry;
  /** 仅快照条目持有；legacy（存量无快照）条目为 undefined */
  snapshot?: TierContentSnapshot;
}

function pushToMap(map: Map<string, string[]>, k: string, v: string): void {
  const arr = map.get(k);
  if (arr) arr.push(v);
  else map.set(k, [v]);
}

/**
 * 创建分类器（一次构建水位索引，整批工单复用）。
 * 索引三类：
 *   byExact / byNoTime —— 带 cfp1 快照的条目（内容可核实）；
 *   legacy —— 无快照或 cfp 版本不识别的条目（内容不可核实，仅对象+tier 关联）。
 */
export function createInheritanceClassifier(state: SyncStateValue) {
  const byExact = new Map<string, string[]>();
  const byNoTime = new Map<string, string[]>();
  const bySlot = new Map<string, string[]>(); // `${rowIndex}\u0001${target trim}` → keys（仅快照条目）
  const legacy: IndexEntry[] = [];
  const entries = state.fingerprints ?? {};

  for (const [key, entry] of Object.entries(entries)) {
    if (entry?.supersededBy) continue; // 已被同内容新键取代：不参与内容匹配（条目与 approved 仍保留审计）
    const snap = entry?.contentSnapshot;
    if (snap && snap.cfpVersion === CFP_VERSION && typeof snap.contentFp === 'string') {
      pushToMap(byExact, snap.contentFp, key);
      pushToMap(byNoTime, snap.contentFpNoTime, key);
      pushToMap(bySlot, `${entry.rowIndex}\u0001${String(entry.targetName ?? '').trim()}`, key);
    } else {
      legacy.push({ key, entry });
    }
  }

  const firstOf = (
    keys: string[] | undefined,
  ): { key: string; entry: SyncStateFingerprintEntry; snapshot: TierContentSnapshot } | null => {
    const k = keys?.[0];
    if (!k) return null;
    const entry = entries[k];
    const snap = entry?.contentSnapshot;
    return snap ? { key: k, entry, snapshot: snap } : null;
  };

  function classify(args: ClassifyTicketArgs): InheritanceDecision {
    const { rowIndex, snapshot } = args;
    const target = String(args.targetName ?? '').trim();

    // 1. contentFp 精确匹配（完整内容一致，含提交时间）
    const exactKeys = byExact.get(snapshot.contentFp) ?? [];
    if (exactKeys.length === 1) {
      const hit = firstOf(exactKeys)!;
      const approved = hit.entry.approved ?? null;
      return {
        state: 'A_INHERITED',
        matchedKeys: exactKeys,
        matchedBy: 'contentExact',
        inheritedApproved: approved,
        legacyApprovedUnverified: null,
        changedFields: [],
        ambiguity: null,
        duplicateInBatch: false,
        matchedFirstSeenAt: hit.entry.firstSeenAt ?? null,
        summary: approved
          ? `内容与历史条目完全一致（唯一匹配，历史审批 ${approved.by}@${approved.at.slice(0, 19)}）→ 继承审批标记`
          : '内容与历史条目完全一致（唯一匹配，历史未审批）→ 不涉及审批继承',
      };
    }
    if (exactKeys.length >= 2) {
      return {
        state: 'C_AMBIGUOUS',
        matchedKeys: exactKeys,
        matchedBy: 'contentExact',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: [],
        ambiguity: `水位中存在 ${exactKeys.length} 条内容完全一致的历史条目，无法确定本张对应哪一条（含审批归属）`,
        duplicateInBatch: false,
        matchedFirstSeenAt: null,
        summary: '多条历史条目内容与本张完全一致 → 歧义，禁止自动继承，需人工核对',
      };
    }

    // 2. contentFpNoTime 匹配（内容一致、仅提交时间不同 → 疑似重复提交）
    const noTimeKeys = (byNoTime.get(snapshot.contentFpNoTime) ?? []).filter(k => !exactKeys.includes(k));
    if (noTimeKeys.length === 1) {
      const hit = firstOf(noTimeKeys)!;
      return {
        state: 'B_CONTENT_CHANGED',
        matchedKeys: noTimeKeys,
        matchedBy: 'contentNoTime',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: diffContentSnapshots(hit.snapshot, snapshot),
        ambiguity: null,
        duplicateInBatch: false,
        matchedFirstSeenAt: hit.entry.firstSeenAt ?? null,
        summary: '与历史条目内容一致、仅提交时间不同（疑似重复提交）→ 需重新审核，不自动继承',
      };
    }
    if (noTimeKeys.length >= 2) {
      return {
        state: 'C_AMBIGUOUS',
        matchedKeys: noTimeKeys,
        matchedBy: 'contentNoTime',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: [],
        ambiguity: `存在 ${noTimeKeys.length} 条「同内容不同提交时间」的历史条目，无法确定关联`,
        duplicateInBatch: false,
        matchedFirstSeenAt: null,
        summary: '多条同内容不同时间的历史条目 → 歧义，需人工核对',
      };
    }

    // 3. 同槽位编辑关联（同 rowIndex + 同写榜对象的历史快照条目 → 全量 diff）
    const slotKeys = bySlot.get(`${rowIndex}\u0001${target}`) ?? [];
    if (slotKeys.length === 1) {
      const hit = firstOf(slotKeys)!;
      return {
        state: 'B_CONTENT_CHANGED',
        matchedKeys: slotKeys,
        matchedBy: 'slotEdit',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: diffContentSnapshots(hit.snapshot, snapshot),
        ambiguity: null,
        duplicateInBatch: false,
        matchedFirstSeenAt: hit.entry.firstSeenAt ?? null,
        summary: '与同槽位（行号+写榜对象）历史条目内容不同 → 内容已变更，需重新审核',
      };
    }
    if (slotKeys.length >= 2) {
      return {
        state: 'C_AMBIGUOUS',
        matchedKeys: slotKeys,
        matchedBy: 'slotEdit',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: [],
        ambiguity: `同槽位（行${rowIndex}·${target}）存在 ${slotKeys.length} 条历史条目，无法确定本张对应哪一条`,
        duplicateInBatch: false,
        matchedFirstSeenAt: null,
        summary: '同槽位多条历史条目 → 歧义，需人工核对',
      };
    }

    // 4. 存量无快照条目关联（对象 + tier；行号仅辅助定位展示，不作判定依据）
    const l1: IndexEntry[] = [];  // 对象相同 且 tier 相同
    const l2: IndexEntry[] = [];  // 对象相同 但 tier 不同（实证变更）
    for (const le of legacy) {
      const t = String(le.entry.targetName ?? '').trim();
      if (!target || t !== target) continue;
      if ((le.entry.tier ?? null) === (snapshot.targetTier.normalized ?? null)) l1.push(le);
      else l2.push(le);
    }
    if (l1.length === 1 && l2.length === 0) {
      const hit = l1[0]!;
      const sameRow = hit.entry.rowIndex === rowIndex;
      const locate = sameRow ? `同位（行${rowIndex}）` : `跨位（历史行${hit.entry.rowIndex} → 当前行${rowIndex}）`;
      return {
        state: 'LEGACY_UNVERIFIED',
        matchedKeys: [hit.key],
        matchedBy: 'legacyHint',
        inheritedApproved: null,
        legacyApprovedUnverified: hit.entry.approved ?? null,
        changedFields: [],
        ambiguity: null,
        duplicateInBatch: false,
        matchedFirstSeenAt: hit.entry.firstSeenAt ?? null,
        summary: `命中唯一历史条目（${locate}·对象+tier 关联），但历史无内容快照，内容一致性无法核实 → 需人工核验后才能写入`,
      };
    }
    if (l1.length === 0 && l2.length === 1) {
      const hit = l2[0]!;
      return {
        state: 'B_CONTENT_CHANGED',
        matchedKeys: [hit.key],
        matchedBy: 'legacyHint',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: [{
          field: 'targetTier',
          label: FIELD_LABELS.targetTier!,
          oldDisplay: displayTier({ kind: hit.entry.tier ? 'tier' : 'empty', raw: hit.entry.tier ?? '', normalized: hit.entry.tier ?? null }),
          newDisplay: displayTier(snapshot.targetTier),
          informationalOnly: false,
        }],
        ambiguity: null,
        duplicateInBatch: false,
        matchedFirstSeenAt: hit.entry.firstSeenAt ?? null,
        summary: `命中唯一历史条目（历史行${hit.entry.rowIndex}），目标tier ${hit.entry.tier ?? '(空)'}→${snapshot.targetTier.normalized ?? '(空)'} 已实证变更；其余字段历史无快照无法核实 → 需重新审核`,
      };
    }
    if (l1.length + l2.length >= 2) {
      return {
        state: 'C_AMBIGUOUS',
        matchedKeys: [...l1, ...l2].map(x => x.key),
        matchedBy: 'legacyHint',
        inheritedApproved: null,
        legacyApprovedUnverified: null,
        changedFields: [],
        ambiguity: `存在 ${l1.length + l2.length} 条同写榜对象的历史条目（tier 相同 ${l1.length} 条/不同 ${l2.length} 条），无法确定关联`,
        duplicateInBatch: false,
        matchedFirstSeenAt: null,
        summary: '同写榜对象多条历史条目 → 歧义，禁止自动继承，需人工核对',
      };
    }

    // 5. 无可靠匹配
    return {
      state: 'D_NO_MATCH',
      matchedKeys: [],
      matchedBy: 'none',
      inheritedApproved: null,
      legacyApprovedUnverified: null,
      changedFields: [],
      ambiguity: null,
      duplicateInBatch: false,
      matchedFirstSeenAt: null,
      summary: '未找到可靠历史关联 → 按新工单处理',
    };
  }

  return { classify };
}

/**
 * 批内重复标记（T4：批内重复检测）。
 * 同步批次中同 contentFp 第二次及以后出现 → 强制 C_AMBIGUOUS（同内容多张，
 * 审批归属不明，禁止任何一张自动继承/直接放行）。
 */
export function markBatchDuplicate(decision: InheritanceDecision, batchIndex: number): InheritanceDecision {
  return {
    ...decision,
    state: 'C_AMBIGUOUS',
    inheritedApproved: null,
    duplicateInBatch: true,
    ambiguity: `本批第 ${batchIndex} 张同内容工单（批内首张同 contentFp），审批归属不明，需人工核对`,
    summary: `批内内容重复（同 contentFp 多张）→ 歧义，禁止自动继承${decision.state === 'A_INHERITED' ? '（已撤销对批内首张以外条的审批继承）' : ''}`,
  };
}
