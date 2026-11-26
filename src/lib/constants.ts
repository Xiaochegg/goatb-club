// GOATB Community Leaderboard - Constants & Types
// ============================================================
import { MC_ICONS } from './mc-icons';

// --- Mode Definitions ---
// 2026-10 新增模式：DSMP / 矛锤（SPEAR_MACE）/ 矿车（MINECART）
// 三者均为普通模式：沿用统一 HT/LT 段位表与点数表（NORMAL_TIER_SCORES），
// 段位分自动计入总榜（NORMAL_MODES 驱动），无需新计分标准。
// 2026-11 新增娱乐模式：小鸟（BIRD）——用户指令 2026-11-01：
//   ① 娱乐模式，与嘉豪共用嘉豪积分体系（LZ/LL 段位 × JIAHAO_TIER_SCORES 点数表）
//   ② 不计入总榜（不入 NORMAL_MODES，与嘉豪同待遇）
//   ③ 上榜规则：小鸟闯关达成全三星（★★★）才能上榜（说明面板/规则文案承载）
//   ④ Tab 顺序：嘉豪移至最后，小鸟紧随其前（娱乐区收尾）
export type GameMode = 'SHIELD' | 'CRYSTAL' | 'SWORD' | 'DIAMOND_POTION' | 'ALLOY_POTION' | 'JIAHAO' | 'MACE' | 'BUHC' | 'SMP' | 'DSMP' | 'SPEAR_MACE' | 'MINECART' | 'BIRD';
export type BoardMode = 'TOTAL' | 'EMOTION' | GameMode;
// 娱乐模式（嘉豪积分体系，不计入总榜）：嘉豪 / 小鸟
export type FunMode = 'JIAHAO' | 'BIRD';
export type NormalMode = Exclude<GameMode, FunMode>;

export const NORMAL_MODES: NormalMode[] = ['SHIELD', 'CRYSTAL', 'SWORD', 'DIAMOND_POTION', 'ALLOY_POTION', 'MACE', 'BUHC', 'SMP', 'DSMP', 'SPEAR_MACE', 'MINECART'];
export const ALL_MODES: GameMode[] = ['SHIELD', 'CRYSTAL', 'SWORD', 'DIAMOND_POTION', 'ALLOY_POTION', 'MACE', 'BUHC', 'SMP', 'DSMP', 'SPEAR_MACE', 'MINECART', 'BIRD', 'JIAHAO'];

export const MODE_LABELS: Record<GameMode, string> = {
  SHIELD: '盾斧',
  CRYSTAL: '水晶',
  SWORD: '剑斗',
  DIAMOND_POTION: '钻石药水',
  ALLOY_POTION: '合金药水',
  JIAHAO: '嘉豪',
  MACE: '重锤',
  BUHC: 'BUHC',
  SMP: 'SMP',
  DSMP: 'DSMP',
  SPEAR_MACE: '矛锤',
  MINECART: '矿车',
  BIRD: '小鸟',
};

// Task 43：MODE_ICONS 改为 MC 像素风 SVG data URI（自绘，零版权/零网络依赖）
// 渲染处需用 <img src={icon} /> 替代原 emoji span（见 mc-icon.tsx McIcon 组件）
export const MODE_ICONS: Record<GameMode, string> = {
  SHIELD:          MC_ICONS.SHIELD,
  CRYSTAL:         MC_ICONS.CRYSTAL,
  SWORD:           MC_ICONS.SWORD,
  DIAMOND_POTION:  MC_ICONS.DIAMOND_POTION,
  ALLOY_POTION:    MC_ICONS.ALLOY_POTION,
  JIAHAO:          MC_ICONS.JIAHAO,
  MACE:             MC_ICONS.MACE,
  BUHC:             MC_ICONS.BUHC,
  SMP:              MC_ICONS.SMP,
  DSMP:             MC_ICONS.DSMP,
  SPEAR_MACE:       MC_ICONS.SPEAR_MACE,
  MINECART:         MC_ICONS.MINECART,
  BIRD:             MC_ICONS.BIRD,
};

