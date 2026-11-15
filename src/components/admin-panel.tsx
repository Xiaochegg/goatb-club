'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// ------------------------------------------------------------
// 本文件原为 2557 行巨型组件（AdminPanel + 12 页签 + PlayerEditDrawer +
// 确认弹窗等混居单文件，访客 idle 预取时全量下载）。
// 重组：实现全部机械迁移至 src/components/admin/*（各页签独立模块 + 共享件 +
// 按 dynamic 拆分的壳），本文件降级为 re-export 兼容壳：
//   - page.tsx 的 dynamic import 路径（@/components/admin-panel）零改动；
//   - 对外导出面不变（AdminPanel / PlayerEditDrawer）；
//   - 拆包收益：访客不再预取后台代码（page.tsx 预取条件化），管理员打开
//     后台按页签增量加载（壳 + 当前页签），切换页签才拉对应模块。
// 迁移映射表与 E2E 验证记录：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// ============================================================
export { AdminPanel } from '@/components/admin';
export { PlayerEditDrawer } from '@/components/admin/player-edit-drawer';
