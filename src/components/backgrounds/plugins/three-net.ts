// ============================================================
// three-net — 点云连线背景插件（Vanta「NET」等效复刻 · FX-07 集成）
//
// 来源：fx-library/effects/vanta/vanta-net（MIT，npm registry 字段）
//       原版锁 three r134 + 独立 rAF/renderer 不可直接引入（DEPENDENCIES 结论①），
//       本插件按 BGPlugin 契约复刻：复用项目 three ^0.186.1 单实例，
//       与 three-basic/particles 同层序（D 卷架构同一时刻只有一个插件在跑，
//       全站 rAF 循环数仍为 1，≤2 达标）。
//
// 能力：N 点随机 3D 布点 + 漂移反弹 + O(n²) 近距连线（近亮远暗金）
//       + 指针视差相机摆动 + 主题 accent 联动（点色跟随赛季主题）
// 资源：1 个 canvas + 1 个 rAF（canRun 阶段被 controller 拦截 lowEnd/无 WebGL）
// 降级：reduced-motion → 静态一帧（连线仍可见，不空白）；
//       contextlost → 5s 未恢复 requestFallback 切 static-gradient；
//       连续 3s <45fps → DPR 降到 1；移动端点数 56 / 桌面 96
// 清理：destroy 全量 dispose + cancel rAF + 移除 window 监听 + canvas remove
// ============================================================

import type * as THREE_NS from 'three';
import type { BGPlugin, BGCtx } from '../bg-types';
import { useAppStore } from '@/lib/store';
import { THEME_PRESETS } from '@/lib/constants';

// ╔════════ 参数调节区（只调这里，别动渲染逻辑）═════════╗
const CFG = {
  POINTS_DESKTOP: 96,
  POINTS_MOBILE: 56,
  MAX_DIST: 1.35,       // 世界单位连线阈值（对应 vanta maxDistance≈22）
  DRIFT: 0.12,          // 点漂移速度（世界单位/s 量级）
  CAM_SWING: 0.35,      // 相机随鼠标摆动幅度
  CAM_SWING_TOUCH: 0.2, // 触屏设备摆幅收小（滚动时 pointermove 也会触发）
  CAM_LERP: 0.04,       // 相机跟随插值
  BOUND_X: 4, BOUND_Y: 3, BOUND_Z: 2.2, // 漂移软边界（z 收窄防贴近相机）
  MAX_LINES: 480,       // 连线缓冲上限（96 点约可出 200-400 条）
  FOV: 60, CAM_Z: 5,
  DPR_MAX: 2,
  GOLD: 0xd4af37,
  JADE: 0x2ecc71,
  POINT_SIZE: 0.055,
  LINE_OPACITY: 0.5,
  GOLD_RATIO: 0.12,     // 金色点占比
  JADE_RATIO: 0.06,     // 玉绿点占比（其余为主题 accent 色）
} as const;
// ╚═════════════════════════════════════════════════════╝

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface NState {
  renderer: THREE_NS.WebGLRenderer | null;
  scene: THREE_NS.Scene | null;
  camera: THREE_NS.PerspectiveCamera | null;
  ptsGeo: THREE_NS.BufferGeometry | null;
  lineGeo: THREE_NS.BufferGeometry | null;
  ptsMat: THREE_NS.PointsMaterial | null;
  lineMat: THREE_NS.LineBasicMaterial | null;
  posAttr: THREE_NS.BufferAttribute | null;
  colAttr: THREE_NS.BufferAttribute | null;
  vel: Float32Array;
  linePos: Float32Array;
  lineCol: Float32Array;
  // 每点颜色类别：0=主题 accent（跟随赛季主题） 1=金 2=玉绿
  colorClass: Uint8Array;
  accent: string;
  raf: number | null;
  lastT: number;
  running: boolean;
  reduced: boolean;
  coarse: boolean;
  mx: number; my: number;
  unsubCtx: Array<() => void>;
  unsubStore: () => void;
  onMove: ((e: PointerEvent) => void) | null;
  ctx: BGCtx | null;
  ctxLostTimer: ReturnType<typeof setTimeout> | null;
  fpsDegraded: boolean;
  fpsLowSince: number;
}

