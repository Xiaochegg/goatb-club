// ============================================================
// particles-bg — 尘埃粒子背景插件（C 卷效果，D 卷插件化）
//
// 能力：Canvas 2D 尘埃粒子 + 呼吸光斑 + 差速视差 + 底部收尾衰减
// 资源：1 个 canvas + 1 个 rAF + ctx 事件订阅（resize/visibility/reducedMotion）
// 快照：capture/restore 粒子数组，切走再切回位置不重置
// 主题：订阅 useAppStore，accent 变化只换色不重建粒子
// 降级：reduced-motion→静态一帧；低端机→粒子减半+光斑关；移动端→低密度
// ============================================================

import type { BGPlugin, BGCtx, BGSnapshot } from '../bg-types';
import { useAppStore } from '@/lib/store';
import { THEME_PRESETS } from '@/lib/constants';

// ╔══════════════ 参数调节区（只调这里，别动绘制逻辑）═════════════╗
const BG_CONFIG = {
  DENSITY_DESKTOP: 22000,   // 桌面每 N px² 一粒；调小变密
  DENSITY_MOBILE: 9000,     // 移动端密度
  RADIUS_MIN: 0.6,
  RADIUS_MAX: 2.1,
  SPEED_MIN: 0.05,          // 上浮速度 px/16.7ms，按 dt 缩放与刷新率无关
  SPEED_MAX: 0.2,
  ALPHA_MIN: 0.1,
  ALPHA_MAX: 0.38,
  PARALLAX: 0.22,           // 视差总强度；0=关视差
  GLOW_COUNT: 5,            // 光斑数；移动端/低端机自动 0
  GLOW_R_MIN: 160,
  GLOW_R_MAX: 420,
  GLOW_ALPHA: 0.07,
  BOTTOM_FADE: 0.25,        // 滚到底亮度剩多少
  FADE_MS: 900,             // canvas 淡入时长
  DPR_MAX: 2,
  GOLD: '#D4AF37',
  JADE: '#2ECC71',
} as const;
// ╚═══════════════════════════════════════════════════════════════╝

const TAU = Math.PI * 2;

interface RGB { r: number; g: number; b: number }
interface Particle {
  x: number; y: number; r: number;
  vy: number;
  driftPhase: number; driftSpeed: number; driftAmp: number;
  depth: number; alpha: number; colorIdx: number;
}
interface GlowOrb {
  x: number; y: number; r: number;
  depth: number; phase: number; speed: number; alpha: number; colorIdx: number;
}

interface PState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  W: number; H: number; docH: number;
  particles: Particle[];
  glows: GlowOrb[];
  palette: RGB[];
  paletteStrings: string[];
  accent: string;
  raf: number;
  last: number;
  reduced: boolean;
  coarse: boolean;
  lowEnd: boolean;
  ready: boolean;
  offs: Array<() => void>;   // ctx.on 返回的 unsubscribe
  unsubStore: () => void;
}

let S: PState | null = null;

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function wrap(v: number, range: number): number {
  return ((v % range) + range) % range;
}

function refreshPalette() {
  if (!S) return;
  S.palette = [hexToRgb(S.accent), hexToRgb(BG_CONFIG.GOLD), hexToRgb(BG_CONFIG.JADE)];
  S.paletteStrings = S.palette.map(c => `rgb(${c.r},${c.g},${c.b})`);
}

