// ============================================================
// Tier Command · 记录级审核状态 API（R2：拒绝 / 撤销拒绝）
// ------------------------------------------------------------
// POST /api/v1/tier-command/review
//   鉴权：requireRole('OWNER','ADMIN')
//   入参：{ action: 'reject' | 'restore', fingerprints: string[], reason?: string }
//
// 需求映射（用户 2026-11-06 拍板）：
//   - 每条记录独立「通过」「拒绝」；拒绝状态持久化，后续同步不再作为候选；
//   - 仅管理员主动撤销才恢复；不删腾讯文档原始数据、不影响该测试者未来新记录；
//   - 每次操作落 OperationLog（时间/操作人/记录/原因），审计可追。
//
// 纪律：
//   - 拒绝不触碰 Player 数据、不删水位条目、不改腾讯文档 —— 仅在
//     Config 水位条目上标记 reviewRejected（合并语义：管理员事实已有值
//     优先，sync 永不覆盖/复活）；撤销 = 置 null（历史由日志承载）；
//   - 已写入（approved 且未回档）记录不可拒绝（写入结果不走候选通道）；
//   - 每条指纹独立记日志（detail 前缀 'tier-command 拒绝' /
//     'tier-command 撤销拒绝'，供总览日志面板分类展示）；
//   - 部分成功：逐指纹独立返回成功/失败与原因；失败绝不假报成功；
//   - 指纹单批上限 100（防滥用；UI 实际逐条/小批调用）。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { readSyncState, type SyncStateFingerprintEntry } from '@/lib/tier-command/sync-state';

export const dynamic = 'force-dynamic';

type ReviewAction = 'reject' | 'restore';

interface ReviewResult {
  fingerprint: string;
  targetName: string | null;
  rowIndex: number | null;
  status: 'OK' | 'FAILED';
  code?: string;
  message?: string;
}

const MAX_BATCH = 100;

function shortFp(fp: string): string {
  return fp.slice(0, 12);
}

