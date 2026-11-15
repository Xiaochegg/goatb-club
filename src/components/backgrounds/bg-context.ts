// ============================================================
// bg-context.ts — 能力检测（D 卷六.4）
// 控制器启动时跑一次，结果通过 ctx 传给所有插件。
// 插件不用各自判断 reducedMotion / lowEnd / WebGL。
// ============================================================

export interface BGCapability {
  /** 低端机：内存≤2GB 或 核心≤2 */
  lowEnd: boolean;
  /** 是否支持 WebGL（预留给 Three.js 类插件） */
  hasWebGL: boolean;
  /** 用户是否开启「减少动态效果」 */
  reducedMotion: boolean;
}

export function detectCapability(): BGCapability {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 8;
  const cores = navigator.hardwareConcurrency || 4;
  const lowEnd = mem <= 2 || cores <= 2;

  let hasWebGL = false;
  try {
    const c = document.createElement('canvas');
    hasWebGL = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    hasWebGL = false;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return { lowEnd, hasWebGL, reducedMotion };
}
