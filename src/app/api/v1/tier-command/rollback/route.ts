// ============================================================
// Tier Command · 写入回档 API（R2：可审计的选择性回档）
// ------------------------------------------------------------
// GET  /api/v1/tier-command/rollback   → 列出可回档历史写入（候选评估）
// POST /api/v1/tier-command/rollback   → 执行选中项回档 { logIds: string[] }
//   鉴权：requireRole('OWNER','ADMIN')
//
// 需求映射（用户 2026-11-06 拍板）：
//   - 弹窗列出可回档历史操作（时间/操作人/涉及记录/变更内容）；
//   - 支持选择性回档（勾选任意子集）；
//   - 回档前展示恢复范围 + 二次确认（UI 层负责，API 只接受显式 logIds）；
//   - 回档后留完整日志（回档本身落 OperationLog，源操作日志永不删除）；
//   - 范围必须明确：恢复范围 = 该次写入改动的 tiers 字段（单字段精确恢复），
//     不动玩家其他字段（头像/战绩/点赞等），不删除玩家条目；
//   - 不误删他人数据 / 不覆盖回档后新记录：
//     硬门禁 = 玩家当前 tiers 必须与该次写入落库时的 afterData.tiers 逐字一致
//     （即该次写入的效果仍是最新状态）—— 期间任何其他段位变更（含后续工单
//     写入、手动编辑、更早的回档恢复）都会使字符串不再一致 → 该项禁止回档
//     并给出原因。该规则使「顺序撤销」合法（回滚最近一次后可继续回滚前一次），
//     而「跳过中间变更的跨越回滚」被硬禁止；
//   - 失败不得显示成功：逐项事务、逐项返回成功/失败与原因；
//   - 无可靠备份或范围不明时禁止执行并提示原因：
//     改动前/后快照缺失或不可解析 → blocked（无可靠备份）；
//     玩家条目已删除 → blocked；重复回档 → blocked。
//
// 恢复目标：
//   - 更新类写入（update）：恢复为 beforeData.tiers（该玩家写入前完整段位串）；
//   - 新建类写入（create，由工单自动建号）：恢复为 '{}'（空段位，保留条目）。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { readSyncState, type SyncStateValue } from '@/lib/tier-command/sync-state';
import { parseTiers } from '@/lib/tiers';
import { bustPlayerCaches } from '@/lib/cache';

export const dynamic = 'force-dynamic';

const SOURCE_DETAIL_PREFIX = 'tier-command 工单审批';
const CANDIDATE_LIMIT = 100;
const MAX_BATCH = 50;

// detail 落库范式（见 approve/route.ts）：
// tier-command 工单审批 · 行{rowIndex} · 指纹 {fp12} · {playerName} · {mode} {old}→{new}[ · 由工单自动创建玩家] · 操作人 {operator}
const DETAIL_RE =
  /^tier-command 工单审批 · 行(\d+) · 指纹 ([0-9a-f]+) · (.+) · ([A-Z_]+) (\S+)→(\S+)(?: · 由工单自动创建玩家)? · 操作人 (.+)$/;

interface ParsedSourceDetail {
  rowIndex: number;
  playerName: string;
  mode: string;
  tierFrom: string;
  tierTo: string;
  created: boolean;
}

function parseSourceDetail(detail: string): ParsedSourceDetail | null {
  const m = DETAIL_RE.exec(detail);
  if (!m) return null;
  return {
    rowIndex: Number(m[1]),
    playerName: m[3],
    mode: m[4],
    tierFrom: m[5],
    tierTo: m[6],
    created: detail.includes('由工单自动创建玩家'),
  };
}

/** 从 before/after 快照 JSON 中安全取 tiers 串；不可读返回 null（=无可靠备份） */
function tiersFromSnapshot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tiers?: unknown };
    return typeof parsed?.tiers === 'string' ? parsed.tiers : null;
  } catch {
    return null;
  }
}

// ---------- 候选评估 ----------

