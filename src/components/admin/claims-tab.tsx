'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1725-L1941），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：认领审批页签（两段式确认 + 历史折叠）。
// ============================================================
import { useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { UserCheck, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { adminFetch } from '@/lib/admin-fetch';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/lib/store';

export interface AdminClaimRow {
  id: string;
  status: string | null;
  createdAt: string;
  updatedAt: string | null;
  detail: string;
  actorId?: string | null;
  actorName: string;
  actorEmail?: string | null;
  claimerNote?: string | null;
  targetName: string;
  // 准确度修复（批示 trace 1a1d027ae7f6abd1）：目标条目当前邮箱
  // （占位邮箱 = 审批通过后将被替换的对象；匿名代录为 null）
  targetEmail?: string | null;
}

// --- Admin: Claims 认领审批（claim-mechanism v1） ---
// 列出 pending 认领请求（发起者+邮箱+目标条目），一键通过/拒绝。
// 通过为不可逆操作 → 两段式确认（点一次变「确认通过」，3 秒未点自动复位）。
// 历史记录（approved/rejected）只读折叠展示。
// 审批动作 PATCH /api/v1/claims/[id]；数据源 GET /api/v1/claims（管理员视角）。
export function AdminClaims() {
  const [claims, setClaims] = useState<AdminClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [featureOn, setFeatureOn] = useState(true);
  const [armedId, setArmedId] = useState<string | null>(null);   // 两段式确认状态
  const [actingId, setActingId] = useState<string | null>(null); // 请求进行中
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [toggling, setToggling] = useState(false);
  const adminRole = useAppStore(s => s.adminRole);
  const canWrite = adminRole === 'OWNER' || adminRole === 'ADMIN';

  // 认领机制开关（工单 2026-11-12：此前只能改库/env，现可视化）
  const toggleFeature = async () => {
    if (toggling || !canWrite) return;
    setToggling(true);
    setActionErr(null);
    try {
      const res = await adminFetch('/api/v1/admin/claims-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !featureOn }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionErr(data?.error || '开关操作失败');
      } else {
        setFeatureOn(!!data.enabled);
        await fetchClaims();
      }
    } catch {
      setActionErr('网络异常，请重试');
    } finally {
      setToggling(false);
    }
  };

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/claims');
      if (!res.ok) {
        // 403 = 功能未开启；401 = 会话过期
        setFeatureOn(false);
        setClaims([]);
        return;
      }
      const data = await res.json();
      setFeatureOn(!!data?.enabled);
      setClaims(Array.isArray(data?.claims) ? data.claims : []);
    } catch {
      setFeatureOn(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  const act = async (id: string, action: 'approve' | 'reject') => {
    if (actingId) return;
    // 通过 = 不可逆 → 两段式确认
    if (action === 'approve' && armedId !== id) {
      setArmedId(id);
      setTimeout(() => setArmedId(cur => (cur === id ? null : cur)), 3000);
      return;
    }
    setActingId(id);
    setActionErr(null);
    try {
      const res = await adminFetch(`/api/v1/claims/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionErr(data?.error || '操作失败，请重试');
        return;
      }
      setArmedId(null);
      await fetchClaims();
    } catch {
      setActionErr('网络异常，请重试');
    } finally {
      setActingId(null);
    }
  };

  if (!featureOn) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-secondary-foreground flex items-center gap-2">
          <UserCheck className="w-4 h-4" /> 认领审批
        </h3>
        <div className="rounded-lg bg-amber-400/10 border border-amber-400/25 px-3 py-3 text-xs text-amber-200/90 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>认领功能当前未开启。开启后：玩家注册撞名（管理员代录条目）可直达认领申请，登录玩家也可认领匿名条目。</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-white/3 border border-white/8 px-3 py-2.5">
          <span className="text-xs text-white/80">认领机制</span>
          {canWrite ? (
            <Switch checked={false} disabled={toggling} onCheckedChange={toggleFeature} aria-label="开启认领机制" />
          ) : (
            <span className="text-[10px] text-muted-foreground">仅 OWNER/ADMIN 可操作</span>
          )}
        </div>
      </div>
    );
  }

  const pending = claims.filter(c => c.status === 'pending');
  const history = claims.filter(c => c.status !== 'pending');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-secondary-foreground flex items-center gap-2">
          <UserCheck className="w-4 h-4" /> 认领审批
          {pending.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/30">
              {pending.length} 待审
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-muted-foreground hidden sm:inline">认领机制</span>
          <Switch checked={featureOn} disabled={toggling || !canWrite} onCheckedChange={toggleFeature} aria-label="认领机制开关" />
          <motion.button
            onClick={fetchClaims}
            aria-label="刷新认领列表"
            className="spring-press text-muted-foreground hover:text-white"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </motion.button>
        </div>
      </div>

      {actionErr && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2" role="alert">
          {actionErr}
        </p>
      )}

      {/* 待审批列表 */}
      <div className="space-y-2 max-h-[260px] overflow-y-auto custom-scrollbar">
        {loading ? (
          <p className="text-xs text-muted-foreground text-center py-4 flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
          </p>
        ) : pending.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">暂无待审批的认领请求</p>
        ) : (
          pending.map(c => (
            <div
              key={c.id}
              className="rounded-lg bg-white/3 border border-white/8 px-3 py-2.5 space-y-2"
              role="listitem"
              aria-label={`认领请求：${c.actorName} 认领 ${c.targetName}`}
            >
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {!c.actorId && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30 flex-shrink-0">注册直达</span>
                )}
                <span className="font-semibold text-white">{c.actorName}</span>
                <span className="text-muted-foreground">请求认领</span>
                <span className="font-semibold text-jade-400">{c.targetName}</span>
                <span className="text-muted-foreground ml-auto">
                  {new Date(c.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {c.claimerNote && (
                <p className="text-[10px] text-white/60 bg-white/5 rounded px-2 py-1">玩家备注：{c.claimerNote}</p>
              )}
              {c.actorEmail && (
                <p className="text-[10px] text-muted-foreground">发起者邮箱：{c.actorEmail}（请线下核实身份后审批）</p>
              )}
              {/* 准确度修复（批示 trace 1a1d027ae7f6abd1）：展示目标条目当前邮箱，
                  管理员审批前可见将要替换掉的占位邮箱 */}
              <p className="text-[10px] text-muted-foreground">
                目标条目邮箱：{c.targetEmail ? `${c.targetEmail}（占位，通过后替换为玩家邮箱）` : '未绑定（匿名代录）'}
              </p>
              <div className="flex items-center gap-2">
                <motion.button
                  onClick={() => act(c.id, 'reject')}
                  disabled={actingId === c.id}
                  aria-label={`拒绝 ${c.actorName} 认领 ${c.targetName}`}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
                >
                  {actingId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : '拒绝'}
                </motion.button>
                <motion.button
                  onClick={() => act(c.id, 'approve')}
                  disabled={actingId === c.id}
                  aria-label={`通过 ${c.actorName} 认领 ${c.targetName}`}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50',
                    armedId === c.id
                      ? 'bg-amber-400/20 text-amber-200 border border-amber-400/40'
                      : 'bg-jade-500/15 text-jade-400 border border-jade-500/30 hover:bg-jade-500/25',
                  )}
                >
                  {armedId === c.id ? '确认通过？' : '通过'}
                </motion.button>
                {armedId === c.id && (
                  <span className="text-[10px] text-amber-300/80">通过后不可逆</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 历史记录（只读折叠） */}
      {history.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowHistory(v => !v)}
            aria-expanded={showHistory}
            className="text-[11px] text-muted-foreground hover:text-white transition-colors flex items-center gap-1"
          >
            <span aria-hidden="true">{showHistory ? '▾' : '▸'}</span>
            历史记录（{history.length}）
          </button>
          {showHistory && (
            <div className="mt-2 space-y-1.5 max-h-[180px] overflow-y-auto custom-scrollbar">
              {history.map(c => (
                <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/3 text-[11px]">
                  <span
                    className={cn(
                      'font-semibold flex-shrink-0',
                      c.status === 'approved' ? 'text-jade-400' : 'text-red-300/80',
                    )}
                  >
                    {c.status === 'approved' ? '✓ 通过' : '✕ 拒绝'}
                  </span>
                  <span className="text-white/70 truncate">{c.detail}</span>
                  <span className="text-muted-foreground ml-auto flex-shrink-0">
                    {new Date(c.updatedAt || c.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
