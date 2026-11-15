// ============================================================
// GOATB 外科合并恢复工具（只增不删 · 幂等 · 单事务）
// ============================================================
// 用途（2026-11-09 管理员批准「方案 A」落地工具）：
//   从指定加密快照中，把当前库缺失的 Player / OperationLog 行
//   合并回 db/custom.db。其余一切（AdminUser / Config / Season /
//   RankSnapshot / ApiKey / Tier 台账表 / 现有任何行）绝不触碰。
//
// 纪律对齐：
//   - 只增不删：仅 INSERT 缺失行，绝不 UPDATE / DELETE 现有行
//   - 幂等：按主键（Player.id / OperationLog.id）+ Player.name 唯一
//     约束双重去重；重复执行零副作用
//   - 可逆：调用方必须在合并前完成一次备份（本次已由
//     custom-2026-11-09-044510905.db.enc 锁定回滚点）
//   - 列交集适配：新旧血缘 schema 可能存在列差异，INSERT 只写
//     「源表与目标表的列交集」，其余列由目标表默认值填充
//   - 与 restore-snapshot.ts 的分工：restore 整库替换（需停 dev），
//     本工具行级追加（短事务 + busy_timeout，可在服务运行时执行）
//
// 用法：
//   GOATB_MERGE_TARGET=custom-2026-11-06-050809226.db.enc \
//     bun run scripts/merge-snapshot-rows.ts
//   GOATB_MERGE_DRYRUN=1 … （只盘点将合并的行，不写库）
//
// 安全设计：
//   - 目标快照必须在本地 backups/ 或 upload/goatb-backups/ 中存在
//   - 解密依赖 AES-256-GCM 认证标签（防篡改/防损坏，密钥错即失败）
//   - 解密产物先过 gateCheck（reject 级拒绝）
//   - BEGIN IMMEDIATE 单事务：要么全部落库，要么零变更
//   - 本工具绝不删除任何文件（含 /tmp 工作产物，由调用方清理）
// ============================================================

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'path';
import {
  DB_PATH, BACKUP_DIR, UPLOAD_BACKUP_DIR,
  loadOrCreateKey, decryptToFile, gateCheck, WORK_DIR,
} from './lib/backup-core';

const TARGET = process.env.GOATB_MERGE_TARGET || '';
const DRYRUN = process.env.GOATB_MERGE_DRYRUN === '1';

if (!TARGET) {
  console.error('✗ 缺少 GOATB_MERGE_TARGET 环境变量（快照 .db.enc 文件名）');
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`✗ [merge] ${msg}`);
  process.exit(1);
}

// ---------- 1) 定位快照 ----------
const localP = path.join(BACKUP_DIR, TARGET);
const ossP = path.join(UPLOAD_BACKUP_DIR, TARGET);
const srcEnc = existsSync(localP) ? localP : existsSync(ossP) ? ossP : null;
if (!srcEnc) fail(`快照在本地与 OSS 目录均不存在：${TARGET}`);

// ---------- 2) 解密（GCM 认证标签 = 完整性硬校验） ----------
const k = await loadOrCreateKey();
console.log(`🔑 [merge] 密钥就绪 fingerprint=${k.fingerprint} source=${k.source}`);
mkdirSync(WORK_DIR, { recursive: true });
const srcDbPath = path.join(WORK_DIR, `merge-${TARGET.replace(/\.enc$/, '')}`);
await decryptToFile(srcEnc!, srcDbPath, k.key);
console.log(`📦 [merge] 快照解密成功：${TARGET}`);

// ---------- 3) 源库闸门（reject 级拒绝） ----------
const g = await gateCheck(srcDbPath);
if (g.status === 'reject') fail(`源快照未过闸门：${g.reason}`);
console.log(`✅ [merge] 源快照过闸门：integrity=${g.integrity} counts=${JSON.stringify(g.counts)}`);

// ---------- 4) 列交集 ----------
function columnsOf(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map(r => r.name);
}

const src = new Database(srcDbPath, { readonly: true, create: false });
if (!existsSync(DB_PATH)) fail(`目标库不存在：${DB_PATH}`);
const tgt = new Database(DB_PATH); // 已断言存在，杜绝静默建空库
tgt.run('PRAGMA busy_timeout = 5000');

