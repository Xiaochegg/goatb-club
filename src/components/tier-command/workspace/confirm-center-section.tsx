'use client';

// ============================================================
// Tier Workspace V2 · SECTION 05 玩家确认中心
// ------------------------------------------------------------
// 工单 §三.S5：完整保留玩家确认机制（复用现有玩家身份、通知与成长记录
// 机制，不另建重复系统）：
//   1. 管理员审核工单 → 2. 提交待确认记录 → 3. 玩家本人收到确认信息 →
//   4. 玩家确认或提出异议 → 5. 确认后写入正式成长记录 → 6. 异议进入人工核对。
// 本区为只读视图：待确认队列 + 异议队列（原因原文）+ 流程说明；
// 未确认的记录不能被标记为正式确认（由后端门禁保证，本区不提供越权按钮）。
// ============================================================

import { AlertTriangle, UserCheck, Inbox } from 'lucide-react';
import { WS, fmtDateTime } from './constants';
import { WSBadge, KDChips } from './primitives';
import type { LedgerRecord } from './use-workspace-data';

export function ConfirmCenterSection({ records }: { records: LedgerRecord[] }) {
  const pending = records.filter(r => r.confirmState === 'PLAYER_PENDING');
  const disputed = records.filter(r => r.confirmState === 'DISPUTED');

  return (
    <div className="flex flex-col gap-3" data-testid="ws-confirm-center">
      {/* 流程说明 */}
      <div className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5">
        <UserCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
        <p className="text-[11px] leading-relaxed text-[#93a89a]">
          确认流程：管理员审批归档 → 系统向<b className="text-white/85">已注册玩家本人</b>发送确认请求（玩家端「我的档案」内出现确认卡片）→
          玩家确认或提出异议 → 确认后写入正式成长记录；有异议进入人工核对。
          <b className="text-amber-300/90">未确认的记录不会被标记为正式确认，不计入正式累计战绩。</b>
          未注册玩家（无确认通道）由管理员逐条豁免并留痕。
        </p>
      </div>

      {/* 异议队列（置顶，暖红橙） */}
      {disputed.length > 0 && (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/[0.06] p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-orange-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            玩家异议队列（{disputed.length} 条 · 记录不会被自动删除，等待管理员人工核对）
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {disputed.map(r => (
              <div key={r.id} className="rounded-lg border border-orange-500/20 bg-black/25 px-2.5 py-1.5 text-[11px]">
                <span className="font-bold text-white/90">{r.identity.displayName}</span>
                <span className="ml-2 text-[#93a89a]">行{r.sourceRow} · {r.raw.project || '未提供'} → {r.norm.testTierNorm ?? (r.raw.testTier || '未提供')}</span>
                <span className="ml-2"><KDChips r={r} /></span>
                <p className="mt-0.5 text-orange-200/85">异议：{r.disputeReason || '（未填写）'}（{fmtDateTime(r.disputedAt)}）</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 待玩家确认队列 */}
      <div className="rounded-xl border border-white/[0.06] bg-[rgba(14,20,16,0.65)] p-3">
        <div className="flex items-center gap-1.5 text-xs font-bold text-sky-300">
          <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
          待玩家确认（{pending.length} 条）
        </div>
        {pending.length === 0 ? (
          <p className={`mt-2 text-[11px] ${WS.faintText}`}>
            暂无等待玩家确认的记录 —— 管理员完成「审批归档写入」后，已注册玩家将在此流程中收到确认请求。
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {pending.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.05] bg-black/25 px-2.5 py-1.5 text-[11px]">
                <span className="font-bold text-white/90">{r.identity.displayName}</span>
                <span className="text-[#93a89a]">行{r.sourceRow} · {r.raw.project || '未提供'} → {r.norm.testTierNorm ?? (r.raw.testTier || '未提供')}</span>
                <span className="font-mono text-[10px] text-[#9db4a4]">{(r.norm.testDateIso ?? '').slice(0, 10) || '未提供'}</span>
                <KDChips r={r} />
                <span className="ml-auto"><WSBadge label="等待玩家操作" cls="border-sky-400/25 bg-sky-400/10 text-sky-300" /></span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className={`text-[10px] leading-relaxed ${WS.faintText}`}>
        重复保护：同一工单重复同步不重复发送确认通知（幂等键 + bizKey 合并）；考核员不会获得测试者的 K/D；
        确认与异议操作在玩家侧完成并全程留审计日志。
      </p>
    </div>
  );
}
