import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdmin, requireRole } from '@/lib/auth';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// 认领审批 — PATCH /api/v1/claims/[id]
// 仅管理员（OWNER/ADMIN/MODERATOR，VIEWER 无审批权）。
// 审批 =「凭据转移 + 改状态 + 连带拒他条」三动作，必须全在
// $transaction 里原子完成 —— 整个功能唯一的并发风险点。
// 凭据转移（Player 即账号的绑定语义）：
//   target.email/passwordHash ← claimer（登录账号 或 register-direct 快照）
//   claimer 壳条目转回匿名（email/passwordHash = null）
// 目标条目若带管理员占位邮箱（虚拟邮箱）， approve 覆盖写入即完成
// 「占位邮箱 → 玩家正式邮箱」替换（批示 trace 1a1d027ae7f6abd1）。
// 可认领判据（同批修复）：拦截条件 email → passwordHash —— 无凭据即可
// 认领，带占位邮箱的代录条目不再被误判为已认领。
// 红线：不改任何分数/段位/感动榜数据。
// ============================================================

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await getCurrentAdmin();
    if (!admin) {
      return NextResponse.json({ error: '未授权 — 请先登录管理员账号', code: 'UNAUTHORIZED' }, { status: 401 });
    }
    const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR');
    if (guard.response) return guard.response;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action;
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'action 必须为 approve 或 reject' }, { status: 400 });
    }

    const result = await db.$transaction(async (tx) => {
      const claim = await tx.operationLog.findUnique({ where: { id } });
      if (!claim || claim.type !== 'CLAIM') {
        return { code: 404 as const, body: { error: '认领请求不存在' } };
      }
      if (claim.status !== 'pending') {
        return { code: 409 as const, body: { error: '该请求已处理过' } };
      }

      if (action === 'reject') {
        const updated = await tx.operationLog.update({
          where: { id },
          data: {
            status: 'rejected',
            detail: `${claim.detail} · 已拒绝`,
            updatedAt: new Date(),
          },
        });
        return { code: 200 as const, body: { ok: true, claim: updated } };
      }

      // ---- approve：先在事务内复核两边状态（防提交后竞态变化）----
      const target = claim.playerId ? await tx.player.findUnique({ where: { id: claim.playerId } }) : null;
      const claimer = claim.actorId ? await tx.player.findUnique({ where: { id: claim.actorId } }) : null;

      // ---- register-direct 分支（工单 2026-11-12）：无壳账号的直达认领 ----
      // 凭据不在 claimer 条目，而在申请快照 beforeData（只存 scrypt 哈希）。
      // 审批通过 = 目标条目虚拟邮箱替换为玩家正式邮箱 + 凭据落位；
      // 榜单数据（名字/段位/战绩/点赞）零触碰。
      if (action === 'approve' && !claim.actorId) {
        if (!target) {
          const updated = await tx.operationLog.update({
            where: { id },
            data: { status: 'rejected', detail: `${claim.detail} · 已拒绝（目标条目已不存在）`, updatedAt: new Date() },
          });
          return { code: 200 as const, body: { ok: true, note: '目标条目已不存在，已自动拒绝', claim: updated } };
        }
        if (target.passwordHash) {
          return { code: 409 as const, body: { error: '该条目已被认领（审批前状态变化）' } };
        }
        let creds: { claimEmail?: string; claimPasswordHash?: string; claimerNote?: string | null } = {};
        try { creds = JSON.parse(claim.beforeData || '{}'); } catch { creds = {}; }
        if (!creds.claimEmail || !creds.claimPasswordHash) {
          const updated = await tx.operationLog.update({
            where: { id },
            data: { status: 'rejected', detail: `${claim.detail} · 已拒绝（申请凭据缺失）`, updatedAt: new Date() },
          });
          return { code: 200 as const, body: { ok: true, note: '申请凭据缺失，已自动拒绝', claim: updated } };
        }
        // 竞态复核：邮箱在审批前被其他账号占用（批示 trace 1a1d04505a0fd5e9：
        // 撞「真账号」→ 409；撞「占位条目」（无凭据，虚拟邮箱）→ 原位清空
        // 后继续绑定 —— 占位邮箱本就是管理员代填的临时值，审批 = 人工确认）
        const emailClash = await tx.player.findFirst({ where: { email: creds.claimEmail, id: { not: target.id } } });
        if (emailClash) {
          if (emailClash.passwordHash) {
            return { code: 409 as const, body: { error: '该邮箱已被其他账号使用（审批前状态变化）' } };
          }
          await tx.player.update({ where: { id: emailClash.id }, data: { email: null } });
        }
        await tx.player.update({
          where: { id: target.id },
          data: { email: creds.claimEmail, passwordHash: creds.claimPasswordHash, lastLoginAt: new Date() },
        });
        const updated = await tx.operationLog.update({
          where: { id },
          data: { status: 'approved', detail: `${claim.detail} · 已通过（注册直达）`, updatedAt: new Date() },
        });
        // 同目标其余 pending 全部自动拒绝（竞态兜底）
        const rivalPendings = await tx.operationLog.findMany({
          where: { type: 'CLAIM', playerId: claim.playerId, status: 'pending', id: { not: id } },
        });
        for (const rival of rivalPendings) {
          await tx.operationLog.update({
            where: { id: rival.id },
            data: { status: 'rejected', detail: `${rival.detail} · 已拒绝（已被他人认领）`, updatedAt: new Date() },
          });
        }
        return { code: 200 as const, body: { ok: true, claim: updated } };
      }

      if (!target || !claimer) {
        // 目标或发起者条目已不存在 → 自动拒绝收尾（不留悬挂 pending）
        const updated = await tx.operationLog.update({
          where: { id },
          data: {
            status: 'rejected',
            detail: `${claim.detail} · 已拒绝（${!target ? '目标条目已不存在' : '发起者条目已不存在'}）`,
            updatedAt: new Date(),
          },
        });
        return { code: 200 as const, body: { ok: true, note: '目标或发起者条目已不存在，已自动拒绝', claim: updated } };
      }
      // 无凭据即可认领（管理员代录含占位邮箱形态）；有凭据 = 审批前已被真账号绑定
      if (target.passwordHash) {
        return { code: 409 as const, body: { error: '该条目已被认领（审批前状态变化）' } };
      }
      if (!claimer.email || !claimer.passwordHash) {
        // 发起者账号已失效（壳条目凭据被转移/清除）→ 自动拒绝
        const updated = await tx.operationLog.update({
          where: { id },
          data: {
            status: 'rejected',
            detail: `${claim.detail} · 已拒绝（发起者账号已失效）`,
            updatedAt: new Date(),
          },
        });
        return { code: 200 as const, body: { ok: true, note: '发起者账号已失效，已自动拒绝', claim: updated } };
      }

      // 竞态复核（批示 trace 1a1d04505a0fd5e9）：发起者邮箱若同时挂在其他
      // 占位条目上 → 原位清空后继续转移；被「真账号」持有则 409（UNIQUE 保护）
      const emailClash = await tx.player.findFirst({
        where: { email: claimer.email, id: { notIn: [target.id, claimer.id] } },
      });
      if (emailClash) {
        if (emailClash.passwordHash) {
          return { code: 409 as const, body: { error: '该邮箱已被其他账号使用（审批前状态变化）' } };
        }
        await tx.player.update({ where: { id: emailClash.id }, data: { email: null } });
      }

      // a. 发起者壳条目先转回匿名（email 有 UNIQUE 约束：必须先释放原邮箱，
      //    否则下一步把同一邮箱写到目标条目会撞 P2002。两步同在一个事务内，
      //    外部观察不到中间态。）
      //    注意：名字/段位/战绩/点赞等榜单数据一律不动。
      await tx.player.update({
        where: { id: claimer.id },
        data: { email: null, passwordHash: null },
      });
      // b. 凭据转移到目标条目
      await tx.player.update({
        where: { id: target.id },
        data: {
          email: claimer.email,
          passwordHash: claimer.passwordHash,
          lastLoginAt: claimer.lastLoginAt ?? new Date(),
        },
      });
      // c. 本条 approved
      const updated = await tx.operationLog.update({
        where: { id },
        data: { status: 'approved', detail: `${claim.detail} · 已通过`, updatedAt: new Date() },
      });
      // d. 同一目标的其余 pending 全部自动拒绝（竞态兜底）
      const rivalPendings = await tx.operationLog.findMany({
        where: { type: 'CLAIM', playerId: claim.playerId, status: 'pending', id: { not: id } },
      });
      for (const rival of rivalPendings) {
        await tx.operationLog.update({
          where: { id: rival.id },
          data: { status: 'rejected', detail: `${rival.detail} · 已拒绝（已被他人认领）`, updatedAt: new Date() },
        });
      }
      // e. 同一发起者的其余 pending 也拒绝（一人一条目）
      const selfPendings = await tx.operationLog.findMany({
        where: { type: 'CLAIM', actorId: claim.actorId, status: 'pending', id: { not: id } },
      });
      for (const other of selfPendings) {
        await tx.operationLog.update({
          where: { id: other.id },
          data: { status: 'rejected', detail: `${other.detail} · 已拒绝（已有生效认领）`, updatedAt: new Date() },
        });
      }

      return { code: 200 as const, body: { ok: true, claim: updated } };
    });

    // Player email/credentials were transferred on approve → bust cached
    // player lists (admin sees email) + stats. Reject-only paths don't
    // touch players, but busting unconditionally is cheap and safe.
    if (result.code === 200) bustPlayerCaches();
    return NextResponse.json(result.body, { status: result.code });
  } catch (error) {
    console.error('[claims] PATCH 审批失败:', error);
    return NextResponse.json({ error: '审批操作失败' }, { status: 500 });
  }
}
