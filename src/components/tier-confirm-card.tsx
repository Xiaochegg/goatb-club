'use client';

// ============================================================
// 玩家成长记录确认卡（TIER_RECORD_RECOGNITION_REBUILD_V1 §3.7）
// ------------------------------------------------------------
// 「待确认 Tier 测试记录」卡片：管理员审批归档后，被测玩家（仅本人，
// 服务端强校验 matchedPlayerId）在「我的」面板确认或提出异议：
//  - 展示：玩家/测试项目/测试日期/考核员/测试者/双方胜场（独立展示）/
//    测试 tier/测试结果评价/击杀死亡=文档未提供/来源=Tier 测试工单（行号）；
//  - <确认记录> → POST /api/v1/tier-confirm { action:'confirm' }
//    （确认后进入正式成长记录序列，记录确认时间与来源）；
//  - <提出异议> → 必填原因（服务端校验）→ { action:'dispute' }
//    （进入待核对队列，等管理员处理；记录永不因超时自动删除）；
//  - 已确认/有异议的记录折叠展示状态；
//  - 未登录/无记录 → 卡片整体不渲染（面板零噪音）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface ConfirmRecord {
  id: string;
  project: string;
  testDate: string;
  examinerId: string;
  testeeId: string;
  testTier: string;
  testerWins: number | null;   // 被测玩家（本人）胜场
  assessorWins: number | null; // 考核员胜场
  review: string;
  killsDeaths: { available: false; note: string };
  source: { kind: 'tier_test_ticket'; docTab: string; sourceRow: number; submittedAt: string };
  confirmState: 'PLAYER_PENDING' | 'CONFIRMED' | 'DISPUTED';
  confirmedAt: string | null;
  disputedAt: string | null;
}

