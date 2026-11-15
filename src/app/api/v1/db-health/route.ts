// ============================================================
// GET  /api/v1/db-health —— 空库检测（管理员指令 2026-11-09「你都没检测到它空了」）
//   返回事实：playerCount / 最新一份「有效且含玩家」的备份 / 最近一次
//   空榜快照 / 提醒状态（alertSince / ackAt / alert）。
//   首次发现「0 玩家但存在含玩家备份」时：写 Config.db_empty_alert_since
//   + OperationLog 审计（每个空榜 episode 只写一次）；库恢复非空后自动复位，
//   下次再空重新提醒（部署/重启/崩溃后进数据页必见）。
// POST /api/v1/db-health —— { action: 'ack' }：管理员「忽略本次」
//   （写 Config.db_empty_alert_ack_at + 审计；恢复非空后提醒自动重新武装）。
// 权限：requireRole('OWNER', 'ADMIN')。
// 设计：纯事实输出，恢复动作本身仍走既有链路（从缓存恢复 = POST /api/v1/archive）；
//   服务器加密快照的恢复走运维脚本，本路由只负责「看见 + 提醒」。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const MANIFESTS = [
  path.join(PROJECT_ROOT, 'backups/LATEST-BACKUP-INFO.json'),
  path.join(PROJECT_ROOT, 'upload/goatb-backups/LATEST-BACKUP-INFO.json'),
];
const SINCE_KEY = 'db_empty_alert_since';
const ACK_KEY = 'db_empty_alert_ack_at';

interface ManifestEntry {
  file: string;
  encryptedAt: string;
  status: string;
  trigger?: string;
  playerCount: number;
}

interface GoodBackup { file: string; encryptedAt: string; playerCount: number; trigger?: string }

async function scanManifest(): Promise<{ newestGood: GoodBackup | null; lastEmpty: GoodBackup | null }> {
  const entries: ManifestEntry[] = [];
  for (const p of MANIFESTS) {
    try {
      if (!existsSync(p)) continue;
      const m = JSON.parse(await readFile(p, 'utf8'));
      if (m?.version !== 1 || !Array.isArray(m.backups)) continue;
      for (const b of m.backups) {
        if (!b?.file || !b?.encryptedAt) continue;
        entries.push({
          file: String(b.file),
          encryptedAt: String(b.encryptedAt),
          status: String(b.status ?? ''),
          trigger: b?.trigger ? String(b.trigger) : undefined,
          playerCount: Number(b?.sourceStats?.Player ?? 0),
        });
      }
    } catch { /* 清单损坏跳过该份 */ }
  }
  // 去重（双副本清单内容相同）：file 唯一化
  const seen = new Set<string>();
  const uniq = entries.filter(e => (seen.has(e.file) ? false : (seen.add(e.file), true)));
  const byTime = (a: ManifestEntry, b: ManifestEntry) => b.encryptedAt.localeCompare(a.encryptedAt);
  const good = uniq
    .filter(e => e.status === 'valid' && e.playerCount > 0)
    .sort(byTime)[0] ?? null;
  const empty = uniq
    .filter(e => e.playerCount === 0)
    .sort(byTime)[0] ?? null;
  return {
    newestGood: good ? { file: good.file, encryptedAt: good.encryptedAt, playerCount: good.playerCount, trigger: good.trigger } : null,
    lastEmpty: empty ? { file: empty.file, encryptedAt: empty.encryptedAt, playerCount: 0, trigger: empty.trigger } : null,
  };
}

async function readConfigValue(key: string): Promise<string | null> {
  try {
    const row = await db.config.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch { return null; }
}

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const playerCount = await db.player.count();
    const { newestGood, lastEmpty } = await scanManifest();

    const emptyEpisode = playerCount === 0 && !!newestGood;
    let alertSince = await readConfigValue(SINCE_KEY);

    if (emptyEpisode && !alertSince) {
      // 首次发现空榜且存在可回退的好备份：落提醒标记 + 审计（本 episode 只此一次）
      const now = new Date().toISOString();
      await db.config.upsert({
        where: { key: SINCE_KEY },
        update: { value: now },
        create: { key: SINCE_KEY, value: now },
      }).catch(() => {});
      alertSince = now;
      await db.operationLog.create({
        data: {
          type: 'info',
          detail: `db-health · 检测到空榜（0 玩家）但存在含玩家的有效备份：${newestGood!.file} @ ${newestGood!.encryptedAt} —— 请在 数据运维 页确认是否恢复`,
          scoreChange: null,
          adminKey: guard.admin.username,
        },
      }).catch(() => {});
    }

    if (playerCount > 0 && alertSince) {
      // 库已非空：复位 episode，下次再空重新提醒
      await db.config.delete({ where: { key: SINCE_KEY } }).catch(() => {});
      alertSince = null;
    }

    const ackAt = await readConfigValue(ACK_KEY);
    const alert = !!(emptyEpisode && alertSince && (!ackAt || ackAt < alertSince));

    return NextResponse.json({
      ok: true,
      playerCount,
      leaderboardEmpty: playerCount === 0,
      newestGoodBackup: newestGood,
      lastEmptySnapshot: lastEmpty,
      alertSince,
      ackAt,
      alert,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `读取数据库健康状态失败: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}

interface DbHealthPostBody { action?: 'ack' }

export async function POST(req: Request) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  let body: DbHealthPostBody | null = null;
  try { body = await req.json() as DbHealthPostBody; } catch { body = null; }

  if (body?.action !== 'ack') {
    return NextResponse.json({ ok: false, error: '未知操作' }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();
    await db.config.upsert({
      where: { key: ACK_KEY },
      update: { value: now },
      create: { key: ACK_KEY, value: now },
    });
    await db.operationLog.create({
      data: {
        type: 'info',
        detail: 'db-health · 管理员确认忽略本次空榜提醒（恢复非空后提醒会自动重新武装）',
        scoreChange: null,
        adminKey: guard.admin.username,
      },
    }).catch(() => {});
    return NextResponse.json({ ok: true, ackAt: now });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `确认操作失败: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
