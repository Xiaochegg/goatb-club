// ============================================================
// 音乐播放器全局状态（2026-12 播放器架构迁移）
// ============================================================
// 背景（真实故障根因，见 music-drawer-player.tsx 头注释）：
//   旧架构把真实播放器做成 4 个运行时注入的全局脚本，UI 存亡依赖
//   资源加载——任一环节失败用户就永远等不到播放器。
//   新架构：播放器是页面内真正的 React 组件，Dock 音乐键 / 迷你圆钮
//   通过本 store 直接驱动抽屉开合，与任何网络/资源状态无关。
//
// 职责（刻意保持极小，只有跨组件状态，无音频逻辑）：
//   - expanded：抽屉展开 ⇄ 收起为迷你圆钮（Dock 音乐键 = toggle，
//     面板头部「收起」钮 = setExpanded(false)，播放不中断）
//   - playing：音频实际播放中 → Dock 音乐项 EQ 生命条动效
// ============================================================
import { create } from 'zustand';

interface MusicPlayerState {
  /** 抽屉是否展开（false = 收起为右下角迷你圆钮） */
  expanded: boolean;
  /** 音频实际播放中（驱动 Dock 音乐项 EQ 动效） */
  playing: boolean;
  setExpanded: (v: boolean) => void;
  toggle: () => void;
  setPlaying: (v: boolean) => void;
}

export const useMusicPlayerStore = create<MusicPlayerState>((set) => ({
  expanded: false,
  playing: false,
  setExpanded: (v) => set({ expanded: v }),
  toggle: () => set((s) => ({ expanded: !s.expanded })),
  setPlaying: (v) => set({ playing: v }),
}));
