'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L220-L417），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：概览页签（Ops Center）。
// ============================================================
import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, AlertTriangle, TrendingUp, Camera } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { BOARD_TABS, MODE_LABELS, type GameMode } from '@/lib/constants';
import { McIcon } from '@/components/mc-icon';
import { MC_ICONS } from '@/lib/mc-icons';

// --- Admin: Dashboard (Ops Center, spec §12) ---
export function AdminDashboard() {
  const { setSelectedPlayerId } = useAppStore();
  const [data, setData] = useState<{
    overview: { totalPlayers: number; newToday: number; avgScore: number; totalLikes: number; emotionCount: number };
    activeModes: Array<{ mode: string; count: number }>;
    recentLogs: Array<{ id: string; type: string; detail: string; createdAt: string; adminKey: string | null }>;
    topMovers: Array<{ playerId: string; playerName: string; mode: string; delta: number; direction: 'up' | 'down' }>;
    suspicious: Array<{ playerId: string; playerName: string; reason: string; value: string }>;
    suspiciousCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [authFailed, setAuthFailed] = useState(false); // 401 → 引导重新登录而非无效果重试
  // P2-6（审计 2026-11-13）：排名快照此前无任何 UI 触发入口（POST 零调用方），
  // RankSnapshot 永远 0 行 → topMovers/排名历史永远空。本按钮为唯一触发入口。
  const [snapshotState, setSnapshotState] = useState<
    { phase: 'idle' | 'running' | 'ok' | 'error'; msg?: string }
  >({ phase: 'idle' });

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/admin/dashboard');
      // Bugfix 2026-11: 401/500 时响应体是 {error:...}——之前未检查 res.ok 就 setData，
      // 导致 data 为真值但 data.overview 为 undefined → 渲染 overview.totalPlayers 崩溃。
      // 修复：非 200 或缺 overview 一律按失败处理（显示重试 UI），不进渲染分支。
      // 2026-11 环境兼容补充：401 时明确提示「登录已失效」并引导重新登录，
      // 盲目重试永远不会成功（凭据不在，不是瞬时故障）。
      if (res.status === 401) {
        setAuthFailed(true);
        setData(null);
      } else if (!res.ok) {
        setAuthFailed(false);
        setData(null);
      } else {
        const d = await res.json();
        setAuthFailed(false);
        setData(d?.overview ? d : null);
      }
    } catch { setAuthFailed(false); setData(null); }
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchDashboard is async
  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  const captureSnapshot = useCallback(async () => {
    setSnapshotState({ phase: 'running' });
    try {
      const res = await adminFetch('/api/v1/rank-snapshots', { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setSnapshotState({ phase: 'ok', msg: `已捕获 ${d.captured} 条快照（${d.modes} 榜 × ${d.players} 人）` });
        fetchDashboard(); // 快照落库后刷新 topMovers/recentLogs
      } else {
        setSnapshotState({ phase: 'error', msg: d?.error ?? `失败（${res.status}）` });
      }
    } catch {
      setSnapshotState({ phase: 'error', msg: '网络错误' });
    }
  }, [fetchDashboard]);

  if (loading) {
    return <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>;
  }
  // Bugfix 2026-11: 防御性守卫 — data 存在但缺 overview（异常响应）也走失败分支
  if (!data?.overview) {
    if (authFailed) {
      return (
        <div className="py-8 text-center">
          <p className="text-xs text-amber-400">管理员登录已失效，请重新登录</p>
          <button
            onClick={() => useAppStore.getState().setAdminLoginOpen(true)}
            className="mt-2 text-xs text-jade-400 hover:text-jade-300 font-medium"
          >
            重新登录
          </button>
        </div>
      );
    }
    return (
      <div className="py-8 text-center">
        <p className="text-xs text-muted-foreground">加载失败，请刷新重试</p>
        <button
          onClick={fetchDashboard}
          className="mt-2 text-xs text-jade-400 hover:text-jade-300 font-medium"
        >
          重试
        </button>
      </div>
    );
  }

  const { overview, activeModes, recentLogs, topMovers, suspicious } = data;
  const modeLabel = (m: string) => m === 'TOTAL' ? '总榜' : m === 'EMOTION' ? '感动榜' : MODE_LABELS[m as GameMode] || m;
  const modeIcon = (m: string) => BOARD_TABS.find(t => t.key === m)?.icon || MC_ICONS.TOTAL;

  return (
    <div className="space-y-4">
      {/* Overview stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="liquid-glass-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">玩家总数</div>
          <div className="text-xl font-bold text-white number-score mt-0.5">{overview.totalPlayers}</div>
          <div className="text-[10px] text-jade-400 mt-0.5">今日 +{overview.newToday}</div>
        </div>
        <div className="liquid-glass-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">平均分</div>
          <div className="text-xl font-bold liquid-score number-score mt-0.5">{overview.avgScore.toLocaleString()}</div>
        </div>
        <div className="liquid-glass-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">总点赞</div>
          <div className="text-xl font-bold text-[var(--system-pink)] number-score mt-0.5">{overview.totalLikes}</div>
        </div>
        <div className="liquid-glass-subtle rounded-xl p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">感动榜</div>
          <div className="text-xl font-bold text-[var(--system-red)] number-score mt-0.5">{overview.emotionCount}</div>
        </div>
      </div>

      {/* Top movers + suspicious (2-col on desktop) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Top movers */}
        <div className="liquid-glass-subtle rounded-xl p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h4 className="text-xs font-bold text-white/80 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-jade-400" /> 排名飙升
            </h4>
            <button
              onClick={captureSnapshot}
              disabled={snapshotState.phase === 'running'}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-white/10 text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jade-300/70"
              aria-label="生成排名快照：为全部玩家各榜捕获当前名次，作为排名变化历史基准"
              title="生成排名快照（全部玩家 × 全部模式）"
            >
              {snapshotState.phase === 'running'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Camera className="w-3 h-3" />}
              {snapshotState.phase === 'running' ? '捕获中…' : '生成排名快照'}
            </button>
          </div>
          {snapshotState.phase === 'ok' && (
            <p className="text-[10px] text-jade-400 mb-2">{snapshotState.msg}</p>
          )}
          {snapshotState.phase === 'error' && (
            <p className="text-[10px] text-amber-400 mb-2">快照失败：{snapshotState.msg}</p>
          )}
          {topMovers.length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-3 text-center">暂无快照数据，点击右上「生成排名快照」后，下次快照对比即可显示排名变化</p>
          ) : (
            <div className="space-y-1">
              {topMovers.map((m, i) => (
                <button
                  key={`${m.playerId}-${m.mode}-${i}`}
                  onClick={() => setSelectedPlayerId(m.playerId)}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={cn('text-[10px] font-bold flex-shrink-0', m.direction === 'up' ? 'text-[var(--system-green)]' : 'text-[var(--system-red)]')}>
                      {m.direction === 'up' ? '▲' : '▼'} {Math.abs(m.delta)}
                    </span>
                    <span className="text-xs text-white truncate">{m.playerName}</span>
                  </span>
                  <span className="text-[9px] text-muted-foreground flex-shrink-0 ml-2">{modeLabel(m.mode)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Suspicious data */}
        <div className="liquid-glass-subtle rounded-xl p-3">
          <h4 className="text-xs font-bold text-white/80 flex items-center gap-1.5 mb-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> 数据异常
            {suspicious.length > 0 && <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 rounded-full">{suspicious.length}</span>}
          </h4>
          {suspicious.length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-3 text-center">无异常数据</p>
          ) : (
            <div className="space-y-1">
              {suspicious.map((s, i) => (
                <button
                  key={`${s.playerId}-${i}`}
                  onClick={() => setSelectedPlayerId(s.playerId)}
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-amber-500/5 transition-colors text-left"
                >
                  <span className="text-xs text-white truncate">{s.playerName}</span>
                  <span className="text-[9px] text-amber-400 flex-shrink-0 ml-2">{s.reason} · {s.value}</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-[9px] text-muted-foreground/60 mt-2">仅提示，不自动处罚</p>
        </div>
      </div>

      {/* Active modes */}
      <div className="liquid-glass-subtle rounded-xl p-3">
        <h4 className="text-xs font-bold text-white/80 mb-2">活跃模式</h4>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
          {activeModes.map(m => (
            <div key={m.mode} className="bg-white/5 rounded-lg p-2 text-center">
              <div className="text-base flex items-center justify-center"><McIcon src={modeIcon(m.mode)} className="w-4 h-4" /></div>
              <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{modeLabel(m.mode)}</div>
              <div className="text-sm font-bold text-white number-score">{m.count}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent operations */}
      <div className="liquid-glass-subtle rounded-xl p-3">
        <h4 className="text-xs font-bold text-white/80 mb-2">最近操作</h4>
        {recentLogs.length === 0 ? (
          <p className="text-[10px] text-muted-foreground py-2 text-center">暂无操作记录</p>
        ) : (
          <div className="space-y-1">
            {recentLogs.map(log => (
              <div key={log.id} className="flex items-center gap-2 px-2 py-1 rounded text-[10px]">
                <span className={cn(
                  'px-1.5 py-0.5 rounded font-bold flex-shrink-0',
                  log.type === 'create' ? 'bg-jade-500/15 text-jade-400' :
                  log.type === 'delete' ? 'bg-red-500/15 text-red-400' :
                  log.type === 'update' ? 'bg-blue-500/15 text-blue-400' :
                  log.type === 'purge' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-white/5 text-muted-foreground'
                )}>{log.type}</span>
                <span className="text-white/70 flex-1 truncate">{log.detail}</span>
                <span className="text-muted-foreground/60 flex-shrink-0">
                  {new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
