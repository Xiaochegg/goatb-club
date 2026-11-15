// ============================================================
// parallax-manager.ts — 高级动效·阶段 2（GSAP + ScrollTrigger 视差）
//
// 设计原则（用户锁定）：
//   - intro/hero 区动效可以强；PlayerList 榜单区必须安静无 parallax
//   - 克制优先：小幅 Y 位移（16-44px），不透明度、不缩放、不旋转
//   - 沙盒 4GB：动态 import gsap+ScrollTrigger → 独立 chunk，不进首屏主 bundle
//
// 作用域（硬边界）：
//   仅 [data-bg-zone="particles"] 内的 [data-parallax] 元素。
//   static-gradient zone（榜单区）零接触，保证数据可读性。
//
// canRun 守卫（复用 bg-context.detectCapability）：
//   - reducedMotion=true → 跳过（尊重无障碍设置）
//   - lowEnd=true（mem≤2 / cores≤2）→ 跳过（沙盒 cores=2 即跳过）
//
// 预算影响（B 卷修订版，scroll 监听放宽至 ≤3）：
//   - 新增 scroll 监听：1（ScrollTrigger 内部，passive）
//   - 累计：6.1 触发器(1) + ScrollTrigger(1) = 2 ≤ 3 ✓
//   - rAF 循环：gsap ticker 仅在滚动事件期间唤醒，idle 时睡眠，不计入连续循环
// ============================================================

import { detectCapability } from '@/components/backgrounds/bg-context';

const INTRO_ZONE_SELECTOR = '[data-bg-zone="particles"]';
const PARALLAX_EL_SELECTOR = '[data-parallax]';
const DEFAULT_SPEED = 0.12;
/** speed × MAX_MAGNITUDE_PX = 最大位移。0.12×200=24px，0.22×200=44px */
const MAX_MAGNITUDE_PX = 200;
/** speed 上限，防止过大位移破坏布局 */
const SPEED_CLAMP = 0.5;

interface GSAPAPI {
  registerPlugin: (...plugins: unknown[]) => void;
  to: (target: HTMLElement, vars: Record<string, unknown>) => { scrollTrigger?: { kill: () => void }; kill: () => void };
}

interface ScrollTriggerClass {
  refresh: () => void;
}

export class ParallaxManager {
  private gsap: GSAPAPI | null = null;
  private ScrollTrigger: ScrollTriggerClass | null = null;
  private tweens: Array<{ kill: () => void; scrollTrigger?: { kill: () => void } }> = [];
  private destroyed = false;
  private started = false;

  /**
   * 启动视差。
   * - reduced-motion / low-end：不启动，元素保持原位（降级）
   * - 动态 import gsap+ScrollTrigger：~110KB minified 独立 chunk，首屏零下载
   * - 作用域限定 intro zone，逐元素建 scrubbed tween
   */
  async start(): Promise<void> {
    if (this.started || this.destroyed) return;

    const cap = detectCapability();
    // dev-only 旁路：沙盒 cores=2 → lowEnd=true 会跳过，__PARALLAX_FORCE_RUN 供 agent-browser 验证
    // 生产构建 NODE_ENV=production 时此判断为 false（死代码消除），不影响真实降级逻辑
    const forceRun =
      process.env.NODE_ENV !== 'production' &&
      (window as unknown as { __PARALLAX_FORCE_RUN?: boolean }).__PARALLAX_FORCE_RUN === true;
    if (!forceRun && (cap.reducedMotion || cap.lowEnd)) {
      // 降级：不启动视差。元素保持 CSS 原位，不影响可读性。
      return;
    }

    const introZone = document.querySelector<HTMLElement>(INTRO_ZONE_SELECTOR);
    if (!introZone) return;

    const parallaxEls = Array.from(
      introZone.querySelectorAll<HTMLElement>(PARALLAX_EL_SELECTOR)
    );
    if (parallaxEls.length === 0) return;

    // 动态 import：拆独立 chunk，保首屏阻塞 JS 指标
    const { gsap } = await import('gsap');
    const { ScrollTrigger } = await import('gsap/ScrollTrigger');
    gsap.registerPlugin(ScrollTrigger);

    // import 期间可能已 destroy
    if (this.destroyed) return;

    this.gsap = gsap as unknown as GSAPAPI;
    this.ScrollTrigger = ScrollTrigger as unknown as ScrollTriggerClass;
    this.started = true;

    parallaxEls.forEach((el) => {
      const rawSpeed = parseFloat(el.dataset.parallaxSpeed || String(DEFAULT_SPEED));
      const speed = Math.max(0, Math.min(rawSpeed, SPEED_CLAMP));
      const magnitude = speed * MAX_MAGNITUDE_PX;

      // scrub: true → 1 帧延迟直接绑定 scroll，无 gsap 平滑（避免 ticker 常驻 rAF）
      // start 'top top' → intro 顶部到视口顶（首屏已满足，header 下方即开始）
      // end   'bottom top' → intro 底部滚过视口顶（intro 完全离开）
      const tween = gsap.to(el, {
        y: -magnitude,
        ease: 'none',
        scrollTrigger: {
          trigger: introZone,
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
      });
      this.tweens.push(tween);
    });

    // dev CSS 注入延迟 / 字体加载可能导致初始几何偏差，下一帧 refresh 一次校准
    requestAnimationFrame(() => {
      if (this.destroyed || !this.ScrollTrigger) return;
      this.ScrollTrigger.refresh();
    });
  }

  /** 销毁：杀所有 tween + scrollTrigger，释放 gsap 引用 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.tweens.forEach((tw) => {
      tw.scrollTrigger?.kill();
      tw.kill();
    });
    this.tweens = [];

    this.gsap = null;
    this.ScrollTrigger = null;
  }

  /** 调试用：手动触发 refresh（布局变化后校准） */
  refresh(): void {
    if (this.destroyed || !this.ScrollTrigger) return;
    this.ScrollTrigger.refresh();
  }
}
