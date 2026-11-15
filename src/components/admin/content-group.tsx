'use client';
// ============================================================
// GOATB 管理面板布局重组（管理员批复 2026-11-08「哪些可以直接合并，不需要单独的菜单」）
// ------------------------------------------------------------
// 「内容管理」合并组：原 4 个独立菜单（内容配置 / 音乐管理 / 背景管理 / 个性标签）
// 合并为 1 个菜单，组内子页签切换。
// 纪律：四个子面板组件（AdminContentConfig/AdminMusicManage/AdminBgManage/
// AdminTagStyles）本体零改动，本文件仅提供子页签壳。
// 子页签按钮样式沿用 AdminContentConfig 既有的 subTabs 模式，零新样式。
// 拆包语义：本文件被 index.tsx dynamic 按需加载——打开「内容管理」才拉本 chunk，
// content-tabs + tag-styles-tab 合入同一 chunk（393 行），与其他组互不牵连。
// 可逆性：删除本文件 + 还原 index.tsx 页签映射即回滚（映射见批次报告）。
// ============================================================
import { useState } from 'react';
import { AdminContentConfig, AdminMusicManage, AdminBgManage } from './content-tabs';
import { AdminTagStyles } from './tag-styles-tab';

const SUB_TABS = ['内容配置', '音乐管理', '背景管理', '个性标签'] as const;

export function AdminContentGroup() {
  const [sub, setSub] = useState(0);

  return (
    <div>
      <div className="flex gap-1 mb-3" role="tablist" aria-label="内容管理子页签">
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
      {/* 与重组前语义一致：条件渲染 = 切走即卸载（各面板本就各自持有本地态） */}
      {sub === 0 && <AdminContentConfig />}
      {sub === 1 && <AdminMusicManage />}
      {sub === 2 && <AdminBgManage />}
      {sub === 3 && <AdminTagStyles />}
    </div>
  );
}
