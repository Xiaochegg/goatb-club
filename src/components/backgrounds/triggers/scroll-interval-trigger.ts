// ============================================================
// scroll-interval-trigger — 滚动区间切换触发器（D 卷 6.1）
//
// 职责：监听带 [data-bg-zone="<plugin-id>"] 的 section 元素，
//       当某 zone 的区间包含视口 40% 阅读线时，调用
//       controller.setBackground(zone) 自动切换背景。
//
// 设计要点：
//   1. 1 个 passive scroll 监听 + rAF 节流（≤1 预算内，当前全站 0 → 1）。
//      曾尝试 IntersectionObserver（0 scroll 监听），但沙盒 headless Chromium
//      下 IO 对 0 高线 rootMargin + 布局变化组合不触发（滚动时 IO 不 fire），
//      故改用 scroll 监听——最可靠的 scroll-spy 实现。
//   2. 零 rAF 循环——rAF 仅按需调度（scroll 事件触发一次 rAF 回调，不持续循环）。
//   3. 零依赖——原生 scroll 监听 + requestAnimationFrame。
//   4. 触发线 = viewport 40%（innerHeight * 0.4）。active zone = 区间包含阅读线
//      （top ≤ line ≤ bottom）的 zone；线在所有 zone 上方时回退第一个 zone，
//      线落在 zone 间隙/页尾时回退最后一个 top 已越线的 zone（旧语义收敛）。
//      Batch 4 修复（管理员已批，依据 Batch 3 背景诊断报告根因1）：旧逻辑只看
//      top、线在 25%，而本页两个 zone 标记仅相距 ~60px → 首屏双 top 同时越线，
//      "最后越线者"恒为 static-gradient 且窄边界带内微小滚动即反复翻转
//      （实测 scroll 700 翻转 particles → 320ms veil 闪变）。新边界 = intro
//      zone 底边穿越 40% 线，单调且远离双 top 窄带；排行榜（高 zone）阅读期
//      包含关系恒成立 → 零往返抖动。
//   4b. 切换冷却（2026-10 滚动性能审计）：900ms 内不重复切换。桌面布局下两个
//       zone 标记在文档中仅相距 ~60px，边界区域极窄，空间迟滞带会永久阻断
//       反向切换；时间冷却既能抑制边界抖动导致的 veil 闪变滥用
//       （每次切换 = 320ms 遮罩 + 插件销毁/重建），又不破坏任意几何下的双向可达性。
//   5. reduced-motion 下不启动——reduced 用户首屏已落 static-gradient
//      （pickInitial），自动切换可能把粒子强加给 reduced 用户，违背其偏好。
//   6. ready 门控：首屏 setBackground 完成前 scroll 回调不切（避免布局未稳定时
//      抢切）。activate() 在首屏 mount 完成后调用，等布局稳定后一次性同步。
//   7. 布局稳定判定：所有 zone top 互不相同（退化态 top=0 表示 CSS/子组件未就绪）。
//      最多重试 30 帧（~480ms）。超时仍不稳定则跳过同步——保持首屏 bg（pickInitial），
//      生产环境 CSS 随首屏 HTML 到位不会退化。
//   8. destroy 彻底移除监听 + cancel rAF，零泄漏。
//
// 集成：site-background.tsx 在 controller 初始化后创建本触发器，
//       start() 建 scroll 监听（ready=false 不切）；首屏 setBackground
//       完成后调 activate() 置 ready=true + 一次性同步。page.tsx 只需在
//       section 上加 data-bg-zone。
// ============================================================

import type { BGController } from '../bg-controller';

export interface ScrollIntervalTriggerOptions {
  /** 控制器实例（唯一切换入口） */
  controller: BGController;
  /** reduced-motion 下是否禁用触发器；默认 true（reduced 用户保持首屏选择） */
  respectReducedMotion?: boolean;
}

/** start() 返回值：initialBg=null 表示触发器未启动（reduced 或 zone 不足/布局退化） */
export interface TriggerStartResult {
  /** 首屏 bg 提示：布局已稳定时返回当前 scroll 位置对应的 zone bg，
   *  调用方与 pickInitial 二选一，避免首屏双挂载（three-net→particles 白切一次） */
  initialBg: string | null;
}

const ZONE_ATTR = 'data-bg-zone';

interface Zone {
  el: HTMLElement;
  bg: string;
}