export function TierConfirmCard({ active, refreshKey }: { active: boolean; refreshKey?: number }) {
  const [records, setRecords] = useState<ConfirmRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [disputeFor, setDisputeFor] = useState<ConfirmRecord | null>(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeErr, setDisputeErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/tier-confirm');
      if (res.status === 401) { setRecords([]); return; } // 未登录 → 静默（卡片不渲染）
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setRecords((data.records as ConfirmRecord[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = useCallback(async (r: ConfirmRecord, action: 'confirm' | 'dispute', reason?: string) => {
    setBusyId(r.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/v1/tier-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: r.id, action, reason }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setNotice(data.message as string);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const submitDispute = useCallback(() => {
    if (!disputeFor) return;
    const reason = disputeReason.trim();
    if (!reason) { setDisputeErr('异议原因必填：请说明这条记录哪里与实际不符'); return; }
    setDisputeErr(null);
    void act(disputeFor, 'dispute', reason);
    setDisputeFor(null);
    setDisputeReason('');
  }, [disputeFor, disputeReason, act]);

  const pending = records.filter(r => r.confirmState === 'PLAYER_PENDING');
  const done = records.filter(r => r.confirmState !== 'PLAYER_PENDING');
  if (!active || (!loading && records.length === 0)) return null;

  return (
    <section className="mb-4" aria-label="待确认 Tier 测试记录">
      <h4 className="text-[12px] font-semibold text-white/90 mb-2 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-jade-400" aria-hidden="true" />
        待确认 Tier 测试记录
        {pending.length > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-jade-500/15 text-jade-300 border border-jade-500/30">
            {pending.length} 条待确认
          </span>
        )}
      </h4>

      {loading && <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 py-2"><Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />加载中…</div>}
      {error && <div role="alert" className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5 leading-relaxed">{error}</div>}
      {notice && <div role="status" className="text-[11px] text-jade-300 bg-jade-500/10 border border-jade-500/30 rounded-lg px-2.5 py-1.5 leading-relaxed">{notice}</div>}

      <div className="flex flex-col gap-2">
        {pending.map(r => (
          <div key={r.id} className="rounded-xl border border-jade-500/25 bg-jade-500/[0.05] p-3 flex flex-col gap-2">
            <div className="text-[11px] font-bold text-jade-300">新的 Tier 测试记录待确认</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] leading-relaxed">
              <span className="text-muted-foreground">玩家：<span className="text-white/90 font-medium">{r.testeeId}</span></span>
              <span className="text-muted-foreground">测试项目：<span className="text-white/90">{r.project}</span></span>
              <span className="text-muted-foreground">测试日期：<span className="text-white/90">{r.testDate}</span></span>
              <span className="text-muted-foreground">测试 tier：<span className="text-white/90 font-bold">{r.testTier}</span></span>
              <span className="text-muted-foreground">考核员：<span className="text-white/90">{r.examinerId}</span></span>
              <span className="text-muted-foreground">测试者：<span className="text-white/90">{r.testeeId}</span></span>
              <span className="text-muted-foreground">测试者胜场：<span className="text-white/90 font-bold">{r.testerWins ?? '未填'}</span></span>
              <span className="text-muted-foreground">考核员胜场：<span className="text-white/90 font-bold">{r.assessorWins ?? '未填'}</span></span>
              <span className="text-muted-foreground">击杀/死亡：<span className="text-amber-300/90">{r.killsDeaths.note}</span></span>
              <span className="text-muted-foreground">来源：Tier 测试工单（第 {r.source.sourceRow} 行）</span>
              {r.review && <span className="text-muted-foreground col-span-2">测试评价：<span className="text-white/75">{r.review}</span></span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <button
                onClick={() => void act(r, 'confirm')}
                disabled={busyId === r.id}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[11px] font-bold bg-jade-500/15 text-jade-300 border border-jade-500/30 hover:bg-jade-500/25 transition-colors disabled:opacity-50 min-h-[36px] focus-visible:ring-2 focus-visible:ring-primary"
              >
                {busyId === r.id ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                确认记录
              </button>
              <button
                onClick={() => { setDisputeFor(r); setDisputeReason(''); setDisputeErr(null); }}
                disabled={busyId === r.id}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[11px] font-medium text-muted-foreground border border-white/10 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50 min-h-[36px] focus-visible:ring-2 focus-visible:ring-primary"
              >
                <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                提出异议
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              确认后该记录进入你的正式成长记录序列；提出异议需填写原因，记录会进入管理员待核对队列（不会被自动删除）。
            </p>
          </div>
        ))}

        {done.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02]">
            <button
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground hover:text-white transition-colors"
            >
              {expanded ? <ChevronDown className="w-3 h-3" aria-hidden="true" /> : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
              已处理记录（{done.length} 条：已确认 {done.filter(r => r.confirmState === 'CONFIRMED').length} · 有异议 {done.filter(r => r.confirmState === 'DISPUTED').length}）
            </button>
            {expanded && done.map(r => (
              <div key={r.id} className="border-t border-white/5 px-3 py-2 text-[10px] text-muted-foreground leading-relaxed">
                {r.testDate} · {r.project} → {r.testTier} · 胜 {r.testerWins ?? '—'}:{r.assessorWins ?? '—'} ·{' '}
                {r.confirmState === 'CONFIRMED'
                  ? <span className="text-jade-300">已确认{r.confirmedAt ? `（${r.confirmedAt.slice(0, 19).replace('T', ' ')}）` : ''}</span>
                  : <span className="text-red-300">有异议（等待管理员处理，记录不会删除）</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 异议原因弹窗（必填） */}
      <Dialog open={!!disputeFor} onOpenChange={v => { if (!v) setDisputeFor(null); }}>
        <DialogContent className="bg-card border-white/10 max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">提出异议</DialogTitle>
            <DialogDescription asChild>
              <div className="text-[11px] leading-relaxed">
                记录：{disputeFor?.testDate} · {disputeFor?.project} → {disputeFor?.testTier} ·
                考核员 {disputeFor?.examinerId} · 胜 {disputeFor?.testerWins ?? '—'}:{disputeFor?.assessorWins ?? '—'}
              </div>
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={disputeReason}
            onChange={e => { setDisputeReason(e.target.value); setDisputeErr(null); }}
            placeholder="异议原因（必填）：请说明这条记录哪里与实际不符（如段位、胜场、日期有误）"
            rows={3}
            className="text-xs"
            aria-label="异议原因"
          />
          {disputeErr && <div className="text-[10px] text-red-300">{disputeErr}</div>}
          <DialogFooter>
            <button
              onClick={() => setDisputeFor(null)}
              className="px-3 py-2 rounded-lg text-[11px] text-muted-foreground hover:text-white min-h-[36px]"
            >
              取消
            </button>
            <button
              onClick={submitDispute}
              className="px-3 py-2 rounded-lg text-[11px] font-bold bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 min-h-[36px]"
            >
              提交异议
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
