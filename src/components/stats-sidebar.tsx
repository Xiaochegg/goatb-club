'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Sparkles, TrendingUp, Sword } from 'lucide-react';
import {
  MODE_LABELS, TIER_BG_COLORS, TIER_COLORS,
  type GameMode,
} from '@/lib/constants';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';
import { ModeIcon } from '@/components/mc-icon';
import { FxCountUp } from '@/components/fx/fx-count-up';
import { TierBadge } from '@/components/tier-badge';
import type { TagStyle } from '@/lib/tag-styles';
import { Skeleton } from '@/components/ui/skeleton';
import { cachedFetchJSON, invalidateClientCache } from '@/lib/client-cache';

// ============================================================
// Hook: fetch real analytics from /api/v1/stats
// ============================================================
interface StatsData {
  overview: {
    totalPlayers: number;
    totalScore: number;
    avgScore: number;
    totalLikes: number;
    emotionCount: number;
    topPlayer: { id: string; name: string; score: number } | null;
    aggStats: { kills: number; deaths: number; wins: number; matches: number; kd: string; winRate: string };
  };
  scoreDistribution: { label: string; min: number; max: number; count: number }[];
  tierDistribution: { tier: string; count: number; color: string }[];
  modeLeaders: { mode: string; leader: { id: string; name: string; score: number; tier: string | null; tagStyle?: TagStyle | null } | null; participantCount: number }[];
  topPlayers: { rank: number; id: string; name: string; score: number; likes: number; level: number; bestTier: string | null }[];
}

function useStats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // C2/C3：经 client-cache（45s TTL + 与页脚共享同一缓存条目/在途请求）。
        // okRequired 对齐原 res.ok 检查：非 2xx 抛错 → failed 状态 + 重试按钮。
        const data = await cachedFetchJSON<StatsData>('/api/v1/stats', { okRequired: true });
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  // C3：手动重试 = 定向失效 stats 缓存后重拉（不再可能命中 45s 内的失败前成功值）
  const refresh = useCallback(() => {
    invalidateClientCache('/api/v1/stats');
    setRefreshKey(k => k + 1);
  }, []);

  return { stats, loading, failed, refresh };
}

