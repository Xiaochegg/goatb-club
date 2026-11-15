// ============================================================
// bg-controller — 控制层（D 卷五.3 + 七）
//
// 职责（唯一知道全局的东西）：
//   1. 当前是哪个背景 / 切换 / 暂停 / 恢复
//   2. veil 过渡（先盖→销毁旧→挂载新→揭盖；reduced-motion 时长 0）
//   3. 防抖串行化（快速连切只跑首末，中间丢弃）
//   4. 快照存取（切走 capture / 切回 restore）
//   5. 全局事件分发（resize/visibility/reducedMotion → 插件）
//   6. 能力检测 → 首屏按 fallback chain 选插件
//   7. visibility → 当前插件 pause/resume
//
// 对外只暴露：setBackground(id) / pickInitial() / destroy()
// ============================================================

import type { BGPlugin, BGCtx, BGSnapshot, BGEvent, BGEventHandler } from './bg-types';
import { detectCapability, type BGCapability } from './bg-context';
import { BG_REGISTRY, BG_FALLBACK_CHAIN } from './bg-registry';

interface ControllerState {
  current: BGPlugin | null;
  currentId: string;
  snapshot: Map<string, BGSnapshot | null>;
  pending: boolean;       // 切换串行锁
  queued: string | null;  // 排队的下一次切换
  switching: boolean;     // 切换进行中（锁住 visibility 的 resume）
}

export class BGController {
  private slot: HTMLElement;
  private stage: HTMLElement;
  private veil: HTMLElement;
  private cap: BGCapability;
  private state: ControllerState;
  private listeners = new Map<BGEvent, Set<BGEventHandler>>();
  private globalCleanups: Array<() => void> = [];
  /** OPT-A 泄漏修复：destroy 后在途异步切换必须自终止，否则插件 mount+start 永久泄漏 */
  private destroyed = false;

  constructor(slot: HTMLElement) {
    this.slot = slot;
    this.stage = slot.querySelector('[data-bg-stage]') as HTMLElement;
    this.veil = slot.querySelector('[data-bg-veil]') as HTMLElement;
    this.cap = detectCapability();
    this.state = {
      current: null, currentId: 'none',
      snapshot: new Map(),
      pending: false, queued: null, switching: false,
    };
    this.bindGlobals();
  }

  // ── 全局监听（控制器唯一持有，分发给插件） ──────────────
  private bindGlobals() {
    const onResize = () => this.emit('resize', { viewport: { w: window.innerWidth, h: window.innerHeight } });
    const onVis = () => {
      const hidden = document.hidden;
      this.emit('visibility', { hidden });
      // 切后台暂停当前插件，切回恢复（切换进行中不恢复，避免与新插件的 start 打架）
      if (hidden) this.state.current?.pause();
      else if (!this.state.switching) this.state.current?.resume();
    };
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onRM = (e: MediaQueryListEvent) => this.emit('reducedMotion', { reduced: e.matches });

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    rm.addEventListener?.('change', onRM);

    this.globalCleanups.push(
      () => window.removeEventListener('resize', onResize),
      () => document.removeEventListener('visibilitychange', onVis),
      () => rm.removeEventListener?.('change', onRM),
    );
  }

