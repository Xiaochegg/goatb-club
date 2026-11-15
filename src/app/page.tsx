'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { useSpotlight } from '@/components/fx/fx-spotlight-card';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Palette, RefreshCw, MessageCircle,
  Shield, ChevronUp, Heart, Star,
  Lock, X, Plus, Trash2, Save, FileDown, FileUp,
  RotateCcw, ArrowUp, ArrowDown, Volume2, VolumeX, Send,
  Sparkles, Eye, EyeOff, Info, Settings, Zap,
  ChevronRight, ChevronLeft, AlertTriangle, Home, User, TrendingDown, Minus,
  Play, Pause, SkipForward, SkipBack, Shuffle, ListMusic, Loader2, Mail,
  SlidersHorizontal, Users, Trophy, Music, KeyRound, CheckCircle2,
} from 'lucide-react';
import { useAppStore, type PlayerData } from '@/lib/store';
// 2026-11 环境兼容：管理员鉴权双通道（cookie 优先，X-Admin-Token 头回退）
import { adminFetch, setAdminToken, clearAdminToken } from '@/lib/admin-fetch';
import {
  BOARD_TABS, ALL_MODES, MODE_LABELS,
  JIAHAO_TIER_SCORES, TIER_COLORS, TIER_BG_COLORS,
  THEME_PRESETS, SPRING_ROYAL,
  getThemePanelPalette, getTiersForMode,
  type BoardMode, type GameMode, type Tier,
  type JiahaoTier, type ThemePreset, type PlayerStats,
  NORMAL_TIERS, JIAHAO_TIERS,
} from '@/lib/constants';
import {
  getPlayerTotalScore,
  type RatingBreakdown,
} from '@/lib/scoring';
import { useMediaQuery } from '@/lib/use-media-query';
import { useReveal } from '@/lib/use-reveal';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';
import dynamic from 'next/dynamic';
import { TierExplanation } from '@/components/tier-explanation';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { LeaderboardSkeleton } from '@/components/leaderboard-skeleton';
import { XtLeaderboard } from '@/components/xt-leaderboard';
import { StatsSidebar } from '@/components/stats-sidebar';
import { fetchNormalizedPlayers } from '@/lib/api';
import { BOOT_SCRIPT, WATCHDOG_SCRIPT, bootAwareFetch } from '@/lib/boot-data';
import { SiteBackground } from '@/components/site-background';
import { SiteEffects } from '@/components/site-effects';
import { TextMaskReveal } from '@/components/motion/TextMaskReveal';
import { FxLabLoader } from '@/components/fx/fx-lab-loader';

// ============================================================
// Heavy modals / drawers — lazy-loaded so the initial bundle for a
// normal visitor skips admin code, music player, player-detail and
// profile/claim UI. Each loads on first open (ssr:false because they
// are pure client islands with window/localStorage access).
//
// Prefetch strategy: after the page is idle for 2.5s, we preload the
// chunks in priority order (music > detail > profile > admin) so the
// first click is instant. Each import() is memoized so it only fires
// once. Admin chunk is loaded last (most visitors never need it).
// ============================================================
const LoadingShim = () => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
    <div className="w-8 h-8 border-2 border-jade-400/20 border-t-jade-500 rounded-full animate-spin" />
  </div>
);

const AdminPanel = dynamic(() => import('@/components/admin-panel').then(m => m.AdminPanel), { ssr: false, loading: () => null });
const PlayerEditDrawer = dynamic(() => import('@/components/admin-panel').then(m => m.PlayerEditDrawer), { ssr: false, loading: () => null });
// Task 41: MusicPlayerModal 已下线（迁移至左下角 mp-root 浮动图标播放器）
const PlayerDetailModal = dynamic(() => import('@/components/player-detail-modal').then(m => m.PlayerDetailModal), { ssr: false, loading: () => <LoadingShim /> });
const ProfilePanelModal = dynamic(() => import('@/components/profile-panel').then(m => m.ProfilePanelModal), { ssr: false, loading: () => <LoadingShim /> });

// Idle prefetch: warm the chunk cache so the first open is instant.
// Runs once on the client after the page settles.
let _prefetched = false;
function prefetchHeavyChunks() {
  if (_prefetched || typeof window === 'undefined') return;
  _prefetched = true;
  const schedule = (cb: () => void, delay: number) => setTimeout(cb, delay);
  // Prioritize the ones a normal visitor is most likely to open first.
  // OPT-B：music-player-modal 已下线（Task 41 后不在任何渲染树），停止白下载其 chunk。
  schedule(() => import('@/components/player-detail-modal').catch(() => {}), 400);
  schedule(() => import('@/components/profile-panel').catch(() => {}), 800);
  // 管理面板重组（批复 2026-11-08「管理员面板重组更精简，更便利拆包」）：
  // admin chunk 只对已登录管理员预热——访客 idle 不再下载后台代码
  // （verify 完成晚于 idle 的场景由下方 verify 成功分支补预热，双保险）。
  if (useAppStore.getState().isAdmin) {
    schedule(() => import('@/components/admin-panel').catch(() => {}), 1500);
  }
}

// ============================================================
// V6 · ModuleErrorBoundary (A2) — one module crashing must never
// take down the whole page. Wraps every island: widgets, sidebar,
// modals. Retry remounts the island in place.
// ============================================================
class ModuleErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: unknown) {
    console.error(`[goatb] module crash${this.props.label ? ` · ${this.props.label}` : ''}:`, err);
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        className="fixed bottom-24 right-3 lg:bottom-24 lg:right-4 z-[var(--z-dock)] liquid-glass-strong rounded-xl px-3 py-2 flex items-center gap-2 border border-white/10"
        style={{ background: 'rgba(20,20,40,0.92)' }}
        role="alert"
      >
        <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
        <span className="text-[10px] text-white/70">{this.props.label || '模块'}开小差了</span>
        <button onClick={() => this.setState({ hasError: false })} className="text-[10px] text-jade-400 hover:text-jade-300 font-medium">重试</button>
      </div>
    );
  }
}

// ============================================================
// V6 · DataHealthBar (巧思①) — 2px heartbeat at the very top.
// SILENT when healthy; amber while checking; red pulse on failure.
// Driven by the real data pipeline — no polling, no fake state.
// ============================================================
function DataHealthBar() {
  const apiHealth = useAppStore((s) => s.apiHealth);
  if (apiHealth === 'ok') return null;
  return (
    <div
      aria-hidden="true"
      className={`fixed top-0 left-0 right-0 h-[2px] z-[var(--z-health)] animate-pulse ${
        apiHealth === 'fail' ? 'bg-red-500/90' : 'bg-amber-400/80'
      }`}
    />
  );
}

// ============================================================
// Component: Announcement Banner — liquid glass pill
// ============================================================
function AnnouncementBanner() {
  const { announcement, announcementVisible, setAnnouncementVisible } = useAppStore();
  if (!announcement || !announcementVisible) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -12, filter: 'blur(6px)' }}
      transition={{ type: 'spring', stiffness: 280, damping: 24 }}
      className="mx-4 mt-2"
    >
      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-4 py-2.5 flex items-center gap-3">
        <Star className="w-4 h-4 text-secondary-foreground flex-shrink-0" />
        <p className="text-xs text-white/85 flex-1 leading-relaxed">{announcement}</p>
        <button
          onClick={() => setAnnouncementVisible(false)}
          className="liquid-press text-muted-foreground hover:text-white transition-colors flex-shrink-0 min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center -my-2"
          aria-label="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}





// ============================================================
// Filter Sheet — 已随旧榜单规格拆除（XT 规格替换 2026-10 用户指令）。
// XT 表格仅保留搜索过滤（内部绑定 store.searchQuery）。
// ============================================================

// ============================================================
// Live Notifier (M4) — listens to socket 'live' events and updates
// the store optimistically. Connects on mount, disconnects on unmount.
// No persistence, no polling — purely ephemeral real-time signals.
// ============================================================
function LiveNotifier() {
  const { triggerLiveLike, setLiveConnected } = useAppStore();
  const socketRef = useRef<ReturnType<typeof import('socket.io-client')['io']> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // CRITICAL (preview-load fix): delay connection until the page is fully
    // loaded. socket.io's default long-polling transport keeps one HTTP
    // request permanently in-flight, which prevents the preview panel's
    // "network idle" detection from ever settling — the preview would spin
    // forever. Waiting 3s + websocket-only transport keeps the first paint
    // completely free of hanging requests.
    timer = setTimeout(() => {
      if (cancelled) return;
      import('socket.io-client').then(({ io }) => {
        if (cancelled) return;
        // SA-11 故障恢复：显式 reconnection 配置 + 连接状态广播
        const socket = io('/?XTransformPort=3003', {
          transports: ['websocket'],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000,
        });
        socket.on('connect', () => setLiveConnected(true));
        socket.on('disconnect', () => setLiveConnected(false));
        socket.on('connect_error', () => setLiveConnected(false));
        socket.on('reconnect_attempt', () => setLiveConnected(false));
        socket.on('live', (data: { type: string; payload: unknown }) => {
          if (data.type === 'like' && typeof data.payload === 'string') {
            triggerLiveLike(data.payload);
          }
        });
        socketRef.current = socket;

        // Listen for local emit requests (from like button clicks)
        const onEmitRequest = (e: Event) => {
          const detail = (e as CustomEvent).detail as { type: string; payload: unknown };
          socket.emit('live', detail);
        };
        window.addEventListener('goatb:live-emit', onEmitRequest);
        (socketRef.current as unknown as { _cleanup?: () => void })._cleanup = () => {
          window.removeEventListener('goatb:live-emit', onEmitRequest);
        };
      });
    }, 3000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      const sock = socketRef.current as unknown as { _cleanup?: () => void; disconnect?: () => void };
      sock?._cleanup?.();
      sock?.disconnect?.();
      socketRef.current = null;
    };
  }, [triggerLiveLike]);

  return null; // headless component
}

