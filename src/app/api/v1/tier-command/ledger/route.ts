// ============================================================
// Tier Command · 归档台账读取 API（TIER_RECORD_RECOGNITION_REBUILD_V1）
// ------------------------------------------------------------
// GET /api/v1/tier-command/ledger
//   鉴权：requireRole('OWNER','ADMIN')
//   行为：只读返回台账（UNIQUE 保留行，四层排序：玩家名→考核组合→测试日期
//         旧→新→提交者兜底）+ 管理员十态统计 + 最近批次日志。
//   纪律：零写入；原始值与标准化值双份透出。
//
// V2 增强（TIER_WORKSPACE_V2，读取端识别视图 —— 零写库/零数据修改）：
//   1. identity：名称与 Tier 分离识别视图（identity.ts 纯函数）——
//      紧贴尾缀（bad小杨HT5）不再并入玩家身份；词表外形态（MT4）只提示人工核对；
//      真名含 token 保留原名；同名不同 ID 绝不自动合并。
//   2. kd：K/D 语义映射（管理员定义 2026-11-09）——
//      H 列「测试者胜场」= K·击杀；I 列「考核员胜场」= D·死亡；两者均归属
//      被测玩家（测试者）。null = 未提供（绝不补 0 / 不推算）。
//   3. players：按玩家聚合视图（aggKey 逐行透出，前端可独立分组渲染）——
//      唯一匹配 → P:<playerId>；未匹配/歧义 → N:<纯名>（仅展示分组，不产生授权）。
//   4. 已确认累计 K/D：仅 CONFIRMED 且 UNIQUE 保留行累计（防重复累计）；
//      无任何带值已确认记录 → null（显示「未提供」，不显示 0）。
//   5. 本端点不修改 ingest 落库逻辑、不触 Player.tiers、不动评分公式。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { normalizeText, sortLedgerRecords } from '@/lib/tier-command/ingest';
import {
  resolveIdentity,
  buildIdentityIndex,
  identityAggKey,
  type IdentityView,
} from '@/lib/tier-command/identity';

export const dynamic = 'force-dynamic';

/** Player.tiers JSON → 非空段位条目（当前 Tier 展示；无可靠数据 → 空数组） */
function parseTiers(tiersJson: string): Array<{ mode: string; tier: string }> {
  try {
    const obj = JSON.parse(tiersJson) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => typeof v === 'string' && String(v).trim() !== '')
      .map(([mode, v]) => ({ mode, tier: String(v) }));
  } catch {
    return [];
  }
}

