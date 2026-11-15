import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 管理端总览
// GET /api/v1/admin/visual/overview
// ------------------------------------------------------------
// Player Selector 数据源：玩家列表（含视觉配置状态）+ 预设清单 +
// 全局默认配置。只读接口，VIEWER 及以上全部可用。
// ============================================================

export async function GET() {
  const guard = await requireRole('OWNER', 'ADMIN', 'MODERATOR', 'VIEWER');
  if (guard.response) return guard.response;

  try {
    const [players, presets, globalRow] = await Promise.all([
      db.player.findMany({
        select: {
          id: true, name: true, avatarUrl: true, updatedAt: true,
          tiers: true, visualConfig: {
            select: {
              enabled: true, status: true, version: true, presetId: true, updatedAt: true,
              preset: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.visualPreset.findMany({
        select: {
          id: true, name: true, description: true, isBuiltin: true,
          createdBy: true, updatedAt: true, _count: { select: { playerConfigs: true } },
        },
        orderBy: [{ isBuiltin: 'desc' }, { name: 'asc' }],
      }),
      db.config.findUnique({ where: { key: 'visual_global_default' } }),
    ]);

    return NextResponse.json({
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        avatarUrl: p.avatarUrl,
        updatedAt: p.updatedAt,
        tierSample: safeParse(p.tiers),
        visual: p.visualConfig
          ? {
              enabled: p.visualConfig.enabled,
              status: p.visualConfig.status,
              version: p.visualConfig.version,
              presetId: p.visualConfig.presetId,
              presetName: p.visualConfig.preset?.name ?? null,
              updatedAt: p.visualConfig.updatedAt,
            }
          : null,
      })),
      presets: presets.map(pr => ({
        id: pr.id,
        name: pr.name,
        description: pr.description,
        isBuiltin: pr.isBuiltin,
        createdBy: pr.createdBy,
        updatedAt: pr.updatedAt,
        assignedCount: pr._count.playerConfigs,
      })),
      globalDefault: globalRow ? safeParseGlobal(globalRow.value) : null,
    });
  } catch {
    return NextResponse.json({ error: '读取失败' }, { status: 500 });
  }
}

function safeParse(tiers: string): Record<string, string> {
  try { return JSON.parse(tiers) ?? {}; } catch { return {}; }
}
function safeParseGlobal(v: string): unknown {
  try { return JSON.parse(v); } catch { return null; }
}
