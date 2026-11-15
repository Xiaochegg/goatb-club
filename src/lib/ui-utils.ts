// ============================================================
// UI helpers — 纯展示函数，零业务依赖
// wave-7 后收敛 wave-1~7 累积的 helper 副本（tierPillStyle 已
// 漂移过一次被抓住，AVATAR_COLORS 两套并存）。所有组件统一从
// 此 import，杜绝副本漂移。
// ============================================================

import {
  AVATAR_COLORS,
  NORMAL_TIER_SCORES,
  calcLevel,
  type NormalMode,
  type NormalTier,
} from '@/lib/constants';
import { getPlayerTotalScore } from '@/lib/scoring';
import type { PlayerData } from '@/lib/store';

// ── Avatar ──────────────────────────────────────────────────
export function getAvatarInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Card mode subset（PlayerCard/PodiumStrip 段位评选用 6 模式）──
// 注意：是 NORMAL_MODES 的子集（不含 DIAMOND_POTION/BUHC），有意如此。
export const CARD_MODE_SLOTS: NormalMode[] = [
  'SHIELD', 'CRYSTAL', 'SWORD', 'ALLOY_POTION', 'MACE', 'SMP',
];

// ── Player title badge（rank=1 冠军 / HT1 Elite / HT2 Pro / ...）──
// Task 43：title icon 改为 MC 像素风 SVG data URI
import { MC_ICONS } from './mc-icons';
export function getPlayerTitle(player: PlayerData, rank: number): { label: string; icon: string } {
  if (rank === 1) return { label: 'Champion', icon: MC_ICONS.CHAMPION };
  let best: NormalTier | null = null;
  let bestScore = -1;
  CARD_MODE_SLOTS.forEach(m => {
    const t = player.tiers?.[m] as NormalTier | undefined;
    if (t && NORMAL_TIER_SCORES[t] > bestScore) { bestScore = NORMAL_TIER_SCORES[t]; best = t; }
  });
  if (best === 'HT1') return { label: 'Elite', icon: MC_ICONS.ELITE };
  if (best === 'HT2') return { label: 'Pro', icon: MC_ICONS.PRO };
  if (best === 'HT3' || best === 'LT1') return { label: 'Veteran', icon: MC_ICONS.VETERAN };
  const level = calcLevel(getPlayerTotalScore(player));
  if (level >= 5) return { label: 'Veteran', icon: MC_ICONS.VETERAN };
  return { label: 'Rookie', icon: MC_ICONS.ROOKIE };
}

// ── Big number display（数字外露防线 · 2026-10 修复）─────────
// 面板窄卡片里的大数字（总分/场次/K-D 等）按「渲染字符数」逐级缩小
// 字号，保证管理员输入任意量级都不会把数字挤出卡片边界。
// 现状依据（375px 移动端实测）：双子卡内容宽 ~93px，"1,234,632"
// 在 24px 字号下需 ~109px → 外露裁切。降级后各级均留 ≥15% 余量。
// Tailwind 任意值类必须静态可提取 → 字号表写死，不用模板拼接。
// 配套约定：数值元素同时挂 whitespace-nowrap + min-w-0 + truncate
// （超长脏数据的最后防线）+ title 全量 tooltip。

export type NumSizeStep = { maxChars: number; cls: string };

// 双列大数字卡（基准 24px）：总分 / 排名
const TWIN_STAT_STEPS: NumSizeStep[] = [
  { maxChars: 5, cls: 'text-[24px]' },        // "9,999" ≈ 61px
  { maxChars: 7, cls: 'text-[20px]' },        // "123,456" ≈ 73px
  { maxChars: 9, cls: 'text-[16px]' },        // "1,234,632" ≈ 72px
  { maxChars: Infinity, cls: 'text-[12px]' }, // "12,345,678" ≈ 68px
];