export const BOARD_TABS: { key: BoardMode; label: string; icon: string }[] = [
  { key: 'TOTAL', label: '总榜', icon: MC_ICONS.TOTAL },
  { key: 'EMOTION', label: '感动榜', icon: MC_ICONS.EMOTION },
  { key: 'SHIELD', label: '盾斧', icon: MC_ICONS.SHIELD },
  { key: 'CRYSTAL', label: '水晶', icon: MC_ICONS.CRYSTAL },
  { key: 'SWORD', label: '剑斗', icon: MC_ICONS.SWORD },
  { key: 'DIAMOND_POTION', label: '钻石药水', icon: MC_ICONS.DIAMOND_POTION },
  { key: 'ALLOY_POTION', label: '合金药水', icon: MC_ICONS.ALLOY_POTION },
  { key: 'MACE', label: '重锤', icon: MC_ICONS.MACE },
  { key: 'BUHC', label: 'BUHC', icon: MC_ICONS.BUHC },
  { key: 'SMP', label: 'SMP', icon: MC_ICONS.SMP },
  { key: 'DSMP', label: 'DSMP', icon: MC_ICONS.DSMP },
  { key: 'SPEAR_MACE', label: '矛锤', icon: MC_ICONS.SPEAR_MACE },
  { key: 'MINECART', label: '矿车', icon: MC_ICONS.MINECART },
  // 2026-11-01 用户指令：娱乐区收尾 —— 嘉豪移至最后，小鸟紧随其前
  { key: 'BIRD', label: '小鸟', icon: MC_ICONS.BIRD },
  { key: 'JIAHAO', label: '嘉豪', icon: MC_ICONS.JIAHAO },
];

// --- Tier Definitions ---
// 段位体系（用户指令 2026-10：撤掉 XT 模板带来的 MT/RHT/RMT/RLT/R-F 命名，
// 还原本站原版 10 档 = HT/LT × Tier1-5；嘉豪 LZ/LL 体系不动——硬约束）：
// - XT 规格的表格形态（四列总榜/分组矩阵/实拍图标/中文称号）保留，仅段位阶梯回归原版
// - DB 普查（scripts/_tier-census.ts，用后即删）确认零 MT/RHT/R-F 存量数据，裁剪零迁移
// - 点数表沿用现值（HT1=40…LT5=1），积分/排名零波动；原版点数表为
//   HT1:50/LT1:40/HT2:30/LT2:25/HT3:20/LT3:15/HT4:10/LT4:5/HT5:3/LT5:1，
//   若连点数一并还原图会影响总榜跨模式次序，需用户确认后再动
export type NormalTier =
  | 'HT1' | 'LT1'
  | 'HT2' | 'LT2'
  | 'HT3' | 'LT3'
  | 'HT4' | 'LT4'
  | 'HT5' | 'LT5';
export type JiahaoTier = 'LZ1' | 'LL1' | 'LZ2' | 'LL2' | 'LZ3' | 'LL3' | 'LZ4' | 'LL4' | 'LZ5' | 'LL5';
export type Tier = NormalTier | JiahaoTier;

// 管理选择列表（原版顺序：HT/LT 交替）
export const NORMAL_TIERS: NormalTier[] = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
export const JIAHAO_TIERS: JiahaoTier[] = ['LZ1', 'LL1', 'LZ2', 'LL2', 'LZ3', 'LL3', 'LZ4', 'LL4', 'LZ5', 'LL5'];

// 点数表（HT/LT 阶梯沿用现值，积分零波动；见 Tier Definitions 注释）
export const NORMAL_TIER_SCORES: Record<NormalTier, number> = {
  HT1: 40, LT1: 35,
  HT2: 25, LT2: 20,
  HT3: 15, LT3: 10,
  HT4: 7,  LT4: 5,
  HT5: 3,  LT5: 1,
};

