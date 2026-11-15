'use client';

// ============================================================
// Tier Workspace V2 · 共用原语（徽章 / 黄色常驻提醒 / 工单卡片）
// ------------------------------------------------------------
// 工单强制规则落地：
//  - NameGuardBanner：名称识别保护黄色提醒，置于工作区顶部（tab 之外），
//    切换标签/展开卡片/刷新页面均不消失；发现异常时升级提示
//    「名称与 Tier 疑似混淆，已暂停自动处理，请管理员核对。」
//  - TicketCard：K/D 统一显示「K·击杀 / D·死亡」（绝不显示
//    「测试者胜场/考核员胜场」）；缺失显示「未提供」，绝不补 0；
//    技术信息（来源/指纹/识别结果）默认收起。
// ============================================================

import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, ShieldAlert, TriangleAlert } from 'lucide-react';
import { PROCESS_BADGE, CONFIRM_BADGE, MATCH_BADGE, SPRING_EXPAND, NO_MOTION, fmtKD, fmtDateTime, WS } from './constants';
import type { LedgerRecord } from './use-workspace-data';

// ---------- 徽章 ----------

export function WSBadge({ label, cls, title }: { label: string; cls: string; title?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold leading-none whitespace-nowrap ${cls}`}
      title={title}
    >
      {label}
    </span>
  );
}

export function StateBadges({ r, extra }: { r: LedgerRecord; extra?: ReactNode }) {
  const proc = PROCESS_BADGE[r.processState];
  const conf = CONFIRM_BADGE[r.confirmState];
  const match = MATCH_BADGE[r.matchState];
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {extra}
      {match && r.matchState !== 'MATCHED' && <WSBadge label={match.label} cls={match.cls} />}
      {conf && r.confirmState !== 'NONE' && <WSBadge label={conf.label} cls={conf.cls} />}
      {proc && <WSBadge label={proc.label} cls={proc.cls} />}
      {r.suspectGarbage && <WSBadge label="疑似垃圾" cls="bg-amber-400/10 text-amber-300 border-amber-400/30" />}
      {r.dupSourceCount > 1 && (
        <WSBadge label={`×${r.dupSourceCount} 来源`} cls="bg-[rgba(191,90,242,0.10)] text-[#c98af5] border-[rgba(191,90,242,0.30)]" />
      )}
    </span>
  );
}

// ---------- 名称识别保护（黄色常驻提醒，工单最高优先级规则） ----------

export function NameGuardBanner({ identityReviewCount }: { identityReviewCount: number }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-xl border border-amber-400/40 bg-amber-400/[0.08] px-3 py-2.5 sm:px-4"
      data-testid="name-guard-banner"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 text-[11px] leading-relaxed sm:text-xs">
          <p className="font-bold text-amber-200">
            名称识别保护：MT4、LT5、HT5 等 Tier 标识必须与玩家名称分离，禁止并入玩家身份。
          </p>
          <p className="mt-0.5 text-amber-200/75">
            有效等级词表：HT1–HT5 · LT1–LT5 · LZ1–LZ5 · LL1–LL5（现行 Tier 体系）；MT1–MT5 等词表外形态只提示人工核对，
            不创建等级、不自动拆分；原始名称全文保留可追溯；无法确定的记录不自动归档。
          </p>
          {identityReviewCount > 0 && (
            <motion.p
              initial={false}
              animate={{ opacity: 1 }}
              className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/15 px-2 py-1 font-bold text-amber-100"
            >
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              名称与 Tier 疑似混淆，已暂停自动处理，请管理员核对。（{identityReviewCount} 条工单待核对）
            </motion.p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- K/D 展示（工单 §一.2：统一 K·击杀 / D·死亡，归属测试者） ----------

export function KDChips({ r, size = 'sm' }: { r: LedgerRecord; size?: 'sm' | 'lg' }) {
  const pad = size === 'lg' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[10px]';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] font-mono font-bold text-emerald-300 ${pad}`}
        title="K · 击杀（归属测试者）——缺失时显示未提供，绝不补 0"
      >
        K <span className="text-emerald-200">{fmtKD(r.kd.kills)}</span>
      </span>
      <span
        className={`inline-flex items-center gap-1 rounded-md border border-orange-400/25 bg-orange-400/[0.08] font-mono font-bold text-orange-300 ${pad}`}
        title="D · 死亡（归属测试者）——缺失时显示未提供，绝不补 0"
      >
        D <span className="text-orange-200">{fmtKD(r.kd.deaths)}</span>
      </span>
    </span>
  );
}

