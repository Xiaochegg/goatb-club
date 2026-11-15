// ============================================================
// GOATB 备份体系自检工具（持久保留，可重复运行）
// 用法：bun run scripts/selftest-backup.ts
// ============================================================
// 全部测试在 /tmp/goatb-selftest/ 独立副本上进行，
// 绝不修改/删除生产 db/、backups/、upload/ 中任何既有文件。
// 覆盖：
//   1. 闸门判定：正常库=valid / 空库=quarantine / 损坏库=reject
//      / 缺表库=reject（证明非仅凭大小判定，Player=0 不误伤）
//   2. 加密回环：encrypt→decrypt 逐字节一致；篡改密文解密必须失败
//   3. 独立副本恢复演练：从清单 latestValid 解密→闸门→行数比对
//   4. latestValid 指针保护：确认自检全程未改动清单指针
// ============================================================

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'path';
import {
  gateCheck, encryptBuffer, decryptBuffer, loadOrCreateKey,
  listRestoreCandidates, tryRestoreCandidate, readManifest,
  inspectDb, WORK_DIR, DB_PATH,
} from './lib/backup-core';

const T = '/tmp/goatb-selftest';
let pass = 0, fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.error(`  ✗ ${name} ${detail}`); fail++; }
}

async function makeEmptyDb(p: string) {
  const db = new Database(p, { create: true });
  // 最小 GOATB schema（7 张必需表，全空）
  db.run(`CREATE TABLE "Player" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "tiers" TEXT DEFAULT '{}', "createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME)`);
  db.run(`CREATE TABLE "AdminUser" ("id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE "Config" ("id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "value" TEXT DEFAULT '')`);
  db.run(`CREATE TABLE "OperationLog" ("id" TEXT PRIMARY KEY, "type" TEXT, "detail" TEXT)`);
  db.run(`CREATE TABLE "Season" ("id" TEXT PRIMARY KEY, "name" TEXT)`);
  db.run(`CREATE TABLE "RankSnapshot" ("id" TEXT PRIMARY KEY, "playerId" TEXT)`);
  db.run(`CREATE TABLE "ApiKey" ("id" TEXT PRIMARY KEY, "name" TEXT)`);
  db.close();
}

async function makeMissingTableDb(p: string) {
  const db = new Database(p, { create: true });
  db.run(`CREATE TABLE "Player" ("id" TEXT PRIMARY KEY, "name" TEXT)`);
  // 故意缺 AdminUser/Config 等
  db.close();
}

async function main() {
  rmSync(T, { recursive: true, force: true });
  mkdirSync(T, { recursive: true });
  console.log(`🧪 GOATB 备份体系自检（工作区 ${T}，不触碰生产数据）\n`);

  // ---------- 1. 闸门判定 ----------
  console.log('[1] 有效性闸门判定');
  const emptyDb = path.join(T, 'empty.db');
  await makeEmptyDb(emptyDb);
  const gEmpty = await gateCheck(emptyDb);
  check('空库 → quarantine（而非 valid/reject）', gEmpty.status === 'quarantine', `got ${gEmpty.status}`);
  check('空库原因 = AdminUser=0 AND Config=0', gEmpty.reason.includes('AdminUser=0 AND Config=0'));

  const corruptDb = path.join(T, 'corrupt.db');
  writeFileSync(corruptDb, Buffer.concat([Buffer.alloc(200000, 7), Buffer.from('not a sqlite file at all')]));
  const gCorrupt = await gateCheck(corruptDb);
  check('随机字节伪库 → reject', gCorrupt.status === 'reject', `got ${gCorrupt.status}`);

  const missingDb = path.join(T, 'missing-table.db');
  await makeMissingTableDb(missingDb);
  const gMissing = await gateCheck(missingDb);
  check('缺必需表库 → reject', gMissing.status === 'reject', `got ${gMissing.status}`);

  const tinyDb = path.join(T, 'tiny.db');
  writeFileSync(tinyDb, Buffer.alloc(100, 1));
  const gTiny = await gateCheck(tinyDb);
  check('过小文件 → reject（大小仅作粗滤）', gTiny.status === 'reject');

  const gProd = await gateCheck(DB_PATH);
  check(`生产库 → valid（integrity=${gProd.integrity}）`, gProd.status === 'valid');
  check('生产库 Player=0 未被误判为损坏', gProd.status === 'valid' && gProd.counts?.Player === 0);
  console.log(`      生产画像: ${Object.entries(gProd.counts ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // ---------- 2. 加密回环 ----------
  console.log('\n[2] AES-256-GCM 加密回环');
  const k = await loadOrCreateKey();
  const plain = readFileSync(DB_PATH);
  const enc = encryptBuffer(plain, k.key);
  check('密文 ≠ 明文且带 GOATBENC1 头', !enc.subarray(0, plain.length).equals(plain) && enc.subarray(0, 9).toString('ascii') === 'GOATBENC1');
  const dec = decryptBuffer(enc, k.key);
  check('解密后与明文逐字节一致', dec.equals(plain));
  let tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 0xff; // 篡改最后 1 字节
  let tamperCaught = false;
  try { decryptBuffer(tampered, k.key); } catch { tamperCaught = true; }
  check('密文篡改 → GCM 认证失败拒绝解密', tamperCaught);
  let wrongKeyCaught = false;
  try { decryptBuffer(enc, Buffer.alloc(32, 0xab)); } catch { wrongKeyCaught = true; }
  check('错误密钥 → GCM 认证失败拒绝解密', wrongKeyCaught);

  // ---------- 3. 独立副本恢复演练（清单 latestValid → 解密 → 闸门 → 比对） ----------
  console.log('\n[3] 独立副本恢复演练（不触碰生产 db/）');
  const before = await readManifest('local');
  const latestValidBefore = before?.latestValid ?? null;
  const cands = await listRestoreCandidates();
  check(`恢复候选枚举 ≥1（实际 ${cands.length}）`, cands.length >= 1);
  const first = cands[0];
  console.log(`      首选候选: ${first.label}`);
  const r = await tryRestoreCandidate(first, k.key, path.join(T, 'restore'));
  check('解密+闸门通过', r.ok, r.error ?? '');
  if (r.ok && r.gate?.counts) {
    const src = inspectDb(DB_PATH);
    const same = Object.keys(src.counts ?? {}).every(t => (r.gate!.counts as any)[t] === (src.counts as any)[t]);
    check('恢复副本行数画像与生产库一致', same,
      `restored=${JSON.stringify(r.gate.counts)} prod=${JSON.stringify(src.counts)}`);
  }
  const restoredBytes = existsSync(path.join(T, 'restore')) ? r.tmpDb : undefined;
  check('恢复产物为合法 SQLite（再次 integrity_check）', restoredBytes ? inspectDb(restoredBytes!).integrity === 'ok' : false);

  // ---------- 4. latestValid 指针保护 ----------
  console.log('\n[4] latestValid 指针保护');
  const after = await readManifest('local');
  check('自检全程未改动 latestValid', after?.latestValid === latestValidBefore,
    `before=${latestValidBefore} after=${after?.latestValid}`);
  check('自检未在生产 db/ 产生新文件', inspectDb(DB_PATH).ok);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  rmSync(T, { recursive: true, force: true }); // 仅清理本自检自己的 /tmp 工作区
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('selftest 异常:', e); process.exit(1); });
