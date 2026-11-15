// ============================================================
// Component: Player Card — LGX compact row (UI refactor 2026-10)
// Two-line dense row: rank · skin · name+meta · tier chip ·
// rating core · rank change · like. The 9-mode tier matrix
// moved to the detail modal (L3 progressive disclosure).
// Flat background (no backdrop-filter) for jank-free FLIP re-rank.
// Extracted from page.tsx (split-wave-4, 2026-11) — pure display,
// no "use client" needed (auto client via parent page.tsx).
// ============================================================
import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { Heart, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useAppStore, type PlayerData } from '@/lib/store';
import {
  ALL_MODES, MODE_LABELS, MODE_ICONS,
  NORMAL_TIER_SCORES,
  getRankChange,
  type BoardMode, type GameMode, type NormalTier,
} from '@/lib/constants';
import { getPlayerBoardScore, getPlayerTotalScore } from '@/lib/scoring';
import {
  getAvatarInitial,
  getAvatarColor,
  getPlayerTitle,
  getPlayerRegion,
  tierPillStyle, // lgx-tmx 段位矩阵仍用（主 chip 色板由 TierBadge 内部取）
  CARD_MODE_SLOTS,
} from '@/lib/ui-utils';
import { McIcon } from '@/components/mc-icon';
import { TierBadge } from '@/components/tier-badge';
import { useSpotlight } from '@/components/fx/fx-spotlight-card';