// ============================================================
// Command Palette (Ctrl+K / ⌘K) — lightweight, zero-dependency.
// Static commands (navigation/actions) + debounced player search.
// Memory-safe: AbortController cancels stale requests, useEffect
// cleanup removes listeners, closing clears all transient state.
// ============================================================
type CommandItem = {
  id: string;
  label: string;
  description?: string;
  group: 'navigation' | 'admin' | 'actions';
  shortcut?: string;
  roles?: string[]; // undefined = all; otherwise allowed roles
  action: () => void;
};

function CommandPalette() {
  const {
    commandPaletteOpen, setCommandPaletteOpen,
    setActiveMode, setAdminPanelOpen, setAdminLoginOpen,
    setSelectedPlayerId, setDiyEditorOpen,
    isAdmin, adminRole, players, setPlayers,
    openWidget,
  } = useAppStore();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<Array<{ id: string; name: string; avatarUrl: string | null }>>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Global Ctrl+K / ⌘K listener ──
  // Skip when focus is in an input/textarea/select to avoid hijacking
  // the browser's native shortcuts (e.g. Ctrl+K in address bar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const target = e.target as HTMLElement;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
          return; // don't hijack typing
        }
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  // ── Reset state whenever palette opens/closes ──
  // Clearing on close prevents stale search results from lingering
  // in memory and avoids "flash of old results" on next open.
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSearchResults([]);
      setActiveIndex(0);
      setSearching(false);
      // autoFocus next tick (dialog mount)
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      // Cleanup: abort any in-flight search + clear debounce
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSearchResults([]);
      setSearching(false);
    }
  }, [commandPaletteOpen]);

  // ── Debounced player search with AbortController ──
  // Only triggers when query length >= 2 (avoid 1-char noise).
  // Each new keystroke aborts the previous request.
  useEffect(() => {
    if (!commandPaletteOpen) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();

    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(`/api/v1/players?search=${encodeURIComponent(q)}&limit=8`, {
          signal: ac.signal,
        });
        const data = await res.json();
        if (!ac.signal.aborted) {
          setSearchResults((data.players || []).map((p: Record<string, unknown>) => ({
            id: p.id as string,
            name: p.name as string,
            avatarUrl: (p.avatarUrl as string) || null,
          })));
        }
      } catch {
        // aborted or network error — silently ignore
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, commandPaletteOpen]);

  // ── Build command list (static, role-filtered) ──
  const commands = useMemo<CommandItem[]>(() => {
    const role = adminRole || (isAdmin ? 'ADMIN' : null);
    const items: CommandItem[] = [
      { id: 'go-home', label: '返回顶部', group: 'navigation', shortcut: 'G H', action: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
      { id: 'mode-total', label: '切换到总榜', group: 'navigation', action: () => setActiveMode('TOTAL') },
      { id: 'mode-emotion', label: '切换到感动榜', group: 'navigation', action: () => setActiveMode('EMOTION') },
      // Task 41: 音乐入口已迁移至左下角浮动图标（mp-root 播放器），菜单栏不再保留
      { id: 'open-chat', label: '打开实时聊天', group: 'actions', action: () => openWidget('chat') },
      // R3-T3 下架（批复 2026-11-08）：AI「社区助手」命令面板入口移除（留档：原 open-ai → openWidget('ai')）
      { id: 'open-theme', label: '打开主题编辑器', group: 'actions', action: () => setDiyEditorOpen(true) },
      // XT 规格替换：筛选面板/排序切换/空位切换随旧榜单规格拆除（2026-10 用户指令）
      // SA-09 无障碍：暂停/恢复所有动效（键盘可达，Ctrl+K 触发）
      { id: 'toggle-pause-motion', label: '暂停/恢复所有动效（无障碍）', group: 'actions', action: () => useAppStore.getState().setPausedMotion(!useAppStore.getState().pausedMotion) },
      { id: 'refresh', label: '刷新玩家数据', group: 'actions', action: async () => {
        setPlayers(await fetchNormalizedPlayers());
      }},
    ];

    // Admin-only commands (role-gated)
    if (isAdmin) {
      items.push({
        id: 'open-admin',
        label: '打开管理后台',
        group: 'admin',
        roles: ['OWNER', 'ADMIN', 'MODERATOR', 'VIEWER'],
        action: () => setAdminPanelOpen(true),
      });
      items.push({
        id: 'admin-login',
        label: '管理员登录',
        group: 'admin',
        action: () => setAdminLoginOpen(true),
      });
    }

    // OWNER-only commands
    if (role === 'OWNER') {
      items.push({
        id: 'seed-sandbox',
        label: '生成 100 名模拟玩家',
        description: '沙盒模式 · 测试用',
        group: 'admin',
        roles: ['OWNER'],
        action: async () => {
          await fetch('/api/v1/sandbox/seed?count=100', { method: 'POST' });
          setPlayers(await fetchNormalizedPlayers());
        },
      });
    }

    return items;
  }, [adminRole, isAdmin, setActiveMode, setDiyEditorOpen, setPlayers, setAdminPanelOpen, setAdminLoginOpen, openWidget]);

  // ── Filter static commands by query ──
  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // ── Combined flat list for keyboard nav (commands + search results) ──
  const flatItems = useMemo(() => {
    const cmdItems = filteredCommands.map(c => ({ type: 'command' as const, data: c }));
    const playerItems = query.trim().length >= 2 ? searchResults.map(p => ({ type: 'player' as const, data: p })) : [];
    return [...cmdItems, ...playerItems];
  }, [filteredCommands, searchResults, query]);

  // Reset active index when flat list changes
  useEffect(() => { setActiveIndex(0); }, [flatItems.length]);

  // ── Execute item by index ──
  const executeItem = useCallback((idx: number) => {
    const item = flatItems[idx];
    if (!item) return;
    if (item.type === 'command') {
      setCommandPaletteOpen(false);
      item.data.action();
    } else {
      setCommandPaletteOpen(false);
      setSelectedPlayerId(item.data.id);
    }
  }, [flatItems, setCommandPaletteOpen, setSelectedPlayerId]);

  // ── Keyboard nav inside palette ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setCommandPaletteOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeItem(activeIndex);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!commandPaletteOpen) return null;

  // Group commands for display
  const navCmds = filteredCommands.filter(c => c.group === 'navigation');
  const actionCmds = filteredCommands.filter(c => c.group === 'actions');
  const adminCmds = filteredCommands.filter(c => c.group === 'admin');
  const showPlayerResults = query.trim().length >= 2;

  let runningIdx = -1;
  const renderItem = (item: { type: 'command'; data: CommandItem } | { type: 'player'; data: { id: string; name: string; avatarUrl: string | null } }) => {
    runningIdx++;
    const idx = runningIdx;
    const active = idx === activeIndex;
    if (item.type === 'command') {
      return (
        <button
          key={`cmd-${item.data.id}`}
          data-idx={idx}
          onMouseEnter={() => setActiveIndex(idx)}
          onClick={() => executeItem(idx)}
          className={cn(
            'w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 transition-colors',
            active ? 'bg-jade-500/15 text-jade-400' : 'text-white/80 hover:bg-white/5'
          )}
        >
          <span className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">{item.data.label}</span>
            {item.data.description && <span className="text-[10px] text-muted-foreground truncate block">{item.data.description}</span>}
          </span>
          {item.data.shortcut && (
            <kbd className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground border border-white/5">{item.data.shortcut}</kbd>
          )}
        </button>
      );
    }
    return (
      <button
        key={`player-${item.data.id}`}
        data-idx={idx}
        onMouseEnter={() => setActiveIndex(idx)}
        onClick={() => executeItem(idx)}
        className={cn(
          'w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 transition-colors',
          active ? 'bg-jade-500/15' : 'hover:bg-white/5'
        )}
      >
        <div className="w-7 h-7 rounded-full v2b7-avatar flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={{ background: getAvatarColor(item.data.name) }}>
          {item.data.avatarUrl ? <img src={item.data.avatarUrl} alt="" className="w-full h-full rounded-full object-cover" /> : <span className="text-white">{getAvatarInitial(item.data.name)}</span>}
        </div>
        <span className="flex-1 min-w-0">
          <span className="text-sm font-medium text-white truncate block">{item.data.name}</span>
          <span className="text-[10px] text-muted-foreground truncate block">查看玩家详情</span>
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      </button>
    );
  };

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] px-4"
          onClick={() => setCommandPaletteOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            initial={{ y: -20, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: -10, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-lg liquid-glass-strong v2l-card v2b7-modal rounded-[var(--radius-liquid-lg)] overflow-hidden"
          >
            {/* Search input */}
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/8">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="搜索命令或玩家...（↑↓ 选择，Enter 执行，Esc 关闭）"
                aria-label="命令搜索"
                className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
              />
              <kbd className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground border border-white/10 flex-shrink-0">ESC</kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[50vh] overflow-y-auto custom-scrollbar v2l-scroll p-2">
              {flatItems.length === 0 && !searching && (
                <div className="py-8 text-center">
                  <p className="text-xs text-muted-foreground">没有匹配的命令或玩家</p>
                </div>
              )}

              {navCmds.length > 0 && (
                <div className="mb-1">
                  <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-[0.16em] px-3 py-1.5">导航</div>
                  {navCmds.map(c => renderItem({ type: 'command', data: c }))}
                </div>
              )}

              {actionCmds.length > 0 && (
                <div className="mb-1">
                  <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-[0.16em] px-3 py-1.5">操作</div>
                  {actionCmds.map(c => renderItem({ type: 'command', data: c }))}
                </div>
              )}

              {adminCmds.length > 0 && (
                <div className="mb-1">
                  <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-[0.16em] px-3 py-1.5">管理</div>
                  {adminCmds.map(c => renderItem({ type: 'command', data: c }))}
                </div>
              )}

              {showPlayerResults && (
                <div>
                  <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-[0.16em] px-3 py-1.5 flex items-center gap-1.5">
                    玩家
                    {searching && <Loader2 className="w-3 h-3 animate-spin" />}
                  </div>
                  {searchResults.length === 0 && !searching ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">未找到匹配玩家</div>
                  ) : (
                    searchResults.map(p => renderItem({ type: 'player', data: p }))
                  )}
                </div>
              )}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-white/8 flex items-center justify-between text-[9px] text-muted-foreground/60">
              <span className="flex items-center gap-1.5">
                <kbd className="font-mono px-1 py-0.5 rounded bg-white/5 border border-white/5">↑↓</kbd> 导航
                <kbd className="font-mono px-1 py-0.5 rounded bg-white/5 border border-white/5 ml-1">Enter</kbd> 执行
              </span>
              <span>{flatItems.length} 项</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// Component: Admin Login Modal
// ============================================================
function AdminLoginModal() {
  const { adminLoginOpen, setAdminLoginOpen, setIsAdmin, setAdminPanelOpen, setAdminRole, setAdminUsername } = useAppStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        // 环境兼容：保存 token（sessionStorage），iframe/HTTP 环境下 cookie 被拦时走头回退
        if (data.token) setAdminToken(data.token);
        setIsAdmin(true);
        setAdminRole(data.role || 'ADMIN');
        setAdminUsername(data.username || 'admin');
        setAdminLoginOpen(false);
        setAdminPanelOpen(true);
        setUsername('');
        setPassword('');
      } else {
        setError(data.error || '登录失败 — 请检查凭据是否正确');
      }
    } catch {
      setError('网络连接失败 — 请检查网络后重试');
    }
    setLoading(false);
  };

  return (
    <AnimatePresence>
      {adminLoginOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-3"
          onClick={() => setAdminLoginOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="管理员登录"
            initial={{ y: 24, scale: 0.92, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.85, opacity: 0, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.9 }}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-sm liquid-glass-strong v2l-card v2b7-modal rounded-[var(--radius-liquid-lg)] overflow-hidden"
          >
            {/* Gold gradient accent bar */}
            <div className="h-1 gold-bar" />
            <div className="p-6 relative z-10">
              <div className="flex flex-col items-center gap-2 mb-6">
                <div className="w-12 h-12 rounded-[var(--radius-liquid-md)] liquid-glass-subtle flex items-center justify-center">
                  <Shield className="w-6 h-6 text-secondary-foreground" />
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">管理员登录</h2>
                <p className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">Admin Access</p>
              </div>

              <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3 transition-all focus-within:border-secondary-foreground/30">
                <User className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && password && handleLogin()}
                  placeholder="输入管理员用户名"
                  aria-label="管理员用户名"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                  autoFocus
                />
              </div>

              <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3 transition-all focus-within:border-secondary-foreground/30">
                <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && username.trim() && handleLogin()}
                  placeholder="输入密码"
                  aria-label="管理员密码"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                />
              </div>

              <AnimatePresence>
                {error && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-xs text-[var(--system-red)] mb-3 flex items-center gap-1.5 px-1"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
                  </motion.p>
                )}
              </AnimatePresence>

              <motion.button
                onClick={handleLogin}
                disabled={loading || !password || !username.trim()}
                whileTap={{ scale: 0.97 }}
                className="liquid-press liquid-pill-active w-full py-3 rounded-[var(--radius-liquid-md)] font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>登录中...</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    <span>登录</span>
                  </>
                )}
              </motion.button>

              <button
                onClick={() => setAdminLoginOpen(false)}
                className="liquid-press w-full mt-2 py-2 text-xs text-muted-foreground hover:text-white transition-colors"
              >
                取消
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// Component: Player Auth Modal — 玩家自助注册/登录
// 注册即录入榜单（空段位/战绩，管理员后续填写）
// 登录后认领自己的 Player 条目，但不能改分
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）：
//   - 「忘记密码」提示视图（工单一：取消邮件找回，不发送邮件/不生成验证码）
//   - 强制改密视图（工单三：临时密码首登后必须改密，改完才能继续使用，不可跳过）
// ============================================================
function PlayerAuthModal() {
  const { playerAuthOpen, setPlayerAuthOpen, setPlayer, player } = useAppStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  // PHASE 3：form = 登录/注册表单；forgot = 忘记密码提示（工单文案）
  const [view, setView] = useState<'form' | 'forgot'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 认领通道直达（工单 2026-11-12）：注册撞匿名/占位邮箱条目 → 直达认领申请
  // claimTarget = 被撞的代录条目；hasPlaceholderEmail = 目标带管理员占位邮箱；
  // claimOk = 申请已提交
  const [claimTarget, setClaimTarget] = useState<{ id: string; name: string; hasPlaceholderEmail?: boolean } | null>(null);
  const [claimOk, setClaimOk] = useState(false);
  const [claimNote, setClaimNote] = useState('');

  // 准确度修复（批示 trace 1a1d027ae7f6abd1 根因③）：认领态随弹窗打开重置——
  // 修复前撞名进入认领模式后关闭弹窗，重开仍残留在认领横幅/提交按钮态。
  // 官方「渲染期调整状态」模式（比较上一渲染值，替代 effect 内 setState，
  // 规避 react-hooks/set-state-in-effect）：仅在 open 的上升沿执行，
  // 不影响本次会话内已设置的认领目标。
  const [prevAuthOpen, setPrevAuthOpen] = useState(playerAuthOpen);
  if (playerAuthOpen !== prevAuthOpen) {
    setPrevAuthOpen(playerAuthOpen);
    if (playerAuthOpen) {
      setClaimTarget(null);
      setClaimOk(false);
      setClaimNote('');
      setError('');
      setView('form');
    }
  }

  // PHASE 3 强制改密：临时密码登录后 player.mustChangePassword=true，
  // 弹窗打开期间无条件渲染改密视图，不可跳过/关闭（工单三硬要求）
  const forceMustChange = Boolean(playerAuthOpen && player?.mustChangePassword);
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState('');

  const handleSubmit = async () => {
    setLoading(true);
    setError('');
    try {
      const endpoint = mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const body = mode === 'login'
        ? { email, password }
        : { email, password, name };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setPlayer(data.player);
        // PHASE 3：临时密码首登（mustChangePassword=true）→ 保持弹窗打开，
        // forceMustChange 自动接管渲染强制改密视图；正常登录/注册 → 关闭
        if (!data.player?.mustChangePassword) {
          setPlayerAuthOpen(false);
          setEmail(''); setPassword(''); setName('');
        }
        setView('form');
      } else if (mode === 'register' && res.status === 409 && data?.claimAvailable && data?.targetPlayerId) {
        // 注册撞代录条目（匿名/占位邮箱）→ 开启认领通道（不发死路文案）
        setClaimTarget({
          id: data.targetPlayerId,
          name: data.targetName || name.trim(),
          hasPlaceholderEmail: !!data.targetHasEmail,
        });
        setError('');
      } else {
        setError(data.error || '操作失败');
      }
    } catch {
      setError('网络连接失败 — 请检查网络后重试');
    }
    setLoading(false);
  };

  // 认领通道直达：提交认领申请（POST /api/v1/auth/register-claim）
  // 邮箱/密码复用表单既有输入；申请阶段不创建账号（管理员确认后凭据落到原条目）
  const submitClaim = async () => {
    if (loading || !claimTarget) return;
    if (!email || !password) { setError('填写邮箱和密码后即可提交认领申请'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/v1/auth/register-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: claimTarget.name, note: claimNote }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.ok || data.success)) {
        setClaimOk(true);
        setPassword('');
      } else {
        setError(data.error || '提交失败，请稍后再试');
      }
    } catch {
      setError('网络连接失败 — 请检查网络后重试');
    }
    setLoading(false);
  };

  // PHASE 3：强制改密提交（当前密码=管理员下发的临时密码）
  const handleChangePassword = async () => {
    if (changing) return;
    setChangeError('');
    if (!curPwd || !newPwd) { setChangeError('当前密码和新密码均为必填'); return; }
    if (newPwd.length < 6) { setChangeError('新密码至少 6 位'); return; }
    if (newPwd !== newPwd2) { setChangeError('两次输入的新密码不一致'); return; }
    setChanging(true);
    try {
      const res = await fetch('/api/v1/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setPlayer(player ? { ...player, mustChangePassword: false } : null);
        setCurPwd(''); setNewPwd(''); setNewPwd2('');
        setPlayerAuthOpen(false);
      } else {
        setChangeError(data.error || '修改失败，请重试');
      }
    } catch {
      setChangeError('网络连接失败 — 请检查网络后重试');
    }
    setChanging(false);
  };

  return (
    <AnimatePresence>
      {playerAuthOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-3"
          onClick={() => { if (!forceMustChange) setPlayerAuthOpen(false); }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={forceMustChange ? '设置新密码' : mode === 'login' ? '玩家登录' : '玩家注册'}
            initial={{ y: 24, scale: 0.92, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.85, opacity: 0, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 220, damping: 24, mass: 0.9 }}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-sm liquid-glass-strong v2l-card v2b7-modal rounded-[var(--radius-liquid-lg)] overflow-hidden"
          >
            <div className="h-1 gold-bar" />
            <div className="p-6 relative z-10">
              <div className="flex flex-col items-center gap-2 mb-6">
                <div className="w-12 h-12 rounded-[var(--radius-liquid-md)] liquid-glass-subtle flex items-center justify-center">
                  {forceMustChange ? (
                    <KeyRound className="w-6 h-6 text-secondary-foreground" />
                  ) : (
                    <User className="w-6 h-6 text-secondary-foreground" />
                  )}
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">
                  {forceMustChange ? '设置新密码' : mode === 'login' ? '玩家登录' : '玩家注册'}
                </h2>
                <p className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">
                  {forceMustChange ? 'Set New Password' : mode === 'login' ? 'Player Login' : 'Player Register'}
                </p>
              </div>

              {/* PHASE 3 强制改密视图（工单三：临时密码首登后必须修改，不可跳过） */}
              {forceMustChange ? (
                <>
                  <p className="text-xs text-white/70 mb-3 leading-relaxed px-1">
                    检测到你正在使用管理员重置的临时密码，请设置新密码后继续使用。
                  </p>
                  <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                    <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <input
                      type="password"
                      value={curPwd}
                      onChange={e => setCurPwd(e.target.value)}
                      placeholder="当前密码（即临时密码）"
                      aria-label="当前密码"
                      className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                      autoFocus
                    />
                  </div>
                  <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                    <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <input
                      type="password"
                      value={newPwd}
                      onChange={e => setNewPwd(e.target.value)}
                      placeholder="新密码（至少 6 位）"
                      aria-label="新密码"
                      className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                    />
                  </div>
                  <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                    <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <input
                      type="password"
                      value={newPwd2}
                      onChange={e => setNewPwd2(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && curPwd && newPwd && handleChangePassword()}
                      placeholder="确认新密码"
                      aria-label="确认新密码"
                      className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                    />
                  </div>
                  <AnimatePresence>
                    {changeError && (
                      <motion.p
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="text-xs text-[var(--system-red)] mb-3 flex items-center gap-1.5 px-1"
                      >
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {changeError}
                      </motion.p>
                    )}
                  </AnimatePresence>
                  <motion.button
                    onClick={handleChangePassword}
                    disabled={changing || !curPwd || !newPwd || !newPwd2}
                    whileTap={{ scale: 0.97 }}
                    className="liquid-press liquid-pill-active w-full py-3 rounded-[var(--radius-liquid-md)] font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {changing ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /><span>提交中...</span></>
                    ) : (
                      <><span>设置新密码并继续</span></>
                    )}
                  </motion.button>
                </>
              ) : view === 'forgot' ? (
                /* PHASE 3 忘记密码提示视图（工单一指定文案：取消邮件找回） */
                <>
                  <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-4 py-4 mb-3">
                    <p className="text-sm text-white/90 leading-relaxed text-center">
                      如果你忘记了密码，请联系管理员申请重置。
                      管理员核实身份后，将为你重置账号密码。
                    </p>
                  </div>
                  <p className="text-[10px] text-muted-foreground/70 text-center leading-relaxed mb-3 px-2">
                    本站不发送验证邮件；重置后的临时密码请妥善保管，登录后需立即设置新密码。
                  </p>
                  <button
                    onClick={() => { setView('form'); setError(''); }}
                    className="liquid-press w-full py-3 rounded-[var(--radius-liquid-md)] font-semibold text-sm liquid-pill-active flex items-center justify-center gap-2"
                  >
                    <span>返回登录</span>
                  </button>
                </>
              ) : (
                <>
              {/* 认领通道直达（工单 2026-11-12）：注册撞代录条目 → 直达认领申请 */}
              {mode === 'register' && claimTarget && !claimOk && (
                <div className="rounded-[var(--radius-liquid-md)] border border-jade-500/40 bg-jade-500/10 px-3 py-2.5 mb-3">
                  <p className="text-[11px] text-jade-300 leading-relaxed">
                    「{claimTarget.name}」已有榜单条目（管理员代录{claimTarget.hasPlaceholderEmail ? '，当前为占位邮箱' : ''}）。如果你的就是这条，填好邮箱和密码后
                    直接提交认领申请 —— 管理员确认后，该条目{claimTarget.hasPlaceholderEmail ? '的占位邮箱将替换为你的邮箱' : '将改绑你的邮箱'}，之后用邮箱登录即可。
                  </p>
                  <input
                    type="text"
                    value={claimNote}
                    onChange={e => setClaimNote(e.target.value)}
                    placeholder="向管理员补充说明（可选，≤100 字）"
                    aria-label="认领备注"
                    maxLength={100}
                    className="w-full bg-transparent text-[11px] text-white placeholder:text-muted-foreground/60 focus:outline-none mt-2 border-t border-white/10 pt-2"
                  />
                </div>
              )}
              {mode === 'register' && claimOk && (
                <div className="rounded-[var(--radius-liquid-md)] border border-jade-500/40 bg-jade-500/10 px-3 py-3 mb-3">
                  <p className="text-[12px] text-jade-300 font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 认领申请已提交
                  </p>
                  <p className="text-[11px] text-white/70 leading-relaxed mt-1">
                    「{claimTarget?.name}」的认领申请已进入管理员审批队列。通过后该条目即绑定你填写的邮箱，
                    用邮箱 + 密码登录即可查看积分与段位。
                  </p>
                  <button
                    onClick={() => { setClaimTarget(null); setClaimOk(false); setClaimNote(''); setError(''); }}
                    className="liquid-press mt-2 text-[11px] text-muted-foreground hover:text-white transition-colors"
                  >
                    返回
                  </button>
                </div>
              )}

              {mode === 'register' && !claimTarget && !claimOk && (
                <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                  <User className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="游戏ID（将显示在榜单）"
                    aria-label="游戏ID"
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                    autoFocus
                  />
                </div>
              )}

              <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="邮箱"
                  aria-label="邮箱"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                  autoFocus={mode === 'login'}
                />
              </div>

              <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] flex items-center gap-2 px-3 py-3 mb-3">
                <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && email && password && (mode === 'login' || name.trim() || claimTarget) && (claimTarget && !claimOk ? submitClaim() : handleSubmit())}
                  placeholder="密码（至少 6 位）"
                  aria-label="密码"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
                />
              </div>

              <AnimatePresence>
                {error && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-xs text-[var(--system-red)] mb-3 flex items-center gap-1.5 px-1"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
                  </motion.p>
                )}
              </AnimatePresence>

              <motion.button
                onClick={mode === 'register' && claimTarget && !claimOk ? submitClaim : handleSubmit}
                disabled={loading || !email || !password || (mode === 'register' && !claimTarget && !name.trim()) || (mode === 'register' && claimOk)}
                whileTap={{ scale: 0.97 }}
                className="liquid-press liquid-pill-active w-full py-3 rounded-[var(--radius-liquid-md)] font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /><span>{mode === 'login' ? '登录中...' : claimTarget ? '提交中...' : '注册中...'}</span></>
                ) : (
                  <><span>{mode === 'login' ? '登录' : claimTarget ? '提交认领申请' : '注册'}</span></>
                )}
              </motion.button>

              <button
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); if (mode === 'register') { setClaimTarget(null); setClaimOk(false); setClaimNote(''); } }}
                className="liquid-press w-full mt-2 py-2 text-xs text-muted-foreground hover:text-white transition-colors"
              >
                {mode === 'login' ? '没有账号？去注册' : claimTarget ? '换个游戏ID注册' : '已有账号？去登录'}
              </button>

              {/* PHASE 3 忘记密码入口（工单一：提示文案，不发送邮件） */}
              {mode === 'login' && (
                <button
                  onClick={() => { setView('forgot'); setError(''); }}
                  className="liquid-press w-full py-2 text-xs text-muted-foreground hover:text-white transition-colors"
                >
                  忘记密码？
                </button>
              )}

              <button
                onClick={() => setPlayerAuthOpen(false)}
                className="liquid-press w-full mt-1 py-2 text-xs text-muted-foreground hover:text-white transition-colors"
              >
                取消
              </button>

              {mode === 'register' && (
                <p className="text-[10px] text-muted-foreground/60 mt-3 text-center leading-relaxed">
                  注册后你的游戏ID将录入榜单，积分/段位由管理员填写
                </p>
              )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// Component: DIY Editor Modal
// ============================================================
function DiyEditorModal() {
  const { diyEditorOpen, setDiyEditorOpen, setTheme, theme, setCustomBg } = useAppStore();

  const applyPreset = (key: ThemePreset) => {
    setTheme(key);
    setCustomBg(null);
    if (typeof window !== 'undefined') {
      localStorage.setItem('goatb-theme', key);
      localStorage.removeItem('goatb-bg');
    }
  };

  return (
    <AnimatePresence>
      {diyEditorOpen && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-end justify-center" onClick={() => setDiyEditorOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="DIY编辑器"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={SPRING_ROYAL}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-lg liquid-glass-strong v2l-card v2b7-modal rounded-t-[var(--radius-liquid-lg)] p-6 max-h-[85vh] overflow-y-auto custom-scrollbar v2l-scroll"
          >
            <div className="h-1 w-12 rounded-full bg-white/20 mx-auto mb-4" />
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Palette className="w-5 h-5 text-secondary-foreground" /> DIY 编辑器
              </h3>
              <button
                onClick={() => setDiyEditorOpen(false)}
                aria-label="关闭主题编辑器"
                className="p-1.5 rounded-lg text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2 mb-4">
              {Object.entries(THEME_PRESETS).map(([key, preset]) => (
                <motion.button
                  key={key}
                  onClick={() => applyPreset(key as ThemePreset)}
                  aria-label={preset.name}
                  className={`v2b7-preset spring-press-subtle p-2 rounded-xl text-center transition-all ${theme === key ? 'ring-2 ring-jade-400' : ''}`}
                  style={{ background: preset.bg + 'cc' }}
                >
                  <div className="w-4 h-4 rounded-full mx-auto mb-1" style={{ background: preset.accent }} />
                  <span className="text-[10px] text-white">{preset.name}</span>
                </motion.button>
              ))}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">上传自定义背景图片</label>
              <input
                type="file"
                accept="image/*"
                onChange={handleBgUpload}
                className="w-full mt-2 text-xs text-muted-foreground file:mr-2 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:bg-jade-500/20 file:text-jade-400"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-2">WebP压缩 · 最大1920px · 质量0.8 · 仅保存在本地</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function handleBgUpload(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    if (dataUrl.length > 0.5 * 1024 * 1024) {
      alert('图片过大，请选择小于0.5MB的图片');
      return;
    }
    useAppStore.getState().setCustomBg(dataUrl);
  };
  reader.readAsDataURL(file);
}

// ============================================================
// Component: Chat Modal (WebSocket via socket.io)
// ============================================================
function ChatModal() {
  const { chatOpen, setChatOpen } = useAppStore();
  const [messages, setMessages] = useState<Array<{ id: string; text: string; sender: string }>>([]);
  const [input, setInput] = useState('');
  const [nickname] = useState('游客' + Math.floor(Math.random() * 1000));
  const [onlineCount, setOnlineCount] = useState(0);
  const socketRef = useRef<ReturnType<typeof import('socket.io-client')['io']> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // V6: connect once on first open, then STAY connected for the page
  // lifetime — messages arriving while the panel is stowed feed the
  // dock's unread badge (one lightweight websocket, no polling)
  useEffect(() => {
    if (!chatOpen || socketRef.current) return;
    let cancelled = false;
    import('socket.io-client').then(({ io }) => {
      if (cancelled || socketRef.current) return;
      const socket = io('/?XTransformPort=3003', {
        transports: ['websocket', 'polling'],
        // SA-11 故障恢复：显式 reconnection 配置
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      });
      socket.on('recent', (msgs: Array<{ id: string; text: string; sender: string }>) => {
        setMessages(msgs);
      });
      socket.on('message', (msg: { id: string; text: string; sender: string }) => {
        setMessages(prev => [...prev, msg]);
        const st = useAppStore.getState();
        if (msg.sender !== nickname && !st.chatOpen) st.bumpChatUnread();
      });
      // V6 audit: online count broadcast — lets the user see if anyone
      // else is around before they start typing into the void
      socket.on('online', (count: number) => setOnlineCount(count));
      socketRef.current = socket;
    });
    return () => { cancelled = true; };
  }, [chatOpen, nickname]);

  // Opening the panel clears the unread badge
  useEffect(() => {
    if (chatOpen) useAppStore.getState().clearChatUnread();
  }, [chatOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    // 彩蛋暗号（批示 trace 1a1cf86a8dee8aa9）：输入「君慕礼服」→ 跳转彩蛋页，
    // 不发往聊天室（防剧透）；其余消息不受影响。批示HTML落盘于
    // public/eggs/junmu-dress.html，页面"返回"= history.back() 回到站点。
    if (text === '君慕礼服') {
      setInput('');
      setChatOpen(false);
      window.location.assign('/eggs/junmu-dress.html');
      return;
    }
    socketRef.current?.emit('message', { text, sender: nickname });
    setInput('');
  };

  return (
    <AnimatePresence>
      {chatOpen && (
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="fixed bottom-40 left-3 right-3 sm:left-auto sm:right-20 sm:w-80 lg:bottom-24 lg:right-20 z-[var(--z-widget)] h-[50dvh] lg:h-96 max-h-[calc(100dvh-190px)] min-h-0 liquid-glass-strong v2l-card v2b7-modal rounded-[var(--radius-liquid-lg)] overflow-hidden flex flex-col" style={{ background: 'rgba(20,20,40,0.95)' }}>
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
            <h4 className="text-sm font-medium text-white flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-jade-400" /> 实时聊天
              <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className={`w-1.5 h-1.5 rounded-full ${onlineCount > 1 ? 'bg-emerald-400' : 'bg-white/30'}`} />
                在线 {onlineCount}
              </span>
            </h4>
            <button onClick={() => setChatOpen(false)} className="text-muted-foreground hover:text-white" aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar v2l-scroll">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8">
                {onlineCount <= 1 ? '当前只有你在线，发言会留存，其他人进来后能看到。' : '暂无消息，快来聊天吧！'}
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={msg.id || i} className={`flex ${msg.sender === nickname ? 'justify-end' : 'justify-start'}`}>
                <span className={`px-3 py-1.5 rounded-xl text-xs ${msg.sender === nickname ? 'bg-jade-500/15 text-jade-400' : 'bg-white/10 text-white'}`}>
                  {msg.sender !== nickname && <span className="text-muted-foreground text-[10px] mr-1">{msg.sender}</span>}
                  {msg.text}
                </span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="divider-refined" />
          {/* 彩蛋暗号提示（可发现性优先；如需隐藏删除本行即可——批次报告已披露） */}
          <p className="px-3 pt-2 text-[10px] text-muted-foreground/70">彩蛋暗号 · 君慕礼服</p>
          <div className="p-3 flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="输入消息..." className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background" />
            <motion.button onClick={send} className="spring-press-subtle px-3 py-2 rounded-xl bg-jade-500/15 text-jade-400" aria-label="发送"><Send className="w-4 h-4" /></motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ============================================================
// Component: AI Assistant
// ============================================================
function AiAssistant() {
  const aiAssistantOpen = useAppStore((s) => s.aiAssistantOpen);
  const setAiAssistantOpen = useAppStore((s) => s.setAiAssistantOpen);
  const players = useAppStore((s) => s.players);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: '你好！我是GOATB社区助手，有什么可以帮你的吗？😊' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const quickSuggestions = ['谁第一名？', '前5名都有谁？', '段位规则是什么？', 'HT1比HT2多多少分？'];

  const send = async (text?: string) => {
    const content = text || input.trim();
    if (!content || loading) return;
    setInput('');
    const newMessages = [...messages, { role: 'user' as const, content }];
    setMessages(newMessages);
    setLoading(true);

    try {
      // Build context with current leaderboard data
      const topPlayers = [...players].sort((a, b) => getPlayerTotalScore(b) - getPlayerTotalScore(a)).slice(0, 10);
      const contextInfo = topPlayers.map((p, i) => `${i + 1}. ${p.name} - ${getPlayerTotalScore(p)}`).join('\n');

      const res = await fetch('/api/v1/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          systemPrompt: `你是GOATB社区排榜的AI助手。当前排行榜数据：\n${contextInfo}\n\n请用简洁友好的中文回答。`,
        }),
      });

      const text = await res.text();
      setMessages([...newMessages, { role: 'assistant', content: text || '抱歉，我暂时无法回答。' }]);
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: '网络错误，请稍后重试。' }]);
    }
    setLoading(false);
  };

  return (
    <>
      {/* V6: launcher FAB removed — the WidgetDock owns all widget entry
          points now (chat / AI / music used to float here separately) */}

      {/* Chat panel */}
      <AnimatePresence>
        {aiAssistantOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={SPRING_ROYAL}
            className="fixed bottom-40 left-3 right-3 sm:left-auto sm:right-20 sm:w-80 lg:bottom-24 lg:right-20 lg:w-96 z-[var(--z-widget)] liquid-glass-strong v2l-card v2b7-modal rounded-[var(--radius-liquid-lg)] overflow-hidden flex flex-col"
            style={{ background: 'rgba(20,20,40,0.95)', backdropFilter: 'blur(16px)', maxHeight: 'min(500px, calc(100dvh - 190px))' }}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-jade-400" /> GOATB社区助手
                </h4>
                <p className="text-[10px] text-jade-400">在线 · 排行榜v5.0</p>
              </div>
              <button onClick={() => setAiAssistantOpen(false)} className="text-muted-foreground hover:text-white" aria-label="关闭">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar v2l-scroll min-h-0">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                    msg.role === 'user' ? 'bg-jade-500/15 text-jade-400' : 'bg-white/10 text-white/90'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-white/10 text-white/50 px-3 py-2 rounded-xl text-xs animate-pulse">思考中...</div>
                </div>
              )}
            </div>

            {/* Quick suggestions */}
            {messages.length <= 1 && (
              <div className="px-3 pb-2 flex flex-wrap gap-1">
                {quickSuggestions.map(s => (
                  <button key={s} onClick={() => send(s)} className="px-2 py-1 rounded-lg text-[10px] border border-jade-400/20 text-jade-400 hover:bg-jade-500/10">
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="divider-refined" />
            <div className="p-3 flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="输入问题..."
                className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none focus:border-jade-400/30 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
              <motion.button
                onClick={() => send()}
                disabled={loading}
                aria-label="发送"
                className="spring-press-subtle px-3 py-2 rounded-xl bg-jade-500 text-jade-900 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ============================================================
// V3 · Liquid Glass Dock (trace 1a1d6d98a9b358a5) — 统一底部交互中心。
// 取代 LiquidCapsuleNav（移动胶囊 + 桌面左竖轨）与 WidgetDock（FAB + 托盘）：
// 两档断点同为一枚液态玻璃胶囊，底部居中，仅此一枚悬浮栏。
//   两断点统一 6 项：首页 / 榜单 / 聊天(未读徽标) / 音乐(EQ) / 主题 / 我的。
//   音乐项：既有规则 .mp-icon{display:none!important}（管理员 2026-11-05
//   授权"音乐入口收纳进 Dock"）已全局隐藏播放器收起圆钮，Dock 音乐项
//   就是唯一音乐入口（window.MusicPlayer?.toggle() 公开 API）。
// WidgetDock 冻结行为原样迁入（2026-11-06 Batch2 闸门批次）：
//   · 1.5s 只读观测播放器公开 aria-label / mp-root class（既有机制迁移，
//     非新增轮询；查询代价 = 2×querySelector/1.5s）
//   · 首访 mp-collapsed='1' 预置
// 液态玻璃语言（FX-07 延续 + 实站研究 DNA，纯 CSS）：
//   · layoutId 弹簧选中透镜（挤压→落位→回弹手感）
//   · 指针高光（--sx/--sy）边缘响应
//   · Light Sweep 光带 + Active 彗星光环（CSS 合成器动画；
//     prefers-reduced-motion / 暂停动效开关时静止）
// ============================================================
function EqBars() {
  return (
    <span className="absolute -top-1 -right-1 flex items-end gap-[2px]" aria-hidden="true">
      <span className="dock-eq-bar" style={{ animationDelay: '0ms' }} />
      <span className="dock-eq-bar" style={{ animationDelay: '180ms' }} />
      <span className="dock-eq-bar" style={{ animationDelay: '360ms' }} />
    </span>
  );
}

interface DockItem {
  id: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  action: () => void;
  unread?: number;
  eq?: boolean;       // 音乐进行中 → EQ 生命条
  isActive?: boolean; // 外部活跃态（音乐面板展开）；瞬时入口不占导航选中位
}

function LiquidGlassDock() {
  const setActiveMode = useAppStore((s) => s.setActiveMode);
  const openWidget = useAppStore((s) => s.openWidget);
  const setDiyEditorOpen = useAppStore((s) => s.setDiyEditorOpen);
  const setProfileOpen = useAppStore((s) => s.setProfileOpen);
  const chatUnread = useAppStore((s) => s.chatUnread);
  const musicPlaying = useAppStore((s) => s.musicPlaying);
  const setMusicPlaying = useAppStore((s) => s.setMusicPlaying);
  const pausedMotion = useAppStore((s) => s.pausedMotion);
  const [activeId, setActiveId] = useState('board');
  const [musicOpen, setMusicOpen] = useState(false);
  // FX-07 指针液态高光：pointermove 写 --sx/--sy 到 nav 玻璃
  // （globals.css .nav-capsule background/::after 边缘金光响应），零 state 零 rAF。
  const glassGlow = useSpotlight<HTMLElement>();

  // ── 冻结行为原样迁入自 WidgetDock（非新增轮询）──
  useEffect(() => {
    try {
      if (window.localStorage.getItem('mp-collapsed') === null) {
        window.localStorage.setItem('mp-collapsed', '1');
      }
    } catch { /* 隐私模式等场景静默 */ }
    const id = window.setInterval(() => {
      const playBtn = document.querySelector('[data-mp-play]');
      if (playBtn) {
        const playing = playBtn.getAttribute('aria-label') === '暂停';
        if (playing !== useAppStore.getState().musicPlaying) setMusicPlaying(playing);
      }
      const mpRoot = document.querySelector('.mp-root');
      // 2026-11-14 部署验收整改：mp-root 尚未挂载（chunk 异步加载中）或瞬时
      // 卸载时，旧写法 !undefined === true 会把 musicOpen 误报为「打开」，
      // 透镜 layoutId 便在无人操作时自动滑到音乐项、待播放器挂载后再滑回——
      // 即用户报告的「胶囊在自己动」。播放器缺失一律视为关闭态。
      const open = !!mpRoot && !mpRoot.classList.contains('mp-hidden');
      setMusicOpen(open);
    }, 1500);
    return () => window.clearInterval(id);
  }, [setMusicPlaying]);

  // Dock 项（两断点统一 6 项：首页/榜单/聊天/音乐/主题/我的）。
  // V3 修订：音乐项两档都保留 —— 既有规则 .mp-icon{display:none!important}
  // （管理员 2026-11-05 授权"音乐入口收纳进 Dock"）全局隐藏播放器收起圆钮，
  // Dock 音乐项就是唯一音乐入口，移动端胶囊必须含音乐项，否则功能缺口。
  const dockItems: DockItem[] = useMemo(() => {
    const music: DockItem = {
      id: 'music', icon: Music, label: '音乐',
      action: () => window.MusicPlayer?.toggle(),
      eq: musicPlaying, isActive: musicOpen,
    };
    return [
      { id: 'home', icon: Home, label: '首页', action: () => { window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      { id: 'board', icon: Shield, label: '榜单', action: () => setActiveMode('TOTAL') },
      { id: 'chat', icon: MessageCircle, label: '聊天', action: () => openWidget('chat'), unread: chatUnread },
      music,
      { id: 'theme', icon: Palette, label: '主题', action: () => setDiyEditorOpen(true) },
      { id: 'profile', icon: User, label: '我的', action: () => {
        // 整改：统一打开「我的」账户面板（面板内部区分登录/未登录态，
        // 含账户信息/战绩/快捷功能/注销系统）
        setProfileOpen(true);
      } },
    ];
  }, [setActiveMode, openWidget, setDiyEditorOpen, setProfileOpen, chatUnread, musicPlaying, musicOpen]);

  const renderItem = (item: DockItem, glowId: string) => {
    const Icon = item.icon;
    const isNavActive = activeId === item.id;
    // 音乐 = 瞬时入口：透镜只随面板真实开合，不占导航选中位
    const showGlow = item.id === 'music' ? item.isActive === true : isNavActive;
    const lit = showGlow || item.isActive;
    return (
      <motion.button
        key={item.id}
        type="button"
        onClick={() => {
          if (item.id !== 'music') setActiveId(item.id);
          item.action();
        }}
        whileTap={{ scale: 0.84 }}
        whileHover={{ scale: 1.06 }}
        transition={{ type: 'spring', stiffness: 420, damping: 18 }}
        className={cn('nav-capsule-item', lit && 'is-active')}
        aria-label={item.unread ? `${item.label}（${item.unread} 条未读）` : item.label}
        aria-current={showGlow && item.id !== 'music' ? 'page' : undefined}
        data-tip={item.label}
      >
        {showGlow && (
          <motion.span
            layoutId={glowId}
            className="nav-capsule-glow"
            transition={{ type: 'spring', stiffness: 300, damping: 27, mass: 1.08 }}
          >
            {/* 彗星光环：仅 ACTIVE 透镜渲染一个实例；reduced-motion 时 CSS 静止 */}
            <i className="nav-capsule-glow-comet" aria-hidden="true" />
          </motion.span>
        )}
        {lit ? (
          <motion.span
            key={`nav-pop-${item.id}`}
            initial={{ scale: 1.4 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 560, damping: 15, mass: 0.6 }}
            className="flex items-center justify-center"
          >
            <Icon className="w-[17px] h-[17px]" strokeWidth={2.6} />
          </motion.span>
        ) : (
          <Icon className="w-[17px] h-[17px]" strokeWidth={2} />
        )}
        <span className="nav-capsule-label text-[8px] font-medium tracking-wide leading-none">{item.label}</span>
        {item.unread ? (
          <span className="dock-unread-badge" aria-hidden="true">{item.unread > 9 ? '9+' : item.unread}</span>
        ) : null}
        {item.eq && !item.isActive && <EqBars />}
      </motion.button>
    );
  };

  return (
    <>
      {/* ═══ Mobile: 底部居中液态玻璃胶囊（唯一底部悬浮栏）═══ */}
      <div className="mobile-dock-only dock-zone fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        <motion.nav
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 22, delay: 0.3 }}
          style={{ touchAction: 'pan-y' }}
          className="nav-capsule pointer-events-auto"
          aria-label="主导航"
          data-motion-paused={pausedMotion || undefined}
          {...glassGlow}
        >
          <span className="nav-capsule-sweep" aria-hidden="true" />
          {dockItems.map(it => renderItem(it, 'dock-glow-m'))}
        </motion.nav>
      </div>

      {/* ═══ Desktop: 底部居中液态玻璃 dock（左竖轨退役）═══ */}
      <div className="dock-desktop-zone fixed left-0 right-0 z-40 flex justify-center pointer-events-none">
        <motion.nav
          initial={{ y: 48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 22, delay: 0.3 }}
          className="nav-capsule pointer-events-auto"
          aria-label="主导航"
          data-motion-paused={pausedMotion || undefined}
          {...glassGlow}
        >
          <span className="nav-capsule-sweep" aria-hidden="true" />
          {dockItems.map(it => renderItem(it, 'dock-glow-d'))}
        </motion.nav>
      </div>
    </>
  );
}


// ============================================================
// Main Page — responsive 3-column on desktop
// ============================================================
export default function HomePage() {
  // OPT-B：selector 化——无 selector 的 useAppStore() 会在任何 store 变化
  // （搜索键击/点赞/聊天未读等）时重渲染整页树，此处只订阅本组件真实消费的字段。
  const players = useAppStore((s) => s.players);
  const setPlayers = useAppStore((s) => s.setPlayers);
  const setLoading = useAppStore((s) => s.setLoading);
  const loading = useAppStore((s) => s.loading);
  const theme = useAppStore((s) => s.theme);
  const customBg = useAppStore((s) => s.customBg);
  const announcement = useAppStore((s) => s.announcement);
  const setAnnouncement = useAppStore((s) => s.setAnnouncement);
  const setTheme = useAppStore((s) => s.setTheme);
  const setCustomBg = useAppStore((s) => s.setCustomBg);
  // 待办清理批（批复 2026-11-08「待办执行」）：AdminPanel/PlayerEditDrawer 条件挂载用
  const isAdmin = useAppStore((s) => s.isAdmin);
  const [initialized, setInitialized] = useState(false);
  // 64em = 规范小桌面断点（em 与 CSS 断点同源，随用户字号缩放，避免 JS/CSS 双轨漂移）
  const isDesktop = useMediaQuery('(min-width: 64em)');

  // Load persisted theme + custom bg from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // WATCHDOG 就绪标记（工单：手机 Brave 白屏修复 · 方案 D，2026-11-09 授权）：
    // 本 effect 运行 = React 已水合挂载 → 看门狗据此判定页面就绪，停止自愈检查
    (window as unknown as { __goatbReady?: boolean }).__goatbReady = true;
    const savedTheme = localStorage.getItem('goatb-theme') as ThemePreset | null;
    if (savedTheme && savedTheme in THEME_PRESETS) {
      setTheme(savedTheme);
    }
    const savedBg = localStorage.getItem('goatb-bg');
    if (savedBg) setCustomBg(savedBg);

    // Idle-prefetch heavy modal chunks so first open is instant.
    // Uses requestIdleCallback when available, falls back to setTimeout.
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    const trigger = () => prefetchHeavyChunks();
    if (ric) {
      ric(trigger, { timeout: 3000 });
    } else {
      setTimeout(trigger, 2500);
    }
  }, [setTheme, setCustomBg]);

  // Load data on mount — V6: health heartbeat + auto-retry with backoff
  // (2s → 4s → 6s, max 3) so a cold/failing network never leaves a
  // silently collapsed page. Manual retry re-runs via dataVersion.
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataVersion = useAppStore((s) => s.dataVersion);
  useEffect(() => {
    if (initialized) return;
    let cancelled = false;
    const loadData = async () => {
      setLoading(true);
      useAppStore.getState().setApiHealth('checking');
      try {
        const [, configRes] = await Promise.all([
          fetchNormalizedPlayers().then(players => {
            if (!cancelled) setPlayers(players);
          }),
          // P1 #2 boot 桥：config 优先复用 HTML 解析期预取的 Response（未命中回退直连）
          bootAwareFetch('/api/v1/config'),
        ]);

        if (cancelled) return;

        const configData = await configRes.json();
        const configs = configData.configs || {};
        if (configs.announcement) setAnnouncement(configs.announcement);
        // W1-T2: 读参评门槛（Config.min_matches，默认 5）
        const mm = parseInt(configs.min_matches, 10);
        if (!isNaN(mm) && mm > 0) useAppStore.getState().setMinMatches(mm);

        // Verify admin（adminFetch：无 cookie 环境自动附带 token 头）
        try {
          const verifyRes = await adminFetch('/api/v1/admin/verify');
          const verifyData = await verifyRes.json();
          useAppStore.getState().setIsAdmin(verifyData.isAdmin);
          if (verifyData.isAdmin) {
            useAppStore.getState().setAdminRole(verifyData.role || 'ADMIN');
            useAppStore.getState().setAdminUsername(verifyData.username || 'admin');
            // 管理面板重组（批复 2026-11-08）：管理员身份确认后补预热 admin chunk，
            // 覆盖 verify 完成晚于 idle 预取的时序；访客不会走到此分支，零后台字节。
            import('@/components/admin-panel').catch(() => {});
          } else {
            // 本地 token 已失效（管理员被删/secret 轮换）→ 清理避免发无用头
            clearAdminToken();
          }
        } catch {}

        // 加载玩家 session（方案 A）
        try {
          const meRes = await fetch('/api/v1/auth/me');
          const meData = await meRes.json();
          if (meData.player) {
            useAppStore.getState().setPlayer(meData.player);
            // AUTH V2.0 PHASE 3：临时密码首登（mustChangePassword=true）→
            // 打开登录弹窗，其内部无条件渲染不可跳过的强制改密视图（工单三）
            if (meData.player.mustChangePassword) {
              useAppStore.getState().setPlayerAuthOpen(true);
            }
          }
        } catch {}

        useAppStore.getState().setApiHealth('ok');
        useAppStore.getState().setLoadError(null);
        retryCountRef.current = 0;
        setInitialized(true);
      } catch (error) {
        console.error('Failed to load data:', error);
        if (cancelled) return;
        useAppStore.getState().setApiHealth('fail');
        useAppStore.getState().setLoadError('数据加载失败，网络异常');
        // Auto-retry with backoff (2s → 4s → 6s, max 3), then the
        // manual retry button in the error card takes over
        if (retryCountRef.current < 3) {
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            if (!cancelled) useAppStore.getState().retryDataLoad();
          }, 2000 * retryCountRef.current);
        }
      }
      if (!cancelled) setLoading(false);
    };
    loadData();
    return () => {
      cancelled = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [initialized, dataVersion, setPlayers, setLoading, setAnnouncement]);

  // Apply theme — 背景 background 全走 --goatb-bg CSS 变量（防闪紫 boot 架构）：
  // 首屏由 layout head 阻塞脚本按 localStorage 预写变量 → 首帧即正确主题零闪紫；
  // 这里只在 theme/customBg 变化（面板实时切换 / 初始同步）时把变量改到最新值。
  // SSR 与客户端渲染的 style 字符串恒为 'var(--goatb-bg)' → 零 hydration mismatch。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const el = document.documentElement;
    if (customBg) {
      el.style.setProperty('--goatb-bg', `url("${customBg.replace(/["\\]/g, '')}") center/cover no-repeat`);
    } else {
      el.style.setProperty('--goatb-bg', THEME_PRESETS[theme].gradient);
    }
  }, [theme, customBg]);

  const bgStyle = { background: 'var(--goatb-bg)' };

  return (
    <div className="min-h-screen flex flex-col liquid-ambient-bg relative isolate" style={bgStyle}>
      {/* P1 #2 boot 桥（批复 2026-11-08）：SSR HTML 内联引导脚本，解析到即发起首屏四路
          GET（players/config/seasons/stats），与框架 JS 下载解析完全并行——把取数发起
          从水合后 ~3.7s 前移到 ~0.3s。幂等守卫防水合重放；boot 失败自动回退原路径。
          详见 src/lib/boot-data.ts 与批次报告 docs/perf/P1-P2-BATCH-REPORT-2026-11-08.md */}
      <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      {/* 看门狗（工单：手机 Brave 白屏修复 · 方案 D，管理员 2026-11-09 授权）：
          chunk 加载失败时 React 仅 Suspense 永久 pending 不 throw（实验证据见
          docs/EMERGENCY-BRAVE-WHITE-SCREEN-DIAG-2026-11-09.md §三），error boundary
          触发不了 → 由本脚本兜底：关键资源失败/12s 未就绪自动整页恢复一次（防循环），
          已自愈仍失败则注入非阻塞提示条。详见 src/lib/boot-data.ts WATCHDOG_SCRIPT */}
      <script dangerouslySetInnerHTML={{ __html: WATCHDOG_SCRIPT }} />
      {/* SA-09 无障碍：跳到排行榜主体的跳过链接（键盘 Tab 首个聚焦点）*/}
      <a
        href="#leaderboard-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-3 focus:py-1.5 focus:rounded-lg focus:bg-jade-500 focus:text-[#1a0a2e] focus:text-xs focus:font-medium focus:shadow-lg"
      >
        跳到排行榜主体
      </a>
      {/* SA-09 无障碍：「暂停所有动效」入口保留在 Ctrl+K 命令面板；
          右下角悬浮按钮已按需求移除（pausedMotion 状态与暂停管线不受影响）*/}
      {/* SA-10 SEO：结构化数据（ItemList + WebPage + VideoGame JSON-LD）*/}
      <LeaderboardJsonLd />
      {/* V6: pixel-grid ambience — pure CSS texture under the content (D3) */}
      <div className="pixel-grid-overlay" aria-hidden="true" />
      {/* C-卷背景大更新: 动效背景层 — 画在主题渐变/pixel-grid 之上、内容之下; customBg 时自动让位 */}
      <SiteBackground />
      {/* 高级动效·阶段 2: GSAP+ScrollTrigger 视差 — 仅 intro zone, customBg 时让位 */}
      <SiteEffects />
      <Header />
      <AnnouncementBanner />

      <main id="leaderboard-main" className="flex-1 pb-32 lg:pb-8">
        {isDesktop ? (
          /* ═══ Desktop layout: 2-column grid — opens straight into the table ═══ */
          <div className="lg-two-col pt-4">
            {/* Center: Leaderboard (information-first) */}
            <div>
              <LeaderboardSection loading={loading} />
            </div>

            {/* Right: Stats / filters (sticky) */}
            <div className="lg-sticky-right">
              {!loading && <ModuleErrorBoundary label="数据侧栏"><StatsSidebar /></ModuleErrorBoundary>}
            </div>
          </div>
        ) : (
          /* ═══ Mobile layout: single column — straight into the ranked table ═══ */
          <LeaderboardSection loading={loading} />
        )}
      </main>

      <Footer />

      {/* V3 · Liquid Glass Dock：统一底部交互中心（替代 LiquidCapsuleNav + WidgetDock）。
          聊天一级气泡 ChatEntryBubble 已下架（trace 1a1d022d595f8125）历史留档：
          聊天入口唯一归 Dock 胶囊，ChatModal/chatUnread 链路不变。 */}
      <LiquidGlassDock />

      {/* Modals — every island wrapped: one crash never sinks the page (A2) */}
      <ModuleErrorBoundary label="玩家详情"><PlayerDetailModal /></ModuleErrorBoundary>
      <AdminLoginModal />
      <PlayerAuthModal />
      <ProfilePanelModal />
      {/* 待办清理批（批复 2026-11-08「待办执行」）：访客零后台字节——
          预渲染壳条件挂载（一期报告 §五.1 边际项），管理员 verify 置位后才挂载拉 chunk；
          一期 verify 补预热（L1607）已覆盖管理员首开时序 */}
      {isAdmin && <AdminPanel />}
      <ModuleErrorBoundary label="主题编辑器"><DiyEditorModal /></ModuleErrorBoundary>
      {/* Task 41: 旧 React Modal 音乐播放器已下线——迁移至左下角 mp-root 浮动图标播放器
          （music-player-init.js），由 music-player-loader.tsx 链式加载，不占 React 渲染树 */}
      <CommandPalette />
      {isAdmin && <PlayerEditDrawer />}
      <LiveNotifier />
      {/* R3-T3 下架（批复 2026-11-08）：社区助手（AI）已下架——入口全部移除（Dock 按钮/命令面板/本渲染），
          AiAssistant 组件本体与 /api/v1/ai 路由留档保留，恢复上架时还原三处入口 + 翻转路由使能开关 */}
      <ModuleErrorBoundary label="实时聊天"><ChatModal /></ModuleErrorBoundary>

      <DataHealthBar />

      {/* FX 特效组件库开发验证面板（DEV ONLY，仅 ?fxlab=1 渲染，生产零影响） */}
      <FxLabLoader />
    </div>
  );
}

// ============================================================
// Component: Leaderboard Section — shared between mobile & desktop
// ============================================================
function LeaderboardSection({ loading }: { loading: boolean }) {
  // V6: genuine error state — the page must NEVER silently collapse (A1)
  const loadError = useAppStore((s) => s.loadError);
  const retryDataLoad = useAppStore((s) => s.retryDataLoad);
  const liveConnected = useAppStore((s) => s.liveConnected);
  // UR2（trace 1a1d6ab1f1fdd8ed）：IO 门控 reveal + 氛围层可见性暂停。
  // 一次性 IntersectionObserver（lib/use-reveal.ts），零常驻循环；
  // data-ur2-ambient 使 hero 光晕离开视口即暂停（data-ur2-idle）。
  const revealRef = useReveal<HTMLDivElement>();
  return (
    <>
      {/* D 卷 6.1 滚动区间切换：两个稳定 zone div 恒存在（不依赖 loading），
          IO 据此在 particles（intro 区）/ static-gradient（密集数据区）间切换。
          - particles zone：标题 + 段位说明 + 模式 Tab + 搜索（首屏欢迎区，已精简掉冗余胶囊）
          - static-gradient zone：榜单数据区（加载中/失败/PlayerList 三分支整体），
            用户滚到深处时背景变安静，让密集数据更易读 */}
      <div data-bg-zone="particles" ref={revealRef}>
        {/* V7 hero（trace 1a1d4ec59c54a575）→ UR2 V2.1 重构（trace 1a1d6ab1f1fdd8ed）：
            品牌版式升级 —— 眉标（MINECRAFT PVP · COMMUNITY RANKED）+ GOATB CLUB
            大标题 + 三段彩虹光标语 + 金紫分隔细线（.ur2-hero-rule）。
            氛围光 .ur2-hero::before/::after（预软化径向渐变，transform/opacity only，
            离开视口由 data-ur2-idle 暂停（观察目标 = hero 区段自身），
            reduced-motion 静态降级）。
            data-ur2-reveal + --ur2-i 错峰入场（IO 一次性触发，arm 门保证无 JS 永远可见）。
            品牌配色延续 header（GO 亮光 / ATB 金，globals.css .logo-go-glow/.gold-text）；
            data-parallax 层次与 h1 语义保持不变。 */}
        <section
          data-parallax
          data-parallax-speed="0.05"
          data-ur2-ambient
          className="ur2-hero px-4 mt-6 mb-1 text-center"
          aria-label="GOATB CLUB — YOUR GAME. YOUR IDENTITY. YOUR LEGACY."
        >
          <p
            data-ur2-reveal
            style={{ '--ur2-i': 0 } as React.CSSProperties}
            className="font-mc text-[8px] sm:text-[9px] tracking-[0.34em] text-secondary-foreground/65 select-none"
            aria-hidden="true"
          >
            MINECRAFT PVP · COMMUNITY RANKED
          </p>
          <h1
            data-ur2-reveal
            style={{ '--ur2-i': 1 } as React.CSSProperties}
            className="mt-2.5 font-mc text-xl sm:text-3xl md:text-4xl tracking-[0.06em] leading-relaxed"
          >
            <span className="logo-go-glow">GO</span><span className="gold-text">ATB</span>{' '}
            <span className="hero-club-rest">CLUB</span>
          </h1>
          <p
            data-ur2-reveal
            style={{ '--ur2-i': 2 } as React.CSSProperties}
            className="mt-3 sm:mt-4 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1.5 font-mc text-[9px] sm:text-[11px] tracking-[0.12em]"
            aria-label="YOUR GAME. YOUR IDENTITY. YOUR LEGACY."
          >
            <span className="rainbow-light">YOUR GAME.</span>
            <span className="rainbow-light rainbow-d2">YOUR IDENTITY.</span>
            <span className="rainbow-light rainbow-d3">YOUR LEGACY.</span>
          </p>
          <div data-ur2-reveal style={{ '--ur2-i': 3 } as React.CSSProperties} className="ur2-hero-rule" aria-hidden="true" />
        </section>

        {/* 高级动效·阶段 2：data-parallax 仅作用于 intro zone。
            speed 0.08→0.18 渐增，制造 h2(远)→搜索框(近) 的层次深度。
            XT 规格替换：模式 Tab 与搜索框已移入 XtLeaderboard 内部（XT 芯片
            tab + XT 搜索框规格），intro 区仅保留标题与段位说明。 */}
        <section
          data-parallax
          data-parallax-speed="0.08"
          className="px-4 mt-3 mb-1 scroll-mt-24"
        >
          <div className="flex items-center justify-between">
            <h2 className="jade-glow-animated text-base sm:text-lg font-bold tracking-[0.2em]">
              <TextMaskReveal text="LEADERBOARD" keySeed="leaderboard-title" className="mask-line font-mc" />
            </h2>
            <span className="liquid-tier-badge micro flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-liquid-pill)] text-[9px] font-medium bg-white/[0.05] text-secondary-foreground/80 lg:hidden">
              {/* SA-11 故障恢复：实时连接状态指示器（绿=已连接/灰=重连中）*/}
              <span
                className={`w-1.5 h-1.5 rounded-full ${liveConnected ? 'bg-emerald-400' : 'bg-white/30'}`}
                title={liveConnected ? '实时连接正常' : '实时连接断开，重连中…'}
                aria-label={liveConnected ? '实时连接正常' : '实时连接断开，重连中'}
              />
              <Zap className="w-2.5 h-2.5" />
              <span>活动进行中</span>
            </span>
          </div>
        </section>

        <div data-parallax data-parallax-speed="0.12">
          <TierExplanation />
        </div>
      </div>

      <div data-bg-zone="static-gradient" aria-busy={loading ? 'true' : undefined}>
        {loading ? (
          // CG-1：shadcn Skeleton 骨架屏替换纯 spinner —— 加载完成零布局跳动
          <LeaderboardSkeleton />
        ) : loadError ? (
          <div className="px-4 py-12 text-center" role="alert" aria-live="assertive">
            <div className="liquid-glass rounded-[var(--radius-liquid-md)] max-w-sm mx-auto p-6">
              <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
              <p className="text-sm text-white/85 mt-3 font-medium">榜单数据加载失败</p>
              <p className="text-xs text-muted-foreground mt-1">正在自动重试，也可以手动重新加载</p>
              <button
                onClick={retryDataLoad}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-jade-500/20 text-jade-300 text-xs font-medium border border-jade-500/30 hover:bg-jade-500/30 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                重新加载
              </button>
            </div>
          </div>
        ) : (
          /* XT PVP Tier 规格榜（2026-10 用户指令：替换旧排行榜规格）。
             内含：XT 公告条/模式 Tab/搜索框 + 总榜四列表格 + 单模式分组矩阵；
             感动榜按硬约束委托原 PlayerList 渲染。 */
          <XtLeaderboard />
        )}
      </div>
    </>
  );
}

// ============================================================
// SA-10 SEO：LeaderboardJsonLd — 结构化数据（ItemList + WebPage + VideoGame）
// 客户端渲染 <script type="application/ld+json">（SSR 化属 defer 项）
// Google 渲染器执行 JS 后可索引；dateModified 用当前时间（数据实时）
// ============================================================
function LeaderboardJsonLd() {
  const players = useAppStore((s) => s.players);
  const activeMode = useAppStore((s) => s.activeMode);
  // 仅客户端挂载后渲染——避免 dateModified 在 SSR/hydration 间时间戳不一致
  // 导致 hydration mismatch。用 useSyncExternalStore（React 官方 SSR-safe 模式）
  // 而非 useEffect+setState（React 19 react-hooks/set-state-in-effect 规则禁用）
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,   // client snapshot
    () => false,  // server snapshot
  );
  const jsonLd = useMemo(() => {
    const top = players.slice(0, 50).map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: p.name,
      url: `${typeof window !== 'undefined' ? window.location.origin : ''}/#player-${p.id}`,
    }));
    const graph = [
      {
        '@type': 'ItemList',
        name: 'GOATB 社区排行榜',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: players.length,
        itemListElement: top,
      },
      {
        '@type': 'WebPage',
        name: 'GOATB 社区排行榜',
        description: 'GOATB Club - Minecraft 游戏社区排行榜，竞技段位与积分体系',
        dateModified: new Date().toISOString(),
      },
      {
        '@type': 'VideoGame',
        name: 'GOATB',
        gameItem: 'Minecraft',
        playMode: 'MultiPlayer',
        applicationCategory: 'Game',
      },
    ];
    return { '@context': 'https://schema.org', '@graph': graph };
  }, [players, activeMode]);

  if (!mounted) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
