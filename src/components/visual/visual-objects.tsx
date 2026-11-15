'use client';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 视觉对象渲染器
// ------------------------------------------------------------
// VisualBox：六类对象（AVATAR/PROFILE_CARD/RANK_BADGE/STATS_CARD/
// BACKGROUND/FLOATING_PANEL）的统一包装器 =
//   外层（形状+尺寸+位移+图层+交互）→ 内层（十效果入场动画）
//   → 装饰层（扫光/扫描线/轨道环/粒子/揭幕光缘）
// 触发方式：AUTO/DELAYED/SEQUENCE(时间轴)/SCROLL 自动；
// CLICK/HOVER/TOGGLE 手动（HOVER 自动附带 CLICK——移动端触摸可用）。
// 时间轴：resolved.timeline 中以对象为目标的片段覆写 delay/duration。
// 性能：STATIC/LITE 不渲染环境层；粒子数量随 perf 分级递减。
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useVisualStage } from './visual-stage';
import type {
  Direction, EffectKey, EventKey, ObjectTarget, ResolvedObjectVisual, ResolvedVisualConfig,
} from '@/lib/visual/types';

// ── 效果 → CSS 动画类 ──
const EFFECT_CLASS: Record<EffectKey, string> = {
  PRISM: 'vx-prism',
  PORTAL: 'vx-portal',
  HOLOGRAM: 'vx-hologram',
  AURORA: 'vx-aurora',
  ORBIT: 'vx-orbit',
  PARTICLE: 'vx-particle-body',
  LIQUID: 'vx-liquid',
  DIMENSION: 'vx-dimension',
  REVEAL: 'vx-reveal',
  PHOTON: 'vx-photon',
};

// ── 方向 → CSS 变量（PORTAL 原点 / REVEAL 揭幕起点 / DIMENSION 翻转轴 / PHOTON 扫向）──
function directionVars(effect: EffectKey, dir: Direction, intensity: number): React.CSSProperties {
  const k = Math.max(0.2, intensity / 100);
  switch (effect) {
    case 'PORTAL': {
      const origin = dir === 'up' ? '50% 0%' : dir === 'down' ? '50% 100%'
        : dir === 'left' ? '0% 50%' : dir === 'right' ? '100% 50%' : '50% 50%';
      return { '--vx-origin': origin } as React.CSSProperties;
    }
    case 'REVEAL': {
      const inset = dir === 'left' ? '0 100% 0 0' : dir === 'right' ? '0 0 0 100%'
        : dir === 'up' ? '100% 0 0 0' : dir === 'down' ? '0 0 100% 0' : '0 50% 0 50%';
      return { '--vx-inset': inset } as React.CSSProperties;
    }
    case 'DIMENSION':
      return { '--vx-rot': `${(dir === 'left' ? 1 : dir === 'right' ? -1 : dir === 'up' ? 1 : -1) * (35 + 25 * k)}deg` } as React.CSSProperties;
    case 'PHOTON':
      return { '--vx-ph': dir === 'right' ? 1 : -1 } as React.CSSProperties;
    default:
      return {};
  }
}

// ── 尺寸档位 → 具体值（AVATAR/RANK_BADGE 固定方寸；卡片类流式 + CUSTOM）──
const SIZE_AVATAR: Record<string, number> = { XS: 36, S: 44, M: 56, L: 72, XL: 96 };
const SIZE_BADGE: Record<string, number> = { XS: 26, S: 32, M: 40, L: 48, XL: 60 };

function shapeStyle(cfg: ResolvedObjectVisual): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (cfg.shape === 'CIRCLE' || cfg.shape === 'ELLIPSE') s.borderRadius = '50%';
  else if (cfg.shape === 'HEXAGON') { /* clip-path 由类承接 */ }
  else s.borderRadius = `${cfg.customRadius}px`;
  if (cfg.sizePreset === 'CUSTOM') {
    s.width = Math.min(cfg.customWidth, 1200);
    s.height = Math.min(cfg.customHeight, 1200);
    s.maxWidth = '100%';
  }
  if (cfg.aspectRatio) {
    const [w, h] = cfg.aspectRatio.split(':').map(Number);
    if (w > 0 && h > 0) s.aspectRatio = `${w} / ${h}`;
  }
  return s;
}

