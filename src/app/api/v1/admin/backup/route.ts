// ============================================================
// GET  /api/v1/admin/backup —— 备份体系状态（调度器 + 清单摘要 + 自动存档开关）
// POST /api/v1/admin/backup —— 三种动作：
//   { action: 'set-auto-save', enabled: boolean }
//       自动存档开关（持久化 Config.auto_backup_enabled，默认关）。
//       开启时立即先存一份（trigger=auto-on），管理员立刻可见效果。
//       每次切换写审计日志（OperationLog）。
//   { action: 'run', source: 'page-enter' | 'manual' }
//       立即存档一次：进数据页自动触发（page-enter，前端 60s 节流）
//       或「立即保存」按钮（manual）。
//   { action: 'verify-autosave-halt' }
//       自动存档停机核实（2026-11-10）：清除停机标记，停机自动关闭；
//       若内容仍被侵犯，下一轮自动请求会重新停机（安全优先）。
//   （无 body / 旧调用）→ 等价 { action: 'run', source: 'manual' }。
// ============================================================
// 权限：requireRole('OWNER', 'ADMIN')。
// 设计：状态/触发主链路走文件与子进程（库异常也能手动备份）；
//       开关状态必须读 Config（唯一事实源，fail-safe：读不到=关）。
// 2026-11-09（管理员指令「写一个开关…你一开始就先给我关着 5分钟…我点进
// 那个数据的地方 它自己不等5分钟」）：真正每 5 分钟的服务器端自动存档
// 调度在 backup-keeper（每轮新鲜读 Config，无缓存）——本路由只负责
// 开关的读写与即时反馈。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  getAutoBackupStatus,
  triggerAutoBackup,
  readManifestSummary,
} from '@/lib/backup/auto-backup';
// 自动存档停机核实（管理员指令 2026-11-10）：纯 node:fs 双运行时模块
import { clearAutosaveHalt, readAutosaveHalt } from '../../../../../../scripts/lib/autosave-halt';

const AUTO_SAVE_CONFIG_KEY = 'auto_backup_enabled';

/** 开关唯一事实源：Config.auto_backup_enabled（'1'/'on' = 开；无行/异常 = 关） */
async function readAutoSaveFlag(): Promise<{ enabled: boolean; dbOk: boolean }> {
  try {
    const row = await db.config.findUnique({ where: { key: AUTO_SAVE_CONFIG_KEY } });
    return { enabled: row?.value === '1' || row?.value === 'on', dbOk: true };
  } catch {
    return { enabled: false, dbOk: false }; // fail-safe：读不到一律视为关
  }
}

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const status = await getAutoBackupStatus();
    const manifest = await readManifestSummary();
    const autoSave = await readAutoSaveFlag();
    return NextResponse.json({ ok: true, status, manifest, autoSave });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `读取备份状态失败: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}

interface BackupPostBody {
  action?: 'set-auto-save' | 'run' | 'verify-autosave-halt';
  enabled?: boolean;
  source?: string;
}

export async function POST(req: Request) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  let body: BackupPostBody | null = null;
  try { body = await req.json() as BackupPostBody; } catch { body = null; }

  try {
    // —— 自动存档停机核实（管理员指令 2026-11-10「等待管理员核实自动关闭」）——
    // 核实后停机自动关闭；若数据仍被侵犯，下一轮自动请求会重新停机（安全优先）。
    if (body?.action === 'verify-autosave-halt') {
      const halt = readAutosaveHalt();
      clearAutosaveHalt();
      await db.operationLog.create({
        data: {
          type: 'info',
          detail: `backup · 自动存档停机核实（管理员确认恢复）${halt ? ` · 原判定=${halt.gateStatus} · 原因=${halt.reason}` : ' · 当前无停机标记'}`,
          adminKey: guard.admin.username,
        },
      }).catch(() => {});
      return NextResponse.json({ ok: true, cleared: !!halt });
    }

    // —— 自动存档开关（持久化 Config，默认关；切换写审计）——
    if (body?.action === 'set-auto-save') {
      const enabled = body.enabled === true;
      await db.config.upsert({
        where: { key: AUTO_SAVE_CONFIG_KEY },
        update: { value: enabled ? '1' : '0' },
        create: { key: AUTO_SAVE_CONFIG_KEY, value: enabled ? '1' : '0' },
      });
      await db.operationLog.create({
        data: {
          type: 'info',
          detail: `backup · 自动存档开关 → ${enabled ? '开启' : '关闭'}（服务器端每 5 分钟快照，无需保持页面打开；开关持久化 Config.${AUTO_SAVE_CONFIG_KEY}）`,
          adminKey: guard.admin.username,
        },
      }).catch(() => {});
      // 开启即先存一份（trigger=auto-on）：管理员立刻看到效果，不等第一个 5 分钟
      const immediate = enabled ? await triggerAutoBackup('auto-on') : null;
      return NextResponse.json({ ok: true, enabled, immediate });
    }

    // —— 立即存档（进页自动 page-enter / 手动按钮 manual；无 body 兼容旧手动调用）——
    const source: 'page-enter' | 'manual' =
      body?.action === 'run' && body?.source === 'page-enter' ? 'page-enter' : 'manual';
    const rec = await triggerAutoBackup(source);
    if ('skipped' in rec && rec.skipped) {
      return NextResponse.json({ ok: false, skipped: true, reason: rec.reason }, { status: 409 });
    }
    const ok = !('outcome' in rec) || rec.outcome === 'valid';
    return NextResponse.json({ ok, record: rec }, { status: ok ? 200 : 500 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `备份操作失败: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
