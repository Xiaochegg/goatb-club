'use client';

// ============================================================
// Component: ProfilePanelModal —「我的」账户面板（自审核后整改）
// 侧栏「我的」的专属面板，替换原先"登录后只能跳玩家详情"的行为。
// 已登录：账户信息卡（邮箱/注册时间/末次登录）+ 我的战绩
//         （总分/等级/排名/K-D/胜率/获赞）+ 全部功能快捷入口
//         （榜单详情/主题定制/音乐/聊天）+ 认领卡（认领机制 v1）
//         + 注销登录（logout 系统）
// 未登录：登录/注册引导 + 功能说明 + 管理员入口提示
// 会话来源：打开时实时拉 /api/v1/auth/me（含 createdAt/lastLoginAt），
// 注销调 POST /api/v1/auth/logout 并清空本地身份。
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User,
  X,
  LogOut,
  LogIn,
  BarChart3,
  Palette,
  Music,
  MessageCircle,
  Mail,
  CalendarDays,
  Clock3,
  Trophy,
  Medal,
  Swords,
  Heart,
  Crown,
  ShieldUser,
  Info,
  Loader2,
  UserCheck,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useAppStore, type PlayerData } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  ALL_MODES,
  calcKD,
  calcWinRate,
  calcLevel,
  getLevelProgress,
} from '@/lib/constants';
import { getPlayerTotalScore, getSortedPlayers } from '@/lib/scoring';
import { ClaimModal, type ClaimableEntry } from '@/components/claim-modal';
import { TierConfirmCard } from '@/components/tier-confirm-card';
import { SecurityCenter } from '@/components/security-center';
import { getAvatarInitial, getAvatarColor, bigNumSizeClass } from '@/lib/ui-utils';

// --- 认领请求（GET /api/v1/claims 返回，普通用户视角） ---
interface ClaimRecord {
  id: string;
  status: string | null;
  createdAt: string;
  detail: string;
  actorName: string;
  targetName: string;
}

// --- 完整身份（/auth/me 返回，比 store.player 多 createdAt/lastLoginAt/role） ---
interface FullProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt?: string | null;
  lastLoginAt?: string | null;
  // UNIFIED ACCOUNT V1 P1：邮箱验证态（null/undefined = 未验证）
  emailVerifiedAt?: string | null;
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '—';
  }
}

const springIn = { type: 'spring' as const, stiffness: 220, damping: 24, mass: 0.9 };

