// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 服务端校验 / 钳制 / 默认配置
// （任务书 §十二：服务端 Schema 验证、大小限制和枚举白名单；
//   任务书 §十三：禁止任意 JS/CSS/HTML 入配置）
// ------------------------------------------------------------
// 项目无 zod 依赖（性能红线 §14：不为简单功能引大依赖）→
// 手写白名单校验器：未知键一律丢弃、数值一律钳制、枚举一律白名单。
// 校验永不抛异常（脏输入 → 就近合法值），保证「配置读取失败安全回退默认」。
// ============================================================

import {
  ACCENT_TOKENS, DIRECTIONS, EASINGS, EFFECT_KEYS, EVENT_KEYS, OBJECT_TARGETS,
  PERF_MODES, SHAPE_KINDS, SIZE_PRESETS, TRIGGERS,
  type EffectBinding, type ObjectTarget, type ObjectVisual,
  type PerfMode, type TimelineSegment, type VisualConfig,
} from './types';

/** 序列化后体积上限（任务书 §十二：大小限制） */
export const VISUAL_CONFIG_MAX_BYTES = 16 * 1024;

// ── 数值钳制边界（单一事实源，编辑器 UI 同步引用） ──
export const BOUNDS = {
  duration: [200, 3000] as const,
  delay: [0, 3000] as const,
  intensity: [0, 100] as const,
  iteration: [0, 3] as const,
  opacity: [0, 100] as const,
  scale: [50, 120] as const,
  customRadius: [0, 48] as const,
  customWidth: [40, 1200] as const,
  customHeight: [40, 1200] as const,
  positionXY: [-40, 40] as const,
  zLayer: [0, 9] as const,
  mobileScale: [50, 100] as const,
  timelineStart: [0, 6000] as const,
  eventDuration: [400, 2500] as const,
  timelineMaxSegments: 12,
} as const;

const clampNum = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
};

const pickEnum = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : fallback;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── 效果参数 ──
export function sanitizeEffectParams(v: unknown): Partial<EffectBinding['params']> {
  if (!isObj(v)) return {};
  const out: Record<string, unknown> = {};
  if ('duration' in v) out.duration = clampNum(v.duration, BOUNDS.duration, 700);
  if ('delay' in v) out.delay = clampNum(v.delay, BOUNDS.delay, 0);
  if ('intensity' in v) out.intensity = clampNum(v.intensity, BOUNDS.intensity, 60);
  if ('direction' in v) out.direction = pickEnum(v.direction, DIRECTIONS, 'center');
  if ('easing' in v) out.easing = pickEnum(v.easing, EASINGS, 'cubic-bezier(0.22, 1, 0.36, 1)');
  if ('iteration' in v) out.iteration = clampNum(v.iteration, BOUNDS.iteration, 1);
  if ('opacity' in v) out.opacity = clampNum(v.opacity, BOUNDS.opacity, 100);
  if ('scale' in v) out.scale = clampNum(v.scale, BOUNDS.scale, 100);
  return out;
}

// ── 入场效果绑定 ──
export function sanitizeEffectBinding(v: unknown): EffectBinding | null {
  if (!isObj(v)) return null;
  if (!('effect' in v) || (v.effect !== null && typeof v.effect !== 'string')) return null;
  if (v.effect === null) return null; // 显式 null = 关闭入场（继承链终止）
  if (!(EFFECT_KEYS as readonly string[]).includes(v.effect)) return null;
  return {
    effect: v.effect as EffectBinding['effect'],
    trigger: pickEnum(isObj(v.trigger) ? undefined : v.trigger, TRIGGERS, 'AUTO'),
    params: sanitizeEffectParams(v.params),
  };
}

// ── 单对象配置 ──
export const DEFAULT_OBJECT: ObjectVisual = {
  shape: 'ROUNDED_RECT',
  customRadius: 16,
  sizePreset: 'M',
  customWidth: 320,
  customHeight: 200,
  aspectRatio: '',
  positionX: 0,
  positionY: 0,
  zLayer: 1,
  entrance: null,
  ambient: null,
  interaction: 'NONE',
  accentColor: 'inherit',
  mobileScale: 100,
};

