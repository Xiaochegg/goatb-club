'use client';

import React, { type ComponentPropsWithoutRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';

import './fx-animations.css';

/**
 * FxShimmerButton — 流光按钮
 * 来源: Magic UI (https://magicui.design/r/shimmer-button)
 * 许可证: MIT — 详见 fx-library/LICENSES.md
 * 适配:
 * - 接入站点 pausedMotion（useAppStore）→ CSS 动画以 animationPlayState: 'paused' 暂停
 * - 金色默认值: --shimmer-color #FFD700（原 #ffffff）、背景 rgba(26,26,46,1) = #1a1a2e 深色系（原纯黑）
 * - keyframes 迁入 fx-animations.css（fx-shimmer-slide / fx-spin-around），
 *   Tailwind animate-* token 改为 .fx-* 工具类；@container-[size] 改内联 containerType: 'size'；
 *   Tailwind 任意值类（inset-(--cut)/[background:var(--bg)] 等）改内联 style，规避解析差异
 * - type 默认 'button'（可覆盖），避免在 form 内误触发提交；像素风可传 borderRadius="4px"
 */

export interface FxShimmerButtonProps extends ComponentPropsWithoutRef<'button'> {
  shimmerColor?: string;
  shimmerSize?: string;
  borderRadius?: string;
  shimmerDuration?: string;
  background?: string;
  className?: string;
  children?: React.ReactNode;
}

export const FxShimmerButton = React.forwardRef<HTMLButtonElement, FxShimmerButtonProps>(
  (
    {
      shimmerColor = '#FFD700',
      shimmerSize = '0.05em',
      shimmerDuration = '3s',
      borderRadius = '100px',
      background = 'rgba(26, 26, 46, 1)',
      className,
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const paused = useAppStore((s) => s.pausedMotion);
    const playState = paused ? ('paused' as const) : undefined;

    return (
      <button
        type={type}
        ref={ref}
        style={
          {
            '--spread': '90deg',
            '--shimmer-color': shimmerColor,
            '--radius': borderRadius,
            '--speed': shimmerDuration,
            '--cut': shimmerSize,
            '--bg': background,
            borderRadius: 'var(--radius)',
            background: 'var(--bg)',
          } as CSSProperties
        }
        className={cn(
          'group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden border border-white/10 px-6 py-3 whitespace-nowrap text-white',
          'transform-gpu transition-transform duration-300 ease-in-out active:translate-y-px',
          className
        )}
        {...props}
      >
        {/* spark 容器：container query 上下文（子元素 100cqh/100cqw 依赖 containerType: size） */}
        <div
          className="-z-30 absolute inset-0 overflow-visible blur-[2px]"
          style={{ containerType: 'size' }}
        >
          {/* spark 滑块：沿容器横向往返 */}
          <div
            className="fx-shimmer-slide absolute inset-0 rounded-none"
            style={{
              height: '100cqh',
              aspectRatio: '1 / 1',
              mask: 'none',
              animationPlayState: playState,
            }}
          >
            {/* conic 高光：围绕 spark 旋转，与 backdrop 的内缩边缘合成流光带 */}
            <div
              className="fx-spin-around absolute w-auto"
              style={{
                inset: '-100%',
                background:
                  'conic-gradient(from calc(270deg - (var(--spread) * 0.5)), transparent 0, var(--shimmer-color) var(--spread), transparent var(--spread))',
                animationPlayState: playState,
              }}
            />
          </div>
        </div>
        {children}

        {/* 高光：hover / active 内阴影按压反馈 */}
        <div
          className={cn(
            'absolute inset-0 size-full rounded-2xl px-4 py-1.5 text-sm font-medium shadow-[inset_0_-8px_10px_#ffffff1f]',
            'transform-gpu transition-all duration-300 ease-in-out',
            'group-hover:shadow-[inset_0_-6px_10px_#ffffff3f]',
            'group-active:shadow-[inset_0_-10px_10px_#ffffff3f]'
          )}
        />

        {/* backdrop：内缩的实底背景，露出的边即流光带 */}
        <div
          className="absolute -z-20"
          style={{ inset: 'var(--cut)', borderRadius: 'var(--radius)', background: 'var(--bg)' }}
        />
      </button>
    );
  }
);

FxShimmerButton.displayName = 'FxShimmerButton';
