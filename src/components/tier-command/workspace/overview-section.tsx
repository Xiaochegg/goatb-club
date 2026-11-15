'use client';

// ============================================================
// Tier Workspace V2 · SECTION 01 工单总览
// ------------------------------------------------------------
// 工单 §三.S1：页面打开第一眼看到整体工作情况；统计数字必须来自真实数据
// （ledger API 实时计算），绝不写死；每个数字可点击 → 自动筛选对应状态。
// 数字更新使用微弹簧（100-180ms），只对数字本身做淡入位移，不整页刷新。
// ============================================================

import { motion } from 'framer-motion';
import { Inbox, ClipboardList, Archive, UserCheck, CheckCircle2, ArchiveRestore, ShieldQuestion, MessageSquareWarning } from 'lucide-react';
import { SPRING_MICRO, NO_MOTION, WS } from './constants';
import type { LedgerStats } from './use-workspace-data';

export type WorkspaceFilter =
  | 'ALL' | 'PENDING_REVIEW' | 'READY' | 'PLAYER_PENDING'
  | 'CONFIRMED' | 'ARCHIVED' | 'NEEDS_IDENTITY' | 'DISPUTED';

interface CardDef {
  key: WorkspaceFilter;
  label: string;
  hint: string;
  value: number;
  icon: React.ReactNode;
  tone: string;
}

export function OverviewSection({
  stats,
  reduced,
  activeFilter,
  onSelectFilter,
}: {
  stats: LedgerStats;
  reduced: boolean;
  activeFilter: WorkspaceFilter;
  onSelectFilter: (f: WorkspaceFilter) => void;
}) {
  const cards: CardDef[] = [
    { key: 'ALL', label: '全部有效工单', hint: '去重后的有效工单总数', value: stats.recognized - stats.merged >= 0 ? stats.recognized - stats.merged : 0, icon: <Inbox className="h-4 w-4" />, tone: 'text-[#d5e0d8]' },
    { key: 'PENDING_REVIEW', label: '待处理 · 待核对', hint: '解析失败/身份歧义/疑似垃圾，等待人工核对', value: stats.pendingReview, icon: <ClipboardList className="h-4 w-4" />, tone: 'text-amber-300' },
    { key: 'READY', label: '待归档', hint: '识别完成，等待管理员审批写入', value: stats.ready, icon: <Archive className="h-4 w-4" />, tone: 'text-[#d0a6f7]' },
    { key: 'PLAYER_PENDING', label: '待玩家确认', hint: '已归档，等待玩家本人确认', value: stats.playerPending, icon: <UserCheck className="h-4 w-4" />, tone: 'text-sky-300' },
    { key: 'CONFIRMED', label: '已确认', hint: '玩家已确认，计入正式成长记录', value: stats.confirmed, icon: <CheckCircle2 className="h-4 w-4" />, tone: 'text-emerald-300' },
    { key: 'ARCHIVED', label: '已归档', hint: '已写入玩家档案', value: stats.archived, icon: <ArchiveRestore className="h-4 w-4" />, tone: 'text-emerald-300/80' },
    { key: 'NEEDS_IDENTITY', label: '需要核对', hint: '名称与 Tier 疑似混淆 / 同名歧义 / 身份存疑', value: stats.identityReviewCount, icon: <ShieldQuestion className="h-4 w-4" />, tone: 'text-amber-300' },
    { key: 'DISPUTED', label: '存在异议', hint: '玩家提出异议，等待管理员处理', value: stats.disputed, icon: <MessageSquareWarning className="h-4 w-4" />, tone: 'text-orange-300' },
  ];

  return (
    <div className="flex flex-col gap-2" data-testid="ws-overview">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map(c => {
          const active = activeFilter === c.key;
          return (
            <motion.button
              key={c.key}
              type="button"
              whileTap={reduced ? undefined : { scale: 0.97 }}
              transition={reduced ? NO_MOTION : SPRING_MICRO}
              onClick={() => onSelectFilter(c.key)}
              aria-pressed={active}
              title={`${c.hint}（点击筛选）`}
              className={`group flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${
                active
                  ? 'border-[rgba(191,90,242,0.5)] bg-[rgba(191,90,242,0.10)]'
                  : 'border-white/[0.07] bg-[rgba(18,26,21,0.72)] hover:border-[rgba(191,90,242,0.35)] hover:bg-[rgba(24,34,27,0.78)]'
              }`}
              data-testid={`ws-stat-${c.key}`}
            >
              <span className="flex w-full items-center gap-1.5 text-[10px] font-medium text-[#93a89a]">
                <span className={c.tone}>{c.icon}</span>
                <span className="truncate">{c.label}</span>
              </span>
              <motion.span
                key={c.value}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={reduced ? NO_MOTION : SPRING_MICRO}
                className={`text-2xl font-bold leading-none ${c.tone}`}
              >
                {c.value}
              </motion.span>
            </motion.button>
          );
        })}
      </div>
      <p className={`text-[10px] leading-relaxed ${WS.faintText}`}>
        统计口径：全部有效工单 = 台账去重保留行（完全重复来源已合并，不重复计数）；待处理记录与存在异议记录不计入正式累计战绩；
        已确认且未重复的记录才计入累计 K/D。所有数字来自台账实时数据，无任何写死。
      </p>
    </div>
  );
}