// ---------- 5) 盘点待合并行（只增判定） ----------
interface MergePlan {
  table: 'Player' | 'OperationLog';
  cols: string[];
  rows: Record<string, unknown>[];
  skippedExisting: number;
}

function planTable(table: 'Player' | 'OperationLog'): MergePlan {
  const srcCols = columnsOf(src, table);
  const tgtCols = columnsOf(tgt, table);
  if (tgtCols.length === 0) fail(`目标库缺表：${table}`);
  const cols = srcCols.filter(c => tgtCols.includes(c));
  if (cols.length === 0) fail(`源/目标 ${table} 无列交集`);

  const srcRows = src.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
  const existingIds = new Set(
    (tgt.query(`SELECT id FROM "${table}"`).all() as { id: string }[]).map(r => r.id),
  );
  const existingNames = table === 'Player'
    ? new Set((tgt.query(`SELECT name FROM Player`).all() as { name: string }[]).map(r => r.name))
    : null;

  const rows: Record<string, unknown>[] = [];
  let skippedExisting = 0;
  for (const r of srcRows) {
    if (existingIds.has(String(r.id))) { skippedExisting++; continue; }
    if (existingNames?.has(String(r.name))) { skippedExisting++; continue; }
    rows.push(r);
  }
  return { table, cols, rows, skippedExisting };
}

const plans = [planTable('Player'), planTable('OperationLog')];

console.log(`\n📋 [merge] 合并计划${DRYRUN ? '（DRY RUN，不写库）' : ''}：`);
for (const p of plans) {
  console.log(`   ${p.table}：待插入 ${p.rows.length} 行，已存在跳过 ${p.skippedExisting} 行（列交集 ${p.cols.length} 列）`);
  for (const r of p.rows.slice(0, 5)) {
    const hint = p.table === 'Player'
      ? String(r.name)
      : `${String(r.createdAt)} [${String(r.type)}] ${String(r.detail).slice(0, 60)}`;
    console.log(`     · ${String(r.id)} → ${hint}`);
  }
  if (p.rows.length > 5) console.log(`     · … 共 ${p.rows.length} 行`);
}

if (DRYRUN) {
  console.log('\n🧪 [merge] DRY RUN 结束，未写库。');
  process.exit(0);
}

if (plans.every(p => p.rows.length === 0)) {
  console.log('\n⏭ [merge] 无缺失行可合并（幂等命中），零变更退出。');
  process.exit(0);
}

// ---------- 6) 单事务落库（BEGIN IMMEDIATE，要么全成要么零变更） ----------
try {
  tgt.run('BEGIN IMMEDIATE');
  for (const p of plans) {
    if (p.rows.length === 0) continue;
    const colList = p.cols.map(c => `"${c}"`).join(', ');
    const placeholders = p.cols.map(() => '?').join(', ');
    const stmt = tgt.prepare(`INSERT INTO "${p.table}" (${colList}) VALUES (${placeholders})`);
    for (const r of p.rows) {
      stmt.run(...p.cols.map(c => r[c] as never));
    }
  }
  tgt.run('COMMIT');
  console.log(`\n💾 [merge] 事务已提交。`);
} catch (e) {
  try { tgt.run('ROLLBACK'); } catch { /* 事务已不在位 */ }
  fail(`事务失败已回滚，目标库零变更：${(e as Error).message}`);
} finally {
  src.close();
  tgt.close();
}

// ---------- 7) 落库复检 ----------
const chk = new Database(DB_PATH, { readonly: true, create: false });
try {
  const integrity = (chk.query('PRAGMA integrity_check').get() as any).integrity_check;
  const players = (chk.query('SELECT name, tiers FROM Player ORDER BY createdAt').all() as any[]);
  const opTotal = (chk.query('SELECT COUNT(*) as c FROM OperationLog').get() as any).c;
  console.log(`\n🔍 [merge] 复检：integrity=${integrity}`);
  console.log(`   Player=${players.length}：${players.map(p => p.name).join('、')}`);
  for (const p of players) console.log(`   · ${p.name} tiers=${p.tiers}`);
  console.log(`   OperationLog 总数=${opTotal}`);
  if (integrity !== 'ok') fail('落库后 integrity_check 未通过！');
  console.log(`\n✅ [merge] 完成：${TARGET} → db/custom.db（只增不删）`);
} finally {
  chk.close();
}
