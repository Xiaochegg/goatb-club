'use client';

import { useEffect, useRef } from 'react';

// ============================================================
// UR2 · IO 门控 reveal / ambient 生命周期（trace 1a1d6ab1f1fdd8ed）
// 纯一次性 IntersectionObserver，最小成本设计（4GB 内存约束）：
//   1. [data-ur2-reveal] 子元素进入视口 → 写 data-ur2-in（一次性，
//      立即 unobserve；CSS 侧以 opacity/transform 过渡呈现）
//   2. 容器内带 data-ur2-ambient 的子元素（未指定则容器自身）：离开视口 →
//      data-ur2-idle，CSS 据此 pause 该元素内的氛围层动画（不可见即停止计算）
//   3. 无 JS / SSR / 不支持 IO：元素默认可见（arm 门由 effect 设置，
//      零 CLS / 零内容消失风险）
//   4. 卸载时 disconnect，无泄漏
// ============================================================
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    root.setAttribute('data-ur2-arm', '');

    let revealIo: IntersectionObserver | null = null;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-ur2-reveal]'));
    if (items.length > 0) {
      revealIo = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.setAttribute('data-ur2-in', '');
              revealIo?.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
      );
      items.forEach((el) => revealIo!.observe(el));
    }

    let idleIo: IntersectionObserver | null = null;
    const ambEl = root.querySelector<HTMLElement>('[data-ur2-ambient]') || root;
    if (ambEl.hasAttribute('data-ur2-ambient')) {
      idleIo = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) ambEl.removeAttribute('data-ur2-idle');
            else ambEl.setAttribute('data-ur2-idle', '');
          }
        },
        { threshold: 0 }
      );
      idleIo.observe(ambEl);
    }

    return () => {
      revealIo?.disconnect();
      idleIo?.disconnect();
    };
  }, []);

  return ref;
}
