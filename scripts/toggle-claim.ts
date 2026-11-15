// ============================================================
// 认领功能开关脚本（feature_claim）
// 用法：bun run scripts/toggle-claim.ts          → 开启（value=on）
//       bun run scripts/toggle-claim.ts --off    → 关闭（value=off，回滚用）
// 作用：幂等 upsert Config key=feature_claim，效果等价于
//       管理面板 PUT /api/v1/config（含同格式审计日志）
// 红线：本脚本触库，执行前必须先跑 scripts/backup-db.ts
// ============================================================

import { db } from '../src/lib/db';

const KEY = 'feature_claim';
const value = process.argv.includes('--off') ? 'off' : 'on';

async function main() {
  const before = await db.config.findUnique({ where: { key: KEY } });
  console.log(`[claim-toggle] before: ${KEY} = ${before?.value ?? '(不存在)'}`);

  await db.config.upsert({
    where: { key: KEY },
    update: { value },
    create: { key: KEY, value },
  });

  // 审计记录：格式与 PUT /api/v1/config（管理面板路径）完全一致
  await db.operationLog
    .create({
      data: {
        type: 'update',
        detail: `admin → config · ${KEY} = ${value}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    })
    .catch(() => {});

  const after = await db.config.findUnique({ where: { key: KEY } });
  console.log(`[claim-toggle] after:  ${KEY} = ${after?.value}`);
  if (after?.value !== value) {
    console.error('[claim-toggle] ✗ 校验失败：落库值与预期不符');
    process.exit(1);
  }
  console.log(
    `[claim-toggle] ✓ 认领功能现为 ${value === 'on' ? 'ON（已开启）' : 'OFF（已关闭）'}`
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error('[claim-toggle] FAILED:', e);
  process.exit(1);
});