function seed() {
  if (!S) return;
  const C = BG_CONFIG;
  const mobileLike = S.coarse || S.W < 640;
  const density = mobileLike ? C.DENSITY_MOBILE : C.DENSITY_DESKTOP;
  let count = Math.max(8, Math.round((S.W * S.H) / density));
  if (S.lowEnd) count = Math.round(count / 2);
  if (S.reduced) count = Math.min(count, 40);
  S.particles = Array.from({ length: count }, () => ({
    x: Math.random() * S.W,
    y: Math.random() * (S.H + 8) - 4,
    r: C.RADIUS_MIN + Math.random() * (C.RADIUS_MAX - C.RADIUS_MIN),
    vy: C.SPEED_MIN + Math.random() * (C.SPEED_MAX - C.SPEED_MIN),
    driftPhase: Math.random() * TAU,
    driftSpeed: 0.00015 + Math.random() * 0.00035,
    driftAmp: 4 + Math.random() * 14,
    depth: 0.25 + Math.random() * 0.75,
    alpha: C.ALPHA_MIN + Math.random() * (C.ALPHA_MAX - C.ALPHA_MIN),
    colorIdx: Math.floor(Math.random() * S.palette.length),
  }));
  const glowCount = mobileLike || S.lowEnd ? 0 : C.GLOW_COUNT;
  S.glows = Array.from({ length: glowCount }, (_, i) => ({
    x: Math.random() * S.W,
    y: Math.random() * S.H,
    r: C.GLOW_R_MIN + Math.random() * (C.GLOW_R_MAX - C.GLOW_R_MIN),
    depth: 0.05 + Math.random() * 0.07,
    phase: Math.random() * TAU,
    speed: 0.00008 + Math.random() * 0.00012,
    alpha: C.GLOW_ALPHA * (0.7 + Math.random() * 0.6),
    colorIdx: i % S.palette.length,
  }));
}

function resize(w: number, h: number) {
  if (!S) return;
  const dpr = Math.min(window.devicePixelRatio || 1, BG_CONFIG.DPR_MAX);
  S.W = w; S.H = h;
  S.canvas.width = Math.round(w * dpr);
  S.canvas.height = Math.round(h * dpr);
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seed();
  S.docH = Math.max(document.documentElement.scrollHeight, 1);
  if (S.reduced) draw(performance.now(), window.scrollY, 1);
}

