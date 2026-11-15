// ============================================================
// W1-T1b · tiers 升级迁移脚本
// ============================================================
// 用法：bun run scripts/upgrade-tiers.ts
// 作用：扫描所有 Player，把旧格式 tiers({SHIELD:"HT1"}) 升级为新格式({SHIELD:{tier:"HT1",source:"legacy",updatedAt:"..."}})
// 安全：只做加法（加 source/updatedAt），不删任何字段；可回滚（downgradeTiers）
// 回滚：bun run scripts/upgrade-tiers.ts --rollback

import { db } from '../src/lib/db';
import { isUpgradedTiers, parseTiers, serializeTiers, downgradeTiers } from '../src/lib/tiers';

async function main() {
  const rollback = process.argv.includes('--rollback');
  console.log(`[upgrade-tiers] mode: ${rollback ? 'ROLLBACK' : 'UPGRADE'}`);

  const players = await db.player.findMany({ select: { id: true, name: true, tiers: true } });
  console.log(`[upgrade-tiers] scanned ${players.length} players`);

  let upgraded = 0;
  let skipped = 0;
  let alreadyDone = 0;

  for (const p of players) {
    if (rollback) {
      // 回滚：新格式 → 旧格式
      const downgraded = downgradeTiers(p.tiers);
      if (downgraded !== p.tiers) {
        await db.player.update({ where: { id: p.id }, data: { tiers: downgraded } });
        upgraded++;
      } else {
        skipped++;
      }
      continue;
    }

    // 升级：旧格式 → 新格式
    if (isUpgradedTiers(p.tiers)) {
      alreadyDone++;
      continue;
    }
    const upgradedJson = serializeTiers(parseTiers(p.tiers));
    await db.player.update({ where: { id: p.id }, data: { tiers: upgradedJson } });
    upgraded++;
  }

  console.log(`[upgrade-tiers] done: ${upgraded} ${rollback ? 'rolled back' : 'upgraded'}, ${alreadyDone} already done, ${skipped} skipped`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error('[upgrade-tiers] FAILED:', e);
  process.exit(1);
});