/** AVATAR/RANK_BADGE 的档位尺寸（像素方寸） */
export function presetSize(target: ObjectTarget, preset: string): number | null {
  if (target === 'AVATAR') return SIZE_AVATAR[preset] ?? null;
  if (target === 'RANK_BADGE') return SIZE_BADGE[preset] ?? null;
  return null;
}

/** 对象 → 事件特效的归属映射（任务书 §十一） */
export const EVENT_TARGET: Record<EventKey, ObjectTarget> = {
  RANK_CHANGED: 'RANK_BADGE',
  LEADERBOARD_POSITION_CHANGED: 'RANK_BADGE',
  TIER_CHANGED: 'RANK_BADGE',
  STATISTICS_UPDATED: 'STATS_CARD',
  TAB_CHANGED: 'STATS_CARD',
  PLAYER_CARD_EXPANDED: 'FLOATING_PANEL',
  PLAYER_PROFILE_OPEN: 'PROFILE_CARD',
  PLAYER_PROFILE_CLOSE: 'PROFILE_CARD',
};

/** 时间轴片段查找：以对象为目标的最早片段覆写入场时序 */
function timelineFor(resolved: ResolvedVisualConfig, target: ObjectTarget) {
  return resolved.timeline.find(s => s.target === target) ?? null;
}

