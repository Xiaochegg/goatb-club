// ============================================================
// GOATB 自动存档停机标记（管理员指令 2026-11-10）
// ============================================================
// 管理员原话（机制定义）：
//   「自动保存添加一个新机制……检测到被侵犯缓存」「必须是检测你所缓存的，
//    保存的缓存是否有 KB 的，如果没 KB 的就直接弃用」
//   「检测如果没 KB 的话就停止保存，直接拒绝 5 分钟保存一次的请求，
//    等待管理员核实自动关闭」
//
// 语义：
//   - 自动存档家族（auto-5min / page-enter / auto-on）在备份执行体闸门
//     判定源数据「被侵犯」（reject = 损坏/过小/缺表；quarantine = 空库/
//     空榜签名）时，写入本停机标记；
//   - 标记存在期间，5 分钟自动保存请求被直接拒绝（不再执行备份），
//     等待管理员核实；
//   - 管理员核实后停机自动关闭（两条路径）：
//       a) 数据存档页「已核实，恢复自动存档」按钮（verify-autosave-halt）；
//       b) 任何一次手动保存产出有效备份（gate=valid）→ 自动清除。
//   - 手动动作永不拦截（2026-11-09 既有裁定不变）；每小时例行备份
//     不受停机影响。
//
// 工程约束：
//   - 本模块被三方共用：scripts/lib/backup-core.ts（Bun 执行体，写）、
//     mini-services/backup-keeper（Bun 调度器，读）、
//     src/lib/backup/auto-backup.ts + API 路由（Node 运行时，读/清）。
//     因此只依赖 node:fs（绝不能引入 bun:sqlite —— Node 侧不可用）。
//   - 标记放 /tmp（与 BACKUP-PAUSED 暂停标记同一模式）：容器重置即清空，
//     但清空后若数据仍无效，下一轮闸门会重新停机（自愈，不怕丢标记）。
// ============================================================

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';

export const AUTOSAVE_HALT_FILE = '/tmp/goatb-autosave-halted.json';

export interface AutosaveHalt {
  gateStatus: 'reject' | 'quarantine';       // 闸门判定（被侵犯类型）
  reason: string;                            // 闸门原因（透传给管理员）
  counts: Record<string, number> | null;     // 行数画像（Player/AdminUser/Config…）
  trigger: string;                           // 触发源（哪个自动请求发现的）
  at: string;                                // 停机时刻 ISO
}

/** 读停机标记：不存在/损坏 → null（fail-open；闸门下一轮会重新判定，自愈） */
export function readAutosaveHalt(): AutosaveHalt | null {
  try {
    if (!existsSync(AUTOSAVE_HALT_FILE)) return null;
    const j = JSON.parse(readFileSync(AUTOSAVE_HALT_FILE, 'utf8')) as Partial<AutosaveHalt>;
    if (j?.gateStatus !== 'reject' && j?.gateStatus !== 'quarantine') return null;
    if (typeof j.reason !== 'string' || typeof j.at !== 'string') return null;
    return {
      gateStatus: j.gateStatus,
      reason: j.reason,
      counts: (j.counts && typeof j.counts === 'object') ? j.counts as Record<string, number> : null,
      trigger: typeof j.trigger === 'string' ? j.trigger : 'unknown',
      at: j.at,
    };
  } catch {
    return null;
  }
}

/** 写停机标记（覆盖写，保留最新一次判定事实） */
export function writeAutosaveHalt(h: AutosaveHalt): void {
  try {
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(AUTOSAVE_HALT_FILE, JSON.stringify(h, null, 2));
  } catch { /* 写失败不影响备份本体；下一轮闸门会再次判定 */ }
}

/** 清除停机标记（管理员核实 / 手动有效备份自动关闭） */
export function clearAutosaveHalt(): void {
  try { rmSync(AUTOSAVE_HALT_FILE, { force: true }); } catch { /* ignore */ }
}
