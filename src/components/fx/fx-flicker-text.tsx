'use client';

import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';

import './fx-animations.css';

/**
 * FxFlickerText — 霓虹明灭文字（纯 CSS，零 JS 动画）
 * 来源: Animista text-flicker-in-glow (https://animista.net/play/text/flicker)
 * 许可证: FreeBSD License (© 2017 Ana Travas) — 详见 fx-library/LICENSES.md
 * 适配:
 * - 原「一次性点亮入场」改造为循环明灭（@keyframes fx-flicker，见 fx-animations.css）
 * - 金紫配色：文字 #FFD700 + 金/紫双层 text-shadow，呼应站点 logo-go-glow
 * - prefers-reduced-motion: reduce 下 animation: none（CSS 兜底，文字终态可见）
 * - 站点 pausedMotion=true 时 animationPlayState: 'paused'（明灭冻结在当前帧）
 */

export interface FxFlickerTextProps {
  text: string;
  className?: string;
  /** 一轮明灭循环时长（秒），默认 4 */
  duration?: number;
}

export function FxFlickerText({ text, className, duration = 4 }: FxFlickerTextProps) {
  const paused = useAppStore((s) => s.pausedMotion);

  return (
    <span
      className={cn('fx-flicker-glow', className)}
      style={
        {
          '--fx-flicker-duration': `${duration}s`,
          animationPlayState: paused ? 'paused' : undefined,
        } as CSSProperties
      }
    >
      {text}
    </span>
  );
}
