'use client';

// ============================================================
// Tier Command · 归档台账区块（TIER_RECORD_RECOGNITION_REBUILD_V1）
// ------------------------------------------------------------
// 管理员批复 2026-11-09「批准」（P0/P1 报告 §3.8）：
//  - 「立即拉取收集表归档」→ POST /api/v1/tier-command/ingest
//    （幂等：同来源行重复拉取仅计数，绝不重复累计）；
//  - 管理员十态统计条（已读取/已识别/已合并/待核对/待归档/已归档/
//    待玩家确认/已确认/有异议/同步失败）；
//  - 记录视图：按「玩家名称优先」分组（提交者仅审计，永不作分组/排序主键），
//    服务端已按四层排序（玩家名→考核组合→测试日期旧→新→提交者兜底）；
//  - 每条独立审批归档（选择模式 + 创建并写入显式勾选；无预设勾选/全选）；
//  - 双方胜场独立展示（测试者/考核员），绝不混淆/相加；
//  - 击杀/死亡：文档未提供（显式缺失标注，绝不补 0/不从胜场推算）；
//  - 玩家确认状态徽章 + 异议原因展示（异议队列 = DISPUTED 记录置顶区）；
//  - 完全重复来源聚合展示（dupSources：同一份内容多来源合并为一条有效记录）。
// 绝对硬约束（继承现行纪律）：每条必须管理员手动确认（模式必选）；
//  不写 Player.stats（胜场不参与评分）；失败不显示成功。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { TierAutoIngestControl } from './tier-auto-ingest-control';
import { ALL_MODES, MODE_LABELS, type GameMode } from '@/lib/constants';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ---------- 类型（与 ledger / ingest / ledger-approve API 对齐） ----------

interface LedgerDupSource { sourceRow: number; submitter: string; submittedAt: string | null; mergedAt?: string }

interface LedgerRecord {
  id: string;
  batchId: string;
  sourceRow: number;
  rowFingerprint: string;
  raw: {
    submitter: string; submittedAt: string; project: string; testDate: string;
    examiner: string; testee: string; testTier: string;
    testerWins: string; assessorWins: string; review: string;
  };
  norm: {
    testDateIso: string | null; examinerId: string; examinerTierCand: string | null;
    testeeId: string; testeeTierCand: string | null; testTierNorm: string | null;
    testerWins: number | null; assessorWins: number | null; review: string;
  };
  killsDeaths: { available: false; note: string };
  mergeState: 'UNIQUE' | 'MERGED_DUPLICATE';
  dupSourceCount: number;
  dupSources: LedgerDupSource[];
  matchState: 'MATCHED' | 'NOT_FOUND' | 'NAME_AMBIGUOUS' | 'UNCERTAIN';
  matchedPlayerId: string | null;
  suspectGarbage: boolean;
  processState: 'SYNCED' | 'MERGED' | 'PENDING_REVIEW' | 'READY' | 'ARCHIVED' | 'ARCHIVE_FAILED';
  confirmState: 'NONE' | 'PLAYER_PENDING' | 'CONFIRMED' | 'DISPUTED';
  confirmedAt: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  approveRef: { at?: string; by?: string; tier?: string; mode?: string; created?: boolean } | null;
  exemptNoConfirm: boolean;
  exemptNote: string | null;
  createdAt: string;
}

interface LedgerStats {
  read: number; recognized: number; merged: number; pendingReview: number;
  ready: number; archived: number; playerPending: number; confirmed: number;
  disputed: number; syncFailed: number; playerGroupCount: number;
  matchedCount: number; notFoundCount: number; ambiguousCount: number;
  uncertainCount: number; suspectGarbageCount: number; killsDeathsMissing: number;
}

interface LedgerBatch {
  id: string; fetchedAt: string; tabId: string; docRowCount: number; validRows: number;
  tombstoneRows: number; garbageRows: number; newRecords: number; mergedDupes: number;
  idempotentHits: number; ok: boolean; warnings: string[];
}