export class ScrollIntervalTrigger {
  private controller: BGController;
  private respectReducedMotion: boolean;
  private zones: Zone[] = [];
  private started = false;
  private destroyed = false;
  /** 初始 mount 完成前 scroll 回调不生效（避免布局未稳定时抢切） */
  private ready = false;
  /** 当前已请求的 bg（避免重复调用 setBackground，控制器虽 no-op 但省一次调用） */
  private currentBg = '';
  /** 切换冷却：上次切换后 900ms 内忽略新的切换请求（下次 scroll 事件重试） */
  private static readonly SWITCH_COOLDOWN_MS = 900;
  private lastSwitchAt = 0;
  private scrollHandler: (() => void) | null = null;
  private rafId: number | null = null;

  constructor(opts: ScrollIntervalTriggerOptions) {
    this.controller = opts.controller;
    this.respectReducedMotion = opts.respectReducedMotion ?? true;
  }

  /**
   * 启动触发器。内部：
   *   1. reduced-motion 检查 → 不启动
   *   2. 发现 [data-bg-zone] 元素 → <2 个不启动
   *   3. 建 1 个 passive scroll 监听（rAF 节流），ready=false 期间不切
   *   4. 返回 initialBg=null——首屏布局可能未稳定，由调用方走 pickInitial
   */
  start(): TriggerStartResult {
    if (this.destroyed || this.started) return { initialBg: null };
    this.started = true;

    // reduced-motion：不启动，让 pickInitial 的 static-gradient 保持
    if (this.respectReducedMotion && prefersReducedMotion()) {
      return { initialBg: null };
    }

    this.zones = this.discoverZones();
    if (this.zones.length < 2) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[bg-trigger] 仅发现 ${this.zones.length} 个 [${ZONE_ATTR}] 元素，` +
          `滚动区间切换需 ≥2 个，触发器不启动`,
        );
      }
      return { initialBg: null };
    }

    // 1 个 passive scroll 监听 + rAF 节流。ready=false 期间 check() 不切。
    this.scrollHandler = () => this.scheduleCheck();
    window.addEventListener('scroll', this.scrollHandler, { passive: true });

    // 同步计算首屏 zone（D 卷设计意图：与 pickInitial 二选一，避免首屏双切）。
    // useEffect 时 DOM 已提交，可安全测量；布局退化（top 全同/全 0）则返回 null
    // 让调用方走 pickInitial 兜底。
    if (this.zonesLayoutStable()) {
      const initial = this.computeActiveBg();
      if (initial) this.currentBg = initial;
      return { initialBg: initial };
    }
    return { initialBg: null };
  }

  /**
   * 首屏 setBackground 完成后调用：置 ready=true，并等布局稳定后做一次性同步。
   * 防止首屏 mount 期间布局未稳定时 scroll 回调抢切，并补正 mid-page 重载场景。
   */
  activate(): void {
    if (this.ready || this.destroyed || !this.scrollHandler) return;
    this.ready = true;
    this.syncWhenStable(0);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.zones = [];
  }

  // ── 对外协调入口（供 user-action-trigger 等其他触发器协调） ──

  /**
   * 同步 currentBg（不触发切换）。供外部触发器在直接调 controller.setBackground
   * 后同步本触发器的 state，避免下次 check 时 currentBg 过期导致漏切/错切。
   * 例：user-action-trigger 打开模态时调 controller.setBackground('static-gradient')，
   * 再调本方法同步 currentBg='static-gradient'；模态关闭后调 requestCheck() 恢复。
   */
  syncCurrentBg(bg: string): void {
    this.currentBg = bg;
  }

  /**
   * 请求一次 check（rAF 节流）。供外部触发器在条件变化后请求重算。
   * 例：user-action-trigger 关闭模态后调本方法，按当前 scroll 几何恢复 zone bg。
   */
  requestCheck(): void {
    if (!this.ready || this.destroyed) return;
    this.scheduleCheck();
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 扫描 DOM，收集所有 [data-bg-zone] 元素（文档序） */
  private discoverZones(): Zone[] {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(`[${ZONE_ATTR}]`),
    );
    const zones: Zone[] = [];
    for (const el of els) {
      const bg = el.getAttribute(ZONE_ATTR);
      if (bg) zones.push({ el, bg });
    }
    return zones;
  }

  /** scroll 事件 → rAF 节流（多事件合并为 1 帧一次 check） */
  private scheduleCheck(): void {
    if (this.rafId !== null) return; // 已调度，合并
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.check();
    });
  }

  /** 重算 active zone，与 currentBg 不同且不在冷却期则切换 */
  private check(): void {
    if (!this.ready || this.destroyed) return;
    if (document.hidden) return; // 切后台期间不切
    this.ensureZonesValid();
    const activeBg = this.computeActiveBg();
    if (!activeBg || activeBg === this.currentBg) return;
    const now = Date.now();
    if (now - this.lastSwitchAt < ScrollIntervalTrigger.SWITCH_COOLDOWN_MS) {
      return; // 冷却中：不排队不丢需求，下次 scroll 事件会重试
    }
    this.lastSwitchAt = now;
    this.currentBg = activeBg;
    // 控制器自带串行防抖 + 同 id no-op，这里 fire-and-forget
    this.controller.setBackground(activeBg).catch(() => {
      // 控制器 _doSwitch 抛错时已有兜底（catch 降级 static-gradient）
    });
  }

  /**
   * zone 引用可能因 React 重渲染失效（isDesktop 切换导致 wrapper div 重建）。
   * 检测到脱离文档的元素（!isConnected）则重新发现，避免 getBoundingClientRect
   * 对脱离文档元素返回 {top:0} 导致错算。
   */
  private ensureZonesValid(): void {
    if (this.zones.some(z => !z.el.isConnected)) {
      this.zones = this.discoverZones();
    }
  }

  /**
   * 同步计算当前应当激活的 bg（Batch 4 修复后：区间包含判定，见类头 4.）。
   * 主判据：active = 包含 40% 阅读线的 zone（top ≤ line ≤ bottom）。
   * 兜底 1：线在所有 zone 上方（页面顶部且首 zone 未达线）→ 第一个 zone。
   * 兜底 2：线落在 zone 间隙或页尾 → 最后一个 top 已越线的 zone（旧语义收敛）。
   * 切换边界 = intro zone 底边穿越阅读线，单调无窄带抖动；
   * 抖动防护仍由 check() 的时间冷却承担（见 SWITCH_COOLDOWN_MS）。
   */
  private computeActiveBg(): string | null {
    if (this.zones.length === 0) return null;
    const line = window.innerHeight * 0.4;
    // 主判据：区间包含阅读线的 zone（已进入阅读区且尚未滚出）
    for (const z of this.zones) {
      const r = z.el.getBoundingClientRect();
      if (r.top <= line && r.bottom >= line) return z.bg;
    }
    // 兜底 1：线在所有 zone 上方 → 第一个 zone（避免首屏落空）
    if (this.zones[0].el.getBoundingClientRect().top > line) {
      return this.zones[0].bg;
    }
    // 兜底 2：线在 zone 间隙或页尾 → 最后一个 top 已越过线的 zone
    let active = this.zones[0].bg;
    for (const z of this.zones) {
      const r = z.el.getBoundingClientRect();
      if (r.top <= line) active = z.bg;
    }
    return active;
  }

  /** 布局稳定判定：所有 zone top 互不相同（退化态 top=0 表示 CSS/子组件未就绪） */
  private zonesLayoutStable(): boolean {
    this.ensureZonesValid();
    const tops = this.zones.map(z => Math.round(z.el.getBoundingClientRect().top));
    return new Set(tops).size > 1;
  }

  /**
   * 等布局稳定后一次性同步。布局稳定判定：所有 zone top 互不相同
   * （退化态 top=0 表示 CSS/子组件未就绪）。最多重试 30 帧（~480ms）。
   * 超时仍不稳定则跳过——保持首屏 bg，生产环境不会退化。
   */
  private syncWhenStable(retries: number): void {
    if (this.destroyed) return;
    if (this.zonesLayoutStable()) {
      const activeBg = this.computeActiveBg();
      if (activeBg) {
        this.currentBg = activeBg;
        this.lastSwitchAt = Date.now(); // 吸收首屏加载后的边界抖动
        this.controller.setBackground(activeBg).catch(() => {});
      }
    } else if (retries < 30) {
      requestAnimationFrame(() => this.syncWhenStable(retries + 1));
    }
    // retries >= 30 且仍不稳定：跳过同步，保持首屏 bg
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
