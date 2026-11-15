'use client';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Heart, TrendingUp, TrendingDown, Minus, Loader2,
} from 'lucide-react';
import { useAppStore } from '@/lib/store';
import {
  ALL_MODES, MODE_LABELS,
  NORMAL_TIER_SCORES, JIAHAO_TIER_SCORES,
  calcKD, calcWinRate, calcLevel, getLevelProgress,
  getThemePanelPalette,
  type Tier, type GameMode, type NormalTier, type JiahaoTier, type PlayerStats, type BoardMode,
} from '@/lib/constants';
import {
  getPlayerModeScore,
  getPlayerTotalScore,
  getPlayerBoardScore,
  getSortedPlayers,
  computeTieRanks,
  type RatingBreakdown,
} from '@/lib/scoring';
import { getAvatarInitial, getAvatarColor, bigNumSizeClass } from '@/lib/ui-utils';
import { ModeIcon } from '@/components/mc-icon';
import { TierBadge } from '@/components/tier-badge';
// PLAYER IDENTITY ENGINE V1.0（trace 1a1cfcfc32dceef1 批示「通过」）
import { VisualStageProvider, useVisualStage } from '@/components/visual/visual-stage';
import { VisualBox, VisualAmbientBackground } from '@/components/visual/visual-objects';
import '@/components/visual/visual.css';

// ============================================================
// VisualEventWatcher — 真实业务事件检测（任务书 §十一）
// ------------------------------------------------------------
// 只根据【真实数据 diff】触发：前后值 ref 比对；同一事件 3s 冷却
// 在 stage.fireVisualEvent 内统一执行。没有任何数据变化就不播动画，
// 绝不用动画伪造排名/段位变化（表现层只读，不改任何业务数据）。
// ============================================================
function VisualEventWatcher({
  currentModeRank, totalRank, bestTier, totalScore, activeMode, ratingExpanded,
}: {
  currentModeRank: number;
  totalRank: number;
  bestTier: string | null;
  totalScore: number;
  activeMode: string;
  ratingExpanded: boolean;
}) {
  const stage = useVisualStage();
  const prev = useRef<{ rank: number; tier: string | null; score: number; mode: string; expanded: boolean } | null>(null);
  const firedOpen = useRef(false);

  useEffect(() => {
    if (!stage) return;
    if (!firedOpen.current) {
      firedOpen.current = true;
      stage.fireVisualEvent('PLAYER_PROFILE_OPEN');
      prev.current = { rank: currentModeRank, tier: bestTier, score: totalScore, mode: activeMode, expanded: ratingExpanded };
      return;
    }
    const p = prev.current;
    if (p) {
      // 真实段位变化（优先级最高，覆盖统计类反馈）
      if (bestTier !== p.tier && bestTier !== null && p.tier !== null) {
        stage.fireVisualEvent('TIER_CHANGED');
      } else if (totalScore !== p.score) {
        stage.fireVisualEvent('STATISTICS_UPDATED');
      }
      // 真实名次变化（两事件各自独立绑定，管理员可分别配置）
      if (currentModeRank !== p.rank) stage.fireVisualEvent('RANK_CHANGED');
      if (totalRank !== p.rank && currentModeRank === p.rank) stage.fireVisualEvent('LEADERBOARD_POSITION_CHANGED');
      // 模式切换 / 明细展开
      if (activeMode !== p.mode) stage.fireVisualEvent('TAB_CHANGED');
      if (ratingExpanded && !p.expanded) stage.fireVisualEvent('PLAYER_CARD_EXPANDED');
    }
    prev.current = { rank: currentModeRank, tier: bestTier, score: totalScore, mode: activeMode, expanded: ratingExpanded };
  }, [stage, currentModeRank, totalRank, bestTier, totalScore, activeMode, ratingExpanded]);

  // PLAYER_PROFILE_CLOSE：卸载 = 面板关闭（AnimatePresence 退场窗口内
  // provider 仍在挂载；若已同步卸载则为无害 no-op）。经 ref 捕获避免
  // cleanup 闭包过期。
  const stageRef = useRef(stage);
  useEffect(() => { stageRef.current = stage; }, [stage]);
  useEffect(() => {
    return () => { stageRef.current?.fireVisualEvent('PLAYER_PROFILE_CLOSE'); };
  }, []);

  return null;
}

