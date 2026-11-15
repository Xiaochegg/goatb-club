'use client';

/**
 * FxMarquee — 无缝跑马灯（横向/纵向，纯 CSS 动画）
 * 来源: Magic UI (https://magicui.design/docs/components/marquee)
 * 许可证: MIT (magicuidesign/magicui) — 详见 fx-library/LICENSES.md
 * 适配:
 *  - @keyframes 移入同目录 fx-animations.css（由主代理在 globals.css 统一 @import），组件文件不写 keyframes
 *  - animate-marquee 类改为内联 style animation（项目未注册 --animate-marquee token）
 *  - 接入站点 pausedMotion：暂停时 animationPlayState: paused；恢复自动续播
 *  - pauseOnHover 由 group-hover 类改为 JS hover 状态：内联 animation 简写会把
 *    animation-play-state 定死在 inline 层级，类级 group-hover 无法覆盖，故用事件驱动
 */

import { useState, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';

interface FxMarqueeProps extends ComponentPropsWithoutRef<'div'> {
  /**
   * Optional CSS class name to apply custom styles
   */
  className?: string;
  /**
   * Whether to reverse the animation direction
   * @default false
   */
  reverse?: boolean;
  /**
   * Whether to pause the animation on hover
   * @default false
   */
  pauseOnHover?: boolean;
  /**
   * Content to be displayed in the marquee
   */
  children: React.ReactNode;
  /**
   * Whether to animate vertically instead of horizontally
   * @default false
   */
  vertical?: boolean;
  /**
   * Number of times to repeat the content
   * @default 4
   */
  repeat?: number;
}

export function FxMarquee({
  className,
  reverse = false,
  pauseOnHover = false,
  children,
  vertical = false,
  repeat = 4,
  ...props
}: FxMarqueeProps) {
  // 站点级「暂停所有动效」开关（SA-09）：paused 时整条跑马灯定格
  const paused = useAppStore(s => s.pausedMotion);
  const [hovered, setHovered] = useState(false);
  const shouldPause = paused || (pauseOnHover && hovered);

  return (
    <div
      {...(pauseOnHover ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } : null)}
      {...props}
      className={cn(
        'group flex gap-(--gap) overflow-hidden p-2 [--duration:40s] [--gap:1rem]',
        vertical ? 'flex-col' : 'flex-row',
        className
      )}
    >
      {Array(repeat)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className={cn('flex shrink-0 justify-around gap-(--gap)', vertical ? 'flex-col' : 'flex-row')}
            style={{
              // keyframes 定义在 fx-animations.css；时长用外层 --duration 变量（默认 40s）
              animation: `${vertical ? 'fx-marquee-vertical' : 'fx-marquee'} var(--duration, 40s) linear infinite`,
              animationDirection: reverse ? 'reverse' : undefined,
              // paused（站点级）或 hover（pauseOnHover）时定格；undefined 时 React 不写该属性
              animationPlayState: shouldPause ? 'paused' : undefined
            }}
          >
            {children}
          </div>
        ))}
    </div>
  );
}

export default FxMarquee;
