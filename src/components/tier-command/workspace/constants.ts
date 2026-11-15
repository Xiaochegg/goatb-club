'use client';

// ============================================================
// Tier Workspace V2 · 设计 tokens（色板 + 徽章 + Spring 参数）
// ------------------------------------------------------------
// 视觉方向（工单 §四）：深色游戏管理中枢 + 精致 Tier 竞技后台。
//   页面背景 = 深绿黑；主卡片 = 深绿灰；主强调 = 紫（复用 --jade 体系 #BF5AF2）；
//   待处理 = 暖黄；成功 = 柔和绿；异议 = 暖红橙；次要文字 = 灰绿。
// 禁止：indigo/blue 固定 hover、组件全亮、过度渐变、大面积发光。
// 动画（工单 §五）：transform/opacity 优先；spring 可打断；
//   prefers-reduced-motion 时全部退化为零时长（调用方用 useReducedMotion 判定）。
// ============================================================

import type { Transition } from 'framer-motion';

// ---------- Spring 参数（工单建议区间；可被打断，不拖慢连续操作） ----------

/** Tab 指示滑动 / 选中背景移动（220-320ms） */
export const SPRING_TAB: Transition = { type: 'spring', stiffness: 380, damping: 32, mass: 0.9 };
/** 卡片展开 / 内容渐入（220-320ms） */
export const SPRING_EXPAND: Transition = { type: 'spring', stiffness: 300, damping: 30, mass: 0.9 };
/** 抽屉/弹窗（250-350ms，柔和弹簧） */
export const SPRING_DRAWER: Transition = { type: 'spring', stiffness: 260, damping: 28, mass: 0.95 };
/** 数字更新 / 轻反馈（100-180ms） */
export const SPRING_MICRO: Transition = { type: 'spring', stiffness: 480, damping: 34, mass: 0.6 };

/** 退化用（reduced-motion）：零时长，无位移 */
export const NO_MOTION: Transition = { duration: 0 };

// ---------- 色板（统一设计变量，避免散落魔法色） ----------

export const WS = {
  /** 深绿黑页面容器 */
  shell: 'bg-[linear-gradient(180deg,#0b120e_0%,#0e1611_55%,#0b120e_100%)]',
  /** 深绿灰主卡片 */
  card: 'rounded-xl border border-white/[0.07] bg-[rgba(18,26,21,0.72)] backdrop-blur-sm',
  cardHover: 'hover:border-[rgba(191,90,242,0.35)] hover:bg-[rgba(24,34,27,0.78)]',
  /** 主强调（紫） */
  accentText: 'text-[#c98af5]',
  accentBg: 'bg-[rgba(191,90,242,0.12)]',
  accentBorder: 'border-[rgba(191,90,242,0.35)]',
  /** 次要文字（灰绿） */
  subText: 'text-[#93a89a]',
  faintText: 'text-[#6d7f72]',
} as const;

// ---------- 状态徽章（工单 §一/§三 语义色） ----------

export interface BadgeSpec { label: string; cls: string }

/** 工单处理态（processState） */
export const PROCESS_BADGE: Record<string, BadgeSpec> = {
  SYNCED: { label: '已读取', cls: 'bg-white/[0.06] text-[#93a89a] border-white/10' },
  MERGED: { label: '已合并', cls: 'bg-[rgba(191,90,242,0.10)] text-[#c98af5] border-[rgba(191,90,242,0.30)]' },
  PENDING_REVIEW: { label: '待核对', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  READY: { label: '待归档', cls: 'bg-[rgba(191,90,242,0.10)] text-[#d0a6f7] border-[rgba(191,90,242,0.35)]' },
  ARCHIVED: { label: '已归档', cls: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25' },
  ARCHIVE_FAILED: { label: '同步失败', cls: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
};

/** 玩家确认态（confirmState） */
export const CONFIRM_BADGE: Record<string, BadgeSpec> = {
  NONE: { label: '未提交确认', cls: 'bg-white/[0.05] text-[#6d7f72] border-white/10' },
  PLAYER_PENDING: { label: '待玩家确认', cls: 'bg-sky-400/10 text-sky-300 border-sky-400/25' },
  CONFIRMED: { label: '已确认', cls: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25' },
  DISPUTED: { label: '有异议', cls: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
};

/** 身份匹配态（matchState，后端判定） */
export const MATCH_BADGE: Record<string, BadgeSpec> = {
  MATCHED: { label: '身份已匹配', cls: 'bg-emerald-400/[0.08] text-emerald-300/90 border-emerald-400/20' },
  NOT_FOUND: { label: '待建条目', cls: 'bg-white/[0.05] text-[#93a89a] border-white/10' },
  NAME_AMBIGUOUS: { label: '同名歧义', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  UNCERTAIN: { label: '身份存疑', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
};

/** 整理表通道行状态（SyncRow.status） */
export const SYNC_STATUS_BADGE: Record<string, BadgeSpec> = {
  READY: { label: '校验通过', cls: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25' },
  PLAYER_MISSING: { label: '待建条目', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  INVALID: { label: '校验失败', cls: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
};

/** 审计日志四类 */
export const LOG_KIND_BADGE: Record<string, BadgeSpec> = {
  approve: { label: '写入', cls: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25' },
  rollback: { label: '回档', cls: 'bg-amber-400/10 text-amber-300 border-amber-400/30' },
  reject: { label: '拒绝', cls: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
  restore: { label: '撤销拒绝', cls: 'bg-white/[0.05] text-[#93a89a] border-white/10' },
};

/** Tier 徽章着色（紫系渐进，避免蓝） */
export function tierBadgeCls(tier: string): string {
  const t = tier.toUpperCase();
  if (/^(HT|LZ)1$/.test(t)) return 'bg-amber-300/15 text-amber-200 border-amber-300/40';
  if (/[123]$/.test(t)) return 'bg-[rgba(191,90,242,0.12)] text-[#d0a6f7] border-[rgba(191,90,242,0.35)]';
  return 'bg-white/[0.06] text-[#c9d4cc] border-white/15';
}

// ---------- 工具 ----------

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '未提供';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateCn(iso: string | null | undefined): string {
  if (!iso) return '未提供';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** K/D 显示：数值或「未提供」（绝不补 0） */
export function fmtKD(v: number | null): string {
  return v === null ? '未提供' : String(v);
}
