// ============================================================
// GOATB 数据库保护脚本（2026-11-04 加固版 / 2026-11-05 互斥升级）
// 用法：bun run scripts/protect-db.ts
// 语义：「保护」= 执行一次完整备份（与 backup-db.ts 同核心），
//       双副本 = 本地 backups/ + OSS upload/goatb-backups/，
//       副本互验 = SHA-256 写后回读校验（核心层内置）。
// 旧版的项目内/项目外双目录写入已由「本地+OSS 加密副本」取代：
//   - 项目外 /home/z/goatb-data-safe 位于非持久 rootfs，实证无效
//   - OSS 层加密后上云（密钥独立于备份文件存放）
// 纪律：本脚本只新增文件，绝不删除既有备份；空库进隔离区。
//
// 2026-11-05 互斥升级（架构纠错轮）：
//   - 本脚本是全部备份触发路径（keeper 调度 / 管理员手动 / 人工 CLI）
//     的唯一执行体 → 在此统一收口跨进程互斥：
//     1) 恢复暂停标记（BACKUP-PAUSED.json）存在 → 拒绝备份（退出码 4）
//     2) 独占备份锁（BACKUP.lock，O_EXCL + pid/bootId 夺取）→
//        任何时刻最多一个备份在执行（退出码 3 = 他方持锁）
//
// 2026-11-09 触发源标记（管理员指令「写一个开关…5分钟」）：
//   --trigger=hourly|auto-5min|page-enter|auto-on|manual
//   写入清单条目（审计可追溯）并作为自动快照家族限额的判定依据。
// ============================================================

import {
  runBackup,
  isBackupPaused, readPauseReason,
  acquireBackupLockSync, releaseBackupLockSync,
  BACKUP_BUSY_EXIT, BACKUP_PAUSED_EXIT,
} from './lib/backup-core';

async function main(): Promise<number> {
  // 触发源标记（缺省 hourly）：写入清单，供审计与自动快照家族限额区分
  const triggerArg = process.argv.find(a => a.startsWith('--trigger='));
  const trigger = triggerArg ? triggerArg.slice('--trigger='.length) : 'hourly';

  // 0) 恢复/维护期间备份避让（restore-snapshot 会写暂停标记）
  if (isBackupPaused()) {
    console.warn(`⏸  [protect-db] 备份已暂停（${readPauseReason()}）—— 本次不执行，既有备份未受影响`);
    return BACKUP_PAUSED_EXIT;
  }

  // 1) 独占备份锁（与 keeper 调度 / 其他 protect-db / 恢复流程互斥）
  const lock = acquireBackupLockSync('protect-db');
  if (!lock.ok) {
    console.warn(`⏭  [protect-db] 备份锁被占用：${lock.reason} —— 本次不执行（宁少备不错备）`);
    return BACKUP_BUSY_EXIT;
  }

  try {
    console.log(`🛡  [protect-db] 开始保护性备份（trigger=${trigger}｜闸门 → 快照 → 加密 → 双副本 → 回读校验）`);
    const outcome = await runBackup({ trigger });

    if (outcome.status === 'error') {
      console.error(`✗ [protect-db] 备份失败：${outcome.reason}`);
      return 1;
    }
    if (outcome.status === 'reject') {
      console.error(`✗ [protect-db] 源库未过有效性闸门，未写入任何备份：${outcome.reason}`);
      return 1;
    }
    if (outcome.status === 'quarantine') {
      console.warn('⚠ [protect-db] 源库为空库特征：已隔离存档，未顶替最后一份有效备份');
      return 0;
    }
    console.log(`✓ [protect-db] 保护完成：${outcome.file}（OSS 回读 ${outcome.ossVerified ? '一致' : '失败，仅本地副本'}）`);
    return 0;
  } finally {
    releaseBackupLockSync('protect-db');
  }
}

process.exit(await main());
