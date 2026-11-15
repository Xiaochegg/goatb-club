import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';
import { ALL_MODES, NORMAL_TIERS, JIAHAO_TIERS } from '@/lib/constants';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// POST /api/v1/sandbox/seed?count=N
// Generate N demo players with realistic tier distribution + stats.
// All demo players are name-prefixed "[DEMO]" so they can be wiped
// cleanly without touching real data.
// ============================================================

const DEMO_PREFIX = '[DEMO]';

// Weighted tier distribution — mirrors a real competitive ladder:
// top tiers rare, mid tiers common, bottom tiers moderate.
// (HT1/LT1 5%, HT2/LT2 10%, HT3/LT3 20%, HT4/LT4 30%, HT5/LT5 35%)
const TIER_WEIGHTS: Array<[string, number]> = [
  ['HT1', 3], ['LT1', 2],
  ['HT2', 6], ['LT2', 4],
  ['HT3', 12], ['LT3', 8],
  ['HT4', 18], ['LT4', 12],
  ['HT5', 20], ['LT5', 15],
];

// Demo name pools — Minecraft-y handles
const NAME_ADJ = ['Diamond', 'Iron', 'Emerald', 'Nether', 'Shadow', 'Crystal', 'Storm', 'Frost', 'Blaze', 'Void', 'Cyber', 'Pixel', 'Turbo', 'Mega', 'Ultra', 'Dark', 'Neon', 'Quantum', 'Apex', 'Phantom'];
const NAME_NOUN = ['King', 'Queen', 'Slayer', 'Hunter', 'Knight', 'Wizard', 'Reaper', 'Ghost', 'Wolf', 'Tiger', 'Dragon', 'Phoenix', 'Titan', 'Guardian', 'Ranger', 'Berserker', 'Champion', 'Master', 'Legend', 'Prodigy'];
const EMOTIONS = [
  '从青铜一路打到 HT1，感谢兄弟们陪我肝了 200 场',
  '水晶模式永远的神，这把 1v3 翻盘太爽了',
  '新人报道，目标年底进总榜前 50',
  '退坑一年回来发现还是这套装备最顺手',
  '感谢 GOATB 社区，在这里认识了最好的队友',
  '剑斗 200 胜达成，下一个目标 500 胜',
  '虽然只是 LT3 但每场都在进步，下次冲 HT',
  '老玩家回归，发现新人们都好强',
  '盾斧才是男人的浪漫',
  'SMP 生存赛冠军，这赛季继续努力',
];

function weightedPick<T>(items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

function randomName(used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const adj = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)];
    const noun = NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
    const num = Math.floor(Math.random() * 999);
    const name = `${adj}${noun}${num}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // fallback: uuid-ish
  const name = `Player${Math.floor(Math.random() * 999999)}`;
  used.add(name);
  return name;
}

function generateStats(tier: string) {
  // Derive plausible stats from tier — higher tier = more wins/kills
  const tierLevel = tier.startsWith('HT') ? parseInt(tier.slice(2)) : parseInt(tier.slice(2));
  const isHigh = tier.startsWith('HT');
  const base = (6 - tierLevel) * 20; // HT1=100, HT5=20, LT1=80...
  const matches = Math.floor(base * (0.8 + Math.random() * 0.6));
  const winRateBase = isHigh ? 0.65 - tierLevel * 0.05 : 0.45 - tierLevel * 0.05;
  const wins = Math.floor(matches * Math.max(0.15, winRateBase + (Math.random() - 0.5) * 0.1));
  const kills = Math.floor(wins * (2 + Math.random() * 3) + Math.random() * 20);
  const deaths = Math.floor((matches - wins) * (1 + Math.random() * 2) + Math.random() * 10);
  return { kills, deaths, wins, matches };
}

// AUTH V2.0 安全修复专项（2026-11-11）：批量注入演示数据限 OWNER/ADMIN（VIEWER 只读）
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const count = parseInt(req.nextUrl.searchParams.get('count') || '100');
    if (isNaN(count) || count < 1) {
      return NextResponse.json({ error: 'count must be a positive integer' }, { status: 400 });
    }
    if (count > 10000) {
      return NextResponse.json({ error: 'Max 10000 demo players per seed' }, { status: 400 });
    }

    // Fetch existing demo names to avoid collisions
    const existing = await db.player.findMany({
      where: { name: { startsWith: DEMO_PREFIX } },
      select: { name: true },
    });
    const usedNames = new Set(existing.map(p => p.name));

    let created = 0;
    const batchSize = 100;
    for (let batch = 0; batch < count; batch += batchSize) {
      const remaining = Math.min(batchSize, count - batch);
      const batchData: Array<{
        name: string;
        tiers: string;
        overrideScores: string;
        stats: string;
        likes: number;
        emotionText: string | null;
      }> = [];
      for (let i = 0; i < remaining; i++) {
        const rawName = randomName(usedNames);
        const demoName = `${DEMO_PREFIX}${rawName}`;
        usedNames.add(demoName);

        // Assign tiers to a random subset of modes (1-5 modes per player)
        const modeCount = 1 + Math.floor(Math.random() * 5);
        const shuffledModes = [...ALL_MODES].sort(() => Math.random() - 0.5).slice(0, modeCount);
        const tiers: Record<string, string> = {};
        const stats: Record<string, { kills: number; deaths: number; wins: number; matches: number }> = {};
        for (const mode of shuffledModes) {
          const isFunMode = mode === 'JIAHAO' || mode === 'BIRD';
          const tierSet = isFunMode ? JIAHAO_TIERS : NORMAL_TIERS;
          // 娱乐模式（嘉豪/小鸟）用 LZ/LL tiers — map weights to those
          let tier: string;
          if (isFunMode) {
            const jiahaoWeights: Array<[string, number]> = TIER_WEIGHTS.map(([t, w]) => {
              const n = parseInt(t.slice(2));
              return [t.startsWith('HT') ? `LZ${n}` : `LL${n}`, w] as [string, number];
            });
            tier = weightedPick(jiahaoWeights);
          } else {
            tier = weightedPick(TIER_WEIGHTS);
          }
          tiers[mode] = tier;
          stats[mode] = generateStats(tier);
        }

        // ~20% of demo players have emotion text
        const hasEmotion = Math.random() < 0.2;
        const emotionText = hasEmotion ? EMOTIONS[Math.floor(Math.random() * EMOTIONS.length)] : null;
        const likes = hasEmotion ? Math.floor(Math.random() * 50) : Math.floor(Math.random() * 10);

        batchData.push({
          name: demoName,
          tiers: JSON.stringify(tiers),
          overrideScores: '{}',
          stats: JSON.stringify(stats),
          likes,
          emotionText,
        });
      }
      await db.player.createMany({ data: batchData });
      created += remaining;
    }

    await db.operationLog.create({
      data: {
        type: 'import',
        detail: `admin → sandbox seed · +${created} demo players`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // Demo players created → bust cached player lists + stats.
    bustPlayerCaches();
    return NextResponse.json({ success: true, created, prefix: DEMO_PREFIX });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to seed sandbox data' }, { status: 500 });
  }
}
