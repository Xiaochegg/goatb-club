// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — 三级继承合并器
// （任务书 §十：Individual Player Override > Group Preset > Global Default）
// ------------------------------------------------------------
// 合并语义：
//   - 对象级 partial 深合并（键覆盖：上层未配置的键逐级回落）；
//   - entrance 绑定整体替换（不做绑定内键合并，语义清晰：
//     「换效果」必然换参数；要微调参数就在本层写全）；
//   - 事件绑定整体替换；时间轴整体替换（编排是整体作品，不做片段拼接）；
//   - perfMode / ambientEnabled 取最高优先层显式值。
// 合并顺序：parts[0] = global（最低）→ parts[n-1] = individual（最高）。
// ============================================================

import {
  DEFAULT_OBJECT, sanitizeVisualConfig,
} from './schema';
import {
  EVENT_KEYS, OBJECT_TARGETS,
  type EventBinding, type ObjectTarget, type ResolvedObjectVisual,
  type ResolvedVisualConfig, type VisualConfig,
} from './types';

/** 对象默认完整观感（OBJECT_TARGETS 全量兜底；entrance null = 不播入场） */
function defaultResolvedObject(target: ObjectTarget): ResolvedObjectVisual {
  const base: ResolvedObjectVisual = { ...DEFAULT_OBJECT };
  // 兜底差异化：背景永远沉底、头像最上层，符合图层直觉
  if (target === 'BACKGROUND') base.zLayer = 0;
  if (target === 'AVATAR') base.zLayer = 3;
  if (target === 'FLOATING_PANEL') base.zLayer = 4;
  return base;
}

function mergeObjectPartial(base: ResolvedObjectVisual, partial: Partial<ResolvedObjectVisual> | undefined): ResolvedObjectVisual {
  if (!partial) return base;
  const merged: ResolvedObjectVisual = { ...base };
  for (const key of Object.keys(partial) as Array<keyof ResolvedObjectVisual>) {
    const v = partial[key];
    if (v !== undefined) {
      // entrance 允许显式 null（关闭该层入场并阻止继续回落）
      (merged as Record<string, unknown>)[key] = v;
    }
  }
  return merged;
}

/**
 * 合并多级配置。约定调用方传参顺序 = 优先级从低到高：
 * resolveEffectiveConfig([global, presetConfig, individualConfig])
 * 任一层可为 null（该层无配置）。全部为 null → 引擎默认。
 */
export function resolveEffectiveConfig(parts: Array<VisualConfig | null>): ResolvedVisualConfig {
  const valid = parts.filter((p): p is VisualConfig => p !== null);
  const top = valid[valid.length - 1] ?? null;

  const objects = {} as Record<ObjectTarget, ResolvedObjectVisual>;
  for (const target of OBJECT_TARGETS) {
    let acc = defaultResolvedObject(target);
    for (const part of valid) {
      acc = mergeObjectPartial(acc, part.objects?.[target] as Partial<ResolvedObjectVisual> | undefined);
    }
    objects[target] = acc;
  }

  // 事件绑定：仅取最高优先层的事件表（事件语义整体性优先，避免跨层拼装误触发）
  const events = {} as Record<EventKey, EventBinding>;
  for (const key of EVENT_KEYS) {
    events[key] = {
      enabled: false,
      effect: 'PHOTON',
      intensity: 70,
      duration: 900,
    };
  }
  if (top) {
    for (const key of EVENT_KEYS) {
      const b = top.events?.[key];
      if (b) events[key] = { ...b };
    }
  }

  const timeline = top?.timeline ? top.timeline.map(s => ({ ...s })) : [];

  return {
    version: 1,
    perfMode: top?.perfMode ?? 'FULL',
    ambientEnabled: top?.ambientEnabled ?? false,
    objects,
    timeline,
    events,
    _meta: { source: 'default' },
  };
}

/**
 * 服务端便捷入口：从三个原始 JSON 串解析并合并。
 * 任一串损坏 → 该层按 null 处理（安全回退，绝不抛错）。
 */
export function resolveFromJson(globalJson: string | null, presetJson: string | null, individualJson: string | null): ResolvedVisualConfig {
  const g = globalJson ? sanitizeVisualConfig(safeParse(globalJson)) : null;
  const p = presetJson ? sanitizeVisualConfig(safeParse(presetJson)) : null;
  const i = individualJson ? sanitizeVisualConfig(safeParse(individualJson)) : null;
  return resolveEffectiveConfig([g, p, i]);
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
}
