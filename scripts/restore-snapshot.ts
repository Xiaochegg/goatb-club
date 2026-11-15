// ============================================================
// GOATB 定向快照恢复工具（2026-11-04 容器级重置事故专用）
// ============================================================
// 与 ensure-db.ts 自动恢复链的区别：
//   ensure-db 只在「现库缺失/未过闸门」时才走恢复链；本次事故中
//   污染库（AdminUser=0, Config=1）恰好逃过空库签名（需 Admin=0
//   且 Config=0），会被闸门误判为 valid —— 因此需要本工具做
//   「人工裁定 + 定向恢复」：恢复用户指定的具体快照文件。
//
// 流程（全部复用 backup-core 已验证路径，绝不手写加解密）：
//   1) loadOrCreateKey()            —— 密钥权威源 OSS
//   2) 定位目标快照（本地 → OSS）
//   3) 清单 SHA-256 预校验（防传输损坏/FUSE 异步窗口）
//   4) tryRestoreCandidate()        —— 解密 → /tmp 工作目录 → 闸门
//   5) 事发库取证留档 /tmp（不入备份链，防污染）
//   6) 落位 db/custom.db + 复检
//
// 用法：
//   GOATB_RESTORE_TARGET=custom-2026-11-04-150059730.db.enc \
//     bun run scripts/restore-snapshot.ts
// 纪律：
//   - 目标文件必须在清单中登记且 status≠reject，否则拒绝恢复
//   - 落位前必须先停 dev server（脚本检测进程并拒绝继续）
//   - 本脚本绝不删除任何备份文件
//
// 2026-11-05 互斥升级：恢复期间写「备份暂停标记」+ 获取独占备份锁，
//   backup-keeper 调度的备份在此期间自动避让；结束后无论成败均清理。
// ============================================================

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { copyFile, readFile, mkdir } from 'node:fs/promises';
import path from 'path';
import {
  DB_PATH, BACKUP_DIR, UPLOAD_BACKUP_DIR, WORK_DIR,
  loadOrCreateKey, listRestoreCandidates, tryRestoreCandidate,
  inspectDb, readManifest, mergeManifests, sha256Hex,
  writePauseMarker, clearPauseMarker,
  acquireBackupLockSync, releaseBackupLockSync,
} from './lib/backup-core';

const TARGET = process.env.GOATB_RESTORE_TARGET || '';

function fail(msg: string): never {
  // 抛错而非直接退出：保证外层 finally 能释放锁 / 清理暂停标记
  throw new Error(msg);
}