export const JIAHAO_TIER_SCORES: Record<JiahaoTier, number> = {
  LZ1: 4550, LL1: 4550,
  LZ2: 3650, LL2: 3650,
  LZ3: 2750, LL3: 2750,
  LZ4: 1850, LL4: 1850,
  LZ5: 950,  LL5: 950,
};

export function getTiersForMode(mode: GameMode): Tier[] {
  // 娱乐模式（嘉豪/小鸟）共用 LZ/LL 段位体系
  if (mode === 'JIAHAO' || mode === 'BIRD') return JIAHAO_TIERS;
  return NORMAL_TIERS;
}

// XT 单模式榜分组（模式感知：嘉豪/小鸟走 LZ/LL 映射）
export function getXtTierGroupsForMode(mode: GameMode): Array<{ label: string; tiers: string[] }> {
  if (mode === 'JIAHAO' || mode === 'BIRD') return XT_JIAHAO_TIER_GROUPS;
  return XT_TIER_GROUPS;
}

// --- Tier Colors ---
// 注：TIER_COLORS/TIER_BG_COLORS 为旧组件（tier-badge/说明面板/管理后台）用色板。
// XT 规格新表格的徽章配色走 .xtlb-t1~t5 CSS（见 xt-leaderboard）。
// MT/RHT/RMT/RLT/R-F 键已随段位裁剪移除（2026-10，DB 无存量数据）。
export const TIER_COLORS: Record<string, string> = {
  HT1: '#D4AF37', LT1: '#C9A02C',
  HT2: '#9A7B2A', LT2: '#7D6322',
  HT3: '#805010', LT3: '#604008',
  HT4: '#403008', LT4: '#302004',
  HT5: '#201004', LT5: '#180802',
  LZ1: '#D4AF37', LL1: '#C9A02C',
  LZ2: '#9A7B2A', LL2: '#7D6322',
  LZ3: '#805010', LL3: '#604008',
  LZ4: '#403008', LL4: '#302004',
  LZ5: '#201004', LL5: '#180802',
};

export const TIER_BG_COLORS: Record<string, string> = {
  HT1: 'rgba(212,175,55,0.25)', LT1: 'rgba(201,160,44,0.2)',
  HT2: 'rgba(154,123,42,0.2)', LT2: 'rgba(125,99,34,0.18)',
  HT3: 'rgba(128,80,16,0.18)', LT3: 'rgba(96,64,8,0.15)',
  HT4: 'rgba(64,48,8,0.15)', LT4: 'rgba(48,32,4,0.12)',
  HT5: 'rgba(32,16,4,0.12)', LT5: 'rgba(24,8,2,0.1)',
  LZ1: 'rgba(212,175,55,0.25)', LL1: 'rgba(201,160,44,0.2)',
  LZ2: 'rgba(154,123,42,0.2)', LL2: 'rgba(125,99,34,0.18)',
  LZ3: 'rgba(128,80,16,0.18)', LL3: 'rgba(96,64,8,0.15)',
  LZ4: 'rgba(64,48,8,0.15)', LL4: 'rgba(48,32,4,0.12)',
  LZ5: 'rgba(32,16,4,0.12)', LL5: 'rgba(24,8,2,0.1)',
};

// --- XT PVP Tier 规格助手（直採自 upload/xt_pvp_tier_cleaned.html 模板）---