// 微网格统计卡（基准 20px）：K/D / 胜率 / 总场次
const MICRO_STAT_STEPS: NumSizeStep[] = [
  { maxChars: 6, cls: 'text-[20px]' },        // "100.0%" ≈ 68px
  { maxChars: 8, cls: 'text-[16px]' },        // "346,000" ≈ 63px
  { maxChars: Infinity, cls: 'text-[12px]' }, // "3,456,789" ≈ 58px
];

/**
 * 按渲染字符数返回降级字号类。
 * @param value 已格式化的显示文本（含千分位逗号/小数点/%）
 * @param kind 'twin' = 24px 基准大卡，'micro' = 20px 基准小卡
 */
export function bigNumSizeClass(value: string, kind: 'twin' | 'micro' = 'twin'): string {
  const steps = kind === 'twin' ? TWIN_STAT_STEPS : MICRO_STAT_STEPS;
  const len = [...value].length;
  return (steps.find(s => len <= s.maxChars) ?? steps[steps.length - 1]).cls;
}

// ── Region pill（确定性 hash → 5 区域，色码）──
export const REGIONS: { name: string; color: string; bg: string; border: string }[] = [
  { name: '华东', color: '#60a5fa', bg: 'rgba(96,165,250,0.14)',  border: 'rgba(96,165,250,0.32)' },
  { name: '华南', color: '#34d399', bg: 'rgba(52,211,153,0.14)',  border: 'rgba(52,211,153,0.32)' },
  { name: '华北', color: '#fbbf24', bg: 'rgba(251,191,36,0.14)',  border: 'rgba(251,191,36,0.32)' },
  { name: '华西', color: '#BF5AF2', bg: 'rgba(191,90,242,0.14)',  border: 'rgba(191,90,242,0.32)' },
  { name: '华中', color: '#22d3ee', bg: 'rgba(34,211,238,0.14)',  border: 'rgba(34,211,238,0.32)' },
];

export function getPlayerRegion(playerId: string) {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) hash = playerId.charCodeAt(i) + ((hash << 5) - hash);
  return REGIONS[Math.abs(hash) % REGIONS.length];
}

// ── Tier pill style（HT 紫色系 / LT 灰色系 / LZ/LL 金色系）──
// 完整版色阶，与 page.tsx 原版 + player-card.tsx 副本一致。
// NOTE: text colors stay in light-lavender range for EVERY depth —
// deep purples were unreadable on dark-navy (self-review fix).
// Depth is communicated by bg intensity instead.
export type TierPillStyle = { bg: string; border: string; color: string } | null;

export function tierPillStyle(tier: string | null | undefined): TierPillStyle {
  if (!tier) return null;
  if (tier.startsWith('HT')) {
    const n = parseInt(tier.slice(2), 10);
    const intensity = [0.44, 0.36, 0.29, 0.22, 0.16][Math.min(n - 1, 4)];
    const text = ['#f3e8ff', '#ecd9ff', '#e2c6fc', '#d5b0fa', '#c9a0f5'][Math.min(n - 1, 4)];
    return { bg: `rgba(168,85,247,${intensity})`, border: `rgba(192,132,252,${intensity + 0.14})`, color: text };
  }
  if (tier.startsWith('LT')) {
    const n = parseInt(tier.slice(2), 10);
    const intensity = [0.34, 0.28, 0.23, 0.18, 0.14][Math.min(n - 1, 4)];
    const text = ['#eef2f7', '#dde4ec', '#c9d2dd', '#adb9c7', '#94a2b3'][Math.min(n - 1, 4)];
    return { bg: `rgba(100,116,139,${intensity})`, border: `rgba(148,163,184,${intensity + 0.12})`, color: text };
  }
  if (tier.startsWith('LZ')) return { bg: 'rgba(251,191,36,0.30)', border: 'rgba(251,191,36,0.42)', color: '#fde68a' };
  if (tier.startsWith('LL')) return { bg: 'rgba(180,150,40,0.22)', border: 'rgba(180,150,40,0.32)', color: '#e8c84a' };
  return null;
}
