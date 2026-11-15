'use client';

/**
 * FxLab — 特效组件库开发验证面板（DEV ONLY）
 *
 * 用途：FX-04 逐项实测。通过 /?fxlab=1 访问时挂载，逐个开启特效演示，
 * 配合 agent-browser 验证 console 错误 / FPS / 移动端表现。
 * 生产构建（NODE_ENV=production）不渲染、不加载；仅开发环境可用。
 *
 * 面板自身包含：FPS 计数器（rAF 采样）+ window error 计数。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FxCountUp } from './fx-count-up';
import { FxStarBorder } from './fx-star-border';
import { FxDecryptedText } from './fx-decrypted-text';
import { FxMarquee } from './fx-marquee';
import { FxShimmerButton } from './fx-shimmer-button';
import { FxPixelTrail } from './fx-pixel-trail';
import { FxFlickerText } from './fx-flicker-text';
import { FxPixelIntro } from './fx-pixel-intro';
import { FxConfettiButton } from './fx-confetti';

/* ---------------- FPS / 错误监控（面板级，非全局） ---------------- */

function useFpsCounter(enabled: boolean): number {
  const [fps, setFps] = useState(0);
  const framesRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // rAF 采样：只统计帧数，1s 定时器读取（避免 setState-in-effect）
    let raf = 0;
    const loop = () => {
      framesRef.current += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(() => {
      setFps(framesRef.current);
      framesRef.current = 0;
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return fps;
}

function useErrorCounter(enabled: boolean): number {
  const [errors, setErrors] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const onError = () => setErrors(n => n + 1);
    window.addEventListener('error', onError);
    return () => window.removeEventListener('error', onError);
  }, [enabled]);
  return errors;
}

/* ---------------- 演示卡容器 ---------------- */

function FxDemoCard({
  title,
  source,
  license,
  children,
}: {
  title: string;
  source: string;
  license: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-white/10 bg-black/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-white/5 transition-colors"
        aria-expanded={open}
      >
        <span className="flex flex-col min-w-0">
          <span className="text-xs font-semibold text-amber-300 truncate">{title}</span>
          <span className="text-[9px] text-white/40 truncate">{source} · {license}</span>
        </span>
        <span className="text-[10px] text-white/50 flex-shrink-0 ml-2">{open ? '关' : '开'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-white/5">{children}</div>
      )}
    </div>
  );
}

/* ---------------- 主面板 ---------------- */