export async function POST(request: Request) {
  // a. 验权
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;
  const operator = gate.admin!.username;
  const ip = request.headers.get('x-forwarded-for') || 'unknown';

  // b. 参数校验
  let body: { action?: string; fingerprints?: unknown; reason?: unknown } | null = null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = null;
  }
  const action = body?.action as ReviewAction | undefined;
  if (action !== 'reject' && action !== 'restore') {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: 'action 必须为 reject 或 restore' },
      { status: 400 },
    );
  }
  const fps = body?.fingerprints;
  if (!Array.isArray(fps) || fps.length === 0 || fps.some(f => typeof f !== 'string' || !f.trim())) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: 'fingerprints 必须为非空指纹数组' },
      { status: 400 },
    );
  }
  const fingerprints = [...new Set((fps as string[]).map(f => f.trim()))];
  if (fingerprints.length > MAX_BATCH) {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: `单次操作记录数超限（≤${MAX_BATCH}）` },
      { status: 400 },
    );
  }
  const reasonRaw = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  const reason = reasonRaw || null;

  // c. 读取水位（服务端真值）
  const state = await readSyncState();

  // d. 逐指纹前置校验（不落库；未知/非法指纹进失败列表）
  const results: ReviewResult[] = [];
  const okTargets: Array<{ fp: string; entry: SyncStateFingerprintEntry }> = [];
  const seen = new Set<string>();
  for (const fp of fingerprints) {
    if (seen.has(fp)) {
      results.push({ fingerprint: fp, targetName: null, rowIndex: null, status: 'FAILED', code: 'DUPLICATE_IN_REQUEST', message: '同一请求内重复指纹' });
      continue;
    }
    seen.add(fp);
    const entry = state.fingerprints[fp];
    if (!entry) {
      results.push({ fingerprint: fp, targetName: null, rowIndex: null, status: 'FAILED', code: 'FINGERPRINT_UNKNOWN', message: '工单指纹不存在（请先同步）' });
      continue;
    }
    if (action === 'reject') {
      if (entry.approved && !entry.rollback) {
        results.push({ fingerprint: fp, targetName: entry.targetName ?? null, rowIndex: entry.rowIndex, status: 'FAILED', code: 'ALREADY_APPROVED', message: '该记录已审批写入，不可拒绝（如需撤回请走回档）' });
        continue;
      }
      if (entry.reviewRejected) {
        results.push({ fingerprint: fp, targetName: entry.targetName ?? null, rowIndex: entry.rowIndex, status: 'FAILED', code: 'ALREADY_REJECTED', message: '该记录已处于拒绝状态' });
        continue;
      }
    } else {
      if (!entry.reviewRejected) {
        results.push({ fingerprint: fp, targetName: entry.targetName ?? null, rowIndex: entry.rowIndex, status: 'FAILED', code: 'NOT_REJECTED', message: '该记录未处于拒绝状态，无需撤销' });
        continue;
      }
    }
    okTargets.push({ fp, entry });
  }

  // e. 落库（单事务：水位标记 + 每指纹一条审计日志）
  if (okTargets.length > 0) {
    const nowIso = new Date().toISOString();
    try {
      await db.$transaction(async tx => {
        // e1. 水位定向修改（事务内读-改-写，与 mergeSyncState 同并发纪律；
        //     Config 行不存在 = 尚未同步过 → 指纹必然不存在，理论不达；
        //     水位 JSON 损坏 → 抛错整体失败，绝不假报成功）
        const cfgRow = await tx.config.findUnique({ where: { key: 'tier_command_sync_state' } });
        if (!cfgRow) throw new Error('SYNC_STATE_MISSING');
        let current: { fingerprints?: Record<string, { reviewRejected?: unknown } & Record<string, unknown>> } | null = null;
        try {
          current = JSON.parse(cfgRow.value) as typeof current;
        } catch {
          throw new Error('SYNC_STATE_CORRUPT');
        }
        if (!current?.fingerprints || typeof current.fingerprints !== 'object') {
          throw new Error('SYNC_STATE_CORRUPT');
        }
        for (const { fp } of okTargets) {
          const entry = current.fingerprints[fp];
          if (!entry) throw new Error('SYNC_STATE_ENTRY_MISSING');
          entry.reviewRejected = action === 'reject'
            ? { at: nowIso, by: operator, reason }
            : null; // 撤销拒绝：清除标记（历史由日志承载）
        }
        current.updatedAt = nowIso;
        await tx.config.update({
          where: { key: 'tier_command_sync_state' },
          data: { value: JSON.stringify(current) },
        });

        // e2. 每指纹一条审计日志（时间/操作人/记录/原因）
        for (const { fp, entry } of okTargets) {
          const label = entry.targetName
            ? `${entry.targetName} · 行${entry.rowIndex ?? '?'}`
            : `行${entry.rowIndex ?? '?'}`;
          await tx.operationLog.create({
            data: {
              type: action === 'reject' ? 'review-reject' : 'review-restore',
              detail:
                action === 'reject'
                  ? `tier-command 拒绝 · 指纹 ${shortFp(fp)} · ${label} · 原因 ${reason ?? '（未填写）'} · 操作人 ${operator}`
                  : `tier-command 撤销拒绝 · 指纹 ${shortFp(fp)} · ${label} · 操作人 ${operator}`,
              scoreChange: null,
              adminKey: operator,
              ip,
              sessionId: null,
            },
          });
        }
      });
    } catch (err) {
      // 写库失败：整体失败（不假报成功；已失败的前置校验项照常返回）
      const corrupt = err instanceof Error && err.message.startsWith('SYNC_STATE_');
      return NextResponse.json(
        {
          ok: false,
          code: 'REVIEW_WRITE_FAILED',
          message: corrupt
            ? '审核状态写入失败（同步水位数据缺失/损坏，禁止操作以保护数据一致性）'
            : '审核状态写入失败（数据库异常），未产生任何变更',
          results,
        },
        { status: 500 },
      );
    }

    // e3. 成功项填充结果
    for (const { fp, entry } of okTargets) {
      results.push({
        fingerprint: fp,
        targetName: entry.targetName ?? null,
        rowIndex: entry.rowIndex,
        status: 'OK',
        message: action === 'reject' ? '已拒绝（后续同步不再作为写入候选）' : '已撤销拒绝（恢复为候选）',
      });
    }
  }

  const okCount = results.filter(r => r.status === 'OK').length;
  const failCount = results.filter(r => r.status === 'FAILED').length;

  return NextResponse.json({
    ok: true,
    action,
    okCount,
    failCount,
    results,
    message:
      okCount > 0
        ? action === 'reject'
          ? `已拒绝 ${okCount} 条记录${failCount > 0 ? `，${failCount} 条操作被拒绝（详见 results）` : ''}`
          : `已撤销拒绝 ${okCount} 条记录${failCount > 0 ? `，${failCount} 条操作被拒绝（详见 results）` : ''}`
        : '没有任何记录被变更',
  });
}
