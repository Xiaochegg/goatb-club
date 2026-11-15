'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';

/**
 * fireConfetti / FxConfettiButton — 零依赖 DOM 彩带庆祝
 * 来源: CodePen "DOM Confetti (No canvas)" by ChristopherRobison (https://codepen.io/ChristopherRobison/pen/yLOKepY)
 * 许可证: CodePen 默认许可（Pen 未显式声明，默认按 MIT 对待）——商用前需人工复核 fx-library/LICENSES.md
 * 适配:
 * - 改写为 TypeScript + rAF 循环（源码为 setTimeout(20ms) 递归）；物理参数逐项保留
 *   （gravity 0.65 / drag 0.08 / initSpeed 20 / terminalVelocity 4 / flipSpeed 1.5 / 尺寸 5×20 · 10×18）
 * - 金色默认 palette ['#FFD700','#D4AF37','#BF5AF2','#FFFFFF']；背面色由正面色程序化加深派生
 *   （源码为手写 7 组 front/back 色对）
 * - DOM 清理三重保障：①出界或超 6s 寿命逐片移除 ②fireConfetti 返回本波清理器
 *   ③FxConfettiButton 卸载时调用清理器移除未完成元素（记 refs 兜底）
 * - pausedMotion=true → fireConfetti 直接 no-op（读 useAppStore.getState()，命令式调用可生效）
 * - 容器为 body 下 fixed aria-hidden 层（pointer-events:none），源码 500×500 #panel 不再需要；
 *   .glitter 样式改内联，不占用 fx-animations.css（无 keyframes）
 * - 源码 rotateSpeed 为全局单值（CodePen 笔误：所有片共用一个随机值），改为每片随机
 */

const DEFAULT_COLORS = ['#FFD700', '#D4AF37', '#BF5AF2', '#FFFFFF'];
const MAX_PIECES = 160; // 单波上限：DOM 彩带每片是独立元素，防长列表页 DOM 膨胀
const MAX_LIFE_MS = 6000; // 兜底寿命：任何一片存活不超过 6s
const LAYER_Z = '90';

/* 物理参数（source.js confettiParams 原值） */
const PARAMS = {
  initSpeed: 20,
  gravity: 0.65,
  drag: 0.08,
  terminalVelocity: 4,
  flipSpeed: 1.5,
};

interface Confetto {
  el: HTMLDivElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotateSpeed: number;
  randomModifier: number;
  terminal: number;
  front: string;
  back: string;
  born: number;
  view: { w: number; h: number };
}

let pieces: Confetto[] = [];
let layerEl: HTMLDivElement | null = null;
let rafId = 0;
let looping = false;

const rand = (min: number, max: number) => Math.random() * (max - min) + min;

