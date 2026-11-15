// ============================================================
// GOATB backup-keeper 调度核心（纯函数，无副作用，可隔离单测）
// ============================================================
// 「每小时第 1 分钟」的墙钟对齐计算 + 小时桶判定。
// 规则：时刻必须对齐真实系统时间（绝不使用 3600000ms 相对间隔，
// 那会随进程启动时间漂移，永远到不了 XX:01）。
// ============================================================

export const HOUR_MARK_MINUTE = 1;

/**
 * 最近一个已过去的「每小时第 1 分钟」时刻（<= now）。
 * 例：17:29:49 → 17:01:00；17:00:30 → 16:01:00；17:01:00 → 17:01:00
 */
export function latestHourMark(now: Date = new Date()): Date {
  const m = new Date(now);
  m.setMinutes(HOUR_MARK_MINUTE, 0, 0);
  if (m.getTime() > now.getTime()) m.setHours(m.getHours() - 1);
  return m;
}

/** 下一个「每小时第 1 分钟」时刻（> now，绝对墙钟对齐） */
export function nextHourMark(now: Date = new Date()): Date {
  const m = new Date(now);
  m.setMinutes(HOUR_MARK_MINUTE, 0, 0);
  if (m.getTime() <= now.getTime()) m.setHours(m.getHours() + 1);
  return m;
}

export function msUntilNextHourMark(from: Date = new Date()): number {
  return nextHourMark(from).getTime() - from.getTime();
}

/**
 * 小时桶是否已满足：本小时窗口 [mark, 下一 mark) 内是否已有一份
 * status=valid 的备份（以清单 encryptedAt 为准）。
 * 容差：时间戳允许比 mark 早 ≤2s（触发与加密之间毫秒级抖动）；
 * 未来时间戳（时钟偏移）视为已满足，避免补位循环。
 */
export function bucketSatisfied(
  newestValidEncryptedAt: string | null | undefined,
  mark: Date,
  now: Date = new Date(),
): boolean {
  if (!newestValidEncryptedAt) return false;
  const t = Date.parse(newestValidEncryptedAt);
  if (!Number.isFinite(t)) return false;
  return t >= mark.getTime() - 2000 && t <= now.getTime() + 60_000;
}