function draw(t: number, sy: number, dt: number) {
  if (!S) return;
  const C = BG_CONFIG;
  const maxScroll = Math.max(S.docH - S.H, 1);
  const progress = Math.min(Math.max(sy, 0) / maxScroll, 1);
  const globalFade = 1 - C.BOTTOM_FADE * Math.pow(progress, 1.5);

  S.ctx.clearRect(0, 0, S.W, S.H);

  for (const g of S.glows) {
    const gx = g.x + Math.cos(t * g.speed * 0.8 + g.phase) * 18;
    const gy = wrap(g.y + Math.sin(t * g.speed + g.phase) * 24 - sy * g.depth * C.PARALLAX, S.H + g.r * 2) - g.r;
    const a = g.alpha * (0.7 + 0.3 * Math.sin(t * g.speed * 1.3 + g.phase)) * globalFade;
    if (a <= 0.004) continue;
    const c = S.palette[g.colorIdx];
    const grad = S.ctx.createRadialGradient(gx, gy, 0, gx, gy, g.r);
    grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${a.toFixed(4)})`);
    grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    S.ctx.fillStyle = grad;
    S.ctx.fillRect(gx - g.r, gy - g.r, g.r * 2, g.r * 2);
  }

  for (const p of S.particles) {
    p.y -= p.vy * dt;
    if (p.y < -4) p.y += S.H + 8;
    const px = p.x + Math.sin(t * p.driftSpeed + p.driftPhase) * p.driftAmp;
    const py = wrap(p.y - sy * p.depth * C.PARALLAX, S.H + 8) - 4;
    S.ctx.globalAlpha = p.alpha * globalFade;
    S.ctx.fillStyle = S.paletteStrings[p.colorIdx];
    S.ctx.beginPath();
    S.ctx.arc(px, py, p.r, 0, TAU);
    S.ctx.fill();
  }
  S.ctx.globalAlpha = 1;
}

function loop(t: number) {
  if (!S) { return; }
  S.raf = requestAnimationFrame(loop);
  const dt = Math.min(Math.max((t - S.last) / 16.667, 0.25), 2.5);
  S.last = t;
  draw(t, window.scrollY, dt);
}

function startLoop() {
  if (!S || S.raf || S.reduced) return;
  S.last = performance.now();
  S.raf = requestAnimationFrame(loop);
}

function stopLoop() {
  if (!S) return;
  if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
}

export const particlesBg: BGPlugin = {
  id: 'particles',
  name: '尘埃粒子',
  version: '1.0.0',

  async mount(stage: HTMLElement, ctx: BGCtx) {
    const canvas = document.createElement('canvas');
    canvas.className = 'site-bg-canvas';
    canvas.style.cssText = 'width:100%;height:100%;display:block;opacity:0;transition:opacity 900ms ease;';
    stage.appendChild(canvas);

    let ctx2d: CanvasRenderingContext2D | null = null;
    try { ctx2d = canvas.getContext('2d'); } catch { ctx2d = null; }
    if (!ctx2d) throw new Error('canvas 2d unavailable');

    const accent = THEME_PRESETS[useAppStore.getState().theme].accent;
    S = {
      canvas, ctx: ctx2d, W: 0, H: 0, docH: 1,
      particles: [], glows: [], palette: [], paletteStrings: [],
      accent, raf: 0, last: 0,
      reduced: ctx.reducedMotion,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      lowEnd: ctx.isLowEnd,
      ready: false,
      offs: [],
      unsubStore: () => {},
    };

    // 主题联动：accent 变化只换色不重建粒子
    S.unsubStore = useAppStore.subscribe((st) => {
      const a = THEME_PRESETS[st.theme].accent;
      if (S && a !== S.accent) { S.accent = a; refreshPalette(); }
    });

    // ctx 事件（控制器托管，destroy 时自动失效）
    S.offs.push(ctx.on('resize', (d) => { if (d.viewport && S) resize(d.viewport.w, d.viewport.h); }));
    S.offs.push(ctx.on('visibility', (d) => { if (d.hidden) stopLoop(); else if (S && !S.reduced) startLoop(); }));
    S.offs.push(ctx.on('reducedMotion', (d) => {
      if (!S) return;
      S.reduced = !!d.reduced;
      stopLoop();
      if (S.reduced) draw(performance.now(), window.scrollY, 1);
      else startLoop();
    }));

    refreshPalette();
    resize(ctx.viewport.w, ctx.viewport.h);
    // 起始帧用 initialScrollY 避免跳变
    if (S.reduced) draw(performance.now(), ctx.initialScrollY, 1);
    S.ready = true;
    // 淡入
    requestAnimationFrame(() => { if (S) S.canvas.style.opacity = '1'; });
  },

  start() { if (S && !S.reduced) startLoop(); },
  pause() { stopLoop(); },
  resume() { if (S && !S.reduced) startLoop(); },

  destroy() {
    if (!S) return;
    stopLoop();
    S.offs.forEach(off => { try { off(); } catch {} });
    S.unsubStore();
    S.canvas.remove();
    S = null;
  },

  capture(): BGSnapshot {
    if (!S) return {};
    return {
      particles: S.particles,
      glows: S.glows,
      accent: S.accent,
    };
  },

  restore(snap: BGSnapshot) {
    if (!S) return;
    if (Array.isArray(snap.particles)) S.particles = snap.particles as Particle[];
    if (Array.isArray(snap.glows)) S.glows = snap.glows as GlowOrb[];
    if (typeof snap.accent === 'string' && snap.accent !== S.accent) {
      S.accent = snap.accent;
      refreshPalette();
    }
  },

  configSchema: [
    { key: 'density', label: '密度', type: 'number', default: 22000, min: 5000, max: 60000 },
    { key: 'speed', label: '速度', type: 'number', default: 1.0, min: 0.1, max: 3 },
    { key: 'parallax', label: '视差强度', type: 'number', default: 0.22, min: 0, max: 0.6 },
    { key: 'accent', label: '主色', type: 'color', default: '#BF5AF2' },
  ],
};
