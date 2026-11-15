// ============================================================
// Tier Command · 人工审批写榜 API（P2 最终闭环）
// ------------------------------------------------------------
// POST /api/v1/tier-command/approve
//   鉴权：requireRole('OWNER','ADMIN')（缺一即拒：401/403）
//   入参：{ approvedRows: [{ rowIndex, fingerprint, playerName, tier, mode,
//                             createIfMissing? }] }
//   绝对硬约束（用户指令 2026-11-04，全部在代码中强制）：
//     - 逐行人工确认：approvedRows 为空/缺失 → 400（服务端不存在任何
//       「未列行也会被写入」的代码路径）
//     - 幂等：指纹不存在→拒；已审批→拒（ALREADY_APPROVED，严禁二次写榜）；
//       同请求内重复指纹→拒
//     - 复用现有业务逻辑：tier 写入走 src/lib/tiers.ts 的
//       parseTiers/setModeTier/serializeTiers（与 PUT players/[id] 同层），
//       before/after 快照落 OperationLog.beforeData/afterData（同 PUT 语义，
//       sessionId 挂 player.id 支持 Undo）
//     - 每行写入必落 OperationLog（操作人/工单指纹/行号/改动详情）
//     - 缺失玩家：仅当 createIfMissing=true 时在事务内先建号（只含名字）
//       再写 tier，日志标注「由工单自动创建玩家」；绝无静默自动创建
//     - 写榜对象（playerName）必须与同步快照 targetName（⑥列被测玩家）
//       一致，防 UI 篡改
//   部分成功：逐行独立事务，逐行返回成功/失败与原因
//
// T5 审批门禁·分级拦截（2026-11-05，方案 A 第二版 §五；纯函数模块
// approve-gate.ts，本路由为接线层）：
//   逐行写入前先过 evaluateApproveGate（消费 T4 随水位落盘的
//   inheritanceState/contentSnapshot 判定）：
//     ① entry.approved → ALREADY_APPROVED（既有硬拦截，不变；
//       事务内并发复查保留，与门禁互为纵深）
//     ② 同内容冲突（另一非 superseded 条目同 contentFp 已审批 / 本请求内
//       已写入同 contentFp）→ CONTENT_ALREADY_APPROVED（同一份内容仅允许
//       落榜一次）
//     ③ C_AMBIGUOUS → 未带 confirmAmbiguous=true 拒绝
//       （AMBIGUOUS_CONFIRMATION_REQUIRED：人工核对在 API 层强制落点）
//     ④ LEGACY_UNVERIFIED / 旧版未判定条目 → 未带 confirmLegacyUnverified=true
//       拒绝（LEGACY_CONFIRMATION_REQUIRED：内容不可核实需显式核验；
//       legacyApprovedUnverified 仅存证展示，绝不触发 ALREADY_APPROVED）
//     ⑤ A_INHERITED（历史未审批）/ B_CONTENT_CHANGED / D_NO_MATCH → 放行
//       （B 态重审 = 本次人工审批本身；diff 展示由 T6 UI 负责）
//   兼容性：confirm 两字段为可选入参，旧 UI 不传 → 存量/歧义工单按
//   fail-safe 拒绝（待 T6 UI 补勾选项后放行），其余行为不变。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { parseTiers, setModeTier, serializeTiers } from '@/lib/tiers';
import { ALL_MODES, type GameMode } from '@/lib/constants';
import { normalizeTier } from '@/lib/tier-command/column-map';
import { readSyncState } from '@/lib/tier-command/sync-state';
import { evaluateApproveGate } from '@/lib/tier-command/approve-gate';
import { bustPlayerCaches } from '@/lib/cache';

export const dynamic = 'force-dynamic';

// ---------- 入参与行级错误 ----------

