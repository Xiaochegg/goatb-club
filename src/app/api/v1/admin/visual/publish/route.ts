import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { sanitizeVisualConfig, serializeVisualConfig } from '@/lib/visual/schema';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 发布（单个 + 批量）
// POST /api/v1/admin/visual/publish
// body: { playerId, summary? }                       单个发布（草稿→发布）
// body: { playerIds: [...], presetId, summary? }     批量按预设发布
// body: { playerIds: [...], clear: true }            批量清除个人覆盖
// ------------------------------------------------------------
// 发布语义：draftConfig 经服务端再校验 → 写入 config（生效）→
// version+1 → VisualRevision 快照（可回滚）→ OperationLog 审计。
// 批量：逐一独立处理，返回真实成功/失败数量（任务书 §7.4）。
// 权限：OWNER/ADMIN。
// ============================================================

export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  const admin = guard.admin!;
  const ip = req.headers.get('x-forwarded-for') || 'unknown';

  try {
    const body = await req.json();
    const summary = typeof body?.summary === 'string' ? body.summary.slice(0, 120) : null;

    // ── 批量分支 ──
    if (Array.isArray(body?.playerIds)) {
      const playerIds: string[] = body.playerIds
        .filter((x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 64)
        .slice(0, 500);
      if (playerIds.length === 0) {
        return NextResponse.json({ error: 'playerIds 为空' }, { status: 400 });
      }

      // 批量清除
      if (body.clear === true) {
        let ok = 0; let fail = 0;
        for (const pid of playerIds) {
          try {
            const del = await db.playerVisualConfig.deleteMany({ where: { playerId: pid } });
            if (del.count > 0) ok += 1; else fail += 1;
          } catch { fail += 1; }
        }
        await db.operationLog.create({
          data: {
            type: 'VISUAL',
            detail: `visual-batch-clear · 影响 ${playerIds.length} · 成功 ${ok} · 失败 ${fail}`,
            adminKey: admin.username, ip,
          },
        }).catch(() => {});
        return NextResponse.json({ success: true, mode: 'batch-clear', affected: playerIds.length, successCount: ok, failCount: fail });
      }

      // 批量按预设发布
      const presetId = typeof body.presetId === 'string' ? body.presetId : null;
      if (!presetId) return NextResponse.json({ error: '批量发布必须提供 presetId 或 clear=true' }, { status: 400 });
      const preset = await db.visualPreset.findUnique({ where: { id: presetId } });
      if (!preset) return NextResponse.json({ error: '预设不存在' }, { status: 404 });
      const presetConfig = sanitizeVisualConfig(safeJson(preset.config));
      const presetSerialized = serializeVisualConfig(presetConfig);
      if (!presetSerialized) return NextResponse.json({ error: '预设配置非法' }, { status: 500 });

      let successCount = 0; let failCount = 0;
      for (const pid of playerIds) {
        try {
          const player = await db.player.findUnique({ where: { id: pid }, select: { id: true } });
          if (!player) { failCount += 1; continue; }
          const prev = await db.playerVisualConfig.findUnique({ where: { playerId: pid } });
          const nextVersion = (prev?.version ?? 0) + 1;
          await db.playerVisualConfig.upsert({
            where: { playerId: pid },
            create: {
              playerId: pid, presetId, enabled: true,
              draftConfig: presetSerialized, config: presetSerialized,
              status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
            },
            update: {
              presetId, enabled: true,
              draftConfig: presetSerialized, config: presetSerialized,
              status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
            },
          });
          await db.visualRevision.create({
            data: {
              playerId: pid, version: nextVersion,
              configSnapshot: presetSerialized,
              changedBy: admin.username,
              changeSummary: `批量预设「${preset.name}」${summary ? ' · ' + summary : ''}`,
            },
          });
          successCount += 1;
        } catch { failCount += 1; }
      }
      await db.operationLog.create({
        data: {
          type: 'VISUAL',
          detail: `visual-batch-publish · 预设「${preset.name}」 · 影响 ${playerIds.length} · 成功 ${successCount} · 失败 ${failCount}`,
          adminKey: admin.username, ip,
        },
      }).catch(() => {});
      return NextResponse.json({ success: true, mode: 'batch-publish', presetName: preset.name, affected: playerIds.length, successCount, failCount });
    }

    // ── 单个发布分支 ──
    const { playerId } = body ?? {};
    if (!playerId || typeof playerId !== 'string') {
      return NextResponse.json({ error: 'playerId 为必填' }, { status: 400 });
    }
    const player = await db.player.findUnique({ where: { id: playerId }, select: { id: true, name: true } });
    if (!player) return NextResponse.json({ error: '玩家不存在' }, { status: 404 });

    const pvc = await db.playerVisualConfig.findUnique({ where: { playerId } });
    const draftRaw = pvc?.draftConfig ?? '{}';
    const draftSafe = sanitizeVisualConfig(safeJson(draftRaw));
    const serialized = serializeVisualConfig(draftSafe);
    if (!serialized) return NextResponse.json({ error: '草稿配置非法或超限' }, { status: 400 });

    const nextVersion = (pvc?.version ?? 0) + 1;
    await db.playerVisualConfig.upsert({
      where: { playerId },
      create: {
        playerId, presetId: pvc?.presetId ?? null, enabled: pvc?.enabled ?? true,
        draftConfig: serialized, config: serialized,
        status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
      },
      update: {
        draftConfig: serialized, config: serialized,
        status: 'PUBLISHED', version: nextVersion, updatedBy: admin.username,
      },
    });
    await db.visualRevision.create({
      data: {
        playerId, version: nextVersion, configSnapshot: serialized,
        changedBy: admin.username, changeSummary: summary ?? '发布视觉配置',
      },
    });
    await db.operationLog.create({
      data: {
        type: 'VISUAL',
        detail: `visual-publish · ${player.name} · v${nextVersion}`,
        adminKey: admin.username, ip,
        beforeData: pvc ? JSON.stringify({ version: pvc.version, status: pvc.status }) : null,
        afterData: JSON.stringify({ version: nextVersion, status: 'PUBLISHED' }),
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, mode: 'publish', version: nextVersion });
  } catch {
    return NextResponse.json({ error: '发布失败（上一版本已保留）' }, { status: 500 });
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
