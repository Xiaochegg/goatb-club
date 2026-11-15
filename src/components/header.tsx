// ============================================================
// Component: Header — Minimal floating glass, liquid style
// Extracted from page.tsx (split-wave-4, 2026-11).
// Has useState (season popover) + useEffect (fetch active season,
// click-outside) → "use client" required. Season popup state lives
// INSIDE this component; parent must not duplicate it.
// ============================================================
'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence, useScroll, useMotionValueEvent } from 'framer-motion';
import { ChevronDown, Trophy, Lock, Heart, Send, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useAppStore } from '@/lib/store';
import { cachedFetchJSON } from '@/lib/client-cache';
import { FxDecryptedText } from '@/components/fx/fx-decrypted-text';

// Task 42：汽车 SVG 图标（替代 Shield 盾牌）——侧视跑车剪影，20-24px 可读
// 金色车身 + 紫色描边呼应 logo-go-glow 的金紫配色
function CarLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* 车身主体 */}
      <path
        d="M2 15 L2 11 Q2 9 4 9 L8 9 L11 5 L20 5 Q22 5 23 7 L25 9 L26 10 Q27 10.5 27 12 L27 15 Z"
        fill="url(#carBodyGrad)"
        stroke="rgba(191,90,242,0.6)"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      {/* 车窗 */}
      <path
        d="M9 9 L11 6 L19 6 Q20.5 6 21.5 8 L22.5 9 Z"
        fill="rgba(168,212,232,0.7)"
        stroke="rgba(191,90,242,0.4)"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      {/* 前灯 */}
      <rect x="25" y="11" width="2" height="1.8" rx="0.4" fill="#FFE68A" />
      {/* 后轮 */}
      <circle cx="8" cy="15.5" r="2.8" fill="#1a1030" />
      <circle cx="8" cy="15.5" r="1.2" fill="#FFD700" />
      {/* 前轮 */}
      <circle cx="22" cy="15.5" r="2.8" fill="#1a1030" />
      <circle cx="22" cy="15.5" r="1.2" fill="#FFD700" />
      <defs>
        <linearGradient id="carBodyGrad" x1="0" y1="0" x2="28" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFD700" />
          <stop offset="0.5" stopColor="#D4AF37" />
          <stop offset="1" stopColor="#BF5AF2" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Header() {
  const { setAdminLoginOpen, isAdmin, setAdminPanelOpen, incrementEasterEgg } = useAppStore();
  const { toast } = useToast();

  // ============================================================
  // 赞助弹窗（工单 2026-11-09：管理按钮左侧"赞助"入口）
  // 数据源 GET /api/v1/sponsor（公开）；弹窗打开时按需拉取，零首屏负担
  // ============================================================
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [sponsorLoading, setSponsorLoading] = useState(false);
  const [sponsorError, setSponsorError] = useState(false);
  const [sponsorData, setSponsorData] = useState<{ enabled: boolean; note: string; image: string | null; hasImage: boolean } | null>(null);

  // ============================================================
  // 祝福语（工单 2026-11-09：弹窗右下角「送祝福」→ 后台可查）
  // 独立于赞助开关：未开放态也可送祝福；POST /api/v1/sponsor/blessings
  // 内容 1..100 字、署名可选 ≤20 字，同 IP 60 秒 1 条（服务端限流）
  // ============================================================
  const [blessOpen, setBlessOpen] = useState(false);
  const [blessContent, setBlessContent] = useState('');
  const [blessNick, setBlessNick] = useState('');
  const [blessSending, setBlessSending] = useState(false);
  const [blessDone, setBlessDone] = useState(false);
  const [blessError, setBlessError] = useState<string | null>(null);

  const submitBlessing = useCallback(async () => {
    const content = blessContent.trim();
    if (!content || blessSending) return;
    setBlessSending(true);
    setBlessError(null);
    try {
      const res = await fetch('/api/v1/sponsor/blessings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, nickname: blessNick.trim() || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || '发送失败，请稍后重试');
      setBlessDone(true);
      setBlessOpen(false);
      setBlessContent('');
      setBlessNick('');
    } catch (e) {
      setBlessError(e instanceof Error ? e.message : '发送失败，请稍后重试');
    } finally {
      setBlessSending(false);
    }
  }, [blessContent, blessNick, blessSending]);

  const openSponsor = useCallback(() => {
    setSponsorOpen(true);
    setSponsorLoading(true);
    setSponsorError(false);
    // 祝福语表单随弹窗打开重置（工单 2026-11-09：弹窗右下角送祝福）
    setBlessOpen(false);
    setBlessContent('');
    setBlessNick('');
    setBlessError(null);
    setBlessDone(false);
    fetch('/api/v1/sponsor')
      .then(r => { if (!r.ok) throw new Error('bad status'); return r.json(); })
      .then(d => setSponsorData(d))
      .catch(() => setSponsorError(true))
      .finally(() => setSponsorLoading(false));
  }, []);

  // Task 42：彩蛋升级——连点 5 次 logo 打开「小车爱拉稀」公路旅行网页
  // （public/easter-egg.html，新标签页打开，保留原滚动体验）
  // 10/20 次等里程碑保留 toast 反馈
  const handleLogoClick = useCallback(() => {
    const next = useAppStore.getState().easterEggCount + 1;
    incrementEasterEgg();
    if (next === 5) {
      toast({ description: '🚗 彩蛋解锁：小车发车了！正在打开公路旅行…' });
      window.open('/easter-egg.html', '_blank', 'noopener,noreferrer');
    }
    if (next > 5 && next % 10 === 0) {
      toast({ description: `🏆 GOATB 荣誉居民：已点击 ${next} 次` });
    }
  }, [incrementEasterEgg, toast]);
  // B5：滚动压缩响应态——纯展示层 chrome 反馈（阈值 16px）。
  // 只读 window scrollY，不参与背景 zone 判定（scroll-interval-trigger 独立运行）；
  // setState 同值时 React 自动 bail out，滚动期零多余渲染。
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  useMotionValueEvent(scrollY, 'change', (v) => setScrolled(v > 16));

  // V6: season badge → clickable popover with real season info (D2)
  const [seasonInfo, setSeasonInfo] = useState<{ id: string; name: string; startAt: string | null } | null>(null);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const seasonBoxRef = useRef<HTMLDivElement>(null);

  // Click outside closes the season popover
  useEffect(() => {
    if (!seasonOpen) return;
    const onDown = (e: PointerEvent) => {
      if (seasonBoxRef.current && !seasonBoxRef.current.contains(e.target as Node)) setSeasonOpen(false);
    };
    // AU 审计补齐（2026-11）：Escape 关闭（非模态 popover 的惯用键盘语义，
    // 与筛选 Sheet / 编辑抽屉的 Escape 行为一致）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSeasonOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [seasonOpen]);

  // Fetch active season name once on mount (lightweight — 1 row)
  // C2/C3：经 client-cache 与页脚共享 seasons 缓存条目（TTL 45s），头部不再重复请求
  useEffect(() => {
    let cancelled = false;
    cachedFetchJSON<{ seasons?: Array<{ id: string; name: string; status: string; startAt?: string | null }> }>('/api/v1/seasons')
      .then(d => {
        if (cancelled) return;
        const active = (d.seasons || []).find((s: { status: string }) => s.status === 'ACTIVE');
        if (active) {
          setSeasonInfo({ id: active.id, name: active.name, startAt: active.startAt ?? null });
          useAppStore.getState().setCurrentSeasonId(active.id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <header className="sticky top-0 z-50 px-4 pt-[max(env(safe-area-inset-top),12px)]">
      <motion.div
        initial={{ y: -20, opacity: 0, filter: 'blur(8px)' }}
        animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
        transition={{ type: 'spring', stiffness: 260, damping: 22, mass: 0.8 }}
        className={cn(
          'liquid-glass v2b2-shell v2b2-header v2b5-hdr rounded-[var(--radius-liquid-pill)] px-4 py-2.5 flex flex-wrap items-center justify-between gap-y-1 min-w-0',
          scrolled && 'v2b5-scrolled'
        )}
      >
        {/* B5：滚动加深叠加层（内容层之下：z-0 + DOM 首位；零伪元素占用） */}
        <span aria-hidden="true" className="v2b5-tint" />
        {/* Logo — liquid pill press (Task 42: 汽车 SVG + GO 亮光质感) */}
        <motion.button
          onClick={handleLogoClick}
          aria-label="GOATB · 连点 5 次发车"
          whileTap={{ scale: 0.95 }}
          className="liquid-press relative flex items-center gap-2 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1a2e]"
        >
          <CarLogo className="w-5 h-4 sm:w-6 sm:h-[18px] drop-shadow-[0_0_4px_rgba(255,215,0,0.4)]" />
          <span className="text-sm sm:text-base font-bold tracking-[0.15em] font-mc">
            <span className="logo-go-glow">GO</span><span className="gold-text">ATB</span>
          </span>
        </motion.button>

        <div className="flex items-center gap-2">
          {/* Active season badge → popover (V6 D2): click for real season info */}
          {seasonInfo && (
            <div className="relative hidden sm:block" ref={seasonBoxRef}>
              <button
                onClick={() => setSeasonOpen((v) => !v)}
                aria-expanded={seasonOpen}
                aria-label={`${seasonInfo.name} 赛季信息`}
                className="flex items-center gap-1.5 text-[10px] font-semibold text-jade-400 bg-jade-500/10 border border-jade-500/20 px-2 py-1 rounded-full hover:bg-jade-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-300/70"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-jade-400 animate-pulse" />
                {seasonInfo.name}
                <ChevronDown className={cn('w-3 h-3 transition-transform', seasonOpen && 'rotate-180')} />
              </button>
              <AnimatePresence>
                {seasonOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.96 }}
                    transition={{ duration: 0.16 }}
                    className="absolute right-0 top-9 w-52 liquid-glass-strong rounded-xl p-3 border border-white/10 z-[60]"
                    style={{ background: 'rgba(20,20,40,0.95)' }}
                    role="dialog"
                    aria-label={`${seasonInfo.name} 信息`}
                  >
                    <p className="text-sm font-bold text-white flex items-center gap-1.5">
                      <Trophy className="w-3.5 h-3.5 text-jade-400 flex-shrink-0" />
                      {/* FX-07 赛博解密入场：popover 打开时播一次（命令方块感，React Bits · MIT） */}
                      <FxDecryptedText
                        text={seasonInfo.name}
                        className="text-white"
                        encryptedClassName="text-jade-400/60"
                        speed={32}
                        maxIterations={4}
                      />
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">
                      {seasonInfo.startAt
                        ? `开赛于 ${new Date(seasonInfo.startAt).toLocaleDateString('zh-CN')} · 已进行 ${Math.max(1, Math.floor((Date.now() - new Date(seasonInfo.startAt).getTime()) / 86400000) + 1)} 天`
                        : '进行中'}
                    </p>
                    <div className="liquid-divider my-2" />
                    <p className="text-[10px] text-white/50 leading-relaxed">赛季内所有对局积分计入当前榜单，赛季结束时可归档留存。</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Sponsor entry — glass pill button，管理入口左侧（工单 2026-11-09）*/}
          <motion.button
            onClick={openSponsor}
            whileTap={{ scale: 0.95 }}
            aria-haspopup="dialog"
            className="liquid-pill liquid-press relative px-3.5 min-h-[44px] rounded-[var(--radius-liquid-pill)] text-xs font-semibold border border-secondary-foreground/20 text-secondary-foreground/90 hover:text-secondary-foreground hover:border-secondary-foreground/35 hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1a2e]"
          >
            <Heart className="w-3 h-3 text-[#bf5af2]" aria-hidden="true" />
            赞助
          </motion.button>

          {/* Admin entry — single glass pill button */}
          <motion.button
            onClick={() => isAdmin ? setAdminPanelOpen(true) : setAdminLoginOpen(true)}
            whileTap={{ scale: 0.95 }}
            className="liquid-pill liquid-press relative px-3.5 min-h-[44px] rounded-[var(--radius-liquid-pill)] text-xs font-semibold border border-secondary-foreground/20 text-secondary-foreground/90 hover:text-secondary-foreground hover:border-secondary-foreground/35 hover:bg-white/[0.04] transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1a2e]"
          >
            <Lock className="w-3 h-3" />
            {isAdmin ? '管理后台' : '管理'}
          </motion.button>
        </div>
      </motion.div>

      {/* 赞助弹窗：图片 + 说明（enabled=false / 无图时显示未开放态） */}
      <Dialog open={sponsorOpen} onOpenChange={setSponsorOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md bg-[#201c33] border-white/10 text-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Heart className="w-4 h-4 text-[#bf5af2]" aria-hidden="true" />
              支持我们
            </DialogTitle>
            <DialogDescription className="sr-only">赞助与支持 GOATB CLUB</DialogDescription>
          </DialogHeader>

          {sponsorLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10" role="status" aria-live="polite">
              <div className="w-7 h-7 rounded-full border-2 border-[#bf5af2]/30 border-t-[#bf5af2] animate-spin" aria-hidden="true" />
              <p className="text-xs text-white/50">正在加载赞助信息…</p>
            </div>
          ) : sponsorError ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-sm text-white/70">加载失败，请稍后重试。</p>
              <button
                type="button"
                onClick={openSponsor}
                className="min-h-[40px] px-5 rounded-xl bg-[#7c6fd0] hover:bg-[#8b7fdd] transition-colors text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
              >
                重新加载
              </button>
            </div>
          ) : sponsorData?.enabled && sponsorData.image ? (
            <div className="flex flex-col items-center gap-3 pb-1">
              
              <img
                src={sponsorData.image}
                alt="赞助二维码"
                className="w-full max-h-[60vh] object-contain rounded-xl border border-white/10 bg-white/[0.03]"
              />
              {sponsorData.note ? (
                <p className="text-xs leading-relaxed text-white/60 text-center whitespace-pre-wrap break-words">
                  {sponsorData.note}
                </p>
              ) : null}
            </div>
          ) : sponsorData?.enabled ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <Heart className="w-8 h-8 text-[#bf5af2]/40" aria-hidden="true" />
              <p className="text-sm text-white/70">赞助通道即将开放，敬请期待。</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10">
              <Heart className="w-8 h-8 text-white/20" aria-hidden="true" />
              <p className="text-sm text-white/50">暂未开放，敬请期待。</p>
            </div>
          )}

          {/* 祝福语（工单 2026-11-09）：右下角入口，独立于赞助开关，所有状态可用 */}
          <div className="pt-2 mt-1 border-t border-white/5">
            {blessDone ? (
              <div
                role="status"
                className="flex items-center justify-end gap-1.5 text-xs text-emerald-300 py-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                祝福已送达，感谢支持！
              </div>
            ) : blessOpen ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
                <Textarea
                  value={blessContent}
                  maxLength={100}
                  rows={3}
                  placeholder="写一句祝福送给我们吧（1-100 字）…"
                  aria-label="祝福内容"
                  className="text-sm bg-transparent border-white/10 focus-visible:ring-[#a78bfa] resize-none"
                  onChange={(e) => { setBlessContent(e.target.value); setBlessError(null); }}
                />
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    type="text"
                    value={blessNick}
                    maxLength={20}
                    placeholder="署名（选填，≤20 字）"
                    aria-label="祝福署名（可选）"
                    className="flex-1 min-h-[36px] h-9 rounded-lg bg-transparent border border-white/10 px-2.5 text-xs text-white/80 placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                    onChange={(e) => { setBlessNick(e.target.value); setBlessError(null); }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/30 tabular-nums sm:mr-auto">
                      {blessContent.length}/100
                    </span>
                    <button
                      type="button"
                      onClick={() => { setBlessOpen(false); setBlessError(null); }}
                      disabled={blessSending}
                      className="min-h-[36px] px-3 rounded-lg text-xs text-white/50 hover:text-white/80 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                    >
                      收起
                    </button>
                    <button
                      type="button"
                      onClick={submitBlessing}
                      disabled={blessSending || !blessContent.trim()}
                      className="min-h-[36px] px-4 rounded-lg bg-[#7c6fd0] hover:bg-[#8b7fdd] disabled:opacity-40 disabled:hover:bg-[#7c6fd0] transition-colors text-xs font-semibold flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                    >
                      {blessSending ? (
                        <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" aria-hidden="true" />
                      ) : (
                        <Send className="w-3 h-3" aria-hidden="true" />
                      )}
                      送出祝福
                    </button>
                  </div>
                </div>
                {blessError ? (
                  <p className="text-[11px] text-red-300" role="alert">{blessError}</p>
                ) : null}
              </div>
            ) : (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setBlessOpen(true)}
                  className="min-h-[36px] px-3 rounded-lg text-xs text-white/55 hover:text-[#c9b8f5] transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                  aria-expanded={blessOpen}
                >
                  <Sparkles className="w-3.5 h-3.5 text-[#bf5af2]" aria-hidden="true" />
                  送祝福
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
