'use client';

// ============================================================
// Component: SecurityCenter —「安全中心」（AUTH V2.0 · Phase 6）
// 挂载于 profile-panel「注销登录」区之前，玩家面向：
//   ① 安全状态格：末次登录 / 密码最近重置 / 账号状态
//   ② 登录设备列表：SessionLedger 登录留痕（≤20 行，「本机」徽章）
//   ③ 退出其他设备：两段确认（3 秒窗口）+ toast 反馈；
//      当前设备由服务端重签 cookie 保持登录，前端零处理。
// 数据来源（同源相对路径，随 cookie 自动携带凭证）：
//   GET  /api/v1/auth/sessions
//   POST /api/v1/auth/logout-others
// 拉取失败静默降级（空态 + 一行错误提示），绝不白屏。
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldCheck,
  Clock3,
  KeyRound,
  Activity,
  LogOut,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

// --- GET /api/v1/auth/sessions 返回（前后端并行契约） ---
interface SecurityInfo {
  lastLoginAt?: string | null;
  passwordResetAt?: string | null;
  mustChangePassword?: boolean;
  disabled?: boolean;
}

interface SessionRow {
  id: string;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
  current?: boolean;
}

// 日期（对齐 profile-panel 的 formatDate：YYYY/MM/DD）
function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '—';
  }
}

// 日期 + 时分（设备列表行用）
function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '—';
  }
}

// UA 简写：Edg → Firefox → Chrome → Safari 依序匹配，否则截断原文 18 字符
function uaShort(ua?: string | null): string {
  if (!ua) return '未知设备';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return ua.length > 18 ? `${ua.slice(0, 18)}…` : ua;
}

const CONFIRM_WINDOW_MS = 3000;

