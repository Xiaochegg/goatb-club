// ============================================================
// Tier Command · 只读同步 API（P1-C 接线）
// ------------------------------------------------------------
// POST /api/v1/tier-command/sync
//   鉴权：requireRole('OWNER','ADMIN')
//   参数：{ dryRun?: boolean }（默认 false）
//   行为：腾讯文档 opendoc 拉取 → protobuf 解码 → P1-B 管线解析 →
//         Config 单 key 指纹幂等（dryRun 不写；写失败降级内存幂等）
//   纪律（用户指令 2026-11-04）：
//     - 只读同步：不写 Player.tiers / RankSnapshot / OperationLog
//     - 不接 AI 模型、不做审批写入
//     - 不改 P1-B 解析规则
//   错误分类（不得返回空结果冒充成功）：
//     DOC_FETCH_FAILED / DOC_PERMISSION_DENIED / HEADER_DRIFT /
//     PARSE_FAILED / CONFIG_WRITE_FAILED（后者为降级警告，不失败）
//   审计：同步审计「待审批写入阶段补审计」（P2 补 OperationLog）
//
// v2 结构迁移（2026-11-04 晚）已被 T4 审批继承状态机取代（2026-11-05，方案 A 第二版）：
//   - 旧「行号+被测玩家 targetName 直接继承 approved」路径已移除
//     （安全审计：行号漂移 fail-open / 同位改内容错误继承 / 索引后写覆盖）；
//   - 每行构建 cfp1 内容快照（T1），由 approval-inheritance 状态机判定
//     A_INHERITED（唯一匹配且内容一致→继承审批）/ B_CONTENT_CHANGED（内容变更
//     →需重审）/ C_AMBIGUOUS（多匹配/批内重复→人工核对）/ D_NO_MATCH（新增）/
//     LEGACY_UNVERIFIED（存量无快照→人工核验，原审批仅存证）；
//   - 仅 A 态自动继承 approved；行号只作关联信号不作继承依据；
//   - 行快照/判定结果随水位落盘（contentSnapshot/inheritanceState/
//     legacyApprovedUnverified，见 sync-state T3/T4 字段），供 T5 审批校验
//     与 T6 UI 五态展示。
//
// v3 结构适配（2026-11-05，见 docs/TIER_LATEST_DOCUMENT_SCHEMA_AUDIT.md）：
//   - 列左移：胜场 K/L → H/I，评价 M → J；legacy 三列（v2 H/I/J）已从文档消失；
//   - 指纹版本 v2→v3（cells 13→10 维 + 版本前缀隔离哈希空间），同物理行
//     哈希必然变化 —— 跨世代水印/审批继承由 T4 状态机按 cfp1 内容指纹裁决，
//     水位数据零迁移（旧 v2 键与审批标记永久保留，审计纪律：只增不删）；
//   - 内容快照槽位不变：legacyScore/recording/legacyReview 三槽以空串参与
//     （与 v2 快照中已空的历史 H/I 槽同值）→ 内容未变的行可精确匹配继承；
//   - 响应 meta 新增 schemaVersion='v3'（可观测性）；
//   - 新增映射外非空数据格警告透传（管线 OUT_OF_MAP_NONEMPTY）。
//
// R3 清空保护（2026-11-07，管理员批复：「加一个自动化缓存导入 每当检测到清空时重置」）：
//   - 检测到文档被清空（0 数据行且表头亦为空，isSheetWiped）→ 自动从
//     tier_command_batch_cache（最后一次非空实时批次快照）导入 rows 原样展示；
//   - 清空态绝不写水位、绝不写快照；水位/审批/文档零改动；
//   - 表头仍在但结构漂移仍走 HEADER_DRIFT 整批拒绝（两套保护语义不混同）；
//   - 每次真实同步（非 dryRun）解析 >0 行后刷新快照（writeBatchCache）；
//   - 响应 meta 新增 clearedDetected / cacheFallback（UI 横幅数据源）。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  fetchSheetSnapshot,
  TencentDocError,
  type OpendocSnapshot,
} from '@/lib/tier-command/tencent-doc-client';
import { decodeRelatedSheet } from '@/lib/tier-command/protobuf-parse';
import { buildTickets, ticketToSnapshotInput, type TierTicketRow } from '@/lib/tier-command/pipeline';
import { TICKET_SCHEMA_VERSION } from '@/lib/tier-command/column-map';
import {
  buildContentSnapshot,
} from '@/lib/tier-command/content-fingerprint';
import {
  createInheritanceClassifier,
  markBatchDuplicate,
  type InheritanceDecision,
  type InheritanceState,
  type ContentDiffItem,
} from '@/lib/tier-command/approval-inheritance';
import { suggestForTicketRow, type AiSuggestion } from '@/lib/tier-command/ai-suggest';
import {
  computeDupKey,
  dupKeyFromSnapshot,
} from '@/lib/tier-command/duplicate-detect';
import {
  mergeSyncState,
  readSyncState,
  type SyncStateFingerprintEntry,
} from '@/lib/tier-command/sync-state';
import { readBatchCache, writeBatchCache, type TierBatchCacheValue } from '@/lib/tier-command/batch-cache';
import { isSheetWiped } from '@/lib/tier-command/tab-inventory';
import type { DecodedSheet } from '@/lib/tier-command/protobuf-parse';

