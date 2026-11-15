// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 内置视觉预设种子
// （任务书 §九示例预设；只存受控配置参数，无任何可执行代码）
// ------------------------------------------------------------
// 种子策略：幂等 upsert by name；isBuiltin=true（可编辑不可删）。
// 仅为「起点模板」，管理员可改后另存/覆盖。
// ============================================================

import type { VisualConfig } from './types';

export interface BuiltinPresetDef {
  name: string;
  description: string;
  config: VisualConfig;
}

const evt = (effect: VisualConfig['events'][string]['effect'], intensity = 70, duration = 900) =>
  ({ enabled: true, effect, intensity, duration });

export const BUILTIN_PRESETS: BuiltinPresetDef[] = [
  {
    name: 'Holographic Elite',
    description: '全息投影入场 + 扫描线氛围，精英级科技感',
    config: {
      version: 1, perfMode: 'FULL', ambientEnabled: true,
      objects: {
        AVATAR: { shape: 'HEXAGON', entrance: { effect: 'HOLOGRAM', trigger: 'AUTO', params: { duration: 900, intensity: 70 } }, ambient: 'HOLOGRAM', interaction: 'GLOW', accentColor: 'cyan' },
        PROFILE_CARD: { entrance: { effect: 'REVEAL', trigger: 'AUTO', params: { duration: 700, direction: 'left' } }, ambient: 'AURORA' },
        RANK_BADGE: { shape: 'HEXAGON', entrance: { effect: 'PHOTON', trigger: 'AUTO', params: { duration: 800, delay: 300 } } },
        STATS_CARD: { entrance: { effect: 'HOLOGRAM', trigger: 'AUTO', params: { duration: 800, delay: 150 } }, interaction: 'LIFT' },
        BACKGROUND: { ambient: 'AURORA', zLayer: 0 },
        FLOATING_PANEL: { entrance: { effect: 'PRISM', trigger: 'CLICK', params: { duration: 600 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'BACKGROUND', effect: 'AURORA', start: 0, duration: 1200, intensity: 50 },
        { id: 'seg-2', target: 'PROFILE_CARD', effect: 'REVEAL', start: 200, duration: 700, intensity: 60 },
        { id: 'seg-3', target: 'AVATAR', effect: 'HOLOGRAM', start: 600, duration: 900, intensity: 70 },
        { id: 'seg-4', target: 'RANK_BADGE', effect: 'PHOTON', start: 1100, duration: 800, intensity: 70 },
      ],
      events: {
        TIER_CHANGED: evt('HOLOGRAM', 85, 1400),
        RANK_CHANGED: evt('PHOTON', 70, 1000),
        STATISTICS_UPDATED: evt('PRISM', 55, 800),
      },
    },
  },
  {
    name: 'Cyber Champion',
    description: '维度翻转 + 光子扫掠，冠军登场的舞台感',
    config: {
      version: 1, perfMode: 'FULL', ambientEnabled: true,
      objects: {
        AVATAR: { shape: 'CIRCLE', entrance: { effect: 'DIMENSION', trigger: 'AUTO', params: { duration: 1000, direction: 'right', intensity: 80 } }, interaction: 'TILT', accentColor: 'gold' },
        PROFILE_CARD: { entrance: { effect: 'PHOTON', trigger: 'AUTO', params: { duration: 900, direction: 'left' } }, ambient: 'ORBIT' },
        RANK_BADGE: { shape: 'HEXAGON', entrance: { effect: 'PORTAL', trigger: 'AUTO', params: { duration: 700, delay: 350 } } },
        STATS_CARD: { entrance: { effect: 'PHOTON', trigger: 'AUTO', params: { duration: 850, delay: 200, direction: 'right' } }, interaction: 'LIFT' },
        BACKGROUND: { ambient: 'ORBIT', zLayer: 0 },
        FLOATING_PANEL: { entrance: { effect: 'DIMENSION', trigger: 'CLICK', params: { duration: 700 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'BACKGROUND', effect: 'ORBIT', start: 0, duration: 1400, intensity: 45 },
        { id: 'seg-2', target: 'PROFILE_CARD', effect: 'PHOTON', start: 250, duration: 900, intensity: 65 },
        { id: 'seg-3', target: 'AVATAR', effect: 'DIMENSION', start: 700, duration: 1000, intensity: 80 },
        { id: 'seg-4', target: 'STATS_CARD', effect: 'PHOTON', start: 1400, duration: 850, intensity: 60 },
      ],
      events: {
        TIER_CHANGED: evt('PORTAL', 90, 1500),
        RANK_CHANGED: evt('PHOTON', 75, 1100),
        PLAYER_PROFILE_OPEN: evt('PHOTON', 60, 1200),
      },
    },
  },
  {
    name: 'Aurora Glass',
    description: '极光流动氛围 + 棱镜玻璃材质，柔和高级',
    config: {
      version: 1, perfMode: 'BALANCED', ambientEnabled: true,
      objects: {
        AVATAR: { shape: 'CIRCLE', entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 900, intensity: 55 } }, ambient: 'AURORA', accentColor: 'violet' },
        PROFILE_CARD: { entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 800 } }, ambient: 'AURORA' },
        RANK_BADGE: { entrance: { effect: 'AURORA', trigger: 'AUTO', params: { duration: 1000, delay: 300 } } },
        STATS_CARD: { entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 750, delay: 180 } }, interaction: 'LIFT' },
        BACKGROUND: { ambient: 'AURORA', zLayer: 0 },
        FLOATING_PANEL: { entrance: { effect: 'PRISM', trigger: 'CLICK', params: { duration: 550 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'BACKGROUND', effect: 'AURORA', start: 0, duration: 1600, intensity: 55 },
        { id: 'seg-2', target: 'PROFILE_CARD', effect: 'PRISM', start: 300, duration: 800, intensity: 50 },
        { id: 'seg-3', target: 'AVATAR', effect: 'PRISM', start: 700, duration: 900, intensity: 55 },
      ],
      events: { STATISTICS_UPDATED: evt('PRISM', 50, 800), TAB_CHANGED: evt('AURORA', 40, 700) },
    },
  },
  {
    name: 'Prism Identity',
    description: '全棱镜语言：折射高光贯穿头像与数据卡',
    config: {
      version: 1, perfMode: 'BALANCED', ambientEnabled: false,
      objects: {
        AVATAR: { shape: 'ELLIPSE', entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 850, intensity: 75 } }, interaction: 'GLOW' },
        PROFILE_CARD: { entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 700 } } },
        RANK_BADGE: { entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 700, delay: 250 } } },
        STATS_CARD: { entrance: { effect: 'PRISM', trigger: 'AUTO', params: { duration: 700, delay: 150 } }, interaction: 'LIFT' },
        FLOATING_PANEL: { entrance: { effect: 'PRISM', trigger: 'CLICK', params: { duration: 500 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'PROFILE_CARD', effect: 'PRISM', start: 0, duration: 700, intensity: 60 },
        { id: 'seg-2', target: 'AVATAR', effect: 'PRISM', start: 350, duration: 850, intensity: 75 },
        { id: 'seg-3', target: 'STATS_CARD', effect: 'PRISM', start: 900, duration: 700, intensity: 55 },
      ],
      events: { STATISTICS_UPDATED: evt('PRISM', 55, 750) },
    },
  },
  {
    name: 'Minimal Premium',
    description: '近乎原生：仅轻量上浮与淡入，克制即高级',
    config: {
      version: 1, perfMode: 'LITE', ambientEnabled: false,
      objects: {
        AVATAR: { shape: 'CIRCLE', entrance: { effect: 'REVEAL', trigger: 'AUTO', params: { duration: 400, intensity: 25 } } },
        PROFILE_CARD: { entrance: { effect: 'REVEAL', trigger: 'AUTO', params: { duration: 380, intensity: 20 } } },
        STATS_CARD: { entrance: { effect: 'REVEAL', trigger: 'AUTO', params: { duration: 380, delay: 80, intensity: 20 } } },
        RANK_BADGE: { entrance: { effect: 'REVEAL', trigger: 'AUTO', params: { duration: 350, delay: 140, intensity: 20 } } },
        FLOATING_PANEL: { entrance: { effect: 'REVEAL', trigger: 'CLICK', params: { duration: 300, intensity: 20 } } },
      },
      timeline: [],
      events: { TIER_CHANGED: evt('PHOTON', 45, 800) },
    },
  },
  {
    name: 'Cosmic Orbit',
    description: '轨道环绕 + 粒子构成，深空巡礼',
    config: {
      version: 1, perfMode: 'FULL', ambientEnabled: true,
      objects: {
        AVATAR: { shape: 'CIRCLE', entrance: { effect: 'PARTICLE', trigger: 'AUTO', params: { duration: 1100, intensity: 80 } }, ambient: 'ORBIT', accentColor: 'cyan' },
        PROFILE_CARD: { entrance: { effect: 'PORTAL', trigger: 'AUTO', params: { duration: 900 } }, ambient: 'ORBIT' },
        RANK_BADGE: { shape: 'HEXAGON', entrance: { effect: 'ORBIT', trigger: 'AUTO', params: { duration: 900, delay: 300 } } },
        STATS_CARD: { entrance: { effect: 'PARTICLE', trigger: 'AUTO', params: { duration: 900, delay: 200, intensity: 60 } }, interaction: 'LIFT' },
        BACKGROUND: { ambient: 'PARTICLE', zLayer: 0 },
        FLOATING_PANEL: { entrance: { effect: 'PORTAL', trigger: 'CLICK', params: { duration: 600 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'BACKGROUND', effect: 'PARTICLE', start: 0, duration: 1500, intensity: 60 },
        { id: 'seg-2', target: 'PROFILE_CARD', effect: 'PORTAL', start: 300, duration: 900, intensity: 65 },
        { id: 'seg-3', target: 'AVATAR', effect: 'PARTICLE', start: 800, duration: 1100, intensity: 80 },
        { id: 'seg-4', target: 'RANK_BADGE', effect: 'ORBIT', start: 1600, duration: 900, intensity: 65 },
      ],
      events: {
        TIER_CHANGED: evt('PARTICLE', 85, 1500),
        LEADERBOARD_POSITION_CHANGED: evt('ORBIT', 70, 1100),
      },
    },
  },
  {
    name: 'Liquid Dimension',
    description: '液态变形 + 空间翻转，流体雕塑感',
    config: {
      version: 1, perfMode: 'FULL', ambientEnabled: false,
      objects: {
        AVATAR: { shape: 'CUSTOM_RADIUS', customRadius: 42, entrance: { effect: 'LIQUID', trigger: 'AUTO', params: { duration: 1000, intensity: 75 } }, interaction: 'TILT' },
        PROFILE_CARD: { entrance: { effect: 'LIQUID', trigger: 'AUTO', params: { duration: 850 } }, ambient: 'LIQUID' },
        RANK_BADGE: { shape: 'ELLIPSE', entrance: { effect: 'DIMENSION', trigger: 'AUTO', params: { duration: 800, delay: 250, intensity: 60 } } },
        STATS_CARD: { entrance: { effect: 'LIQUID', trigger: 'AUTO', params: { duration: 800, delay: 150 } }, interaction: 'LIFT' },
        FLOATING_PANEL: { entrance: { effect: 'LIQUID', trigger: 'CLICK', params: { duration: 600 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'PROFILE_CARD', effect: 'LIQUID', start: 0, duration: 850, intensity: 65 },
        { id: 'seg-2', target: 'AVATAR', effect: 'LIQUID', start: 400, duration: 1000, intensity: 75 },
        { id: 'seg-3', target: 'STATS_CARD', effect: 'LIQUID', start: 1100, duration: 800, intensity: 60 },
      ],
      events: { TIER_CHANGED: evt('LIQUID', 80, 1300), PLAYER_CARD_EXPANDED: evt('LIQUID', 55, 800) },
    },
  },
  {
    name: 'Cinematic Reveal',
    description: '分层揭幕时间轴：像预告片一样逐层呈现',
    config: {
      version: 1, perfMode: 'BALANCED', ambientEnabled: false,
      objects: {
        AVATAR: { entrance: { effect: 'REVEAL', trigger: 'SEQUENCE', params: { duration: 700, direction: 'up', intensity: 70 } } },
        PROFILE_CARD: { entrance: { effect: 'REVEAL', trigger: 'SEQUENCE', params: { duration: 650, direction: 'left', intensity: 60 } } },
        RANK_BADGE: { entrance: { effect: 'REVEAL', trigger: 'SEQUENCE', params: { duration: 600, direction: 'down', intensity: 60 } } },
        STATS_CARD: { entrance: { effect: 'REVEAL', trigger: 'SEQUENCE', params: { duration: 650, direction: 'right', intensity: 60 } } },
        FLOATING_PANEL: { entrance: { effect: 'REVEAL', trigger: 'CLICK', params: { duration: 500 } } },
      },
      timeline: [
        { id: 'seg-1', target: 'PROFILE_CARD', effect: 'REVEAL', start: 0, duration: 650, intensity: 60 },
        { id: 'seg-2', target: 'AVATAR', effect: 'REVEAL', start: 450, duration: 700, intensity: 70 },
        { id: 'seg-3', target: 'RANK_BADGE', effect: 'REVEAL', start: 950, duration: 600, intensity: 60 },
        { id: 'seg-4', target: 'STATS_CARD', effect: 'REVEAL', start: 1400, duration: 650, intensity: 60 },
        { id: 'seg-5', target: 'FLOATING_PANEL', effect: 'PHOTON', start: 2000, duration: 700, intensity: 50 },
      ],
      events: { PLAYER_PROFILE_OPEN: evt('REVEAL', 60, 1000), TIER_CHANGED: evt('REVEAL', 85, 1400) },
    },
  },
];