export interface RollbackCandidate {
  logId: string;
  at: string;
  operator: string;
  rowIndex: number | null;
  playerName: string | null;
  mode: string | null;
  tierFrom: string | null;
  tierTo: string | null;
  created: boolean;
  /** 关联的水位指纹（logId → state entry approved.logId 反查；可能因裁剪缺失） */
  fingerprint: string | null;
  /** 水位已标记回档（历史事实，不可重复回档） */
  stateRolledBack: boolean;
  /** 玩家当前该模式段位（回档前展示用） */
  currentTier: string | null;
  /** 恢复目标段位展示（created → '（空）'） */
  restoreTierDisplay: string;
  rollbackable: boolean;
  blockedReason: string | null;
}

interface EvalCore {
  rollbackable: boolean;
  blockedReason: string | null;
  playerExists: boolean;
  currentTiers: string | null;
  afterTiers: string | null;
  restoreTiers: string | null;
  restoreTierDisplay: string;
  stateFp: string | null;
  stateRolledBack: boolean;
}

/**
 * 核心评估（GET 全量评估与 POST 事务内复评共用同一套规则，两端结论一致）。
 * `playerTiers` / `logRow` 由调用方按上下文提供（GET 批量预取 / POST 事务内读取）。
 */
function evalCore(args: {
  logRow: { id: string; detail: string; beforeData: string | null; afterData: string | null; sessionId: string | null };
  parsed: ParsedSourceDetail | null;
  playerTiers: string | null;   // null = 玩家不存在
  state: SyncStateValue;
  mode: string;
}): EvalCore {
  const { logRow, parsed, playerTiers, state, mode } = args;

  // 水位反查：approved.logId === 源日志 id
  let stateFp: string | null = null;
  let stateRolledBack = false;
  for (const [fp, entry] of Object.entries(state.fingerprints)) {
    if (entry.approved?.logId === logRow.id) {
      stateFp = fp;
      stateRolledBack = !!entry.rollback;
      break;
    }
  }

  const fail = (reason: string, extra?: Partial<EvalCore>): EvalCore => ({
    rollbackable: false,
    blockedReason: reason,
    playerExists: playerTiers !== null,
    currentTiers: playerTiers,
    afterTiers: null,
    restoreTiers: null,
    restoreTierDisplay: parsed?.created ? '（空）' : '—',
    stateFp,
    stateRolledBack,
    ...extra,
  });

  if (!parsed) return fail('源日志详情不可解析（范围不明），禁止回档');
  if (stateRolledBack) return fail('该写入已被回档过（历史事实，不可重复回档）');
  if (playerTiers === null) return fail('玩家条目已不存在，无法回档');

  const afterTiers = tiersFromSnapshot(logRow.afterData);
  if (!afterTiers) return fail('缺少可读的改动后快照（范围不明），禁止回档');

  // 硬门禁：当前 tiers 必须与该次写入落库结果逐字一致（该写入效果仍是最新状态）
  if (playerTiers !== afterTiers) {
    return fail('该玩家段位在此操作之后已有其他变更，回档会覆盖后续变更，禁止执行', { afterTiers });
  }

  if (parsed.created) {
    // 新建写入：恢复为空段位（保留条目，不删除 —— 不误删任何数据）
    return {
      rollbackable: true,
      blockedReason: null,
      playerExists: true,
      currentTiers: playerTiers,
      afterTiers,
      restoreTiers: '{}',
      restoreTierDisplay: '（空）',
      stateFp,
      stateRolledBack,
    };
  }

  const beforeTiers = tiersFromSnapshot(logRow.beforeData);
  if (!beforeTiers) return fail('缺少可读的改动前快照（无可靠备份），禁止回档', { afterTiers });

  const restored = parseTiers(beforeTiers)[mode]?.tier ?? null;
  return {
    rollbackable: true,
    blockedReason: null,
    playerExists: true,
    currentTiers: playerTiers,
    afterTiers,
    restoreTiers: beforeTiers,
    restoreTierDisplay: restored ?? '（空）',
    stateFp,
    stateRolledBack,
  };
}

// ---------- GET：候选列表 ----------