export const dynamic = 'force-dynamic';

// ---------- 错误分类 ----------

type SyncErrorCode =
  | 'DOC_FETCH_FAILED'
  | 'DOC_PERMISSION_DENIED'
  | 'HEADER_DRIFT'
  | 'PARSE_FAILED'
  | 'CONFIG_WRITE_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'BAD_REQUEST';

const ERROR_HTTP_STATUS: Record<SyncErrorCode, number> = {
  DOC_FETCH_FAILED: 502,
  DOC_PERMISSION_DENIED: 502,
  HEADER_DRIFT: 422,
  PARSE_FAILED: 500,
  CONFIG_WRITE_FAILED: 500,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
};

/** 可读中文（不暴露原始异常栈） */
const ERROR_MESSAGE: Record<SyncErrorCode, string> = {
  DOC_FETCH_FAILED: '拉取腾讯文档失败（网络/超时/限频/响应结构异常），请稍后重试',
  DOC_PERMISSION_DENIED: '文档不可读：权限可能已收紧或参数组失效（非「所有人可查看」状态）',
  HEADER_DRIFT: '表头结构漂移：文档列结构发生变更，已整批拒绝解析（静默解析已阻止）',
  PARSE_FAILED: '文档数据块解码失败（zlib/protobuf 层异常）',
  CONFIG_WRITE_FAILED: '同步指纹写入失败（已降级为内存幂等，重启后可能重复计数）',
  UNAUTHORIZED: '未授权 — 请先登录管理员账号',
  FORBIDDEN: '权限不足 — 需要 OWNER 或 ADMIN 角色',
  BAD_REQUEST: '请求参数不合法',
};

// ---------- 输入 ----------

interface SyncRequestBody {
  dryRun?: boolean;
}

// ---------- 行投影（响应结构） ----------

interface SyncRowPayload {
  rowIndex: number;
  cells: {
    submitter: string;
    submittedAt: string;
    project: string;
    testDate: string;
    tester: string;
    testee: string;
    testTier: string;
    /** v2 legacy：H 测试比分（v3 文档已无此列，恒空串） */
    score: string;
    /** v2 legacy：I 测试录屏（v3 文档已无此列，恒空串） */
    recording: string;
    /** v3：测试者胜场（H列原文，自 v2 K 列左移） */
    testeeWins: string;
    /** v3：考核员胜场（I列原文，自 v2 L 列左移） */
    testerWins: string;
    /** v3：测试评价（J列原文，活跃列，自 v2 M 列左移） */
    review: string;
    /** v2 legacy：测试评价（J列原文，已删除残留；v3 文档已无此列，恒空串） */
    legacyReview: string;
  };
  status: 'READY' | 'PLAYER_MISSING' | 'INVALID';
  reasons: string[];
  playerMatch: {
    tester: { status: string; playerName: string | null; pendingEntry: boolean };
    testee: { status: string; playerName: string | null; pendingEntry: boolean };
  };
  fingerprint: string;
  /** T4：内容指纹（cfp1，不含物理行号） */
  contentFp: string;
  /** T4：内容指纹（不含提交时间；同内容跨时间关联键） */
  contentFpNoTime: string;
  isDuplicate: boolean;
  /** T4：审批继承状态机判定（UI 五态展示数据源） */
  inheritance: {
    state: InheritanceState;
    matchedBy: string;
    matchedKeys: string[];
    matchedFirstSeenAt: string | null;
    /** 仅 A 态非空（自动继承的审批） */
    inheritedApproved: SyncStateFingerprintEntry['approved'] | null;
    /** 仅 LEGACY_UNVERIFIED 态非空（原审批存证，需人工核验） */
    legacyApprovedUnverified: SyncStateFingerprintEntry['approved'] | null;
    changedFields: ContentDiffItem[];
    ambiguity: string | null;
    duplicateInBatch: boolean;
    summary: string;
  };
  /** P2：AI 建议（仅供参考，无权勾选/写库） */
  aiSuggestion: AiSuggestion;
  /** P2：该行是否已审批写入（Config 指纹回填） */
  approved: SyncStateFingerprintEntry['approved'] | null;
  /** P2：测试项目→模式提示（UI 预选模式用；confidence 非 exact 时管理员须显式确认） */
  modeHint: { mode: string | null; confidence: string };
  /** R2：管理员拒绝标记（持久化；拒绝行不再是写入候选，仅撤销后恢复） */
  reviewRejected: { at: string; by: string; reason: string | null } | null;
  /** R2：回档标记（该行历史写入已被恢复；重新写入须显式确认） */
  rolledBack: { at: string; by: string } | null;
  /** R2：多字段重复检测（测试者+日期+考核者+项目+tier）疑似重复命中清单
   *  （不含与当前行同内容的逻辑同记录；approved=true 表示对方已写入——
   *  防重复录入的强信号；最多透出 5 条） */
  dupSuspects: Array<{ rowIndex: number; approved: boolean; at: string | null }>;
}

