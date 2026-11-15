'use client';

// ============================================================
// SiteEffects — 前景动效层（高级动效分阶段接入点）
//
// 与 SiteBackground 平行：
//   - SiteBackground 管 z:-8 背景层（particles/three/static + 6.1/6.2 触发器）
//   - SiteEffects   管 z:0+ 前景层（视差/光标等内容/行为动效）
//
// 阶段 2：GSAP + ScrollTrigger 视差，限定 intro zone
// 阶段 3：Custom Cursor（dot + ring + hover/text 状态）
//
// 滚动策略变更（2026-10 滚动性能审计）：
//   Lenis 平滑滚动已整体移除，回归浏览器原生滚动。原因：
//   duration 模式（1.15s 指数缓出）把滚轮输入与视口位移解耦，
//   产生「追轮滑行 + 卡后跳段」的不自然手感，且与嵌套滚动容器
//   （sticky 侧栏 / EMOTION 列表）的原生滚动双轨切换造成顿挫；
//   lagSmoothing(0) 还会放大主线程卡顿为位置跳变。
//   原生滚动零劫持、零 rAF 预算占用；GSAP ScrollTrigger 自带
//   原生 scroll 监听，视差不受影响。弹窗滚动锁由
//   react-remove-scroll（Radix）原生接管，无需 Lenis 代理。
//
// customBg 有值时（管理员自定义背景图）：本层不启动，与 SiteBackground 让位策略一致
// ============================================================

import { useEffect, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { ParallaxManager } from './effects/parallax-manager';
import { CursorManager } from './effects/cursor-manager';

export function SiteEffects() {
  const customBg = useAppStore(s => s.customBg);
  const pausedMotion = useAppStore(s => s.pausedMotion);
  const parallaxRef = useRef<ParallaxManager | null>(null);
  const cursorRef = useRef<CursorManager | null>(null);

  useEffect(() => {
    // customBg 有值时让位（与 SiteBackground 一致）
    if (customBg) return;

    const parallax = new ParallaxManager();
    parallaxRef.current = parallax;
    parallax.start().catch(err => {
      console.warn('[effects] 视差启动失败，降级为无动效', err);
    });

    // 阶段 3：Custom Cursor（canRun 守卫：reduced-motion / lowEnd / coarse-pointer 跳过）
    const cursor = new CursorManager();
    cursorRef.current = cursor;
    cursor.start();

    // 调试入口
    if (process.env.NODE_ENV !== 'production') {
      const w = window as unknown as {
        __parallax?: ParallaxManager;
        __cursor?: CursorManager;
      };
      w.__parallax = parallax;
      w.__cursor = cursor;
    }

    return () => {
      cursor.destroy();
      cursorRef.current = null;
      parallax.destroy();
      parallaxRef.current = null;
      if (process.env.NODE_ENV !== 'production') {
        const w = window as unknown as {
          __parallax?: ParallaxManager;
          __cursor?: CursorManager;
        };
        delete w.__parallax;
        delete w.__cursor;
      }
    };
  }, [customBg]);

  // SA-09 无障碍：pausedMotion 冻结全部 CSS keyframes 动画
  // （logo-go-shimmer、赛季徽标 pulse、jade-shimmer、nav-live-pulse、mp-pulse）。
  // 「暂停所有动效」对前庭障碍用户是可访问性承诺 —— <html> 挂 .motion-paused，
  // 由 globals.css 统一冻结（不含 transition：过渡是用户触发的一次性反馈）。
  // 视差/光标是交互触发（非自动播放），不属 WCAG 2.2「自动播放>5s 可暂停」范畴；
  // Three.js 背景由 SiteBackground 监听 pausedMotion 调 bg controller pause/resume。
  // 注意：此 effect 必须在 `if (customBg) return null` 之前，保 hook 顺序稳定
  useEffect(() => {
    document.documentElement.classList.toggle('motion-paused', pausedMotion);
    return () => document.documentElement.classList.remove('motion-paused');
  }, [pausedMotion]);

  // customBg 时本层不渲染（也无副作用）
  if (customBg) return null;

  // 本层无 DOM 输出，仅管理副作用（视差作用在 page 内既有元素上）
  return null;
}