export function sanitizeObjectVisual(v: unknown): Partial<ObjectVisual> {
  if (!isObj(v)) return {};
  const out: Record<string, unknown> = {};
  if ('shape' in v) out.shape = pickEnum(v.shape, SHAPE_KINDS, DEFAULT_OBJECT.shape);
  if ('customRadius' in v) out.customRadius = clampNum(v.customRadius, BOUNDS.customRadius, DEFAULT_OBJECT.customRadius);
  if ('sizePreset' in v) out.sizePreset = pickEnum(v.sizePreset, SIZE_PRESETS, DEFAULT_OBJECT.sizePreset);
  if ('customWidth' in v) out.customWidth = clampNum(v.customWidth, BOUNDS.customWidth, DEFAULT_OBJECT.customWidth);
  if ('customHeight' in v) out.customHeight = clampNum(v.customHeight, BOUNDS.customHeight, DEFAULT_OBJECT.customHeight);
  if ('aspectRatio' in v) {
    const ar = typeof v.aspectRatio === 'string' ? v.aspectRatio : '';
    out.aspectRatio = ['', '1:1', '4:3', '16:9', '3:4'].includes(ar) ? ar : '';
  }
  if ('positionX' in v) out.positionX = clampNum(v.positionX, BOUNDS.positionXY, 0);
  if ('positionY' in v) out.positionY = clampNum(v.positionY, BOUNDS.positionXY, 0);
  if ('zLayer' in v) out.zLayer = clampNum(v.zLayer, BOUNDS.zLayer, 1);
  if ('entrance' in v) out.entrance = sanitizeEffectBinding(v.entrance);
  if ('ambient' in v) {
    out.ambient = typeof v.ambient === 'string' && (EFFECT_KEYS as readonly string[]).includes(v.ambient)
      ? v.ambient : null;
  }
  if ('interaction' in v) {
    const inter = v.interaction;
    out.interaction = typeof inter === 'string' && ['NONE', 'LIFT', 'GLOW', 'TILT'].includes(inter)
      ? inter : 'NONE';
  }
  if ('accentColor' in v) out.accentColor = pickEnum(v.accentColor, ACCENT_TOKENS, 'inherit');
  if ('mobileScale' in v) out.mobileScale = clampNum(v.mobileScale, BOUNDS.mobileScale, 100);
  return out;
}

// ── 时间轴 ──
export function sanitizeTimeline(v: unknown): TimelineSegment[] {
  if (!Array.isArray(v)) return [];
  const out: TimelineSegment[] = [];
  v.slice(0, BOUNDS.timelineMaxSegments).forEach((raw, i) => {
    if (!isObj(raw)) return;
    const target = typeof raw.target === 'string' && (OBJECT_TARGETS as readonly string[]).includes(raw.target)
      ? raw.target as ObjectTarget : null;
    const effect = typeof raw.effect === 'string' && (EFFECT_KEYS as readonly string[]).includes(raw.effect)
      ? raw.effect : null;
    if (!target || !effect) return;
    out.push({
      id: `seg-${i + 1}`,
      target,
      effect: effect as TimelineSegment['effect'],
      start: clampNum(raw.start, BOUNDS.timelineStart, i * 200),
      duration: clampNum(raw.duration, BOUNDS.duration, 700),
      intensity: clampNum(raw.intensity, BOUNDS.intensity, 60),
    });
  });
  // start 升序稳定排序（时间轴语义）
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

// ── 事件绑定 ──
export function sanitizeEvents(v: unknown): VisualConfig['events'] {
  if (!isObj(v)) return {};
  const out: VisualConfig['events'] = {};
  for (const key of EVENT_KEYS) {
    const raw = v[key];
    if (!isObj(raw)) continue;
    if (typeof raw.enabled !== 'boolean') continue; // enabled 必须显式
    const effect = typeof raw.effect === 'string' && (EFFECT_KEYS as readonly string[]).includes(raw.effect)
      ? raw.effect as (typeof EFFECT_KEYS)[number]
      : null;
    if (!effect) continue;
    out[key] = {
      enabled: raw.enabled,
      effect: effect as (typeof EFFECT_KEYS)[number],
      intensity: clampNum(raw.intensity, BOUNDS.intensity, 70),
      duration: clampNum(raw.duration, BOUNDS.eventDuration, 900),
    };
  }
  return out;
}

// ── 顶层配置（服务端唯一入口；脏输入安全回退） ──
export function sanitizeVisualConfig(input: unknown): VisualConfig {
  const safe: VisualConfig = {
    version: 1,
    perfMode: 'FULL',
    ambientEnabled: true,
    objects: {},
    timeline: [],
    events: {},
  };
  try {
    if (!isObj(input)) return safe;
    if ('perfMode' in input) safe.perfMode = pickEnum(input.perfMode, PERF_MODES, 'FULL') as PerfMode;
    if ('ambientEnabled' in input) safe.ambientEnabled = input.ambientEnabled === true;
    if (isObj(input.objects)) {
      for (const target of OBJECT_TARGETS) {
        if (target in input.objects) {
          const partial = sanitizeObjectVisual(input.objects[target]);
          if (Object.keys(partial).length > 0) safe.objects[target] = partial;
        }
      }
    }
    safe.timeline = sanitizeTimeline(input.timeline);
    safe.events = sanitizeEvents(input.events);
  } catch {
    return safe;
  }
  return safe;
}

/** 存库前序列化（含体积硬限制：超限返回 null，调用方 400） */
export function serializeVisualConfig(config: VisualConfig): string | null {
  try {
    const json = JSON.stringify(config);
    if (json.length > VISUAL_CONFIG_MAX_BYTES) return null;
    return json;
  } catch {
    return null;
  }
}

/** 读库反序列化（损坏 JSON → null，调用方回退默认/继承链） */
export function parseVisualConfig(json: string | null | undefined): VisualConfig | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return sanitizeVisualConfig(parsed);
  } catch {
    return null;
  }
}

// ============================================================
// 引擎默认配置（未做任何管理配置时的观感 = 站点既有品味：
// 轻量上浮入场 + 无环境粒子 + 无主色注入，接近"原生"体验）
// ============================================================
export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  version: 1,
  perfMode: 'FULL',
  ambientEnabled: false,
  objects: {},
  timeline: [],
  events: {},
};
