'use client';

import { useSyncExternalStore } from 'react';

// ============================================================
// SSR-safe media query hook — returns false during SSR, updates on mount
// 拆分自 src/app/page.tsx (split-mode-tabs, 2026-10)
// ModeTabs / StatsSidebar / 其他需要响应式断点的组件共用。
// ============================================================
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    () => window.matchMedia(query).matches,
    () => false, // SSR snapshot
  );
}