/** 正面色加深 → 背面色（源码手写 front/back 色对的程序化替代） */
function darken(hex: string, k: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

function ensureLayer(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (layerEl?.isConnected) return layerEl;
  layerEl = document.createElement('div');
  layerEl.setAttribute('data-fx-confetti-layer', '');
  layerEl.setAttribute('aria-hidden', 'true');
  const s = layerEl.style;
  s.position = 'fixed';
  s.inset = '0';
  s.overflow = 'hidden';
  s.pointerEvents = 'none';
  s.zIndex = LAYER_Z;
  document.body.appendChild(layerEl);
  return layerEl;
}

function step(now: number) {
  rafId = 0;
  for (const p of pieces) {
    p.vx *= 0.98; // 水平阻尼（源码 update() 原值）
    p.x += p.vx;
    p.vy += p.randomModifier * PARAMS.drag;
    p.vy = Math.min(p.vy + PARAMS.gravity, p.terminal);
    p.y += p.vy;
    p.rotation += p.rotateSpeed * p.randomModifier;
    const flip = Math.cos((p.y + p.randomModifier) * PARAMS.flipSpeed);
    p.el.style.top = `${p.y}px`;
    p.el.style.left = `${p.x}px`;
    p.el.style.transform = `rotate3d(1, 1, 1, ${p.rotation}deg)`;
    p.el.style.backgroundColor = flip > 0 ? p.front : p.back; // 源码：翻面时亮/暗切换
  }
  const expired: Confetto[] = [];
  pieces = pieces.filter((p) => {
    const dead =
      p.y > p.view.h ||
      p.x < p.view.w * -0.5 ||
      p.x > p.view.w * 1.5 ||
      now - p.born > MAX_LIFE_MS;
    if (dead) expired.push(p);
    return !dead;
  });
  for (const p of expired) p.el.remove();
  if (pieces.length > 0) {
    rafId = requestAnimationFrame(step);
  } else {
    looping = false;
  }
}

export interface FireConfettiOptions {
  /** 彩带正面色（背面自动加深派生）；默认金色系 ['#FFD700','#D4AF37','#BF5AF2','#FFFFFF'] */
  colors?: string[];
  /** 单波片数，默认 70，上限 160 */
  count?: number;
  /** 爆发原点（视口坐标 px）；默认视口中上部 */
  origin?: { x: number; y: number };
}

/**
 * 发射一波 DOM 彩带；返回本波清理器（移除该波所有未完成元素）。
 * pausedMotion=true 或 SSR 环境下 no-op（返回空清理器）。
 */
export function fireConfetti(options: FireConfettiOptions = {}): () => void {
  // 站点「暂停动效」开启 → 直接 no-op（终态：无彩带）
  if (useAppStore.getState().pausedMotion) return () => {};
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const host = ensureLayer();
  if (!host) return () => {};

  const colors = options.colors && options.colors.length > 0 ? options.colors : DEFAULT_COLORS;
  const count = Math.max(1, Math.min(options.count ?? 70, MAX_PIECES));
  const origin = options.origin ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
  const view = { w: window.innerWidth, h: window.innerHeight };
  const mine: Confetto[] = [];

  for (let i = 0; i < count; i++) {
    const randomModifier = rand(-1, 1);
    const front = colors[Math.floor(rand(0, colors.length))];
    const el = document.createElement('div');
    const s = el.style;
    s.position = 'absolute';
    s.width = `${rand(5, 20)}px`;
    s.height = `${rand(10, 18)}px`;
    s.backgroundColor = front;
    s.willChange = 'transform, top, left';
    const vx = rand(-PARAMS.initSpeed, PARAMS.initSpeed) * 0.4;
    let vy = rand(-PARAMS.initSpeed, PARAMS.initSpeed);
    if (origin.y <= view.h) vy = -Math.abs(vy); // 源码：原点在视口内必向上爆
    s.top = `${origin.y}px`;
    s.left = `${origin.x}px`;
    const rotate = Math.floor(rand(0, 360));
    s.transform = `rotate3d(1, 1, 1, ${rotate}deg)`;
    host.appendChild(el);
    mine.push({
      el,
      x: origin.x,
      y: origin.y,
      vx,
      vy,
      rotation: rotate,
      rotateSpeed: rand(0.5, 2.5),
      randomModifier,
      terminal: rand(1, 1.5) * PARAMS.terminalVelocity,
      front,
      back: darken(front, 0.5),
      born: performance.now(),
      view,
    });
  }

  pieces.push(...mine);
  if (!looping) {
    looping = true;
    rafId = requestAnimationFrame(step);
  }

  return () => {
    for (const p of mine) {
      const idx = pieces.indexOf(p);
      if (idx >= 0) pieces.splice(idx, 1);
      p.el.remove();
    }
  };
}

export interface FxConfettiButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  children?: ReactNode;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** 彩带发射后回调（被 pausedMotion 拦截时不触发） */
  onFire?: () => void;
  /** fireConfetti 参数（colors / count / origin）；默认以点击坐标为爆发原点 */
  fireOptions?: FireConfettiOptions;
}

export function FxConfettiButton({
  children,
  className,
  disabled,
  onClick,
  onFire,
  fireOptions,
  ...rest
}: FxConfettiButtonProps) {
  const paused = useAppStore((s) => s.pausedMotion);
  const disposerRef = useRef<(() => void) | null>(null);

  // 组件卸载 → 清理本按钮产生的未完成彩带元素（记 refs 兜底）
  useEffect(() => {
    return () => {
      disposerRef.current?.();
      disposerRef.current = null;
    };
  }, []);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!paused && !disabled) {
        disposerRef.current?.(); // 上一波若有残留先清，防 DOM 堆积
        const origin = fireOptions?.origin ?? { x: event.clientX, y: event.clientY };
        disposerRef.current = fireConfetti({ ...fireOptions, origin });
        onFire?.();
      }
      onClick?.(event);
    },
    [paused, disabled, fireOptions, onFire, onClick]
  );

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn('fx-confetti-button cursor-pointer', className)}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  );
}
