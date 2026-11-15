// ============================================================
// bg-registry — 插件注册表 + 降级链（D 卷四.1）
// 新增背景只改这一个文件：import + 注册 + 放进 chain。
// ============================================================

import type { BGPlugin } from './bg-types';
import { threeNetBg } from './plugins/three-net';
import { threeBasicBg } from './plugins/three-bg';
import { particlesBg } from './plugins/particles-bg';
import { staticGradientBg } from './plugins/static-gradient-bg';

export const BG_REGISTRY: Record<string, BGPlugin> = {
  'three-net': threeNetBg,
  'three-basic': threeBasicBg,
  'particles': particlesBg,
  'static-gradient': staticGradientBg,
};

// 降级链：低端机/无能力时自动降级到后面的。
// 顺序即优先级——控制器按 chain 顺序找第一个能跑的。
// three-net 放最前（FX-07）：支持 WebGL 的桌面优先「点云连线」氛围网（Vanta NET 复刻）；
// three-basic（金线框立方体）保留可手动选；lowEnd / 无 WebGL 由 canRun 跳过，
// 自动落到 particles。
export const BG_FALLBACK_CHAIN = ['three-net', 'three-basic', 'particles', 'static-gradient'];
