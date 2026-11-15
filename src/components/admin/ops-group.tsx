'use client';
// ============================================================
// GOATB 管理面板布局重组（管理员批复 2026-11-08「哪些可以直接合并，不需要单独的菜单」）
// ------------------------------------------------------------
// 「数据运维」合并组：原 3 个独立菜单（数据存档 / 操作日志 / 沙盒）
// 合并为 1 个菜单，组内子页签切换。
// 纪律：三个子面板组件（AdminArchive/AdminOpLogs/AdminSandbox）本体零改动，
// 本文件仅提供子页签壳（样式同 content-group）。
// R3-T2 自动存档行为不变：AdminArchive 挂载才启动 1.5s 首拍 + 5min 周期，
// 与重组前「存档页签激活才挂载」完全一致（组内子页签同为条件渲染）。
// 拆包语义：archive-tab + oplogs-tab + sandbox-tab 合入同一 chunk（552 行），
// 与内容组互不牵连。
// 可逆性：删除本文件 + 还原 index.tsx 页签映射即回滚（映射见批次报告）。
// ============================================================
import { useState } from 'react';
import { AdminArchive } from './archive-tab';
import { AdminOpLogs } from './oplogs-tab';
import { AdminSandbox } from './sandbox-tab';

const SUB_TABS = ['自动存档', '操作日志', '沙盒'] as const;

export function AdminOpsGroup() {
  const [sub, setSub] = useState(0);

  return (
    <div>
      <div className="flex gap-1 mb-3" role="tablist" aria-label="数据运维子页签">
        {SUB_TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setSub(i)}
            role="tab"
            aria-selected={sub === i}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
              sub === i ? 'bg-jade-500/15 text-jade-400' : 'text-muted-foreground hover:text-white hover:bg-white/5'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {/* 与重组前语义一致：条件渲染 = 切走即卸载 */}
      {sub === 0 && <AdminArchive />}
      {sub === 1 && <AdminOpLogs />}
      {sub === 2 && <AdminSandbox />}
    </div>
  );
}