  private emit(event: BGEvent, data: Parameters<BGEventHandler>[0]) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach(h => { try { h(data); } catch { /* 插件回调出错不影响其他 */ } });
  }

  private makeCtx(): BGCtx {
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      reducedMotion: this.cap.reducedMotion,
      isLowEnd: this.cap.lowEnd,
      hasWebGL: this.cap.hasWebGL,
      initialScrollY: window.scrollY,
      getScrollY: () => window.scrollY,
      on: (event, handler) => {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
        return () => { this.listeners.get(event)?.delete(handler); };
      },
      // SA-11：插件请求降级 → 切 static-gradient（防循环：已是 static 则 noop）
      requestFallback: (reason: string) => {
        if (this.state.currentId === 'static-gradient') return;
        console.warn('[bg] 插件请求降级，切 static-gradient:', reason);
        this.setBackground('static-gradient').catch(() => {});
      },
    };
  }

  /** veil 过渡时长：reduced-motion 下 0ms（直接切换）
   *  待办清理批（批复 2026-11-08「待办执行」）：R2 顺延项 + 方案 C 子项 2 裁决
   *  ——320ms → 200ms，整屏压暗段缩短 37.5%；交叉淡入（消除压暗段本身）
   *  属行为级重构，独立批次另做（见批次报告 §三）。冻结件授权偏离已上报。 */
  private get veilDuration(): number {
    return this.cap.reducedMotion ? 0 : 200;
  }

  /** 首屏选插件：reduced-motion → static-gradient；否则按 fallback chain 第一个能跑的 */
  pickInitial(): string {
    if (this.cap.reducedMotion) return 'static-gradient';
    for (const id of BG_FALLBACK_CHAIN) {
      const p = BG_REGISTRY[id];
      if (p && this.canRun(p)) return id;
    }
    return 'static-gradient';
  }

  /** 能力决策：three- 系插件在 lowEnd / 无 WebGL 时跳过（D 卷预留扩展点，阶段 1 启用） */
  private canRun(p: BGPlugin): boolean {
    if (p.id.startsWith('three-') && (this.cap.lowEnd || !this.cap.hasWebGL)) return false;
    return true;
  }

  // ── 唯一对外切换入口（串行化防抖，D 卷七.2） ──────────────
  async setBackground(id: string): Promise<void> {
    if (this.destroyed || id === this.state.currentId) return;
    if (this.state.pending) { this.state.queued = id; return; }  // 并发请求只记最后一次
    this.state.pending = true;
    this.state.switching = true;
    try {
      await this._doSwitch(id);
      while (this.state.queued) {
        if (this.destroyed) break;   // OPT-A：销毁后不再消费排队切换
        const next = this.state.queued;
        this.state.queued = null;
        // 同 id 跳过：避免切换进行中又收到同 id 请求时冗余 remount
        // （触发器场景：首屏 setBackground 后 IO 初始回调可能回 same-id）
        if (next === this.state.currentId) continue;
        await this._doSwitch(next);
      }
    } finally {
      this.state.pending = false;
      this.state.switching = false;
    }
  }

  private async _doSwitch(id: string) {
    const plugin = BG_REGISTRY[id];
    if (!plugin) throw new Error(`[bg] 未注册的背景: ${id}`);

    const dur = this.veilDuration;
    // 1. 拉起过渡层（盖住旧画面）
    if (dur > 0) {
      this.veil.classList.add('is-active');
      await nextFrame();           // 等一帧让浏览器绘制 veil 起始态
      await delay(dur);            // 等 veil 完全不透明
      if (this.destroyed) {        // OPT-A：切换窗口内被销毁 → 复原 veil 并中止
        this.veil.classList.remove('is-active');
        return;
      }
    }

    // 2. 销毁旧的 + 存快照
    if (this.state.current) {
      const snap = this.state.current.capture?.() ?? null;
      this.state.snapshot.set(this.state.currentId, snap);
      this.state.current.destroy();
      this.stage.innerHTML = '';
    }

    // 3. 挂载新的
    this.state.current = plugin;
    this.state.currentId = id;
    await plugin.mount(this.stage, this.makeCtx());
    if (this.destroyed) {          // OPT-A：mount 期间（可能含动态 import）被销毁 → 立即回收刚挂载插件
      plugin.destroy();
      this.stage.innerHTML = '';
      this.state.current = null;
      return;
    }

    // 4. 恢复快照（切回来时位置不重置）
    const snap = this.state.snapshot.get(id);
    if (snap) plugin.restore?.(snap);

    // 5. 启动
    plugin.start();
    this.slot.dataset.bgCurrent = id;
    this.slot.dataset.bgReady = 'true';

    // 6. 揭开过渡层
    if (dur > 0) {
      this.veil.classList.remove('is-active');
    }
  }

  /** 控制器自身销毁（页面卸载/customBg 接管时） */
  destroy() {
    this.destroyed = true;         // OPT-A：置位后所有在途异步切换自终止
    this.state.queued = null;
    this.state.current?.destroy();
    this.state.current = null;
    this.state.currentId = 'none';
    this.listeners.clear();
    this.globalCleanups.forEach(fn => { try { fn(); } catch {} });
    this.globalCleanups = [];
  }

  /** SA-09：暂停当前背景插件的自动播放动画（pausedMotion 控件调用） */
  pauseCurrent() {
    this.state.current?.pause();
  }

  /** SA-09：恢复当前背景插件 */
  resumeCurrent() {
    if (!this.state.switching) this.state.current?.resume();
  }
}

function nextFrame(): Promise<void> {
  return new Promise(r => requestAnimationFrame(() => r()));
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
