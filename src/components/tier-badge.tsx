// ============================================================
// Component: TierBadge — 段位徽章（CG-1 现成组件升级 / P2 统一）
// 结构借鉴：Trophy UI Achievement Badge（MIT，github.com/trophyso/ui，
// 证据：docs/component-upgrade/sources/trophy-ui/）
// 色板来源：tierPillStyle()（w5 系列对比度审计成果，零色值漂移）
// 结构升级（不只是换色/圆角）：
//   1. 段位带菱形标 —— HT(紫)/LT(铁灰)/LZ(金)/LL(暗金) 带族即时可辨，
//      与项目 MC 像素质感呼应
//   2. 稀有段微光 —— HT1/HT2/LZ/LL 加同带色 box-shadow（稀有段位展示）
// 尺寸变体（P2 统一详情弹窗矩阵时新增）：
//   sm = 9 模式矩阵格（紧凑）/ md = 榜单行主 chip（默认）/ lg = 身份块徽章
//   尺寸样式由组件自有 CSS 类（.lgx-tb-*）全权负责——调用方不再传
//   text-/px- 覆盖（globals.css 非分层样式优先级高于 Tailwind 工具层，
//   外部覆盖会静默失效，故收口到组件内）。
// 个性标签样式（tagStyle）：管理员后台「个性标签」编辑器产出。
//   bgEffect = rainbow/gold/goldMix → 覆盖背景为流动渐变 + 发光
//   textEffect = rainbow(扫光)/gold → 覆盖文字为渐变（rainbow 带循环扫光）
//   textColor = 任意 hex → 仅在 textEffect=none 时作为文字色生效
// 实现要点：CSS 渐变类依赖 background/color 不被 inline 覆盖，故有效果时
// 组件不再下发 inline background/color/border，让位给 globals.css 的 .tag-* 类。
// 纯 CSS + 复用 .lgx-tier 基类；display-only，零业务逻辑。
// ============================================================
import { cn } from '@/lib/utils';
import { tierPillStyle } from '@/lib/ui-utils';
import { TAG_BG_DEFAULT_TEXT, type TagStyle } from '@/lib/tag-styles';

export type TierBadgeSize = 'sm' | 'md' | 'lg';

export function TierBadge({ tier, size = 'md', tagStyle, className }: {
  tier: string;
  size?: TierBadgeSize;
  tagStyle?: TagStyle | null;
  className?: string;
}) {
  const style = tierPillStyle(tier);
  if (!style) return null;
  const band = tier.startsWith('HT') ? '#c084fc'
    : tier.startsWith('LZ') ? '#fbbf24'
    : tier.startsWith('LL') ? '#b49628'
    : '#94a3b8';
  const n = parseInt(tier.slice(2), 10);
  const rare = tier.startsWith('LZ') || tier.startsWith('LL') || (tier.startsWith('HT') && n <= 2);

  const bgEffect = tagStyle?.bgEffect ?? 'none';
  const textEffect = tagStyle?.textEffect ?? 'none';
  const textColor = tagStyle?.textColor ?? '';
  const hasBgEffect = bgEffect !== 'none';
  const hasTextEffect = textEffect !== 'none';

  return (
    <span
      className={cn(
        'lgx-tier lgx-tb',
        size !== 'md' && `lgx-tb-${size}`,
        hasBgEffect && `tag-bg-${bgEffect}`,
        className,
      )}
      style={{
        // 无背景效果：用段位原色背景 + 边框；有背景效果：让位给 .tag-bg-* 渐变类
        ...(hasBgEffect ? {} : { background: style.bg, border: `1px solid ${style.border}` }),
        // 无文字效果：自定义颜色 > 背景效果配套深色（亮底配深字保对比度）> 段位原色；
        // 有文字效果：文字由内层 .tag-text-* 渐变接管，外层不下发 color
        ...(hasTextEffect ? {} : { color: textColor || (hasBgEffect ? TAG_BG_DEFAULT_TEXT[bgEffect] : style.color) }),
        // 稀有段微光：仅在没有背景效果时叠加（背景效果自带发光，避免冲突）
        ...(rare && !hasBgEffect ? { boxShadow: `0 0 10px ${band}2e, inset 0 0 6px rgba(255,255,255,0.05)` } : null),
      }}
    >
      {/* 背景效果激活时隐藏菱形标（效果即视觉主体）；否则保留带族纹理 */}
      {!hasBgEffect && <span className="lgx-tb-gem" style={{ background: band }} aria-hidden="true" />}
      {/* 文字光效：渐变画在内层 span 的 background 上（background-clip:text）。
          若直接挂在外层，会被 inline 段位底色覆盖（inline 优先级 > 类）→
          渐变丢失 + text-fill-color transparent = 文字隐形（实测踩坑）。
          内层方案：外层保留段位胶囊底色，内层只负责渐变文字，互不干扰。 */}
      {hasTextEffect ? <span className={`tag-text-${textEffect}`}>{tier}</span> : tier}
    </span>
  );
}
