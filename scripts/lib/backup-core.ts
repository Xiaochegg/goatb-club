// ============================================================
// GOATB 备份核心模块（2026-11-04 沙盒持久化修复）
// ============================================================
// 设计要点（对应 docs/tier-command-sandbox-audit.md 第四节）：
//   1. 三层存储：rootfs（非持久） / upload/goatb-backups（OSS 持久）
//   2. 备份强制 AES-256-GCM 加密后才可上 OSS；密钥独立存放
//      （upload/goatb-keys/，与备份不同目录），并有明确恢复机制
//   3. 有效性闸门：不得仅凭大小 —— integrity_check + 7 必需表
//      + Schema fingerprint + 行数画像
//   4. 空库（AdminUser=0 且 Config=0 等全空特征）→ quarantine，
//      2026-11-09 追加（管理员实战教训「你都没检测到它空了」）：
//      空榜签名（Player=0 但 AdminUser/Config 已配置）也 → quarantine，
//      绝不顶替最后一份有效备份（自动保存的「冷却」= 不许空榜顶好备份）
//      绝不允许覆盖/顶替最后一份有效备份
//   5. 不依赖 OSSFS rename 原子性：唯一时间戳文件名 +
//      LATEST-BACKUP-INFO.json 清单指定最新有效备份
//   6. SHA-256 写后回读校验（防 FUSE 异步上云窗口）
// ============================================================

import { Database } from 'bun:sqlite';
import {
  createHash, randomBytes, createCipheriv, createDecipheriv,
} from 'node:crypto';
// 自动存档停机标记（管理员指令 2026-11-10「没KB就停止保存，拒绝5分钟请求，
// 等待管理员核实自动关闭」）—— 纯 node:fs 双运行时模块
import { readAutosaveHalt, writeAutosaveHalt, clearAutosaveHalt } from './autosave-halt';
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync, readdirSync,
  openSync, writeSync, closeSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import {
  readFile, writeFile, mkdir, readdir, rename, rm,
} from 'node:fs/promises';
import path from 'path';

// ---------- 路径常量 ----------
export const PROJECT_ROOT = process.cwd();
export const DB_PATH = path.join(PROJECT_ROOT, 'db/custom.db');
export const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
export const UPLOAD_BACKUP_DIR = path.join(PROJECT_ROOT, 'upload/goatb-backups');
export const UPLOAD_KEY_DIR = path.join(PROJECT_ROOT, 'upload/goatb-keys');
export const LOCAL_KEY_DIR = '/home/z/goatb-keys'; // 项目外便利镜像（rootfs 非持久）
export const WORK_DIR = '/tmp/goatb-backup-work';
export const KEY_FILE_NAME = 'backup-secret.key';
export const INFO_FILE_NAME = 'LATEST-BACKUP-INFO.json';
export const ALERT_FILE = path.join(PROJECT_ROOT, 'db/DATA-LOSS-ALERT.txt');

export const MAGIC = Buffer.from('GOATBENC1', 'ascii'); // 9 字节文件头
export const IV_LEN = 12;
export const TAG_LEN = 16; // GCM authTag 固定 128-bit
// 密文布局：MAGIC(MAGIC.length) + iv(IV_LEN) + tag(TAG_LEN) + ciphertext
export const REQUIRED_TABLES = [
  'Player', 'AdminUser', 'Config', 'OperationLog', 'Season', 'RankSnapshot', 'ApiKey',
];
// 大小仅作粗滤（截断/损坏文件），有效性判定绝不依赖大小
export const MIN_DB_BYTES = 16 * 1024;

// ---------- 小工具 ----------
export function sha256Hex(buf: Buffer | ArrayBuffer): string {
  return createHash('sha256').update(buf as any).digest('hex');
}

