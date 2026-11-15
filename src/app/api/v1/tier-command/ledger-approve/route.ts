// ============================================================
// Tier Command · 归档台账审批写榜 API（TIER_RECORD_RECOGNITION_REBUILD_V1）
// ------------------------------------------------------------
// POST /api/v1/tier-command/ledger-approve
//   鉴权：requireRole('OWNER','ADMIN')
//   入参：{ recordId, tier, mode, createIfMissing?, confirmSuspectGarbage? }
//   行为：对台账 UNIQUE 且 READY 的保留行执行人工审批归档（与现行 approve
//         链同纪律的写榜事务）：
//     - 复用 src/lib/tiers.ts parseTiers/setModeTier/serializeTiers 写
//       Player.tiers（与 PUT players/[id] 同层）；绝不写 Player.stats
//       （决策点 5：胜场≠kills/deaths/wins/matches 语义，不改评分红线）；
//     - tier 必须与台账 testTierNorm 一致（防 UI 篡改，同 approve route）；
//     - 幂等：非 READY / 已归档 → 拒绝（严禁二次写榜）；
//     - 跨通道防双写：现行 sync 水位中同 dupKey 条目已 approved → 拒绝
//       （CONTENT_ALREADY_APPROVED；同一逻辑工单不允许双通道重复落榜）；
//     - 每次写入必落 OperationLog（before/after 快照同 PUT 语义）；
//     - 确认流挂接（§3.7）：写入后 matchedPlayerId 存在且玩家已注册 →
//       confirmState=PLAYER_PENDING；未注册/无匹配 → 自动豁免留痕
//       （exemptNoConfirm=true + exemptNote，决策点 3-A）。
//   逐条人工确认：单条端点，不存在「未列行也会被写入」的代码路径。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { parseTiers, setModeTier, serializeTiers } from '@/lib/tiers';
import { ALL_MODES, type GameMode } from '@/lib/constants';
import { normalizeTier } from '@/lib/tier-command/column-map';
import { readSyncState } from '@/lib/tier-command/sync-state';
import { computeDupKey } from '@/lib/tier-command/duplicate-detect';
import { bustPlayerCaches } from '@/lib/cache';

export const dynamic = 'force-dynamic';

type ErrorCode =
  | 'BAD_REQUEST' | 'RECORD_NOT_FOUND' | 'NOT_APPROVABLE' | 'NOT_READY'
  | 'TIER_INVALID' | 'TIER_MISMATCH' | 'MODE_INVALID' | 'PLAYER_NOT_FOUND'
  | 'SUSPECT_GARBAGE_CONFIRM_REQUIRED' | 'CONTENT_ALREADY_APPROVED' | 'INTERNAL';

const HTTP: Record<ErrorCode, number> = {
  BAD_REQUEST: 400, RECORD_NOT_FOUND: 404, NOT_APPROVABLE: 409, NOT_READY: 409,
  TIER_INVALID: 422, TIER_MISMATCH: 422, MODE_INVALID: 422, PLAYER_NOT_FOUND: 409,
  SUSPECT_GARBAGE_CONFIRM_REQUIRED: 422, CONTENT_ALREADY_APPROVED: 409, INTERNAL: 500,
};

const MSG: Record<ErrorCode, string> = {
  BAD_REQUEST: '请求参数不合法（缺 recordId/tier/mode）',
  RECORD_NOT_FOUND: '台账记录不存在',
  NOT_APPROVABLE: '幂等拦截：该记录已归档写入过，拒绝二次写榜',
  NOT_READY: '该记录当前状态不可归档（待核对/已合并行须先处理；重复来源自动并入保留行）',
  TIER_INVALID: 'tier 不在词表（constants.ts），拒绝写入',
  TIER_MISMATCH: 'tier 与台账识别结果不一致，拒绝写入（防篡改校验）',
  MODE_INVALID: '缺少或非法的写入模式（mode），拒绝写入',
  PLAYER_NOT_FOUND: '玩家不存在且未勾选「创建并写入」（绝不静默自动创建）',
  SUSPECT_GARBAGE_CONFIRM_REQUIRED: '该记录疑似垃圾/残留数据：须显式勾选确认后才可归档',
  CONTENT_ALREADY_APPROVED: '同一逻辑工单已通过其他通道（整理表同步）审批写入，拒绝重复落榜',
  INTERNAL: '归档事务失败（未写入；可安全重试）',
};

