'use client';

// ============================================================
// 约 PVP · 发起表单（工单 2026-11-10 V1.0，§7.2-7.5）
// ------------------------------------------------------------
// - 对手：/api/pvp/players（仅已注册玩家；stable id 身份，名称仅展示）
// - 模式：PVP_MODES（单一来源 constants.ALL_MODES，不重复硬编码）
// - 时间：datetime-local 本地时间 → UTC ISO + IANA 时区 + 偏移；
//         服务端重新校验（拒绝过去/超远期）
// - 备注：≤100 字，折叠空白；React 文本节点输出，绝不 innerHTML
// - 提交：requestId 幂等；Loading→按后端真实结果显示 成功/失败/结果未知
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import type { GameMode } from '@/lib/constants';
import { ModeIcon } from '@/components/mc-icon';
import {
  PVP_LIMITS,
  PVP_MODES,
  type PvpChallengeView,
} from '@/lib/pvp';
import {
  createChallenge,
  fetchChallengeByRequestId,
  fetchPvpPlayers,
  fmtSchedule,
  type PvpPlayerOption,
} from '@/lib/pvp-client';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; challenge: PvpChallengeView; deduplicated?: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'unknown'; message: string; requestId: string };

export function PvpCreateForm({ me, onSuccess }: {
  me: { id: string; name: string; email: string };
  onSuccess: () => void;
}) {
  // ---------- 对手 ----------
  const [players, setPlayers] = useState<PvpPlayerOption[] | null>(null);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [opponent, setOpponent] = useState<PvpPlayerOption | null>(null);

  // ---------- 模式 / 时间 / 备注 ----------
  const [modeId, setModeId] = useState<string>('');
  const [localTime, setLocalTime] = useState<string>('');
  const [notes, setNotes] = useState('');

  // ---------- 提交 ----------
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const requestIdRef = useRef<string>('');
  if (!requestIdRef.current) requestIdRef.current = newRequestId();

  const loadPlayers = useRef<() => void>(() => {});
  loadPlayers.current = () => {
    setPlayersError(null);
    void fetchPvpPlayers().then(r => {
      if (r.result === 'success') setPlayers(r.data.players.filter(p => p.id !== me.id));
      else setPlayersError(r.error);
    });
  };
  useEffect(() => { loadPlayers.current(); }, []);

  // 时间输入下界 = 本地 now + MIN_LEAD（原生 min 属性；服务端仍权威校验）
  const minLocal = useMemo(() => {
    const d = new Date(Date.now() + PVP_LIMITS.MIN_LEAD_MINUTES * 60_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, []);

  const filtered = useMemo(() => {
    if (!players) return [];
    const q = query.trim().toLowerCase();
    if (!q) return players.slice(0, 30);
    return players.filter(p => p.name.toLowerCase().includes(q)).slice(0, 30);
  }, [players, query]);

  const viewerTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh', []);

  function resetForm() {
    setOpponent(null);
    setQuery('');
    setModeId('');
    setLocalTime('');
    setNotes('');
    requestIdRef.current = newRequestId();
    setSubmit({ kind: 'idle' });
  }

  async function handleSubmit() {
    if (submit.kind === 'busy') return; // 防重复点击
    if (!opponent) { setSubmit({ kind: 'error', message: '请先选择对手' }); return; }
    if (!modeId) { setSubmit({ kind: 'error', message: '请选择比赛模式' }); return; }
    if (!localTime) { setSubmit({ kind: 'error', message: '请选择预约时间' }); return; }

    // datetime-local = 用户本地时间 → 规范化 UTC + 保留时区信息（工单 §7.4）
    const localDate = new Date(localTime);
    if (Number.isNaN(localDate.getTime())) { setSubmit({ kind: 'error', message: '预约时间格式无效' }); return; }
    if (localDate.getTime() < Date.now() + PVP_LIMITS.MIN_LEAD_MINUTES * 60_000) {
      setSubmit({ kind: 'error', message: `预约时间需至少提前 ${PVP_LIMITS.MIN_LEAD_MINUTES} 分钟` });
      return;
    }

    setSubmit({ kind: 'busy' });
    const r = await createChallenge({
      requestId: requestIdRef.current,
      opponentId: opponent.id,
      modeId,
      scheduledAt: localDate.toISOString(),
      timezone: viewerTz,
      tzOffsetMinutes: -localDate.getTimezoneOffset(),
      notes: notes || undefined,
    });

    if (r.result === 'success') {
      setSubmit({ kind: 'success', challenge: r.data.challenge, deduplicated: r.data.deduplicated });
    } else if (r.result === 'error') {
      setSubmit({ kind: 'error', message: r.error });
      // 服务端明确拒绝 → 换新幂等键允许修正重试
      requestIdRef.current = newRequestId();
    } else {
      // 结果未知：凭 requestId 查询恢复，绝不盲目重复创建（工单 §10）
      setSubmit({ kind: 'unknown', message: r.error, requestId: requestIdRef.current });
    }
  }

  async function handleResolveUnknown() {
    if (submit.kind !== 'unknown') return;
    setSubmit({ kind: 'busy' });
    const r = await fetchChallengeByRequestId(submit.requestId);
    if (r.result === 'success') {
      setSubmit({ kind: 'success', challenge: r.data.challenge });
    } else if (r.result === 'error' && r.status === 404) {
      // 服务端确认未创建 → 同一 requestId 安全重发（幂等保护仍在）
      setSubmit({ kind: 'error', message: '已确认服务端未创建该请求，可重新发送' });
    } else if (r.result === 'error') {
      setSubmit({ kind: 'unknown', message: r.error, requestId: submit.requestId });
    } else {
      setSubmit({ kind: 'unknown', message: '查询超时，请稍后再试', requestId: submit.requestId });
    }
  }

  // ---------- 成功态（后端真实确认后才显示；含请求编号） ----------
  if (submit.kind === 'success') {
    return (
      <div className="pvp-state ok" role="status" data-testid="pvp-create-success">
        <div className="big">✓ 约战请求已送达</div>
        <p style={{ fontSize: 11 }}>工单编号：<span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{submit.challenge.id}</span></p>
        <p style={{ fontSize: 11, marginTop: 2 }}>
          对手 <b>{submit.challenge.counterpartName}</b> · {submit.challenge.modeLabel} · {fmtSchedule(submit.challenge.scheduledAt, submit.challenge.timezone)}
        </p>
        <p style={{ fontSize: 11, marginTop: 2 }}>状态：等待对方回应 —— 接受前不计入任何正式战绩</p>
        {submit.deduplicated && <p style={{ fontSize: 10, marginTop: 3, opacity: 0.75 }}>(同一请求已存在，本次为幂等返回，未重复创建)</p>}
        <div className="row">
          <button type="button" className="pvp-mini-btn acc" onClick={onSuccess}>查看我的约战</button>
          <button type="button" className="pvp-mini-btn" onClick={resetForm}>再约一场</button>
        </div>
      </div>
    );
  }

  const notesLen = notes.replace(/\s+/g, ' ').trim().length;

  return (
    <div data-testid="pvp-create-form">
      {/* ① 选择对手 */}
      <div className="pvp-sec">
        <span className="pvp-label">选择对手 <span className="opt">仅已注册玩家可收到约战</span></span>
        {opponent ? (
          <div className="pvp-pick-summary">
            <PlayerAvatar p={opponent} />
            <div className="min-w-0">
              <div className="nm">{opponent.name}</div>
              <div className="tier">{bestTierText(opponent.tiers)}</div>
            </div>
            <button type="button" className="pvp-clear-btn" onClick={() => setOpponent(null)}>清除选择</button>
          </div>
        ) : (
          <div className="pvp-picker">
            <div className="search">
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索玩家名称…"
                aria-label="搜索约战对手"
              />
            </div>
            <div className="list" role="listbox" aria-label="候选对手列表">
              {playersError ? (
                <div className="pvp-state err" style={{ border: 0, borderRadius: 0 }}>
                  <div className="big">玩家列表加载失败</div>
                  <p style={{ fontSize: 11 }}>{playersError}</p>
                  <div className="row">
                    <button type="button" className="pvp-mini-btn" onClick={() => loadPlayers.current()}>
                      <RefreshCw className="w-3 h-3 inline" aria-hidden="true" /> 重试
                    </button>
                  </div>
                </div>
              ) : players === null ? (
                <div className="pvp-opt-empty" role="status">正在加载玩家…</div>
              ) : filtered.length === 0 ? (
                <div className="pvp-opt-empty">{query ? '没有匹配的玩家' : '暂无可选玩家（需要已注册账号）'}</div>
              ) : (
                filtered.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="pvp-opt"
                    onClick={() => { setOpponent(p); setQuery(''); }}
                  >
                    <PlayerAvatar p={p} />
                    <span className="nm" style={{ fontWeight: 700 }}>{p.name}</span>
                    <span className="tier">{bestTierText(p.tiers)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* ② 比赛模式 */}
      <div className="pvp-sec">
        <span className="pvp-label">比赛模式</span>
        <div className="pvp-modes" role="radiogroup" aria-label="比赛模式">
          {PVP_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={modeId === m.id}
              className={`pvp-mode-chip${modeId === m.id ? ' on' : ''}`}
              onClick={() => setModeId(m.id)}
            >
              <ModeIcon mode={m.id as GameMode} size="chip" />
              {m.label}
            </button>
          ))}
        </div>
        <p className="pvp-hint">图标与名称读取自现有模式配置（MODE_LABELS / MODE_ICONS），无独立硬编码。</p>
      </div>

      {/* ③ 预约时间 */}
      <div className="pvp-sec">
        <span className="pvp-label">预约时间</span>
        <input
          className="pvp-input"
          type="datetime-local"
          value={localTime}
          min={minLocal}
          onChange={e => setLocalTime(e.target.value)}
          aria-label="预约比赛时间（本地时间）"
        />
        <p className="pvp-hint">
          本地时间（{viewerTz}）· 至少提前 {PVP_LIMITS.MIN_LEAD_MINUTES} 分钟 · 服务端将按 UTC 规范化保存并重新校验
        </p>
      </div>

      {/* ④ 规则备注 */}
      <div className="pvp-sec">
        <span className="pvp-label">规则备注 <span className="opt">选填</span></span>
        <textarea
          className="pvp-textarea"
          value={notes}
          maxLength={PVP_LIMITS.NOTES_MAX + 20}
          onChange={e => setNotes(e.target.value)}
          placeholder="例如：BO3、禁用某物品、迟到 15 分钟判负…"
          aria-label="规则备注（选填）"
        />
        <div className="pvp-counter">{notesLen}/{PVP_LIMITS.NOTES_MAX}</div>
      </div>

      {/* 错误 / 结果未知状态卡（§14） */}
      {submit.kind === 'error' && (
        <div className="pvp-state err" role="alert" style={{ marginTop: 12 }}>
          <div className="big">未能发送</div>
          {submit.message}
        </div>
      )}
      {submit.kind === 'unknown' && (
        <div className="pvp-state unknown" role="alert" style={{ marginTop: 12 }}>
          <div className="big">⏳ {submit.message}</div>
          <p style={{ fontSize: 11 }}>为避免重复创建，请先查询原请求状态：</p>
          <div className="row">
            <button type="button" className="pvp-mini-btn" onClick={() => { void handleResolveUnknown(); }}>
              <Search className="w-3 h-3 inline" aria-hidden="true" /> 查询请求状态
            </button>
          </div>
        </div>
      )}

      {/* ⑤ 提交（busy 禁点；成功/失败一律来自后端真实响应） */}
      <button
        type="button"
        className={`pvp-submit${submit.kind === 'busy' ? '' : ''}`}
        onClick={() => { void handleSubmit(); }}
        disabled={submit.kind === 'busy'}
        data-testid="pvp-submit"
      >
        {submit.kind === 'busy'
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 正在发送…</span>
          : '发送约战请求'}
      </button>
      <p className="pvp-hint" style={{ textAlign: 'center' }}>
        发起 ≠ 开赛：对方接受前不进正式 matches、不计胜场、不计 K/D、不更新排行榜。
      </p>
    </div>
  );
}

// ---------- 小件 ----------

function PlayerAvatar({ p }: { p: PvpPlayerOption }) {
  if (p.avatarUrl) {
    return <img className="pvp-avatar" src={p.avatarUrl} alt="" decoding="async" />;
  }
  const hue = [...p.name].reduce((a, c) => a + c.codePointAt(0)! * 7, 0) % 360;
  return (
    <span className="pvp-avatar" style={{ background: `hsl(${hue} 30% 26%)` }} aria-hidden="true">
      {p.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function bestTierText(tiers: Record<string, string>): string {
  const tested = Object.entries(tiers).filter(([, t]) => t && String(t).trim() && !['', '/', 'UN', '未测'].includes(String(t).toUpperCase()));
  if (tested.length === 0) return '暂无段位';
  return tested.map(([m, t]) => `${t}`).slice(0, 3).join(' / ');
}

function newRequestId(): string {
  // 幂等键：客户端生成 UUID（crypto 原生，无新依赖）
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