export function FxLab() {
  const [panelOpen, setPanelOpen] = useState(true);
  const fps = useFpsCounter(panelOpen);
  const errors = useErrorCounter(panelOpen);

  const [countUpKey, setCountUpKey] = useState(0);
  const [introKey, setIntroKey] = useState(0);
  const replayCountUp = useCallback(() => setCountUpKey(k => k + 1), []);
  const replayIntro = useCallback(() => setIntroKey(k => k + 1), []);

  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="fixed right-3 bottom-6 z-[95] flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-black/70 px-3 py-2 text-[10px] font-semibold text-amber-300 shadow-lg backdrop-blur hover:bg-black/90"
        aria-label="打开 FX Lab 特效验证面板（仅开发环境）"
      >
        <FlaskConical className="h-3.5 w-3.5" />
        FX Lab (dev)
      </button>
    );
  }

  return (
    <aside
      className="fixed right-3 bottom-6 z-[95] w-[min(92vw,380px)] max-h-[72vh] rounded-xl border border-amber-400/30 bg-[#0c0c14]/95 shadow-2xl backdrop-blur-md flex flex-col"
      aria-label="FX Lab 特效验证面板（仅开发环境）"
    >
      {/* 头部：标题 + 运行指标 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-3.5 w-3.5 text-amber-300" />
          <span className="text-xs font-bold text-amber-200">FX Lab — 特效验证</span>
          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-400/15 text-amber-300">DEV ONLY</span>
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          className="p-1 rounded text-white/50 hover:text-white hover:bg-white/10"
          aria-label="收起面板"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-white/60 border-b border-white/5 font-mono">
        <span>FPS: <b className={cn(fps >= 50 ? 'text-emerald-400' : fps >= 30 ? 'text-amber-400' : 'text-red-400')}>{fps}</b></span>
        <span>Errors: <b className={cn(errors === 0 ? 'text-emerald-400' : 'text-red-400')}>{errors}</b></span>
        <span className="text-white/30">9 components</span>
      </div>

      {/* 演示卡列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2 fx-lab-scroll">
        <FxDemoCard title="FxCountUp — 数字滚动" source="reactbits.dev" license="MIT+CC">
          <div className="flex items-center gap-2">
            <span className="text-lg text-amber-200 font-mc">
              <FxCountUp key={countUpKey} to={1234567} separator="," duration={2} trigger="load" />
            </span>
            <button type="button" onClick={replayCountUp} className="ml-auto text-[10px] px-2 py-1 rounded border border-white/20 text-white/70 hover:bg-white/10">重播</button>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxStarBorder — 星迹描边" source="reactbits.dev" license="MIT+CC">
          <div className="flex justify-center py-1">
            <FxStarBorder radius={10} duration={4} glow={0.8}>
              <span className="text-xs text-amber-200 px-2 py-1">第一名</span>
            </FxStarBorder>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxDecryptedText — 解密文字" source="reactbits.dev" license="MIT+CC">
          <div className="py-1 text-center text-sm text-amber-100">
            <FxDecryptedText text="GOATB SERVER ONLINE" animateOn="click" speed={40} />
            <p className="text-[9px] text-white/35 mt-1">点击文字播放解密</p>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxMarquee — 跑马灯" source="magicui.design" license="MIT">
          <div className="py-1">
            <FxMarquee pauseOnHover repeat={3} className="rounded border border-white/10 py-1" style={{ ['--duration' as string]: '12s' }}>
              <span className="text-[10px] text-white/70 px-3">🏆 赛季 Top1: Steve</span>
              <span className="text-[10px] text-white/70 px-3">⛏ 新赛季 11.1 开启</span>
              <span className="text-[10px] text-white/70 px-3">💎 钻石榜刷新</span>
            </FxMarquee>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxShimmerButton — 流光按钮" source="magicui.design" license="MIT">
          <div className="flex justify-center py-1">
            <FxShimmerButton className="text-xs font-semibold text-amber-200" shimmerDuration="2.5s">
              赛季结算
            </FxShimmerButton>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxPixelTrail — 像素拖尾" source="reactbits.dev" license="MIT+CC">
          <div className="relative h-32 rounded border border-white/10 overflow-hidden bg-black/60">
            <FxPixelTrail className="absolute inset-0" gridSize={28} shape="square" decay="fade" />
            <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/35 pointer-events-none">在此区域滑动鼠标</span>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxFlickerText — 霓虹明灭" source="animista.net" license="FreeBSD">
          <div className="flex justify-center py-2 text-xl font-mc">
            <FxFlickerText text="HOT STREAK" />
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxPixelIntro — 像素字坠落" source="animorio.com" license="项目内可用">
          <div className="flex items-center gap-2 py-1">
            <span className="flex-1 text-center text-2xl font-mc text-amber-200">
              <FxPixelIntro key={introKey} text="GOATB" className="font-mc" />
            </span>
            <button type="button" onClick={replayIntro} className="text-[10px] px-2 py-1 rounded border border-white/20 text-white/70 hover:bg-white/10">重播</button>
          </div>
        </FxDemoCard>

        <FxDemoCard title="FxConfetti — 金色彩带" source="codepen.io" license="默认许可·需复核">
          <div className="flex justify-center py-1">
            <FxConfettiButton className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-400/20">
              🎉 庆贺上榜
            </FxConfettiButton>
          </div>
        </FxDemoCard>
      </div>

      <div className="px-3 py-1.5 text-[9px] text-white/30 border-t border-white/5">
        仅 ?fxlab=1 + 开发环境可见 · 生产构建不含本面板
      </div>
    </aside>
  );
}

export default FxLab;