// ============================================================
// VisualBox — 对象统一包装器
// ============================================================
export function VisualBox({
  target,
  children,
  className,
  style,
  onClick,
  ...rest
}: {
  target: ObjectTarget;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick' | 'className' | 'style'>) {
  const stage = useVisualStage();
  const resolved = stage?.resolved;
  const perf = stage?.perf ?? 'FULL';
  const cfg = resolved?.objects?.[target];

  const [inView, setInView] = useState(false);
  const [manualPlay, setManualPlay] = useState(0); // CLICK/HOVER/TOGGLE 播放序号
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // SCROLL 触发：进入视口播一次（IntersectionObserver，卸载即清理）
  const trigger = cfg?.entrance?.trigger ?? 'AUTO';
  useEffect(() => {
    if (trigger !== 'SCROLL' || !scrollRef.current) return;
    const el = scrollRef.current;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setInView(true); io.disconnect(); }
    }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, [trigger]);

  const entrance = cfg?.entrance ?? null;
  const seg = resolved ? timelineFor(resolved, target) : null;

  // 是否已（自动）播放：AUTO/DELAYED/SEQUENCE/SCROLL 立即或条件播放
  const autoPlay = entrance && (trigger === 'AUTO' || trigger === 'DELAYED' || trigger === 'SEQUENCE' || (trigger === 'SCROLL' && inView));
  const playing = perf !== 'STATIC' && !!entrance && (autoPlay || manualPlay > 0);

  const p = entrance?.params ?? {};
  const duration = seg?.duration ?? p.duration ?? 700;
  const delay = seg ? seg.start : (p.delay ?? 0);
  const intensity = seg?.intensity ?? p.intensity ?? 60;

  // 形状 + 尺寸 + 位移 + 图层（STATIC 也保留静态视觉风格——任务书 §14）
  const size = presetSize(target, cfg?.sizePreset ?? 'M');
  const objStyle: React.CSSProperties = {
    ...(cfg ? shapeStyle(cfg) : {}),
    ...(size ? { width: size, height: size } : {}),
    transform: `translate(${cfg?.positionX ?? 0}px, ${cfg?.positionY ?? 0}px) scale(${(cfg?.mobileScale ?? 100) / 100})`,
    zIndex: cfg?.zLayer ?? 1,
    ...style,
  };

  const accent = cfg?.accentColor ?? 'inherit';
  const interaction = cfg?.interaction ?? 'NONE';
  const ambient = (cfg?.ambient ?? null);
  const ambientOn = stage?.resolved?.ambientEnabled && perf !== 'STATIC' && perf !== 'LITE' && !!ambient;

  // 手动触发处理器（HOVER 附带 CLICK 回退；TOGGLE = 点击重播）
  const handleManual = () => {
    if (!entrance || perf === 'STATIC') return;
    if (trigger === 'CLICK' || trigger === 'HOVER' || trigger === 'TOGGLE') {
      setManualPlay(n => n + 1);
    }
  };

  // 事件特效归属
  const evt = stage?.activeEvent;
  const evtMine = evt && EVENT_TARGET[evt.key] === target ? evt : null;

  const outerClass = cn(
    'relative vx-accent-' + accent,
    cfg?.shape === 'HEXAGON' && 'vx-shape-hexagon',
    interaction !== 'NONE' && perf !== 'STATIC' && cn('vx-interaction',
      interaction === 'LIFT' && 'vx-ia-lift',
      interaction === 'GLOW' && 'vx-ia-glow',
      interaction === 'TILT' && 'vx-ia-tilt'),
    ambientOn && ambient === 'LIQUID' && 'vx-ambient-liquid',
    ambientOn && ambient === 'PHOTON' && 'vx-ambient-photon',
    ambientOn && ambient === 'HOLOGRAM' && 'vx-ambient-hologram',
    ambientOn && ambient === 'PRISM' && 'vx-ambient-prism',
    className,
  );

  const animVars: React.CSSProperties = {
    '--vxd': `${duration}ms`,
    '--vxe': p.easing ?? 'cubic-bezier(0.22, 1, 0.36, 1)',
    '--vx-delay': `${delay}ms`,
    '--vxi': intensity / 100,
    '--vx-opacity': (p.opacity ?? 100) / 100,
    '--vx-scale': (p.scale ?? 100) / 100,
    '--vx-radius': `${cfg?.customRadius ?? 16}px`,
    ...directionVars(entrance?.effect ?? 'PRISM', p.direction ?? 'center', intensity),
  } as React.CSSProperties;

  return (
    <div
      ref={scrollRef}
      className={outerClass}
      style={objStyle}
      onClick={e => { onClick?.(e); handleManual(); }}
      onMouseEnter={trigger === 'HOVER' ? handleManual : undefined}
      {...rest}
    >
      {/* 入场动画内层（key 强制重播：整体 replay / 手动触发 / 事件无关） */}
      <div
        key={`vx-${target}-${stage?.replayKey ?? 0}-${manualPlay}`}
        className={cn('h-full w-full', playing && EFFECT_CLASS[entrance.effect], playing && 'vx-anim')}
        style={playing ? animVars : { opacity: (p.opacity ?? 100) / 100, transform: `scale(${(p.scale ?? 100) / 100})` }}
      >
        {children}
      </div>

      {/* 装饰层（与入场同参；STATIC/LITE 不渲染重装饰） */}
      {playing && entrance.effect === 'PRISM' && <span className="vx-sheen" aria-hidden="true" />}
      {playing && entrance.effect === 'PORTAL' && <span className="vx-portal-ring" aria-hidden="true" />}
      {playing && entrance.effect === 'HOLOGRAM' && <span className="vx-scanlines" aria-hidden="true" />}
      {playing && entrance.effect === 'PHOTON' && <span className="vx-photon-beam" aria-hidden="true" />}
      {playing && entrance.effect === 'ORBIT' && (
        <span className="vx-orbit-rings" aria-hidden="true" style={{ '--vxa': '14s' } as React.CSSProperties} />
      )}
      {playing && entrance.effect === 'REVEAL' && (
        <span
          className="vx-reveal-edge"
          aria-hidden="true"
          style={{
            ...animVars,
            ...( (p.direction ?? 'left') === 'left' || (p.direction ?? 'left') === 'right'
              ? { top: 0, bottom: 0, width: 2, '--vx-edge-from': `translateX(${(p.direction ?? 'left') === 'left' ? '-100%' : '100%'})`, '--vx-edge-to': 'translateX(0)' }
              : { left: 0, right: 0, height: 2, '--vx-edge-from': `translateY(${(p.direction ?? 'left') === 'up' ? '-100%' : '100%'})`, '--vx-edge-to': 'translateY(0)' } ) as React.CSSProperties,
          }}
        />
      )}
      {playing && entrance.effect === 'PARTICLE' && (
        <VxParticles
          count={particleCount(intensity, perf)}
          enter
          duration={duration}
          delay={delay}
          accentOnly={false}
        />
      )}
      {ambientOn && ambient === 'AURORA' && (
        <span className="vx-aurora-flow" aria-hidden="true" style={{ zIndex: -1 }} />
      )}
      {ambientOn && ambient === 'ORBIT' && (
        <span className="vx-orbit-rings" aria-hidden="true" style={{ '--vxa': '16s' } as React.CSSProperties} />
      )}
      {ambientOn && ambient === 'PARTICLE' && (
        <VxParticles count={particleCount(45, perf)} ambient />
      )}

      {/* 真实事件反馈特效（有界动画：pop + 扩散环） */}
      {evtMine && perf !== 'STATIC' && (
        <span
          key={`vx-evt-${evtMine.seq}`}
          className="pointer-events-none absolute inset-0 z-[5] rounded-[inherit]"
          style={{ '--vxd': `${evtMine.duration}ms`, '--vxi': evtMine.intensity / 100, '--vx-accent': 'var(--vx-accent)' } as React.CSSProperties}
        >
          <span className="absolute inset-0 vx-event-fx" onAnimationEnd={() => { /* fill both 终态=常态，无需清理 */ }} />
          <span className="absolute inset-0 vx-event-fx-ring" />
        </span>
      )}
    </div>
  );
}

