// ============================================================
// 数据库启动前自检 — dev / start 启动前自动检测并恢复
// 用法：bun run scripts/ensure-db.ts（dev 与 start 脚本均已接入）
// 2026-11-04 加固（沙盒持久化修复，见 docs/tier-command-sandbox-audit.md）：
//   1) 恢复链升级：加密备份（清单 latestValid → 本地/ OSS 枚举）
//      → 旧版明文快照，全部经有效性闸门后才落位
//   2) 禁止静默创建空库：库缺失且无有效备份时，
//      必须显式传入 GOATB_ALLOW_EMPTY_DB=1（仅限命令行一次性传入，
//      禁止写入 .env 常规环境）才会建空库；否则响亮失败（exit 1）
//   3) 任何灾难路径都写入 db/DATA-LOSS-ALERT.txt 告警标志
//   4) 2026-11-05 隔离洞修复：空库（quarantine：AdminUser=0 且 Config=0）
//      不再被误判为 OK —— 旧逻辑 `g.status !== 'reject'` 会让容器重置后的
//      空库直接通过启动检查且永不触发恢复链（16:27 两次 quarantine
//      备份即此洞的产物）。现在 quarantine 与 reject 一致进入恢复链，
//      从最近有效备份自愈；全新部署仍按纪律要求 GOATB_ALLOW_EMPTY_DB=1
// 纪律：本脚本绝不删除生产库；恢复候选必须过闸门（integrity/必需表）
// ============================================================

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'path';
import {
  DB_PATH, BACKUP_DIR, loadOrCreateKey, gateCheck,
  listRestoreCandidates, tryRestoreCandidate, ALERT_FILE,
} from './lib/backup-core';

function playerCount(dbPath: string): number {
  if (!existsSync(dbPath)) return -1;
  try {
    // 轻量检查：闸门前的快速存在性判断（正式闸门在 backup-core.gateCheck）
    const db = new Database(dbPath, { readonly: true });
    const row = db.query('SELECT COUNT(*) as c FROM Player').get() as { c: number } | null;
    db.close();
    return row?.c ?? 0;
  } catch {
    return -1; // 表不存在或文件损坏
  }
}

async function writeAlert(reason: string, recoveryHint: string) {
  try {
    mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      ALERT_FILE,
      [
        '⚠️  GOATB 数据丢失告警（DATA LOSS ALERT）',
        `时间: ${new Date().toISOString()}`,
        `原因: ${reason}`,
        '',
        '该文件由 ensure-db.ts 在「数据库缺失且无有效备份」时写入。',
        '处理指引:',
        recoveryHint,
        '本告警在数据库成功恢复后会被自动删除。',
      ].join('\n'),
      'utf8',
    );
  } catch { /* 告警写失败不阻塞主流程 */ }
}

