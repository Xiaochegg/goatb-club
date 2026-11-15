import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { resolveFromJson } from '@/lib/visual/resolve';
import type { PublicVisualPayload } from '@/lib/visual/types';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 玩家侧公开读取
// GET /api/v1/visual/config?playerId=xxx
// ------------------------------------------------------------
// 返回该玩家【已发布生效】的视觉配置（三级继承解析后的完整视图）。
// 绝不返回：草稿（draftConfig）、审计、其他玩家的任何配置。
// 数据读取失败 → 安全回退默认配置（HTTP 200 + enabled:false 语义由
// 引擎端默认观感兜底，绝不 500 打挂玩家面板）。
// ============================================================

export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get('playerId') || '';
  if (!playerId || playerId.length > 64) {
    return NextResponse.json({ error: 'playerId 必填' }, { status: 400 });
  }

  try {
    const player = await db.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true },
    });
    if (!player) {
      return NextResponse.json({ error: '玩家不存在' }, { status: 404 });
    }

    const pvc = await db.playerVisualConfig.findUnique({
      where: { playerId },
      include: { preset: { select: { name: true, config: true } } },
    });

    // enabled=false 或无已发布配置 → 走继承链（preset/global），仍可全空
    const chain = pvc && pvc.enabled !== false
      ? resolveFromJson(
          await getGlobalJson(),
          pvc.preset?.config ?? null,
          pvc.status === 'PUBLISHED' || pvc.status === 'DIRTY' ? pvc.config : null,
        )
      : resolveFromJson(await getGlobalJson(), null, null);

    const payload: PublicVisualPayload = {
      playerId,
      enabled: pvc ? pvc.enabled && (pvc.status === 'PUBLISHED' || pvc.status === 'DIRTY') : false,
      config: {
        version: 1,
        perfMode: chain.perfMode,
        ambientEnabled: chain.ambientEnabled,
        objects: chain.objects,
        timeline: chain.timeline,
        events: chain.events,
      },
      presetName: pvc?.preset?.name ?? null,
    };
    return NextResponse.json(payload);
  } catch {
    // 读取失败安全回退（任务书 §十二：配置读取失败时安全回退到默认配置）
    return NextResponse.json({
      playerId,
      enabled: false,
      config: null,
      presetName: null,
    } satisfies PublicVisualPayload);
  }
}

async function getGlobalJson(): Promise<string | null> {
  const row = await db.config.findUnique({ where: { key: 'visual_global_default' } }).catch(() => null);
  return row?.value ?? null;
}
