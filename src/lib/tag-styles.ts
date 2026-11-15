// ============================================================
// 玩家个性标签样式（Player Tag Style）
// 管理员后台「个性标签」编辑器与 TierBadge 渲染共用。
// 存储于 Config.player_tag_styles，值为 JSON：{ "<playerId>": TagStyle }
// 不改 Prisma Schema；复用 /api/v1/config GET/PUT。
// ============================================================

export type TagBgEffect = 'none' | 'rainbow' | 'gold' | 'goldMix' | 'silverGold';
export type TagTextEffect = 'none' | 'rainbow' | 'gold';

export interface TagStyle {
  bgEffect: TagBgEffect;
  textEffect: TagTextEffect;
  textColor: string; // 任意自定义颜色（hex），'' 表示用段位默认色
}

export const DEFAULT_TAG_STYLE: TagStyle = {
  bgEffect: 'none',
  textEffect: 'none',
  textColor: '',
};

export const TAG_BG_EFFECTS: { value: TagBgEffect; label: string; desc: string }[] = [
  { value: 'none', label: '默认背景', desc: '使用段位原色背景' },
  { value: 'rainbow', label: '彩虹背景光效', desc: '分层全息彩虹：oklch 高光带扫过流光底（旧浏览器自动降级纯流光）' },
  { value: 'gold', label: '金色背景光效', desc: '金属三层质感：暗金→金→高光→金→暗金' },
  { value: 'goldMix', label: '金银混色流光', desc: '金→亮金→银白高光→银灰，光泽流动' },
  { value: 'silverGold', label: '银底金边', desc: '银色基底 + 金色渐变描边，层次分明' },
];

export const TAG_TEXT_EFFECTS: { value: TagTextEffect; label: string; desc: string }[] = [
  { value: 'none', label: '默认文字', desc: '使用段位原色 / 自定义颜色' },
  { value: 'rainbow', label: '彩虹文字光效（专属独特·扫光）', desc: '彩虹渐变文字 + 循环扫光动效' },
  { value: 'gold', label: '金色文字光效', desc: '金色渐变文字 + 暖光' },
];

const VALID_BG: TagBgEffect[] = TAG_BG_EFFECTS.map(e => e.value);
const VALID_TEXT: TagTextEffect[] = TAG_TEXT_EFFECTS.map(e => e.value);

/** 背景光效激活时的默认文字色（亮底配深字，保证对比度；规格建议的深色文字）。
 *  textEffect 或自定义 textColor 优先级更高。 */
export const TAG_BG_DEFAULT_TEXT: Record<Exclude<TagBgEffect, 'none'>, string> = {
  rainbow: '#0b0b14',
  gold: '#3a2c07',
  goldMix: '#1a1a1a',
  silverGold: '#2a2a2a',
};

/** 解析 Config.player_tag_styles 的 JSON 值；非法/缺失返回空映射 */
export function parseTagStyles(raw: string | null | undefined): Record<string, TagStyle> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, TagStyle> = {};
    for (const [pid, v] of Object.entries(obj)) {
      if (!pid || v == null || typeof v !== 'object') continue;
      const s = v as Partial<TagStyle>;
      out[pid] = {
        bgEffect: VALID_BG.includes(s.bgEffect as TagBgEffect) ? (s.bgEffect as TagBgEffect) : 'none',
        textEffect: VALID_TEXT.includes(s.textEffect as TagTextEffect) ? (s.textEffect as TagTextEffect) : 'none',
        textColor: typeof s.textColor === 'string' && /^#?[0-9a-fA-F]{0,8}$/.test(s.textColor) ? s.textColor : '',
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeTagStyles(map: Record<string, TagStyle>): string {
  return JSON.stringify(map);
}
