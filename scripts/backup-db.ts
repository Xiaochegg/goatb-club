// ============================================================
// GOATB 数据库备份脚本（2026-11-04 加固版）
// 用法：bun run scripts/backup-db.ts
// 核心逻辑统一在 scripts/lib/backup-core.ts：
//   有效性闸门 → VACUUM INTO 一致性快照 → AES-256-GCM 加密
//   → 本地 backups/ + OSS upload/goatb-backups/ 双副本
//   → SHA-256 写后回读校验 → 清单更新（latestValid 指针）
// 纪律：空库/可疑库进隔离区，绝不顶替最后一份有效备份；
//       闸门拒绝的源库不产生任何备份文件。
// ============================================================

import { runBackup } from './lib/backup-core';

const outcome = await runBackup();
if (outcome.status === 'error') {
  console.error(`✗ [backup-db] 备份失败：${outcome.reason}`);
  process.exit(1);
}
if (outcome.status === 'reject') {
  console.error(`✗ [backup-db] 源库未过有效性闸门，未写入任何备份：${outcome.reason}`);
  process.exit(1);
}
// valid / quarantine 均属成功执行（quarantine 已由核心层告警）
process.exit(0);