function projectRow(
  t: TierTicketRow,
  isDuplicate: boolean,
  contentSnapshot: ReturnType<typeof buildContentSnapshot>,
  decision: InheritanceDecision,
  /** 展示用审批标记：行指纹条目已存的 approved 优先（历史事实），
   *  其次 A 态继承标记（本次落盘）；B/C/D/legacy 恒 null（不得虚显「已写入」） */
  approvedDisplay: SyncStateFingerprintEntry['approved'] | null,
  /** R2 扩展（拒绝/回档/疑似重复） */
  reviewRejected: { at: string; by: string; reason: string | null } | null,
  rolledBack: { at: string; by: string } | null,
  dupSuspects: Array<{ rowIndex: number; approved: boolean; at: string | null }>,
): SyncRowPayload {
  const reasons = t.issues
    .filter(i => i.level === 'error' || i.level === 'warn')
    .map(i => i.message);
  return {
    rowIndex: t.sheetRow,
    cells: {
      submitter: t.submitter ?? '',
      submittedAt: t.submittedAt?.display ?? '',
      project: t.project.raw,
      testDate: t.testDate?.display ?? '',
      tester: t.tester.gameId,
      testee: t.testee.gameId,
      testTier: t.testTier.normalized ?? t.testTier.raw,
      score: t.score.raw,
      recording: t.recording,
      testeeWins: t.testeeWins.raw,
      testerWins: t.testerWins.raw,
      review: t.review.raw,
      legacyReview: t.legacyReview.raw,
    },
    status: t.status,
    reasons,
    playerMatch: {
      tester: {
        status: t.tester.matched.status,
        playerName: t.tester.matched.playerName,
        pendingEntry: t.tester.matched.pendingEntry,
      },
      testee: {
        status: t.testee.matched.status,
        playerName: t.testee.matched.playerName,
        pendingEntry: t.testee.matched.pendingEntry,
      },
    },
    fingerprint: t.fingerprint,
    contentFp: contentSnapshot.contentFp,
    contentFpNoTime: contentSnapshot.contentFpNoTime,
    isDuplicate,
    inheritance: {
      state: decision.state,
      matchedBy: decision.matchedBy,
      matchedKeys: decision.matchedKeys,
      matchedFirstSeenAt: decision.matchedFirstSeenAt,
      inheritedApproved: decision.inheritedApproved,
      legacyApprovedUnverified: decision.legacyApprovedUnverified,
      changedFields: decision.changedFields,
      ambiguity: decision.ambiguity,
      duplicateInBatch: decision.duplicateInBatch,
      summary: decision.summary,
    },
    aiSuggestion: suggestForTicketRow(t),
    approved: approvedDisplay ?? null,
    modeHint: { mode: t.project.modeHint.mode, confidence: t.project.modeHint.confidence },
    reviewRejected,
    rolledBack,
    dupSuspects,
  };
}

