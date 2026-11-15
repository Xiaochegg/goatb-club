'use client';

import { useEffect, useRef } from 'react';

import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';

import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';

/**
 * FxPixelIntro — 像素字坠落 intro（gsap timeline）
 * 来源: Animorio「titolo-che-arriva-a-pixel」(https://animorio.com/animazioni/titolo-che-arriva-a-pixel/)
 * 许可证: Animorio Licenza d'uso（项目内可用可改，禁再分发源码集合）— 详见 fx-library/LICENSES.md
 * 适配:
 * - 原演示为全屏舞台循环（词组自屏幕中心放大 + Bitcount 变量轴点阵字形 + 卡片入画 +
 *   鼠标视差 + 循环退场）；组件化取其核心「字符坠落」，保持源码时序参数：
 *   DROP=0.7s / STAGGER=0.03s / 随机顺序 / CustomEase('0,0,0,1') 落地缓动
 * - 按任务口径统一为「自上方坠落」（源码为上下交替 -100/+100）
 * - Bitcount 变量轴（--forma/--peso）不迁移：站点字体非可变字体；字形由 className 传入（如 font-mc）
 * - pausedMotion=true → 跳过动画直接显示完整文字（直接终态，onComplete 同样回调一次）；
 *   动画播放中切换为 true → kill timeline 并定格终态；一旦终态不再重播
 * - prefers-reduced-motion 与源码 fermo() 行为一致：静态完整文字
 * - 卸载时 kill timeline（ref 清理）；等 document.fonts.ready 再起 timeline（与源码一致），
 *   起播前先隐藏字符防闪现
 * - 无障碍：容器 role="img" + aria-label={text}（使 label 对读屏生效），动画字符 aria-hidden
 */

/* 源码时序参数（animorio source.js 原值） */
const DROP = 0.7; // 每个字符坠落时长（秒）
const STAGGER = 0.03; // 相邻字符（随机序）起落间隔（秒）
const FROM_Y_PERCENT = -130; // 起始位：上方（留 30% 字高余量防裁切）

let easesReady = false;
function ensureEases() {
  // CustomEase 注册一次；模块级单例防同名 ease 重复注册告警
  if (easesReady) return;
  gsap.registerPlugin(CustomEase);
  // 源码 SLOW_DOWN：先快后长刹车的落地手感
  CustomEase.create('fx-pixel-intro-slow-down', '0, 0, 0, 1');
  easesReady = true;
}

/* 源码 mescola：Fisher–Yates 随机顺序 */
function shuffle(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface FxPixelIntroProps {
  text: string;
  className?: string;
  /** 全部字符落位后回调（暂停定格 / reduced-motion 终态时同样回调一次） */
  onComplete?: () => void;
}

export function FxPixelIntro({ text, className, onComplete }: FxPixelIntroProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const doneRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const paused = useAppStore((s) => s.pausedMotion);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const chars = Array.from(root.querySelectorAll<HTMLElement>('[data-fx-intro-char]'));
    if (chars.length === 0) return;

    let cancelled = false;

    // 直接终态：清掉 gsap 内联样式即回到完整文字
    const finishNow = () => {
      tlRef.current?.kill();
      tlRef.current = null;
      gsap.killTweensOf(chars);
      gsap.set(chars, { clearProps: 'all' });
      if (!doneRef.current) {
        doneRef.current = true;
        onCompleteRef.current?.();
      }
    };

    const start = () => {
      if (cancelled || doneRef.current) return;
      ensureEases();
      gsap.set(chars, { yPercent: FROM_Y_PERCENT, opacity: 0 });
      const tl = gsap.timeline({
        onComplete: () => {
          tlRef.current = null;
          doneRef.current = true;
          onCompleteRef.current?.();
        },
      });
      tlRef.current = tl;
      // 源码：随机顺序决定第 i 个字符的起落时刻（一次性 intro，无源码的退场/循环段）
      const order = shuffle(chars.length);
      chars.forEach((el, i) => {
        const t = order[i] * STAGGER;
        tl.to(el, { yPercent: 0, duration: DROP, ease: 'fx-pixel-intro-slow-down' }, t);
        tl.to(el, { opacity: 1, duration: DROP * 0.3, ease: 'power1.out' }, t);
      });
    };

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (paused || reduced) {
      finishNow();
    } else if (!doneRef.current) {
      // 先隐藏防闪现，等字体就绪再起 timeline（与源码 document.fonts.ready 一致）
      gsap.set(chars, { yPercent: FROM_Y_PERCENT, opacity: 0 });
      document.fonts.ready
        .then(() => {
          if (!cancelled) start();
        })
        .catch(() => {
          if (!cancelled) start();
        });
    }

    return () => {
      cancelled = true;
      tlRef.current?.kill();
      tlRef.current = null;
    };
  }, [paused, text]);

  return (
    <span ref={rootRef} role="img" aria-label={text} className={cn('fx-pixel-intro inline-block', className)}>
      {Array.from(text).map((ch, i) => (
        <span
          key={`${i}-${ch}`}
          aria-hidden="true"
          data-fx-intro-char
          className="inline-block will-change-transform"
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ))}
    </span>
  );
}