interface ApprovedRowInput {
  rowIndex?: number;
  fingerprint?: string;
  playerId?: string;
  playerName?: string;
  tier?: string;
  mode?: string;
  createIfMissing?: boolean;
  /** T5：存量/历史条目人工核验确认（LEGACY_UNVERIFIED 或旧版未判定条目须 true 才放行） */
  confirmLegacyUnverified?: boolean;
  /** T5：歧义工单人工核对确认（C_AMBIGUOUS 须 true 才放行） */
  confirmAmbiguous?: boolean;
  /** R2：回档后重新写入确认（entry.approved 且 entry.rollback 时须 true 才放行） */
  confirmAfterRollback?: boolean;
}

type RowErrorCode =
  | 'ALREADY_APPROVED' | 'CONTENT_ALREADY_APPROVED'
  | 'LEGACY_CONFIRMATION_REQUIRED' | 'AMBIGUOUS_CONFIRMATION_REQUIRED'
  | 'REVIEW_REJECTED' | 'ROLLBACK_REWRITE_CONFIRM_REQUIRED'
  | 'FINGERPRINT_UNKNOWN' | 'ROW_SNAPSHOT_MISSING'
  | 'ROW_MISMATCH' | 'TIER_MISMATCH' | 'TIER_INVALID' | 'MODE_INVALID'
  | 'STATUS_NOT_APPROVABLE' | 'PLAYER_NOT_FOUND' | 'CREATE_CONFLICT'
  | 'DUPLICATE_IN_REQUEST' | 'INVALID_PAYLOAD';

const ROW_ERROR_MESSAGE: Record<RowErrorCode, string> = {
  ALREADY_APPROVED: '幂等拦截：该工单已审批写入过，拒绝二次写榜',
  // T5 以下三项为静态兜底文案；前置门禁拒绝时优先返回门禁动态文案（含存证/冲突详情）
  CONTENT_ALREADY_APPROVED: '同内容工单已审批写入过，拒绝二次写榜（同一份内容仅允许写入一次）',
  LEGACY_CONFIRMATION_REQUIRED: '存量工单内容一致性不可核实：需人工核验并显式确认后才能写入',
  AMBIGUOUS_CONFIRMATION_REQUIRED: '该工单历史审批归属存在歧义：需人工核对并显式确认后才能写入',
  REVIEW_REJECTED: '该记录已被管理员拒绝：不作为写入候选，须先撤销拒绝',
  ROLLBACK_REWRITE_CONFIRM_REQUIRED: '该工单写入已被回档恢复：重新写入须勾选「回档后重写确认」',
  FINGERPRINT_UNKNOWN: '工单指纹不存在：请先在「数据同步」拉取后再审批',
  ROW_SNAPSHOT_MISSING: '行快照缺失（旧版同步数据），请重新同步后审批',
  ROW_MISMATCH: '行号与指纹不匹配，拒绝写入',
  TIER_MISMATCH: 'tier 与同步快照不一致，拒绝写入（请重新同步后再审批）',
  TIER_INVALID: 'tier 不在词表（constants.ts），拒绝写入',
  MODE_INVALID: '缺少或非法的写入模式（mode），拒绝写入',
  STATUS_NOT_APPROVABLE: '该行状态不可审批（校验失败行须修复数据后重新同步）',
  PLAYER_NOT_FOUND: '玩家不存在且未勾选「创建并写入」',
  CREATE_CONFLICT: '创建玩家失败：同名玩家已存在（可能并发创建）',
  DUPLICATE_IN_REQUEST: '同一请求内出现重复工单指纹，仅处理第一条',
  INVALID_PAYLOAD: '行参数不合法（缺 rowIndex/fingerprint/playerName/tier/mode）',
};

interface RowResult {
  rowIndex: number;
  fingerprint: string;
  playerName: string | null;
  status: 'APPROVED' | 'REJECTED';
  code?: RowErrorCode;
  message?: string;
  playerId?: string;
  created?: boolean;
  logId?: string | null;
}

// ---------- 单行审批（独立事务；成功返回行结果，失败返回行错误） ----------