function errorResponse(code: SyncErrorCode, detail?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, code, message: ERROR_MESSAGE[code], ...detail },
    { status: ERROR_HTTP_STATUS[code] },
  );
}

// ---------- R3：清空检测 → 自动化缓存导入（重置展示，批复 2026-11-07） ----------

/**
 * 文档被清空时的降级响应：自动从批次快照缓存导入上次同步内容原样展示。
 * - 只读降级：不写水位、不写快照、不动文档（dryRun/真实同步同响应）；
 * - 有缓存 → rows=快照行 + cacheFallback meta（UI 横幅提示「已自动导入」）；
 * - 无缓存 → 空 rows + 明确警告（绝不假报成功导入）。
 */
async function wipedFallbackResponse(
  snapshot: OpendocSnapshot,
  dryRun: boolean,
  warnings: string[],
): Promise<NextResponse> {
  let cache: TierBatchCacheValue | null = null;
  try {
    cache = await readBatchCache();
  } catch {
    cache = null; // 读取异常按无缓存处理（下方警告路径）
  }
  const cachedRows = Array.isArray(cache?.rows) ? (cache!.rows as unknown[]) : [];
  const fallback = cachedRows.length > 0;
  if (fallback) {
    warnings.push(
      `检测到文档内容已被清空（0 数据行，表头亦为空）：已自动从本地缓存导入上次同步快照` +
      `（保存于 ${cache!.savedAt || '未知时刻'}，共 ${cachedRows.length} 行）—— 工单数据未丢失，` +
      `指纹水位与审批记录不受影响；文档恢复数据后重新同步即切回实时内容`,
    );
  } else {
    warnings.push(
      '检测到文档内容已被清空（0 数据行，表头亦为空）：本地无可用缓存快照，无法自动导入 —— 请尽快核实文档是否被误清空',
    );
  }
  return NextResponse.json({
    ok: true,
    dryRun,
    fetchedAt: snapshot.fetchedAt,
    docRowCount: 0,
    parsedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    newCount: 0,
    duplicateCount: 0,
    rows: fallback ? cachedRows : [],
    warnings,
    meta: {
      docId: snapshot.docId,
      tabId: snapshot.tabId,
      maxRow: snapshot.maxRow,
      maxCol: snapshot.maxCol,
      bytes: snapshot.bytes,
      schemaVersion: TICKET_SCHEMA_VERSION,
      statePersisted: false,
      auditPending: true,
      clearedDetected: true,
      cacheFallback: fallback ? { savedAt: cache!.savedAt, rowCount: cachedRows.length } : null,
    },
  });
}

// ---------- 主流程 ----------