// ============================================================
// Component: Stats Sidebar — real analytics from /api/v1/stats
// Desktop right column. Liquid Glass cards with charts.
// 整体从 page.tsx 拆出（wave-6）。自包含：
//   - useStats hook（fetch /api/v1/stats，4 useState + useEffect）
//   - 三面板渲染（OVERVIEW / DISTRIBUTION / MODE KINGS）
//   - MODE KINGS 数据来自后端 stats.modeLeaders（独立于 PlayerList
//     的 modeRanks——后者是前端 getSortedPlayers+computeTieRanks
//     算的「我第几」，这里是后端算的「谁第一」，方向不同）
// ============================================================
export function StatsSidebar() {
  const { stats, loading, failed, refresh } = useStats();
  // 2026-10 v2: RANK DISTRIBUTION 默认折叠 — 普通玩家不被干扰，
  // 管理员/硬核玩家点开展看直方图+段位分布。
  const [distOpen, setDistOpen] = useState(false);

  // V6: genuine three-state — skeleton while loading, retry card on
  // failure (the old code showed the skeleton FOREVER on error)
  // P2-2：加载态统一用 shadcn Skeleton 基件（对齐 CG-1 LeaderboardSkeleton
  // 模式）；形状复刻 OVERVIEW 面板（标题行 + 两行指标），CLS≈0。
  if (loading) {
    return (
      <div className="space-y-3">
        <div className="liquid-glass rounded-[var(--radius-liquid-md)] p-4">
          <Skeleton className="h-3 w-28 mb-3 bg-white/10" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full bg-white/5" />
            <Skeleton className="h-4 w-4/5 bg-white/5" />
          </div>
        </div>
      </div>
    );
  }
  if (!stats) {
    return failed ? (
      <div className="liquid-glass rounded-[var(--radius-liquid-md)] p-4 text-center">
        <AlertTriangle className="w-5 h-5 text-amber-400 mx-auto" />
        <p className="text-xs text-muted-foreground mt-2">统计数据加载失败</p>
        <button onClick={refresh} className="mt-2 text-xs text-jade-400 hover:text-jade-300 font-medium">重试</button>
      </div>
    ) : (
      <div className="space-y-3">
        <div className="liquid-glass rounded-[var(--radius-liquid-md)] p-4">
          <Skeleton className="h-3 w-28 bg-white/10" />
        </div>
      </div>
    );
  }

  const { overview, scoreDistribution, tierDistribution, modeLeaders } = stats;
  const maxTierCount = tierDistribution[0]?.count || 1;
  const maxBucketCount = Math.max(...scoreDistribution.map(b => b.count), 1);

  return (
    <div className="space-y-3">
      {/* ═══ Panel 1 · OVERVIEW — 紧凑数据模块（2026-10 重构）═══
          从 8 大方块 → 两行紧凑文本，释放侧栏空间给排行榜。
          数据零丢失：玩家/均分/点赞/感动 + KD/胜率/场次/击杀 全保留。 */}
      <motion.div
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.22, delay: 0.2, ease: [0.2, 0.9, 0.2, 1] }}
        className="lgx-panel lgx-panel-compact v2b2-panel v2l-card scroll-mt-24"
      >
        <h3 className="lgx-panel-title">
          <Sparkles className="w-3 h-3 text-secondary-foreground" />
          Server Overview
        </h3>
        <div className="lgx-overview-compact">
          {/* Arena Console V2.0：单行指标 → 三枚 stat tile（BoardUI stat tiles 模式）。
              仅展示层重排——数据字段（totalPlayers/avgScore/totalLikes）与
              FxCountUp 数字滚动组件全部原样保留，取数链路零改动。 */}
          <div className="grid grid-cols-3 gap-1.5">
            <div className="stat-tile v2b2-tile">
              <span className="stat-tile-value">
                <FxCountUp to={overview.totalPlayers} />
              </span>
              <span className="stat-tile-label">Players</span>
            </div>
            <div className="stat-tile v2b2-tile">
              <span className="stat-tile-value">
                <FxCountUp to={overview.avgScore} separator="," />
              </span>
              <span className="stat-tile-label">Rating</span>
            </div>
            <div className="stat-tile v2b2-tile">
              <span className="stat-tile-value">
                <FxCountUp to={overview.totalLikes} />
              </span>
              <span className="stat-tile-label">Likes</span>
            </div>
          </div>
          {overview.aggStats && overview.aggStats.matches > 0 && (
            <div className="lgx-overview-row mt-1.5">
              <span className="lgx-ov-num">{overview.aggStats.kd}</span><span className="lgx-ov-lbl">KD</span>
              <span className="lgx-ov-sep">·</span>
              <span className="lgx-ov-num">{overview.aggStats.winRate}</span><span className="lgx-ov-lbl">Win</span>
              <span className="lgx-ov-sep">·</span>
              <span className="lgx-ov-num">{overview.aggStats.matches}</span><span className="lgx-ov-lbl">Matches</span>
            </div>
          )}
        </div>
      </motion.div>

      {/* ═══ Panel 2 · RANK DISTRIBUTION — 默认折叠（2026-10 v2）═══
          普通玩家不被分析数据干扰；管理员/硬核玩家点开展看。
          收起时只有一行标题（＋），展开显示直方图+段位分布。 */}
      <motion.div
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.22, delay: 0.26, ease: [0.2, 0.9, 0.2, 1] }}
        className="lgx-panel lgx-panel-compact v2b2-panel v2l-card scroll-mt-24"
      >
        <button
          onClick={() => setDistOpen(o => !o)}
          className="w-full flex items-center justify-between group"
          aria-expanded={distOpen}
        >
          <h3 className="lgx-panel-title !mb-0">
            <TrendingUp className="w-3 h-3 text-jade-400" />
            Rank Distribution
          </h3>
          <span className="text-[10px] text-white/40 group-hover:text-white/70 transition-colors" aria-hidden="true">
            {distOpen ? '－' : '＋'}
          </span>
        </button>
        {distOpen && (
          <div className="mt-2.5">
            <div className="flex items-end justify-between gap-1.5 h-14 mb-1.5">
              {scoreDistribution.map((b) => (
                <div key={b.label} className="flex-1 flex flex-col items-center gap-1" title={`${b.label}：${b.count} 人`}>
                  <span className="text-[9px] text-white/45 number-score">{b.count}</span>
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: `${(b.count / maxBucketCount) * 100}%` }}
                    transition={{ duration: 0.5, ease: [0.2, 0.9, 0.2, 1], delay: 0.1 }}
                    className="w-full rounded-t-sm bg-gradient-to-t from-jade-500/40 to-jade-400/80 min-h-[2px]"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-1.5">
              {scoreDistribution.map((b) => (
                <span key={b.label} className="flex-1 text-center text-[8px] text-white/35 truncate">{b.label}</span>
              ))}
            </div>
            {tierDistribution.length > 0 && (
              <>
                <hr className="lgx-divider" />
                <div className="space-y-1.5">
                  {tierDistribution.slice(0, 6).map(({ tier, count }) => {
                    const pct = (count / maxTierCount) * 100;
                    return (
                      <div key={tier} className="flex items-center gap-2" title={`${tier}：${count} 人`}>
                        <span
                          className="lgx-tier w-10 text-center flex-shrink-0"
                          style={{ background: TIER_BG_COLORS[tier], color: TIER_COLORS[tier], border: `1px solid ${TIER_COLORS[tier]}44` }}
                        >
                          {tier}
                        </span>
                        <div className="flex-1 liquid-progress-track h-1.5">
                          <motion.div
                            className="liquid-progress-fill"
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.5, ease: [0.2, 0.9, 0.2, 1], delay: 0.15 }}
                          />
                        </div>
                        <span className="text-[10px] text-white/45 number-score w-6 text-right">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </motion.div>

      {/* ═══ Panel 3 · MODE KINGS — who rules each board（降级紧凑）═══
          2026-10 重构：保留 Mode Kings 但紧凑化。排行榜才是主角，侧栏只做辅助。 */}
      <motion.div
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.22, delay: 0.26, ease: [0.2, 0.9, 0.2, 1] }}
        className="lgx-panel lgx-panel-compact v2b2-panel v2l-card scroll-mt-24"
      >
        <h3 className="lgx-panel-title">
          <Sword className="w-3 h-3 text-jade-400" />
          Mode Kings · 模式之王
        </h3>
        <div className="space-y-1.5">
          {modeLeaders.filter(m => m.leader).slice(0, 6).map(({ mode, leader }) => (
            <div key={mode} className="flex items-center gap-2">
              <ModeIcon mode={mode as GameMode} size="sm" className="flex-shrink-0" />
              <span className="text-[10px] text-white/45 truncate w-12 flex-shrink-0">{MODE_LABELS[mode as GameMode]}</span>
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                style={{ background: getAvatarColor(leader!.name) }}
              >
                <span className="text-white">{getAvatarInitial(leader!.name)}</span>
              </div>
              <span className="text-[11px] text-white/85 truncate flex-1">{leader!.name}</span>
              {leader!.tier && (
                /* 榜首徽章走 TierBadge：与榜单行同构，且携带玩家个性标签样式（光效对外展示位） */
                <TierBadge tier={leader!.tier} size="sm" tagStyle={leader!.tagStyle ?? null} />
              )}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
