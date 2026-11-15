'use client';

// ============================================================
// 约 PVP · 我的约战（收件箱 + 发件箱；工单 2026-11-10 V1.0，§8/§12）
// ------------------------------------------------------------
// - 通知方案（V1）：聊天系统为独立 socket.io 服务，向其伪造消息被任务书
//   禁止 —— 通知以「独立接口 + 面板内收件箱 + 30s 轮询」实现（§12 允许的
//   降级路径）；后续如需推送再独立设计推送通道。
// - accept/reject 仅对手可操作；cancel 仅发起方；全部经服务端身份校验。
// - 接受后不产生任何正式战绩 —— 赛果仍走管理员既有录入流程。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { PVP_STATUS_LABELS, type PvpChallengeView, type PvpStatus } from '@/lib/pvp';
import { fetchMyChallenges, fmtSchedule, fmtTimeShort, respondChallenge } from '@/lib/pvp-client';

const OPEN_POLL_MS = 30_000; // 面板打开期间轻量轮询（仅此一处，无全局循环）

export function PvpMyBoard({ me, onPendingCount, onGotoCreate }: {
  me: { id: string; name: string; email: string };
  onPendingCount?: (n: number) => void;
  onGotoCreate?: () => void;
}) {
  const [items, setItems] = useState<PvpChallengeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actingMsg, setActingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    const r = await fetchMyChallenges('all');
    if (!aliveRef.current) return;
    if (r.result === 'success') {
      setItems(r.data.challenges);
      onPendingCount?.(r.data.incomingPending);
    } else if (r.result === 'error') {
      setError(r.error);
    } else {
      setError('网络异常，稍后自动重试');
    }
  }, [onPendingCount]);

  useEffect(() => {
    aliveRef.current = true;
    // 首拉走宏任务（不在 effect 同步路径内 setState，hooks lint 合规）；
    const first = setTimeout(() => { void load(true); }, 0);
    const t = setInterval(() => { void load(true); }, OPEN_POLL_MS); // 打开期间 30s 轮询
    return () => {
      aliveRef.current = false;
      clearTimeout(first);
      clearInterval(t); // 面板关闭即释放（工单 §6：关闭后清理定时器/监听）
    };
  }, [load]);

  async function act(id: string, action: 'accept' | 'reject' | 'cancel') {
    if (busyId) return;
    setBusyId(id);
    setActingMsg(null);
    const r = await respondChallenge(id, action);
    if (!aliveRef.current) return;
    if (r.result === 'success') {
      setActingMsg({ ok: true, text: action === 'accept' ? '已接受' : action === 'reject' ? '已拒绝' : '已取消' });
      await load(true);
    } else if (r.result === 'error') {
      setActingMsg({ ok: false, text: r.error });
      await load(true); // 状态可能已被对方/过期清扫改变，刷新真实状态
    } else {
      setActingMsg({ ok: false, text: '网络异常，状态未确认 —— 正在刷新' });
      await load(true);
    }
    setBusyId(null);
  }

  if (error && items === null) {
    return (
      <div className="pvp-state err" role="alert">
        <div className="big">约战列表加载失败</div>
        <p style={{ fontSize: 11 }}>{error}</p>
        <div className="row"><button type="button" className="pvp-mini-btn" onClick={() => { void load(); }}><RefreshCw className="w-3 h-3 inline" aria-hidden="true" /> 重试</button></div>
      </div>
    );
  }

  if (items === null) {
    return <div className="pvp-state" role="status"><Loader2 className="w-4 h-4 animate-spin inline" aria-hidden="true" /> 正在加载…</div>;
  }

  const incoming = items.filter(c => c.role === 'opponent');
  const outgoing = items.filter(c => c.role === 'challenger');

  return (
    <div data-testid="pvp-my-board">
      {actingMsg && (
        <div className={`pvp-state ${actingMsg.ok ? 'ok' : 'err'}`} role="status" style={{ marginBottom: 10 }}>
          {actingMsg.text}
        </div>
      )}

      {/* 收到的约战（我是被约方） */}
      <div className="pvp-box-title">收到的约战 <span className="n">{incoming.length} 条</span></div>
      {incoming.length === 0 ? (
        <div className="pvp-opt-empty">暂无收到的约战 —— 别的玩家发起后会出现在这里</div>
      ) : (
        <div className="pvp-ch-list">
          {incoming.map(c => (
            <ChallengeItem key={c.id} c={c} busyId={busyId} onAct={act} />
          ))}
        </div>
      )}

      {/* 发出的约战（我是发起方） */}
      <div className="pvp-box-title">发出的约战 <span className="n">{outgoing.length} 条</span></div>
      {outgoing.length === 0 ? (
        <div className="pvp-opt-empty">
          还没有发起过约战
          {onGotoCreate && (
            <button type="button" className="pvp-mini-btn" style={{ marginLeft: 8 }} onClick={onGotoCreate}>去发起</button>
          )}
        </div>
      ) : (
        <div className="pvp-ch-list">
          {outgoing.map(c => (
            <ChallengeItem key={c.id} c={c} busyId={busyId} onAct={act} />
          ))}
        </div>
      )}

      <p className="pvp-hint" style={{ marginTop: 12 }}>
        列表打开期间每 30 秒自动刷新 · 接受后请按约时间比赛，赛果仍由管理员按既有流程录入（约战状态永远不等同于正式战绩）。
      </p>
    </div>
  );
}

// ---------- 单条工单 ----------

function ChallengeItem({ c, busyId, onAct }: {
  c: PvpChallengeView;
  busyId: string | null;
  onAct: (id: string, action: 'accept' | 'reject' | 'cancel') => Promise<void>;
}) {
  const st: PvpStatus = c.status;
  const isPending = st === 'pending';
  const isOutgoing = c.role === 'challenger';

  return (
    <div className={`pvp-ch-item ${isPending ? 'pending' : st === 'accepted' ? 'accepted' : 'closed'}`} data-testid={`pvp-ch-${c.id}`}>
      <div className="min-w-0">
        <div className="who">
          {isOutgoing ? '→ ' : '← '}{c.counterpartName}
          <span className="pvp-status-badge" style={{ marginLeft: 8 }} data-pvp-status={st}>{PVP_STATUS_LABELS[st]}</span>
        </div>
        <div className="meta">
          <span>{c.modeLabel}</span>
          <span>· {fmtSchedule(c.scheduledAt, c.timezone)}</span>
          <span>· 创建于 {fmtTimeShort(c.createdAt)}</span>
        </div>
        {c.notes && <div className="note">备注：{c.notes}</div>}
        {st === 'accepted' && (
          <div className="note" style={{ color: '#6ee7b7' }}>✓ 双方已确认 —— 请按约时间比赛</div>
        )}
        {st === 'expired' && <div className="note">预约时间已过且未回应，自动过期。</div>}
      </div>
      <div className="acts">
        {!isOutgoing && isPending && (
          <>
            <button type="button" className="pvp-mini-btn acc" disabled={busyId !== null} onClick={() => { void onAct(c.id, 'accept'); }} data-testid={`pvp-accept-${c.id}`}>接受</button>
            <button type="button" className="pvp-mini-btn dgr" disabled={busyId !== null} onClick={() => { void onAct(c.id, 'reject'); }}>拒绝</button>
          </>
        )}
        {isOutgoing && isPending && (
          <button type="button" className="pvp-mini-btn" disabled={busyId !== null} onClick={() => { void onAct(c.id, 'cancel'); }}>取消</button>
        )}
      </div>
    </div>
  );
}