function particleCount(intensity: number, perf: string): number {
  const base = Math.round((intensity / 100) * 24);
  if (perf === 'FULL') return Math.max(6, Math.min(24, base));
  if (perf === 'BALANCED') return Math.max(4, Math.min(12, Math.round(base / 2)));
  return 0;
}

// ============================================================
// VxParticles — 一次性生成的 DOM 粒子（无 canvas / 无 RAF）
// ============================================================
function VxParticles({ count, enter = false, ambient = false, duration = 1100, delay = 0 }: {
  count: number; enter?: boolean; ambient?: boolean; duration?: number; delay?: number;
}) {
  const dots = useMemo(() => {
    if (count <= 0) return [];
    // 固定伪随机（种子即索引）→ 服务端/客户端渲染一致，避免水合抖动
    return Array.from({ length: count }, (_, i) => {
      const r1 = ((i * 73) % 100) / 100;
      const r2 = ((i * 137) % 100) / 100;
      const r3 = ((i * 31) % 100) / 100;
      const r4 = ((i * 53) % 100) / 100;
      return {
        left: `${8 + r1 * 84}%`,
        top: `${8 + r2 * 84}%`,
        size: 2 + r3 * 3,
        px0: `${(r1 - 0.5) * 90}px`,
        py0: `${(r2 - 0.5) * 70}px`,
        pdx: `${(r3 - 0.5) * 10}px`,
        pdy: `${-4 - r4 * 8}px`,
        d: `${r4 * 800}ms`,
        t: `${4.5 + r1 * 4}s`,
      };
    });
  }, [count]);

  if (dots.length === 0) return null;
  return (
    <span className="vx-particles-layer" aria-hidden="true">
      {dots.map((d, i) => (
        <span
          key={i}
          className={cn(enter ? 'vx-particle vx-particle-enter' : 'vx-particle vx-particle-ambient')}
          style={{
            left: d.left, top: d.top, width: d.size, height: d.size,
            '--px0': d.px0, '--py0': d.py0, '--pdx': d.pdx, '--pdy': d.pdy,
            '--pvd': `${duration}ms`, '--pvdelay': enter ? `${delay + parseInt(d.d)}ms` : d.d,
            '--pvt': d.t,
          } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

// ============================================================
// VisualAmbientBackground — 背景装饰层（BACKGROUND 对象）
// 挂在 stage 容器最底层（z 由 BACKGROUND.zLayer 承接，默认 0）
// ============================================================
export function VisualAmbientBackground() {
  const stage = useVisualStage();
  const resolved = stage?.resolved;
  const perf = stage?.perf ?? 'FULL';
  if (!resolved || perf === 'STATIC' || perf === 'LITE') return null;
  const bg = resolved.objects?.BACKGROUND;
  if (!bg) return null;

  const ambient = bg.ambient;
  const on = resolved.ambientEnabled && ambient;
  if (!on) return null;

  return (
    <VisualBox target="BACKGROUND" className="absolute inset-0 rounded-[inherit] pointer-events-none overflow-visible" style={{ zIndex: bg.zLayer ?? 0 }}>
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden">
        {ambient === 'AURORA' && <span className="vx-aurora-flow" style={{ zIndex: 0 }} aria-hidden="true" />}
        {ambient === 'PARTICLE' && <VxParticles count={particleCount(50, perf)} ambient />}
        {ambient === 'ORBIT' && <span className="vx-orbit-rings" style={{ '--vxa': '22s' } as React.CSSProperties} aria-hidden="true" />}
        {ambient === 'HOLOGRAM' && <span className="vx-scanlines opacity-40" aria-hidden="true" />}
      </div>
    </VisualBox>
  );
}