export function createNetBg(): BGPlugin {
  const S: NState = {
    renderer: null, scene: null, camera: null,
    ptsGeo: null, lineGeo: null, ptsMat: null, lineMat: null,
    posAttr: null, colAttr: null,
    vel: new Float32Array(0), linePos: new Float32Array(0), lineCol: new Float32Array(0),
    colorClass: new Uint8Array(0),
    accent: '#BF5AF2',
    raf: null, lastT: 0, running: false,
    reduced: false, coarse: false,
    mx: 0, my: 0,
    unsubCtx: [], unsubStore: () => {}, onMove: null,
    ctx: null, ctxLostTimer: null,
    fpsDegraded: false, fpsLowSince: 0,
  };

  function pointCount(): number {
    return S.coarse ? CFG.POINTS_MOBILE : CFG.POINTS_DESKTOP;
  }

  /** 构建/重建每点颜色（accent 变化只改类别 0 的色值，不重建粒子） */
  function paintColors(): void {
    if (!S.colAttr) return;
    const arr = S.colAttr.array as Float32Array;
    const a = hexToRgb(S.accent);
    const g = hexToRgb('#D4AF37');
    const j = hexToRgb('#2ECC71');
    for (let i = 0; i < S.colorClass.length; i++) {
      const c = S.colorClass[i] === 0 ? a : S.colorClass[i] === 1 ? g : j;
      arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
    }
    S.colAttr.needsUpdate = true;
  }

  /** 一帧模拟 + 连线 + 渲染（reduced-motion 静态帧也走这里，dt=0） */
  function frame(t: number, dt: number): void {
    if (!S.renderer || !S.scene || !S.camera || !S.posAttr) return;
    const p = S.posAttr.array as Float32Array;
    const bounds = [CFG.BOUND_X, CFG.BOUND_Y, CFG.BOUND_Z];
    if (dt > 0) {
      for (let i = 0; i < p.length; i++) {
        p[i] += S.vel[i] * dt;
        const b = bounds[i % 3];
        if (p[i] > b || p[i] < -b) S.vel[i] *= -1;  // 软边界反弹
      }
      S.posAttr.needsUpdate = true;
    }
    // 连线：O(n²) 距离比较（n≤96 ≈ 4.5k 次/帧，桌面可接受；移动端 n=56 减半）
    const L = S.linePos, C = S.lineCol;
    const n = pointCount();
    let li = 0;
    const cGold = [0.83, 0.69, 0.22], cDim = [0.34, 0.27, 0.08];
    const max2 = CFG.MAX_DIST * CFG.MAX_DIST;
    for (let i = 0; i < n && li < CFG.MAX_LINES * 6; i++) {
      for (let j = i + 1; j < n && li < CFG.MAX_LINES * 6; j++) {
        const dx = p[i * 3] - p[j * 3], dy = p[i * 3 + 1] - p[j * 3 + 1], dz = p[i * 3 + 2] - p[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < max2) {
          L[li] = p[i * 3]; L[li + 1] = p[i * 3 + 1]; L[li + 2] = p[i * 3 + 2];
          L[li + 3] = p[j * 3]; L[li + 4] = p[j * 3 + 1]; L[li + 5] = p[j * 3 + 2];
          const f = 1 - Math.sqrt(d2) / CFG.MAX_DIST;  // 近亮远暗
          const r = cGold[0] * f + cDim[0] * (1 - f);
          const g = cGold[1] * f + cDim[1] * (1 - f);
          const b = cGold[2] * f + cDim[2] * (1 - f);
          C[li] = r; C[li + 1] = g; C[li + 2] = b;
          C[li + 3] = r; C[li + 4] = g; C[li + 5] = b;
          li += 6;
        }
      }
    }
    if (S.lineGeo) {
      const lp = S.lineGeo.getAttribute('position') as THREE_NS.BufferAttribute;
      const lc = S.lineGeo.getAttribute('color') as THREE_NS.BufferAttribute;
      lp.needsUpdate = true;
      lc.needsUpdate = true;
      S.lineGeo.setDrawRange(0, li / 3);
    }
    // 指针视差：相机轻移（reduced-motion 已在 start 处拦截，不进 loop）
    if (S.camera) {
      const swing = S.coarse ? CFG.CAM_SWING_TOUCH : CFG.CAM_SWING;
      S.camera.position.x += (S.mx * swing - S.camera.position.x) * CFG.CAM_LERP;
      S.camera.position.y += (-S.my * swing - S.camera.position.y) * CFG.CAM_LERP;
      S.camera.lookAt(0, 0, 0);
    }
    S.renderer.render(S.scene, S.camera);
  }

  const plugin: BGPlugin = {
    id: 'three-net',
    name: '点云连线（金网 · Vanta NET 复刻）',
    version: '1.0.0',

    async mount(stage: HTMLElement, ctx: BGCtx): Promise<void> {
      const THREE = await import('three') as typeof THREE_NS;  // 复用项目 three 单实例（动态 chunk）
      const W = ctx.viewport.w, H = ctx.viewport.h;

      const renderer = new THREE.WebGLRenderer({
        alpha: true,           // 透明背景：主题渐变透出
        antialias: true,
        powerPreference: 'low-power',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.DPR_MAX));
      renderer.setSize(W, H);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 0.9s ease;';
      stage.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(CFG.FOV, W / H, 0.1, 100);
      camera.position.z = CFG.CAM_Z;

      // ---- 点云 ----
      const n = window.matchMedia('(pointer: coarse)').matches ? CFG.POINTS_MOBILE : CFG.POINTS_DESKTOP;
      const pos = new Float32Array(n * 3);
      S.vel = new Float32Array(n * 3);
      S.colorClass = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 2 * CFG.BOUND_X;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 2 * CFG.BOUND_Y;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 2 * CFG.BOUND_Z;
        const sp = (Math.random() - 0.5) * CFG.DRIFT;
        S.vel[i * 3] = sp;
        S.vel[i * 3 + 1] = (Math.random() - 0.5) * CFG.DRIFT;
        S.vel[i * 3 + 2] = (Math.random() - 0.5) * CFG.DRIFT * 0.6;
        const r = Math.random();
        S.colorClass[i] = r < CFG.JADE_RATIO ? 2 : r < CFG.JADE_RATIO + CFG.GOLD_RATIO ? 1 : 0;
      }
      const ptsGeo = new THREE.BufferGeometry();
      ptsGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      ptsGeo.setAttribute('color', colAttr);
      const ptsMat = new THREE.PointsMaterial({
        vertexColors: true, size: CFG.POINT_SIZE, sizeAttenuation: true,
        transparent: true, opacity: 0.9, depthWrite: false,
      });
      scene.add(new THREE.Points(ptsGeo, ptsMat));

      // ---- 连线（每帧重写 draw range）----
      const linePos = new Float32Array(CFG.MAX_LINES * 6);
      const lineCol = new Float32Array(CFG.MAX_LINES * 6);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: CFG.LINE_OPACITY, depthWrite: false,
      });
      scene.add(new THREE.LineSegments(lineGeo, lineMat));

      Object.assign(S, {
        renderer, scene, camera, ptsGeo, lineGeo, ptsMat, lineMat,
        posAttr: ptsGeo.getAttribute('position') as THREE_NS.BufferAttribute,
        colAttr,
        linePos, lineCol,
        reduced: ctx.reducedMotion,
        coarse: window.matchMedia('(pointer: coarse)').matches,
        accent: THEME_PRESETS[useAppStore.getState().theme].accent,
        ctx,
      });
      paintColors();

      // ---- 赛季主题联动：accent 变化只重涂点色，不重建点云 ----
      S.unsubStore = useAppStore.subscribe((st) => {
        const a = THEME_PRESETS[st.theme].accent;
        if (a !== S.accent) { S.accent = a; paintColors(); }
      });

      // ---- 指针视差（window 级，destroy 移除；reduced-motion 不挂） ----
      if (!ctx.reducedMotion) {
        S.onMove = (e: PointerEvent) => {
          S.mx = (e.clientX / Math.max(W, 1)) * 2 - 1;
          S.my = (e.clientY / Math.max(H, 1)) * 2 - 1;
        };
        window.addEventListener('pointermove', S.onMove, { passive: true });
      }

      // ---- ctx 事件（控制器托管，destroy 自动失效）----
      S.unsubCtx.push(
        ctx.on('resize', (d) => {
          if (!d.viewport || !S.renderer || !S.camera) return;
          S.renderer.setSize(d.viewport.w, d.viewport.h);
          S.camera.aspect = d.viewport.w / d.viewport.h;
          S.camera.updateProjectionMatrix();
        }),
        ctx.on('reducedMotion', (d) => {
          S.reduced = !!d.reduced;
          if (S.reduced) {
            plugin.pause();  // 停在当前帧（画面冻结，不清空）
          } else {
            plugin.resume();
          }
        }),
      );

      // ---- SA-11 故障恢复：contextlost → preventDefault + 停帧 + 5s 超时降级 ----
      const onContextLost = (e: Event) => {
        e.preventDefault();
        console.warn('[three-net] WebGL 上下文丢失，5s 后降级到 static-gradient');
        plugin.pause();
        if (S.ctxLostTimer) clearTimeout(S.ctxLostTimer);
        S.ctxLostTimer = setTimeout(() => {
          S.ctx?.requestFallback?.('webgl-contextlost');
        }, 5000);
      };
      renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
      S.unsubCtx.push(() => {
        if (S.renderer) S.renderer.domElement.removeEventListener('webglcontextlost', onContextLost, false);
      });

      // reduced-motion：渲染一帧静态网图（连线已计算，画面不空白）
      if (ctx.reducedMotion) {
        frame(performance.now(), 0);
      }

      // 淡入
      requestAnimationFrame(() => {
        renderer.domElement.style.opacity = '1';
      });
    },

    start(): void {
      if (S.running || S.reduced || !S.renderer) return;
      S.running = true;
      S.lastT = performance.now();
      const loop = (t: number) => {
        if (!S.running) return;
        S.raf = requestAnimationFrame(loop);
        const dt = Math.min((t - S.lastT) / 1000, 0.05);  // 防后台大步进
        S.lastT = t;
        frame(t, dt);

        // SA-11 故障恢复：连续 3s <45fps → DPR 降到 1（仅一次）
        if (!S.fpsDegraded && dt > 0) {
          const fps = 1 / dt;
          if (fps < 45) {
            if (S.fpsLowSince === 0) S.fpsLowSince = t;
            else if (t - S.fpsLowSince >= 3000) {
              S.renderer?.setPixelRatio(1);
              S.fpsDegraded = true;
              console.warn('[three-net] 连续 3s 低帧率，已降 DPR 到 1');
            }
          } else {
            S.fpsLowSince = 0;
          }
        }
      };
      S.raf = requestAnimationFrame(loop);
    },

    pause(): void {
      S.running = false;
      if (S.raf !== null) { cancelAnimationFrame(S.raf); S.raf = null; }
    },

    resume(): void {
      if (!S.running && !S.reduced) this.start();
    },

    destroy(): void {
      plugin.pause();
      if (S.ctxLostTimer) { clearTimeout(S.ctxLostTimer); S.ctxLostTimer = null; }
      S.unsubCtx.forEach(off => { try { off(); } catch { /* noop */ } });
      S.unsubCtx = [];
      try { S.unsubStore(); } catch { /* noop */ }
      if (S.onMove) {
        window.removeEventListener('pointermove', S.onMove);
        S.onMove = null;
      }
      S.ptsGeo?.dispose();
      S.lineGeo?.dispose();
      S.ptsMat?.dispose();
      S.lineMat?.dispose();
      S.renderer?.dispose();
      S.renderer?.domElement.remove();
      S.renderer = null; S.scene = null; S.camera = null;
      S.ptsGeo = null; S.lineGeo = null; S.ptsMat = null; S.lineMat = null;
      S.posAttr = null; S.colAttr = null;
      S.ctx = null;
      S.fpsDegraded = false; S.fpsLowSince = 0;
    },
  };

  return plugin;
}

/** registry 单例（D 卷架构：同一时刻只有一个插件实例在跑） */
export const threeNetBg: BGPlugin = createNetBg();