// 头衔阶梯：按总积分分档（阈值与 XT 模板 getRankInfo 一致，含样式类名）。
// 防抄袭差异化（用户指令 2026-10）：XT 模板的英文战斗称号改为全中文，
// 阈值/样式类名保持 XT 原值不变。
export interface XtRankInfo { title: string; cssClass: string }
export const XT_RANK_TITLES_CN = [
  '战斗至尊', '战斗大师', '战斗王牌', '战斗精英',
  '战斗专家', '战斗学员', '战斗新秀', '新兵',
] as const;
export function getXtRankInfo(pointTotal: number): XtRankInfo {
  if (pointTotal >= 200) return { title: '战斗至尊', cssClass: 'xtlb-title-combatgrandmaster' };
  if (pointTotal >= 140) return { title: '战斗大师', cssClass: 'xtlb-title-combatmaster' };
  if (pointTotal >= 100) return { title: '战斗王牌', cssClass: 'xtlb-title-combatace' };
  if (pointTotal >= 75) return { title: '战斗精英', cssClass: 'xtlb-title-combatelite' };
  if (pointTotal >= 45) return { title: '战斗专家', cssClass: 'xtlb-title-combatspecialist' };
  if (pointTotal >= 20) return { title: '战斗学员', cssClass: 'xtlb-title-combatcadet' };
  if (pointTotal >= 10) return { title: '战斗新秀', cssClass: 'xtlb-title-combatnovice' };
  return { title: '新兵', cssClass: 'xtlb-title-rookie' };
}

// 未测标记（与模板 isTested 一致）：空串 / 斜杠 / UN / 未测 都不算参测
export const XT_UNTESTED_MARKERS = ['', '/', 'UN', '未测'];
export function isXtTested(tierText: string | null | undefined): boolean {
  return tierText != null && !XT_UNTESTED_MARKERS.includes(String(tierText));
}

// 徽章样式档位：按段位数字 1-5 → t1-t5，未测/未知值 → rf 兜底
export function xtTierBadgeClass(tierText: string | null | undefined): string {
  if (!isXtTested(tierText)) return 'xtlb-rf';
  const s = String(tierText).toUpperCase();
  if (/^(HT|LT)1$/.test(s)) return 'xtlb-t1';
  if (/^(HT|LT)2$/.test(s)) return 'xtlb-t2';
  if (/^(HT|LT)3$/.test(s)) return 'xtlb-t3';
  if (/^(HT|LT)4$/.test(s)) return 'xtlb-t4';
  if (/^(HT|LT)5$/.test(s)) return 'xtlb-t5';
  return 'xtlb-rf';
}

// 单模式榜分组：Tier N 组 = HTN/LTN（XT 的 MT 层与 R-F 特殊组已随档位裁剪移除）
export const XT_TIER_GROUPS: Array<{ label: string; tiers: string[] }> = [
  { label: 'Tier 1', tiers: ['HT1', 'LT1'] },
  { label: 'Tier 2', tiers: ['HT2', 'LT2'] },
  { label: 'Tier 3', tiers: ['HT3', 'LT3'] },
  { label: 'Tier 4', tiers: ['HT4', 'LT4'] },
  { label: 'Tier 5', tiers: ['HT5', 'LT5'] },
];
// 嘉豪模式分组：LZ/LL × 5（嘉豪体系不动，仅映射进 XT 表格形态）
export const XT_JIAHAO_TIER_GROUPS: Array<{ label: string; tiers: string[] }> = [
  { label: 'Tier 1', tiers: ['LZ1', 'LL1'] },
  { label: 'Tier 2', tiers: ['LZ2', 'LL2'] },
  { label: 'Tier 3', tiers: ['LZ3', 'LL3'] },
  { label: 'Tier 4', tiers: ['LZ4', 'LL4'] },
  { label: 'Tier 5', tiers: ['LZ5', 'LL5'] },
];