function tsName(prefix = 'custom', ext = 'db.enc'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // 含毫秒：保证任意两次备份文件名唯一（不依赖 rename，同名即隐患）
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${prefix}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}.${ext}`;
}

// ---------- 密钥管理 ----------
export interface BackupKey { key: Buffer; fingerprint: string; source: string }

export async function loadOrCreateKey(): Promise<BackupKey> {
  const tryRead = async (p: string): Promise<Buffer | null> => {
    try {
      if (!existsSync(p)) return null;
      const raw = (await readFile(p)).toString().trim();
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === 32) return buf;
      return null;
    } catch { return null; }
  };

  const ossKey = path.join(UPLOAD_KEY_DIR, KEY_FILE_NAME);
  const localKey = path.join(LOCAL_KEY_DIR, KEY_FILE_NAME);

  // 权威源：OSS（跨容器持久）；本地镜像仅作便利兜底
  let key = await tryRead(ossKey);
  let source = 'oss';
  if (!key) {
    key = await tryRead(localKey);
    source = 'local-mirror';
  }
  if (!key) {
    key = randomBytes(32);
    source = 'newly-generated';
  }

  // 双写持久化（幂等；已存在的密钥绝不覆盖）
  try {
    await mkdir(UPLOAD_KEY_DIR, { recursive: true });
    if (!existsSync(ossKey)) {
      await writeFile(ossKey, key.toString('hex') + '\n', { mode: 0o600 });
      chmodSync(ossKey, 0o600);
    }
  } catch { /* OSS 不可写时由调用方告警 */ }
  try {
    await mkdir(LOCAL_KEY_DIR, { recursive: true });
    if (!existsSync(localKey)) {
      await writeFile(localKey, key.toString('hex') + '\n', { mode: 0o600 });
      chmodSync(localKey, 0o600);
    }
  } catch { /* 本地镜像失败不致命 */ }

  const fingerprint = sha256Hex(key).slice(0, 12);
  return { key, fingerprint, source };
}

// ---------- 数据库体检 / 有效性闸门 ----------
export interface DbStats {
  ok: boolean;
  error?: string;
  integrity?: string;
  tables?: string[];
  counts?: Record<string, number>;
  schemaFingerprint?: string; // sqlite_master 结构 hash
  bytes?: number;
}

export function inspectDb(dbPath: string): DbStats {
  try {
    if (!existsSync(dbPath)) return { ok: false, error: 'file not found' };
    const bytes = statSync(dbPath).size;
    if (bytes < MIN_DB_BYTES) return { ok: false, error: `too small (${bytes}B)`, bytes };

    const db = new Database(dbPath, { readonly: true, create: false });
    try {
      const integrity = (db.query('PRAGMA integrity_check').get() as any)?.integrity_check;
      if (integrity !== 'ok') return { ok: false, integrity, error: `integrity_check=${integrity}`, bytes };

      const tables = (db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
      ).all() as { name: string }[]).map(r => r.name);

      const counts: Record<string, number> = {};
      for (const t of REQUIRED_TABLES) {
        if (!tables.includes(t)) return { ok: false, integrity, tables, error: `missing table: ${t}`, bytes };
        counts[t] = (db.query(`SELECT COUNT(*) as c FROM "${t}"`).get() as any).c;
      }
      // Schema fingerprint：sqlite_master 全部结构定义的 SHA-256
      const schemaRows = db.query(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as { name: string; sql: string }[];
      const schemaFingerprint = sha256Hex(Buffer.from(JSON.stringify(schemaRows)));

      return { ok: true, integrity, tables, counts, schemaFingerprint, bytes };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type GateStatus = 'valid' | 'quarantine' | 'reject';
export interface GateResult extends DbStats {
  status: GateStatus;
  reason: string;
  schemaFileHash?: string; // prisma/schema.prisma 的 SHA-256（清单记录用）
}

async function schemaFileHash(): Promise<string | undefined> {
  try {
    const p = path.join(PROJECT_ROOT, 'prisma/schema.prisma');
    if (!existsSync(p)) return undefined;
    return sha256Hex(await readFile(p));
  } catch { return undefined; }
}

/**
 * 闸门判定：
 *  - reject：打不开 / integrity!=ok / 必需表缺失 / 过小 —— 不产生任何备份
 *  - quarantine：
 *      a) 全空特征（AdminUser=0 且 Config=0）；
 *      b) 空榜签名（Player=0 且 AdminUser/Config 已配置）——
 *         2026-11-09 升级（管理员指令「你都没检测到它空了……自动保存才需要冷却」）：
 *         旧版只认全空特征，导致 12:16 进页即存把 0 玩家空榜存成 valid 并顶掉
 *         latestValid —— 对排行榜应用而言 0 玩家就是丢榜信号；空榜快照仍存档
 *         （不丢弃事实）但绝不顶替最后一份有效备份。
 *         若管理员是有意清榜重开：空榜状态本无数据可备，且随时可用运维脚本
 *         恢复任一份历史备份，故此判定无副作用。
 *  - valid：其余全部通过
 */
export async function gateCheck(dbPath: string): Promise<GateResult> {
  const s = inspectDb(dbPath);
  const base: GateResult = { ...s, status: 'reject', reason: '', schemaFileHash: await schemaFileHash() };
  if (!s.ok) {
    base.reason = s.error ?? 'inspect failed';
    return base;
  }
  const c = s.counts!;
  if ((c.AdminUser ?? 0) === 0 && (c.Config ?? 0) === 0) {
    base.status = 'quarantine';
    base.reason = 'empty-db signature (AdminUser=0 AND Config=0)';
    return base;
  }
  // 空榜签名（2026-11-09 升级）：有管理员/配置但 0 玩家 —— 不作为有效备份顶掉好快照
  if ((c.Player ?? 0) === 0 && ((c.AdminUser ?? 0) > 0 || (c.Config ?? 0) > 0)) {
    base.status = 'quarantine';
    base.reason = `leaderboard-empty signature (Player=0, AdminUser=${c.AdminUser ?? 0}, Config=${c.Config ?? 0})`;
    return base;
  }
  base.status = 'valid';
  base.reason = 'gate passed';
  return base;
}

// ---------- 快照 / 加密 / 解密 ----------
/** VACUUM INTO 一致性快照（在线、不锁库、不碰源内容） */
export function vacuumSnapshot(srcDbPath: string, destTmpPath: string): void {
  if (existsSync(destTmpPath)) rm(destTmpPath, { force: true });
  const ro = new Database(srcDbPath, { readonly: true, create: false });
  try {
    ro.run(`VACUUM INTO '${destTmpPath}'`);
  } finally {
    ro.close();
  }
}

/** AES-256-GCM。输出布局：MAGIC(8) + iv(12) + authTag(16) + ciphertext */
export function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

export function decryptBuffer(enc: Buffer, key: Buffer): Buffer {
  const hLen = MAGIC.length;
  if (enc.length < hLen + IV_LEN + TAG_LEN || !enc.subarray(0, hLen).equals(MAGIC)) {
    throw new Error('not a GOATBENC1 backup file');
  }
  const iv = enc.subarray(hLen, hLen + IV_LEN);
  const tag = enc.subarray(hLen + IV_LEN, hLen + IV_LEN + TAG_LEN);
  const ct = enc.subarray(hLen + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export async function decryptToFile(encPath: string, outPath: string, key: Buffer): Promise<void> {
  const enc = await readFile(encPath);
  const plain = decryptBuffer(enc, key);
  await writeFile(outPath, plain);
}

// ---------- 上传 + SHA-256 写后回读校验 ----------
export interface UploadVerify { ok: boolean; sha256?: string; error?: string }

export async function uploadWithVerify(localPath: string, destPath: string): Promise<UploadVerify> {
  try {
    const localBuf = await readFile(localPath);
    const localHash = sha256Hex(localBuf);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, localBuf);
    // 写后回读：重新从目标读出并比对 SHA-256
    const readBack = await readFile(destPath);
    const readBackHash = sha256Hex(readBack);
    if (localHash !== readBackHash) {
      return { ok: false, sha256: localHash, error: `readback mismatch (local=${localHash.slice(0, 12)} oss=${readBackHash.slice(0, 12)})` };
    }
    return { ok: true, sha256: localHash };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- 完整性清单 ----------
export interface ManifestEntry {
  file: string;
  sha256: string;
  sizeBytes: number;
  encryptedAt: string;
  algorithm: 'aes-256-gcm';
  keyFingerprint: string;
  schemaFingerprint?: string;   // sqlite_master 结构 hash
  schemaFileHash?: string;      // prisma/schema.prisma hash
  sourceStats?: Record<string, number>;
  integrity?: string;
  status: 'valid' | 'quarantine';
  reason?: string;
  ossVerified?: boolean;        // OSS 回读校验结果
  trigger?: string;             // 触发源（hourly/auto-5min/page-enter/auto-on/manual）；旧条目无此字段
}
export interface Manifest {
  version: 1;
  updatedAt: string;
  keyFingerprint: string;
  latestValid: string | null;   // 指针（唯一权威，不依赖 rename）
  backups: ManifestEntry[];
}

export function manifestPath(scope: 'local' | 'oss'): string {
  return scope === 'local'
    ? path.join(BACKUP_DIR, INFO_FILE_NAME)
    : path.join(UPLOAD_BACKUP_DIR, INFO_FILE_NAME);
}

export async function readManifest(scope: 'local' | 'oss'): Promise<Manifest | null> {
  try {
    const p = manifestPath(scope);
    if (!existsSync(p)) return null;
    const m = JSON.parse(await readFile(p, 'utf8')) as Manifest;
    if (m?.version !== 1) return null;
    return m;
  } catch { return null; }
}

/** 清单双写：本地用 rename（原子）；OSS 直接覆盖写（无原子性保证，失败则告警保留旧清单） */
export async function writeManifest(m: Manifest): Promise<{ local: boolean; oss: boolean }> {
  m.updatedAt = new Date().toISOString();
  const text = JSON.stringify(m, null, 2);
  let local = false, oss = false;
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const tmp = manifestPath('local') + '.tmp';
    await writeFile(tmp, text);
    await rename(tmp, manifestPath('local'));
    local = true;
  } catch { /* 保留旧清单 */ }
  try {
    await mkdir(UPLOAD_BACKUP_DIR, { recursive: true });
    await writeFile(manifestPath('oss'), text);
    oss = true;
  } catch { /* 保留旧清单 */ }
  if (!local || !oss) {
    console.warn(`⚠ [manifest] 清单写入不完整（local=${local} oss=${oss}）—— 以可写的一份为准，恢复端会双源核对`);
  }
  return { local, oss };
}

/** 合并两份清单（OSS 与本地可能有一份滞后）：按 file 去重，取信息更全者 */
export function mergeManifests(a: Manifest | null, b: Manifest | null): Manifest | null {
  if (!a) return b;
  if (!b) return a;
  const byFile = new Map<string, ManifestEntry>();
  for (const e of [...a.backups, ...b.backups]) {
    const prev = byFile.get(e.file);
    if (!prev || Object.keys(e).length > Object.keys(prev).length) byFile.set(e.file, e);
  }
  const latest = a.updatedAt >= b.updatedAt ? a : b;
  return {
    version: 1,
    updatedAt: latest.updatedAt,
    keyFingerprint: latest.keyFingerprint,
    latestValid: latest.latestValid,
    backups: [...byFile.values()].sort((x, y) => (x.file < y.file ? 1 : -1)),
  };
}

// ---------- 主备份流程 ----------
export interface BackupOutcome {
  ran: boolean;
  status: 'valid' | 'quarantine' | 'reject' | 'error';
  file?: string;
  sha256?: string;
  ossVerified?: boolean;
  reason?: string;
  stats?: Record<string, number>;
}

export async function runBackup(opts: { quiet?: boolean; trigger?: string } = {}): Promise<BackupOutcome> {
  const log = (...a: any[]) => { if (!opts.quiet) console.log(...a); };
  const trigger = opts.trigger ?? 'hourly';
  try {
    if (!existsSync(DB_PATH)) {
      return { ran: false, status: 'error', reason: `source db not found: ${DB_PATH}` };
    }

    // 1) 源库闸门
    const gate = await gateCheck(DB_PATH);
    if (gate.status === 'reject') {
      log(`✗ [backup] 源库未过闸门，拒绝备份：${gate.reason}`);
      // 自动存档停机（2026-11-10）：内容被侵犯（损坏/过小/缺表）→ 停机等管理员核实
      haltAutosaveOnInvalid(trigger, 'reject', gate.reason, gate.counts ?? null);
      return { ran: true, status: 'reject', reason: gate.reason };
    }
    if (gate.status === 'quarantine') {
      log(`⚠ [backup] 源库为空库特征（${gate.reason}）—— 将进入隔离区，绝不顶替最后一份有效备份`);
    }

    // 2) 密钥
    const k = await loadOrCreateKey();
    log(`🔑 [backup] 密钥就绪 fingerprint=${k.fingerprint} source=${k.source}`);

    // 3) VACUUM INTO 一致性快照 → 工作目录
    await mkdir(WORK_DIR, { recursive: true });
    const name = tsName();
    const snapTmp = path.join(WORK_DIR, name.replace(/\.enc$/, ''));
    vacuumSnapshot(DB_PATH, snapTmp);

    // 4) 快照复核闸门（快照必须与源库判定一致）
    const snapGate = await gateCheck(snapTmp);
    if (snapGate.status === 'reject') {
      await rm(snapTmp, { force: true });
      log(`✗ [backup] 快照复核未通过（${snapGate.reason}），放弃本次备份（既有备份未受影响）`);
      return { ran: true, status: 'reject', reason: `snapshot gate: ${snapGate.reason}` };
    }
    const finalStatus = gate.status === 'quarantine' || snapGate.status === 'quarantine'
      ? 'quarantine' : 'valid';

    // 自动存档停机（2026-11-10）：隔离区签名 = 内容被侵犯（空库/空榜）→ 停机等核实
    if (finalStatus === 'quarantine') {
      haltAutosaveOnInvalid(trigger, 'quarantine', snapGate.reason || gate.reason, snapGate.counts ?? null);
    }
    // 停机自动关闭路径 b：管理员手动保存产出有效备份 = 核实通过（自动关闭）
    if (trigger === 'manual' && finalStatus === 'valid' && readAutosaveHalt()) {
      clearAutosaveHalt();
      log(`✅ [backup] 手动有效备份核实通过 → 自动存档停机自动关闭`);
    }

    // 5) 加密
    const plain = await readFile(snapTmp);
    const enc = encryptBuffer(plain, k.key);
    const encName = name;
    const localEnc = path.join(BACKUP_DIR, encName);
    await mkdir(BACKUP_DIR, { recursive: true });
    await writeFile(localEnc, enc);
    const encHash = sha256Hex(enc);

    // 6) OSS 上传 + 回读校验
    const ossEnc = path.join(UPLOAD_BACKUP_DIR, encName);
    const up = await uploadWithVerify(localEnc, ossEnc);
    if (!up.ok) {
      console.warn(`⚠ [backup] OSS 副本写入/回读失败：${up.error}（本地副本 ${encName} 已保留，SHA256=${encHash.slice(0, 12)}）`);
    } else {
      log(`☁️  [backup] OSS 回读校验一致 SHA256=${up.sha256!.slice(0, 12)}…`);
    }

    // 7) 清单更新（quarantine 绝不改写 latestValid）
    const localM = await readManifest('local');
    const ossM = await readManifest('oss');
    const m = mergeManifests(localM, ossM) ?? {
      version: 1 as const, updatedAt: '', keyFingerprint: k.fingerprint,
      latestValid: null as string | null, backups: [],
    };
    if (m.keyFingerprint && m.keyFingerprint !== k.fingerprint) {
      console.warn(`⚠ [backup] 密钥 fingerprint 变化（清单=${m.keyFingerprint} 当前=${k.fingerprint}）——请人工核对 goatb-keys 目录！`);
    }
    m.keyFingerprint = k.fingerprint;
    m.backups.unshift({
      file: encName,
      sha256: encHash,
      sizeBytes: enc.length,
      encryptedAt: new Date().toISOString(),
      algorithm: 'aes-256-gcm',
      keyFingerprint: k.fingerprint,
      schemaFingerprint: snapGate.schemaFingerprint,
      schemaFileHash: snapGate.schemaFileHash,
      sourceStats: snapGate.counts,
      integrity: snapGate.integrity,
      status: finalStatus,
      reason: snapGate.reason,
      ossVerified: up.ok,
      trigger,
    });
    if (finalStatus === 'valid') {
      m.latestValid = encName;
    }
    // 7.5) 自动快照家族限额（管理员开关开启后每 5 分钟一份，必须封顶防无限增长）：
    //      仅限 trigger ∈ {auto-5min, page-enter, auto-on} 的条目；
    //      绝不触碰 latestValid / 手动 / 小时例行备份；仅删除 OSS 已回读校验的副本。
    await pruneAutoBackups(m);
    const w = await writeManifest(m);
    log(`📋 [backup] 清单已更新 latestValid=${m.latestValid}（local=${w.local} oss=${w.oss}）`);

    // 8) 清理本次工作临时文件 + 本地旧备份轮换（只删清单内且 OSS 已校验的旧文件）
    await rm(snapTmp, { force: true });
    await rotateLocalBackups(m, up.ok);

    log(`✅ [backup] 完成：${encName} status=${finalStatus} Player=${snapGate.counts?.Player} AdminUser=${snapGate.counts?.AdminUser} Config=${snapGate.counts?.Config}`);
    return {
      ran: true, status: finalStatus, file: encName, sha256: encHash,
      ossVerified: up.ok, reason: snapGate.reason, stats: snapGate.counts,
    };
  } catch (e) {
    return { ran: true, status: 'error', reason: (e as Error).message };
  }
}

/** 本地轮换：保留最近 MAX_LOCAL_BACKUPS 份；只删除「已存在于清单且 OSS 副本已校验」的旧加密备份 */
const MAX_LOCAL_BACKUPS = 24;
async function rotateLocalBackups(m: Manifest, ossHealthy: boolean): Promise<void> {
  try {
    if (!ossHealthy) {
      console.warn('⚠ [rotate] OSS 不可用，跳过本地轮换（避免删除唯一副本）');
      return;
    }
    const entries = m.backups.filter(b => b.status === 'valid' || b.status === 'quarantine');
    const excess = entries.slice(MAX_LOCAL_BACKUPS);
    for (const e of excess) {
      if (!e.ossVerified) continue; // OSS 未确认的绝不删
      const p = path.join(BACKUP_DIR, e.file);
      if (existsSync(p)) await rm(p, { force: true });
    }
  } catch { /* 轮换失败不影响备份结果 */ }
}

// ---------- 自动快照家族限额（管理员开关 2026-11-09「写一个开关…5分钟」） ----------
const MAX_AUTO_BACKUPS = 48;                       // 5 分钟档 × 48 ≈ 4 小时滚动覆盖
const AUTO_TRIGGER_FAMILY = new Set(['auto-5min', 'page-enter', 'auto-on']);

/** 自动存档停机（管理员指令 2026-11-10）：自动家族触发且内容被侵犯 → 写停机标记。
 *  手动（manual）/每小时例行（hourly）永不停机、永不拦截（既有裁定不变）。 */
function haltAutosaveOnInvalid(trigger: string, gateStatus: 'reject' | 'quarantine', reason: string, counts: Record<string, number> | null): void {
  try {
    if (!AUTO_TRIGGER_FAMILY.has(trigger)) return;
    writeAutosaveHalt({ gateStatus, reason, counts, trigger, at: new Date().toISOString() });
    console.log(`🛑 [backup] 自动存档已停机（${gateStatus}）：${reason} —— 后续 5 分钟自动保存请求将被拒绝，等待管理员核实`);
  } catch { /* 停机标记失败不影响备份本体；下一轮闸门会再次判定 */ }
}

/** 只清理自动家族超额旧份：latestValid / 手动 / 小时例行 / OSS 未校验的绝不删 */
async function pruneAutoBackups(m: Manifest): Promise<void> {
  try {
    const isAuto = (e: ManifestEntry) => !!e.trigger && AUTO_TRIGGER_FAMILY.has(e.trigger);
    const autoEntries = m.backups.filter(isAuto); // backups[0] 为最新
    if (autoEntries.length <= MAX_AUTO_BACKUPS) return;
    const removed = new Set<string>();
    for (const e of autoEntries.slice(MAX_AUTO_BACKUPS)) {
      if (e.file === m.latestValid) continue;   // 权威指针永不删
      if (!e.ossVerified) continue;             // OSS 未确认的绝不删
      removed.add(e.file);
      await rm(path.join(UPLOAD_BACKUP_DIR, e.file), { force: true });
      await rm(path.join(BACKUP_DIR, e.file), { force: true });
    }
    if (removed.size) {
      m.backups = m.backups.filter(b => !removed.has(b.file));
      console.log(`🧹 [backup] 自动快照轮换：清理 ${removed.size} 份超限旧份（自动家族保留最近 ${MAX_AUTO_BACKUPS} 份）`);
    }
  } catch { /* 限额失败不影响备份本体 */ }
}

// ---------- 恢复辅助（供 ensure-db / 演练使用） ----------
export interface RestoreCandidate {
  kind: 'manifest-enc' | 'enum-enc-local' | 'enum-enc-oss' | 'plain-legacy';
  path: string;
  label: string;
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** 枚举全部恢复候选（清单优先，其次目录枚举，最后兼容旧明文快照） */
export async function listRestoreCandidates(): Promise<RestoreCandidate[]> {
  const out: RestoreCandidate[] = [];
  const m = mergeManifests(await readManifest('local'), await readManifest('oss'));
  if (m?.latestValid) {
    const localP = path.join(BACKUP_DIR, m.latestValid);
    const ossP = path.join(UPLOAD_BACKUP_DIR, m.latestValid);
    if (existsSync(localP)) out.push({ kind: 'manifest-enc', path: localP, label: `manifest:${m.latestValid}(local)` });
    else if (existsSync(ossP)) out.push({ kind: 'manifest-enc', path: ossP, label: `manifest:${m.latestValid}(oss)` });
  }
  try {
    if (existsSync(BACKUP_DIR)) {
      const files = (await readdir(BACKUP_DIR)).filter(f => f.endsWith('.db.enc')).sort().reverse();
      for (const f of files) {
        const p = path.join(BACKUP_DIR, f);
        if (!out.some(c => c.path === p)) out.push({ kind: 'enum-enc-local', path: p, label: `local:${f}` });
      }
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(UPLOAD_BACKUP_DIR)) {
      const files = (await readdir(UPLOAD_BACKUP_DIR)).filter(f => f.endsWith('.db.enc')).sort().reverse();
      for (const f of files) {
        const p = path.join(UPLOAD_BACKUP_DIR, f);
        if (!out.some(c => c.path === p)) out.push({ kind: 'enum-enc-oss', path: p, label: `oss:${f}` });
      }
    }
  } catch { /* ignore */ }
  // 旧版明文兼容（历史遗留快照）
  const legacy: string[] = [];
  const legacyLatest = path.join(BACKUP_DIR, 'db-snapshot-latest.db');
  if (existsSync(legacyLatest)) legacy.push(legacyLatest);
  for (const f of readdirSyncSafe(BACKUP_DIR)) {
    if (f.startsWith('custom-') && f.endsWith('.db')) legacy.push(path.join(BACKUP_DIR, f));
  }
  legacy.sort().reverse();
  for (const p of legacy) {
    if (!out.some(c => c.path === p)) out.push({ kind: 'plain-legacy', path: p, label: `legacy:${path.basename(p)}` });
  }
  return out;
}

/**
 * 从单个候选恢复：解密（若为加密备份）→ 闸门 → 返回明文临时文件路径。
 * 调用方负责把该文件复制到目标位置。本函数绝不直接触碰生产 db/。
 */
export async function tryRestoreCandidate(c: RestoreCandidate, key: Buffer, workDir = WORK_DIR): Promise<{ ok: boolean; tmpDb?: string; gate?: GateResult; error?: string }> {
  try {
    await mkdir(workDir, { recursive: true });
    const outName = `restore-${path.basename(c.path).replace(/\.enc$/, '')}`;
    const outPath = path.join(workDir, outName);
    if (c.kind === 'plain-legacy') {
      copyFileSync(c.path, outPath);
    } else {
      await decryptToFile(c.path, outPath, key);
    }
    const g = await gateCheck(outPath);
    if (g.status === 'reject') {
      await rm(outPath, { force: true });
      return { ok: false, gate: g, error: `gate reject: ${g.reason}` };
    }
    return { ok: true, tmpDb: outPath, gate: g };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ============================================================
// 跨进程互斥锁 + 恢复暂停标记（2026-11-05 值守架构升级）
// ============================================================
// 锁与暂停标记放 /tmp（tmpfs）——实测 ossfs（upload/ 挂载）对
// 「新建文件」存在 ~60s 目录项缓存盲区，跨进程互斥不可依赖；
// /tmp 同容器内即时可见，容器重置时随 /tmp 清空（天然除陈锁）。
// 备份本体 / 清单 / 状态文件仍在 OSS 持久层（覆写已存在文件，可见）。
//   - 锁内容含 pid + bootId + acquiredAt：进程死亡 / 容器重置后
//     可被安全夺取（pid 不存在、bootId 不同、或超时）
// ============================================================

export const BACKUP_LOCK_FILE = '/tmp/goatb-backup.lock';
export const BACKUP_PAUSE_FILE = '/tmp/goatb-backup-paused.json';
/** 锁超过此时长视为陈旧可夺取（备份子进程上限 180s，留足余量） */
export const BACKUP_LOCK_STALE_MS = 300_000;
/** protect-db 退出码：3 = 他方持锁（busy）；4 = 备份已暂停（恢复/维护中） */
export const BACKUP_BUSY_EXIT = 3;
export const BACKUP_PAUSED_EXIT = 4;

export interface LockPayload { pid: number; holder: string; acquiredAt: string; bootId: string }

export function hostBootId(): string {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unknown'; }
}

/** 探测进程是否存活（kill 0 信号探针） */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------- 暂停标记（恢复期间备份必须避让） ----------
export function isBackupPaused(): boolean {
  return existsSync(BACKUP_PAUSE_FILE);
}

export function readPauseReason(): string | null {
  try {
    const j = JSON.parse(readFileSync(BACKUP_PAUSE_FILE, 'utf8')) as { reason?: string };
    return j?.reason ?? 'paused';
  } catch {
    return isBackupPaused() ? 'paused' : null;
  }
}

export async function writePauseMarker(reason: string, by: string): Promise<void> {
  await mkdir(UPLOAD_BACKUP_DIR, { recursive: true });
  await writeFile(
    BACKUP_PAUSE_FILE,
    JSON.stringify({ reason, by, at: new Date().toISOString() }, null, 2),
  );
}

export async function clearPauseMarker(): Promise<void> {
  try { await rm(BACKUP_PAUSE_FILE, { force: true }); } catch { /* ignore */ }
}

// ---------- 独占备份锁（O_EXCL 原子创建 + 死进程/陈旧夺取） ----------
export function acquireBackupLockSync(holder: string): { ok: boolean; reason?: string } {
  try { mkdirSync('/tmp', { recursive: true }); } catch { /* /tmp 恒存在 */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(BACKUP_LOCK_FILE, 'wx'); // O_EXCL：原子性由内核保证
      const payload: LockPayload = {
        pid: process.pid,
        holder,
        acquiredAt: new Date().toISOString(),
        bootId: hostBootId(),
      };
      writeSync(fd, JSON.stringify(payload, null, 2));
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        return { ok: false, reason: `lock create failed: ${(e as Error).message}` };
      }
      // 已有锁：判定是否可安全夺取
      let prev: LockPayload | null = null;
      try { prev = JSON.parse(readFileSync(BACKUP_LOCK_FILE, 'utf8')) as LockPayload; } catch { /* 锁内容损坏 */ }
      let stale: boolean;
      let why: string;
      if (!prev) { stale = true; why = 'lock payload unreadable'; }
      else if (prev.bootId !== hostBootId()) { stale = true; why = `bootId changed (prev=${prev.bootId.slice(0, 8)})`; }
      else if (!pidAlive(prev.pid)) { stale = true; why = `holder pid=${prev.pid} dead`; }
      else if (Date.now() - Date.parse(prev.acquiredAt ?? '') > BACKUP_LOCK_STALE_MS) { stale = true; why = `held > ${BACKUP_LOCK_STALE_MS / 1000}s`; }
      else { stale = false; why = `held by pid=${prev.pid} (${prev.holder}) since ${prev.acquiredAt}`; }
      if (!stale) return { ok: false, reason: why };
      try { rmSync(BACKUP_LOCK_FILE, { force: true }); } catch {
        return { ok: false, reason: `stale lock steal failed (${why})` };
      }
      // 第二次循环用 O_EXCL 重新竞争
    }
  }
  return { ok: false, reason: 'backup lock contention after steal' };
}

export function releaseBackupLockSync(holder: string): void {
  try {
    const prev = JSON.parse(readFileSync(BACKUP_LOCK_FILE, 'utf8')) as LockPayload;
    // 只释放自己持有的锁；读不出归属时绝不删除（留给陈旧夺取逻辑处理）
    if (prev.pid === process.pid && prev.holder === holder) {
      rmSync(BACKUP_LOCK_FILE, { force: true });
    }
  } catch { /* 锁不存在或损坏：不动作 */ }
}

/** 心跳续锁：刷新锁文件 mtime（供长驻持有者证明自己活着） */
export function touchLock(holder: string): void {
  try { utimesSync(BACKUP_LOCK_FILE, new Date(), new Date()); } catch { /* ignore */ }
}