// ============================================================
// Component: Player Detail Modal
// ============================================================
// Spring-stagger variants for the modular player panel blocks
const panelBlock = {
  hidden: { opacity: 0, y: 18, scale: 0.96, filter: 'blur(6px)' },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { type: 'spring' as const, stiffness: 300, damping: 25, mass: 0.8, delay: 0.04 + i * 0.05 },
  }),
};

// ============================================================
// Rank History Chart — SVG sparkline of a player's rank over time.
// Reads /api/v1/rank-snapshots. Shows "暂无历史数据" gracefully
// when fewer than 2 snapshots exist (first-run state).
// ============================================================
function RankHistoryBlock({ playerId, mode, label }: { playerId: string; mode: string; label: string }) {
  const [history, setHistory] = useState<Array<{ rank: number; score: number; at: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch pattern; setLoading(true) is needed on dep change
    setLoading(true);
    fetch(`/api/v1/rank-snapshots?playerId=${playerId}&mode=${mode}&limit=30`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setHistory(d.history || []); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playerId, mode]);

  // SVG dimensions
  const W = 280, H = 70, PAD = 8;

  if (loading) {
    return (
      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3">
        <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)] pb-2 flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" /> 排名走势 · {label}
        </div>
        <div className="h-[70px] flex items-center justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-[var(--tertiary-label)]" />
        </div>
      </div>
    );
  }

  if (history.length < 2) {
    return (
      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3">
        <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)] pb-2 flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" /> 排名走势 · {label}
        </div>
        <div className="h-[70px] flex flex-col items-center justify-center gap-1">
          <p className="text-[10px] text-[var(--tertiary-label)]">暂无历史数据</p>
          <p className="text-[9px] text-[var(--tertiary-label)]">管理员触发快照后这里会显示排名走势</p>
        </div>
      </div>
    );
  }

  // Build sparkline path — invert rank (lower rank = higher on chart = better)
  const ranks = history.map(h => h.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const range = maxRank - minRank || 1;
  const xStep = (W - PAD * 2) / (history.length - 1);

  const points = history.map((h, i) => {
    const x = PAD + i * xStep;
    // rank 1 = top (PAD), maxRank = bottom (H - PAD)
    const y = PAD + ((h.rank - minRank) / range) * (H - PAD * 2);
    return { x, y, ...h };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${H - PAD} L ${PAD} ${H - PAD} Z`;

  const first = history[0];
  const last = history[history.length - 1];
  const change = first.rank - last.rank; // positive = improved (lower rank number = better)
  const peakRank = Math.min(...ranks); // best (lowest) rank

  return (
    <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3">
      <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)] pb-2 flex items-center gap-1.5">
        <TrendingUp className="w-3 h-3" /> 排名走势 · {label}
      </div>
      <div className="flex items-center gap-3">
        <svg width={W} height={H} className="flex-shrink-0" viewBox={`0 0 ${W} ${H}`}>
          {/* gradient fill under the line */}
          <defs>
            <linearGradient id={`rh-grad-${mode}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--jade-500)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--jade-500)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaD} fill={`url(#rh-grad-${mode})`} />
          <path d={pathD} fill="none" stroke="var(--jade-500)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
          {/* start + end dots */}
          <circle cx={points[0].x} cy={points[0].y} r="2.5" fill="var(--jade-500)" opacity="0.5" />
          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="3" fill="var(--jade-500)" />
        </svg>
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-[var(--tertiary-label)] uppercase tracking-wider">当前</span>
            <span className="text-sm font-bold number-score text-[var(--label)]">#{last.rank}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-[var(--tertiary-label)] uppercase tracking-wider">变化</span>
            <span className={cn(
              'text-xs font-bold number-score flex items-center gap-0.5',
              change > 0 ? 'text-[var(--system-green)]' : change < 0 ? 'text-[var(--system-red)]' : 'text-[var(--tertiary-label)]'
            )}>
              {change > 0 ? <TrendingUp className="w-3 h-3" /> : change < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
              {change > 0 ? `+${change}` : change || '0'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-[var(--tertiary-label)] uppercase tracking-wider">峰值</span>
            <span className="text-xs font-bold number-score text-secondary-foreground">#{peakRank}</span>
          </div>
        </div>
      </div>
      <p className="text-[9px] text-[var(--tertiary-label)] mt-1.5">
        {history.length} 个快照 · {new Date(first.at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} → {new Date(last.at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
      </p>
    </div>
  );
}

// ============================================================
// PlayerDetailModal — extracted from src/app/page.tsx (split-detail)
// ============================================================
export function PlayerDetailModal() {
  const { selectedPlayerId, setSelectedPlayerId, players, activeMode, currentUserId, theme } = useAppStore();
  const player = players.find(p => p.id === selectedPlayerId);

  // Theme-aware inverted panel palette — the modal surface INVERTS the
  // active theme (dark theme → light panel + dark text) so detail content
  // stays readable regardless of which ambient theme is active. Injected
  // as --panel-* CSS vars on the modal root, consumed by .pvp-modal-themed.
  const panelPalette = useMemo(() => getThemePanelPalette(theme), [theme]);

  // Escape closes the dialog (self-review fix — standard dialog behavior)
  useEffect(() => {
    if (!selectedPlayerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedPlayerId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPlayerId, setSelectedPlayerId]);

  // Memoize all rank computations — avoids 11× re-sort per render
  // 2026-10 并列规则：同积分 → 同名次（computeTieRanks 密集排名 1,1,2,2,3,3），
  // 排序先后由 getSortedPlayers 破平键（战绩评分 desc → 名字字母序）决定。
  const rankData = useMemo(() => {
    if (!player) return null;
    const rankOf = (mode: BoardMode) => {
      const ranked = getSortedPlayers(players, mode, true, '');
      const tieRanks = computeTieRanks(ranked, p => getPlayerBoardScore(p, mode));
      const idx = ranked.findIndex(p => p.id === player.id);
      return idx >= 0 ? tieRanks[idx] : 0;
    };
    const currentModeRank = rankOf(activeMode);
    const totalRank = rankOf('TOTAL');
    const modeRanks: Record<string, number> = {};
    ALL_MODES.forEach(mode => { modeRanks[mode] = rankOf(mode); });
    return { currentModeRank, totalRank, modeRanks };
  }, [player, players, activeMode]);

  // Memoize aggregate stats
  const aggStats = useMemo<PlayerStats>(() => {
    if (!player) return { kills: 0, deaths: 0, wins: 0, matches: 0 };
    const s: PlayerStats = { kills: 0, deaths: 0, wins: 0, matches: 0 };
    ALL_MODES.forEach(mode => {
      const st = player.stats?.[mode];
      if (st) { s.kills += st.kills; s.deaths += st.deaths; s.wins += st.wins; s.matches += st.matches; }
    });
    return s;
  }, [player]);

  // W3-T3: 评分明细 — fetch rating breakdown for the detail modal
  // OPT-B：key 失效模式——state 携带请求 key，派生时比对当前 key，
  // 不匹配即视为旧玩家/旧模式的脏数据（替代 effect 内同步 setState 清空，
  // 规避 react-hooks/set-state-in-effect 级联渲染规则）。
  const [ratingState, setRatingState] = useState<{ key: string; data: RatingBreakdown } | null>(null);
  const [showRatingPanel, setShowRatingPanel] = useState(false);
  const ratingKey = `${selectedPlayerId}:${activeMode}`;
  useEffect(() => {
    if (!selectedPlayerId) return;
    let cancelled = false;
    const key = ratingKey;
    fetch(`/api/v1/players/${selectedPlayerId}/rating-breakdown?mode=${activeMode === 'EMOTION' ? 'TOTAL' : activeMode}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d.breakdown) setRatingState({ key, data: d.breakdown }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedPlayerId, activeMode, ratingKey]);
  const ratingBreakdown = ratingState && ratingState.key === ratingKey ? ratingState.data : null;

  if (!player || !rankData) return null;

  const totalScore = getPlayerTotalScore(player);
  const { currentModeRank, totalRank, modeRanks } = rankData;
  const hasAggStats = aggStats.kills > 0 || aggStats.deaths > 0 || aggStats.matches > 0;
  const levelProgress = getLevelProgress(totalScore);

  // 数字外露防线（2026-10）：窄卡片大数字先格式化千分位，再按字符数
  // 降级字号；truncate + title 兜底超长脏数据，任何量级都不挤出卡片。
  const totalScoreText = totalScore.toLocaleString();
  const rankText = currentModeRank ? String(currentModeRank) : '—';
  const kdText = hasAggStats ? calcKD(aggStats) : '—';
  const winRateText = hasAggStats ? calcWinRate(aggStats) : '—';
  const matchesText = hasAggStats ? aggStats.matches.toLocaleString() : '—';

  // Best tier across all modes (identity block badge)
  const bestTier = ALL_MODES.reduce<Tier | null>((best, mode) => {
    const t = player.tiers?.[mode];
    if (!t) return best;
    if (!best) return t;
    return (NORMAL_TIER_SCORES[t as NormalTier] ?? JIAHAO_TIER_SCORES[t as JiahaoTier] ?? 0) >
      (NORMAL_TIER_SCORES[best as NormalTier] ?? JIAHAO_TIER_SCORES[best as JiahaoTier] ?? 0) ? t : best;
  }, null);

  // Current active mode label
  const currentModeLabel = activeMode === 'TOTAL'
    ? '总榜'
    : activeMode === 'EMOTION'
      ? '感动榜'
      : MODE_LABELS[activeMode as GameMode] || activeMode;

  return (
    <AnimatePresence>
      {selectedPlayerId && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[105] flex items-center justify-center p-3"
          onClick={() => setSelectedPlayerId(null)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="玩家详情"
            initial={{ y: 24, scale: 0.92, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.85, opacity: 0, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.9 }}
            onClick={e => e.stopPropagation()}
            className="relative w-[min(75vw,358px)] liquid-glass-strong pvp-modal-themed rounded-[var(--radius-liquid-lg)] p-0 overflow-hidden"
            style={{
              '--panel-surface': panelPalette.surface,
              '--panel-surface-alt': panelPalette.surfaceAlt,
              '--panel-surface-soft': panelPalette.surfaceSoft,
              '--panel-text': panelPalette.text,
              '--panel-text-secondary': panelPalette.textSecondary,
              '--panel-text-tertiary': panelPalette.textTertiary,
              '--panel-border': panelPalette.border,
              '--panel-border-subtle': panelPalette.borderSubtle,
            } as React.CSSProperties}
          >
            {/* ── PLAYER IDENTITY ENGINE V1.0：视觉舞台（配置拉取/性能分级/事件总线）── */}
            <VisualStageProvider playerId={player.id}>
            <VisualAmbientBackground />
            <VisualEventWatcher
              currentModeRank={currentModeRank}
              totalRank={totalRank}
              bestTier={bestTier}
              totalScore={totalScore}
              activeMode={activeMode}
              ratingExpanded={showRatingPanel}
            />

            {/* ── Back Button · golden-ratio inset ──
                36px glass circle, inset = 36 × 0.618 ≈ 22px from panel
                edges (φ proportion, see .pvp-modal-back in globals.css).
                Anchored to the panel shell (scrolling happens in the
                inner content wrapper below), thin-stroke chevron,
                light gray → white on hover. */}
            <button
              onClick={() => setSelectedPlayerId(null)}
              className="pvp-modal-back absolute z-10 flex items-center justify-center rounded-full liquid-glass-subtle text-[var(--secondary-label)] hover:text-[var(--label)] transition-colors liquid-press"
              aria-label="返回排行榜"
            >
              <ChevronLeft className="w-[18px] h-[18px]" strokeWidth={2} />
            </button>

            {/* ══════════════════════════════════════════════════
                MODULAR PLAYER PANEL — composable glass blocks.
                Identity row → twin stat blocks → micro-block grid
                → mode chip grid → emotion block. Spring-staggered
                plug-in blocks, minimal vertical scroll.
            ══════════════════════════════════════════════════ */}
            {/* px-3.5 legacy gutter · pt-70px reserves the back-button band
                (22.25 inset + 36 button + 12 gap) · pb-3 + space-y-2 keep
                the 80%-scaled panel within 70vh without hurting legibility
                · scroll lives HERE so the back button never drifts
                · pvp-scroll-fade: 顶部 mask 渐隐 — 滚动时卡片数字在滑入
                  玻璃返回按钮下方前变透明（数字外露修复） */}
            <div className="px-3.5 pt-[70px] pb-3 space-y-2 max-h-[70vh] overflow-y-auto custom-scrollbar pvp-scroll-fade">

              {/* ── Block: Identity row (avatar block · name block · tier block)
                      PIE V1.0：PROFILE_CARD / AVATAR / RANK_BADGE 三对象接入
                      （形状/尺寸/入场/环境/交互由管理员视觉配置驱动）── */}
              <VisualBox
                target="PROFILE_CARD"
                className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3"
              >
              <motion.div
                variants={panelBlock} custom={0} initial="hidden" animate="show"
                className="flex items-center gap-3 w-full"
              >
                <VisualBox
                  target="AVATAR"
                  className="flex-shrink-0"
                  style={{ borderRadius: 'var(--radius-liquid-md)' }}
                >
                  <div
                    className="w-full h-full flex items-center justify-center text-xl font-bold overflow-hidden"
                    style={{
                      background: player.avatarUrl ? 'transparent' : getAvatarColor(player.name),
                      boxShadow: '0 6px 18px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
                    }}
                  >
                    {player.avatarUrl ? (
                      <img src={player.avatarUrl} alt={player.name} className="w-full h-full object-cover" />
                    ) : <span className="text-white drop-shadow-lg">{getAvatarInitial(player.name)}</span>}
                  </div>
                </VisualBox>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h2 className={cn(
                      "text-[17px] font-bold truncate tracking-tight leading-tight",
                      player.id === currentUserId ? "text-jade-300" : "text-[var(--label)]"
                    )}>{player.name}</h2>
                    {player.id === currentUserId && (
                      <span className="text-[8px] font-bold text-jade-300 bg-jade-500/20 px-1 py-0.5 rounded leading-none tracking-wider flex-shrink-0">YOU</span>
                    )}
                  </div>
                  {/* LGX · Identity layer — UUID + last-active line */}
                  <div className="text-[9px] text-[var(--secondary-label)] mt-1 flex items-center gap-1.5 min-w-0">
                    <span className="font-mono truncate" title={`UUID ${player.id}`}>@{player.id.slice(-8)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">{new Date(player.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 活跃</span>
                  </div>
                  <div className="text-[8px] text-[var(--tertiary-label)] tracking-[0.18em] uppercase mt-0.5">GOATB · Player Profile</div>
                </div>
                {bestTier && (
                  /* P2 统一：身份块徽章复用 TierBadge（lg 尺寸，与榜单主 chip 同构）
                     PIE V1.0：RANK_BADGE 对象包装（段位变化事件特效落点）*/
                  <VisualBox target="RANK_BADGE" className="flex-shrink-0">
                    <TierBadge tier={bestTier} size="lg" tagStyle={player.tagStyle} />
                  </VisualBox>
                )}
              </motion.div>
              </VisualBox>

              {/* ── Blocks: twin core stats (score · rank) — PIE V1.0: STATS_CARD ── */}
              <div className="grid grid-cols-2 gap-2.5">
                <VisualBox target="STATS_CARD" className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3">
                <motion.div
                  variants={panelBlock} custom={1} initial="hidden" animate="show"
                  className="w-full"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">总分</div>
                  <div
                    title={`总分 ${totalScoreText}`}
                    className={cn(
                      "liquid-score font-bold leading-tight mt-1 min-w-0 truncate",
                      bigNumSizeClass(totalScoreText)
                    )}
                  >
                    {totalScoreText}
                  </div>
                  <div className="text-[9px] text-[var(--tertiary-label)] mt-0.5 number-score">
                    {activeMode !== 'TOTAL' ? `总榜 #${totalRank || '—'}` : `${player.likes || 0} 感动值`}
                  </div>
                </motion.div>
                </VisualBox>
                <VisualBox target="STATS_CARD" className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3">
                <motion.div
                  variants={panelBlock} custom={2} initial="hidden" animate="show"
                  className="w-full"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">{currentModeLabel}排名</div>
                  <div
                    title={`${currentModeLabel}排名 ${rankText}`}
                    className={cn(
                      "font-bold number-score leading-tight mt-1 min-w-0 truncate",
                      bigNumSizeClass(rankText),
                      currentModeRank <= 3 ? "text-secondary-foreground" : "text-[var(--label)]"
                    )}>
                    {rankText}
                  </div>
                  <div className="text-[9px] text-[var(--tertiary-label)] mt-0.5">共 {players.length} 名玩家</div>
                </motion.div>
                </VisualBox>
              </div>

              {/* ── Blocks: micro grid (level · K/D · winrate · matches) ── */}
              <div className="grid grid-cols-2 gap-2.5">
                <motion.div
                  variants={panelBlock} custom={3} initial="hidden" animate="show"
                  className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">等级</span>
                    <span className="liquid-level-badge text-[9px] px-1.5 py-0 leading-none">LV.{calcLevel(totalScore)}</span>
                  </div>
                  <div className="mt-2 mc-hud-progress" aria-label={`等级进度 ${levelProgress.percent}%`}>
                    {Array.from({ length: 10 }).map((_, i) => (
                      <span key={i} className={i < Math.floor(levelProgress.percent / 10) ? 'mc-hud-fill' : ''} />
                    ))}
                  </div>
                  <div className="text-[9px] text-[var(--tertiary-label)] mt-1.5 number-score">{levelProgress.current}/100 → LV.{calcLevel(totalScore) + 1}</div>
                </motion.div>
                <motion.div
                  variants={panelBlock} custom={4} initial="hidden" animate="show"
                  className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-2.5"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">K/D</div>
                  <div
                    title={`K/D ${kdText}`}
                    className={cn(
                      "font-bold number-score text-[var(--system-teal)] leading-tight mt-0.5 min-w-0 truncate",
                      bigNumSizeClass(kdText, 'micro')
                    )}
                  >{kdText}</div>
                </motion.div>
                <motion.div
                  variants={panelBlock} custom={5} initial="hidden" animate="show"
                  className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-2.5"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">胜率</div>
                  <div
                    title={`胜率 ${winRateText}`}
                    className={cn(
                      "font-bold number-score text-[var(--system-yellow)] leading-tight mt-0.5 min-w-0 truncate",
                      bigNumSizeClass(winRateText, 'micro')
                    )}
                  >{winRateText}</div>
                </motion.div>
                <motion.div
                  variants={panelBlock} custom={6} initial="hidden" animate="show"
                  className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-2.5"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)]">总场次</div>
                  <div
                    title={`总场次 ${matchesText}`}
                    className={cn(
                      "font-bold number-score text-[var(--label)] leading-tight mt-0.5 min-w-0 truncate",
                      bigNumSizeClass(matchesText, 'micro')
                    )}
                  >{matchesText}</div>
                </motion.div>
              </div>

              {/* W3-T3 · 评分明细 — 可折叠面板，公示公式 + 四项贡献 + 示例演算
                  PIE V1.0：FLOATING_PANEL 对象包装（PLAYER_CARD_EXPANDED 事件落点） */}
              <VisualBox target="FLOATING_PANEL" className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] overflow-hidden">
              <motion.div
                variants={panelBlock} custom={6.5} initial="hidden" animate="show"
                className="w-full"
              >
                <button
                  onClick={() => setShowRatingPanel(s => !s)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-left"
                  aria-expanded={showRatingPanel}
                >
                  <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--secondary-label)] flex items-center gap-1.5">
                    <span aria-hidden="true">{showRatingPanel ? '▾' : '▸'}</span>
                    评分规则 · 战绩评分
                  </span>
                  {ratingBreakdown && (
                    <span className="text-[14px] font-bold number-score text-[var(--label)]">
                      {ratingBreakdown.total}
                    </span>
                  )}
                </button>
                <AnimatePresence>
                  {showRatingPanel && ratingBreakdown && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="px-3.5 pb-3 space-y-2.5">
                        {/* 公式 */}
                        <div className="text-[9px] text-[var(--tertiary-label)] leading-relaxed font-mono bg-black/10 rounded px-2 py-1.5">
                          {ratingBreakdown.formula}
                        </div>
                        {/* 基础分 + 场次因子 */}
                        <div className="flex items-center justify-between text-[10px] text-[var(--secondary-label)]">
                          <span>基础分</span>
                          <span className="number-score text-[var(--label)]">{ratingBreakdown.base}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-[var(--secondary-label)]">
                          <span>场次因子 (1-e<sup>-m/30</sup>)</span>
                          <span className="number-score text-[var(--label)]">{ratingBreakdown.matchFactor.toFixed(3)}</span>
                        </div>
                        {/* 五项贡献进度条（含对手强度，权重 0 时灰显）*/}
                        {(['kills', 'deaths', 'wins', 'matches', 'opponentStrength'] as const).map(key => {
                          const c = ratingBreakdown.components[key];
                          const maxContrib = 1000 * ratingBreakdown.matchFactor * c.weight;
                          const pct = maxContrib > 0 ? (c.contribution / maxContrib) * 100 : 0;
                          const isInactive = c.weight === 0;
                          return (
                            <div key={key} className="space-y-1">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className={isInactive ? 'text-[var(--tertiary-label)]' : 'text-[var(--secondary-label)]'}>
                                  {c.label} <span className="text-[var(--tertiary-label)]">×{c.weight}</span>
                                  {isInactive && <span className="ml-1 text-[8px] text-secondary-foreground/60">[暂未启用]</span>}
                                </span>
                                <span className="number-score text-[var(--label)]">+{c.contribution}</span>
                              </div>
                              <div className="h-1.5 rounded-full bg-black/10 overflow-hidden">
                                <div
                                  className={cn('h-full rounded-full', isInactive ? 'bg-white/15' : 'bg-jade-500')}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <div className="text-[9px] text-[var(--tertiary-label)]">{c.detail}</div>
                            </div>
                          );
                        })}
                        {/* 示例演算汇总 — 贡献和 = 总分 - 基础分，计算器可复现 */}
                        <div className="flex items-center justify-between pt-1.5 border-t border-[var(--separator)]">
                          <span className="text-[10px] text-[var(--secondary-label)]">基础分 + 贡献和</span>
                          <span className="number-score text-[var(--secondary-label)]">
                            {ratingBreakdown.base} + {ratingBreakdown.components.kills.contribution + ratingBreakdown.components.deaths.contribution + ratingBreakdown.components.wins.contribution + ratingBreakdown.components.matches.contribution + ratingBreakdown.components.opponentStrength.contribution}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-[var(--label)]">战绩评分</span>
                          <span className="text-[16px] font-bold number-score text-[var(--label)]">{ratingBreakdown.total}</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
              </VisualBox>

              {/* ── Block: mode chip grid — PROGRESSION layer ──
                  Full 9-mode tier · score · rank matrix (received the
                  per-mode tier columns from the old 4-band card).
                  批示 trace 1a1d027ae7f6abd1「图标错位/空间感不足」光学修复：
                  ① 图标统一暗底芯片 .pi-mode-ico（XT 实拍图 mix-blend screen
                    在浅色卡上被溶解成碎片 = 「错位」根因；芯片提供设计基底
                    且抹平各图内容占框率差异）；② 间距升档（gap/mt/py 2→2.5）。 */}
              <motion.div
                variants={panelBlock} custom={7} initial="hidden" animate="show"
                className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3"
              >
                <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)] px-1 pb-2.5">模式排名</div>
                <div className="grid grid-cols-3 gap-2.5">
                  {ALL_MODES.map((mode) => {
                    const tier = player.tiers?.[mode];
                    const score = getPlayerModeScore(player, mode);
                    const st = player.stats?.[mode];
                    // 2026-10 bug 修复：未参评的模式（无段位分且 0 场对局）不显示排名 —
                    // 修复前：全量 findIndex 排名导致 0 分玩家在 9 个模式全部显示 #1/#2
                    const participated = score > 0 || (st ? st.matches > 0 : false);
                    const rank = modeRanks[mode] || 0;
                    const isCurrentMode = activeMode === mode;
                    return (
                      <div
                        key={mode}
                        className={cn(
                          // 工单 2026-11-12：窄屏徽章与名次错位修复 —
                          // ① 与 pvp.css 的 .pvp-mode-chip（inline-flex 布局劫持）解绑，
                          //   换纯配色 .pvp-mode-tile；② min-w-0 链 + 徽章裁剪 +
                          //   名次禁缩；③ py-2.5/gap-2.5 提升空间感（本批再升档）；
                          //   移动端 px-2 回调一档换 4 字模式名完整显示（芯片占位补偿）
                          "rounded-[var(--radius-liquid-sm)] px-2 sm:px-2.5 py-2.5 border transition-colors min-w-0",
                          isCurrentMode
                            ? "bg-jade-500/[0.10] border-jade-500/30"
                            : "pvp-mode-tile"
                        )}
                      >
                        <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
                          {/* 统一暗底芯片：screen 混合实拍图的设计基底 + 光学尺寸一致 */}
                          <span className="pi-mode-ico" aria-hidden="true">
                            <ModeIcon mode={mode} size="sm" />
                          </span>
                          <span className={cn(
                            "text-[10px] font-medium truncate leading-none min-w-0",
                            isCurrentMode ? "text-[var(--label)]" : "text-[var(--secondary-label)]"
                          )}>{MODE_LABELS[mode]}</span>
                        </div>
                        <div className="flex items-center justify-between gap-1.5 mt-2.5 min-w-0">
                          {tier ? (
                            /* P2 统一：矩阵徽章复用 TierBadge（sm 尺寸，菱形标+稀有段微光）
                               工单 2026-11-12：外层 min-w-0 + overflow-hidden —
                               最坏情况徽章裁剪而非压到名次上 */
                            <span className="min-w-0 max-w-[64%] overflow-hidden flex items-center">
                              <TierBadge tier={tier} size="sm" tagStyle={player.tagStyle} />
                            </span>
                          ) : (
                            <span className="text-[9px] text-[var(--tertiary-label)] leading-none">—</span>
                          )}
                          <span className={cn(
                            "text-[11px] font-bold number-score leading-none flex-shrink-0",
                            participated && rank > 0 && rank <= 3 ? "text-secondary-foreground" : "text-[var(--tertiary-label)]"
                          )}>
                            {participated && rank > 0 ? `#${rank}` : '—'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>

              {/* ── Block: Rank History sparkline — HISTORY layer ──
                  Real RankSnapshot data; comes after progression. */}
              <motion.div
                variants={panelBlock} custom={8} initial="hidden" animate="show"
              >
                <RankHistoryBlock
                  playerId={player.id}
                  mode={activeMode === 'EMOTION' ? 'TOTAL' : activeMode}
                  label={currentModeLabel}
                />
              </motion.div>

              {/* ── Block: emotion (optional plug-in) ── */}
              {player.emotionText && (
                <motion.div
                  variants={panelBlock} custom={9} initial="hidden" animate="show"
                  className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] p-3.5"
                >
                  <div className="text-[9px] uppercase tracking-[0.16em] text-[var(--secondary-label)] pb-1.5 flex items-center gap-1">
                    <Heart className="w-3 h-3 text-[var(--system-red)]" /> 感动榜
                  </div>
                  <p className="text-[13px] text-[var(--label)] leading-relaxed">{player.emotionText}</p>
                  {player.likes > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-[var(--secondary-label)]">
                      <span className="number-score text-[var(--label)]">{player.likes}</span> 次感动
                    </div>
                  )}
                </motion.div>
              )}
            </div>
            {/* Bottom safe area padding */}
            <div className="h-2" />
            </VisualStageProvider>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
