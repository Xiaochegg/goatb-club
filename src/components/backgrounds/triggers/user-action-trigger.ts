// ============================================================
// user-action-trigger — 用户动作切换触发器（D 卷 6.2）
//
// 职责：监听大型模态的开闭状态，任一大型模态打开时强制背景切到
//       static-gradient（降低视觉干扰让模态内容突出），全关闭后交还
//       scroll-interval-trigger 按当前 scroll 位置接管。
//
// 设计要点：
//   1. 零 scroll 监听 / 零 rAF——纯 Zustand store 订阅，状态变化即触发。
//   2. 零依赖——store 订阅是 Zustand 原生能力。
//   3. "大型模态"定义：会显著遮挡视口或强制用户聚焦的模态。filterSheet
//      （底部条，背景仍可见）、tierDropdown（小下拉）不算，不强制切背景。
//   4. 与 scroll-interval-trigger 协调（关键）：
//      - 打开模态：调 controller.setBackground('static-gradient') +
//        scrollTrigger.syncCurrentBg('static-gradient')，避免 scroll-trigger
//        的 currentBg 过期导致下次 scroll 事件漏切。
//      - 关闭模态：调 scrollTrigger.requestCheck()，按当前 scroll 几何重算
//        active zone 并按需切回（用户在 intro 区则回 particles，在数据区则
//        保持 static-gradient）。
//   5. reduced-motion 下不启动——reduced 用户首屏已落 static-gradient，
//      模态打开再切一次无意义，省一次 veil 过渡。
//   6. destroy 时取消 store 订阅，零泄漏。
//
// 集成：site-background.tsx 在 scroll-trigger 之后创建本触发器，传入
//       controller + scrollTrigger。start() 订阅 store，首屏不主动切
//       （由 scroll-trigger 的 pickInitial 兜首屏）。
// ============================================================

import type { BGController } from '../bg-controller';
import type { ScrollIntervalTrigger } from './scroll-interval-trigger';
import { useAppStore } from '@/lib/store';

export interface UserActionTriggerOptions {
  /** 控制器实例（唯一切换入口） */
  controller: BGController;
  /** scroll-interval-trigger 引用，用于协调 currentBg / 请求 check */
  scrollTrigger: ScrollIntervalTrigger;
  /** reduced-motion 下是否禁用；默认 true */
  respectReducedMotion?: boolean;
}

/** 大型模态状态字段名（store 里的 boolean 字段） */
const LARGE_MODAL_KEYS = [
  'adminPanelOpen',
  'diyEditorOpen',
  'chatOpen',
  'musicPlayerOpen',
  'aiAssistantOpen',
  'playerAuthOpen',
  'profileOpen',
  'adminLoginOpen',
  'commandPaletteOpen',
] as const;

/** 模态打开时强制切换到的背景 id */
const MODAL_BG = 'static-gradient';

export class UserActionTrigger {
  private controller: BGController;
  private scrollTrigger: ScrollIntervalTrigger;
  private respectReducedMotion: boolean;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private destroyed = false;
  /** 当前是否处于"模态打开"覆盖态（true=已强制切 static-gradient） */
  private overriding = false;

  constructor(opts: UserActionTriggerOptions) {
    this.controller = opts.controller;
    this.scrollTrigger = opts.scrollTrigger;
    this.respectReducedMotion = opts.respectReducedMotion ?? true;
  }

  /**
   * 启动触发器。订阅 store 的模态状态。首屏不主动切——由 scroll-trigger
   * 的 pickInitial 兜首屏，本触发器只在模态状态变化时介入。
   */
  start(): void {
    if (this.destroyed || this.started) return;
    this.started = true;

    // reduced-motion：不启动，reduced 用户保持 static-gradient，模态切换无意义
    if (this.respectReducedMotion && prefersReducedMotion()) return;

    // 订阅大型模态状态：任一变化即 checkModals
    this.unsubscribe = useAppStore.subscribe((state, prev) => {
      if (this.destroyed) return;
      const nowOpen = LARGE_MODAL_KEYS.some(k => state[k]);
      const wasOpen = LARGE_MODAL_KEYS.some(k => prev[k]);
      if (nowOpen !== wasOpen) this.onModalChange(nowOpen);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ── 内部 ──────────────────────────────────────────────

  private onModalChange(anyModalOpen: boolean): void {
    if (anyModalOpen && !this.overriding) {
      // 任一大型模态打开 → 强制 static-gradient
      this.overriding = true;
      this.controller.setBackground(MODAL_BG).catch(() => {});
      // 同步 scroll-trigger 的 currentBg，避免下次 scroll 事件 currentBg 过期漏切
      this.scrollTrigger.syncCurrentBg(MODAL_BG);
    } else if (!anyModalOpen && this.overriding) {
      // 全部关闭 → 交还 scroll-trigger，按当前 scroll 几何恢复
      this.overriding = false;
      this.scrollTrigger.requestCheck();
    }
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
