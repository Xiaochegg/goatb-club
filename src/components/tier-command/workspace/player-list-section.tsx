'use client';

// ============================================================
// Tier Workspace V2 · SECTION 02 玩家工单列表（核心区）
// ------------------------------------------------------------
// 工单 §三.S2：按【玩家】聚合（不按提交者分组）；每个玩家只显示一个主条目；
//   玩家名称与 Tier 分列显示；展开玩家全部测试记录；搜索/筛选/排序齐全。
// 碎片化修复：bad小杨 / bad小杨HT5 / bad小杨LT4 由 identity 层归并到同一主条目
//   （唯一身份匹配才聚合；未建条目组按纯名称展示分组并明确标注待核对，
//    绝不自动合并同名不同 ID、绝不自动归档）。
// 布局：md+ 表格；<md 卡片单列；不允许横向溢出（表格容器 overflow-x-auto）。
// ============================================================

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Search, Eye, Loader2 } from 'lucide-react';
import { NORMAL_TIERS, JIAHAO_TIERS } from '@/lib/constants';
import { SPRING_EXPAND, NO_MOTION, WS } from './constants';
import { WSBadge, StateBadges, TierBadges, KDChips } from './primitives';
import type { PlayerAgg, LedgerRecord } from './use-workspace-data';
import type { WorkspaceFilter } from './overview-section';

const TIER_FILTER_OPTIONS = [...NORMAL_TIERS, ...JIAHAO_TIERS];