// XT 模式图标（实拍图资产，来自 XT 模板 base64 提取 → public/modes/xt-*.jpg）。
// 这些 JPEG 为深底实拍图，渲染时必须配合 mix-blend-mode: screen（.xtlb-mode-icon）。
// SHIELD（盾斧）→ xt-axe.jpg（XT 模板的斧图标，用户指令 2026-10：盾斧换成他们的盾斧图标）。
// 无 XT 对应物的模式（CRYSTAL/JIAHAO/TOTAL/EMOTION）保留原 MC 像素图标。
export const XT_MODE_ICONS: Partial<Record<GameMode, string>> = {
  SHIELD: '/modes/xt-axe.jpg',
  SWORD: '/modes/xt-sword.jpg',
  MACE: '/modes/xt-mace.jpg',
  SMP: '/modes/xt-smp.jpg',
  DIAMOND_POTION: '/modes/xt-pot.jpg',
  ALLOY_POTION: '/modes/xt-npot.jpg',
  BUHC: '/modes/xt-uhc.jpg',
};

// --- Theme Presets ---
// 命名规范：name 全部中文。新增主题色值只取自「高端商业色板」28 个唯一色，
// 每个色值全局只用一次（bg / 渐变中段 / 点缀色三种角色），零重复。
// 2026-12 新增 void（液态玻璃）：纯黑深空 × 霓虹光晕，材质全套变形在
// globals.css html[data-theme='void'] 作用域内实现（同 rubberhose 构架）。
export type ThemePreset =
  | 'void'
  | 'aurora' | 'sunset' | 'deepsea' | 'forest' | 'cosmos'
  | 'midnight' | 'navy' | 'pine' | 'burgundy' | 'charcoal'
  | 'graphite' | 'deepgray' | 'obsidian' | 'jadeblack' | 'slate'
  | 'rubberhose';

