'use client';

// ============================================================
// SiteBackground — 背景槽位层（D 卷三.槽位规范）
//
// 三层分离（D 卷二）：
//   Layer 1 槽位 = 本组件（固定 DOM，全站只此一处，page.tsx 零改动）
//   Layer 2 插件 = src/components/backgrounds/plugins/*（各自独立，互不感知）
//   Layer 3 控制 = BGController（唯一知道全局，管切换/过渡/快照/事件分发）
//
// 槽位契约（D 卷三.6 红线）：
//   - 插件只允许操作 data-bg-stage 内部
//   - 插件禁止改 #site-background 自身的 class/style（除 stage）
//   - 插件禁止碰 header/main/footer 与 body background
//   - data-bg-ready="true" 前插件 stage 必须空或不可见
//
// 首屏策略（D 卷五.1）：
//   t0 SSR 输出槽位 + fallback 层（用户不看到白屏）
//   t2 hydrate → useEffect 建控制器 → detectCapability → pickInitial
//   t3 mount() resolve → data-bg-ready=true → fallback 隐藏、插件可见
//
// customBg（管理员自定义背景图）：本槽位整体让位 return null，尊重既有功能
// ============================================================

import { useEffect, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { BGController } from './backgrounds/bg-controller';
import { ScrollIntervalTrigger } from './backgrounds/triggers/scroll-interval-trigger';
import { UserActionTrigger } from './backgrounds/triggers/user-action-trigger';

export function SiteBackground() {
  const customBg = useAppStore(s => s.customBg);
  const pausedMotion = useAppStore(s => s.pausedMotion);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const ctrlRef = useRef<BGController | null>(null);
  const triggerRef = useRef<ScrollIntervalTrigger | null>(null);
  const userActionRef = useRef<UserActionTrigger | null>(null);

  useEffect(() => {
    // customBg 有值时管理员自定义背景图接管，本槽位不启动
    if (customBg) return;
    if (!slotRef.current) return;

    const ctrl = new BGController(slotRef.current);
    ctrlRef.current = ctrl;

    // 滚动区间触发器（D 卷 6.1）：reduced-motion 或 zone <2 时 start() 返回
    // initialBg=null，触发器不启动，首屏走 pickInitial 兜底。
    // 启动时同步算首屏 zone，与 pickInitial 二选一，避免首屏双切。
    const trigger = new ScrollIntervalTrigger({ controller: ctrl });
    triggerRef.current = trigger;
    const { initialBg } = trigger.start();
    const initial = initialBg ?? ctrl.pickInitial();

    // 用户动作触发器（D 卷 6.2）：与 scroll-trigger 协调，模态打开时强制 static-gradient
    const userAction = new UserActionTrigger({
      controller: ctrl,
      scrollTrigger: trigger,
    });
    userActionRef.current = userAction;

    ctrl.setBackground(initial).then(() => {
      // 首屏 mount 完成：开启 scroll 驱动切换 + 用户动作监听
      trigger.activate();
      userAction.start();
    }).catch(err => {
      // 首屏挂载失败：降级到 static-gradient 兜底
      console.warn('[bg] 初始背景挂载失败，降级 static-gradient', err);
      ctrl.setBackground('static-gradient').catch(() => {});
    });

    // 调试入口
    if (process.env.NODE_ENV !== 'production') {
      const w = window as unknown as {
        __bg?: BGController;
        __bgTrigger?: ScrollIntervalTrigger;
        __userActionTrigger?: UserActionTrigger;
        __store?: typeof useAppStore;
      };
      w.__bg = ctrl;
      w.__bgTrigger = trigger;
      w.__userActionTrigger = userAction;
      w.__store = useAppStore;  // 供 agent-browser eval 拨模态状态验证 6.2
    }

    return () => {
      userAction.destroy();
      userActionRef.current = null;
      trigger.destroy();
      triggerRef.current = null;
      ctrl.destroy();
      ctrlRef.current = null;
      if (process.env.NODE_ENV !== 'production') {
        const w = window as unknown as {
          __bg?: BGController;
          __bgTrigger?: ScrollIntervalTrigger;
          __userActionTrigger?: UserActionTrigger;
          __store?: typeof useAppStore;
        };
        delete w.__bg;
        delete w.__bgTrigger;
        delete w.__userActionTrigger;
        delete w.__store;
      }
    };
  }, [customBg]);

  // SA-09 无障碍：pausedMotion=true → 暂停 WebGL/粒子背景的自动播放动画
  // （Three.js 旋转、粒子飘浮等连续循环 >5s 属 WCAG 2.2「自动播放可暂停」范畴）
  // 插件 pause()/resume() 由 BGController 分发（three-bg/particles-bg 均实现）
  // 注意：此 effect 必须在 `if (customBg) return null` 之前，保 hook 顺序稳定；
  //       customBg=true 时 ctrl 未建，effect 内 `if (!ctrl) return` 安全跳过
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (pausedMotion) ctrl.pauseCurrent();
    else ctrl.resumeCurrent();
  }, [pausedMotion]);

  // Batch 4 · 背景修复 P1-b（管理员已批，依据 Batch 3 背景诊断报告根因2）：
  // 真机浏览器 UI 兜底色 theme-color。layout.tsx 属 A 类冻结且已导出 viewport，
  // 无法以 metadata API 补充 → 由本装饰层客户端注入（背景系统职责内）。
  // 仅影响地址栏/任务切换器等浏览器 chrome 底色，页面渲染零影响；
  // customBg 模式同样注入（meta 只管浏览器 chrome，不与自定义背景图冲突）。
  useEffect(() => {
    if (document.querySelector('meta[name="theme-color"]')) return;
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#1a1a2e';
    document.head.appendChild(meta);
  }, []);

  // 管理员设置自定义背景图时让位
  if (customBg) return null;

  return (
    <div
      ref={slotRef}
      id="site-background"
      className="site-bg"
      data-bg-current="none"
      data-bg-ready="false"
      aria-hidden="true"
    >
      {/* 3.1 降级层：永远最先可见，JS 生效后被 data-bg-ready 隐藏 */}
      <div className="site-bg__fallback" data-bg-fallback />
      {/* 3.2 插件挂载点：插件只往这里塞 DOM */}
      <div className="site-bg__stage" data-bg-stage />
      {/* 3.3 过渡层：切换时盖在两层之间，负责淡入淡出 */}
      <div className="site-bg__veil" data-bg-veil />
      {/* 3.4 性能提示层：低端机降级时可选显示一行说明 */}
      <div className="site-bg__notice" data-bg-notice hidden />
    </div>
  );
}
