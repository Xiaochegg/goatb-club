'use client';
// ============================================================
// FxSpotlightCard — 液态玻璃光斑跟随 hook（FX-07 · 类别③卡片光效）
//
// 来源：React Bits「Spotlight Card」（MIT+Commons Clause，已 L0 落盘
//       fx-library/effects/react-bits/spotlight-card）等效重写：
//       指针驱动 CSS 变量（--sx/--sy）+ globals.css .lgx-row::after
//       径向光斑。零 state、零 rAF——pointermove 直接写 style 变量
//       （合成器安全，FLIP 重排不受影响）。
//
// 降级：触屏/精指针不可用时由 CSS @media (hover:hover) gate 光斑显示，
//       JS 侧无副作用；prefers-reduced-motion 仅去掉渐隐过渡，
//       悬停反馈（用户主动触发）保留。
//
// 用法：
//   const spotlight = useSpotlight<HTMLDivElement>();
//   <motion.div {...spotlight}>…
// ============================================================
import { useCallback, useRef } from 'react';

export function useSpotlight<T extends HTMLElement>() {
  // 悬停会话内缓存一次 rect（避免 pointermove 每次读布局造成强制回流）
  const rectRef = useRef<DOMRect | null>(null);

  const onPointerEnter = useCallback((e: React.PointerEvent<T>) => {
    rectRef.current = e.currentTarget.getBoundingClientRect();
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    const el = e.currentTarget;
    let rect = rectRef.current;
    if (!rect) {
      rect = el.getBoundingClientRect();
      rectRef.current = rect;
    }
    el.style.setProperty('--sx', `${Math.round(e.clientX - rect.left)}px`);
    el.style.setProperty('--sy', `${Math.round(e.clientY - rect.top)}px`);
  }, []);

  const onPointerLeave = useCallback(() => {
    rectRef.current = null;
  }, []);

  return { onPointerEnter, onPointerMove, onPointerLeave };
}

export default useSpotlight;