export function ProfilePanelModal() {
  const {
    profileOpen,
    setProfileOpen,
    setPlayer,
    setPlayerAuthOpen,
    setSelectedPlayerId,
    setDiyEditorOpen,
    openWidget,
    players,
    sortHighFirst,
  } = useAppStore();

  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 认领机制 v1：面板打开时拉认领状态（仅登录后）
  const [claimEnabled, setClaimEnabled] = useState(false);
  const [myClaims, setMyClaims] = useState<ClaimRecord[]>([]);
  const [claimable, setClaimable] = useState<ClaimableEntry[]>([]);
  const [claimModalOpen, setClaimModalOpen] = useState(false);

  // 打开时实时拉取完整身份（会话可能已过期，store.player 只是缓存）
  useEffect(() => {
    if (!profileOpen) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/v1/auth/me');
        const data = await res.json();
        if (cancelled) return;
        const p = (data?.player as FullProfile | null) ?? null;
        setProfile(p);
        // 会话已过期但 store 还留旧身份 → 同步清掉；反之补上
        if (!p) setPlayer(null);
        else setPlayer({ id: p.id, name: p.name, email: p.email });
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileOpen, setPlayer]);

  // 认领状态拉取（登录后才有意义；403=功能未开/401=未登录 都静默降级）
  const fetchClaims = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/claims');
      if (!res.ok) {
        setClaimEnabled(false);
        return;
      }
      const data = await res.json();
      setClaimEnabled(!!data?.enabled);
      setMyClaims(Array.isArray(data?.claims) ? data.claims : []);
      setClaimable(Array.isArray(data?.claimable) ? data.claimable : []);
    } catch {
      setClaimEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!profileOpen || !profile) return;
    fetchClaims();
  }, [profileOpen, profile, fetchClaims]);

  // Escape 关闭
  useEffect(() => {
    if (!profileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profileOpen, setProfileOpen]);

  const close = useCallback(() => setProfileOpen(false), [setProfileOpen]);

  // 认领状态派生（优先级：pending > approved > rejected）
  const pendingClaim = myClaims.find(c => c.status === 'pending') ?? null;
  const approvedClaim = myClaims.find(c => c.status === 'approved') ?? null;
  const rejectedClaim = myClaims.find(c => c.status === 'rejected') ?? null;

  // 我的榜单条目与全站排名
  const myEntry: PlayerData | null = useMemo(() => {
    if (!profile) return null;
    return players.find(p => p.id === profile.id) ?? null;
  }, [profile, players]);

  const overallRank = useMemo(() => {
    if (!myEntry) return null;
    const sorted = getSortedPlayers(players, 'TOTAL', sortHighFirst, '');
    const idx = sorted.findIndex(p => p.id === myEntry.id);
    return idx >= 0 ? idx + 1 : null;
  }, [myEntry, players, sortHighFirst]);

  const agg = useMemo(() => {
    const base = { kills: 0, deaths: 0, wins: 0, matches: 0 };
    if (!myEntry) return base;
    return ALL_MODES.reduce((acc, m) => {
      const s = myEntry.stats?.[m];
      if (s) {
        acc.kills += s.kills || 0;
        acc.deaths += s.deaths || 0;
        acc.wins += s.wins || 0;
        acc.matches += s.matches || 0;
      }
      return acc;
    }, base);
  }, [myEntry]);

  const totalScore = myEntry ? getPlayerTotalScore(myEntry) : 0;
  const level = calcLevel(totalScore);
  const progress = getLevelProgress(totalScore);

  // 注销登录（logout 系统）
  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // 网络失败也照样清本地身份（cookie 侧 7 天自然过期兜底）
    }
    setPlayer(null);
    setProfile(null);
    setLoggingOut(false);
    setProfileOpen(false);
  };

  const openDetail = () => {
    if (!myEntry) return;
    setProfileOpen(false);
    setSelectedPlayerId(myEntry.id);
  };

  const quickActions = [
    {
      icon: BarChart3,
      label: '榜单详情',
      desc: '我的排名走势',
      disabled: !myEntry,
      action: openDetail,
    },
    {
      icon: Palette,
      label: '主题定制',
      desc: 'DIY 界面配色',
      disabled: false,
      action: () => {
        setProfileOpen(false);
        setDiyEditorOpen(true);
      },
    },
    {
      icon: Music,
      label: '音乐播放',
      desc: '社区热歌',
      disabled: false,
      action: () => {
        setProfileOpen(false);
        openWidget('music');
      },
    },
    {
      icon: MessageCircle,
      label: '实时聊天',
      desc: '社区频道',
      disabled: false,
      action: () => {
        setProfileOpen(false);
        openWidget('chat');
      },
    },
  ];

  // 数字外露防线（2026-10）：千分位 + 字符数降级，与玩家详情面板同策略
  const totalScoreText = totalScore.toLocaleString();
  const likesText = (myEntry?.likes ?? 0).toLocaleString();
  const kdText = calcKD({ kills: agg.kills, deaths: agg.deaths, wins: agg.wins, matches: agg.matches });
  const winRateText = calcWinRate({ kills: agg.kills, deaths: agg.deaths, wins: agg.wins, matches: agg.matches });

  const statCells = [
    { icon: Trophy, label: '总积分', value: myEntry ? totalScoreText : '—' },
    { icon: Crown, label: '等级', value: myEntry ? `Lv.${level}` : '—' },
    { icon: Medal, label: '全站排名', value: overallRank ? `#${overallRank}` : '—' },
    { icon: Swords, label: 'K/D', value: myEntry ? kdText : '—' },
    { icon: ShieldUser, label: '胜率', value: myEntry ? winRateText : '—' },
    { icon: Heart, label: '获赞', value: myEntry ? likesText : '—' },
  ];

  return (
    <>
    <AnimatePresence>
      {profileOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[105] flex items-center justify-center p-3"
          onClick={close}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="我的账户面板"
            initial={{ y: 24, scale: 0.92, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.85, opacity: 0, filter: 'blur(8px)' }}
            transition={springIn}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-md liquid-glass-strong v2l-card v2l-scroll rounded-[var(--radius-liquid-lg)] overflow-hidden max-h-[88vh] overflow-y-auto"
          >
            <div className="h-1 gold-bar sticky top-0 z-10" />
            <div className="p-6 relative z-10">

              {loading ? (
                /* ── 会话校验中 ── */
                <div className="flex flex-col items-center gap-3 py-10">
                  <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                  <p className="text-xs text-muted-foreground">正在校验登录状态…</p>
                </div>
              ) : profile ? (
                <>
                  {/* ═══ 已登录 · 身份头部 ═══ */}
                  <div className="flex items-start gap-3.5 mb-5">
                    <div
                      className="w-14 h-14 rounded-[var(--radius-liquid-md)] flex items-center justify-center flex-shrink-0 font-bold"
                      style={{
                        background: getAvatarColor(profile.name),
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1.5px rgba(191,90,242,0.35)',
                      }}
                      aria-hidden="true"
                    >
                      <span className="text-white text-xl">{getAvatarInitial(profile.name)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-lg font-bold text-white tracking-tight truncate max-w-[160px]">
                          {profile.name}
                        </h2>
                        <span className="text-[9px] font-semibold tracking-[0.12em] uppercase px-2 py-0.5 rounded-full bg-secondary/20 text-secondary-foreground border border-secondary/30 flex-shrink-0">
                          {profile.role === 'PLAYER' ? '玩家' : profile.role}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-1 truncate">
                        <Mail className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{profile.email}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={close}
                      className="w-11 h-11 rounded-full liquid-glass-subtle flex items-center justify-center flex-shrink-0 hover:bg-[rgba(35,42,58,0.08)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2l-violet)]/60"
                      aria-label="关闭"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* ═══ 账户信息 ═══ */}
                  <section className="mb-4" aria-label="账户信息">
                    <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3 grid grid-cols-2 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <CalendarDays className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[9px] text-muted-foreground tracking-wide">注册于</p>
                          <p className="text-[11px] text-white/90 font-medium">{formatDate(profile.createdAt)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 min-w-0">
                        <Clock3 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[9px] text-muted-foreground tracking-wide">上次登录</p>
                          <p className="text-[11px] text-white/90 font-medium">{formatDate(profile.lastLoginAt)}</p>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* ═══ 我的战绩 ═══ */}
                  <section className="mb-4" aria-label="我的战绩">
                    <h3 className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted-foreground mb-2">
                      我的战绩
                    </h3>
                    {myEntry ? (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          {statCells.map(cell => {
                            const CellIcon = cell.icon;
                            return (
                              <div
                                key={cell.label}
                                className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-2 py-2.5 flex flex-col items-center gap-1"
                              >
                                <CellIcon className="w-3.5 h-3.5 text-secondary-foreground" />
                                <span
                                  title={cell.value}
                                  className={cn(
                                    'font-bold text-white leading-none min-w-0 max-w-full truncate number-score',
                                    bigNumSizeClass(cell.value, 'micro')
                                  )}
                                >{cell.value}</span>
                                <span className="text-[9px] text-muted-foreground">{cell.label}</span>
                              </div>
                            );
                          })}
                        </div>
                        {/* 等级进度条 */}
                        <div className="mt-2 liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-2.5">
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1.5">
                            <span>等级进度</span>
                            <span>
                              {progress.current} / {progress.next}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-secondary to-primary transition-all"
                              style={{ width: `${Math.min(100, progress.percent)}%` }}
                              role="progressbar"
                              aria-valuenow={Math.round(progress.percent)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label="等级进度"
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-4 text-center">
                        <Info className="w-4 h-4 text-muted-foreground mx-auto mb-1.5" aria-hidden="true" />
                        <p className="text-[11px] text-white/80 font-medium mb-0.5">暂无榜单条目</p>
                        <p className="text-[10px] text-muted-foreground">
                          在下方「条目认领」中选择你的条目，管理员审批后即可关联，战绩由管理员录入
                        </p>
                      </div>
                    )}
                  </section>

                  {/* ═══ 待确认 Tier 测试记录（TIER_RECORD_RECOGNITION_REBUILD_V1 §3.7，
                          管理员批复 2026-11-09：仅本人可确认/提出异议，服务端强校验） ═══ */}
                  <TierConfirmCard active={!!profile} />

                  {/* ═══ 全部功能快捷入口 ═══ */}
                  <section className="mb-4" aria-label="快捷功能">
                    <h3 className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted-foreground mb-2">
                      快捷功能
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                      {quickActions.map(qa => {
                        const QAIcon = qa.icon;
                        return (
                          <button
                            key={qa.label}
                            type="button"
                            disabled={qa.disabled}
                            onClick={qa.action}
                            className={cn(
                              'liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3 py-2.5 min-h-[44px] flex items-center gap-2.5 text-left transition-all',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2l-violet)]/60',
                              qa.disabled
                                ? 'opacity-40 cursor-not-allowed'
                                : 'hover:bg-[rgba(35,42,58,0.06)] active:scale-[0.97]'
                            )}
                          >
                            <QAIcon className="w-4 h-4 text-secondary-foreground flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-[12px] font-semibold text-white leading-tight">{qa.label}</p>
                              <p className="text-[9px] text-muted-foreground leading-tight">{qa.desc}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {/* ═══ 认领我的榜单条目（claim-mechanism v1） ═══ */}
                  {claimEnabled && (
                    <section className="mb-4" aria-label="认领榜单条目">
                      <h3 className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted-foreground mb-2">
                        条目认领
                      </h3>
                      {pendingClaim ? (
                        <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3 flex items-start gap-2.5 border border-secondary/30">
                          <Clock3 className="w-4 h-4 text-secondary-foreground flex-shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-white leading-tight">
                              已提交认领请求：{pendingClaim.targetName}
                            </p>
                            <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                              等待管理员审批 · 通过后请重新登录切换到该条目
                            </p>
                          </div>
                        </div>
                      ) : approvedClaim ? (
                        <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3 flex items-start gap-2.5 border border-jade-500/25">
                          <CheckCircle2 className="w-4 h-4 text-jade-400 flex-shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-white leading-tight">
                              {approvedClaim.targetName === profile?.name
                                ? '本条目已通过认领绑定'
                                : `已认领：${approvedClaim.targetName}`}
                            </p>
                            <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                              {approvedClaim.targetName === profile?.name
                                ? '身份绑定已生效，战绩由管理员维护'
                                : '重新登录后切换到该条目'}
                            </p>
                          </div>
                        </div>
                      ) : claimable.length > 0 ? (
                        <>
                          {rejectedClaim && (
                            <p className="text-[10px] text-white/45 flex items-center gap-1.5 mb-2">
                              <XCircle className="w-3 h-3 text-destructive/80 flex-shrink-0" />
                              最近一次认领未通过，可重新提交申请
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={() => setClaimModalOpen(true)}
                            aria-label="打开认领弹窗"
                            className="w-full liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3 min-h-[44px] flex items-center gap-2.5 text-left hover:bg-[rgba(35,42,58,0.06)] active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2l-violet)]/60"
                          >
                            <UserCheck className="w-4 h-4 text-secondary-foreground flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-[12px] font-semibold text-white leading-tight">认领我的榜单条目</p>
                              <p className="text-[9px] text-muted-foreground leading-tight">选择属于你的匿名条目 · 管理员审批后生效</p>
                            </div>
                            <span className="text-[10px] text-muted-foreground flex-shrink-0" aria-hidden="true">›</span>
                          </button>
                        </>
                      ) : (
                        <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3">
                          <p className="text-[11px] text-muted-foreground text-center">当前没有可认领的条目</p>
                        </div>
                      )}
                    </section>
                  )}

                  {/* ═══ 安全中心（AUTH V2.0 · Phase 6：安全状态 / 登录设备 / 退出其他设备） ═══ */}
                  <SecurityCenter />

                  {/* ═══ 注销登录 ═══ */}
                  <section aria-label="会话管理">
                    <button
                      type="button"
                      onClick={handleLogout}
                      aria-label="注销登录确认"
                      disabled={loggingOut}
                      className={cn(
                        'w-full rounded-[var(--radius-liquid-md)] px-4 py-3 min-h-[44px] flex items-center justify-center gap-2 text-sm font-semibold transition-all border',
                        'bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/20 active:scale-[0.98]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50',
                        loggingOut && 'opacity-60 cursor-wait'
                      )}
                    >
                      {loggingOut ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <LogOut className="w-4 h-4" />
                      )}
                      注销登录
                    </button>
                    <p className="text-[9px] text-muted-foreground text-center mt-2">
                      会话有效期 7 天 · 注销后需重新登录
                    </p>
                  </section>
                </>
              ) : (
                <>
                  {/* ═══ 未登录 · 引导 ═══ */}
                  <div className="flex flex-col items-center gap-2 mb-5">
                    <div className="w-12 h-12 rounded-[var(--radius-liquid-md)] liquid-glass-subtle flex items-center justify-center">
                      <User className="w-6 h-6 text-secondary-foreground" />
                    </div>
                    <h2 className="text-lg font-bold text-white tracking-tight">我的</h2>
                    <p className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">Player Account</p>
                  </div>

                  <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-4 py-4 mb-4">
                    <p className="text-[12px] text-white/85 font-semibold mb-2 text-center">
                      登录后解锁全部功能
                    </p>
                    <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                      <li className="flex items-center gap-2">
                        <span className="w-1 h-1 rounded-full bg-secondary-foreground flex-shrink-0" />
                        认领榜单上与你游戏ID相同的条目
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="w-1 h-1 rounded-full bg-secondary-foreground flex-shrink-0" />
                        查看个人战绩、排名走势与获赞
                      </li>
                      <li className="flex items-center gap-2">
                        <span className="w-1 h-1 rounded-full bg-secondary-foreground flex-shrink-0" />
                        主题定制、音乐、聊天快捷直达
                      </li>
                    </ul>
                  </div>

                  <button
                    type="button"
                    aria-label="打开登录注册"
                    onClick={() => {
                      setProfileOpen(false);
                      setPlayerAuthOpen(true);
                    }}
                    className="w-full rounded-[var(--radius-liquid-md)] px-4 py-3 min-h-[44px] flex items-center justify-center gap-2 text-sm font-semibold bg-[var(--v2l-ink)] text-[var(--v2l-surface)] hover:opacity-90 transition-all active:scale-[0.98] mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2l-violet)]/60"
                  >
                    <LogIn className="w-4 h-4" />
                    登录 / 注册
                  </button>
                  <p className="text-[9px] text-muted-foreground text-center">
                    管理员？请点右上角「管理」按钮进入后台
                  </p>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* 认领弹窗 — 渲染在面板动画容器外，避免 transform 影响其 fixed 定位 */}
    <ClaimModal
      open={claimModalOpen}
      onClose={() => setClaimModalOpen(false)}
      claimable={claimable}
      onSubmitted={fetchClaims}
    />
    </>
  );
}

