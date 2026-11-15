// ============================================================
// static-gradient-bg — 降级兜底插件
// 适用：reduced-motion / 极低端机 / 无 WebGL / 无 JS（fallback 层）
// 纯 CSS 静态渐变，无 rAF，mount 即完成，start/pause/resume 空操作。
// 色调与 particles 接近，切换不突兀。
// ============================================================

import type { BGPlugin, BGCtx } from '../bg-types';

let el: HTMLDivElement | null = null;

export const staticGradientBg: BGPlugin = {
  id: 'static-gradient',
  name: '静态渐变（省电）',
  version: '1.0.0',

  async mount(stage: HTMLElement, _ctx: BGCtx) {
    el = document.createElement('div');
    el.className = 'bg-static-gradient';
    el.style.cssText = [
      'position:absolute;inset:0',
      'background:',
      'radial-gradient(ellipse 70% 50% at 20% 15%, rgba(191,90,242,0.06), transparent 60%),',
      'radial-gradient(ellipse 60% 45% at 80% 85%, rgba(46,204,113,0.05), transparent 55%),',
      'radial-gradient(ellipse 50% 40% at 50% 50%, rgba(212,175,55,0.035), transparent 60%),',
      '#1a1a2e',
    ].join(' ');
    stage.appendChild(el);
  },

  start() {},
  pause() {},
  resume() {},

  destroy() {
    el?.remove();
    el = null;
  },

  configSchema: [],
};