export const THEME_PRESETS: Record<ThemePreset, { name: string; description: string; accent: string; bg: string; gradient: string }> = {
  void: {
    name: '液态玻璃',
    description: '纯黑深空 × 霓虹光晕 · Liquid Glass',
    accent: '#00F2FE',
    bg: '#030305',
    gradient: 'linear-gradient(180deg, #030305 0%, #07070e 50%, #030305 100%)',
  },
  aurora: {
    name: '极光',
    description: '默认主题 · 紫罗兰 ambient',
    accent: '#BF5AF2',
    bg: '#0f051a',
    gradient: 'linear-gradient(135deg, #0f051a 0%, #1a0a2e 50%, #0f051a 100%)',
  },
  midnight: {
    name: '午夜蓝',
    description: '午夜蓝 × 哑光金 · 沉稳商务',
    accent: '#BFA46F',
    bg: '#0A1F44',
    // W5-v2.1: 中段 #5C6B7A→#2E3740 压暗（保蓝灰色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #0A1F44 0%, #2E3740 50%, #0A1F44 100%)',
  },
  navy: {
    name: '藏青',
    description: '藏青 × 冷白 · 内敛绅士',
    accent: '#F5F5F2',
    bg: '#102A43',
    // W5-v2.1: 中段 #8A8F98→#3A4048 压暗（保灰色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #102A43 0%, #3A4048 50%, #102A43 100%)',
  },
  pine: {
    name: '墨松',
    description: '墨松绿 × 暖白 · 静谧质感',
    accent: '#F7F4ED',
    bg: '#1F3D34',
    // W5-v2.1: 中段 #6B7A6E→#2D3F36 压暗（保墨松绿色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #1F3D34 0%, #2D3F36 50%, #1F3D34 100%)',
  },
  burgundy: {
    name: '勃艮第',
    description: '勃艮第红 × 奶油白 · 醇厚奢华',
    accent: '#F6F0E6',
    bg: '#6E1F2A',
    // W5-v2.1: 中段 #D9C7A7→#5C3A2E 压暗（保勃艮第色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #6E1F2A 0%, #5C3A2E 50%, #6E1F2A 100%)',
  },
  charcoal: {
    name: '炭黑',
    description: '炭黑 × 月白 · 极简黑白',
    accent: '#F5F5F5',
    bg: '#111111',
    gradient: 'linear-gradient(135deg, #111111 0%, #1A1A1A 50%, #111111 100%)',
  },
  graphite: {
    name: '石墨',
    description: '石墨 × 珍珠白 · 现代金属',
    accent: '#F4F4F2',
    bg: '#2E2E2E',
    // W5-v2.1: 中段 #BFC5CC→#3A3F45 压暗（保钢灰色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #2E2E2E 0%, #3A3F45 50%, #2E2E2E 100%)',
  },
  deepgray: {
    name: '玄灰',
    description: '玄灰 × 米白 · 低调高级',
    accent: '#F3EFE6',
    bg: '#3A3A3A',
    // W5-v2.1: 中段 #B08D57→#4E3F26 压暗（保金棕色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #3A3A3A 0%, #4E3F26 50%, #3A3A3A 100%)',
  },
  obsidian: {
    name: '玄黑',
    description: '玄黑 × 象牙白 · 曜石光泽',
    accent: '#F8F5EF',
    bg: '#0F1115',
    // W5-v2.1: 中段 #C0C0C0→#3A3D45 压暗（保曜石金属感，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #0F1115 0%, #3A3D45 50%, #0F1115 100%)',
  },
  jadeblack: {
    name: '墨玉',
    description: '墨玉 × 古铜 · 温润生辉',
    accent: '#A67C52',
    bg: '#1A1D21',
    // W5-v2.1: 中段 #A67C52→#4A3728 压暗（保古铜色系，降亮度让白字可读）
    gradient: 'linear-gradient(135deg, #1A1D21 0%, #4A3728 50%, #1A1D21 100%)',
  },
  slate: {
    name: '青灰',
    description: '青灰 × 香槟金光晕 · 商务典范',
    accent: '#C6A664',
    // W5-v2.1: bg #4A5568→#2D3744 压暗——slate 的 worst stop 是 bg（两端），不是中段。
    // 中段 #3A3020 已比两端暗 3 倍，压中段无效；必须压 bg 让 worst-stop ≥4.5
    bg: '#2D3744',
    gradient: 'linear-gradient(135deg, #2D3744 0%, #3A3020 50%, #2D3744 100%)',
  },
  sunset: {
    name: '鎏金',
    description: '暖金色调 · 典雅辉煌',
    accent: '#D4AF37',
    bg: '#1a1505',
    gradient: 'linear-gradient(135deg, #1a1505 0%, #2d2208 50%, #1a1505 100%)',
  },
  deepsea: {
    name: '深海',
    description: '冷冽蓝调 · 深邃宁静',
    accent: '#64D2FF',
    bg: '#050f1a',
    gradient: 'linear-gradient(135deg, #050f1a 0%, #08182d 50%, #050f1a 100%)',
  },
  forest: {
    name: '森林',
    description: '深林绿 · 自然沉稳',
    accent: '#15803d',
    bg: '#0a1a0f',
    gradient: 'linear-gradient(135deg, #0a1a0f 0%, #0f2d18 50%, #0a1a0f 100%)',
  },
  cosmos: {
    name: '星云',
    description: '紫粉色调 · 浪漫深邃',
    accent: '#BF5AF2',
    bg: '#0f051a',
    gradient: 'linear-gradient(135deg, #0f051a 0%, #18082d 50%, #0f051a 100%)',
  },
  // 2026-11-17 新增：橡皮管动画（Rubber Hose）——1930 年代美国早期卡通风格。
  // 美术语言参考 finktheartist/rubber-hose-ui（MIT）：粗墨线 #251d16、
  // 纸面奶油底、硬偏移阴影、馅饼眼白手套；全套场景变形在 globals.css
  // html[data-theme='rubberhose'] 作用域内实现（data-theme 由 boot 脚本
  // 与 page.tsx 主题 effect 同步写入）。
  rubberhose: {
    name: '橡皮管',
    description: '1930s 橡皮管动画 · 胶片复古',
    accent: '#D8442B',
    bg: '#ecd7ac',
    gradient: 'linear-gradient(135deg, #ecd7ac 0%, #f4e3bd 50%, #e5cfa0 100%)',
  },
};