export async function GET() {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  const state = await readSyncState();

  const logs = await db.operationLog.findMany({
    where: { detail: { startsWith: SOURCE_DETAIL_PREFIX } },
    orderBy: { createdAt: 'desc' },
    take: CANDIDATE_LIMIT,
  });

  // 批量预取：涉及的玩家 + 同玩家的其他 create/update 日志（顺序撤销判定）
  const playerIds = [...new Set(logs.map(l => l.sessionId).filter((v): v is string => !!v))];
  const players = playerIds.length > 0
    ? await db.player.findMany({ where: { id: { in: playerIds } }, select: { id: true, name: true, tiers: true } })
    : [];
  const playerById = new Map(players.map(p => [p.id, p]));

  const candidates: RollbackCandidate[] = [];
  for (const log of logs) {
    const parsed = parseSourceDetail(log.detail);
    const player = log.sessionId ? playerById.get(log.sessionId) : undefined;
    const core = evalCore({
      logRow: {
        id: log.id, detail: log.detail,
        beforeData: log.beforeData, afterData: log.afterData,
        sessionId: log.sessionId,
      },
      parsed,
      playerTiers: player?.tiers ?? null,
      state,
      mode: parsed?.mode ?? '',
    });
    candidates.push({
      logId: log.id,
      at: log.createdAt.toISOString(),
      operator: log.adminKey ?? '未知',
      rowIndex: parsed?.rowIndex ?? null,
      playerName: parsed?.playerName ?? player?.name ?? null,
      mode: parsed?.mode ?? null,
      tierFrom: parsed?.tierFrom ?? null,
      tierTo: parsed?.tierTo ?? null,
      created: parsed?.created ?? false,
      fingerprint: core.stateFp,
      stateRolledBack: core.stateRolledBack,
      currentTier: player ? (parseTiers(player.tiers)[parsed?.mode ?? '']?.tier ?? null) : null,
      restoreTierDisplay: core.restoreTierDisplay,
      rollbackable: core.rollbackable,
      blockedReason: core.blockedReason,
    });
  }

  return NextResponse.json({ ok: true, candidates });
}

// ---------- POST：执行回档（逐项事务，部分成功） ----------

interface RollbackItemResult {
  logId: string;
  playerName: string | null;
  status: 'ROLLED_BACK' | 'FAILED';
  code?: string;
  message?: string;
}

