// ============================================================
// W1-T3 · feature_flags 种子脚本
// ============================================================
// 用法：bun run scripts/seed-feature-flags.ts
// 作用：向 Config 表写入 public_api=OFF（默认关闭，硬约束 4）
// 幂等：已存在则不覆盖，仅补缺
// 回滚：bun run scripts/seed-feature-flags.ts --remove

import { db } from '../src/lib/db';
import { CONFIG_KEYS } from '../src/lib/constants';

async function main() {
  const remove = process.argv.includes('--remove');

  if (remove) {
    await db.config.deleteMany({ where: { key: CONFIG_KEYS.PUBLIC_API } });
    await db.config.deleteMany({ where: { key: CONFIG_KEYS.MIN_MATCHES } });
    console.log('[seed-flags] removed public_api + min_matches');
    await db.$disconnect();
    return;
  }

  // public_api = OFF（硬约束：默认必须 OFF）
  const existingApi = await db.config.findUnique({ where: { key: CONFIG_KEYS.PUBLIC_API } });
  if (existingApi) {
    console.log(`[seed-flags] public_api already exists, value="${existingApi.value}" (kept)`);
  } else {
    await db.config.create({ data: { key: CONFIG_KEYS.PUBLIC_API, value: 'OFF' } });
    console.log('[seed-flags] created public_api = OFF');
  }

  // min_matches = 5（默认门槛，可后台调）
  const existingMin = await db.config.findUnique({ where: { key: CONFIG_KEYS.MIN_MATCHES } });
  if (existingMin) {
    console.log(`[seed-flags] min_matches already exists, value="${existingMin.value}" (kept)`);
  } else {
    await db.config.create({ data: { key: CONFIG_KEYS.MIN_MATCHES, value: '5' } });
    console.log('[seed-flags] created min_matches = 5');
  }

  // 验证种子
  const verifyApi = await db.config.findUnique({ where: { key: CONFIG_KEYS.PUBLIC_API } });
  console.log(`[seed-flags] VERIFY: public_api = "${verifyApi?.value}" (must be "OFF")`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error('[seed-flags] FAILED:', e);
  process.exit(1);
});