// --- Theme Panel Palette (inverted surface for readability) ---
// The Player Detail Modal INVERTS the active theme: a dark theme bg
// yields a LIGHT frosted-glass panel surface with dark text (the
// theme's own bg color), so detail content stays legible no matter
// which ambient theme is active. A light theme bg would invert to a
// dark panel with light text. Per-theme colors are injected as inline
// CSS custom properties (--panel-*) on the modal root and consumed by
// the .pvp-modal-themed scope in globals.css.
export interface ThemePanelPalette {
  surface: string;       // rgba — main glass face (strong)
  surfaceAlt: string;    // rgba — gradient tail (strong)
  surfaceSoft: string;   // rgba — inner block fills
  text: string;          // hex — primary text (theme bg → high contrast)
  textSecondary: string; // rgba — secondary text
  textTertiary: string;  // rgba — tertiary text
  border: string;        // rgba — borders
  borderSubtle: string;  // rgba — subtle borders
  accent: string;        // hex — accent tint
}

/** 判断 hex 底色是否为亮色（主题选择器亮/暗底自适配文字色用） */
export function isLightHex(hex: string): boolean {
  try {
    return relativeLuminance(hexToRgb(hex)) >= 0.5;
  } catch {
    return false;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function getThemePanelPalette(theme: ThemePreset): ThemePanelPalette {
  const preset = THEME_PRESETS[theme];
  const bg = hexToRgb(preset.bg);
  const accent = hexToRgb(preset.accent);
  const isDarkTheme = relativeLuminance(bg) < 0.5;

  if (isDarkTheme) {
    // Dark theme → invert to a LIGHT panel surface.
    // Surface = white tinted ~10% with the theme accent for identity
    // (so the panel visibly shifts hue when the theme changes, while
    // staying light enough for dark text to read cleanly).
    const tinted = mixRgb([255, 255, 255], accent, 0.10);
    return {
      surface: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.94)`,
      surfaceAlt: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.82)`,
      surfaceSoft: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.68)`,
      text: preset.bg,
      textSecondary: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.62)`,
      textTertiary: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.32)`,
      border: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.12)`,
      borderSubtle: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.06)`,
      accent: preset.accent,
    };
  }
  // Light theme → invert to a DARK panel surface, light text.
  const tinted = mixRgb([18, 18, 18], accent, 0.15);
  return {
    surface: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.94)`,
    surfaceAlt: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.82)`,
    surfaceSoft: `rgba(${tinted[0]}, ${tinted[1]}, ${tinted[2]}, 0.68)`,
    text: preset.bg,
    textSecondary: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.62)`,
    textTertiary: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.32)`,
    border: `rgba(255, 255, 255, 0.18)`,
    borderSubtle: `rgba(255, 255, 255, 0.10)`,
    accent: preset.accent,
  };
}

// --- Animation Presets ---
// Apple-tuned springs: underdamped (ζ < 1) for crisp overshoot
export const SPRING_ROYAL = { stiffness: 180, damping: 14, mass: 1 };

// --- Player Stats ---
export interface PlayerStats {
  kills: number;
  deaths: number;
  wins: number;
  matches: number;
}

export function calcKD(stats: PlayerStats): string {
  if (stats.deaths === 0) return stats.kills > 0 ? '∞' : '0';
  return (stats.kills / stats.deaths).toFixed(2);
}

export function calcWinRate(stats: PlayerStats): string {
  if (stats.matches === 0) return '0%';
  // 显示防御：胜率物理上限 100%（历史脏数据 wins>matches 时不再显示 1560% 这类值）
  return (Math.min(stats.wins / stats.matches, 1) * 100).toFixed(1) + '%';
}

// --- Player Level System ---
// Level derived from total score: every 100 points = 1 level
export function calcLevel(totalScore: number): number {
  return Math.floor(totalScore / 100) + 1;
}

export function getLevelProgress(totalScore: number): { current: number; next: number; percent: number } {
  const level = calcLevel(totalScore);
  const currentLevelBase = (level - 1) * 100;
  const intoLevel = totalScore - currentLevelBase;
  return {
    current: intoLevel,
    next: 100,
    percent: Math.min(intoLevel, 100),
  };
}

// --- Rank Change ---
// HONESTY FIX: previously this returned a deterministic pseudo-random value
// derived from playerId hash, PRETENDING to be real rank movement. That was
// deceptive — users saw ▲▼ numbers that never reflected reality.
//
// Until the rank_history table exists (planned for Phase D data-model redesign),
// we return 0 ("no data / not tracked"). The UI already handles 0 by showing
// a neutral Minus icon. When real history lands, this function will read
// RankSnapshot diffs and return the true delta.
//
// Returns: positive = up, negative = down, 0 = not tracked (current state)
export function getRankChange(_playerId: string): number {
  return 0;
}

// --- Default Config Keys ---
export const CONFIG_KEYS = {
  ANNOUNCEMENT: 'announcement',
  ABOUT: 'about',
  TIER_EXPLANATION: 'tier_explanation',
  JIAHAO_EXPLANATION: 'jiahao_explanation',
  MUSIC_URLS: 'music_urls',
  THEME_MUSIC: 'theme_music',
  // W1 · 工作流 W1-T2/T3
  MIN_MATCHES: 'min_matches',       // 参评门槛，默认 5，可后台调
  PUBLIC_API: 'public_api',          // 三态开关 OFF | WHITELIST | OPEN，默认 OFF
  RATING_WEIGHTS: 'rating_weights',  // W3 评分权重 JSON，默认 40/25/20/15
  // 玩家个性标签样式（管理员后台「个性标签」编辑器产出）
  // 值为 JSON：{ "<playerId>": { bgEffect, textEffect, textColor } }
  PLAYER_TAG_STYLES: 'player_tag_styles',
} as const;

// --- W1 · 参评门槛默认值（Config 可覆盖） ---
export const DEFAULT_MIN_MATCHES = 5;

// --- W1 · API 开关三态 ---
export type ApiGateState = 'OFF' | 'WHITELIST' | 'OPEN';

// --- W1 · 评分权重默认值（用户定稿：Kills40/Deaths25/Wins20/Matches15） ---
// W3-fix-B: opponentStrength 当前为 0（数据模型无对手记录），面板诚实标注
//
// 【硬红线】Rating 作排序键时 opponentStrength 必须非零，详见 docs/w3-rating-redlines.md
// 当前 Rating 仅作透明化展示，真实排序走 tier-based getPlayerBoardScore()
export interface RatingWeights {
  kills: number;             // 击杀效率（KD 标准化）0.40
  deaths: number;            // 生存能力（场均死亡）0.25
  wins: number;              // 胜率 0.20
  matches: number;           // 场次饱和 0.15
  opponentStrength: number;  // 对手强度 0（待 MatchHistory 表引入后启用；作排序键时必须非零）
}
export const DEFAULT_RATING_WEIGHTS: RatingWeights = {
  kills: 0.40,
  deaths: 0.25,
  wins: 0.20,
  matches: 0.15,
  opponentStrength: 0,
};
export const RATING_BASE = 1200;       // 基础分
export const RATING_KD_CAP = 3;        // KD 封顶

// --- Avatar Initial Colors ---
export const AVATAR_COLORS = [
  '#BF5AF2', '#D4AF37', '#64D2FF', '#fb923c', '#8B5CF6',
  '#f472b6', '#34d399', '#E8C84A', '#60a5fa', '#a78bfa',
  '#FF453A', '#2dd4bf', '#e879f9', '#facc15', '#818cf8',
];
