// ============================================================
// 约 PVP · 共享契约与校验（工单 2026-11-10 V1.0）
// ------------------------------------------------------------
// **客户端安全**：本文件绝不 import db / node API（可被 client 组件引用）。
// 服务端独占逻辑（过期清扫/序列化）在 @/lib/pvp-server。
// 零业务越界：
//   - 模式词表唯一来源 = constants.ALL_MODES / MODE_LABELS（不重复硬编码）；
//   - 本模块不做任何写操作，Player.stats（正式 matches/K/D/胜场）永不经由本模块修改；
//   - 状态机单向：pending → accepted | rejected | cancelled | expired | failed。
// ============================================================

import { ALL_MODES, MODE_LABELS, type GameMode } from '@/lib/constants';

// ---------- 模式（约战可选 = 现有全部 PVP 游戏模式；单一来源 import） ----------

export interface PvpModeOption { id: GameMode; label: string }

export const PVP_MODES: PvpModeOption[] = ALL_MODES.map(id => ({ id, label: MODE_LABELS[id] }));

export function isChallengeableMode(modeId: unknown): modeId is GameMode {
  return typeof modeId === 'string' && (ALL_MODES as string[]).includes(modeId);
}

// ---------- 限制常量（服务端权威；客户端仅用于输入预校验与提示） ----------

export const PVP_LIMITS = {
  NOTES_MAX: 100,                 // 备注字数上限（trim 后）
  REQUEST_ID_MIN: 8,              // 幂等键长度下限
  REQUEST_ID_MAX: 64,             // 幂等键长度上限
  MIN_LEAD_MINUTES: 10,           // 预约须至少提前 10 分钟
  MAX_HORIZON_DAYS: 60,           // 预约最长 horizon 60 天
  EXPIRE_GRACE_MINUTES: 120,      // 过期宽限：scheduledAt 过点 2 小时后判 expired
  PENDING_MAX_DAYS: 14,           // pending 最长存活 14 天（防僵尸工单）
  MAX_OPEN_OUTGOING: 8,           // 发起方未终结（pending+accepted）上限
  CREATE_COOLDOWN_MS: 60_000,     // 两次发起最小间隔
} as const;

// ---------- 状态机 ----------

export const PVP_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled', 'expired', 'failed'] as const;
export type PvpStatus = (typeof PVP_STATUSES)[number];

export const PVP_STATUS_LABELS: Record<PvpStatus, string> = {
  pending: '等待回应',
  accepted: '已接受',
  rejected: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
  failed: '创建失败',
};

export function isPvpStatus(v: unknown): v is PvpStatus {
  return typeof v === 'string' && (PVP_STATUSES as readonly string[]).includes(v);
}

/** pending → 终态单向迁移校验（accept/reject/cancel/sweep 之外一律拒绝） */
export function canTransition(from: PvpStatus, to: PvpStatus): boolean {
  if (from !== 'pending' && from !== 'accepted') return false;
  if (from === 'accepted') return false; // accepted 为本系统终态（赛果走既有线下/管理流程）
  return to === 'accepted' || to === 'rejected' || to === 'cancelled' || to === 'expired' || to === 'failed';
}

// ---------- 输入校验（服务端权威；返回 null = 合法） ----------

const REQUEST_ID_RE = /^[A-Za-z0-9\-_]+$/;

export function validateRequestId(v: unknown): string | null {
  if (typeof v !== 'string') return 'requestId 缺失';
  const s = v.trim();
  if (s.length < PVP_LIMITS.REQUEST_ID_MIN || s.length > PVP_LIMITS.REQUEST_ID_MAX) return 'requestId 长度不合法';
  if (!REQUEST_ID_RE.test(s)) return 'requestId 字符不合法';
  return null;
}

/** 备注：折叠空白 + trim；空串 → null（无备注）；超长 → 错误信息 */
export function normalizeNotes(v: unknown): { value: string | null; error: string | null } {
  if (v === undefined || v === null) return { value: null, error: null };
  if (typeof v !== 'string') return { value: null, error: '备注格式不合法' };
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > PVP_LIMITS.NOTES_MAX) return { value: null, error: `备注最长 ${PVP_LIMITS.NOTES_MAX} 字` };
  return { value: s || null, error: null };
}

/** 预约时间：合法 Date 且在 [now+minLead, now+horizon] 窗口内；返回规范化 Date 或错误 */
export function validateScheduledAt(v: unknown, now = new Date()): { value: Date | null; error: string | null } {
  if (typeof v !== 'string' || !v) return { value: null, error: '预约时间缺失' };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { value: null, error: '预约时间格式不合法' };
  const min = now.getTime() + PVP_LIMITS.MIN_LEAD_MINUTES * 60_000;
  const max = now.getTime() + PVP_LIMITS.MAX_HORIZON_DAYS * 24 * 60 * 60_000;
  if (d.getTime() < min) return { value: null, error: `预约时间需至少提前 ${PVP_LIMITS.MIN_LEAD_MINUTES} 分钟` };
  if (d.getTime() > max) return { value: null, error: `预约时间最多提前 ${PVP_LIMITS.MAX_HORIZON_DAYS} 天` };
  return { value: d, error: null };
}

/** 时区标注：IANA 名（宽松校验）+ UTC 偏移分钟 */
export function validateTz(tz: unknown, offset: unknown): { timezone: string; tzOffsetMinutes: number } {
  const timezone = typeof tz === 'string' && tz.length > 0 && tz.length <= 64 ? tz : 'Asia/Riyadh';
  const off = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 180;
  const tzOffsetMinutes = Math.max(-840, Math.min(840, off));
  return { timezone, tzOffsetMinutes };
}

// ---------- 客户端展示序列化 ----------

export interface PvpChallengeView {
  id: string;
  requestId: string;
  modeId: string;
  modeLabel: string;
  scheduledAt: string;       // ISO UTC
  timezone: string;
  tzOffsetMinutes: number;
  notes: string | null;
  status: PvpStatus;
  createdAt: string;
  respondAt: string | null;
  closedAt: string | null;
  /** 相对当前查看者的角色 */
  role: 'challenger' | 'opponent';
  counterpartId: string;
  counterpartName: string;
  counterpartAvatar: string | null;
}
