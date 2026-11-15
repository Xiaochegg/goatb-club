// ============================================================
// 约 PVP · 服务端序列化（仅供 API 路由使用；工单 2026-11-10 V1.0）
// 附加对手/发起方展示名（最小字段：name + avatarUrl，绝不输出 email 等）。
// ============================================================

import { db } from '@/lib/db';
import { PVP_LIMITS, PVP_MODES, isPvpStatus, type PvpChallengeView, type PvpStatus } from '@/lib/pvp';

/**
 * 过期清扫（惰性：读路径触发，无定时器）。
 * 应过期未过期的 pending → expired（scheduledAt 过点超宽限，或 pending 超 14 天）。
 * 幂等；失败不阻断读路径（下次读取重试）。仅服务端可调用（依赖 db）。
 */
export async function sweepExpiredChallenges(now = new Date()): Promise<number> {
  const grace = new Date(now.getTime() - PVP_LIMITS.EXPIRE_GRACE_MINUTES * 60_000);
  const zombie = new Date(now.getTime() - PVP_LIMITS.PENDING_MAX_DAYS * 24 * 60 * 60_000);
  try {
    const r = await db.pvpChallenge.updateMany({
      where: { status: 'pending', OR: [{ scheduledAt: { lt: grace } }, { createdAt: { lt: zombie } }] },
      data: { status: 'expired', closedAt: now },
    });
    return r.count;
  } catch {
    return 0;
  }
}

export interface PvpChallengeRow {
  id: string;
  requestId: string;
  challengerId: string;
  opponentId: string;
  modeId: string;
  scheduledAt: Date;
  timezone: string;
  tzOffsetMinutes: number;
  notes: string | null;
  status: string;
  createdAt: Date;
  respondAt: Date | null;
  closedAt: Date | null;
}

export async function serializeRow(row: PvpChallengeRow, viewerId: string): Promise<PvpChallengeView> {
  const ids = [row.challengerId, row.opponentId];
  const players = await db.player.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, avatarUrl: true },
  });
  const map = new Map(players.map(p => [p.id, p]));
  return serializeRowWithMap(row, viewerId, map);
}

export async function serializeRows(rows: PvpChallengeRow[], viewerId: string): Promise<PvpChallengeView[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap(r => [r.challengerId, r.opponentId]))];
  const players = await db.player.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, avatarUrl: true },
  });
  const map = new Map(players.map(p => [p.id, p]));
  return rows.map(r => serializeRowWithMap(r, viewerId, map));
}

const LABEL_OF = new Map<string, string>(PVP_MODES.map(m => [m.id, m.label]));

function serializeRowWithMap(
  r: PvpChallengeRow,
  viewerId: string,
  map: Map<string, { id: string; name: string; avatarUrl: string | null }>,
): PvpChallengeView {
  const role = r.challengerId === viewerId ? ('challenger' as const) : ('opponent' as const);
  const counterpartId = role === 'challenger' ? r.opponentId : r.challengerId;
  const cp = map.get(counterpartId);
  const status: PvpStatus = isPvpStatus(r.status) ? r.status : 'failed';
  return {
    id: r.id,
    requestId: r.requestId,
    modeId: r.modeId,
    modeLabel: LABEL_OF.get(r.modeId) ?? r.modeId,
    scheduledAt: r.scheduledAt.toISOString(),
    timezone: r.timezone,
    tzOffsetMinutes: r.tzOffsetMinutes,
    notes: r.notes,
    status,
    createdAt: r.createdAt.toISOString(),
    respondAt: r.respondAt ? r.respondAt.toISOString() : null,
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    role,
    counterpartId,
    counterpartName: cp?.name ?? '（已删除条目）',
    counterpartAvatar: cp?.avatarUrl ?? null,
  };
}
