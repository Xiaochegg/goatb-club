'use client';

import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';
import { useAppStore } from '@/lib/store';

// ============================================================
// MotionProvider — 全局 framer-motion 配置
// reducedMotion="user"：当用户系统开启「减少动态效果」时，
// framer-motion 的所有 spring/layout/whileTap/whileHover 动画
// 自动降级（transform 变瞬时、opacity 保留），尊重无障碍偏好。
//
// SA-09 无障碍（increment-patch）：pausedMotion=true 时传
// transition={{ duration: 0 }}——用户点「暂停动效」控件后，
// 所有 framer-motion 动画（layout 重排/whileTap/AnimatePresence）
// 瞬时落终态，满足 WCAG 2.2「自动播放>5s 可暂停」。
// GSAP/Lenis/Three 的暂停由 SiteEffects/SiteBackground 监听
// pausedMotion 分别处理（本 provider 只管 framer-motion 侧）。
//
// 落点：layout.tsx（Server Component）无法直接放 MotionConfig
// （client 组件），故包一层 client wrapper。
// ============================================================
export function MotionProvider({ children }: { children: ReactNode }) {
  const pausedMotion = useAppStore((s) => s.pausedMotion);
  return (
    <MotionConfig
      reducedMotion="user"
      transition={pausedMotion ? { duration: 0 } : undefined}
    >
      {children}
    </MotionConfig>
  );
}