export async function GET() {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  const [records, dupes, batches, players] = await Promise.all([
    db.tierTicketRecord.findMany({ where: { mergeState: 'UNIQUE' } }),
    db.tierTicketRecord.findMany({
      where: { mergeState: 'MERGED_DUPLICATE' },
      select: { mergedIntoId: true, sourceRow: true, rowFingerprint: true, submitterRaw: true, submittedAtRaw: true, createdAt: true },
    }),
    db.tierSyncBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    // V2：榜单玩家索引（只读；用于身份匹配视图与当前 Tier 展示，绝不写回）
    db.player.findMany({ select: { id: true, name: true, tiers: true } }),
  ]);

  // ---- V2：识别索引与逐行 identity 视图 ----
  const idIndex = buildIdentityIndex(players.map(p => ({ id: p.id, name: p.name })));
  const playerTiersById = new Map(players.map(p => [p.id, parseTiers(p.tiers)]));

  // ---- 四层排序（§3.4：玩家名 → 考核组合 → 测试日期旧→新 → 提交者兜底）----
  const sorted = sortLedgerRecords(records.map(r => ({
    record: r,
    testeeId: normalizeText(r.testeeId),
    examinerId: normalizeText(r.examinerId),
    testDateIso: r.testDateIso,
    submitter: r.submitterNorm,
    submittedAtIso: r.submittedAtIso,
  })));

  // ---- 管理员十态统计（任务书 §八口径）----
  const hasFailedBatch = batches.some(b => !b.ok);
  const stats = {
    /** ① 已读取：最新批次的文档数据行总数（含墓碑/空行/垃圾，读取口径） */
    read: batches.find(b => b.ok)?.docRowCount ?? 0,
    /** ② 已识别：台账总行数（标准化完成并入账） */
    recognized: records.length + dupes.length,
    /** ③ 已合并：MERGED_DUPLICATE 来源行数 */
    merged: dupes.length,
    /** ④ 待核对：UNIQUE 且 PENDING_REVIEW */
    pendingReview: records.filter(r => r.processState === 'PENDING_REVIEW').length,
    /** ⑤ 待归档：UNIQUE 且 READY */
    ready: records.filter(r => r.processState === 'READY').length,
    /** ⑥ 已归档：UNIQUE 且 ARCHIVED */
    archived: records.filter(r => r.processState === 'ARCHIVED').length,
    /** ⑦ 待玩家确认 */
    playerPending: records.filter(r => r.confirmState === 'PLAYER_PENDING').length,
    /** ⑧ 已确认 */
    confirmed: records.filter(r => r.confirmState === 'CONFIRMED').length,
    /** ⑨ 有异议 */
    disputed: records.filter(r => r.confirmState === 'DISPUTED').length,
    /** ⑩ 同步失败：失败批次 或 ARCHIVE_FAILED 行 */
    syncFailed: records.filter(r => r.processState === 'ARCHIVE_FAILED').length + (hasFailedBatch ? 1 : 0),
    /** 补充口径（任务书 §八统计项） */
    playerGroupCount: new Set(records.map(r => normalizeText(r.testeeId).toLowerCase())).size,
    matchedCount: records.filter(r => r.matchState === 'MATCHED').length,
    notFoundCount: records.filter(r => r.matchState === 'NOT_FOUND').length,
    ambiguousCount: records.filter(r => r.matchState === 'NAME_AMBIGUOUS').length,
    uncertainCount: records.filter(r => r.matchState === 'UNCERTAIN').length,
    suspectGarbageCount: records.filter(r => r.suspectGarbage).length,
    /** 击杀/死亡缺失数：文档无对应列 → 恒=台账保留行数（如实显示，绝不补 0） */
    killsDeathsMissing: records.length,
    /** V2：名称与 Tier 疑似混淆行数（识别视图 needsReview 或后端身份歧义/存疑） */
    identityReviewCount: 0, // 落库后在下方回填
  };

  // 保留行 → 重复来源挂接
  const dupesByKeeper = new Map<string, Array<{ sourceRow: number; rowFingerprint: string; submitter: string; submittedAt: string; mergedAt: string }>>();
  for (const d of dupes) {
    if (!d.mergedIntoId) continue;
    const arr = dupesByKeeper.get(d.mergedIntoId) ?? [];
    arr.push({ sourceRow: d.sourceRow, rowFingerprint: d.rowFingerprint, submitter: d.submitterRaw, submittedAt: d.submittedAtRaw, mergedAt: d.createdAt.toISOString() });
    dupesByKeeper.set(d.mergedIntoId, arr);
  }

  // ---- 逐行视图（原始 + 标准化 + identity + kd + aggKey）----
  const rows = sorted.map(({ record: r }) => {
    const dupSources = JSON.parse(r.dupSourcesJson || '[]') as Array<{ sourceRow: number; submitter: string; submittedAt: string | null; mergedAt?: string }>;
    const extraDupes = dupesByKeeper.get(r.id) ?? [];
    const identity = resolveIdentity(r.testeeId, idIndex);
    // K/D 映射（管理员定义：H 测试者胜场=K·击杀；I 考核员胜场=D·死亡；均归属测试者）
    const killsProvided = r.testerWins !== null;
    const deathsProvided = r.assessorWins !== null;
    return {
      id: r.id,
      batchId: r.batchId,
      docId: r.docId,
      tabId: r.tabId,
      sourceRow: r.sourceRow,
      rowFingerprint: r.rowFingerprint,
      // 原始值（原样）
      raw: {
        submitter: r.submitterRaw,
        submittedAt: r.submittedAtRaw,
        project: r.projectRaw,
        testDate: r.testDateRaw,
        examiner: r.examinerRaw,
        testee: r.testeeRaw,
        testTier: r.testTierRaw,
        testerWins: r.testerWinsRaw,
        assessorWins: r.assessorWinsRaw,
        review: r.reviewRaw,
      },
      // 标准化值（双存）
      norm: {
        testDateIso: r.testDateIso,
        examinerId: r.examinerId,
        examinerTierCand: r.examinerTierCand,
        testeeId: r.testeeId,
        testeeTierCand: r.testeeTierCand,
        testTierNorm: r.testTierNorm,
        testerWins: r.testerWins,
        assessorWins: r.assessorWins,
        review: r.reviewNorm,
      },
      // V2：K/D 视图（owner=testee；null=未提供，绝不补 0；不再声明「文档未提供」——
      // 管理员定义 H/I 两列即 K/D 信源，字段级缺失才显示「未提供」）
      kd: {
        owner: 'testee' as const,
        kills: r.testerWins,
        killsProvided,
        deaths: r.assessorWins,
        deathsProvided,
      },
      // V2：名称与 Tier 分离识别视图（原始全文永不被改写，raw.testee 仍可追溯）
      identity,
      // V2：玩家聚合键（展示分组；不产生任何归档授权）
      aggKey: identityAggKey(identity),
      mergeState: r.mergeState,
      dupSourceCount: r.dupSourceCount,
      dupSources: [...dupSources, ...extraDupes.map(d => ({ sourceRow: d.sourceRow, submitter: d.submitter, submittedAt: d.submittedAt || null, mergedAt: d.mergedAt }))],
      matchState: r.matchState,
      matchedPlayerId: r.matchedPlayerId,
      suspectGarbage: r.suspectGarbage,
      processState: r.processState,
      confirmState: r.confirmState,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      disputedAt: r.disputedAt?.toISOString() ?? null,
      disputeReason: r.disputeReason,
      approveRef: r.approveRefJson ? (JSON.parse(r.approveRefJson) as Record<string, unknown>) : null,
      exemptNoConfirm: r.exemptNoConfirm,
      exemptNote: r.exemptNote,
      createdAt: r.createdAt.toISOString(),
    };
  });

  // ---- V2：按玩家聚合视图（真实数据计算，绝不写死）----
  interface AggEntry {
    aggKey: string;
    displayName: string;
    rawNameVariants: string[];
    tierCandidates: string[];
    matchedPlayerId: string | null;
    matchedPlayerName: string | null;
    currentTiers: Array<{ mode: string; tier: string }>;
    ticketCount: number;
    counts: { pendingReview: number; ready: number; archived: number; playerPending: number; confirmed: number; disputed: number };
    latestTestDate: string | null;
    confirmedKills: number | null;
    confirmedDeaths: number | null;
    needsReview: boolean;
    suspectGarbage: boolean;
    examiners: string[];
  }
  const aggMap = new Map<string, AggEntry>();
  for (const row of rows) {
    const v = row.identity;
    let g = aggMap.get(row.aggKey);
    if (!g) {
      g = {
        aggKey: row.aggKey,
        displayName: v.displayName,
        rawNameVariants: [],
        tierCandidates: [],
        matchedPlayerId: v.matchedPlayerId,
        matchedPlayerName: v.matchedPlayerName,
        currentTiers: v.matchedPlayerId ? (playerTiersById.get(v.matchedPlayerId) ?? []) : [],
        ticketCount: 0,
        counts: { pendingReview: 0, ready: 0, archived: 0, playerPending: 0, confirmed: 0, disputed: 0 },
        latestTestDate: null,
        confirmedKills: null,
        confirmedDeaths: null,
        needsReview: false,
        suspectGarbage: false,
        examiners: [],
      };
      aggMap.set(row.aggKey, g);
    }
    g.ticketCount += 1;
    if (!g.rawNameVariants.includes(v.rawName)) g.rawNameVariants.push(v.rawName);
    if (v.tierCandidate && !g.tierCandidates.includes(v.tierCandidate)) g.tierCandidates.push(v.tierCandidate);
    if (row.norm.examinerId && !g.examiners.includes(row.norm.examinerId)) g.examiners.push(row.norm.examinerId);
    if (row.processState === 'PENDING_REVIEW') g.counts.pendingReview += 1;
    if (row.processState === 'READY') g.counts.ready += 1;
    if (row.processState === 'ARCHIVED') g.counts.archived += 1;
    if (row.confirmState === 'PLAYER_PENDING') g.counts.playerPending += 1;
    if (row.confirmState === 'CONFIRMED') g.counts.confirmed += 1;
    if (row.confirmState === 'DISPUTED') g.counts.disputed += 1;
    const d = row.norm.testDateIso?.slice(0, 10) ?? null;
    if (d && (!g.latestTestDate || d > g.latestTestDate)) g.latestTestDate = d;
    if (v.needsReview) g.needsReview = true;
    if (row.matchState === 'NAME_AMBIGUOUS' || row.matchState === 'UNCERTAIN') g.needsReview = true;
    if (row.suspectGarbage) g.suspectGarbage = true;
    // 已确认累计 K/D：仅 CONFIRMED 且 UNIQUE 保留行（防重复累计）；缺失值跳过（不补 0）
    if (row.confirmState === 'CONFIRMED') {
      if (row.kd.killsProvided && row.kd.kills !== null) {
        g.confirmedKills = (g.confirmedKills ?? 0) + row.kd.kills;
      }
      if (row.kd.deathsProvided && row.kd.deaths !== null) {
        g.confirmedDeaths = (g.confirmedDeaths ?? 0) + row.kd.deaths;
      }
    }
  }
  // 玩家组显示名优先级：唯一匹配的 Player.name > 首个 SUFFIX 采信余串 > 首个原始全文
  const playersAgg = [...aggMap.values()].map(g => {
    let displayName = g.displayName;
    if (!g.matchedPlayerId) {
      const withSuffix = rows.find(r => r.aggKey === g.aggKey && r.identity.suffixSplit);
      displayName = withSuffix ? withSuffix.identity.displayName : (g.rawNameVariants[0] ?? g.displayName);
    } else if (g.matchedPlayerName) {
      displayName = g.matchedPlayerName;
    }
    return { ...g, displayName };
  });
  // 排序：需要核对的置顶 → 最近测试日期新→旧 → 工单数多→少 → 名称
  playersAgg.sort((a, b) => {
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
    const da = a.latestTestDate ?? '';
    const dbb = b.latestTestDate ?? '';
    if (da !== dbb) return dbb.localeCompare(da);
    if (a.ticketCount !== b.ticketCount) return b.ticketCount - a.ticketCount;
    return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN');
  });

  // 身份核对统计回填
  stats.identityReviewCount = rows.filter(r =>
    r.identity.needsReview || r.matchState === 'NAME_AMBIGUOUS' || r.matchState === 'UNCERTAIN',
  ).length;

  return NextResponse.json({
    ok: true,
    stats,
    records: rows,
    players: playersAgg,
    batches: batches.map(b => ({
      id: b.id,
      fetchedAt: b.fetchedAt.toISOString(),
      tabId: b.tabId,
      docRowCount: b.docRowCount,
      validRows: b.validRows,
      tombstoneRows: b.tombstoneRows,
      garbageRows: b.garbageRows,
      newRecords: b.newRecords,
      mergedDupes: b.mergedDupes,
      idempotentHits: b.idempotentHits,
      ok: b.ok,
      warnings: (() => { try { return JSON.parse(b.stateJson) as string[]; } catch { return []; } })(),
    })),
  });
}