export function PlayerListSection({
  players,
  recordsByAggKey,
  loading,
  reduced,
  filter,
  onFilterChange,
  onOpenDetail,
}: {
  players: PlayerAgg[];
  recordsByAggKey: Map<string, LedgerRecord[]>;
  loading: boolean;
  reduced: boolean;
  filter: WorkspaceFilter;
  onFilterChange: (f: WorkspaceFilter) => void;
  onOpenDetail: (p: PlayerAgg) => void;
}) {
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [sortBy, setSortBy] = useState<'recent' | 'count'>('recent');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = players.filter(p => {
      if (filter !== 'ALL') {
        switch (filter) {
          case 'PENDING_REVIEW': if (p.counts.pendingReview === 0) return false; break;
          case 'READY': if (p.counts.ready === 0) return false; break;
          case 'PLAYER_PENDING': if (p.counts.playerPending === 0) return false; break;
          case 'CONFIRMED': if (p.counts.confirmed === 0) return false; break;
          case 'ARCHIVED': if (p.counts.archived === 0) return false; break;
          case 'NEEDS_IDENTITY': if (!p.needsReview) return false; break;
          case 'DISPUTED': if (p.counts.disputed === 0) return false; break;
        }
      }
      if (tierFilter) {
        const hitTier = p.currentTiers.some(t => t.tier === tierFilter) || p.tierCandidates.includes(tierFilter);
        if (!hitTier) return false;
      }
      if (q) {
        const hay = [p.displayName, p.matchedPlayerName ?? '', ...p.rawNameVariants, ...p.examiners]
          .join('\u0001').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
      if (sortBy === 'count' && a.ticketCount !== b.ticketCount) return b.ticketCount - a.ticketCount;
      const da = a.latestTestDate ?? '';
      const db = b.latestTestDate ?? '';
      if (da !== db) return db.localeCompare(da);
      return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN');
    });
    return list;
  }, [players, filter, tierFilter, query, sortBy]);

  const spring = reduced ? NO_MOTION : SPRING_EXPAND;

  return (
    <div className="flex flex-col gap-3" data-testid="ws-player-list">
      {/* 工具行：搜索 / 筛选 / 排序 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6d7f72]" aria-hidden="true" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索玩家名称 / 游戏 ID / 考核员"
            aria-label="搜索玩家"
            className="h-9 w-full rounded-lg border border-white/10 bg-black/25 pl-8 pr-3 text-xs text-white placeholder:text-[#6d7f72] focus:border-[rgba(191,90,242,0.5)] focus:outline-none focus:ring-1 focus:ring-[rgba(191,90,242,0.4)]"
          />
        </div>
        <select
          value={filter}
          onChange={e => onFilterChange(e.target.value as WorkspaceFilter)}
          aria-label="按工单状态筛选"
          className="h-9 rounded-lg border border-white/10 bg-black/25 px-2 text-xs text-white focus:outline-none"
        >
          <option value="ALL">全部状态</option>
          <option value="PENDING_REVIEW">待核对</option>
          <option value="READY">待归档</option>
          <option value="PLAYER_PENDING">待玩家确认</option>
          <option value="CONFIRMED">已确认</option>
          <option value="ARCHIVED">已归档</option>
          <option value="NEEDS_IDENTITY">身份需要核对</option>
          <option value="DISPUTED">存在异议</option>
        </select>
        <select
          value={tierFilter}
          onChange={e => setTierFilter(e.target.value)}
          aria-label="按 Tier 筛选"
          className="h-9 rounded-lg border border-white/10 bg-black/25 px-2 text-xs text-white focus:outline-none"
        >
          <option value="">全部 Tier</option>
          {TIER_FILTER_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'recent' | 'count')}
          aria-label="排序方式"
          className="h-9 rounded-lg border border-white/10 bg-black/25 px-2 text-xs text-white focus:outline-none"
        >
          <option value="recent">按测试日期排序</option>
          <option value="count">按工单数量排序</option>
        </select>
        <span className={`ml-auto text-[10px] ${WS.faintText}`}>{filtered.length} 位玩家</span>
      </div>

      {/* 列表 */}
      {loading && players.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#93a89a]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 玩家工单加载中…
        </div>
      ) : filtered.length === 0 ? (
        <div className={`rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-xs ${WS.faintText}`}>
          没有匹配的玩家工单 —— 调整搜索/筛选条件，或先「拉取收集表归档」建立台账
        </div>
      ) : (
        <div className={`overflow-hidden rounded-xl border border-white/[0.07] ${WS.card}`}>
          {/* 桌面表头 */}
          <div className="hidden items-center gap-3 border-b border-white/[0.06] bg-black/20 px-4 py-2 text-[10px] font-bold text-[#6d7f72] md:grid md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_54px_60px_minmax(0,2fr)_84px_64px]">
            <span>玩家名称</span>
            <span>Tier</span>
            <span className="text-right">工单数</span>
            <span className="text-right">待处理</span>
            <span>状态</span>
            <span>最近测试</span>
            <span className="text-right">操作</span>
          </div>
          <div className="max-h-[34rem] overflow-y-auto custom-scrollbar">
            {filtered.map(p => {
              const isOpen = expanded === p.aggKey;
              const recs = recordsByAggKey.get(p.aggKey) ?? [];
              const pending = p.counts.pendingReview + p.counts.ready;
              return (
                <div key={p.aggKey} className="border-b border-white/[0.05] last:border-b-0" data-testid={`player-row-${p.displayName}`}>
                  {/* 主条目（桌面） */}
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.aggKey)}
                    aria-expanded={isOpen}
                    className="hidden w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03] md:grid md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_54px_60px_minmax(0,2fr)_84px_64px] md:items-center"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={spring} className="shrink-0" aria-hidden="true">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-[#93a89a]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#93a89a]" />}
                      </motion.span>
                      <span className="truncate text-xs font-bold text-white" title={p.displayName}>{p.displayName}</span>
                      {p.rawNameVariants.length > 1 && (
                        <WSBadge label={`×${p.rawNameVariants.length}形态`} cls="border-white/15 bg-white/[0.05] text-[#93a89a]" title={`原始名称变体：${p.rawNameVariants.join(' / ')}（已按身份归并展示；原名全部保留可追溯）`} />
                      )}
                    </span>
                    <span><TierBadges tiers={p.currentTiers} candidates={p.tierCandidates} /></span>
                    <span className="text-right text-xs font-bold text-white/90">{p.ticketCount}</span>
                    <span className={`text-right text-xs font-bold ${pending > 0 ? 'text-amber-300' : 'text-[#6d7f72]'}`}>{pending}</span>
                    <span className="flex flex-wrap gap-1">
                      {p.needsReview && <WSBadge label="身份待核对" cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />}
                      {p.counts.ready > 0 && <WSBadge label={`待归档 ${p.counts.ready}`} cls="border-[rgba(191,90,242,0.35)] bg-[rgba(191,90,242,0.10)] text-[#d0a6f7]" />}
                      {p.counts.pendingReview > 0 && <WSBadge label={`待核对 ${p.counts.pendingReview}`} cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />}
                      {p.counts.playerPending > 0 && <WSBadge label={`待确认 ${p.counts.playerPending}`} cls="border-sky-400/25 bg-sky-400/10 text-sky-300" />}
                      {p.counts.disputed > 0 && <WSBadge label={`异议 ${p.counts.disputed}`} cls="border-orange-500/30 bg-orange-500/10 text-orange-300" />}
                      {p.counts.confirmed > 0 && <WSBadge label={`已确认 ${p.counts.confirmed}`} cls="border-emerald-400/25 bg-emerald-400/10 text-emerald-300" />}
                      {p.counts.archived > p.counts.confirmed && <WSBadge label={`已归档 ${p.counts.archived}`} cls="border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300/80" />}
                      {p.ticketCount === 0 && <span className={WS.faintText}>—</span>}
                    </span>
                    <span className="font-mono text-[10px] text-[#9db4a4]">{p.latestTestDate ?? '未提供'}</span>
                    <span className="text-right">
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={e => { e.stopPropagation(); onOpenDetail(p); }}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onOpenDetail(p); } }}
                        className="inline-flex min-h-[32px] cursor-pointer items-center gap-1 rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold text-[#c9d4cc] transition-colors hover:border-[rgba(191,90,242,0.4)] hover:text-white"
                      >
                        <Eye className="h-3 w-3" aria-hidden="true" /> 详情
                      </span>
                    </span>
                  </button>

                  {/* 主条目（移动卡片） */}
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.aggKey)}
                    aria-expanded={isOpen}
                    className="flex w-full flex-col gap-1.5 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03] md:hidden"
                  >
                    <span className="flex items-center gap-1.5">
                      <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={spring} className="shrink-0" aria-hidden="true">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-[#93a89a]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#93a89a]" />}
                      </motion.span>
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{p.displayName}</span>
                      <span className="text-[10px] text-[#93a89a]">{p.ticketCount} 单</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1 pl-4">
                      <TierBadges tiers={p.currentTiers} candidates={p.tierCandidates} />
                      {p.needsReview && <WSBadge label="身份待核对" cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />}
                      {p.counts.ready > 0 && <WSBadge label={`待归档 ${p.counts.ready}`} cls="border-[rgba(191,90,242,0.35)] bg-[rgba(191,90,242,0.10)] text-[#d0a6f7]" />}
                      {p.counts.pendingReview > 0 && <WSBadge label={`待核对 ${p.counts.pendingReview}`} cls="border-amber-400/30 bg-amber-400/10 text-amber-300" />}
                      {p.counts.disputed > 0 && <WSBadge label={`异议 ${p.counts.disputed}`} cls="border-orange-500/30 bg-orange-500/10 text-orange-300" />}
                      {p.counts.playerPending > 0 && <WSBadge label={`待确认 ${p.counts.playerPending}`} cls="border-sky-400/25 bg-sky-400/10 text-sky-300" />}
                      {p.counts.confirmed > 0 && <WSBadge label={`已确认 ${p.counts.confirmed}`} cls="border-emerald-400/25 bg-emerald-400/10 text-emerald-300" />}
                    </span>
                    <span className="pl-4 text-[10px] text-[#6d7f72]">最近测试：{p.latestTestDate ?? '未提供'} · 点按展开全部 {p.ticketCount} 条记录</span>
                  </button>

                  {/* 展开区：全部测试记录 */}
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={spring}
                        className="overflow-hidden bg-black/15"
                      >
                        <div className="flex flex-col gap-1.5 px-3 pb-3 pt-2 md:px-4">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#6d7f72]">
                            <span>
                              共 {recs.length} 条独立测试记录（同玩家不同日期/项目/结果分别保留；原始名称：
                              {p.rawNameVariants.join(' / ')}）
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={() => onOpenDetail(p)}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpenDetail(p); }}
                              className="cursor-pointer font-bold text-[#c98af5] hover:underline"
                            >
                              打开完整详情 →
                            </span>
                          </div>
                          {recs.map(r => (
                            <div
                              key={r.id}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.05] bg-[rgba(12,18,14,0.6)] px-2.5 py-1.5 text-[11px]"
                            >
                              <span className="font-mono text-[#9db4a4]">{(r.norm.testDateIso ?? (r.raw.testDate || '未提供')).slice(0, 10)}</span>
                              <span className="min-w-0 flex-1 truncate text-white/85">{r.raw.project || '未提供'}</span>
                              <span className="text-[#93a89a]">考核员 {r.norm.examinerId || '未提供'}</span>
                              <span className="text-[#93a89a]">→ {r.norm.testTierNorm ?? (r.raw.testTier || '未提供')}</span>
                              <KDChips r={r} />
                              <StateBadges r={r} />
                            </div>
                          ))}
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

      {/* 口径脚注 */}
      <p className={`text-[10px] leading-relaxed ${WS.faintText}`}>
        聚合规则：玩家身份优先（游戏 ID / 唯一名称匹配）；同名但不同 ID 不合并；同 ID 不同名称进入改名核对线索；
        名称尾缀（如 bad小杨HT5）只有在「去除后唯一命中榜单条目」时才作为标注分离展示，否则保留原名并标记人工核对；
        排序四层：玩家 → 考核组合 → 测试日期（旧→新）→ 提交者兜底（组内记录按此保留）。
      </p>
    </div>
  );
}
