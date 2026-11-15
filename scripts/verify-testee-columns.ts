// ============================================================
// 一次性核实脚本（用户指令 2026-11-06）：
//   「工单那边有写测试员和考核员 —— 你能判断哪个才是被测试的人吗？」
// 做法：只读拉取线上腾讯文档 → 解码 → 打印真实表头 + 每行 E/F 格原文
//   + P1-B 管线当前把哪列当作「考核员(tester)」哪列当作「被测玩家(testee/写榜对象)」。
// 零写库、零业务改动，纯核实。
// 运行：bun run scripts/verify-testee-columns.ts
// ============================================================

import { fetchSheetSnapshot } from '../src/lib/tier-command/tencent-doc-client';
import { decodeRelatedSheet } from '../src/lib/tier-command/protobuf-parse';
import { buildTickets } from '../src/lib/tier-command/pipeline';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];

async function main() {
  const snapshot = await fetchSheetSnapshot();
  if (snapshot.relatedSheets.length !== 1) {
    throw new Error(`related_sheet 块数=${snapshot.relatedSheets.length}（非 1）`);
  }
  const sheet = decodeRelatedSheet(snapshot.relatedSheets[0]!);

  console.log('=== 1) 线上文档真实表头（行0）===');
  sheet.headers.forEach((h, i) => {
    const letter = LETTERS[i] ?? `c${i}`;
    console.log(`  ${letter}${i}: "${h}"  [表单类型=${sheet.headerFormTypes[i] ?? '-'}]`);
  });

  console.log('\n=== 2) 每条数据行的关键格原文（E=考核员? F=测试者? G=tier H/I=胜场）===');
  const MAX_ROWS = 15;
  for (let i = 0; i < Math.min(sheet.rows.length, MAX_ROWS); i++) {
    const row = sheet.rows[i]!;
    const rowNo = sheet.rowNumbers[i]!;
    const byCol = new Map<number, string>();
    for (const cell of row) {
      const text = cell.text ?? (cell.number !== null ? String(cell.number) : '');
      byCol.set(cell.col, text);
    }
    const pick = (col: number) => `"${byCol.get(col) ?? ''}"`;
    // 打印整行（到 J 列），重点看 E/F
    console.log(
      `行${rowNo}: C=${pick(2)} D=${pick(3)} | E(考核员)=${pick(4)} | F(测试者)=${pick(5)} | G=${pick(6)} | H(测试者胜场)=${pick(7)} I(考核员胜场)=${pick(8)} | J=${pick(9)}`,
    );
  }

  console.log('\n=== 3) P1-B 管线当前的语义判定（tester=执行考核 / testee=被测玩家=写榜对象）===');
  const built = buildTickets(sheet, { players: [] });
  for (const t of built.tickets.slice(0, MAX_ROWS)) {
    console.log(
      `行${t.sheetRow}: 考核员(tester,E列)=${t.tester.gameId || '∅'} | 被测玩家/写榜对象(testee,F列)=${t.testee.gameId || '∅'} | tier=${t.testTier.normalized ?? t.testTier.raw} | status=${t.status}`,
    );
  }

  console.log('\n=== 4) 结论 ===');
  const h4 = sheet.headers[4] ?? '';
  const h5 = sheet.headers[5] ?? '';
  console.log(`E 列表头 = "${h4}" → 管线内部 key = tester（执行考核的一方）`);
  console.log(`F 列表头 = "${h5}" → 管线内部 key = testee（被测试的人，写榜对象 targetName）`);
}

main().catch(err => {
  console.error('核实失败:', err);
  process.exit(1);
});
