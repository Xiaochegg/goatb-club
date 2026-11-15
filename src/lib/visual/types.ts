// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 类型与枚举白名单
// （管理员批示「通过」2026-11-12 trace 1a1cfcfc32dceef1）
// ------------------------------------------------------------
// 设计红线：
//   - 配置中不存在任何自由文本可执行面（无 HTML/JS/CSS 字符串）；
//   - 所有枚举在此处钉定，服务端 schema.ts 与客户端渲染器共用；
//   - 所有数值在 schema.ts 钳制（单一事实源）。
// ============================================================

/** 十种基础视觉动画引擎（任务书 §四，顺序即编号） */
export const EFFECT_KEYS = [
  'PRISM',      // 01 棱镜玻璃
  'PORTAL',     // 02 空间传送
  'HOLOGRAM',   // 03 全息投影
  'AURORA',     // 04 极光流动
  'ORBIT',      // 05 轨道环绕
  'PARTICLE',   // 06 粒子构成
  'LIQUID',     // 07 液态变形
  'DIMENSION',  // 08 空间翻转
  'REVEAL',     // 09 分层揭幕
  'PHOTON',     // 10 光子扫掠
] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];

/** 动画方向（PORTAL/REVEAL/PHOTON/DIMENSION 等使用） */
export const DIRECTIONS = ['center', 'up', 'down', 'left', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** 缓动白名单（CSS timing function，逐字进 style，无注入面） */
export const EASINGS = [
  'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'cubic-bezier(0.22, 1, 0.36, 1)',   // easeOutQuint feel
  'cubic-bezier(0.83, 0, 0.17, 1)',   // easeInOutQuint feel
  'cubic-bezier(0.34, 1.56, 0.64, 1)', // soft overshoot
] as const;
export type Easing = (typeof EASINGS)[number];

/** 触发方式（任务书 §五）。移动端 Hover 永不作为唯一触发：HOVER 自动附带 CLICK 回退 */
export const TRIGGERS = ['AUTO', 'CLICK', 'HOVER', 'SCROLL', 'DELAYED', 'SEQUENCE', 'TOGGLE'] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** 性能分级（任务书 §十四） */
export const PERF_MODES = ['FULL', 'BALANCED', 'LITE', 'STATIC'] as const;
export type PerfMode = (typeof PERF_MODES)[number];

/** 画面形状（任务书 §六） */
export const SHAPE_KINDS = ['ROUNDED_RECT', 'CIRCLE', 'ELLIPSE', 'HEXAGON', 'CUSTOM_RADIUS'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** 尺寸档位（XS-XL + 自定义宽高） */
export const SIZE_PRESETS = ['XS', 'S', 'M', 'L', 'XL', 'CUSTOM'] as const;
export type SizePreset = (typeof SIZE_PRESETS)[number];

/** 独立视觉对象（任务书 §六：六个可独立配置对象） */
export const OBJECT_TARGETS = [
  'AVATAR',          // 头像框
  'PROFILE_CARD',    // 玩家资料卡（身份行）
  'RANK_BADGE',      // 等级徽章
  'STATS_CARD',      // 战绩数据卡（总分/排名块）
  'BACKGROUND',      // 背景装饰层
  'FLOATING_PANEL',  // 弹出式信息窗口（评分明细折叠面板）
] as const;
export type ObjectTarget = (typeof OBJECT_TARGETS)[number];

/** 四层架构（任务书 §三） */
export const LAYERS = ['IDENTITY', 'ENTRANCE', 'AMBIENT', 'INTERACTION'] as const;
export type LayerKey = (typeof LAYERS)[number];

/** 真实业务事件（任务书 §十一）。ACHIEVEMENT_UNLOCKED 无真实数据源，本期不开放 */
export const EVENT_KEYS = [
  'PLAYER_PROFILE_OPEN',
  'PLAYER_PROFILE_CLOSE',
  'RANK_CHANGED',
  'TIER_CHANGED',
  'STATISTICS_UPDATED',
  'LEADERBOARD_POSITION_CHANGED',
  'PLAYER_CARD_EXPANDED',
  'TAB_CHANGED',
] as const;
export type EventKey = (typeof EVENT_KEYS)[number];

/** 效果参数（统一接口，全部受控数值/枚举） */
export interface EffectParams {
  duration: number;   // ms 200..3000
  delay: number;      // ms 0..3000
  intensity: number;  // 0..100（效果强度：模糊量/位移量/粒子比例等归一系数）
  direction: Direction;
  easing: Easing;
  iteration: number;  // 1..3；Ambient 层允许 0 = 无限
  opacity: number;    // 0..100 终态不透明度 %
  scale: number;      // 50..120 终态缩放 %
}

/** 单对象效果绑定（入场效果 + 触发方式） */
export interface EffectBinding {
  effect: EffectKey;
  trigger: Trigger;
  params: Partial<EffectParams>;
}

/** 对象的 Identity + Entrance + Ambient + Interaction 全量配置 */
export interface ObjectVisual {
  shape: ShapeKind;
  customRadius: number;    // px 0..48（CUSTOM_RADIUS / ROUNDED_RECT 微调）
  sizePreset: SizePreset;
  customWidth: number;     // px 40..1200（sizePreset=CUSTOM 时生效，容器内 clamp）
  customHeight: number;    // px 40..1200
  aspectRatio: string;     // '' | '1:1' | '4:3' | '16:9' | '3:4'
  positionX: number;       // px -40..40 平移
  positionY: number;       // px -40..40 平移
  zLayer: number;          // 0..9 图层顺序
  entrance: EffectBinding | null;   // 入场效果（null = 继承上层/无）
  ambient: EffectKey | null;        // 环境层效果（null = 无）
  interaction: 'NONE' | 'LIFT' | 'GLOW' | 'TILT'; // 悬停反馈
  accentColor: string;     // 主色调（枚举白名单 token，非自由色值）
  mobileScale: number;     // 50..100 移动端缩放 %
}

/** 时间轴片段（任务书 §八：顺序编排 + 时间参数，可靠优先） */
export interface TimelineSegment {
  id: string;              // 受控生成 seg-<n>
  target: ObjectTarget;
  effect: EffectKey;
  start: number;           // ms 0..6000
  duration: number;        // ms 200..3000
  intensity: number;       // 0..100
}

/** 事件绑定（真实业务事件 → 表现反馈） */
export interface EventBinding {
  enabled: boolean;
  effect: EffectKey;
  intensity: number;       // 0..100
  duration: number;        // ms 400..2500
}

/** 顶层视觉配置（发布/预设/全局默认共用此结构） */
export interface VisualConfig {
  version: 1;
  perfMode: PerfMode;
  /** 背景/全局氛围（BACKGROUND 对象独立细配之外的整体光效开关） */
  ambientEnabled: boolean;
  objects: Partial<Record<ObjectTarget, Partial<ObjectVisual>>>;
  timeline: TimelineSegment[];
  events: Partial<Record<EventKey, EventBinding>>;
}

/** 完整对象视图（resolve 后：对象未配置项逐级回落 global → 内置兜底，字段全量必填） */
export type ResolvedObjectVisual = ObjectVisual;

export interface ResolvedVisualConfig {
  version: 1;
  perfMode: PerfMode;
  ambientEnabled: boolean;
  objects: Record<ObjectTarget, ResolvedObjectVisual>;
  timeline: TimelineSegment[];
  events: Record<EventKey, EventBinding>;
  /** 继承来源标记（管理端展示用；客户端渲染不消费） */
  _meta?: { source: 'individual' | 'preset' | 'global' | 'default'; presetName?: string | null };
}

/** 玩家侧公开接口返回（绝不含草稿/审计字段） */
export interface PublicVisualPayload {
  playerId: string;
  enabled: boolean;
  config: VisualConfig | null;   // null = 引擎默认
  presetName: string | null;
}

/** 主色调 token 白名单（非自由色值 → 无注入面，随主题变量映射） */
export const ACCENT_TOKENS = ['inherit', 'jade', 'gold', 'crimson', 'violet', 'cyan', 'amber'] as const;
export type AccentToken = (typeof ACCENT_TOKENS)[number];
