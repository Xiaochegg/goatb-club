// ============================================================
// danger:db-reset 互锁包装（2026-11-04）
// package.json 中 "danger:db-reset" 现指向本脚本。
// prisma migrate reset 会清空全部业务数据 —— 必须双重确认：
//   1) 脚本名与警告已明示危险
//   2) 必须显式设置环境变量 GOATB_I_CONFIRM_DATA_LOSS=yes
// 该变量仅限命令行一次性传入，禁止写入 .env 常规环境。
// 放行后委托真正的 prisma migrate reset（本包装不做任何删除）。
// ============================================================

if (process.env.GOATB_I_CONFIRM_DATA_LOSS !== 'yes') {
  console.error('┌──────────────────────────────────────────────────────────────┐');
  console.error('│  ⛔ danger:db-reset 已被互锁拦截                              │');
  console.error('│                                                              │');
  console.error('│  prisma migrate reset 将清空数据库全部业务数据               │');
  console.error('│  （玩家/管理员/配置/日志全部丢失）。                          │');
  console.error('│                                                              │');
  console.error('│  若确认要执行，请先运行一次备份：                            │');
  console.error('│      bun run scripts/backup-db.ts                            │');
  console.error('│                                                              │');
  console.error('│  然后显式携带确认变量重新执行：                              │');
  console.error('│      GOATB_I_CONFIRM_DATA_LOSS=yes bun run danger:db-reset   │');
  console.error('│      （变量仅限命令行一次性传入，禁止写入 .env）             │');
  console.error('└──────────────────────────────────────────────────────────────┘');
  process.exit(1);
}

console.warn('⚠ 已收到显式确认（GOATB_I_CONFIRM_DATA_LOSS=yes），委托 prisma migrate reset 执行…');
const proc = Bun.spawnSync(['bunx', 'prisma', 'migrate', 'reset', '--force'], {
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 0);