// ---------- 玩家 Tier 徽章组 ----------

export function TierBadges({ tiers, candidates }: { tiers: Array<{ mode: string; tier: string }>; candidates?: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {tiers.slice(0, 4).map(t => (
        <WSBadge
          key={`${t.mode}-${t.tier}`}
          label={`${t.tier}`}
          cls="border-white/15 bg-white/[0.06] text-[#d5e0d8]"
          title={`当前段位 · ${t.mode}`}
        />
      ))}
      {(candidates ?? []).filter(c => !tiers.some(t => t.tier === c)).slice(0, 3).map(c => (
        <WSBadge
          key={`cand-${c}`}
          label={`${c}?`}
          cls="border-amber-400/30 bg-amber-400/10 text-amber-300"
          title="识别候选（未核实）—— 不能仅凭字符串认定一定是等级"
        />
      ))}
      {tiers.length === 0 && (candidates ?? []).length === 0 && (
        <span className={`text-[10px] ${WS.faintText}`}>无可靠数据</span>
      )}
    </span>
  );
}

// ---------- 工单卡（玩家详情/展开区共用） ----------

export interface TicketCardAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'accent' | 'amber' | 'plain';
}

export function TicketCard({
  r,
  defaultOpen = false,
  actions,
  reduced,
  children,
}: {
  r: LedgerRecord;
  defaultOpen?: boolean;
  actions?: TicketCardAction[];
  reduced: boolean;
  /** 卡片底部扩展槽（审批交互等） */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const v = r.identity;
  const spring = reduced ? NO_MOTION : SPRING_EXPAND;

  return (
    <div className={`rounded-xl border border-white/[0.07] bg-[rgba(14,20,16,0.65)] ${WS.card}`}>
      {/* 头行：日期/项目/Tier/K/D/状态 */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
        data-testid={`ticket-row-${r.id}`}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={spring}
          className="shrink-0"
          aria-hidden="true"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 text-[#93a89a]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#93a89a]" />}
        </motion.span>
        <span className="shrink-0 font-mono text-[11px] text-[#9db4a4]">{(r.norm.testDateIso ?? (r.raw.testDate || '未提供')).slice(0, 10)}</span>
        <span className="min-w-0 truncate text-[11px] font-medium text-white/90">{r.raw.project || '未提供'}</span>
        <span className="shrink-0 text-[10px] text-[#93a89a]">→ {r.norm.testTierNorm ?? (r.raw.testTier || '未提供')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <KDChips r={r} />
        </span>
        <span className="hidden sm:inline-flex">
          <StateBadges r={r} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2.5 border-t border-white/[0.06] px-3.5 py-3">
              {/* 测试信息 */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] leading-relaxed sm:grid-cols-4">
                <InfoItem label="玩家（纯名称）" value={v.displayName} mono={false} />
                <InfoItem label="原始记录名称" value={v.rawName} mono={false} title="原文保留，可追溯" />
                <InfoItem label="考核员" value={r.norm.examinerId || '未提供'} />
                <InfoItem label="测试者" value={v.displayName} />
                <InfoItem label="原 Tier（候选）" value={r.norm.testeeTierCand ?? v.tierCandidate ?? '未提供'} />
                <InfoItem label="测试后 Tier" value={r.norm.testTierNorm ?? (r.raw.testTier || '未提供')} />
                <InfoItem label="测试日期" value={(r.norm.testDateIso ?? '').slice(0, 10) || '未提供'} />
                <InfoItem label="提交时间" value={r.raw.submittedAt || '未提供'} />
              </div>

              {/* K/D 归属说明 */}
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#93a89a]">
                <KDChips r={r} />
                <span>K · 击杀与 D · 死亡均归属于被测玩家（测试者）；缺失显示「未提供」，不补 0、不推算。</span>
              </div>

              {/* 评价 */}
              <InfoItem
                label="测试评价"
                value={r.raw.review?.trim() ? r.raw.review : '未提供'}
                mono={false}
                wide
              />

              {/* 身份识别提示（needsReview 时醒目） */}
              {v.needsReview && v.reviewNote && (
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-2.5 py-1.5 text-[11px] text-amber-200/90">
                  {v.reviewNote}
                </div>
              )}

              {/* 来源（默认收起） */}
              <SourceDisclosure r={r} reduced={reduced} />

              {/* 操作槽 */}
              {actions && actions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {actions.map(a => (
                    <button
                      key={a.label}
                      type="button"
                      onClick={a.onClick}
                      disabled={a.disabled}
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${
                        a.tone === 'amber'
                          ? 'border border-amber-400/40 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
                          : a.tone === 'plain'
                            ? 'border border-white/15 bg-white/[0.04] text-[#c9d4cc] hover:bg-white/[0.08]'
                            : 'border-[rgba(191,90,242,0.4)] bg-[rgba(191,90,242,0.14)] text-[#d9b8fa] hover:bg-[rgba(191,90,242,0.24)]'
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function InfoItem({ label, value, mono = true, wide = false, title }: { label: string; value: string; mono?: boolean; wide?: boolean; title?: string }) {
  return (
    <span className={`${wide ? 'col-span-2 sm:col-span-4' : ''} min-w-0`} title={title}>
      <span className="text-[#6d7f72]">{label}：</span>
      <span className={`${mono ? 'font-mono' : ''} break-words text-white/85`}>{value}</span>
    </span>
  );
}

function SourceDisclosure({ r, reduced }: { r: LedgerRecord; reduced: boolean }) {
  const [open, setOpen] = useState(false);
  const spring = reduced ? NO_MOTION : SPRING_EXPAND;
  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/20">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] text-[#6d7f72] transition-colors hover:text-[#93a89a]"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring} aria-hidden="true" className="shrink-0">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </motion.span>
        来源与技术详情（原始提交者 · 工作表 · 记录编号 · 识别结果）
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-2.5 pb-2 text-[10px] leading-relaxed text-[#93a89a] sm:grid-cols-3">
              <InfoItem label="原始提交者" value={r.raw.submitter || '未提供'} mono={false} />
              <InfoItem label="来源工作表" value={r.tabId === 'd5roro' ? '收集表 d5roro' : r.tabId} />
              <InfoItem label="原始记录编号" value={`sheet 第 ${r.sourceRow} 行`} />
              <InfoItem label="原始字段（测试者）" value={r.raw.testee || '未提供'} wide title="原始全文，可追溯" />
              <InfoItem label="识别结果" value={
                `${r.identity.matchBasis}${r.identity.suffixSplit ? ' · 已分离尾缀' : ''}${r.identity.suspectToken ? ` · 词表外「${r.identity.suspectToken}」` : ''}`
              } wide />
              <InfoItem label="内容指纹" value={r.rowFingerprint.slice(0, 16) + '…'} wide />
              {r.dupSources.length > 1 && (
                <span className="col-span-2 text-[#c98af5]/85 sm:col-span-3">
                  完全重复来源 {r.dupSources.length} 条（业务字段完全一致才合并；不重复累计、不重复通知）：
                  {r.dupSources.map(d => `行${d.sourceRow}`).join('、')}
                </span>
              )}
              {r.approveRef && (
                <span className="col-span-2 text-emerald-300/85 sm:col-span-3">
                  归档写入：{r.approveRef.by ?? '管理员'} @ {fmtDateTime(r.approveRef.at)} · {r.approveRef.mode ?? '—'} → {r.approveRef.tier ?? '—'}{r.approveRef.created ? ' · 由台账创建玩家' : ''}
                </span>
              )}
              {r.exemptNoConfirm && (
                <span className="col-span-2 text-amber-300/85 sm:col-span-3">确认豁免：{r.exemptNote || '已豁免'}</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
