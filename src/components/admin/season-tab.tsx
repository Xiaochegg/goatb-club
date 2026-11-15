'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1220-L1437），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：赛季管理页签。
// ============================================================
import { useEffect, useState, useCallback } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { ConfirmDialog } from './shared';

// --- Admin: Season Management ---
export function AdminSeasonManage() {
  const { currentSeasonId, setCurrentSeasonId } = useAppStore();
  const [seasons, setSeasons] = useState<Array<{
    id: string; name: string; startAt: string; endAt: string | null; status: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', startAt: '', endAt: '', status: 'UPCOMING' });
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // P2-1: confirm() → 受控 ConfirmDialog
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchSeasons = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/seasons');
      const data = await res.json();
      setSeasons(data.seasons || []);
      // Auto-select the ACTIVE season as current
      const active = (data.seasons || []).find((s: { status: string }) => s.status === 'ACTIVE');
      if (active && !currentSeasonId) setCurrentSeasonId(active.id);
    } catch {
      setSeasons([]);
    }
    setLoading(false);
  }, [currentSeasonId, setCurrentSeasonId]);

  useEffect(() => { fetchSeasons(); }, [fetchSeasons]);

  const createSeason = async () => {
    if (!form.name || !form.startAt) {
      setMsg({ type: 'error', text: '名称和开始时间为必填' });
      return;
    }
    try {
      const res = await adminFetch('/api/v1/seasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ type: 'success', text: `赛季 ${data.season.name} 已创建` });
        setForm({ name: '', startAt: '', endAt: '', status: 'UPCOMING' });
        setShowForm(false);
        fetchSeasons();
      } else {
        setMsg({ type: 'error', text: data.error || '创建失败' });
      }
    } catch {
      setMsg({ type: 'error', text: '网络错误' });
    }
  };

  const activateSeason = async (id: string) => {
    try {
      const res = await adminFetch(`/api/v1/seasons/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE' }),
      });
      if (res.ok) {
        setCurrentSeasonId(id);
        setMsg({ type: 'success', text: '赛季已激活' });
        fetchSeasons();
      }
    } catch {
      setMsg({ type: 'error', text: '激活失败' });
    }
  };

  // P2-1: 原生 confirm → ConfirmDialog；删除执行拆出为纯函数
  const deleteSeason = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await adminFetch(`/api/v1/seasons/${confirmDelete.id}`, { method: 'DELETE' });
      if (currentSeasonId === confirmDelete.id) setCurrentSeasonId(null);
      setMsg({ type: 'success', text: '已删除' });
      fetchSeasons();
    } catch {
      setMsg({ type: 'error', text: '删除失败' });
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const statusColor: Record<string, string> = {
    ACTIVE: 'bg-jade-500/15 text-jade-400 border-jade-500/30',
    UPCOMING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    ENDED: 'bg-white/5 text-muted-foreground border-white/10',
  };

  const statusLabel: Record<string, string> = {
    ACTIVE: '进行中',
    UPCOMING: '未开始',
    ENDED: '已结束',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-secondary-foreground">赛季管理</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="spring-press px-3 min-h-[36px] rounded-xl bg-jade-500/15 text-jade-400 border border-jade-500/30 text-xs font-medium flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> {showForm ? '取消' : '新建赛季'}
        </button>
      </div>

      {showForm && (
        <div className="liquid-glass-subtle rounded-xl p-3 space-y-2">
          <input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="赛季名称（如：Season 01）"
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none focus:border-jade-500/30"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={form.startAt}
              onChange={e => setForm({ ...form, startAt: e.target.value })}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none"
            />
            <input
              type="date"
              value={form.endAt}
              onChange={e => setForm({ ...form, endAt: e.target.value })}
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none"
            />
          </div>
          <select
            value={form.status}
            onChange={e => setForm({ ...form, status: e.target.value })}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none"
          >
            <option value="UPCOMING">未开始</option>
            <option value="ACTIVE">进行中（激活）</option>
            <option value="ENDED">已结束</option>
          </select>
          <button
            onClick={createSeason}
            className="w-full spring-press px-3 min-h-[40px] rounded-lg bg-jade-500 text-jade-900 text-sm font-semibold"
          >
            创建
          </button>
        </div>
      )}

      {msg && (
        <div className={`p-2.5 rounded-lg text-xs ${msg.type === 'success' ? 'bg-jade-500/10 text-jade-400' : 'bg-red-500/10 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" /></div>
      ) : seasons.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          暂无赛季，点击"新建赛季"创建第一个
        </div>
      ) : (
        <div className="space-y-2">
          {seasons.map(s => (
            <div
              key={s.id}
              className={`liquid-glass-subtle rounded-xl p-3 ${currentSeasonId === s.id ? 'ring-1 ring-jade-500/40' : ''}`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">{s.name}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${statusColor[s.status]}`}>
                    {statusLabel[s.status]}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {s.status !== 'ACTIVE' && (
                    <button
                      onClick={() => activateSeason(s.id)}
                      className="px-2 py-1 rounded text-[10px] bg-jade-500/10 text-jade-400 hover:bg-jade-500/20 transition-colors"
                    >
                      激活
                    </button>
                  )}
                  <button
                    onClick={() => setConfirmDelete({ id: s.id, name: s.name })}
                    className="px-2 py-1 rounded text-[10px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {new Date(s.startAt).toLocaleDateString('zh-CN')} → {s.endAt ? new Date(s.endAt).toLocaleDateString('zh-CN') : '无限期'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* P2-1: 删除赛季二次确认 */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={o => { if (!o) setConfirmDelete(null); }}
        title={`确认删除赛季 ${confirmDelete?.name ?? ''}？`}
        description="删除后该赛季无法恢复；若为当前赛季，排行榜将回到无赛季状态。"
        confirmLabel="确认删除"
        onConfirm={deleteSeason}
        busy={deleting}
      />
    </div>
  );
}
