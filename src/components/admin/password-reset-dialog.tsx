'use client';
// ============================================================
// AUTH V2.0 PHASE 3（工单 2026-11-10/11）：管理员密码重置协助弹窗
// 工单依据：二「按邮箱搜索用户 / 查看用户账号基本信息 / 为指定用户重置密码 /
//   禁用或恢复用户账号 / 查看密码重置时间 / 记录管理员操作日志」；
//   三「临时密码安全随机生成 / 仅展示一次 / 仅存储哈希 / 首登强制修改 /
//   支持撤销旧会话」。
// 行为：
//   - 打开即拉取 /api/v1/admin/player-account 展示账号安全画像；
//   - 「生成临时密码」→ /api/v1/admin/password-reset：明文【仅本次展示】，
//     复制后关闭即不可再查（服务端只存 scrypt 哈希，重置时旧会话全部失效）；
//   - 「禁用账号 / 恢复账号」→ /api/v1/admin/player-status（禁用需填写原因，
//     落 OperationLog 审计）；
//   - 权限：接口侧 OWNER/ADMIN（服务端硬校验）；普通用户/低权限角色调用
//     将收到 401/403，组件如实展示错误。
// 红线：任何情况下不展示/不请求用户密码明文或哈希（工单三）。
// ============================================================
import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { KeyRound, ShieldBan, ShieldCheck, Copy, Check, Loader2, AlertTriangle } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { useToast } from '@/hooks/use-toast';
import type { PlayerData } from '@/lib/store';
import { Input } from '@/components/ui/input';

