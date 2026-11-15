// ============================================================
// cursor-manager.ts — 高级动效·阶段 3（Custom Cursor）
//
// 设计原则：
//   - 两元素：dot（8px，1:1 跟随）+ ring（32px，0.18 lerp 缓动 trailing）
//   - mix-blend-mode: difference → 任何背景下自动反色可见（dark/light 通用）
//   - hover 检测：a/button/[role=button]/[data-cursor] → ring 放大变色
//   - text 检测：input/textarea/contenteditable → dot 隐藏 + ring 变 I-beam
//   - 点击脉冲：pointerdown/up → ring 快速缩放反馈
//
// canRun 守卫（3 道门）：
//   - reducedMotion=true → 跳过（尊重无障碍）
//   - lowEnd=true（mem≤2 / cores≤2）→ 跳过
//   - (pointer: fine)=false → 跳过（触屏设备无 hover，原生触控更合适）
//
// 预算影响（B 卷修订版）：
//   - 新增 scroll 监听：0（仅 mousemove + mouseover + pointerdown/up，无 scroll）
//   - 累计 scroll 监听仍 2（6.1 触发器 1 + ScrollTrigger 1）≤ 3 ✓
//   - rAF：1 自取消循环（cursor 静止时 cancelAnimationFrame，不常驻）≤ 2 ✓
//   - mix-blend-mode 跨 isolate 边界：cursor 挂 body（isolate 兄弟），z-index max
//     与 isolate 容器的扁平化渲染层做 difference 混合 → 任何背景可见
// ============================================================

import { detectCapability } from '@/components/backgrounds/bg-context';

const HOVER_SELECTOR = 'a, button, [role="button"], [data-cursor="hover"], label[for], summary';
const TEXT_SELECTOR = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, [contenteditable="true"], [contenteditable=""], [data-cursor="text"]';
const LERP = 0.18;
const SLEEP_THRESHOLD = 0.4;

export class CursorManager {
  private dot: HTMLDivElement | null = null;
  private ring: HTMLDivElement | null = null;
  private rafId = 0;
  private mouseX = 0;
  private mouseY = 0;
  private ringX = 0;
  private ringY = 0;
  private started = false;
  private destroyed = false;
  private hidden = false;

  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    // dot 1:1 跟随（无缓动，即时响应）
    if (this.dot) {
      this.dot.style.transform = `translate(${this.mouseX}px, ${this.mouseY}px)`;
      // 首次 mousemove 移除初始 hidden（start() 时加的，避免首屏闪烁在 (0,0)）
      // 但 text 模式下 dot 必须保持隐藏（I-beam 由 ring 担当）
      if (!this.ring?.classList.contains('cursor-ring--text')) {
        this.dot.classList.remove('cursor-dot--hidden');
      }
    }
    if (this.ring) {
      this.ring.classList.remove('cursor-ring--hidden');
    }
    // ring 走 rAF lerp；若循环已睡眠则唤醒
    if (!this.rafId && !this.destroyed) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private tick = (): void => {
    if (this.destroyed || !this.ring) {
      this.rafId = 0;
      return;
    }
    this.ringX += (this.mouseX - this.ringX) * LERP;
    this.ringY += (this.mouseY - this.ringY) * LERP;
    this.ring.style.transform = `translate(${this.ringX}px, ${this.ringY}px)`;
    // 收敛后自取消（cursor 静止时不占 rAF 预算）
    if (Math.abs(this.mouseX - this.ringX) > SLEEP_THRESHOLD ||
        Math.abs(this.mouseY - this.ringY) > SLEEP_THRESHOLD) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = 0;
    }
  };

  private onMouseOver = (e: MouseEvent): void => {
    if (!this.ring || !this.dot) return;
    const target = e.target as Element | null;
    if (!target || !target.closest) return;

    const isText = !!target.closest(TEXT_SELECTOR);
    const isHover = !isText && !!target.closest(HOVER_SELECTOR);

    this.ring.classList.toggle('cursor-ring--text', isText);
    this.ring.classList.toggle('cursor-ring--hover', isHover);
    // text 模式隐藏 dot（I-beam 由 ring 担当）
    this.dot.classList.toggle('cursor-dot--hidden', isText);
  };

  private onPointerDown = (): void => {
    this.ring?.classList.add('cursor-ring--active');
  };

  private onPointerUp = (): void => {
    this.ring?.classList.remove('cursor-ring--active');
  };

  private onMouseLeave = (): void => {
    // 鼠标离开窗口 → 隐藏自定义光标
    this.hidden = true;
    this.dot?.classList.add('cursor-dot--hidden');
    this.ring?.classList.add('cursor-ring--hidden');
  };

  private onMouseEnter = (): void => {
    if (!this.hidden) return;
    this.hidden = false;
    // 仅当不在 text 模式时恢复 dot
    if (!this.ring?.classList.contains('cursor-ring--text')) {
      this.dot?.classList.remove('cursor-dot--hidden');
    }
    this.ring?.classList.remove('cursor-ring--hidden');
  };

  /** 启动自定义光标。reduced-motion / low-end / coarse-pointer 跳过。 */
  start(): void {
    if (this.started || this.destroyed) return;

    const cap = detectCapability();
    // dev-only 旁路：沙盒 cores=2 → lowEnd=true 跳过，__CURSOR_FORCE_RUN 供 agent-browser 验证
    const forceRun =
      process.env.NODE_ENV !== 'production' &&
      (window as unknown as { __CURSOR_FORCE_RUN?: boolean }).__CURSOR_FORCE_RUN === true;

    if (!forceRun && (cap.reducedMotion || cap.lowEnd)) {
      return;
    }
    // 触屏设备（无 fine pointer / 无 hover）→ 原生触控更合适
    if (!forceRun && !window.matchMedia('(pointer: fine)').matches) {
      return;
    }

    // 创建元素
    this.dot = document.createElement('div');
    this.dot.className = 'cursor-dot cursor-dot--hidden'; // 首屏 hidden，首次 mousemove 后显示
    this.ring = document.createElement('div');
    this.ring.className = 'cursor-ring cursor-ring--hidden';

    // 挂到 body（isolate 容器兄弟），z-index max，mix-blend-mode 跨 isolate 可用
    document.body.appendChild(this.dot);
    document.body.appendChild(this.ring);

    // 隐藏原生光标
    document.documentElement.classList.add('custom-cursor-active');

    // 事件（全 passive，不阻塞滚动/交互）
    document.addEventListener('mousemove', this.onMouseMove, { passive: true });
    document.addEventListener('mouseover', this.onMouseOver, { passive: true });
    document.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    document.addEventListener('pointerup', this.onPointerUp, { passive: true });
    document.addEventListener('mouseleave', this.onMouseLeave, { passive: true });
    document.addEventListener('mouseenter', this.onMouseEnter, { passive: true });

    this.started = true;
  }

  /** 销毁：移除元素 + 事件 + class，零泄漏 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseover', this.onMouseOver);
    document.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('mouseleave', this.onMouseLeave);
    document.removeEventListener('mouseenter', this.onMouseEnter);

    this.dot?.remove();
    this.ring?.remove();
    this.dot = null;
    this.ring = null;

    document.documentElement.classList.remove('custom-cursor-active');
  }
}