// ============================================================
// PlayerCard — React.memo'd dense leaderboard row.
// 2026-10 重构：移除底部 9 模式段位胶囊墙，主行更紧凑。
// 完整 Mode Tier Matrix 在详情弹窗查看。卡片只显示当前模式段位。
// ============================================================
export const PlayerCard = React.memo(function PlayerCard({ player, rank, mode, onSelect, onLike, ineligible }: {
  player: PlayerData; rank: number; mode: BoardMode;
  onSelect: (id: string) => void; onLike: (id: string) => void;
  ineligible?: boolean;  // W2-T4: 未参评区玩家，降级显示（opacity .45 + 待认证标签，不可点进详情）
}) {
  const { currentUserId } = useAppStore();
  // FX-07 Spotlight 光斑跟随：pointermove 写 --sx/--sy（零 state/零 rAF），
  // 视觉层见 globals.css .lgx-row::after（触屏 hover gate 不显示）
  const spotlight = useSpotlight<HTMLDivElement>();
  const score = getPlayerBoardScore(player, mode);
  const isCurrentUser = player.id === currentUserId;
  const isEmotion = mode === 'EMOTION';

  // Rank change value (RankSnapshot-driven; honest 0 until tracked)
  const rankChange = getRankChange(player.id);

  // Derived identity flavor
  const title = useMemo(() => getPlayerTitle(player, rank), [player, rank]);
  const region = useMemo(() => getPlayerRegion(player.id), [player.id]);

  // Tier chip — mode board shows that mode's tier; TOTAL shows best tier.
  // (Full 9-mode tier matrix lives in the detail modal — LGX refactor.)
  const tierChip = useMemo(() => {
    let t: string | null = null;
    if (mode !== 'TOTAL' && mode !== 'EMOTION') {
      t = (player.tiers?.[mode] as string | undefined) ?? null;
    } else if (mode === 'TOTAL') {
      let bestScore = -1;
      CARD_MODE_SLOTS.forEach(m => {
        const tt = player.tiers?.[m] as string | undefined;
        if (tt && (NORMAL_TIER_SCORES[tt as NormalTier] ?? -1) > bestScore) {
          bestScore = NORMAL_TIER_SCORES[tt as NormalTier] ?? -1; t = tt;
        }
      });
    }
    return t; // 色板由 TierBadge 内部走 tierPillStyle（零漂移）
  }, [mode, player.tiers]);

  return (
    <motion.div
      id={`player-${player.id}`}
      role={ineligible ? 'listitem' : 'button'}
      tabIndex={ineligible ? -1 : 0}
      aria-label={`${player.name}，排名 ${rank}，${isEmotion ? '感动值' : 'Rating'} ${score}${ineligible ? '，待认证' : ''}`}
      onClick={() => { if (!ineligible) onSelect(player.id); }}
      onKeyDown={(e) => {
        if (ineligible) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(player.id);
        }
      }}
      whileTap={ineligible ? undefined : { scale: 0.99 }}
      className={cn('lgx-row', isCurrentUser && 'lgx-row-me', ineligible && 'lgx-row-ineligible')}
      aria-current={isCurrentUser ? 'true' : undefined}
      {...spotlight}
    >
      <div className="lgx-row-main">
        {/* Rank numeral — tabular, gold/silver/bronze top-3 */}
        <span className={cn('lgx-rank', rank <= 3 && `lgx-rank-${rank}`)} aria-hidden="true">
          {String(rank).padStart(2, '0')}
        </span>

        {/* Skin thumbnail 34px */}
        <div
          className="lgx-skin"
          style={{ background: player.avatarUrl ? 'transparent' : getAvatarColor(player.name) }}
        >
          {player.avatarUrl ? (
            <img src={player.avatarUrl} alt={player.name} />
          ) : (
            <span className="lgx-skin-fallback">{getAvatarInitial(player.name)}</span>
          )}
        </div>

        {/* Identity block — name row + compact title·region meta */}
        <div className="lgx-id">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn('lgx-name', isCurrentUser && 'text-jade-300')}>{player.name}</span>
            {isCurrentUser && <span className="pvp-you-tag flex-shrink-0">YOU</span>}
          </div>
          <div className="lgx-sub">
            <McIcon src={title.icon} className="w-3 h-3" />
            <b>{title.label}</b>
            <span aria-hidden="true">·</span>
            <span style={{ color: region.color }}>{region.name}</span>
          </div>
        </div>

        {/* Tier chip — ineligible 玩家显示「待认证」徽章替代段位 */}
        {ineligible ? (
          <span className="lgx-tier lgx-tier-pending">待认证</span>
        ) : tierChip && (
          <TierBadge tier={tierChip} tagStyle={player.tagStyle} />
        )}

        {/* Rating core — W3-T4: title 属性提供 RATING 说明 tooltip（键盘 Tab 聚焦也触发）*/}
        <div
          className="lgx-rating"
          title={isEmotion ? `感动值 ${score}（基于点赞数）` : `Rating ${score} = 段位分（HT1=50...LT5=1 之和）。战绩评分明细见详情弹窗`}
        >
          <span className="lgx-rating-num">{score.toLocaleString()}</span>
          <span className="lgx-rating-label">{isEmotion ? 'Hearts' : 'Rating'}</span>
        </div>

        {/* Rank change micro (↗/↘/—, honest 0 = not tracked) */}
        <span
          className={cn('lgx-chg', rankChange > 0 ? 'lgx-chg-up' : rankChange < 0 ? 'lgx-chg-down' : 'lgx-chg-flat')}
          title={rankChange === 0 ? '排名变化追踪即将上线' : undefined}
        >
          {rankChange > 0 ? <><TrendingUp className="w-2.5 h-2.5" />{rankChange}</> :
           rankChange < 0 ? <><TrendingDown className="w-2.5 h-2.5" />{Math.abs(rankChange)}</> :
           <Minus className="w-2.5 h-2.5" />}
        </span>

        {/* Like — inline micro button */}
        <motion.button
          onClick={(e) => { e.stopPropagation(); onLike(player.id); }}
          whileTap={{ scale: 1.12 }}
          aria-label={`点赞 ${player.likes}`}
          className="lgx-like"
        >
          <Heart className="w-3 h-3" />
          <span className="number-score">{player.likes || 0}</span>
        </motion.button>
      </div>

      {/* 2026-10 v2 · Compact Mode Tier Matrix — 信息不删，视觉降噪。
          用户核心需求：在主排行榜就能看到每个模式的段位。
          设计：内联文本（icon+模式名+tier），无边框胶囊，视觉权重
          显著低于名字/Rating。未定级模式显示 —（诚实）。 */}
      {mode !== 'EMOTION' && !ineligible && (
        <div className="lgx-tmx" aria-label="各模式段位">
          {ALL_MODES.map(m => {
            const t = (player.tiers?.[m] as string | undefined) ?? null;
            const style = t ? tierPillStyle(t) : null;
            return (
              <span
                key={m}
                className={cn('lgx-tmx-item', !t && 'lgx-tmx-empty')}
                title={`${MODE_LABELS[m]} · ${t || '未定级'}`}
              >
                <McIcon src={MODE_ICONS[m]} className="w-3 h-3" />
                <span className="lgx-tmx-name">{MODE_LABELS[m]}</span>
                <span className="lgx-tmx-tier" style={style ? { color: style.color } : undefined}>{t || '—'}</span>
              </span>
            );
          })}
        </div>
      )}
    </motion.div>
  );
});
