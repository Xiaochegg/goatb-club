'use client';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — Visual Stage Provider
// ------------------------------------------------------------
// 职责（任务书 §三/§五/§十四）：
//   1. 拉取玩家已发布生效视觉配置（单次 fetch，无轮询）；
//   2. 性能分级仲裁：prefers-reduced-motion / 全局 pausedMotion（SA-09）→
//      强制 STATIC；页面隐藏 → .vx-hidden 暂停非必要动画；
//   3. 事件总线：真实业务事件 → 有界动画（同类事件 3s 冷却防重复）；
//   4. 重播控制（管理端预览与玩家端调试共用）。
// 卸载清理：fetch abort + visibility 监听移除。
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useAppStore } from '@/lib/store';
import { resolveEffectiveConfig } from '@/lib/visual/resolve';
import type { EventKey, PerfMode, ResolvedVisualConfig, VisualConfig } from '@/lib/visual/types';

export interface VisualEventActivation {
  key: EventKey;
  seq: number;        // 递增序号（驱动一次性动画 key）
  effect: ResolvedVisualConfig['events'][EventKey]['effect'];
  intensity: number;
  duration: number;
}

interface VisualStageCtx {
  resolved: ResolvedVisualConfig;
  perf: PerfMode;                 // 仲裁后的实际性能分级
  replayKey: number;              // 变更 → 重挂对象动画（整体重播）
  replay: () => void;
  activeEvent: VisualEventActivation | null;
  fireVisualEvent: (key: EventKey) => void;
  /** 预览模式（管理端）：不读远端、mock 数据源标记 */
  preview: boolean;
}

const Ctx = createContext<VisualStageCtx | null>(null);

/** 玩家面板外层容器必须加 .vx-stage（position:relative + 可见性暂停作用域） */
export function VisualStageProvider({
  playerId,
  configOverride = undefined,
  preview = false,
  children,
}: {
  playerId?: string | null;
  configOverride?: VisualConfig | null;
  preview?: boolean;
  children: React.ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const pausedMotion = useAppStore(s => s.pausedMotion);

  const [fetched, setFetched] = useState<VisualConfig | null>(null);
  const [replayKey, setReplayKey] = useState(0);
  const [activeEvent, setActiveEvent] = useState<VisualEventActivation | null>(null);
  const [hidden, setHidden] = useState(false);
  const eventSeq = useRef(0);
  const lastFireAt = useRef<Partial<Record<EventKey, number>>>({});

  // ── 配置获取：玩家端单次 fetch；预览端用 override ──
  useEffect(() => {
    if (preview || configOverride !== undefined || !playerId) return;
    const ctrl = new AbortController();
    fetch(`/api/v1/visual/config?playerId=${encodeURIComponent(playerId)}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean; config?: VisualConfig | null } | null) => {
        setFetched(d && d.enabled && d.config ? d.config : null);
      })
      .catch(() => setFetched(null));
    return () => ctrl.abort();
  }, [playerId, preview, configOverride]);

  const resolved = useMemo<ResolvedVisualConfig>(() => {
    if (configOverride !== undefined && configOverride !== null) {
      return resolveEffectiveConfig([configOverride]);
    }
    if (preview) return resolveEffectiveConfig([null]);
    return resolveEffectiveConfig([fetched]);
  }, [fetched, configOverride, preview]);

  // ── 性能分级仲裁（任务书 §十四：尊重 prefers-reduced-motion）──
  const perf: PerfMode = reducedMotion || pausedMotion
    ? 'STATIC'
    : resolved.perfMode;

  // ── 页面隐藏暂停（仅非 STATIC 需要）──
  useEffect(() => {
    if (perf === 'STATIC') return;
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [perf]);

  const replay = useCallback(() => setReplayKey(k => k + 1), []);

  // ── 事件总线：真实 diff 由调用方判定；这里负责防重复（3s 冷却）──
  const fireVisualEvent = useCallback((key: EventKey) => {
    const binding = resolved.events?.[key];
    if (!binding || !binding.enabled || perf === 'STATIC') return;
    const now = Date.now();
    if (lastFireAt.current[key] && now - lastFireAt.current[key] < 3000) return;
    lastFireAt.current[key] = now;
    eventSeq.current += 1;
    setActiveEvent({
      key,
      seq: eventSeq.current,
      effect: binding.effect,
      intensity: binding.intensity,
      duration: binding.duration,
    });
  }, [resolved, perf]);

  const value = useMemo<VisualStageCtx>(() => ({
    resolved,
    perf,
    replayKey,
    replay,
    activeEvent,
    fireVisualEvent,
    preview,
  }), [resolved, perf, replayKey, replay, activeEvent, fireVisualEvent, preview]);

  return (
    <Ctx.Provider value={value}>
      <div
        className={[
          'vx-stage relative',
          hidden ? 'vx-hidden' : '',
          perf === 'LITE' ? 'vx-perf-lite' : '',
          perf === 'STATIC' ? 'vx-perf-static' : '',
        ].join(' ')}
        data-vx-perf={perf}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function useVisualStage(): VisualStageCtx | null {
  return useContext(Ctx);
}