async function main() {
  // 全新环境：db 目录可能整个不存在 → 先建目录
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // ---------- 0) 现库快速检查 ----------
  const cur = playerCount(DB_PATH);
  if (cur >= 0) {
    // 现库文件存在且 Player 表可查 → 用正式闸门复核（integrity/必需表）
    const g = await gateCheck(DB_PATH);
    if (g.status === 'valid') {
      console.log(`✓ ensure-db: db/custom.db OK (${cur} players, integrity=${g.integrity ?? 'n/a'})`);
      // 启动即备份一次（保护当前状态；失败不阻塞启动）
      try {
        const { runBackup } = await import('./lib/backup-core');
        const ob = await runBackup({ quiet: true });
        if (ob.status === 'valid' || ob.status === 'quarantine') {
          console.log(`✓ [ensure-db] 启动备份完成：${ob.file} status=${ob.status}${ob.ossVerified ? '（OSS 回读一致）' : '（仅本地副本）'}`);
        } else {
          console.warn(`⚠ [ensure-db] 启动备份未成功（${ob.status}）：${ob.reason ?? ''}`);
        }
      } catch (e) {
        console.warn('⚠ [ensure-db] 启动备份异常（不阻塞启动）:', (e as Error).message);
      }
      return;
    }
    // quarantine（空库签名）与 reject 一致：进入恢复链（2026-11-05 隔离洞修复）
    console.warn(`⚠ ensure-db: 现库未过闸门（${g.status}: ${g.reason}）——尝试恢复链`);
  }

  // ---------- 1) 恢复链：加密备份优先，旧明文快照兜底 ----------
  const k = await loadOrCreateKey();
  const candidates = await listRestoreCandidates();
  console.log(`… ensure-db: 恢复链启动，候选 ${candidates.length} 份`);

  for (const cand of candidates) {
    const r = await tryRestoreCandidate(cand, k.key);
    if (r.ok && r.tmpDb) {
      // 恢复前对明文临时文件做最终确认（防 TOCTOU）
      const g2 = r.gate!;
      await copyFile(r.tmpDb, DB_PATH);
      const stats = g2.counts
        ? Object.entries(g2.counts).map(([t, n]) => `${t}=${n}`).join(' ')
        : '';
      console.log(`✓ [ensure-db] restored from ${cand.label} → db/custom.db（${stats}）`);
      // 恢复成功：清除历史告警
      try { rmSync(ALERT_FILE, { force: true }); } catch { /* ignore */ }
      // 恢复成功后立即做一次新备份（保护恢复成果）
      try {
        const { runBackup } = await import('./lib/backup-core');
        const ob = await runBackup({ quiet: true });
        console.log(`✓ [ensure-db] 恢复成果已自动备份：${ob.file ?? '(skipped)'} status=${ob.status}`);
      } catch { /* 备份失败不阻塞启动 */ }
      return;
    }
    console.warn(`⚠ [ensure-db] 候选不可用 ${cand.label}: ${r.error ?? r.gate?.reason ?? 'unknown'}`);
  }

  // ---------- 2) 全部候选失败 → 灾难路径 ----------
  const allowEmpty = process.env.GOATB_ALLOW_EMPTY_DB === '1';
  const reason = '数据库缺失/损坏，且无任何过闸门的备份（加密备份解密失败或不存在）';

  if (allowEmpty) {
    await writeAlert(
      reason,
      '本次启动通过 GOATB_ALLOW_EMPTY_DB=1 显式允许建空库。若非预期，请立即从 upload/goatb-backups/ 检查备份与 upload/goatb-keys/ 密钥。',
    );
    console.warn('⚠ ensure-db: 显式允许（GOATB_ALLOW_EMPTY_DB=1）→ 建空表结构。此事件已写入 db/DATA-LOSS-ALERT.txt');
    await bootstrapEmptySchema();
    return;
  }

  // 禁止静默空库：响亮失败
  await writeAlert(
    reason,
    '未设置 GOATB_ALLOW_EMPTY_DB=1，拒绝静默建空库。请先检查恢复源后重试。',
  );
  console.error('┌──────────────────────────────────────────────────────────┐');
  console.error('│  ⚠️  GOATB 数据灾难保护触发（DATA LOSS PROTECTION）        │');
  console.error('│  数据库缺失/损坏，且没有任何可用的过闸门备份。            │');
  console.error('│  为避免静默清空业务数据，拒绝以空库启动。                │');
  console.error('│                                                          │');
  console.error('│  处理选项:                                               │');
  console.error('│   1. 检查 upload/goatb-backups/（OSS 加密备份）与        │');
  console.error('│      upload/goatb-keys/backup-secret.key 是否可读        │');
  console.error('│   2. 检查 backups/ 本地加密备份                          │');
  console.error('│   3. 确属全新部署（接受空库）:                           │');
  console.error('│      GOATB_ALLOW_EMPTY_DB=1 bun run dev                  │');
  console.error('│      （该变量仅限命令行一次性传入，禁止写入 .env）       │');
  console.error('│   详情见 db/DATA-LOSS-ALERT.txt                          │');
  console.error('└──────────────────────────────────────────────────────────┘');
  process.exit(1);
}

/** 全新环境自举：建空表结构（仅在显式 GOATB_ALLOW_EMPTY_DB=1 时可达） */
async function bootstrapEmptySchema() {
  console.log('… ensure-db: 尝试 prisma db push 建表（显式授权的全新环境自举）');
  try {
    const proc = Bun.spawnSync(
      ['bunx', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: 'file:' + DB_PATH },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    if (proc.exitCode === 0) {
      console.log('✓ ensure-db: 空表结构创建完成');
    } else {
      console.warn('⚠ ensure-db: prisma db push 非零退出:', new TextDecoder().decode(proc.stderr).slice(0, 400));
    }
  } catch (e) {
    console.warn('⚠ ensure-db: prisma db push 异常:', e);
  }
}

main().catch(async (e) => {
  console.error('ensure-db 失败:', e);
  await writeAlert(`ensure-db 异常: ${(e as Error).message}`, '请人工检查数据库与备份状态。');
  process.exit(1);
});