interface ApproveRowArgs {
  row: ApprovedRowInput;
  stored: {
    rowIndex: number;
    tier: string | null;
    status: string;
    targetName: string | null;
  };
  operator: string;
  ip: string;
}

async function approveRowInTransaction(args: ApproveRowArgs): Promise<RowResult> {
  const { row, stored, operator, ip } = args;
  const rowIndex = typeof row.rowIndex === 'number' ? row.rowIndex : -1;
  const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
  const fail = (code: RowErrorCode, playerName: string | null = null): RowResult =>
    ({ rowIndex, fingerprint, playerName, status: 'REJECTED', code, message: ROW_ERROR_MESSAGE[code] });

  // 参数完整性
  if (!fingerprint || typeof row.playerName !== 'string' || !row.playerName.trim() ||
      typeof row.tier !== 'string' || !row.tier || typeof row.mode !== 'string' || !row.mode) {
    return fail('INVALID_PAYLOAD');
  }
  const playerName = row.playerName.trim();

  // tier：词表校验 + 与同步快照一致（防篡改）
  const tierNorm = normalizeTier(row.tier);
  if (!tierNorm) return fail('TIER_INVALID', playerName);
  if (stored.tier && tierNorm !== stored.tier) return fail('TIER_MISMATCH', playerName);

  // mode：必须命中 GameMode 词表
  if (!(ALL_MODES as string[]).includes(row.mode)) return fail('MODE_INVALID', playerName);
  const mode = row.mode as GameMode;

  // 状态门禁：READY 直接可批；PLAYER_MISSING 须显式 createIfMissing；INVALID 拒绝
  const createIfMissing = row.createIfMissing === true;
  if (stored.status === 'INVALID') return fail('STATUS_NOT_APPROVABLE', playerName);
  if (stored.status === 'PLAYER_MISSING' && !createIfMissing) return fail('PLAYER_NOT_FOUND', playerName);

  // 行号一致性
  if (rowIndex !== stored.rowIndex) return fail('ROW_MISMATCH', playerName);

  // 写榜对象服务端真值校验（防 UI 篡改：名字必须来自同步快照的⑥列）
  if (stored.targetName && playerName !== stored.targetName) {
    return fail('TIER_MISMATCH', playerName); // 与快照不一致 → 同类防篡改拒绝
  }

  // ---- 事务：建号（如需）→ 写 tier → OperationLog → Config approved 标记 ----
  type RowTxResult = { error: RowErrorCode } | { error?: null; playerId: string; created: boolean; logId: string; playerName: string };
  try {
    const result: RowTxResult = await db.$transaction(async tx => {
      // 并发幂等加固：事务内重读 approved 标记，双击/并发二答仅一答生效；
      // R2：已回档条目（rollback 标记）不在此硬拦截 —— 门禁已改为显式确认通道
      const cfgNow = await tx.config.findUnique({ where: { key: 'tier_command_sync_state' } });
      if (cfgNow) {
        try {
          const now = JSON.parse(cfgNow.value) as { fingerprints?: Record<string, { approved?: unknown; rollback?: unknown }> };
          const cur = now.fingerprints?.[fingerprint];
          if (cur?.approved && !cur.rollback) {
            return { error: 'ALREADY_APPROVED' as RowErrorCode };
          }
        } catch { /* 解析失败则继续走外层校验 */ }
      }

      let player = await tx.player.findUnique({ where: { name: playerName } });
      let created = false;

      if (!player && !createIfMissing) {
        return { error: 'PLAYER_NOT_FOUND' as RowErrorCode };
      }

      const beforeSnapshot = player
        ? JSON.stringify({
            name: player.name, avatarUrl: player.avatarUrl, tiers: player.tiers,
            overrideScores: player.overrideScores, stats: player.stats,
            likes: player.likes, emotionText: player.emotionText,
          })
        : null;

      if (!player) {
        // 由工单自动创建玩家（管理员已显式勾选；只含名字+tier，其他留空）
        player = await tx.player.create({
          data: {
            name: playerName,
            tiers: serializeTiers(setModeTier({}, mode, tierNorm, 'manual')),
          },
        });
        created = true;
      } else {
        // 复用现有 tier 业务逻辑（与 PUT players/[id] 同层：parseTiers → setModeTier → serializeTiers 新格式）
        const nextTiers = serializeTiers(setModeTier(parseTiers(player.tiers), mode, tierNorm, 'manual'));
        player = await tx.player.update({ where: { id: player.id }, data: { tiers: nextTiers } });
      }

      const afterSnapshot = JSON.stringify({
        name: player.name, avatarUrl: player.avatarUrl, tiers: player.tiers,
        overrideScores: player.overrideScores, stats: player.stats,
        likes: player.likes, emotionText: player.emotionText,
      });

      const oldTier = beforeSnapshot
        ? (parseTiers((JSON.parse(beforeSnapshot).tiers as string) ?? null)[mode]?.tier ?? null)
        : null;

      const log = await tx.operationLog.create({
        data: {
          type: created ? 'create' : 'update',
          detail:
            `tier-command 工单审批 · 行${rowIndex} · 指纹 ${fingerprint.slice(0, 12)} · ` +
            `${playerName} · ${mode} ${oldTier ?? '无'}→${tierNorm}` +
            (created ? ' · 由工单自动创建玩家' : '') +
            ` · 操作人 ${operator}`,
          scoreChange: null,
          adminKey: operator,
          beforeData: beforeSnapshot,
          afterData: afterSnapshot,
          ip,
          sessionId: player.id, // 与 PUT 语义一致：挂实体，支持定向 Undo
        },
      });

      // Config：该工单状态 → approved（幂等拦截依据；与写榜同事务，原子）
      const cfgRow = await tx.config.findUnique({ where: { key: 'tier_command_sync_state' } });
      if (cfgRow) {
        try {
          const state = JSON.parse(cfgRow.value) as {
            version?: number; updatedAt?: string;
            fingerprints?: Record<string, { approved?: unknown } & Record<string, unknown>>;
          };
          if (state.fingerprints && state.fingerprints[fingerprint]) {
            state.fingerprints[fingerprint].approved = {
              at: new Date().toISOString(), by: operator, tier: tierNorm, mode,
              playerId: player.id, playerName, created, logId: log.id,
            };
            // R2：重新写入成功 → 清除回档标记（历史由回档审计日志承载；
            // 不清除会导致该记录永远处于「已回档」态、每次重写都要确认）
            state.fingerprints[fingerprint].rollback = null;
            state.updatedAt = new Date().toISOString();
            await tx.config.update({ where: { key: 'tier_command_sync_state' }, data: { value: JSON.stringify(state) } });
          }
        } catch { /* 状态 JSON 损坏不影响写榜本体；幂等由 ALREADY_APPROVED 前置校验兜底 */ }
      }

      return { playerId: player.id, created, logId: log.id, playerName };
    });

    if (result.error) return fail(result.error, playerName);
    return {
      rowIndex, fingerprint, playerName, status: 'APPROVED',
      playerId: result.playerId, created: result.created, logId: result.logId,
    };
  } catch {
    // 并发建号唯一键冲突等 → 行级失败（不回滚其他行）
    return fail('CREATE_CONFLICT', playerName);
  }
}

