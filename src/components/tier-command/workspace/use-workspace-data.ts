'use client';

// ============================================================
// Tier Workspace V2 · 数据加载 hook（只读消费既有 API，零新增后端状态）
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-fetch';

// ---------- ledger API V2 契约 ----------

export interface LedgerRaw {
  submitter: string; submittedAt: string; project: string; testDate: string;
  examiner: string; testee: string; testTier: string;
  testerWins: string; assessorWins: string; review: string;
}

export interface LedgerNorm {
  testDateIso: string | null; examinerId: string; examinerTierCand: string | null;
  testeeId: string; testeeTierCand: string | null; testTierNorm: string | null;
  testerWins: number | null; assessorWins: number | null; review: string;
}

export interface LedgerIdentity {
  rawName: string; displayName: string;
  tierCandidate: string | null; suspectToken: string | null;
  suffixSplit: boolean; nameContainsToken: boolean;
  matchBasis: 'EXACT' | 'EXACT_AMBIGUOUS' | 'SUFFIX' | 'SUFFIX_AMBIGUOUS' | 'NONE';
  matchedPlayerId: string | null; matchedPlayerName: string | null;
  needsReview: boolean; reviewNote: string | null;
}

export interface LedgerRecord {
  id: string; batchId: string; docId: string; tabId: string;
  sourceRow: number; rowFingerprint: string;
  raw: LedgerRaw; norm: LedgerNorm;
  kd: { owner: 'testee'; kills: number | null; killsProvided: boolean; deaths: number | null; deathsProvided: boolean };
  identity: LedgerIdentity;
  aggKey: string;
  mergeState: 'UNIQUE' | 'MERGED_DUPLICATE';
  dupSourceCount: number;
  dupSources: Array<{ sourceRow: number; submitter: string; submittedAt: string | null; mergedAt?: string }>;
  matchState: 'MATCHED' | 'NOT_FOUND' | 'NAME_AMBIGUOUS' | 'UNCERTAIN';
  matchedPlayerId: string | null;
  suspectGarbage: boolean;
  processState: 'SYNCED' | 'MERGED' | 'PENDING_REVIEW' | 'READY' | 'ARCHIVED' | 'ARCHIVE_FAILED';
  confirmState: 'NONE' | 'PLAYER_PENDING' | 'CONFIRMED' | 'DISPUTED';
  confirmedAt: string | null; disputedAt: string | null; disputeReason: string | null;
  approveRef: { at?: string; by?: string; tier?: string; mode?: string; created?: boolean } | null;
  exemptNoConfirm: boolean; exemptNote: string | null;
  createdAt: string;
}

export interface PlayerAgg {
  aggKey: string;
  displayName: string;
  rawNameVariants: string[];
  tierCandidates: string[];
  matchedPlayerId: string | null;
  matchedPlayerName: string | null;
  currentTiers: Array<{ mode: string; tier: string }>;
  ticketCount: number;
  counts: { pendingReview: number; ready: number; archived: number; playerPending: number; confirmed: number; disputed: number };
  latestTestDate: string | null;
  confirmedKills: number | null;
  confirmedDeaths: number | null;
  needsReview: boolean;
  suspectGarbage: boolean;
  examiners: string[];
}

export interface LedgerBatch {
  id: string; fetchedAt: string; tabId: string;
  docRowCount: number; validRows: number; tombstoneRows: number; garbageRows: number;
  newRecords: number; mergedDupes: number; idempotentHits: number; ok: boolean;
  warnings: string[];
}

export interface LedgerStats {
  read: number; recognized: number; merged: number; pendingReview: number;
  ready: number; archived: number; playerPending: number; confirmed: number;
  disputed: number; syncFailed: number;
  playerGroupCount: number; matchedCount: number; notFoundCount: number;
  ambiguousCount: number; uncertainCount: number; suspectGarbageCount: number;
  killsDeathsMissing: number; identityReviewCount: number;
}

export interface LedgerResponse {
  ok: boolean;
  stats: LedgerStats;
  records: LedgerRecord[];
  players: PlayerAgg[];
  batches: LedgerBatch[];
  message?: string; error?: string;
}

// ---------- hook ----------

// ---------- 共享 fetcher（纯取数，无 setState） ----------

async function fetchLedger(): Promise<{ ok: boolean; json: LedgerResponse | null; errorMsg: string | null }> {
  try {
    const res = await adminFetch('/api/v1/tier-command/ledger');
    const json = (await res.json()) as LedgerResponse;
    if (!res.ok || !json.ok) {
      return { ok: false, json: null, errorMsg: json.message || json.error || `台账加载失败（HTTP ${res.status}）` };
    }
    return { ok: true, json, errorMsg: null };
  } catch {
    return { ok: false, json: null, errorMsg: '台账请求发送失败（网络异常），请稍后重试' };
  }
}

export function useLedger() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 首次加载（setState 全部在 await 后；卸载守卫）
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetchLedger();
      if (!alive) return;
      setData(r.json);
      setError(r.ok ? null : r.errorMsg);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  // 手动/联动刷新（事件侧调用；保留旧数据展示无闪烁）
  const reload = useCallback(async () => {
    const r = await fetchLedger();
    setData(r.json);
    setError(r.ok ? null : r.errorMsg);
    setLoading(false);
    return r.ok;
  }, []);

  return { data, loading, error, reload };
}

// ---------- 审计日志 API 契约 ----------

export interface WorkspaceAuditLog {
  id: string; at: string; operator: string;
  kind: 'approve' | 'rollback' | 'reject' | 'restore' | null;
  rowIndex: number | null; playerName: string | null;
  mode: string | null; tierTo: string | null; created: boolean; detail: string;
}

export function useAuditLogs(refreshKey: number) {
  const [logs, setLogs] = useState<WorkspaceAuditLog[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 刷新时保留旧数据展示（无闪烁）；首次为 'loading' 态显示骨架
        const res = await adminFetch('/api/v1/tier-command/logs');
        const json = (await res.json()) as { ok: boolean; logs?: WorkspaceAuditLog[]; message?: string; error?: string };
        if (!alive) return;
        if (!res.ok || !json.ok) {
          setError(json.message || json.error || `日志加载失败（HTTP ${res.status}）`);
          setState('error');
          return;
        }
        setLogs(json.logs ?? []);
        setState('ready');
      } catch {
        if (!alive) return;
        setError('日志请求发送失败（网络异常）');
        setState('error');
      }
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  return { logs, state, error };
}