interface ApproveBody {
  recordId?: string;
  tier?: string;
  mode?: string;
  createIfMissing?: boolean;
  /** 疑似垃圾行人工裁决确认（suspectGarbage=true 的记录须显式 true） */
  confirmSuspectGarbage?: boolean;
}

export async function POST(request: Request) {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;
  const operator = gate.admin!.username;
  const ip = request.headers.get('x-forwarded-for') || 'unknown';

  let body: ApproveBody | null = null;
  try {
    body = (await request.json()) as ApproveBody | null;
  } catch {
    body = null;
  }
  const recordId = typeof body?.recordId === 'string' ? body.recordId : '';
  const tierInput = typeof body?.tier === 'string' ? body.tier : '';
  const modeInput = typeof body?.mode === 'string' ? body.mode : '';
  if (!recordId || !tierInput || !modeInput) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: MSG.BAD_REQUEST }, { status: HTTP.BAD_REQUEST });
  }

  // ---- 台账记录（服务端真值）----
  const record = await db.tierTicketRecord.findUnique({ where: { id: recordId } });
  if (!record) {
    return NextResponse.json({ ok: false, code: 'RECORD_NOT_FOUND', message: MSG.RECORD_NOT_FOUND }, { status: HTTP.RECORD_NOT_FOUND });
  }
  if (record.mergeState !== 'UNIQUE' || record.processState !== 'READY') {
    const code = record.processState === 'ARCHIVED' ? 'NOT_APPROVABLE' : 'NOT_READY';
    return NextResponse.json({ ok: false, code, message: MSG[code] }, { status: HTTP[code] });
  }
  if (record.suspectGarbage && body?.confirmSuspectGarbage !== true) {
    return NextResponse.json({ ok: false, code: 'SUSPECT_GARBAGE_CONFIRM_REQUIRED', message: MSG.SUSPECT_GARBAGE_CONFIRM_REQUIRED }, { status: HTTP.SUSPECT_GARBAGE_CONFIRM_REQUIRED });
  }

  // ---- tier/mode 校验（与台账识别结果一致，防篡改）----
  const tierNorm = normalizeTier(tierInput);
  if (!tierNorm) {
    return NextResponse.json({ ok: false, code: 'TIER_INVALID', message: MSG.TIER_INVALID }, { status: HTTP.TIER_INVALID });
  }
  if (record.testTierNorm && tierNorm !== record.testTierNorm) {
    return NextResponse.json({ ok: false, code: 'TIER_MISMATCH', message: MSG.TIER_MISMATCH }, { status: HTTP.TIER_MISMATCH });
  }
  if (!(ALL_MODES as string[]).includes(modeInput)) {
    return NextResponse.json({ ok: false, code: 'MODE_INVALID', message: MSG.MODE_INVALID }, { status: HTTP.MODE_INVALID });
  }
  const mode = modeInput as GameMode;

  // ---- 跨通道防双写（现行 sync 水位 dupKey 已 approved → 拒绝）----
  const ledgerDupKey = computeDupKey({
    testeeGameId: record.testeeId,
    testDateDisplay: record.testDateIso ? record.testDateIso.slice(0, 10) : null,
    testerGameId: record.examinerId,
    projectRaw: record.projectRaw,
    tier: record.testTierNorm ?? record.testTierRaw,
  });
  if (ledgerDupKey) {
    const state = await readSyncState();
    for (const e of Object.values(state.fingerprints)) {
      if (e.supersededBy || e.rollback) continue;
      const eDupKey = e.dupKey ?? null;
      if (eDupKey === ledgerDupKey && e.approved) {
        return NextResponse.json(
          { ok: false, code: 'CONTENT_ALREADY_APPROVED', message: `${MSG.CONTENT_ALREADY_APPROVED}（写入人 ${e.approved.by} @ ${e.approved.at.slice(0, 19).replace('T', ' ')}）` },
          { status: HTTP.CONTENT_ALREADY_APPROVED },
        );
      }
    }
  }

  // ---- 事务：建号（如需）→ 写 tier → OperationLog → 台账状态流转 ----
  const playerName = record.testeeId.trim();
  const createIfMissing = body?.createIfMissing === true;

  type TxResult = { error: ErrorCode } | {
    error?: null; playerId: string; created: boolean; logId: string;
    confirmState: string; exempt: boolean; exemptNote: string | null;
  };

  let result: TxResult;
  try {
    result = await db.$transaction(async tx => {
      // 并发幂等加固：事务内重读状态（双击/并发仅一次生效）
      const recNow = await tx.tierTicketRecord.findUnique({ where: { id: record.id } });
      if (!recNow || recNow.processState !== 'READY' || recNow.mergeState !== 'UNIQUE') {
        return { error: 'NOT_APPROVABLE' as ErrorCode };
      }

      let player = await tx.player.findUnique({ where: { name: playerName } });
      let created = false;
      if (!player && !createIfMissing) {
        return { error: 'PLAYER_NOT_FOUND' as ErrorCode };
      }

      const beforeSnapshot = player
        ? JSON.stringify({
            name: player.name, avatarUrl: player.avatarUrl, tiers: player.tiers,
            overrideScores: player.overrideScores, stats: player.stats,
            likes: player.likes, emotionText: player.emotionText,
          })
        : null;

      if (!player) {
        // 管理员显式勾选后的建号（只含名字+tier，其他留空；与现行 approve 同语义）
        player = await tx.player.create({
          data: { name: playerName, tiers: serializeTiers(setModeTier({}, mode, tierNorm, 'manual')) },
        });
        created = true;
      } else {
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
            `tier-ledger 归档审批 · 台账记录 ${record.id.slice(0, 8)} · 来源行 ${record.sourceRow} · ` +
            `指纹 ${record.rowFingerprint.slice(0, 12)} · ${playerName} · ${mode} ${oldTier ?? '无'}→${tierNorm}` +
            (created ? ' · 由台账归档创建玩家' : '') +
            ` · 测试者胜场 ${record.testerWinsRaw || '未填'} / 考核员胜场 ${record.assessorWinsRaw || '未填'}（独立记录，不参与评分）` +
            ` · 操作人 ${operator}`,
          scoreChange: null,
          adminKey: operator,
          beforeData: beforeSnapshot,
          afterData: afterSnapshot,
          ip,
          sessionId: player.id, // 与 PUT 语义一致：挂实体，支持定向 Undo
        },
      });

      // ---- 确认流挂接（§3.7 + 决策点 3-A）----
      // 已注册玩家（email+passwordHash）→ 待玩家确认；未注册/新建 → 自动豁免留痕
      const registered = !!(player.email && player.passwordHash);
      const confirmState = registered ? 'PLAYER_PENDING' : 'NONE';
      const exempt = !registered;
      const exemptNote = registered ? null : '玩家未注册，无确认通道（自动豁免）';

      await tx.tierTicketRecord.update({
        where: { id: record.id },
        data: {
          processState: 'ARCHIVED',
          matchState: 'MATCHED',
          matchedPlayerId: player.id,
          confirmState,
          exemptNoConfirm: exempt,
          exemptNote,
          approveRefJson: JSON.stringify({
            at: new Date().toISOString(),
            by: operator,
            tier: tierNorm,
            mode,
            playerId: player.id,
            playerName,
            created,
            logId: log.id,
          }),
        },
      });

      return {
        playerId: player.id, created, logId: log.id,
        confirmState, exempt, exemptNote,
      };
    });
  } catch {
    return NextResponse.json({ ok: false, code: 'INTERNAL', message: MSG.INTERNAL }, { status: HTTP.INTERNAL });
  }

  if ('error' in result && result.error) {
    return NextResponse.json({ ok: false, code: result.error, message: MSG[result.error] }, { status: HTTP[result.error] });
  }

  bustPlayerCaches();
  const r = result as { error?: null; playerId: string; created: boolean; logId: string; confirmState: string; exempt: boolean; exemptNote: string | null };
  return NextResponse.json({
    ok: true,
    recordId: record.id,
    playerId: r.playerId,
    created: r.created,
    logId: r.logId,
    confirmState: r.confirmState,
    exemptNoConfirm: r.exempt,
    exemptNote: r.exemptNote,
    message: r.exempt
      ? `已归档写入 ${playerName}（${mode} → ${tierNorm}）；玩家未注册已自动豁免确认环节（留痕）`
      : `已归档写入 ${playerName}（${mode} → ${tierNorm}）；已进入「待玩家确认」`,
  });
}
