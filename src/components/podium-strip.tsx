// ============================================================
// LGX · Podium Strip — top-3 compact champion zone.
// 2026-10 v2（信息不删，视觉降噪）：恢复 Champion 称号行 + 紧凑
// Mode Tier Matrix（与 PlayerCard 同一 .lgx-tmx 结构，居中缩排）。
// 缩小显示、纯文本无胶囊边框 — 不是原来的标签墙。
// ============================================================
import React from 'react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { Heart, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { type PlayerData } from '@/lib/store';
import { McIcon } from '@/components/mc-icon';
import { FxStarBorder } from '@/components/fx/fx-star-border';
import {
  ALL_MODES, MODE_LABELS, MODE_ICONS,
  NORMAL_TIER_SCORES,
  getRankChange,
  type BoardMode,
  type NormalTier,
} from '@/lib/constants';
import { TierBadge } from '@/components/tier-badge';
import { getPlayerBoardScore } from '@/lib/scoring';
import {
  getAvatarInitial, getAvatarColor,
  getPlayerTitle,
  tierPillStyle,
  CARD_MODE_SLOTS,
} from '@/lib/ui-utils';

export function PodiumStrip({ players, mode, onSelect, onLike, ranks }: {
  players: PlayerData[]; mode: BoardMode;
  onSelect: (id: string) => void;
  onLike: (id: string) => void;
  ranks?: number[]; // 并列感知排名（2026-10）：同积分同名次
}) {
  const top3 = players.slice(0, 3);
  if (top3.length === 0) return null;
  const isEmotion = mode === 'EMOTION';
  return (
    <div className="lgx-podium" role="list" aria-label="前三名">
      {top3.map((p, i) => {
        const rank = ranks?.[i] ?? i + 1;
        const score = getPlayerBoardScore(p, mode);
        const rankChange = getRankChange(p.id);
        const title = getPlayerTitle(p, rank);
        // 个性段位徽章（个性化样式对外展示位）：当前模式段位优先
        // （EMOTION 榜无段位概念）；未定级/EMOTION 时回退 6 模式最佳段位，
        // 保证管理员设置的个性标签样式在领奖台上始终可见。
        const modeTier = !isEmotion ? ((p.tiers?.[mode] as string | undefined) ?? null) : null;
        let bestTier: string | null = null;
        let bestScore = -1;
        CARD_MODE_SLOTS.forEach(m => {
          const t = (p.tiers?.[m] as string | undefined) ?? null;
          const s = t ? (NORMAL_TIER_SCORES[t as NormalTier] ?? -1) : -1;
          if (s > bestScore) { bestScore = s; bestTier = t; }
        });
        const badgeTier = modeTier ?? bestTier;
        const cell = (
          <motion.div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(p.id);
              }
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.22, ease: [0.2, 0.9, 0.2, 1] }}
            className={cn('lgx-podium-cell', `lgx-podium-${rank}`)}
            aria-label={`${p.name}，排名 ${rank}，${isEmotion ? '感动值' : 'Rating'} ${score}`}
          >
            <div className="lgx-podium-head">
              <span className="lgx-podium-rank">#{rank}</span>
              <span
                className={cn('lgx-chg', rankChange > 0 ? 'lgx-chg-up' : rankChange < 0 ? 'lgx-chg-down' : 'lgx-chg-flat')}
                title={rankChange === 0 ? '排名变化追踪即将上线' : undefined}
              >
                {rankChange > 0 ? <><TrendingUp className="w-2.5 h-2.5" />{rankChange}</> :
                 rankChange < 0 ? <><TrendingDown className="w-2.5 h-2.5" />{Math.abs(rankChange)}</> :
                 <Minus className="w-2.5 h-2.5" />}
              </span>
            </div>
            <div
              className="lgx-podium-skin"
              style={{ background: p.avatarUrl ? 'transparent' : getAvatarColor(p.name) }}
            >
              {p.avatarUrl ? (
                <img src={p.avatarUrl} alt={p.name} />
              ) : (
                <span className="lgx-skin-fallback">{getAvatarInitial(p.name)}</span>
              )}
            </div>
            <span className="lgx-podium-name">{p.name}</span>
            {/* 段位徽章（带玩家个性标签样式）——与 PlayerCard 主 chip 同构 */}
            {badgeTier && (
              <TierBadge tier={badgeTier} size="sm" tagStyle={p.tagStyle} />
            )}
            <span className="lgx-podium-rating number-score">{score.toLocaleString()}</span>
            {/* 2026-10 v2: Rating + 称号同行紧凑显示 */}
            <span className="lgx-podium-sub">
              {isEmotion ? 'Hearts' : 'Rating'} · <McIcon src={title.icon} className="w-3 h-3 inline-block align-middle" /> {title.label}
            </span>
            {/* 爱心点赞按钮 — stopPropagation 防止触发打开详情 */}
            <motion.button
              onClick={(e) => { e.stopPropagation(); onLike(p.id); }}
              whileTap={{ scale: 1.15 }}
              aria-label={`点赞 ${p.name}，当前 ${p.likes || 0} 赞`}
              className="lgx-podium-like"
            >
              <Heart className="w-3 h-3" />
              <span className="number-score">{p.likes || 0}</span>
            </motion.button>
            {/* 2026-10 v2 · Compact Mode Tier Matrix — 与 PlayerCard 同结构，
                居中 + 更小字号。信息保留，视觉轻量。EMOTION 不显示。 */}
            {!isEmotion && (
              <div className="lgx-tmx lgx-tmx-podium" aria-label="各模式段位">
                {ALL_MODES.map(m => {
                  const t = (p.tiers?.[m] as string | undefined) ?? null;
                  const style = t ? tierPillStyle(t) : null;
                  return (
                    <span
                      key={m}
                      className={cn('lgx-tmx-item', !t && 'lgx-tmx-empty')}
                      title={`${MODE_LABELS[m]} · ${t || '未定级'}`}
                    >
                      <McIcon src={MODE_ICONS[m]} className="w-3 h-3" />
                      <span className="lgx-tmx-tier" style={style ? { color: style.color } : undefined}>{t || '—'}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </motion.div>
        );
        // FX：Top1 星迹描边（FxStarBorder · React Bits MIT+CC）——
        // hover="reveal"：静止时星迹淡出→canvas rAF 完全停帧（守住站点 rAF≤2 预算）；
        // hover 进入时星迹亮起巡游，点击仍有脉冲（clickPulse）。移动端触点同样短促脉冲后停帧。
        return rank === 1 ? (
          <FxStarBorder
            key={`sb-${p.id}`}
            as="div"
            backgroundColor="transparent"
            borderColor="rgba(255, 215, 0, 0.15)"
            radius={14}
            duration={5}
            glow={0.7}
            hover="reveal"
            className="w-full"
            style={{ display: 'block', padding: 0 }}
          >
            {cell}
          </FxStarBorder>
        ) : (
          cell
        );
      })}
    </div>
  );
}
