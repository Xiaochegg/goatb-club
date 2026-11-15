'use client';

// ============================================================
// Tier Command · 收集表自动同步控制卡（管理员指令 2026-11-09）
// ------------------------------------------------------------
// - 「自动存档」= 服务端常开定时器：开关 + 间隔（5/10/30/60 分钟）
//   持久化在服务器 Config，重启/重新部署后自动恢复，与任何设备的
//   登录状态无关（管理员不开后台时照常运行）；
// - 开启时立即拉一轮（幂等：重复拉取仅计数，绝不重复累计）；
// - 最近一次运行结果如实显示（失败红显 code+message，绝不假报成功）；
// - 治理红线说明（固定展示）：自动同步只到「入台账+识别整理」，
//   写玩家档案必须逐条人工审批 + 玩家确认。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Timer } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';

interface LastRun {
  at: string;
  ok: boolean;
  code?: string;
  message?: string;
  trigger: 'boot' | 'timer' | 'manual-toggle' | 'manual-api';
  newRecords?: number;
  mergedDupes?: number;
  idempotentHits?: number;
  readyCount?: number;
  pendingReviewCount?: number;
}

interface AutoIngestStatus {
  enabled: boolean;
  intervalMin: number;
  schedulerRunning: boolean;
  busy: boolean;
  nextRunAt: string | null;
  lastRun: LastRun | null;
}

const INTERVALS = [5, 10, 30, 60];

const TRIGGER_LABEL: Record<LastRun['trigger'], string> = {
  boot: '开机自动',
  timer: '定时器',
  'manual-toggle': '手动开启',
  'manual-api': '手动触发',
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

export function TierAutoIngestControl({ onSynced }: { onSynced?: () => void }) {
  const [status, setStatus] = useState<AutoIngestStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch('/api/v1/tier-command/auto-ingest');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setStatus(data.status as AutoIngestStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 30_000); // 轻量轮询：状态卡 30s 刷新
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(async (body: { enabled?: boolean; intervalMin?: number }) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/auto-ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setStatus(data.status as AutoIngestStatus);
      setNotice(data.message as string);
      if (data.run?.ok) onSynced?.(); // 即时拉取成功 → 刷新台账数据
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(false);
    }
  }, [load, onSynced]);

  const on = status?.enabled ?? false;
  const last = status?.lastRun ?? null;

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 flex flex-col gap-2">
      {/* 标题行 + 开关按钮 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-bold text-white/90">
          <Timer className="w-4 h-4 text-sky-300" aria-hidden="true" />
          自动同步（收集表 → 台账）
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border tracking-wide ${
              on
                ? 'bg-jade-500/15 text-jade-300 border-jade-500/30'
                : 'bg-white/5 text-muted-foreground border-white/10'
            }`}
          >
            {status ? (on ? `已开启 · 每 ${status.intervalMin} 分钟` : '未开启') : '…'}
          </span>
          {status?.busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-300" aria-label="正在拉取" />}
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="tier-auto-ingest-interval">自动同步间隔</label>
          <select
            id="tier-auto-ingest-interval"
            value={status?.intervalMin ?? 10}
            disabled={busy || !status}
            onChange={e => void post({ intervalMin: Number(e.target.value) })}
            className="text-xs rounded-lg bg-white/5 border border-white/10 text-white/90 px-2 py-2 min-h-[44px] focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            {INTERVALS.map(m => <option key={m} value={m}>每 {m} 分钟</option>)}
          </select>
          <button
            onClick={() => void post({ enabled: !on })}
            disabled={busy || !status}
            aria-pressed={on}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold min-h-[44px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary ${
              on
                ? 'bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20'
                : 'bg-jade-500/15 text-jade-300 border border-jade-500/30 hover:bg-jade-500/25'
            }`}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {on ? '停止自动同步' : '开启自动同步'}
          </button>
        </div>
      </div>

      {/* 状态行 */}
      {status && (
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          {on
            ? <>下次自动拉取：<span className="text-white/80">{fmtTime(status.nextRunAt)}</span>（服务器定时器{status.schedulerRunning ? '运行中' : '未运行'}，与设备登录无关）</>
            : '未开启：服务器不会自动拉取；可手动「拉取收集表归档」。'}
          {last && (
            <>
              {' '}最近一次（{TRIGGER_LABEL[last.trigger]} · {fmtTime(last.at)}）：
              {last.ok ? (
                <span className="text-jade-300">
                  成功 · 新建 {last.newRecords ?? 0} · 合并重复 {last.mergedDupes ?? 0} · 幂等命中 {last.idempotentHits ?? 0}
                  {typeof last.readyCount === 'number' && <> · 待归档 {last.readyCount} / 待核对 {last.pendingReviewCount ?? 0}</>}
                </span>
              ) : (
                <span className="text-red-300" role="alert">
                  失败 [{last.code}] {last.message ?? ''}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* 治理红线（固定说明） */}
      <div className="text-[10px] text-muted-foreground/80 leading-relaxed">
        自动同步只做「拉取 → 识别整理 → 入台账」；写玩家档案必须逐条人工审批 + 玩家确认，绝不自动写入。
        开关与间隔保存在服务器：重启/重新部署后自动恢复运行。
      </div>

      {error && (
        <div role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 leading-relaxed">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="text-xs text-jade-300 bg-jade-500/10 border border-jade-500/30 rounded-lg px-3 py-2 leading-relaxed">
          {notice}
        </div>
      )}
    </div>
  );
}
