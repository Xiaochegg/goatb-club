// ============================================================
// backup-keeper · 自动存档开关读取器（管理员指令 2026-11-09）
// ------------------------------------------------------------
// 「写一个开关吧 这样数据不会丢失……你一开始就先给我关着 5分钟」
//  - 开关持久化在 Config 表 key=auto_backup_enabled（'1'/'on' = 开）；
//    无该行 = 关闭（默认关，绝不默认开）。
//  - 本模块每轮被调用一次、每次都新鲜开库读值（绝不缓存）——
//    管理员切换开关后最多一个周期（5 分钟）内生效，任何进程/设备
//    看到的都是同一份事实（「切换的时候缓存不会更新」的根治点）。
//  - 读取失败（库被锁/缺失/损坏）一律视为关闭（fail-safe，绝不误开）。
//  - 调度器归属：5 分钟循环挂在 backup-keeper（全系统唯一常驻调度器），
//    Next.js 侧不注册任何备份定时器（架构裁定不变）。
// ============================================================
import { Database } from 'bun:sqlite';

export const AUTO_SAVE_CONFIG_KEY = 'auto_backup_enabled';
export const AUTO_SAVE_INTERVAL_MIN = 5;

/** 每轮新鲜读库：'1'/'on' = 开启；无行/异常 = 关闭 */
export function readAutoSaveEnabled(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
      const row = db
        .query('SELECT value FROM Config WHERE key = ?')
        .get(AUTO_SAVE_CONFIG_KEY) as { value?: string } | null;
      return row?.value === '1' || row?.value === 'on';
    } finally {
      db.close();
    }
  } catch {
    return false; // fail-safe：读不到一律视为关闭
  }
}

/** 下一个 5 分钟墙钟整点（:x0/:x5 本地对齐，严格未来；不用相对间隔防漂移） */
export function nextFiveMinuteMark(now: Date = new Date()): Date {
  const m = new Date(now);
  m.setSeconds(0, 0);
  const rem = m.getMinutes() % AUTO_SAVE_INTERVAL_MIN;
  if (rem !== 0) m.setMinutes(m.getMinutes() + (AUTO_SAVE_INTERVAL_MIN - rem));
  if (m.getTime() <= now.getTime()) m.setMinutes(m.getMinutes() + AUTO_SAVE_INTERVAL_MIN);
  // 贴边保护：距 now <1s 就顺延一档，避免触发过近
  if (m.getTime() - now.getTime() < 1000) m.setMinutes(m.getMinutes() + AUTO_SAVE_INTERVAL_MIN);
  return m;
}
