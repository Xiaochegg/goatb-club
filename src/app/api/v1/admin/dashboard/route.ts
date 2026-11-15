import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { ALL_MODES } from '@/lib/constants';
import { getPlayerTotalScore, type ScoredPlayer } from '@/lib/scoring';
import { toLegacyTiersMap } from '@/lib/tiers';

// ============================================================
// GET /api/v1/admin/dashboard
// Aggregated ops-center snapshot (spec §12):
//   - player totals + today's new
//   - active modes (players per mode)
//   - recent operations (last 5 logs)
//   - top movers (from latest 2 rank snapshots diff)
//   - suspicious data (K/D > 30, winRate > 95% with 20+ matches)
// Lightweight: single queries + in-memory reduce on small result sets.
// ============================================================

export async function GET() {
  const guard = await requireAdmin();
  if (guard) return guard;

  try {
    // ── Player totals ──
    const totalPlayers = await db.player.count();
    // P3-16（审计 2026-11-13）：「今日」按用户时区 Asia/Riyadh（UTC+3，全年无夏令时）
    // 计算当日午夜，不再用服务器本地（UTC）午夜 —— 旧实现会把利雅得
    // 00:00-03:00 的新增错计到昨天。构造：利雅得当日 Y/M/D → 反推 UTC 时刻。
    const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
    const riyadhNow = new Date(Date.now() + RIYADH_OFFSET_MS);
    const todayStart = new Date(
      Date.UTC(riyadhNow.getUTCFullYear(), riyadhNow.getUTCMonth(), riyadhNow.getUTCDate()) - RIYADH_OFFSET_MS,
    );
    const newToday = await db.player.count({ where: { createdAt: { gte: todayStart } } });

    // ── Active modes (player count per mode that has a tier) ──
    const allPlayers = await db.player.findMany();
    const modeCounts: Record<string, number> = {};
    for (const p of allPlayers) {
      try {
        // P1-3（审计 2026-11-13）：统一走 toLegacyTiersMap —— 写入侧已统一升级
        // 新格式 {SHIELD:{tier,...}}，RAW JSON.parse 会把对象当段位值，
        // 真实段位落库后此处恒判空。与前台 /api/v1/stats 同源解析。
        const tiers = toLegacyTiersMap(p.tiers);
        for (const mode of ALL_MODES) {
          if (tiers[mode]) modeCounts[mode] = (modeCounts[mode] || 0) + 1;
        }
      } catch { /* skip invalid JSON */ }
    }
    const activeModes = Object.entries(modeCounts)
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => b.count - a.count);

    // ── Recent operations (last 5) ──
    const recentLogs = await db.operationLog.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, detail: true, createdAt: true, adminKey: true },
    });

    // ── Top movers (diff latest 2 snapshots per mode, pick biggest rank jumps) ──
    const movers: Array<{ playerId: string; playerName: string; mode: string; delta: number; direction: 'up' | 'down' }> = [];
    const snapshotModes = ['TOTAL', ...ALL_MODES];
    for (const mode of snapshotModes) {
      const snaps = await db.rankSnapshot.findMany({
        where: { mode },
        orderBy: { createdAt: 'desc' },
        take: 200, // last 2 batches worth
        include: { player: { select: { name: true } } },
      });
      if (snaps.length < 2) continue;
      // Group by createdAt to find the 2 latest batches
      const times = [...new Set(snaps.map(s => s.createdAt.toISOString()))];
      if (times.length < 2) continue;
      const latestTime = times[0];
      const prevTime = times[1];
      const latestMap = new Map(snaps.filter(s => s.createdAt.toISOString() === latestTime).map(s => [s.playerId, s.rank]));
      const prevMap = new Map(snaps.filter(s => s.createdAt.toISOString() === prevTime).map(s => [s.playerId, s.rank]));
      for (const [playerId, latestRank] of latestMap) {
        const prevRank = prevMap.get(playerId);
        if (prevRank === undefined) continue;
        const delta = prevRank - latestRank; // positive = improved
        if (delta === 0) continue;
        const p = snaps.find(s => s.playerId === playerId)?.player;
        if (!p) continue;
        movers.push({ playerId, playerName: p.name, mode, delta, direction: delta > 0 ? 'up' : 'down' });
      }
    }
    movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const topMovers = movers.slice(0, 6);

    // ── Suspicious data detection (spec §23 — warning only, no auto-ban) ──
    // Thresholds are configurable via Config table (defaults shown).
    const configRows = await db.config.findMany({
      where: { key: { in: ['anomaly_kd_threshold', 'anomaly_winrate_threshold', 'anomaly_min_matches'] } },
    });
    const cfgMap: Record<string, string> = {};
    for (const c of configRows) cfgMap[c.key] = c.value;
    const KD_THRESHOLD = parseFloat(cfgMap.anomaly_kd_threshold || '30');
    const WINRATE_THRESHOLD = parseFloat(cfgMap.anomaly_winrate_threshold || '95');
    const MIN_MATCHES = parseInt(cfgMap.anomaly_min_matches || '20');

    const suspicious: Array<{ playerId: string; playerName: string; reason: string; value: string }> = [];
    for (const p of allPlayers) {
      try {
        const stats = JSON.parse(p.stats || '{}');
        for (const mode of ALL_MODES) {
          const s = stats[mode];
          if (!s || s.matches < 5) continue;
          const kd = s.deaths === 0 ? (s.kills > 0 ? Infinity : 0) : s.kills / s.deaths;
          const winRate = s.matches > 0 ? (s.wins / s.matches) * 100 : 0;
          if (kd > KD_THRESHOLD) {
            suspicious.push({ playerId: p.id, playerName: p.name, reason: `异常 K/D (${mode})`, value: kd === Infinity ? '∞' : kd.toFixed(1) });
          }
          if (winRate > WINRATE_THRESHOLD && s.matches >= MIN_MATCHES) {
            suspicious.push({ playerId: p.id, playerName: p.name, reason: `异常胜率 (${mode})`, value: `${winRate.toFixed(0)}% / ${s.matches}场` });
          }
        }
      } catch { /* skip */ }
    }

    // ── Aggregate stats ──
    const scoredPlayers: ScoredPlayer[] = allPlayers.map(p => ({
      id: p.id, name: p.name,
      // P1-3：同上，与新格式段位存储对齐（后台平均分不再恒 0）
      tiers: toLegacyTiersMap(p.tiers),
      overrideScores: JSON.parse(p.overrideScores || '{}'),
      stats: JSON.parse(p.stats || '{}'),
      likes: p.likes, emotionText: p.emotionText,
    }));
    const totalScore = scoredPlayers.reduce((s, p) => s + getPlayerTotalScore(p), 0);
    const avgScore = totalPlayers > 0 ? Math.round(totalScore / totalPlayers) : 0;

    return NextResponse.json({
      overview: {
        totalPlayers,
        newToday,
        avgScore,
        totalLikes: allPlayers.reduce((s, p) => s + (p.likes || 0), 0),
        emotionCount: allPlayers.filter(p => p.emotionText).length,
      },
      activeModes,
      recentLogs,
      topMovers,
      suspicious: suspicious.slice(0, 10),
      suspiciousCount: suspicious.length,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
