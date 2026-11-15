// ============================================================
// three-basic — Three.js 最小验证背景插件（阶段 1 · D 卷 6.x 扩展）
//
// 目的：验证 4GB 沙盒下 Three.js 在 Turbopack dev 的编译与 WebGL 运行
//       稳定性。通过后再升级粒子场/着色器（阶段 1 后续）。
//
// 能力：单个旋转 BoxGeometry + 金属质感材质 + 双灯照明
//       alpha:true 透明背景——主题渐变/pixel-grid 从 canvas 后透出，
//       3D 物体浮在既有背景层之上（与 particles 同层序，不遮内容）。
// 资源：1 个 canvas + 1 个 rAF 循环（与 particles 互斥——D 卷架构同一
//       时刻只有一个插件在跑，全站 rAF 循环数仍为 1，≤2 达标）。
// 守卫：canRun() 在 controller——id 以 'three-' 开头且 lowEnd/无 WebGL
//       时跳过，chain 自动落到 particles（bg-controller.ts L113 实现）。
// 清理：destroy 全量 dispose（geometry/material/renderer）+ cancel rAF
//       + canvas remove，零泄漏。切走再切回场景重建（最小验证不做快照）。
// ============================================================

import type * as THREE_NS from 'three';
import type { BGPlugin, BGCtx, BGEvent, BGEventHandler } from '../bg-types';

// 动态 import：three 拆独立 chunk，仅 mount('three-basic') 时才加载。
// 保住 B 卷「阻塞 JS <100KB」指标——静态 import 会把 ~600KB minified three
// 拉进主 bundle；首屏 lowEnd / 手动选 particles 时完全不下载 three。

// ╔════════ 参数调节区（只调这里，别动渲染逻辑）═════════╗
const CFG = {
  ROT_Y: 0.28,        // 绕 Y 轴旋转速度 rad/s（克制慢转）
  ROT_X: 0.11,        // 绕 X 轴
  FLOAT_AMP: 0.06,    // 上下浮动幅度（世界单位）
  FLOAT_SPEED: 0.6,   // 浮动频率 Hz
  CAM_Z: 3.2,         // 相机距离
  FOV: 50,
  DPR_MAX: 2,
  GOLD: 0xd4af37,     // 站内金色（constants 色板）
} as const;

/** 布局：桌面右上留白区（避开居中标题/榜单）；移动端贴右上角缩更小 */
function layoutFor(w: number): { x: number; y: number; s: number } {
  return w >= 768
    ? { x: 1.55, y: 0.85, s: 0.75 }
    : { x: 0.85, y: 0.95, s: 0.55 };
}
// ╚═════════════════════════════════════════════════════╝

interface TState {
  renderer: THREE_NS.WebGLRenderer;
  scene: THREE_NS.Scene;
  camera: THREE_NS.PerspectiveCamera;
  mesh: THREE_NS.Mesh;
  geometry: THREE_NS.BufferGeometry;
  material: THREE_NS.Material;
  raf: number | null;
  lastT: number;
  running: boolean;
  unsubResize: (() => void) | null;
  W: number;
  H: number;
  layoutBaseY: number;
  // SA-11 故障恢复
  ctx: BGCtx | null;            // requestFallback 用
  ctxLostTimer: ReturnType<typeof setTimeout> | null;  // contextlost 5s 超时降级
  fpsDegraded: boolean;         // fps 降级已触发（防重复）
  fpsLowSince: number;          // 连续低帧起始时间戳（0=未触发）
}

const S: { current: TState | null } = { current: null };

