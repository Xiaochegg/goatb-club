'use client';

// ============================================================
// Tier Workspace V2 · SECTION 03 玩家详情与工单详情（侧边抽屉）
// ------------------------------------------------------------
// 工单 §三.S3：点击玩家 → 侧边抽屉；不跳转原始 JSON 页面。
//   玩家身份（纯名称/游戏 ID/当前 Tier）→ 已确认累计 K/D → 每条工单独立卡片
//   （测试信息/K·击杀/D·死亡/评价/来源收起）。
// 审批（复用既有后端门禁，零新后端）：仅 UNIQUE + READY 行可审批；
//   tier 必须等于台账 testTierNorm（词表外等级不可写）；模式必选；
//   待建条目须显式勾选「创建并写入」；疑似垃圾须显式确认；二次确认后提交
//   POST /api/v1/tier-command/ledger-approve。失败不显示成功。
// 动画：右侧滑入柔和弹簧（250-350ms），backdrop 淡入；reduced-motion 直切。
// ============================================================

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ShieldCheck, Loader2 } from 'lucide-react';
import { ALL_MODES, MODE_LABELS, type GameMode } from '@/lib/constants';
import { adminFetch } from '@/lib/admin-fetch';
import { SPRING_DRAWER, NO_MOTION, WS, fmtKD } from './constants';
import { WSBadge, TicketCard } from './primitives';
import type { PlayerAgg, LedgerRecord } from './use-workspace-data';

interface ApproveResponse {
  ok: boolean;
  recordId?: string;
  playerId?: string;
  created?: boolean;
  logId?: string;
  confirmState?: string;
  exemptNoConfirm?: boolean;
  exemptNote?: string | null;
  message?: string;
  code?: string;
}