interface AccountInfo {
  id: string;
  name: string;
  email: string | null;
  role: string;
  isRegistered: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  passwordResetAt: string | null;
  mustChangePassword: boolean;
  disabledAt: string | null;
  emailVerifiedAt: string | null;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function AdminPasswordResetDialog({
  target,
  onClose,
}: {
  target: PlayerData | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  // 本组件由父层以 key=resetTarget?.id 重挂：target 变化即全新实例，
  // 初始 state 即重置后的干净状态（避免 effect 内同步 setState 级联渲染）
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(Boolean(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disableReason, setDisableReason] = useState('');

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    adminFetch(`/api/v1/admin/player-account?playerId=${encodeURIComponent(target.id)}`)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (ok && d?.account) setAccount(d.account as AccountInfo);
        else setError(d?.error || '查询失败');
      })
      .catch(() => { if (!cancelled) setError('网络错误，请稍后重试'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target]);

  const doReset = async () => {
    if (!target || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const res = await adminFetch('/api/v1/admin/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: target.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        setTempPassword(data.tempPassword as string);
        toast({ title: '临时密码已生成', description: `${data.playerName} · 仅本次显示，旧会话已全部失效` });
      } else {
        setError(data?.error || `重置失败（HTTP ${res.status}）`);
      }
    } catch {
      setError('网络错误，请稍后重试');
    }
    setBusy(false);
  };

  const doStatus = async (action: 'disable' | 'restore') => {
    if (!target || busy) return;
    if (action === 'disable' && !confirmDisable) { setConfirmDisable(true); return; }
    setBusy(true); setError('');
    try {
      const res = await adminFetch('/api/v1/admin/player-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: target.id, action, reason: disableReason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        toast({ title: action === 'disable' ? '账号已禁用' : '账号已恢复', description: `${data.playerName} · 已记录操作日志` });
        setConfirmDisable(false); setDisableReason('');
        // 重新拉取账号状态
        const r2 = await adminFetch(`/api/v1/admin/player-account?playerId=${encodeURIComponent(target.id)}`);
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok && d2?.account) setAccount(d2.account as AccountInfo);
      } else {
        setError(data?.error || `操作失败（HTTP ${res.status}）`);
      }
    } catch {
      setError('网络错误，请稍后重试');
    }
    setBusy(false);
  };

  const copyTemp = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 剪贴板不可用时用户可手动选中复制 */ }
  };

  const disabled = Boolean(account?.disabledAt);

  return (
    <Dialog open={!!target} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm rounded-2xl border-white/10 bg-[#14141c] text-white max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <KeyRound className="w-4 h-4 text-secondary-foreground" />
            密码重置协助{target ? ` · ${target.name}` : ''}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            仅账号安全管理；操作将记录到管理员操作日志
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : error && !account ? (
          <div className="text-sm text-[var(--system-red)] flex items-center gap-1.5 py-4">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        ) : account ? (
          <div className="space-y-3">
            {/* 账号基本信息（工单二：查看用户账号基本信息 / 密码重置时间） */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs space-y-1.5">
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">游戏ID</span><span className="text-white/90 font-medium truncate">{account.name}</span></div>
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">邮箱</span><span className="text-white/90 font-medium truncate">{account.email || '—（匿名条目）'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">账号状态</span>
                {disabled ? (
                  <span className="text-[var(--system-red)] font-medium">已禁用</span>
                ) : (
                  <span className="text-emerald-400 font-medium">正常</span>
                )}
              </div>
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">注册时间</span><span className="text-white/90">{fmt(account.createdAt)}</span></div>
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">末次登录</span><span className="text-white/90">{fmt(account.lastLoginAt)}</span></div>
              <div className="flex justify-between gap-2"><span className="text-muted-foreground">密码重置时间</span><span className="text-white/90">{fmt(account.passwordResetAt)}</span></div>
              {account.mustChangePassword && (
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">强制改密</span><span className="text-amber-400 font-medium">待玩家设置新密码</span></div>
              )}
            </div>

            {/* 临时密码一次性展示区（工单三：仅展示一次） */}
            {tempPassword ? (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 space-y-2">
                <p className="text-xs text-amber-300 font-medium flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> 临时密码（仅本次显示，关闭后不可再查看）
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-base font-bold tracking-[0.2em] text-white bg-black/40 rounded-lg px-3 py-2 select-all">{tempPassword}</code>
                  <button
                    onClick={copyTemp}
                    aria-label="复制临时密码"
                    className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-white transition-colors"
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  请通过可信渠道交付玩家；玩家首次登录将被强制要求设置新密码；重置已使该玩家全部旧登录会话失效。
                </p>
              </div>
            ) : account.isRegistered ? (
              <button
                onClick={doReset}
                disabled={busy}
                className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl bg-secondary-foreground text-[#0f0f1a] text-sm font-semibold hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                生成临时密码（重置密码）
              </button>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-1">该条目为匿名榜单条目（无账号），无法重置密码</p>
            )}

            {/* 禁用 / 恢复（工单二） */}
            {account.isRegistered && (
              disabled ? (
                <button
                  onClick={() => doStatus('restore')}
                  disabled={busy}
                  className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-emerald-400/30 text-emerald-300 text-sm font-semibold hover:bg-emerald-400/10 transition-all disabled:opacity-40"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  恢复账号（解除禁用）
                </button>
              ) : (
                <div className="space-y-2">
                  {confirmDisable && (
                    <Input
                      value={disableReason}
                      onChange={e => setDisableReason(e.target.value)}
                      placeholder="禁用原因（将记录到操作日志，可留空）"
                      aria-label="禁用原因"
                      className="text-xs bg-black/30 border-white/10 text-white"
                    />
                  )}
                  <button
                    onClick={() => doStatus('disable')}
                    disabled={busy}
                    className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-[var(--system-red)]/40 text-[var(--system-red)] text-sm font-semibold hover:bg-red-500/10 transition-all disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldBan className="w-4 h-4" />}
                    {confirmDisable ? '确认禁用（旧会话将立即失效）' : '禁用账号'}
                  </button>
                </div>
              )
            )}

            {error && account && (
              <p className="text-xs text-[var(--system-red)] flex items-center gap-1.5" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