export async function POST(request: Request) {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;
  const operator = gate.admin!.username;
  const ip = request.headers.get('x-forwarded-for') || 'unknown';

  // a. 参数
  let body: { logIds?: unknown } | null = null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = null;
  }
  const ids = body?.logIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(v => typeof v !== 'string' || !v.trim())) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: 'logIds 必须为非空日志 id 数组' },
      { status: 400 },
    );
  }
  const logIds = [...new Set((ids as string[]).map(v => v.trim()))];
  if (logIds.length > MAX_BATCH) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: `单次回档条数超限（≤${MAX_BATCH}）` },
      { status: 400 },
    );
  }

  const state = await readSyncState();
  const results: RollbackItemResult[] = [];
  let rolledBackCount = 0;

  for (const logId of logIds) {
    type ItemOutcome = { status: 'ROLLED_BACK'; playerName: string } | { status: 'FAILED'; code: string; message: string };
    let outcome: ItemOutcome;
    try {
      outcome = await db.$transaction(async tx => {
        // 1. 源日志必须存在且确为工单审批写入（防伪造 logId）
        const log = await tx.operationLog.findUnique({ where: { id: logId } });
        if (!log || !log.detail.startsWith(SOURCE_DETAIL_PREFIX)) {
          return { status: 'FAILED' as const, code: 'LOG_NOT_FOUND', message: '源写入日志不存在（或非工单审批写入），拒绝回档' };
        }
        const parsed = parseSourceDetail(log.detail);
        if (!parsed) {
          return { status: 'FAILED' as const, code: 'LOG_UNPARSABLE', message: '源日志详情不可解析（范围不明），禁止回档' };
        }

        // 2. 事务内复评（与 GET 同一规则；以事务内最新数据为准，防评估与执行间窗口漂移）
        const player = log.sessionId
          ? await tx.player.findUnique({ where: { id: log.sessionId } })
          : null;
        const core = evalCore({
          logRow: {
            id: log.id, detail: log.detail,
            beforeData: log.beforeData, afterData: log.afterData,
            sessionId: log.sessionId,
          },
          parsed,
          playerTiers: player?.tiers ?? null,
          state,
          mode: parsed.mode,
        });
        if (!core.rollbackable || core.restoreTiers === null) {
          return { status: 'FAILED' as const, code: 'BLOCKED', message: core.blockedReason ?? '范围不明，禁止回档' };
        }

        // 3. 恢复 = 仅重写 tiers 字段（不触碰玩家其他字段，不删除条目）
        const beforeSnapshot = player
          ? JSON.stringify({
              name: player.name, avatarUrl: player.avatarUrl, tiers: player.tiers,
              overrideScores: player.overrideScores, stats: player.stats,
              likes: player.likes, emotionText: player.emotionText,
            })
          : null;
        const restoredPlayer = await tx.player.update({
          where: { id: player!.id },
          data: { tiers: core.restoreTiers },
        });
        const afterSnapshot = JSON.stringify({
          name: restoredPlayer.name, avatarUrl: restoredPlayer.avatarUrl, tiers: restoredPlayer.tiers,
          overrideScores: restoredPlayer.overrideScores, stats: restoredPlayer.stats,
          likes: restoredPlayer.likes, emotionText: restoredPlayer.emotionText,
        });

        // 4. 回档审计日志（回档后留完整日志；源日志永不删除）
        await tx.operationLog.create({
          data: {
            type: 'rollback',
            detail:
              `tier-command 回档 · 源日志 ${log.id.slice(0, 12)} · 行${parsed.rowIndex} · ${parsed.playerName} · ` +
              `${parsed.mode} ${parsed.tierTo}→${core.restoreTierDisplay}` +
              ` · 恢复范围：tiers 字段（不动玩家其他数据）` +
              ` · 原操作 ${log.adminKey ?? '未知'} @ ${log.createdAt.toISOString().slice(0, 19).replace('T', ' ')}` +
              ` · 操作人 ${operator}`,
            scoreChange: null,
            adminKey: operator,
            beforeData: beforeSnapshot,
            afterData: afterSnapshot,
            ip,
            sessionId: player!.id,
          },
        });

        // 5. 水位标记（best-effort：条目可能已被保留策略裁剪；裁剪时恢复依然有效，
        //    且当前-tiers≠afterTiers 规则天然防重复回档）
        if (core.stateFp) {
          const cfgRow = await tx.config.findUnique({ where: { key: 'tier_command_sync_state' } });
          if (cfgRow) {
            try {
              const s = JSON.parse(cfgRow.value) as {
                fingerprints?: Record<string, { approved?: { logId?: string } | null; rollback?: unknown } & Record<string, unknown>>;
                updatedAt?: string;
              };
              if (s.fingerprints?.[core.stateFp]) {
                s.fingerprints[core.stateFp].rollback = {
                  at: new Date().toISOString(), by: operator, sourceLogId: log.id,
                };
                s.updatedAt = new Date().toISOString();
                await tx.config.update({
                  where: { key: 'tier_command_sync_state' },
                  data: { value: JSON.stringify(s) },
                });
              }
            } catch { /* 水位损坏不影响恢复本体；防重复由 currentTiers!==afterTiers 兜底 */ }
          }
        }

        return { status: 'ROLLED_BACK' as const, playerName: parsed.playerName };
      });
    } catch {
      outcome = { status: 'FAILED', code: 'TX_FAILED', message: '回档事务执行失败（数据库异常），该项未变更' };
    }

    if (outcome.status === 'ROLLED_BACK') {
      rolledBackCount += 1;
      results.push({ logId, playerName: outcome.playerName, status: 'ROLLED_BACK' });
    } else {
      results.push({ logId, playerName: null, status: 'FAILED', code: outcome.code, message: outcome.message });
    }
  }

  if (rolledBackCount > 0) bustPlayerCaches();

  const failedCount = results.length - rolledBackCount;
  return NextResponse.json({
    ok: true,
    rolledBackCount,
    failedCount,
    results,
    message:
      rolledBackCount > 0
        ? `已回档 ${rolledBackCount} 项${failedCount > 0 ? `，${failedCount} 项被阻止（详见 results，未产生任何变更）` : ''}`
        : `没有任何项被回档${failedCount > 0 ? '（全部被安全规则阻止，未产生任何变更）' : ''}`,
  });
}