export function PlayerDetailDrawer({
  player,
  records,
  open,
  reduced,
  onClose,
  onChanged,
}: {
  player: PlayerAgg | null;
  records: LedgerRecord[];
  open: boolean;
  reduced: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const spring = reduced ? NO_MOTION : SPRING_DRAWER;

  // 审批交互状态（每行独立）
  const [modeByRecord, setModeByRecord] = useState<Record<string, string>>({});
  const [createIfMissing, setCreateIfMissing] = useState<Set<string>>(new Set());
  const [confirmGarbage, setConfirmGarbage] = useState<Set<string>>(new Set());
  const [pendingApprove, setPendingApprove] = useState<LedgerRecord | null>(null);
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  // 关闭时清空瞬时状态
  useEffect(() => {
    if (!open) {
      setModeByRecord({});
      setCreateIfMissing(new Set());
      setConfirmGarbage(new Set());
      setPendingApprove(null);
      setNotice(null);
    }
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !approving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, approving, onClose]);

  async function submitApprove(r: LedgerRecord) {
    if (!r.norm.testTierNorm) return;
    setApproving(true);
    setNotice(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/ledger-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: r.id,
          tier: r.norm.testTierNorm,
          mode: modeByRecord[r.id],
          createIfMissing: createIfMissing.has(r.id) && !r.matchedPlayerId,
          confirmSuspectGarbage: confirmGarbage.has(r.id),
        }),
      });
      const json = (await res.json()) as ApproveResponse;
      if (!res.ok || !json.ok) {
        setNotice({ ok: false, msg: json.message || json.code || `审批失败（HTTP ${res.status}）` });
        return;
      }
      const confirmPart = json.exemptNoConfirm
        ? '（该玩家无确认通道，已豁免：' + (json.exemptNote ?? '') + '）'
        : json.confirmState === 'PLAYER_PENDING'
          ? '，已向已注册玩家本人发出确认请求'
          : '';
      setNotice({ ok: true, msg: `归档写入完成${json.created ? '（新建玩家条目）' : ''}${confirmPart}` });
      setPendingApprove(null);
      onChanged();
    } catch {
      setNotice({ ok: false, msg: '审批请求发送失败（网络异常）' });
    } finally {
      setApproving(false);
    }
  }

  return (
    <AnimatePresence>
      {open && player && (
 <>
          {/* backdrop */}
          <motion.div
            key="backdrop"
            initial={reduced ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
            onClick={() => { if (!approving) onClose(); }}
            aria-hidden="true"
          />
          {/* 面板 */}
          <motion.aside
            key="panel"
            role="dialog"
            aria-modal="true"
            aria-label={`玩家详情：${player.displayName}`}
            initial={reduced ? { opacity: 0 } : { x: '100%' }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: '100%' }}
            transition={spring}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-white/10 bg-[#0d1410]"
            data-testid="player-detail-drawer"
          >
            {/* 头部：玩家身份 */}
            <div className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-3.5">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold text-white">{player.displayName}</h3>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {player.matchedPlayerId ? (
                    <WSBadge label={`榜单条目：${player.matchedPlayerName}`} cls="border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300/90" />
                  ) : (
                    <WSBadge label="未建条目 / 身份待核对" cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />
                  )}
                  {player.currentTiers.slice(0, 5).map(t => (
                    <WSBadge key={`${t.mode}-${t.tier}`} label={`${t.tier}`} cls="border-white/15 bg-white/[0.06] text-[#d5e0d8]" title={`当前段位 · ${MODE_LABELS[t.mode as GameMode] ?? t.mode}`} />
                  ))}
                  {player.currentTiers.length === 0 && <span className={`text-[10px] ${WS.faintText}`}>当前 Tier：无可靠数据</span>}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-[#6d7f72]">
                  原始名称形态：{player.rawNameVariants.join(' / ')}（全部保留可追溯
                  {player.rawNameVariants.length > 1 ? '；已按身份归并到同一主条目' : ''}）
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={approving}
                aria-label="关闭详情"
                className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-[#93a89a] transition-all hover:bg-white/[0.08] hover:text-white active:scale-95 disabled:opacity-40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* 已确认累计 K/D（仅已确认且未重复记录参与；缺失不补 0） */}
            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] bg-black/20 px-4 py-2.5 text-[11px]">
              <span className="text-[#93a89a]">已确认累计战绩（正式口径）：</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] px-2 py-0.5 font-mono font-bold text-emerald-300">
                K <span className="text-emerald-200">{fmtKD(player.confirmedKills)}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-orange-400/25 bg-orange-400/[0.08] px-2 py-0.5 font-mono font-bold text-orange-300">
                D <span className="text-orange-200">{fmtKD(player.confirmedDeaths)}</span>
              </span>
              <span className="text-[10px] text-[#6d7f72]">仅统计「已确认且未重复」的工单；缺失显示「未提供」，绝不补 0 / 不推算；不入排行榜评分公式。</span>
            </div>

            {/* 工单卡片列表 */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3 sm:px-4">
              {records.length === 0 ? (
                <p className={`py-6 text-center text-xs ${WS.faintText}`}>该玩家暂无工单记录</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {records.map(r => {
                    const mode = modeByRecord[r.id] ?? '';
                    return (
                      <TicketCard
                        key={r.id}
                        r={r}
                        reduced={reduced}
                      >
                        {r.processState === 'READY' && r.mergeState === 'UNIQUE' && (
                          r.norm.testTierNorm ? (
                            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.05] pt-2">
                              <select
                                value={mode}
                                onChange={e => setModeByRecord(prev => ({ ...prev, [r.id]: e.target.value }))}
                                aria-label={`选择 ${player.displayName} 第 ${r.sourceRow} 行的写入模式`}
                                className="h-8 rounded-md border border-white/15 bg-black/30 px-2 text-[11px] text-white focus:outline-none"
                              >
                                <option value="">写入模式（必选）</option>
                                {ALL_MODES.map(m => <option key={m} value={m}>{m} · {MODE_LABELS[m as GameMode]}</option>)}
                              </select>
                              {!r.matchedPlayerId && (
                                <label className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-[#93a89a]">
                                  <input
                                    type="checkbox"
                                    checked={createIfMissing.has(r.id)}
                                    onChange={e => setCreateIfMissing(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                                    className="accent-[#BF5AF2]"
                                  />
                                  创建并写入
                                </label>
                              )}
                              {r.suspectGarbage && (
                                <label className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-amber-300">
                                  <input
                                    type="checkbox"
                                    checked={confirmGarbage.has(r.id)}
                                    onChange={e => setConfirmGarbage(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                                    className="accent-amber-500"
                                  />
                                  确认非垃圾
                                </label>
                              )}
                              <button
                                type="button"
                                disabled={!mode || approving}
                                onClick={() => setPendingApprove(r)}
                                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-[rgba(191,90,242,0.4)] bg-[rgba(191,90,242,0.14)] px-2.5 py-1 text-[11px] font-bold text-[#d9b8fa] transition-all hover:bg-[rgba(191,90,242,0.24)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                                data-testid={`approve-btn-${r.id}`}
                              >
                                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> 审批归档写入
                              </button>
                              <span className="text-[10px] text-[#6d7f72]">写入后已注册玩家将收到确认请求（未确认不计入正式成长记录）</span>
                            </div>
                          ) : (
                            <div className="border-t border-white/[0.05] pt-2 text-[10px] text-amber-300/85">
                              该行「测试tier」为词表外值（{r.raw.testTier || '空'}）—— 按纪律不可自动写入。
                              请管理员先在腾讯文档修正 G 列为有效等级（HT/LT ×1-5）后重新拉取。
                            </div>
                          )
                        )}
                        {r.processState === 'ARCHIVED' && (
                          <div className="border-t border-white/[0.05] pt-2 text-[10px] text-[#6d7f72]">
                            已归档 · 确认状态：{r.confirmState === 'CONFIRMED' ? '玩家已确认' : r.confirmState === 'PLAYER_PENDING' ? '等待玩家本人确认' : r.confirmState === 'DISPUTED' ? '玩家提出异议' : r.exemptNoConfirm ? '已豁免确认通道' : '无确认通道'}
                          </div>
                        )}
                        {r.processState === 'PENDING_REVIEW' && (
                          <div className="border-t border-white/[0.05] pt-2 text-[10px] text-amber-300/80">
                            待核对：修复文档数据或人工裁决后重新「拉取收集表归档」即可更新状态（不会自动归档）。
                          </div>
                        )}
                      </TicketCard>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 审批结果提示 */}
            <AnimatePresence>
              {notice && (
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={spring}
                  role="status"
                  className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-[11px] sm:mx-4 ${
                    notice.ok
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                      : 'border-orange-500/30 bg-orange-500/10 text-orange-300'
                  }`}
                >
                  {notice.msg}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.aside>

          {/* 二次确认 */}
          <AnimatePresence>
            {pendingApprove && (
              <motion.div
                key="confirm"
                initial={reduced ? { opacity: 0 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.18 }}
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
                role="alertdialog"
                aria-modal="true"
                aria-label="确认归档写入"
              >
                <motion.div
                  initial={reduced ? { opacity: 0 } : { scale: 0.94, y: 10 }}
                  animate={reduced ? { opacity: 1 } : { scale: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { scale: 0.96, y: 6 }}
                  transition={spring}
                  className="w-full max-w-md rounded-xl border border-white/10 bg-[#111913] p-4"
                >
                  <h4 className="text-sm font-bold text-white">确认归档写入（人工逐条审批）</h4>
                  <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-[#93a89a]">
                    <p>
                      将把 <span className="font-bold text-white">{pendingApprove.identity.displayName}</span> 的
                      {' '}{pendingApprove.norm.testTierNorm} 段位写入{MODE_LABELS[(modeByRecord[pendingApprove.id] ?? '') as GameMode] ?? '所选模式'}档案。
                    </p>
                    {!pendingApprove.matchedPlayerId && createIfMissing.has(pendingApprove.id) && (
                      <p className="text-amber-300">· 该玩家无榜单条目，已勾选「创建并写入」→ 将新建条目（名称 = {pendingApprove.identity.displayName}）。</p>
                    )}
                    {pendingApprove.identity.suffixSplit && (
                      <p className="text-amber-300">
                        · 该行原始名称「{pendingApprove.identity.rawName}」尾缀 {pendingApprove.identity.tierCandidate} 已分离，
                        写入名称为「{pendingApprove.identity.displayName}」；请确认这不是同名不同人。
                      </p>
                    )}
                    <p>写入后进入玩家确认流程；未确认的记录不会成为正式成长记录。全程留审计日志。</p>
                  </div>
                  <div className="mt-3.5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingApprove(null)}
                      disabled={approving}
                      className="min-h-[36px] rounded-lg border border-white/15 bg-transparent px-3 text-xs text-[#c9d4cc] transition-colors hover:bg-white/5 disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void submitApprove(pendingApprove)}
                      disabled={approving || !modeByRecord[pendingApprove.id]}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[rgba(191,90,242,0.85)] px-4 text-xs font-bold text-white transition-all hover:bg-[rgba(191,90,242,1)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                      data-testid="confirm-approve-btn"
                    >
                      {approving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      {approving ? '写入中…' : '确认写入'}
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
