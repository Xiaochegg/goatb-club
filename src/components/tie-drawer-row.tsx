'use client';

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type PlayerData } from '@/lib/store';
import { type BoardMode } from '@/lib/constants';
import { getPlayerBoardScore } from '@/lib/scoring';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';
import { PlayerCard } from '@/components/player-card';

// ============================================================
// TieDrawerRow — 抽屉式并列排名行（2026-10 用户需求）
// ============================================================
// 触发条件：同一积分/排名的玩家数 ≥ 3 时，折叠为单行抽屉。
// 抽屉头：#排名 · 并列 N 人 · 预览(首位头像+名字+"等") · 共同分数 · 展开箭头
// 展开：所有并列玩家作为独立 PlayerCard 渲染（同 rank），可逐个点进详情。
// 收起：仅显示抽屉头，节省纵向空间。
//
// 设计动机（用户原话）："防止以后扩大群体有督促"——
// 当某段位（如 LT5=1 分）堆积大量玩家时，逐行展示冗长且重复，
// 抽屉式让榜单保持紧凑，需要时点开看全部并列玩家。
// ============================================================

interface TieDrawerRowProps {
  rank: number;
  players: PlayerData[];
  mode: BoardMode;
  onSelect: (id: string) => void;
  onLike: (id: string) => void;
  rankOf: (id: string) => number;
}

export function TieDrawerRow({ rank, players, mode, onSelect, onLike, rankOf }: TieDrawerRowProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);

  // 所有人同分（密集排名下同 rank 必同分）；用首位取代表分
  const score = getPlayerBoardScore(players[0], mode);
  const isEmotion = mode === 'EMOTION';
  const previewName = players[0].name;
  const extraCount = players.length - 1;

  return (
    <div className="lgx-tie-drawer">
      {/* ── 抽屉头：单行，点击展开/收起 ── */}
      <motion.button
        layout
        onClick={toggle}
        data-tie-rank={rank}
        whileTap={{ scale: 0.99 }}
        className={cn('lgx-row lgx-tie-drawer-header', open && 'lgx-tie-drawer-header-open')}
        aria-expanded={open}
        aria-label={`并列第${rank}名，共${players.length}人，${isEmotion ? '感动值' : 'Rating'} ${score}，${open ? '收起' : '展开'}`}
      >
        <div className="lgx-row-main">
          {/* Rank numeral — 与 PlayerCard 一致，金/银/铜色 */}
          <span className={cn('lgx-rank', rank <= 3 && `lgx-rank-${rank}`)} aria-hidden="true">
            {String(rank).padStart(2, '0')}
          </span>

          {/* 抽屉标识：并列群组图标 + 文案 */}
          <div className="lgx-tie-id">
            <Users className="w-3.5 h-3.5 text-jade-300/80" aria-hidden="true" />
            <span className="lgx-tie-count">并列 {players.length} 人</span>
          </div>

          {/* 预览：首位头像 + 名字 + "+N" */}
          <div className="lgx-tie-preview min-w-0">
            <div
              className="lgx-skin lgx-skin-sm"
              style={{ background: players[0].avatarUrl ? 'transparent' : getAvatarColor(previewName) }}
            >
              {players[0].avatarUrl ? (
                <img src={players[0].avatarUrl} alt={previewName} />
              ) : (
                <span className="lgx-skin-fallback">{getAvatarInitial(previewName)}</span>
              )}
            </div>
            <span className="lgx-tie-preview-name truncate">{previewName}</span>
            {extraCount > 0 && <span className="lgx-tie-preview-more">+{extraCount}</span>}
          </div>

          {/* 共同分数 */}
          <div
            className="lgx-rating"
            title={isEmotion ? `感动值 ${score}` : `Rating ${score} · ${players.length} 人并列`}
          >
            <span className="lgx-rating-num">{score.toLocaleString()}</span>
            <span className="lgx-rating-label">{isEmotion ? 'Hearts' : 'Rating'}</span>
          </div>

          {/* 展开箭头 */}
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 31 }}
            className="lgx-tie-chevron"
            aria-hidden="true"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </motion.span>
        </div>
      </motion.button>

      {/* ── 展开区：所有并列玩家逐行渲染（同 rank）── */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.9, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="lgx-tie-drawer-body space-y-1 mt-1 pl-2 border-l border-jade-500/20">
              {players.map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  rank={rankOf(player.id)}
                  mode={mode}
                  onSelect={onSelect}
                  onLike={onLike}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
