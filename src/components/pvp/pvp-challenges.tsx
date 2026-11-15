'use client';

// ============================================================
// 约 PVP · 面板壳 + 入口胶囊（工单 2026-11-10 V1.0）
// ------------------------------------------------------------
// 接入：入口胶囊由冻结文件 xt-leaderboard.tsx 的 xtlb-search-row 最前
// 渲染（外科手术注入，待授权）；面板经 createPortal 挂 body，与
// 排行榜筛选逻辑零耦合（不参与任何筛选值计算）。
// 动效：framer-motion（既有依赖，零新增）；transform/opacity 优先、
// 可打断；prefers-reduced-motion 与 store.pausedMotion 双重尊重。
// ============================================================

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Swords } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { fetchMe } from '@/lib/pvp-client';
import { PvpCreateForm } from './pvp-create-form';
import { PvpMyBoard } from './pvp-my-board';
import './pvp.css';

type ViewKey = 'create' | 'board';

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function PvpChallenges() {
  const [open, setOpen] = useState(false);
  // 客户端挂载检测（portal 前提）：useSyncExternalStore 水合模式，零 effect/setState
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const [view, setView] = useState<ViewKey>('create');
  const [me, setMe] = useState<{ id: string; name: string; email: string } | null>(null);
  const [meLoading, setMeLoading] = useState(false);
  const [incomingPending, setIncomingPending] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabCreateRef = useRef<HTMLButtonElement>(null);
  const tabBoardRef = useRef<HTMLButtonElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  const reduced = useReducedMotion();
  const pausedMotion = useAppStore(s => s.pausedMotion);
  const setPlayerAuthOpen = useAppStore(s => s.setPlayerAuthOpen);
  const noMotion = reduced || pausedMotion;

  // 视图 pill 定位（选中背景平滑移动；打开/视图切换/resize 均重算）
  const measurePill = useCallback(() => {
    const el = view === 'create' ? tabCreateRef.current : tabBoardRef.current;
    if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
  }, [view]);
  useEffect(() => {
    if (!open) return;
    measurePill();
    window.addEventListener('resize', measurePill);
    return () => window.removeEventListener('resize', measurePill);
  }, [open, measurePill]);

  // 打开：检测登录态（服务端权威）+ 重置视图
  const openPanel = useCallback(() => {
    setOpen(true);
    setView('create');
    setMeLoading(true);
    void fetchMe().then(r => {
      if (r.result === 'success') setMe(r.data.player);
      else setMe(null);
      setMeLoading(false);
    });
  }, []);

  const closePanel = useCallback(() => setOpen(false), []);

  // Escape 关闭 + 打开时锁定页面滚动 + 关闭后无残留监听（清理见本 effect）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel(); };
    const t = setTimeout(() => closeRef.current?.focus(), 60);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.documentElement.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closePanel]);

  const onMaskDown = useCallback((e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) closePanel();
  }, [closePanel]);

  return (
    <>
      {/* 入口胶囊：独立按钮，不参与现有筛选事件/筛选值（工单 §7.1） */}
      <button type="button" className="pvp-entry-chip" onClick={openPanel} aria-haspopup="dialog">
        <Swords className="w-3.5 h-3.5" aria-hidden="true" />
        约 PVP
        {incomingPending > 0 && <span className="pvp-entry-dot" title={`${incomingPending} 条待回应`} aria-hidden="true" />}
      </button>

      {mounted && createPortal(
        <AnimatePresence>
          {open && (
            <>
              {/* 遮罩：180-240ms 淡入 */}
              <motion.div
                className="pvp-mask"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: noMotion ? 0 : 0.2, ease: EASE_OUT }}
                onMouseDown={onMaskDown}
                aria-hidden="true"
              />
              {/* 面板：260-360ms，轻微下移进入 + 微缩放，无大幅弹跳 */}
              <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="约 PVP"
                className="pvp-glass-panel"
                initial={noMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.97 }}
                animate={noMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                exit={noMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
                transition={{ duration: noMotion ? 0 : 0.3, ease: EASE_OUT }}
                data-testid="pvp-panel"
              >
                <div className="pvp-head">
                  <Swords className="w-4 h-4" style={{ color: 'var(--pvp-accent-text)' }} aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="t">约 PVP</div>
                    <div className="s">发起约战请求 —— 对方接受前不产生任何正式战绩</div>
                  </div>
                  <button ref={closeRef} type="button" className="pvp-x" onClick={closePanel} aria-label="关闭约战面板">✕</button>
                </div>

                {/* 视图切换：选中背景平滑移动，不重载面板、不闪屏 */}
                <div className="pvp-viewtabs" role="tablist" aria-label="约战视图">
                  {pill && !noMotion && (
                    <motion.span
                      className="pvp-pill"
                      aria-hidden="true"
                      initial={false}
                      animate={{ x: pill.x, width: pill.w }}
                      transition={{ duration: 0.26, ease: EASE_OUT }}
                      style={{ left: 0 }}
                    />
                  )}
                  <button ref={tabCreateRef} role="tab" aria-selected={view === 'create'} onClick={() => setView('create')}>发起约战</button>
                  <button ref={tabBoardRef} role="tab" aria-selected={view === 'board'} onClick={() => setView('board')}>
                    我的约战
                    {incomingPending > 0 && <span className="pvp-incoming-badge">{incomingPending}</span>}
                  </button>
                </div>

                <div className="pvp-body">
                  {meLoading ? (
                    <div className="pvp-state" role="status">正在确认登录状态…</div>
                  ) : !me ? (
                    /* 未登录：面板可浏览，发起/查看需登录（服务端同校验，工单 §9.2） */
                    <div className="pvp-state">
                      <div className="big">需要玩家登录</div>
                      <p style={{ fontSize: 11, marginTop: 2 }}>约战请求与接受/拒绝都必须以实名登录身份进行，</p>
                      <p style={{ fontSize: 11 }}>这样才能保证约战双方真实可追责。</p>
                      <div className="row">
                        <button type="button" className="pvp-mini-btn acc" onClick={() => { closePanel(); setPlayerAuthOpen(true); }}>
                          去登录 / 注册
                        </button>
                      </div>
                    </div>
                  ) : view === 'create' ? (
                    <PvpCreateForm me={me} onSuccess={() => setView('board')} />
                  ) : (
                    <PvpMyBoard me={me} onPendingCount={setIncomingPending} onGotoCreate={() => setView('create')} />
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