async function main() {
  if (!TARGET) fail('缺少 GOATB_RESTORE_TARGET 环境变量（目标 .db.enc 文件名）');

  // ---------- 0) 安全前置：dev server 必须已停止 ----------
  const proc = Bun.spawnSync(['pgrep', '-f', 'next dev -p 3000'], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode === 0) {
    fail('检测到 next dev -p 3000 仍在运行 —— 请先停止 dev server 再执行恢复（防 SQLite 文件句柄竞争）');
  }
  console.log(`✓ [restore] 前置检查：dev server 已停止，端口 3000 空闲`);

  // ---------- 0.5) 备份避让：暂停标记 + 独占备份锁（无论成败均清理） ----------
  await writePauseMarker(`定向恢复 ${TARGET}`, 'restore-snapshot');
  console.log(`⏸  [restore] 已写备份暂停标记（调度器在此期间自动避让）`);
  let lockAcquired = false;
  try {
    const lockDeadline = Date.now() + 200_000; // 等待进行中的备份收尾（单次备份 < 180s）
    for (;;) {
      const lk = acquireBackupLockSync('restore-snapshot');
      if (lk.ok) { lockAcquired = true; break; }
      if (Date.now() > lockDeadline) {
        fail(`备份锁长期被占用（${lk.reason}）—— 放弃恢复，暂停标记已清理，可稍后重试`);
      }
      console.log(`⏳ [restore] 有备份正在执行（${lk.reason}），5s 后重试…`);
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log(`🔒 [restore] 已获取独占备份锁`);

    await restoreFlow();
  } finally {
    if (lockAcquired) releaseBackupLockSync('restore-snapshot');
    await clearPauseMarker();
    console.log(`🧹 [restore] 已释放备份锁并清除暂停标记`);
  }
}

async function restoreFlow() {
  // ---------- 1) 密钥 ----------
  const k = await loadOrCreateKey();
  console.log(`🔑 [restore] 密钥就绪 fingerprint=${k.fingerprint} source=${k.source}`);

  // ---------- 2) 清单登记核验 ----------
  const m = mergeManifests(await readManifest('local'), await readManifest('oss'));
  const entry = m?.backups.find(b => b.file === TARGET);
  if (!entry) fail(`目标快照 ${TARGET} 不在备份清单中 —— 拒绝恢复未登记文件`);
  if (entry.status === 'reject') fail(`目标快照在清单中 status=reject（${entry.reason}）—— 拒绝恢复`);
  console.log(`📋 [restore] 清单登记：status=${entry.status} encryptedAt=${entry.encryptedAt} sourceStats=${JSON.stringify(entry.sourceStats)}`);

  // ---------- 3) 定位目标文件（本地优先，其次 OSS） ----------
  const localP = path.join(BACKUP_DIR, TARGET);
  const ossP = path.join(UPLOAD_BACKUP_DIR, TARGET);
  let srcPath = '';
  let srcLabel = '';
  if (existsSync(localP)) { srcPath = localP; srcLabel = `local:${TARGET}`; }
  else if (existsSync(ossP)) { srcPath = ossP; srcLabel = `oss:${TARGET}`; }
  else fail(`目标快照在本地与 OSS 目录均不存在：${TARGET}`);
  console.log(`📦 [restore] 目标文件定位：${srcLabel}`);

  // ---------- 4) 密文 SHA-256 预校验（对照清单） ----------
  const srcBuf = await readFile(srcPath);
  const actualHash = sha256Hex(srcBuf);
  if (entry.sha256 && actualHash !== entry.sha256) {
    fail(`密文 SHA-256 与清单不一致（清单=${entry.sha256.slice(0, 12)} 实测=${actualHash.slice(0, 12)}）—— 文件可能损坏，拒绝恢复`);
  }
  console.log(`🔐 [restore] 密文 SHA-256 预校验一致：${actualHash.slice(0, 12)}…`);

  // ---------- 5) 恢复候选 + tryRestoreCandidate（已验证恢复路径） ----------
  const candidates = await listRestoreCandidates();
  const cand = candidates.find(c => c.path === srcPath)
    ?? { kind: srcLabel.startsWith('oss:') ? 'enum-enc-oss' as const : 'enum-enc-local' as const, path: srcPath, label: srcLabel };
  console.log(`⚙️  [restore] 调用 tryRestoreCandidate（kind=${cand.kind}）—— 解密 → 闸门 → /tmp 临时文件`);
  const r = await tryRestoreCandidate(cand, k.key);
  if (!r.ok || !r.tmpDb) fail(`tryRestoreCandidate 失败：${r.error ?? r.gate?.reason ?? 'unknown'}`);
  const g = r.gate!;
  console.log(`✅ [restore] 解密成功且过闸门：integrity=${g.integrity} counts=${JSON.stringify(g.counts)}`);

  // ---------- 6) 事发库取证留档（/tmp，不入备份链） ----------
  if (existsSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveP = `/tmp/goatb-incident-db-${stamp}.db`;
    await copyFile(DB_PATH, archiveP);
    const before = inspectDb(DB_PATH);
    console.log(`🗂  [restore] 事发库已留档：${archiveP}（画像 AdminUser=${before.counts?.AdminUser} Config=${before.counts?.Config} OperationLog=${before.counts?.OperationLog}）`);
  }

  // ---------- 7) 落位 ----------
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await copyFile(r.tmpDb, DB_PATH);
  console.log(`💾 [restore] 已落位：${r.tmpDb} → ${DB_PATH}`);

  // ---------- 8) 落位复检 ----------
  const after = inspectDb(DB_PATH);
  if (!after.ok) fail(`落位后复检失败：${after.error ?? 'unknown'}`);
  console.log(`✅ [restore] 落位复检通过：integrity=${after.integrity} bytes=${after.bytes}`);
  console.log(`📊 [restore] 恢复后画像：${JSON.stringify(after.counts)}`);

  // ---------- 9) 业务级明细核验（管理员 / 配置键 / 审计日志） ----------
  const db = new Database(DB_PATH, { readonly: true, create: false });
  try {
    const admins = db.query('SELECT username, role FROM AdminUser ORDER BY createdAt').all() as { username: string; role: string }[];
    console.log(`👤 [restore] 管理员账号（${admins.length}）：${admins.map(a => `${a.username}(${a.role})`).join('、')}`);

    const cfgRows = db.query('SELECT key FROM Config ORDER BY key').all() as { key: string }[];
    const cfgKeys = cfgRows.map(c => c.key);
    console.log(`⚙️  [restore] 配置键（${cfgKeys.length}）：${cfgKeys.join('、')}`);

    const logTotal = (db.query('SELECT COUNT(*) as c FROM OperationLog').get() as { c: number }).c;
    const recent = db.query('SELECT type, detail, createdAt FROM OperationLog ORDER BY createdAt DESC LIMIT 3').all() as { type: string; detail: string; createdAt: string }[];
    console.log(`📜 [restore] 审计日志共 ${logTotal} 条，最近 3 条：`);
    for (const l of recent) console.log(`    [${l.type}] ${String(l.detail).slice(0, 80)} @ ${l.createdAt}`);
  } finally {
    db.close();
  }

  console.log(`\n✅ [restore] 定向恢复完成：${TARGET}`);
}

main().catch((e) => {
  console.error(`✗ [restore] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