interface IngestStatsResponse {
  docRowCount: number; tombstoneRows: number; emptyRows: number; validRows: number;
  garbageRows: number; newRecords: number; mergedDupes: number; idempotentHits: number;
  playerGroupCount: number; readyCount: number; pendingReviewCount: number;
  killsDeathsMissingCount: number;
}

// ---------- 展示辅助 ----------

const PROCESS_BADGE: Record<LedgerRecord['processState'], { label: string; cls: string }> = {
  SYNCED: { label: '已读取', cls: 'bg-white/5 text-muted-foreground border-white/10' },
  MERGED: { label: '已合并', cls: 'bg-violet-500/10 text-violet-300 border-violet-500/30' },
  PENDING_REVIEW: { label: '待核对', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  READY: { label: '待归档', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
  ARCHIVED: { label: '已归档', cls: 'bg-jade-500/15 text-jade-300 border-jade-500/30' },
  ARCHIVE_FAILED: { label: '同步失败', cls: 'bg-red-500/10 text-red-300 border-red-500/30' },
};

const CONFIRM_BADGE: Record<LedgerRecord['confirmState'], { label: string; cls: string } | null> = {
  NONE: null,
  PLAYER_PENDING: { label: '待玩家确认', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30' },
  CONFIRMED: { label: '玩家已确认', cls: 'bg-jade-500/15 text-jade-300 border-jade-500/30' },
  DISPUTED: { label: '有异议', cls: 'bg-red-500/10 text-red-300 border-red-500/30' },
};

const MATCH_BADGE: Record<LedgerRecord['matchState'], { label: string; cls: string } | null> = {
  MATCHED: { label: '已匹配', cls: 'bg-jade-500/15 text-jade-300 border-jade-500/30' },
  NOT_FOUND: { label: '待建条目', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  NAME_AMBIGUOUS: { label: '同名歧义', cls: 'bg-red-500/10 text-red-300 border-red-500/30' },
  UNCERTAIN: { label: '身份存疑', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
};

function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full border tracking-wide whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ');
}

// ---------- 玩家分组（玩家名称优先；组内保持服务端四层排序） ----------

interface LedgerGroup { key: string; testeeId: string; records: LedgerRecord[] }

function buildLedgerGroups(records: LedgerRecord[]): LedgerGroup[] {
  const map = new Map<string, LedgerGroup>();
  for (const r of records) {
    const key = r.norm.testeeId.trim().toLowerCase() || '__UNNAMED__';
    const g = map.get(key) ?? { key, testeeId: r.norm.testeeId, records: [] };
    g.records.push(r);
    map.set(key, g);
  }
  return [...map.values()];
}

// ---------- 主组件 ----------

export function TierLedgerSection({ onChanged }: { onChanged?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [stats, setStats] = useState<LedgerStats | null>(null);
  const [batches, setBatches] = useState<LedgerBatch[]>([]);
  const [lastIngest, setLastIngest] = useState<IngestStatsResponse | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [showWarnings, setShowWarnings] = useState(false);
  const [activeWarnings, setActiveWarnings] = useState<string[]>([]);

  // 审批交互
  const [modeByRecord, setModeByRecord] = useState<Record<string, string>>({});
  const [createIfMissing, setCreateIfMissing] = useState<Set<string>>(new Set());
  const [confirmGarbage, setConfirmGarbage] = useState<Set<string>>(new Set());
  const [pendingApprove, setPendingApprove] = useState<LedgerRecord | null>(null);
  const [approving, setApproving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/ledger');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setRecords(data.records as LedgerRecord[]);
      setStats(data.stats as LedgerStats);
      setBatches(data.batches as LedgerBatch[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runIngest = useCallback(async () => {
    setIngesting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setLastIngest(data.stats as IngestStatsResponse);
      setActiveWarnings(data.warnings as string[]);
      setNotice(
        `归档拉取完成：文档 ${data.stats.docRowCount} 行 → 有效 ${data.stats.validRows} · ` +
        `新建 ${data.stats.newRecords} · 合并重复 ${data.stats.mergedDupes} · ` +
        `幂等命中 ${data.stats.idempotentHits}（重复拉取不重复累计）`,
      );
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  }, [load, onChanged]);

  const submitApprove = useCallback(async (r: LedgerRecord) => {
    const mode = modeByRecord[r.id];
    if (!mode) { setError('请先为该记录选择写入模式（必选，无预设）'); return; }
    setApproving(true);
    setError(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/ledger-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: r.id,
          tier: r.norm.testTierNorm ?? r.raw.testTier,
          mode,
          createIfMissing: createIfMissing.has(r.id),
          confirmSuspectGarbage: confirmGarbage.has(r.id) || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setNotice(data.message as string);
      setPendingApprove(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }, [modeByRecord, createIfMissing, confirmGarbage, load, onChanged]);

  const groups = useMemo(() => buildLedgerGroups(records), [records]);
  const disputedRows = useMemo(() => records.filter(r => r.confirmState === 'DISPUTED'), [records]);

  const toggleGroup = (k: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const TEN_STATES: Array<{ label: string; value: number; tone: string }> = stats ? [
    { label: '已读取', value: stats.read, tone: 'text-muted-foreground' },
    { label: '已识别', value: stats.recognized, tone: 'text-white' },
    { label: '已合并', value: stats.merged, tone: 'text-violet-300' },
    { label: '待核对', value: stats.pendingReview, tone: 'text-amber-300' },
    { label: '待归档', value: stats.ready, tone: 'text-sky-300' },
    { label: '已归档', value: stats.archived, tone: 'text-jade-300' },
    { label: '待玩家确认', value: stats.playerPending, tone: 'text-sky-300' },
    { label: '已确认', value: stats.confirmed, tone: 'text-jade-300' },
    { label: '有异议', value: stats.disputed, tone: 'text-red-300' },
    { label: '同步失败', value: stats.syncFailed, tone: 'text-red-300' },
  ] : [];

  return (
    <div className="flex flex-col gap-3">
      {/* 操作行 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          onClick={() => void runIngest()}
          disabled={ingesting || loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-jade-500/15 text-jade-300 border border-jade-500/30 hover:bg-jade-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary min-h-[44px]"
        >
          {ingesting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Archive className="w-4 h-4" aria-hidden="true" />}
          {ingesting ? '拉取中…' : '拉取收集表归档'}
        </button>
        <button
          onClick={() => void load()}
          disabled={loading || ingesting}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground border border-white/10 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-50 min-h-[44px]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          刷新台账
        </button>
      </div>

      {/* 自动同步控制（服务端常开定时器；开关/间隔持久化，重启自恢复） */}
      <TierAutoIngestControl onSynced={() => void load()} />

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

      {/* 十态统计条 */}
      {stats && (
        <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
          {TEN_STATES.map(s => (
            <div key={s.label} className="rounded-lg border border-white/10 bg-white/[0.03] px-1.5 py-2 text-center">
              <div className={`text-sm font-bold leading-none ${s.tone}`}>{s.value}</div>
              <div className="text-[10px] text-muted-foreground mt-1 leading-none whitespace-nowrap">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* 补充统计（口径：玩家分组/身份/垃圾/击杀死亡缺失） */}
      {stats && (
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          玩家分组 {stats.playerGroupCount} · 已匹配 {stats.matchedCount} · 待建条目 {stats.notFoundCount} ·
          同名歧义 {stats.ambiguousCount} · 身份存疑 {stats.uncertainCount} · 疑似垃圾 {stats.suspectGarbageCount} ·
          击杀/死亡缺失 {stats.killsDeathsMissing}（文档未提供对应列，全部如实标注，绝不补 0、绝不从胜场推算）
        </div>
      )}

      {/* 批次警告 */}
      {activeWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
          <button onClick={() => setShowWarnings(v => !v)} className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
            <AlertTriangleIcon />
            批次警告（{activeWarnings.length} 条）{showWarnings ? '▲' : '▼'}
          </button>
          {showWarnings && (
            <ul className="mt-1.5 space-y-1">
              {activeWarnings.map((w, i) => (
                <li key={i} className="text-[11px] text-amber-200/80 leading-relaxed">· {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 异议队列（置顶） */}
      {disputedRows.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 flex flex-col gap-1.5">
          <div className="text-xs font-bold text-red-300 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            玩家异议队列（{disputedRows.length} 条 · 记录不会被自动删除，等管理员处理）
          </div>
          {disputedRows.map(r => (
            <div key={r.id} className="text-[11px] text-red-200/85 leading-relaxed">
              {r.norm.testeeId} · 行{r.sourceRow} · {r.raw.project} {r.norm.testTierNorm ?? r.raw.testTier} ·
              异议：{r.disputeReason || '（未填写）'}（{fmtTime(r.disputedAt)}）
            </div>
          ))}
        </div>
      )}

      {/* 玩家分组记录列表 */}
      {loading && records.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 台账加载中…
        </div>
      ) : groups.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center leading-relaxed">
          台账为空 —— 点击「拉取收集表归档」建立首份台账（数据源：tier测试工单（收集结果）· d5roro）
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <div className="max-h-[28rem] overflow-y-auto ledger-scroll">
            {groups.map(g => {
              const open = expandedGroups.has(g.key);
              const pending = g.records.filter(r => r.processState === 'READY').length;
              return (
                <div key={g.key} className="border-b border-white/5 last:border-b-0">
                  <button
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/[0.03] transition-colors text-left"
                  >
                    {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />}
                    <span className="text-xs font-bold text-white truncate">{g.testeeId || '（无名称）'}</span>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">{g.records.length} 条记录</span>
                    {pending > 0 && <Badge label={`待归档 ${pending}`} cls="bg-sky-500/10 text-sky-300 border-sky-500/30" />}
                  </button>
                  {open && (
                    <div className="flex flex-col">
                      {g.records.map(r => {
                        const rowOpen = expandedRows.has(r.id);
                        const proc = PROCESS_BADGE[r.processState];
                        const conf = CONFIRM_BADGE[r.confirmState];
                        const match = MATCH_BADGE[r.matchState];
                        const isReady = r.processState === 'READY' && r.mergeState === 'UNIQUE';
                        return (
                          <div key={r.id} className="border-t border-white/5 bg-black/10">
                            <button
                              onClick={() => toggleRow(r.id)}
                              aria-expanded={rowOpen}
                              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] transition-colors text-left"
                            >
                              {rowOpen ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" aria-hidden="true" />}
                              <span className="text-[11px] text-white/90 font-medium truncate max-w-[7rem]">{r.norm.examinerId || '—'}</span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{(r.norm.testDateIso ?? r.raw.testDate).slice(0, 10)}</span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{r.raw.project} → {r.norm.testTierNorm ?? r.raw.testTier}</span>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">胜 {r.norm.testerWins ?? '—'}:{r.norm.assessorWins ?? '—'}</span>
                              {r.dupSourceCount > 1 && <Badge label={`×${r.dupSourceCount} 来源`} cls="bg-violet-500/10 text-violet-300 border-violet-500/30" />}
                              {r.suspectGarbage && <Badge label="疑似垃圾" cls="bg-amber-500/10 text-amber-300 border-amber-500/30" />}
                              <span className="ml-auto flex items-center gap-1 shrink-0">
                                {match && <Badge label={match.label} cls={match.cls} />}
                                {conf && <Badge label={conf.label} cls={conf.cls} />}
                                <Badge label={proc.label} cls={proc.cls} />
                              </span>
                            </button>
                            {rowOpen && (
                              <div className="px-4 pb-3 pt-1 flex flex-col gap-2">
                                {/* 明细（原始+标准化双存；胜场独立两列；击杀死亡缺失显式） */}
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[10px] leading-relaxed">
                                  <span className="text-muted-foreground">被测玩家：<span className="text-white/85">{r.norm.testeeId}</span>{r.norm.testeeTierCand ? `（原${r.norm.testeeTierCand}）` : ''}</span>
                                  <span className="text-muted-foreground">考核员：<span className="text-white/85">{r.norm.examinerId}</span>{r.norm.examinerTierCand ? `（${r.norm.examinerTierCand}）` : ''}</span>
                                  <span className="text-muted-foreground">测试日期：<span className="text-white/85">{(r.norm.testDateIso ?? r.raw.testDate).slice(0, 10)}</span></span>
                                  <span className="text-muted-foreground">测试项目：<span className="text-white/85">{r.raw.project}</span></span>
                                  <span className="text-muted-foreground">测试者胜场（H）：<span className="text-white/85 font-bold">{r.norm.testerWins ?? '未填'}</span></span>
                                  <span className="text-muted-foreground">考核员胜场（I）：<span className="text-white/85 font-bold">{r.norm.assessorWins ?? '未填'}</span></span>
                                  <span className="text-muted-foreground">击杀/死亡：<span className="text-amber-300/90">{r.killsDeaths.note}</span></span>
                                  <span className="text-muted-foreground">提交者（仅审计）：<span className="text-white/60">{r.raw.submitter || '—'}</span></span>
                                  <span className="text-muted-foreground col-span-2 sm:col-span-4">测试评价：<span className="text-white/70">{r.raw.review || '—'}</span></span>
                                  <span className="text-muted-foreground">来源行：<span className="text-white/60">sheet 第 {r.sourceRow} 行</span></span>
                                  <span className="text-muted-foreground">指纹：<span className="text-white/40 font-mono">{r.rowFingerprint.slice(0, 12)}…</span></span>
                                  {r.approveRef && (
                                    <span className="text-muted-foreground col-span-2">
                                      归档写入：<span className="text-jade-300/90">{r.approveRef.by} @ {fmtTime(r.approveRef.at)} · {r.approveRef.mode} → {r.approveRef.tier}{r.approveRef.created ? ' · 由台账创建玩家' : ''}</span>
                                    </span>
                                  )}
                                  {r.exemptNoConfirm && (
                                    <span className="text-muted-foreground col-span-2">确认豁免：<span className="text-amber-300/90">{r.exemptNote || '已豁免'}</span></span>
                                  )}
                                </div>

                                {/* 完全重复来源聚合 */}
                                {r.dupSources.length > 1 && (
                                  <div className="text-[10px] text-violet-300/85 leading-relaxed">
                                    完全重复来源 {r.dupSources.length} 条（业务字段完全一致，合并为一条有效记录，不重复累计）：
                                    {r.dupSources.map((d, i) => `行${d.sourceRow}(${d.submitter || '?'}${d.submittedAt ? ` @ ${d.submittedAt.slice(0, 10)}` : ''})`).join('、')}
                                  </div>
                                )}

                                {/* 审批交互（仅 UNIQUE + READY） */}
                                {isReady ? (
                                  <div className="flex items-center gap-2 flex-wrap pt-1">
                                    <select
                                      value={modeByRecord[r.id] ?? ''}
                                      onChange={e => setModeByRecord(prev => ({ ...prev, [r.id]: e.target.value }))}
                                      aria-label={`选择 ${r.norm.testeeId} 行${r.sourceRow} 的写入模式`}
                                      className="text-[11px] rounded-md bg-black/30 border border-white/15 text-white px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-primary"
                                    >
                                      <option value="">写入模式（必选）</option>
                                      {ALL_MODES.map(m => (
                                        <option key={m} value={m}>{m} · {MODE_LABELS[m as GameMode]}</option>
                                      ))}
                                    </select>
                                    {!r.matchedPlayerId && (
                                      <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={createIfMissing.has(r.id)}
                                          onChange={e => setCreateIfMissing(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                                          className="accent-jade-500"
                                        />
                                        创建并写入
                                      </label>
                                    )}
                                    {r.suspectGarbage && (
                                      <label className="inline-flex items-center gap-1 text-[10px] text-amber-300 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={confirmGarbage.has(r.id)}
                                          onChange={e => setConfirmGarbage(prev => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                                          className="accent-amber-500"
                                        />
                                        确认非垃圾（疑似垃圾行必须显式勾选）
                                      </label>
                                    )}
                                    <button
                                      onClick={() => setPendingApprove(r)}
                                      disabled={!modeByRecord[r.id] || approving}
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-jade-500/15 text-jade-300 border border-jade-500/30 hover:bg-jade-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[32px]"
                                    >
                                      <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                                      审批归档写入
                                    </button>
                                    <span className="text-[10px] text-muted-foreground">写入后已注册玩家将收到确认请求</span>
                                  </div>
                                ) : (
                                  <div className="text-[10px] text-muted-foreground leading-relaxed">
                                    {r.processState === 'ARCHIVED'
                                      ? `已归档（确认状态：${CONFIRM_BADGE[r.confirmState]?.label ?? (r.exemptNoConfirm ? '已豁免' : '无确认通道')}）`
                                      : r.mergeState === 'MERGED_DUPLICATE'
                                        ? '重复来源行（已并入保留记录，不参与单独审批）'
                                        : '待核对：修复文档数据或人工裁决后重新拉取'}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 批次历史 */}
      {batches.length > 0 && (
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          最近批次：{batches.slice(0, 3).map(b => (
            <span key={b.id} className={b.ok ? '' : 'text-red-300'}>
              {b.fetchedAt.slice(0, 19).replace('T', ' ')}（有效 {b.validRows}/墓碑 {b.tombstoneRows}/幂等 {b.idempotentHits}{b.ok ? '' : ' · 失败'}）
            </span>
          )).reduce<React.ReactNode[]>((acc, el, i) => (i === 0 ? [el] : [...acc, ' · ', el]), [])}
        </div>
      )}

      {/* 二次确认弹窗（审批归档写入） */}
      <AlertDialog open={!!pendingApprove} onOpenChange={v => { if (!v) setPendingApprove(null); }}>
        <AlertDialogContent className="bg-card border-white/10 max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">确认归档写入（人工逐条审批）</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-xs leading-relaxed space-y-1">
                <div>将被测玩家 <span className="text-white font-bold">{pendingApprove?.norm.testeeId}</span> 的段位写入档案：</div>
                <div>项目 {pendingApprove?.raw.project} · 目标 tier {pendingApprove?.norm.testTierNorm ?? pendingApprove?.raw.testTier} · 模式 {pendingApprove ? (modeByRecord[pendingApprove.id] || '—') : '—'}</div>
                <div>测试者胜场 {pendingApprove?.norm.testerWins ?? '未填'} / 考核员胜场 {pendingApprove?.norm.assessorWins ?? '未填'}（独立记录，仅展示，不参与评分）</div>
                <div>击杀/死亡：文档未提供（不补 0、不推算）</div>
                <div className="text-amber-300">幂等保护：同一记录拒绝二次写入；重复来源已自动合并。</div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => { e.preventDefault(); if (pendingApprove) void submitApprove(pendingApprove); }}
              disabled={approving}
              className="text-xs bg-jade-600 hover:bg-jade-500"
            >
              {approving ? '写入中…' : '确认写入'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AlertTriangleIcon() {
  return <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />;
}
