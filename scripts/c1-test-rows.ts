// ============================================================
// C1 日志分页 · 临时测试行工具（仅测试期使用，用后即删）
// 用法：
//   bun run scripts/c1-test-rows.ts insert 35   → 插入 N 条标记行，ids 写 /tmp/c1-test-ids.json
//   bun run scripts/c1-test-rows.ts remove      → 按 /tmp/c1-test-ids.json 精确删除（不碰其它行）
// 红线：不使用 deleteMany() 无差别删除；只按本脚本记录的 id 逐条删。
// ============================================================

import { db } from '../src/lib/db';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const IDS_FILE = '/tmp/c1-test-ids.json';
const cmd = process.argv[2];
const count = parseInt(process.argv[3] || '35', 10);

async function main() {
  if (cmd === 'insert') {
    const marker = 'C1分页测试行（临时数据·轻量化改造验证用）';
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const row = await db.operationLog.create({
        data: {
          type: 'info',
          detail: `${marker} · #${i}/${count}`,
          scoreChange: null,
          adminKey: 'admin',
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    writeFileSync(IDS_FILE, JSON.stringify(ids));
    const total = await db.operationLog.count();
    console.log(`[c1-test] inserted=${ids.length} ids→${IDS_FILE} totalNow=${total}`);
  } else if (cmd === 'remove') {
    if (!existsSync(IDS_FILE)) {
      console.error('[c1-test] ids 文件不存在，拒绝盲目删除');
      process.exit(1);
    }
    const ids: string[] = JSON.parse(readFileSync(IDS_FILE, 'utf-8'));
    let removed = 0;
    for (const id of ids) {
      const r = await db.operationLog.deleteMany({ where: { id, type: 'info' } });
      removed += r.count;
    }
    const total = await db.operationLog.count();
    console.log(`[c1-test] removed=${removed}/${ids.length} totalNow=${total}`);
    const residual = await db.operationLog.count({
      where: { detail: { contains: 'C1分页测试行' } },
    });
    console.log(`[c1-test] residualMarkerRows=${residual} (must be 0)`);
  } else {
    console.error('用法: bun run scripts/c1-test-rows.ts insert 35 | remove');
    process.exit(1);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error('[c1-test] FAILED:', e);
  process.exit(1);
});
