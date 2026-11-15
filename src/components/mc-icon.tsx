// ============================================================
// McIcon — Minecraft 像素风图标渲染组件（Task 43）
//
// 用法：<McIcon src={MODE_ICONS.SHIELD} className="w-4 h-4" />
// 接收 data URI 字符串，渲染 <img>，image-rendering: pixelated 保像素感
// ============================================================
import { cn } from '@/lib/utils';
import { MODE_ICONS, XT_MODE_ICONS, type GameMode } from '@/lib/constants';

export function McIcon({
  src,
  className,
  alt = '',
}: {
  src: string;
  className?: string;
  alt?: string;
}) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden="true"
      className={cn('inline-block align-middle [image-rendering:pixelated]', className)}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

// ============================================================
// ModeIcon — 模式图标统一入口（XT-SPEC 追补：个人面板图标对齐榜单）
// 有 XT 实拍图的模式（SWORD/MACE/SMP/POT/NPOT/UHC）渲染深底实拍 <img>
// （.xtlb-mode-icon 提供 mix-blend-mode: screen 融合，与榜单同款）；
// 无 XT 对应物的模式（SHIELD/CRYSTAL/JIAHAO 等）回退 MC 像素 SVG。
// 尺寸档：xs=10px（个人胶囊段位 rail）/ sm=12px（详情弹窗矩阵、侧栏）/
//         md=16px（榜单行默认）/ chip=18px（单模式榜芯片）
// 注意：.xtlb-mode-icon 系 globals.css 非分层样式，优先级高于 Tailwind
//       工具层——外部 w-* 覆盖会静默失效，尺寸必须走档位类（P2 踩坑同源）。
// ============================================================
export type ModeIconSize = 'xs' | 'sm' | 'md' | 'chip';

const XT_SIZE_CLASS: Record<ModeIconSize, string> = {
  xs: 'xtlb-mode-icon xtlb-mode-icon-xs',
  sm: 'xtlb-mode-icon xtlb-mode-icon-sm',
  md: 'xtlb-mode-icon',
  chip: 'xtlb-mode-icon xtlb-mode-icon-chip',
};

const PIXEL_SIZE_CLASS: Record<ModeIconSize, string> = {
  xs: 'w-2.5 h-2.5',
  sm: 'w-3 h-3',
  md: 'w-4 h-4',
  chip: 'w-[18px] h-[18px]',
};

export function ModeIcon({
  mode,
  size = 'md',
  className,
}: {
  mode: GameMode;
  size?: ModeIconSize;
  className?: string;
}) {
  const xt = XT_MODE_ICONS[mode];
  if (xt) {
    return (
      <img
        src={xt}
        alt=""
        aria-hidden="true"
        decoding="async"
        className={cn(XT_SIZE_CLASS[size], className)}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }
  return (
    <McIcon
      src={MODE_ICONS[mode]}
      className={cn(PIXEL_SIZE_CLASS[size], 'shrink-0', className)}
    />
  );
}
