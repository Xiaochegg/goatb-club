// ============================================================
// bg-types.ts — 背景插件契约（D 卷四.契约）
// 每个背景插件必须实现 5 个必选方法 + id/name/version。
// 可选：onScroll / capture / restore / configSchema。
// 控制层只通过这些方法与插件通信，插件彼此不感知。
// ============================================================

export type BGEvent = 'resize' | 'visibility' | 'reducedMotion' | 'theme';

export interface BGEventData {
  viewport?: { w: number; h: number };
  hidden?: boolean;
  reduced?: boolean;
  theme?: string;
  accent?: string;
}

export type BGEventHandler = (data: BGEventData) => void;

export interface BGCtx {
  /** 当前视口尺寸（mount 时刻快照；变化走 on('resize')） */
  viewport: { w: number; h: number };
  /** 用户是否开启「减少动态效果」 */
  reducedMotion: boolean;
  /** 低端机（deviceMemory≤2 或 cores≤2） */
  isLowEnd: boolean;
  /** 是否支持 WebGL（预留给 Three.js 类插件决策） */
  hasWebGL: boolean;
  /** mount 时的 scrollY，插件起始帧据此避免跳变 */
  initialScrollY: number;
  /** 实时读取 scrollY（rAF 内调用，不触发强制回流） */
  getScrollY: () => number;
  /** 订阅控制器事件（resize/visibility/reducedMotion/theme），返回 unsubscribe；
   *  控制器在 destroy 插件时自动失效，插件无需自己 removeEventListener */
  on: (event: BGEvent, handler: BGEventHandler) => () => void;
  /** SA-11 故障恢复：插件请求降级（如 WebGL contextlost 5s 未恢复）。
   *  控制器收到后切到 static-gradient（保留所有数据交互，仅移除 WebGL 渲染）。
   *  static-gradient 自身不调用此方法（避免无限循环）。*/
  requestFallback?: (reason: string) => void;
}

export interface BGSnapshot {
  [key: string]: unknown;
}

export interface BGConfigItem {
  key: string;
  label: string;
  type: 'number' | 'color' | 'boolean';
  default: number | string | boolean;
  min?: number;
  max?: number;
}

export interface BGPlugin {
  /** 唯一标识，英文小写，用于 setBackground(id) */
  id: string;
  /** 中文展示名，给调试/后台面板用 */
  name: string;
  version: string;

  /** 1. 挂载：把 DOM/canvas 塞进 stage，一次性初始化。resolve 表示「可以显示了」 */
  mount(stage: HTMLElement, ctx: BGCtx): Promise<void>;
  /** 2. 启动：mount 之后开始动画循环 */
  start(): void;
  /** 3. 暂停：切后台/省电，保持画面不动，resume 无缝继续 */
  pause(): void;
  /** 4. 恢复：与 pause 对称 */
  resume(): void;
  /** 5. 销毁：切走时彻底清理（rAF/监听/canvas/DOM），不销毁=内存泄漏 */
  destroy(): void;

  /** 6.(可选) 滚动进度回调 */
  onScroll?(progress: number, scrollY: number): void;
  /** 7.(可选) 捕获状态快照（切换走时存） */
  capture?(): BGSnapshot;
  /** 8.(可选) 恢复快照（切换回来时用，避免从头播放） */
  restore?(snap: BGSnapshot): void;
  /** 9.(可选) 配置项声明，给后台调节面板 */
  configSchema?: BGConfigItem[];
}