export const threeBasicBg: BGPlugin = {
  id: 'three-basic',
  name: '3D 立方体（Three.js 验证版）',
  version: '0.1.0-min-validation',

  async mount(stage: HTMLElement, ctx: BGCtx): Promise<void> {
    const W = ctx.viewport.w;
    const H = ctx.viewport.h;

    // 按需加载 three chunk（仅选中 three-basic 时下载，保阻塞 JS 指标）
    const THREE = await import('three') as typeof THREE_NS;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,          // 透明：主题渐变透出，3D 物体浮在背景层之上
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.DPR_MAX));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 0.9s ease;';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CFG.FOV, W / H, 0.1, 20);
    camera.position.z = CFG.CAM_Z;

    // 站内色板线框质感：金色线框立方体——经典克制高级 3D 装饰，
    // 不遮挡内容（阶段 1 VLM 实测：实心大物体压标题区严重干扰阅读，故线框化+缩位）
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: CFG.GOLD,
      metalness: 0.55,
      roughness: 0.38,
      wireframe: true,
    });
    const mesh = new THREE.Mesh(geometry, material);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 3, 4);
    const rim = new THREE.DirectionalLight(0x2ecc71, 0.9); // 玉绿轮廓光
    rim.position.set(-3, -1.5, -2.5);
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);

    scene.add(mesh, key, rim, ambient);

    // 初始姿态：微微倾斜比正对更有体积感；位置按视口宽度贴右上留白
    mesh.rotation.set(0.42, 0.66, 0);
    const lay0 = layoutFor(W);
    mesh.position.set(lay0.x, lay0.y, 0);
    mesh.scale.setScalar(lay0.s);

    stage.appendChild(renderer.domElement);

    const state: TState = {
      renderer, scene, camera, mesh, geometry, material,
      raf: null, lastT: 0, running: false,
      unsubResize: null, W, H,
      layoutBaseY: lay0.y,
      ctx: ctx,
      ctxLostTimer: null,
      fpsDegraded: false,
      fpsLowSince: 0,
    };
    S.current = state;

    // SA-11 故障恢复：WebGL 上下文丢失 → preventDefault + 停帧 + 5s 超时降级
    // （Three.js 对象随 context 失效，无法安全恢复 → 5s 后切 static-gradient）
    const onContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('[three-bg] WebGL 上下文丢失，5s 后降级到 static-gradient');
      state.running = false;
      if (state.raf !== null) { cancelAnimationFrame(state.raf); state.raf = null; }
      if (state.ctxLostTimer) clearTimeout(state.ctxLostTimer);
      state.ctxLostTimer = setTimeout(() => {
        state.ctx?.requestFallback?.('webgl-contextlost');
      }, 5000);
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
    // 把清理挂到 state 供 destroy 调用
    (state as TState & { _onContextLost?: (e: Event) => void })._onContextLost = onContextLost;

    // resize 适配（ctx 托管，destroy 时 unsubscribe）
    const onResize: BGEventHandler = (data) => {
      if (!S.current) return;
      const w = data.viewport?.w ?? window.innerWidth;
      const h = data.viewport?.h ?? window.innerHeight;
      state.W = w; state.H = h;
      state.camera.aspect = w / h;
      state.camera.updateProjectionMatrix();
      state.renderer.setSize(w, h);
      const lay = layoutFor(w);
      state.mesh.position.x = lay.x;
      state.mesh.scale.setScalar(lay.s);
      state.layoutBaseY = lay.y;
    };
    state.unsubResize = ctx.on('resize', onResize);

    // 淡入
    requestAnimationFrame(() => {
      renderer.domElement.style.opacity = '1';
    });
  },

  start(): void {
    const st = S.current;
    if (!st || st.running) return;
    st.running = true;
    st.lastT = performance.now();
    const loop = (t: number) => {
      if (!S.current) return;
      st.raf = requestAnimationFrame(loop);
      const dt = Math.min((t - st.lastT) / 1000, 0.1); // 刷新率无关，防后台大步进
      st.lastT = t;
      st.mesh.rotation.y += CFG.ROT_Y * dt;
      st.mesh.rotation.x += CFG.ROT_X * dt;
      st.mesh.position.y = st.layoutBaseY + Math.sin(t * 0.001 * CFG.FLOAT_SPEED * Math.PI * 2) * CFG.FLOAT_AMP;
      st.renderer.render(st.scene, st.camera);

      // SA-11 故障恢复：fps 监控——连续 3s <45fps → 降 DPR 到 1（防 GPU 降频卡顿）
      // dt>0 时 fps≈1/dt；dt=0（同帧）跳过。仅降级一次（fpsDegraded 防重复）
      if (!st.fpsDegraded && dt > 0) {
        const fps = 1 / dt;
        if (fps < 45) {
          if (st.fpsLowSince === 0) st.fpsLowSince = t;
          else if (t - st.fpsLowSince >= 3000) {
            st.renderer.setPixelRatio(1);
            st.fpsDegraded = true;
            console.warn('[three-bg] 连续 3s 低帧率，已降 DPR 到 1');
          }
        } else {
          st.fpsLowSince = 0;
        }
      }
    };
    st.raf = requestAnimationFrame(loop);
  },

  pause(): void {
    const st = S.current;
    if (!st || !st.running) return;
    st.running = false;
    if (st.raf !== null) {
      cancelAnimationFrame(st.raf);
      st.raf = null;
    }
  },

  resume(): void {
    const st = S.current;
    if (!st || st.running) return;
    this.start();
  },

  destroy(): void {
    const st = S.current;
    if (!st) return;
    S.current = null;
    st.running = false;
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    // SA-11：清理 contextlost 监听 + 超时定时器
    if (st.ctxLostTimer) clearTimeout(st.ctxLostTimer);
    const onLost = (st as TState & { _onContextLost?: (e: Event) => void })._onContextLost;
    if (onLost) st.renderer.domElement.removeEventListener('webglcontextlost', onLost, false);
    st.unsubResize?.();
    st.geometry.dispose();
    st.material.dispose();
    st.renderer.dispose();
    st.renderer.domElement.remove();
  },
};
