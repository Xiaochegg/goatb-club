import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { ALL_MODES, NORMAL_TIERS, JIAHAO_TIERS, type GameMode, type Tier } from '@/lib/constants';
import { bustPlayerCaches } from '@/lib/cache';

// POST /api/v1/players/import - Batch import tiers from JSON
// AUTH V2.0 安全修复专项（2026-11-11）：批量写操作限 OWNER/ADMIN（VIEWER 只读）
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { mode, data } = body;

    if (!mode || !ALL_MODES.includes(mode as GameMode)) {
      return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ error: 'Data must be a non-empty array' }, { status: 400 });
    }

    if (data.length > 500) {
      return NextResponse.json({ error: 'Max 500 players per import' }, { status: 400 });
    }

    // 娱乐模式（嘉豪/小鸟）用 LZ/LL 段位表，其余用 HT/LT
    const validTiers = (mode === 'JIAHAO' || mode === 'BIRD') ? JIAHAO_TIERS : NORMAL_TIERS;
    const results = { created: 0, updated: 0, errors: 0 };

    // OPT-C：预载一次消除 N+1——原实现循环内逐条 findUnique（500 条 = 500 次串行读），
    // 现一次 findMany({ name: { in } }) + Map 查表；写侧保持逐条（SQLite 单写者，
    // 串行写最稳），单条失败仍按原语义计 errors 不中断。
    const names = data.map(i => String(i?.name ?? '')).filter(Boolean);
    const existingPlayers = names.length
      ? await db.player.findMany({ where: { name: { in: names } }, select: { id: true, name: true, tiers: true } })
      : [];
    const existingMap = new Map(existingPlayers.map(p => [p.name, p]));

    for (const item of data) {
      try {
        const { name, tier } = item;
        if (!name || !tier) { results.errors++; continue; }
        if (!validTiers.includes(tier as Tier)) { results.errors++; continue; }

        const existing = existingMap.get(String(name));

        if (existing) {
          const tiers = JSON.parse(existing.tiers || '{}');
          tiers[mode] = tier;
          await db.player.update({
            where: { id: existing.id },
            data: { tiers: JSON.stringify(tiers) },
          });
          results.updated++;
        } else {
          const tiers: Record<string, string> = {};
          tiers[mode] = tier;
          await db.player.create({
            data: {
              name: String(name),
              tiers: JSON.stringify(tiers),
              overrideScores: '{}',
              stats: '{}',
            },
          });
          results.created++;
        }
      } catch {
        results.errors++;
      }
    }

    await db.operationLog.create({
      data: {
        type: 'import',
        detail: `admin → import · mode=${mode} · +${results.created}~${results.updated}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Bulk player tier changes → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to import' }, { status: 500 });
  }
}