export async function POST(request: Request) {
  // 1. 鉴权（OWNER / ADMIN）
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  // 2. 参数
  let dryRun = false;
  try {
    const body = (await request.json()) as SyncRequestBody | null;
    dryRun = body?.dryRun === true;
  } catch {
    dryRun = false; // 空 body / 非 JSON → 默认 false
  }

  const warnings: string[] = [];

  // 3. 拉取文档快照（只读）
  let snapshot: OpendocSnapshot;
  try {
    snapshot = await fetchSheetSnapshot();
  } catch (err) {
    if (err instanceof TencentDocError) {
      const permissionCodes = new Set(['HTTP_401', 'BLANKPAGE']);
      return errorResponse(
        permissionCodes.has(err.code) ? 'DOC_PERMISSION_DENIED' : 'DOC_FETCH_FAILED',
        { detail: { docErrorCode: err.code } },
      );
    }
    return errorResponse('DOC_FETCH_FAILED', { detail: { docErrorCode: 'UNKNOWN' } });
  }

  // 4. 解码数据块（zlib + protobuf；多块显式拒绝，不静默取第一块）
  let sheet: DecodedSheet;
  try {
    if (snapshot.relatedSheets.length !== 1) {
      throw new Error(`related_sheet 块数=${snapshot.relatedSheets.length}（非 1，需显式处理策略）`);
    }
    sheet = decodeRelatedSheet(snapshot.relatedSheets[0]!);
  } catch (err) {
    return errorResponse('PARSE_FAILED', {
      detail: { reason: err instanceof Error ? err.message : 'unknown decode error' },
    });
  }

  // 4.5 R3 清空检测（批复：「每当检测到清空时重置」）——
  //  仅「无数据行且表头亦为空」视为清空 → 自动缓存导入；
  //  表头仍在但列结构变更仍走 HEADER_DRIFT 整批拒绝（保护语义不混同）。
  if (isSheetWiped(sheet)) {
    return await wipedFallbackResponse(snapshot, dryRun, warnings);
  }

  // 5. P1-B 管线（含表头漂移守卫；玩家清单只读传入）
  const players = await db.player.findMany({ select: { id: true, name: true } });
  const built = buildTickets(sheet, { players });

  // 表头漂移 → 整批拒绝（不得静默解析）
  if (built.headerMismatches.length > 0) {
    return errorResponse('HEADER_DRIFT', { detail: { mismatches: built.headerMismatches } });
  }

  // 6. 幂等判定：Config 持久水位 + 批内顺序去重
  let state = { version: 1 as const, updatedAt: '', fingerprints: {} as Record<string, SyncStateFingerprintEntry> };
  let stateAvailable = true;
  try {
    state = await readSyncState();
  } catch {
    stateAvailable = false;
    warnings.push('同步指纹读取失败（本次按全部新增处理，不影响解析结果）');
  }

  const nowIso = new Date().toISOString();
  const pendingEntries: Record<string, SyncStateFingerprintEntry> = {};
  let newCount = 0;
  let duplicateCount = 0;
  const rows: SyncRowPayload[] = [];

  // T4 审批继承状态机：一次构建水位索引，整批复用（取代旧行号+targetName 继承）
  const classifier = createInheritanceClassifier(state);
  const batchByContentFp = new Map<string, number>(); // contentFp → 批内首张 rows 下标
  const stateCount: Record<InheritanceState, number> = {
    A_INHERITED: 0, B_CONTENT_CHANGED: 0, C_AMBIGUOUS: 0, D_NO_MATCH: 0, LEGACY_UNVERIFIED: 0,
  };
  let inheritedApprovedCount = 0;
  let legacyUnverifiedApprovedCount = 0;
  let batchDuplicateCount = 0;
  // T4：行移动取代记录（同内容工单换行 → 旧键标记 supersededBy，防永久歧义）
  const supersedes: Array<{ from: string; to: string }> = [];

  // R2 多字段重复检测：预建水位 dupKey 索引（跳过 superseded / 已回档条目；
  // 旧条目无 dupKey 时由内容快照复算，快照/要素缺失不参与比对）
  interface DupIndexValue { rowIndex: number; fingerprint: string; approved: boolean; approvedAt: string | null }
  const dupIndex = new Map<string, DupIndexValue[]>();
  if (stateAvailable) {
    for (const [fp, e] of Object.entries(state.fingerprints)) {
      if (e.supersededBy || e.rollback) continue;
      const dk = e.dupKey ?? dupKeyFromSnapshot(e.contentSnapshot);
      if (!dk) continue;
      const arr = dupIndex.get(dk) ?? [];
      arr.push({ rowIndex: e.rowIndex, fingerprint: fp, approved: !!e.approved, approvedAt: e.approved?.at ?? null });
      dupIndex.set(dk, arr);
    }
  }
  let approvedDupRowCount = 0;
  let unapprovedDupRowCount = 0;

  for (const t of built.tickets) {
    // 内容快照（T1 cfp1；E/F 原始格来自管线 cellTexts 透传）
    const contentSnapshot = buildContentSnapshot(ticketToSnapshotInput(t));

    let decision = classifier.classify({
      rowIndex: t.sheetRow,
      targetName: t.testee.gameId,
      snapshot: contentSnapshot,
    });

    // 批内内容重复检测：同 contentFp 第二次出现 → 强制 C_AMBIGUOUS（审批归属不明）
    const batchFirstIdx = batchByContentFp.get(contentSnapshot.contentFp);
    if (batchFirstIdx !== undefined) {
      decision = markBatchDuplicate(decision, batchFirstIdx + 1);
      batchDuplicateCount += 1;
    } else {
      batchByContentFp.set(contentSnapshot.contentFp, rows.length);
    }
    stateCount[decision.state] += 1;
    if (decision.state === 'A_INHERITED' && decision.inheritedApproved) inheritedApprovedCount += 1;
    if (decision.state === 'LEGACY_UNVERIFIED' && decision.legacyApprovedUnverified) legacyUnverifiedApprovedCount += 1;
    // A 态且命中键 ≠ 当前行键 = 内容移动到了新行：旧键待标记被取代（批次末统一处理）
    const aMatchedKey = decision.state === 'A_INHERITED' ? decision.matchedKeys[0] : undefined;
    if (aMatchedKey && aMatchedKey !== t.fingerprint) supersedes.push({ from: aMatchedKey, to: t.fingerprint });

    const exactEntry = stateAvailable ? state.fingerprints[t.fingerprint] ?? null : null;
    // 重复语义（T4）：行指纹已见 或 状态机命中任何历史关联（A/B/C/legacy）→ duplicate
    const isDuplicate = !!exactEntry || decision.state !== 'D_NO_MATCH';
    if (isDuplicate) duplicateCount += 1;
    else newCount += 1;

    // R2：多字段疑似重复检测（advisory，不拦截）——排除与当前行同内容的
    // 逻辑同记录（同 contentFp）；对方已写入 → 防重复录入强信号
    const dupKey = computeDupKey({
      testeeGameId: t.testee.gameId,
      testDateDisplay: t.testDate?.display ?? null,
      testerGameId: t.tester.gameId,
      projectRaw: t.project.raw,
      tier: t.testTier.normalized ?? t.testTier.raw,
    });
    const dupSuspects: Array<{ rowIndex: number; approved: boolean; at: string | null }> = [];
    if (dupKey) {
      for (const s of dupIndex.get(dupKey) ?? []) {
        const sEntry = state.fingerprints[s.fingerprint];
        if (sEntry?.contentSnapshot?.contentFp === contentSnapshot.contentFp) continue; // 逻辑同记录
        dupSuspects.push({ rowIndex: s.rowIndex, approved: s.approved, at: s.approvedAt });
        if (dupSuspects.length >= 5) break;
      }
    }
    if (dupSuspects.some(s => s.approved)) approvedDupRowCount += 1;
    else if (dupSuspects.length > 0) unapprovedDupRowCount += 1;

    pendingEntries[t.fingerprint] = {
      firstSeenAt: decision.matchedFirstSeenAt ?? nowIso, // 关联历史时间线；新工单为当前时刻
      lastSeenAt: nowIso,
      rowIndex: t.sheetRow,
      tier: t.testTier.normalized,
      status: t.status,
      targetName: t.testee.gameId || null,
      // T4：内容快照落盘（T5 审批完整快照校验 / T6 diff 展示数据源）
      contentSnapshot,
      // T4 硬约束：仅 A 态（唯一匹配且内容完全一致）自动继承审批标记；
      // B/C/D/LEGACY_UNVERIFIED 一律不继承（legacyUnverified 仅存证）
      approved: decision.state === 'A_INHERITED' ? decision.inheritedApproved : null,
      inheritanceState: decision.state,
      legacyApprovedUnverified: decision.legacyApprovedUnverified,
      // R2：重复检测组合键落盘（派生字段，随同步刷新）
      dupKey,
    };
    // 展示优先级：行指纹条目既存 approved（历史事实）> A 态继承 > null
    const approvedDisplay = exactEntry?.approved ?? decision.inheritedApproved ?? null;
    rows.push(projectRow(
      t,
      isDuplicate,
      contentSnapshot,
      decision,
      approvedDisplay,
      exactEntry?.reviewRejected ?? null,
      exactEntry?.rollback ? { at: exactEntry.rollback.at, by: exactEntry.rollback.by } : null,
      dupSuspects,
    ));
  }

  // 行移动取代落盘：原行已不在本批（被删除/移动走）→ 旧键标记 supersededBy；
  // 若原行仍在批内（其自身条目已写入 pendingEntries）→ 不取代（同内容多行=真歧义）
  for (const { from, to } of supersedes) {
    if (pendingEntries[from]) continue;
    const oldEntry = stateAvailable ? state.fingerprints[from] : undefined;
    if (!oldEntry) continue;
    pendingEntries[from] = { ...oldEntry, supersededBy: to, lastSeenAt: nowIso };
  }

  // 状态机判定汇总（替代旧「行号+被测玩家」迁移警告）
  const stateSummaryParts: string[] = [];
  if (stateCount.A_INHERITED > 0) {
    stateSummaryParts.push(`${stateCount.A_INHERITED} 行内容与历史完全一致（其中 ${inheritedApprovedCount} 行继承历史审批）`);
  }
  if (stateCount.B_CONTENT_CHANGED > 0) stateSummaryParts.push(`${stateCount.B_CONTENT_CHANGED} 行内容已变更需重新审核`);
  if (stateCount.C_AMBIGUOUS > 0) stateSummaryParts.push(`${stateCount.C_AMBIGUOUS} 行存在多个历史匹配需人工核对`);
  if (stateCount.LEGACY_UNVERIFIED > 0) {
    stateSummaryParts.push(`${stateCount.LEGACY_UNVERIFIED} 行命中无快照历史条目需人工核验（其中 ${legacyUnverifiedApprovedCount} 行带原审批存证）`);
  }
  if (stateCount.D_NO_MATCH > 0) stateSummaryParts.push(`${stateCount.D_NO_MATCH} 行无历史关联按新增处理`);
  if (stateSummaryParts.length > 0) warnings.push(`审批继承判定：${stateSummaryParts.join('；')}`);
  if (batchDuplicateCount > 0) warnings.push(`本批内 ${batchDuplicateCount} 行与同批其他行内容完全相同（歧义，已禁止自动继承）`);
  if (approvedDupRowCount > 0) {
    warnings.push(`${approvedDupRowCount} 行疑似重复录入：同「测试者+测试日期+考核者+项目+tier」的记录已写入（同内容硬拦截之外的多字段提醒，请人工裁决）`);
  }
  if (unapprovedDupRowCount > 0) {
    warnings.push(`${unapprovedDupRowCount} 行存在疑似重复的未处理记录（同测试者同日多张，请人工核对是否重复提交）`);
  }

  // 7. 持久化水位（dryRun 不写；写失败降级内存幂等 + CONFIG_WRITE_FAILED 警告）
  if (!dryRun && built.tickets.length > 0) {
    try {
      await mergeSyncState(pendingEntries, nowIso);
    } catch {
      warnings.push('同步指纹持久化失败（CONFIG_WRITE_FAILED）：本次结果有效，但重启后幂等水位回到内存');
    }
  } else if (!dryRun && built.tickets.length === 0) {
    warnings.push('本次解析 0 行，未写入指纹水位');
  }

  // 7.5 R3 批次快照缓存刷新（清空自动导入的数据源；dryRun 不写；写失败非致命）
  if (!dryRun && rows.length > 0) {
    try {
      await writeBatchCache({
        version: 1,
        savedAt: nowIso,
        tabId: snapshot.tabId,
        schemaVersion: TICKET_SCHEMA_VERSION,
        rowCount: rows.length,
        rows,
      });
    } catch {
      warnings.push('同步批次快照缓存写入失败（非致命）：若文档被清空，自动导入将缺少本次最新快照');
    }
  }

  // 8. 结构性警告透传（跨层 anomalies + 分页守卫；不改变 ok 语义）
  for (const a of built.anomalies) warnings.push(`结构异常：${a}`);
  if (snapshot.maxRow - 1 > snapshot.endRowRequested - 1) {
    warnings.push(`文档实际行数（${snapshot.maxRow - 1}）超出拉取窗口（${snapshot.endRowRequested - 1}），存在未拉取行 — 需人工扩窗`);
  }
  if (built.summary.duplicateFingerprintsInBatch > 0) {
    warnings.push(`本批内出现 ${built.summary.duplicateFingerprintsInBatch} 行指纹完全相同（同格内容重复提交）`);
  }

  // 9. 汇总
  const summary = {
    ok: true,
    dryRun,
    fetchedAt: snapshot.fetchedAt,
    docRowCount: built.summary.totalDataRows,
    parsedCount: built.tickets.length,
    successCount: built.summary.ready,
    failedCount: built.summary.invalid,
    skippedCount: built.summary.playerMissing,
    newCount,
    duplicateCount,
    rows,
    warnings,
    meta: {
      docId: snapshot.docId,
      tabId: snapshot.tabId,
      maxRow: snapshot.maxRow,
      maxCol: snapshot.maxCol,
      bytes: snapshot.bytes,
      /** v3：当前适配的文档结构版本（column-map.TICKET_SCHEMA_VERSION） */
      schemaVersion: TICKET_SCHEMA_VERSION,
      statePersisted: !dryRun && !warnings.some(w => w.includes('CONFIG_WRITE_FAILED')),
      // 审计：OperationLog 待审批写入阶段补审计（P2），本轮有意不写
      auditPending: true,
    },
  };

  return NextResponse.json(summary);
}