// ---------- 主流程 ----------

export async function POST(request: Request) {
  // a. 验权（OWNER / ADMIN）
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;
  const operator = gate.admin!.username;
  const ip = request.headers.get('x-forwarded-for') || 'unknown';

  // b. 参数校验：approvedRows 非空且合法（缺一即拒 400）
  let body: { approvedRows?: ApprovedRowInput[] } | null = null;
  try {
    body = (await request.json()) as { approvedRows?: ApprovedRowInput[] } | null;
  } catch {
    body = null;
  }
  const rows = body?.approvedRows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: 'approvedRows 为空或缺失：必须逐行勾选确认，严禁全量隐式写入' },
      { status: 400 },
    );
  }
  if (rows.length > 200) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: '单次审批行数超限（≤200），请分批写入' },
      { status: 400 },
    );
  }

  // 指纹水位（幂等与防篡改校验的服务端真值）
  const state = await readSyncState();

  const results: RowResult[] = [];
  const seenInRequest = new Set<string>();
  // T5：本请求内已成功写入行的 contentFp（同批同内容防双写；无快照行不登记）
  const inRequestApprovedContentFps = new Set<string>();
  for (const row of rows) {
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint : '';
    const rowIndex = typeof row.rowIndex === 'number' ? row.rowIndex : -1;
    const playerNameRaw = typeof row.playerName === 'string' ? row.playerName : null;

    // 同请求内重复指纹
    if (fingerprint && seenInRequest.has(fingerprint)) {
      results.push({
        rowIndex, fingerprint, playerName: playerNameRaw,
        status: 'REJECTED', code: 'DUPLICATE_IN_REQUEST', message: ROW_ERROR_MESSAGE.DUPLICATE_IN_REQUEST,
      });
      continue;
    }
    if (fingerprint) seenInRequest.add(fingerprint);

    // 指纹存在性
    const entry = fingerprint ? state.fingerprints[fingerprint] : undefined;
    if (!entry) {
      results.push({
        rowIndex, fingerprint, playerName: playerNameRaw,
        status: 'REJECTED', code: 'FINGERPRINT_UNKNOWN', message: ROW_ERROR_MESSAGE.FINGERPRINT_UNKNOWN,
      });
      continue;
    }

    // T5 审批门禁（分级拦截；取代原单层 ALREADY_APPROVED 前置检查，见文件头 ①–⑤）
    const gate = evaluateApproveGate(
      {
        fingerprint,
        entry,
        confirmLegacyUnverified: row.confirmLegacyUnverified === true,
        confirmAmbiguous: row.confirmAmbiguous === true,
        confirmAfterRollback: row.confirmAfterRollback === true,
      },
      { stateFingerprints: state.fingerprints, inRequestApprovedContentFps },
    );
    if (gate.action === 'REJECT') {
      results.push({
        rowIndex, fingerprint, playerName: playerNameRaw,
        status: 'REJECTED', code: gate.code, message: gate.message,
      });
      continue;
    }

    // 行快照完整性（targetName 为 P2 起同步时定格；旧数据须重新同步）
    if (entry.targetName === undefined || entry.targetName === null) {
      results.push({
        rowIndex, fingerprint, playerName: playerNameRaw,
        status: 'REJECTED', code: 'ROW_SNAPSHOT_MISSING', message: ROW_ERROR_MESSAGE.ROW_SNAPSHOT_MISSING,
      });
      continue;
    }

    const rowResult = await approveRowInTransaction({
      row,
      stored: {
        rowIndex: entry.rowIndex,
        tier: entry.tier,
        status: entry.status,
        targetName: entry.targetName,
      },
      operator,
      ip,
    });
    // T5：成功写入行登记其 contentFp，后续行过门禁时拦截同内容二次写入
    if (rowResult.status === 'APPROVED' && entry.contentSnapshot?.contentFp) {
      inRequestApprovedContentFps.add(entry.contentSnapshot.contentFp);
    }
    results.push(rowResult);
  }

  const approvedCount = results.filter(r => r.status === 'APPROVED').length;
  const rejectedCount = results.filter(r => r.status === 'REJECTED').length;

  // 玩家数据变更 → 失效缓存（与 PUT players/[id] 行为一致）
  if (approvedCount > 0) bustPlayerCaches();

  return NextResponse.json({
    ok: true,
    approvedCount,
    rejectedCount,
    results,
    message: approvedCount > 0
      ? `已写入 ${approvedCount} 行${rejectedCount > 0 ? `，${rejectedCount} 行被拒绝（详见 results）` : ''}`
      : '没有任何行被写入',
  });
}
