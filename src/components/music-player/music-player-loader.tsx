'use client';

/**
 * MusicPlayerLoader
 * 音乐播放器脚本加载器（Task 38 建 → Task 41 重构为左下角浮动图标播放器）。
 *
 * Task 41 架构决策：
 * - 旧 React Modal（music-player-modal.tsx）已从 page.tsx 渲染树移除——
 *   音乐入口迁移至左下角 mp-root 浮动图标播放器（music-player-init.js），
 *   支持收起为小图标 / 展开为浮窗 / 拖拽 / 搜索 / 多榜单 tab。
 * - liveling-music-player CDN 已移除（黑盒数据流导致跳歌痛点）。
 * - 统一数据流：mp-root 播放器 → 同源服务端路由
 *   （/api/v1/music/artist|hot|toplist|search|stream）→ weapi 直连网易，
 *   不受浏览器 CORS 限制，最稳定。第三方公开 API 作为 audio error 换源后备。
 *
 * 加载链：config → api → init → copyright（async=false 保顺序）
 *
 * 预算影响：0 scroll / 0 rAF；阻塞 JS 为 0（链式脚本 afterInteractive）
 *
 * B2（2026-11-03，轻量化改造）：注入时机由「水合后立即」改为「浏览器空闲时」
 * （requestIdleCallback，超时 3 秒兜底；无该 API 的环境 setTimeout 1200ms）。
 * 4 个脚本合计约 96KB，让位首屏水合与交互；保序链与防重复标识不变；
 * 浮动图标出现时点相应延后数百毫秒（预期内权衡，v2 计划 3.3 节 B2）。
 */
import { useEffect } from 'react';

const CHAIN_SCRIPTS = [
  '/js/music-config.js',
  '/js/music-api.js',
  // Task 41: 重新启用 mp-root 自建浮动图标播放器（左下角，收起为图标/展开为浮窗）
  '/js/music-player-init.js',
  '/js/music-copyright-notice.js',
  // （2026-12 清理：Task 40-4 的降级测试脚本 music-test.js 已移出生产加载链并删除）
];

/**
 * 注入环境变量到 window.__MUSIC_ENV__，供 music-config.js 读取。
 * 敏感信息（如 NCM_COOKIE）通过 Next.js 公开环境变量传入：
 *   NEXT_PUBLIC_NCM_COOKIE=xxx
 * 注意：NEXT_PUBLIC_ 前缀的变量会在构建时内联到客户端 bundle，仅放可公开的配置。
 *      真正敏感的 cookie 应通过自建 API 中转，不直接暴露到前端。
 */
function injectEnv() {
  if (typeof window === 'undefined') return;
  if (window.__MUSIC_ENV__) return; // 防重复
  window.__MUSIC_ENV__ = {
    NCM_COOKIE: process.env.NEXT_PUBLIC_NCM_COOKIE || '',
  };
}

/**
 * 注入 touch-action CSS，预防移动端拖拽不灵敏。
 * React Modal 控件（进度条/音量条）由 React/Tailwind 处理；
 * 保留 .lp-root 系列以防 liveling 未来重新启用。
 */
function injectTouchActionStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('music-touch-action-style')) return;
  const style = document.createElement('style');
  style.id = 'music-touch-action-style';
  style.textContent = `
    .lp-root, .lp-panel, .lp-disc-btn {
      touch-action: manipulation;
    }
  `;
  document.head.appendChild(style);
}

function loadChain() {
  injectEnv();
  injectTouchActionStyle();
  let i = 0;
  const loadNext = () => {
    if (i >= CHAIN_SCRIPTS.length) return;
    const src = CHAIN_SCRIPTS[i++];
    // 防重复加载（React 19 Strict Mode 双调 / HMR）
    if (document.querySelector(`script[data-music-src="${src}"]`)) {
      loadNext();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = false; // 保持顺序：config → api → init → copyright
    s.dataset.musicSrc = src;
    s.onload = loadNext;
    s.onerror = () => console.error('[MusicPlayerLoader] 链式加载失败:', src);
    document.body.appendChild(s);
  };
  loadNext();
}

export function MusicPlayerLoader() {
  // B2：空闲时注入（而非水合后立即）；卸载时取消未触发的调度；
  // 链一旦启动不中断（脚本为全局副作用，Strict Mode 双调由防重复标识拦截）
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (!cancelled) loadChain();
    };
    let idleHandle = 0;
    let fallbackTimer = 0;
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(start, { timeout: 3000 });
    } else {
      fallbackTimer = window.setTimeout(start, 1200);
    }
    return () => {
      cancelled = true;
      if (idleHandle) window.cancelIdleCallback(idleHandle);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, []);

  return null;
}
