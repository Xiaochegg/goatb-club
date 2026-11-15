import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { validateArchivePayload } from '@/lib/archive-guard';
import { NEVER_RETURN_KEYS } from '@/lib/config-guard';

// ============================================================
// 2026-11-09 撤销说明（管理员纠偏指令「我没让你冷却……我想保存的时候就导出」）：
//   上一批次把「5 分钟冷却」装在了手动恢复链路（缓存恢复/文件恢复）上，
//   导致管理员刚保存就无法立刻恢复（实战截图：红色拦截 toast）——
//   这是理解错误，本批整体拆除。
//   正确归属（同日管理员指令「自动保存才需要冷却」）：
//     - 手动动作（立即保存/导出/恢复）：管理员主动行为，永不拦截；
//     - 自动保存的「冷却」= 不得用空榜/坏状态顶掉好备份 ——
//       由 scripts/lib/backup-core.ts 闸门升级（空榜签名 → quarantine）
//       在备份执行体收口，与本路由无关。
//   exportedAt 保留为纯信息字段（确认弹窗展示存档时刻），不再参与任何拦截。
// ============================================================

// GET /api/v1/archive - Export full archive (admin only — contains operation logs)
// AUTH V2.0 安全修复专项（2026-11-11）：导出面封死——configs 输出前强制过滤
// 受保护键（session_secret），终审计 §7-G3 修复（原实现全表直出根密钥）。
// P0-1 修复（审计 2026-11-13，批示「执行全部」）：Player 导出改显式白名单投影——
//   原实现 findMany 全行直出，把 passwordHash / email / role / lastLoginAt /
//   sessionEpoch / mustChangePassword / disabledAt / passwordResetAt 八列全部
//   写进导出件（哈希可离线爆破，直接违反「不暴露敏感凭证」红线）。同一函数里
//   configs 有过滤、players 无，属封堵遗漏。导出面只保留榜单业务字段+
//   创建/更新时刻；恢复（POST）本就只消费这十个字段，导出收窄零连带。
//   角色同步收窄：导出件含全量操作日志，升格为 OWNER/ADMIN 专属（VIEWER 不再可导）。
//   敏感列白名单与恢复消费面对齐（见 POST：仅 name/avatarUrl/tiers/overrideScores/
//   stats/likes/emotionText + createdAt/updatedAt）。
const ARCHIVE_PLAYER_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  tiers: true,
  overrideScores: true,
  stats: true,
  likes: true,
  emotionText: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const players = await db.player.findMany({
      orderBy: { createdAt: 'desc' },
      select: ARCHIVE_PLAYER_SELECT,
    });
    const configs = (await db.config.findMany()).filter(
      (c) => !NEVER_RETURN_KEYS.has(c.key),
    );
    const logs = await db.operationLog.findMany({
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      players,
      configs,
      logs,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to export archive' }, { status: 500 });
  }
}

// POST /api/v1/archive - Restore from archive（管理员手动动作：随时可用，零冷却）
// AUTH V2.0 安全修复专项（2026-11-11）：①RBAC 升格——恢复为写操作，
// 限 OWNER/ADMIN（VIEWER 只读）；②恢复面封死——受保护键（session_secret）
// 跳过不写，绝不覆写根密钥（终审计 §7-G6 修复）。
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { players, configs } = body;

    // 导入有效性闸门（管理员指令 2026-11-10「导入也必须检测缓存是否有 KB，
    // 没 KB 的就直接弃用」）：结构 + 大小双判据，从缓存恢复/从文件恢复统一在此收口。
    const v = validateArchivePayload(body);
    if (!v.ok) {
      return NextResponse.json({ error: `存档内容无效，已弃用：${v.reason ?? '格式不符'}` }, { status: 400 });
    }

    if (!Array.isArray(players)) {
      return NextResponse.json({ error: 'Invalid archive format' }, { status: 400 });
    }

    // OPT-C：入参上限——恢复接口此前对 players 数组长度无约束（对比 import 500 /
    // batch-delete 200 都有 cap），超大 payload 会造成长时间串行写阻塞。
    if (players.length > 1000) {
      return NextResponse.json({ error: 'Max 1000 players per restore' }, { status: 400 });
    }

    // P3-26（审计 2026-11-13）：恢复失败行不再静默吞掉——计入 skipped 并
    // 保留失败原因（截断防膨胀），随响应与审计日志一并下发，管理员可对账
    // 「新增/更新/跳过」三数与存档时刻是否吻合。
    const results = {
      playersCreated: 0, playersUpdated: 0, configsSet: 0,
      playersSkipped: 0, configsSkipped: 0,
      skippedReasons: [] as string[],
    };
    const noteSkip = (what: string, name: string, err: unknown) => {
      results.playersSkipped++;
      if (results.skippedReasons.length < 10) {
        results.skippedReasons.push(`${what}:${String(name).slice(0, 32)}:${(err as Error)?.message?.slice(0, 80) ?? 'unknown'}`);
      }
    };

    // OPT-C：预载一次消除 N+1（原实现逐条 findUnique），
    // 写侧保持逐条（语义不变：单条失败跳过继续）。
    const restoreNames = players.map(p => String(p?.name ?? '')).filter(Boolean);
    const existingPlayers = restoreNames.length
      ? await db.player.findMany({ where: { name: { in: restoreNames } }, select: { id: true, name: true } })
      : [];
    const existingMap = new Map(existingPlayers.map(p => [p.name, p]));

    for (const p of players) {
      try {
        const existing = existingMap.get(String(p.name));
        if (existing) {
          await db.player.update({
            where: { id: existing.id },
            data: {
              avatarUrl: p.avatarUrl,
              tiers: p.tiers,
              overrideScores: p.overrideScores,
              stats: p.stats,
              likes: p.likes,
              emotionText: p.emotionText,
            },
          });
          results.playersUpdated++;
        } else {
          await db.player.create({
            data: {
              name: p.name,
              avatarUrl: p.avatarUrl,
              tiers: p.tiers || '{}',
              overrideScores: p.overrideScores || '{}',
              stats: p.stats || '{}',
              likes: p.likes || 0,
              emotionText: p.emotionText || null,
            },
          });
          results.playersCreated++;
        }
      } catch (err) {
        noteSkip('player', String(p?.name ?? '?'), err);
      }
    }

    // Restore configs
    if (Array.isArray(configs)) {
      for (const c of configs) {
        // 受保护键拒绝恢复写入（session_secret 只能由服务端自举管理）
        if (NEVER_RETURN_KEYS.has(String(c?.key ?? ''))) continue;
        try {
          await db.config.upsert({
            where: { key: c.key },
            update: { value: c.value },
            create: { key: c.key, value: c.value },
          });
          results.configsSet++;
        } catch (err) {
          results.configsSkipped++;
          if (results.skippedReasons.length < 10) {
            results.skippedReasons.push(`config:${String(c?.key ?? '?').slice(0, 32)}:${(err as Error)?.message?.slice(0, 80) ?? 'unknown'}`);
          }
        }
      }
    }

    await db.operationLog.create({
      data: {
        type: 'import',
        detail: `admin → archive restore · +${results.playersCreated}~${results.playersUpdated} players · ${results.configsSet} configs · skipped=${results.playersSkipped + results.configsSkipped} · 存档时刻=${typeof body?.exportedAt === 'string' ? body.exportedAt : '未知'}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to restore archive' }, { status: 500 });
  }
}
