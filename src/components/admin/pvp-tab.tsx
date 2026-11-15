'use client';

// ============================================================
// Admin · 约战工单管理（工单 2026-11-10 V1.0，§11）
// ------------------------------------------------------------
// 只读总览：状态计数 + 状态筛选 + 玩家名搜索 + 分页 + 手动刷新。
// **不提供**任何代替玩家接受/拒绝的操作（工单 §11：管理员不得默认
// 拥有绕过玩家确认机制的权限）。
// 「API 测试」按钮仅调用无副作用健康检查 GET /api/pvp/health，
// 绝不向创建接口发送伪造 ping（工单 §9.4）。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Loader2, RefreshCw, Search, Swords } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { PVP_STATUSES, PVP_STATUS_LABELS, type PvpChallengeView, type PvpStatus } from '@/lib/pvp';
import { fmtSchedule, fmtTimeShort } from '@/lib/pvp-client';

interface AdminListResponse {
  ok: boolean;
  items: PvpChallengeView[];
  counts: Record<string, number>;
  total: number;
  page: number;
  pageSize: number;
  error?: string;
}

export function AdminPvpTab() {
  const [data, setData] = useState<AdminListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | PvpStatus>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [health, setHealth] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; text: string }>({ state: 'idle', text: '' });

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      params.set('page', String(page));
      params.set('pageSize', '20');
      const res = await adminFetch(`/api/v1/admin/pvp/challenges?${params.toString()}`, { cache: 'no-store' });
      const j = (await res.json()) as AdminListResponse;
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      if (!alive.current) return;
      setLoading(false);
    }
  }, [status, q, page]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  async function runHealthCheck() {
    setHealth({ state: 'busy', text: '' });
    try {
      const res = await adminFetch('/api/pvp/health', { cache: 'no-store' });
      const j = (await res.json()) as { ok?: boolean; db?: boolean; time?: string };
      if (res.ok && j.ok) {
        setHealth({ state: 'ok', text: `健康检查通过（数据库 ${j.db ? '正常' : '异常'} · ${j.time ?? ''}）` });
      } else {
        setHealth({ state: 'fail', text: `健康检查失败（HTTP ${res.status}）` });
      }
    } catch {
      setHealth({ state: 'fail', text: '健康检查网络失败' });
    }
  }

  const counts = data?.counts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 20)));

  return (
    <div className="space-y-3" data-testid="admin-pvp-tab">
      {/* 头部 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Swords className="w-4 h-4 text-[#d0a6f7]" aria-hidden="true" />
        <h3 className="text-sm font-semibold">约战工单管理</h3>
        <span className="text-[11px] text-muted-foreground">只读视图 · 接受/拒绝仅限玩家本人操作</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void runHealthCheck(); }}
            disabled={health.state === 'busy'}
            className="spring-press inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-[#c9d4cc] hover:bg-white/[0.08] disabled:opacity-50"
          >
            <Activity className="w-3.5 h-3.5" aria-hidden="true" /> API 测试（健康检查）
          </button>
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={loading}
            className="spring-press inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-[#c9d4cc] hover:bg-white/[0.08] disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> 刷新
          </button>
        </div>
      </div>

      {health.text && (
        <div role="status" className={`text-xs px-3 py-2 rounded-lg border ${health.state === 'ok' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {health.text}
        </div>
      )}

      {/* 状态计数 */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        <CountCard label="全部" value={totalAll} active={status === ''} onClick={() => { setStatus(''); setPage(1); }} />
        {PVP_STATUSES.map(s => (
          <CountCard
            key={s}
            label={PVP_STATUS_LABELS[s]}
            value={counts[s] ?? 0}
            active={status === s}
            onClick={() => { setStatus(status === s ? '' : s); setPage(1); }}
          />
        ))}
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1); }}
            placeholder="按玩家名称搜索"
            aria-label="按玩家名称搜索约战工单"
            className="h-9 w-full rounded-lg border border-white/10 bg-black/25 pl-8 pr-3 text-xs text-white placeholder:text-muted-foreground focus:border-[rgba(191,90,242,0.5)] focus:outline-none"
          />
        </div>
        <span className="text-[10px] text-muted-foreground ml-auto">共 {data?.total ?? 0} 条</span>
      </div>

      {/* 列表 */}
      {error ? (
        <div role="alert" className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-300">{error}</div>
      ) : loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 加载中…
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-xs text-muted-foreground">
          没有符合条件的约战工单
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.07]">
          <div className="max-h-96 overflow-y-auto custom-scrollbar">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-[#0d1410] text-[10px] font-bold text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-bold">发起方 → 对手</th>
                  <th className="px-3 py-2 font-bold">模式</th>
                  <th className="px-3 py-2 font-bold">预约时间</th>
                  <th className="px-3 py-2 font-bold">状态</th>
                  <th className="px-3 py-2 font-bold">创建</th>
                  <th className="px-3 py-2 font-bold">工单编号</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(c => (
                  <tr key={c.id} className="border-t border-white/[0.05] hover:bg-white/[0.02]">
                    <td className="px-3 py-2">
                      <span className="text-white/90">{c.role === 'challenger' ? c.counterpartName : ''}</span>
                      <span className="text-muted-foreground"> → </span>
                      <span className="text-white/90">{c.role === 'opponent' ? c.counterpartName : ''}</span>
                    </td>
                    <td className="px-3 py-2 text-[#c9d4cc]">{c.modeLabel}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-[#9db4a4]">{fmtSchedule(c.scheduledAt, c.timezone)}</td>
                    <td className="px-3 py-2"><StatusChip s={c.status} /></td>
                    <td className="px-3 py-2 font-mono text-[10px] text-[#9db4a4]">{fmtTimeShort(c.createdAt)}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground" title={c.id}>{c.id.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 分页 */}
      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" className="pvp-mini-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          <span className="text-[10px] text-muted-foreground">{page} / {totalPages}</span>
          <button type="button" className="pvp-mini-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页</button>
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        口径：约战工单为独立数据归属 —— pending/accepted 状态绝不写入正式 matches / 胜场 / K/D；
        赛果仍由管理员按既有比赛流程录入。接受、拒绝、取消只能由工单参与双方（登录玩家）执行。
      </p>
    </div>
  );
}

function CountCard({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-xl border p-2.5 text-left transition-colors ${active ? 'border-[rgba(191,90,242,0.5)] bg-[rgba(191,90,242,0.10)]' : 'border-white/[0.07] bg-[rgba(18,26,21,0.72)] hover:border-[rgba(191,90,242,0.35)]'}`}
    >
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="block font-mono text-lg font-bold text-white/90">{value}</span>
    </button>
  );
}

function StatusChip({ s }: { s: PvpStatus }) {
  const map: Record<PvpStatus, string> = {
    pending: 'border-[rgba(191,90,242,0.38)] bg-[rgba(191,90,242,0.12)] text-[#d0a6f7]',
    accepted: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    rejected: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    cancelled: 'border-white/12 bg-white/[0.04] text-muted-foreground',
    expired: 'border-white/12 bg-white/[0.04] text-muted-foreground',
    failed: 'border-white/12 bg-white/[0.04] text-muted-foreground',
  };
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold ${map[s]}`}>{PVP_STATUS_LABELS[s]}</span>;
}