export function SecurityCenter() {
  const { toast } = useToast();

  const [security, setSecurity] = useState<SecurityInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 两段确认：第一次点 → 进入确认态（3 秒内再点才执行；超时/失焦还原）
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // 卸载时清掉确认计时器，避免 setState 到已卸载组件
    return clearConfirmTimer;
  }, [clearConfirmTimer]);

  // 拉取安全状态 + 登录设备列表（失败静默降级，不抛错不白屏）
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/sessions');
      if (!res.ok) {
        // 401=会话过期 / 404=后端未就绪 / 5xx — 一律静默降级
        setSecurity(null);
        setSessions([]);
        setError('安全信息暂时无法获取');
        return;
      }
      const data = await res.json();
      setSecurity((data?.security as SecurityInfo | null) ?? null);
      setSessions(Array.isArray(data?.sessions) ? (data.sessions as SessionRow[]) : []);
      setError(null);
    } catch {
      setSecurity(null);
      setSessions([]);
      setError('安全信息暂时无法获取');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startConfirm = useCallback(() => {
    clearConfirmTimer();
    setConfirming(true);
    confirmTimerRef.current = setTimeout(() => {
      setConfirming(false);
      confirmTimerRef.current = null;
    }, CONFIRM_WINDOW_MS);
  }, [clearConfirmTimer]);

  // POST /api/v1/auth/logout-others — 撤销其他设备会话，当前设备无感续期
  const executeRevoke = useCallback(async () => {
    clearConfirmTimer();
    setRevoking(true);
    try {
      const res = await fetch('/api/v1/auth/logout-others', { method: 'POST' });
      if (res.ok) {
        toast({ description: '✅ 已退出其他设备的登录，当前设备保持在线' });
        await load();
      } else {
        let msg = '';
        try {
          const data = await res.json();
          msg = data?.error || data?.message || '';
        } catch {
          // 非 JSON 响应体，走兜底文案
        }
        if (!msg) {
          msg =
            res.status === 429
              ? '操作过于频繁，请稍后再试'
              : '退出其他设备失败，请稍后再试';
        }
        toast({ description: `❌ ${msg}`, variant: 'destructive' });
      }
    } catch {
      toast({ description: '❌ 网络异常，退出其他设备失败', variant: 'destructive' });
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }, [clearConfirmTimer, load, toast]);

  const disabled = security?.disabled === true;

  return (
    <section className="mb-4" aria-label="安全中心">
      <h3 className="text-[10px] font-semibold tracking-[0.2em] uppercase text-muted-foreground mb-2 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
        安全中心
      </h3>

      {/* 安全状态格（对齐「账户信息」双列 liquid-glass 网格） */}
      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-3.5 py-3 grid grid-cols-2 gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Clock3 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[9px] text-muted-foreground tracking-wide">末次登录</p>
            <p className="text-[11px] text-white/90 font-medium">
              {formatDate(security?.lastLoginAt ?? null)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[9px] text-muted-foreground tracking-wide">密码最近重置</p>
            {security ? (
              security.passwordResetAt ? (
                <>
                  <p className="text-[11px] text-white/90 font-medium">
                    {formatDate(security.passwordResetAt)}
                  </p>
                  <p className="text-[9px] text-muted-foreground">由管理员重置</p>
                </>
              ) : (
                <p className="text-[11px] text-white/90 font-medium">从未被重置</p>
              )
            ) : (
              <p className="text-[11px] text-white/90 font-medium">—</p>
            )}
          </div>
        </div>
        <div className="col-span-2 flex items-center gap-2 min-w-0">
          <Activity className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[9px] text-muted-foreground tracking-wide">账号状态</p>
            <p
              className={cn(
                'text-[11px] font-medium',
                security ? (disabled ? 'text-destructive' : 'text-white/90') : 'text-white/90'
              )}
            >
              {security ? (disabled ? '已禁用' : '正常') : '—'}
            </p>
          </div>
        </div>
      </div>

      {/* 登录设备列表 */}
      <p className="text-[9px] text-muted-foreground tracking-wide mb-1.5 px-1">登录设备</p>
      <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] px-1.5 py-1.5 mb-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6" aria-live="polite">
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" aria-hidden="true" />
            <span className="text-[10px] text-muted-foreground">正在加载登录设备…</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3.5 py-5 text-center">
            <p className="text-[10px] text-muted-foreground">
              暂无登录记录 · 本功能上线前的既有会话不回填
            </p>
            {error && <p className="text-[9px] text-destructive/80 mt-1">{error}</p>}
          </div>
        ) : (
          <ul className="max-h-48 overflow-y-auto custom-scrollbar" aria-label="登录设备列表">
            {sessions.map(s => (
              <li
                key={s.id}
                aria-current={s.current ? 'true' : undefined}
                className="px-2 py-2 rounded-[var(--radius-liquid-sm)] hover:bg-[rgba(35,42,58,0.06)] transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-white/90 font-medium truncate">
                    {formatDateTime(s.createdAt)}
                  </p>
                  {s.current && (
                    <span className="text-[9px] font-semibold tracking-[0.12em] uppercase px-2 py-0.5 rounded-full bg-secondary/20 text-secondary-foreground border border-secondary/30 flex-shrink-0">
                      本机
                    </span>
                  )}
                </div>
                <p className="text-[9px] text-muted-foreground truncate mt-0.5">
                  IP {s.ip ?? '未知'} · {uaShort(s.userAgent)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 退出其他设备（两段确认，面板内嵌套不新开 Dialog） */}
      <button
        type="button"
        onClick={confirming && !revoking ? executeRevoke : startConfirm}
        onBlur={confirming ? () => setConfirming(false) : undefined}
        disabled={revoking}
        aria-label={confirming ? '确认退出其他设备' : '退出其他设备'}
        className={cn(
          'w-full rounded-[var(--radius-liquid-md)] px-4 py-3 min-h-[44px] flex items-center justify-center gap-2 text-sm font-semibold transition-all border',
          'bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/20 active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50',
          revoking && 'opacity-60 cursor-wait'
        )}
      >
        {revoking ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : (
          <LogOut className="w-4 h-4" aria-hidden="true" />
        )}
        {revoking ? '正在退出…' : confirming ? '确认退出其他设备？' : '退出其他设备'}
      </button>
      <p className="text-[9px] text-muted-foreground text-center mt-2">
        撤销其他设备上的登录 · 当前设备保持在线
      </p>
    </section>
  );
}

export default SecurityCenter;
