'use client';

// ============================================================
// 约 PVP · 客户端 API 助手（工单 2026-11-10 V1.0）
// - 统一 10s 超时（AbortController）；超时/网络中断 → result:'unknown'
//   （结果未知时凭 requestId 查询恢复，绝不盲目重复创建）
// - 不读取/保存任何密钥；正式工单状态一律以服务端为准
// ============================================================

import type { PvpChallengeView } from '@/lib/pvp';

export interface PvpPlayerOption {
  id: string;
  name: string;
  avatarUrl: string | null;
  tiers: Record<string, string>;
}

export type PvpApiResult<T> =
  | { result: 'success'; data: T }
  | { result: 'unknown'; error: string }   // 网络/超时/中断——状态不明
  | { result: 'error'; error: string; status: number; code?: string };

async function call<T>(url: string, init?: RequestInit): Promise<PvpApiResult<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!res.ok) {
      return { result: 'error', status: res.status, error: json?.error ?? `请求失败（HTTP ${res.status}）`, code: json?.code };
    }
    return { result: 'success', data: json as T };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return { result: 'unknown', error: aborted ? '请求超时，结果未知' : '网络异常，结果未知' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 登录态 ----------

export async function fetchMe(): Promise<PvpApiResult<{ player: { id: string; name: string; email: string } | null }>> {
  return call('/api/v1/auth/me');
}

// ---------- 候选对手 ----------

export async function fetchPvpPlayers(): Promise<PvpApiResult<{ players: PvpPlayerOption[] }>> {
  return call('/api/pvp/players');
}

// ---------- 创建（幂等） ----------

export interface CreateChallengeInput {
  requestId: string;
  opponentId: string;
  modeId: string;
  scheduledAt: string;       // ISO UTC
  timezone: string;
  tzOffsetMinutes: number;
  notes?: string;
}

export async function createChallenge(
  input: CreateChallengeInput,
): Promise<PvpApiResult<{ ok: boolean; challenge: PvpChallengeView; deduplicated?: boolean }>> {
  return call('/api/pvp/challenges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ---------- 我的约战 ----------

export async function fetchMyChallenges(box: 'all' | 'incoming' | 'outgoing' = 'all'): Promise<PvpApiResult<{ challenges: PvpChallengeView[]; incomingPending: number }>> {
  const q = box === 'all' ? '' : `?box=${box}`;
  return call(`/api/pvp/challenges${q}`);
}

export async function fetchChallengeByRequestId(requestId: string): Promise<PvpApiResult<{ challenge: PvpChallengeView }>> {
  return call(`/api/pvp/challenges?request_id=${encodeURIComponent(requestId)}`);
}

export async function fetchChallengeById(id: string): Promise<PvpApiResult<{ challenge: PvpChallengeView }>> {
  return call(`/api/pvp/challenges/${encodeURIComponent(id)}`);
}

// ---------- 回应 ----------

export async function respondChallenge(id: string, action: 'accept' | 'reject' | 'cancel'): Promise<PvpApiResult<{ challenge: PvpChallengeView }>> {
  return call(`/api/pvp/challenges/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

// ---------- 展示工具 ----------

/** 预约时间本地化展示（查看者本地时区；附发起方时区名以便跨时区核对） */
export function fmtSchedule(iso: string, sourceTz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间无效';
  const local = d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return viewerTz && viewerTz !== sourceTz ? `${local}（${sourceTz}）` : local;
}

export function fmtTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
