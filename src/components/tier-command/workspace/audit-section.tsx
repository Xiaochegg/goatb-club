'use client';

// ============================================================
// Tier Workspace V2 · SECTION 06 操作审计历史
// ------------------------------------------------------------
// 工单 §三.S6：最近 30 条操作；每条用普通中文展示（时间/操作人/目标玩家/
//   操作内容/操作结果）；详细技术日志放在展开详情里；回档功能保留但
//   不能擅自执行（复用既有 RollbackDialog：候选门禁 + 逐项复核 + 二次确认）。
// ============================================================

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, ChevronDown, ChevronRight, Undo2, AlertTriangle, Loader2 } from 'lucide-react';
import { MODE_LABELS, type GameMode } from '@/lib/constants';
import { SPRING_EXPAND, NO_MOTION, LOG_KIND_BADGE, WS, fmtDateCn, fmtDateTime } from './constants';
import { WSBadge } from './primitives';
import { RollbackDialog } from './legacy-sync-section';
import { useAuditLogs, type WorkspaceAuditLog } from './use-workspace-data';

/** 普通中文操作描述（工单示例口径：管理员于 X 月 X 日 将……） */
function humanizeLog(l: WorkspaceAuditLog): string {
  const at = fmtDateCn(l.at);
  const op = l.operator || '管理员';
  const player = l.playerName ?? '玩家';
  const modeLabel = l.mode ? (MODE_LABELS[l.mode as GameMode] ?? l.mode) : null;
  switch (l.kind) {
    case 'approve':
      return `${op} 于 ${at} 将 ${player} 的测试工单审批写入（${modeLabel ? `${modeLabel} · ` : ''}${l.tierTo ?? '—'}）${l.created ? '，并新建了玩家条目' : ''}，已提交至玩家确认流程`;
    case 'rollback':
      return `${op} 于 ${at} 回档了对 ${player} 的一次段位写入（仅恢复该次写入的 tiers 字段，后续变更不受影响）`;
    case 'reject':
      return `${op} 于 ${at} 拒绝了 ${player} 的测试工单（行${l.rowIndex ?? '?'}），后续同步不再作为写入候选`;
    case 'restore':
      return `${op} 于 ${at} 撤销了对 ${player} 工单（行${l.rowIndex ?? '?'}）的拒绝，恢复为候选`;
    default:
      return `${op} 于 ${at}：${l.detail}`;
  }
}

export function AuditSection({ refreshKey, reduced }: { refreshKey: number; reduced: boolean }) {
  const { logs, state, error } = useAuditLogs(refreshKey);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rbOpen, setRbOpen] = useState(false);
  const spring = reduced ? NO_MOTION : SPRING_EXPAND;

  return (
    <div className="flex flex-col gap-2.5" data-testid="ws-audit">
      {state === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-[#93a89a]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 审计历史加载中…
        </div>
      )}
      {state === 'error' && error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {state === 'ready' && logs.length === 0 && (
        <div className={`rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-xs ${WS.faintText}`}>
          暂无操作记录 —— 完成一次工单审批 / 拒绝 / 回档后，此处将显示普通中文的操作历史
        </div>
      )}
      {state === 'ready' && logs.length > 0 && (
        <div className={`overflow-hidden rounded-xl border border-white/[0.07] ${WS.card}`}>
          <div className="max-h-96 overflow-y-auto custom-scrollbar divide-y divide-white/[0.04]">
            {logs.map(l => {
              const kind = l.kind ? LOG_KIND_BADGE[l.kind] : null;
              const isOpen = expanded === l.id;
              return (
                <div key={l.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : l.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                  >
                    <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#6d7f72]" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] leading-relaxed text-white/85">{humanizeLog(l)}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {kind && <WSBadge label={kind.label} cls={kind.cls} />}
                        <span className="font-mono text-[10px] text-[#6d7f72]">{fmtDateTime(l.at)}</span>
                        {l.created && <WSBadge label="新建条目" cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />}
                      </span>
                    </span>
                    <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={spring} className="mt-0.5 shrink-0" aria-hidden="true">
                      {isOpen ? <ChevronDown className="h-3 w-3 text-[#6d7f72]" /> : <ChevronRight className="h-3 w-3 text-[#6d7f72]" />}
                    </motion.span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={spring}
                        className="overflow-hidden"
                      >
                        <div className="mx-3 mb-2.5 rounded-lg border border-white/[0.05] bg-black/25 px-2.5 py-2 text-[10px] leading-relaxed text-[#93a89a]">
                          <p><span className="text-[#6d7f72]">日志 ID：</span><span className="font-mono">{l.id}</span></p>
                          <p><span className="text-[#6d7f72]">技术详情原文：</span>{l.detail}</p>
                          <p><span className="text-[#6d7f72]">记录编号：</span>行{l.rowIndex ?? '—'} · 模式 {l.mode ?? '—'} · 写入 Tier {l.tierTo ?? '—'}</p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 回档（保留既有能力：候选门禁 + 逐项复核 + 二次确认；绝不擅自执行） */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRbOpen(true)}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-1.5 text-[11px] font-bold text-amber-300 transition-all hover:bg-amber-400/[0.16] active:scale-[0.97]"
          aria-label="打开写入回档"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          回档
        </button>
        <span className={`text-[10px] ${WS.faintText}`}>
          选择性回档历史写入：恢复范围明确、不覆盖回档后新记录、全程留审计日志；回档不会自动执行，需逐项勾选并二次确认
        </span>
      </div>
      <RollbackDialog open={rbOpen} onOpenChange={setRbOpen} onChanged={() => { /* 回档成功后由父级刷新审计 */ }} />
    </div>
  );
}
