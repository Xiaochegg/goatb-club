// ============================================================
// mc-icons.ts — Minecraft 像素风图标库（Task 43）
//
// 设计：16×16 像素手绘 SVG，用 rect/circle/path 拼像素画
//   - 零网络依赖（data URI 内联，不下载 MC wiki 贴图）
//   - 零版权风险（自绘几何抽象，非官方贴图复制）
//   - 矢量缩放清晰（SVG，配合 image-rendering: pixelated 保像素感）
//
// 色板（MC 经典）：
//   钻石青 #5DECFF / 金 #FFD700 / 红石红 #E63946 / 下界合金 #4A4A5E
//   橡木棕 #8B5A2B / 营火橙 #E67E22 / 末地紫 #C8A2E8 / 玻璃蓝 #A8D8F0
//
// 映射（用户指定 + MC wiki 最贴合）：
//   总榜 🏆 → 金苹果（MC 经典奖励）
//   感动榜 ❤️ → 红心（MC 生命值心）
//   盾斧 🛡️ → 盾牌（MC 1.9+ 盾牌）
//   水晶 💎 → 末地水晶（用户指定）
//   剑斗 ⚔️ → 钻石剑（用户指定"石的→钻石剑"，按剑斗最贴合）
//   钻石药水 💎 → 喷溅药水（钻石色调）
//   合金药水 🧪 → 喷溅药水（下界合金深灰调）
//   嘉豪 👑 → 附魔金苹果（紫光金苹果，王者感）
//   重锤 🔨 → 锤（MC 1.21 Mace）
//   BUHC 🎯 → 靶子（MC Target Block）
//   SMP 🏕️ → 营火（MC Campfire）
//   DSMP 🟩 → 草方块（生存服务器经典意象，2026-10 新增模式）
//   矛锤 ⚒️ → 矛尖长杆 + 侧挂刺锤（2026-10 新增模式）
//   矿车 ⛏️ → 轨道矿车（MC Minecart，2026-10 新增模式）
//   小鸟 🐦 → 像素小鸟（小鸟闯关吉祥物，金黄羽 + 白眼 + 橙喙爪，2026-11 新增娱乐模式）
// ============================================================

// 工具：把 <svg>...</svg> 转为 data URI（无需 base64，url-encode 即可）
function svgToDataUri(svg: string): string {
  return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim());
}

// 通用 16×16 viewBox 外壳
function wrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${inner}</svg>`;
}

// ── 模式图标 ──────────────────────────────────────────────

// 总榜：金苹果（金色圆 + 绿叶 + 棕柄）
const GOLDEN_APPLE = wrap(
  '<rect x="6" y="3" width="4" height="1" fill="#5a8a3a"/>' +
  '<rect x="5" y="4" width="1" height="1" fill="#5a8a3a"/>' +
  '<rect x="10" y="4" width="2" height="1" fill="#6b4a2b"/>' +
  '<rect x="4" y="5" width="8" height="6" fill="#FFD700"/>' +
  '<rect x="3" y="6" width="10" height="4" fill="#FFD700"/>' +
  '<rect x="5" y="7" width="2" height="1" fill="#FFF4B8"/>' +
  '<rect x="4" y="11" width="8" height="1" fill="#E8C84A"/>' +
  '<rect x="5" y="12" width="6" height="1" fill="#D4AF37"/>'
);

// 感动榜：红心（MC 生命值心形像素）
const HEART = wrap(
  '<rect x="3" y="4" width="3" height="1" fill="#E63946"/>' +
  '<rect x="10" y="4" width="3" height="1" fill="#E63946"/>' +
  '<rect x="2" y="5" width="5" height="1" fill="#E63946"/>' +
  '<rect x="9" y="5" width="5" height="1" fill="#E63946"/>' +
  '<rect x="2" y="6" width="12" height="1" fill="#E63946"/>' +
  '<rect x="2" y="7" width="12" height="1" fill="#E63946"/>' +
  '<rect x="3" y="8" width="10" height="1" fill="#E63946"/>' +
  '<rect x="4" y="9" width="8" height="1" fill="#E63946"/>' +
  '<rect x="5" y="10" width="6" height="1" fill="#E63946"/>' +
  '<rect x="6" y="11" width="4" height="1" fill="#E63946"/>' +
  '<rect x="7" y="12" width="2" height="1" fill="#E63946"/>' +
  '<rect x="3" y="5" width="1" height="1" fill="#FF6B7A"/>' +
  '<rect x="4" y="6" width="1" height="1" fill="#FF6B7A"/>'
);

// 盾斧：盾牌（深灰盾形 + 金边）
const SHIELD = wrap(
  '<rect x="3" y="2" width="10" height="2" fill="#6B6B6B"/>' +
  '<rect x="3" y="2" width="10" height="1" fill="#D4AF37"/>' +
  '<rect x="2" y="4" width="12" height="4" fill="#6B6B6B"/>' +
  '<rect x="3" y="8" width="10" height="2" fill="#5A5A5A"/>' +
  '<rect x="4" y="10" width="8" height="2" fill="#4A4A4A"/>' +
  '<rect x="6" y="12" width="4" height="1" fill="#3A3A3A"/>' +
  '<rect x="7" y="13" width="2" height="1" fill="#2A2A2A"/>' +
  '<rect x="6" y="4" width="4" height="1" fill="#D4AF37"/>' +
  '<rect x="6" y="6" width="4" height="2" fill="#D4AF37"/>'
);

// 水晶：末地水晶（紫色菱形 + 底座）—— 用户指定
const END_CRYSTAL = wrap(
  '<rect x="7" y="2" width="2" height="1" fill="#C8A2E8"/>' +
  '<rect x="5" y="3" width="6" height="1" fill="#C8A2E8"/>' +
  '<rect x="4" y="4" width="8" height="1" fill="#E0BFF8"/>' +
  '<rect x="3" y="5" width="10" height="3" fill="#C8A2E8"/>' +
  '<rect x="4" y="8" width="8" height="1" fill="#E0BFF8"/>' +
  '<rect x="5" y="9" width="6" height="1" fill="#C8A2E8"/>' +
  '<rect x="7" y="10" width="2" height="1" fill="#C8A2E8"/>' +
  '<rect x="6" y="11" width="4" height="1" fill="#8B6B4A"/>' +
  '<rect x="5" y="12" width="6" height="1" fill="#6B4A2B"/>' +
  '<rect x="4" y="13" width="8" height="1" fill="#4A3220"/>' +
  '<rect x="5" y="6" width="2" height="1" fill="#F0D8FF"/>' +
  '<rect x="4" y="5" width="1" height="1" fill="#F0D8FF"/>'
);

// 剑斗：钻石剑（青色剑身 + 棕柄 + 金护手）—— 用户指定"石的→钻石剑"
const DIAMOND_SWORD = wrap(
  '<rect x="2" y="2" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="3" y="3" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="4" y="4" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="5" y="5" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="6" y="6" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="7" y="7" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="8" y="8" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="9" y="9" width="1" height="1" fill="#5DECFF"/>' +
  '<rect x="3" y="2" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="4" y="3" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="5" y="4" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="6" y="5" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="7" y="6" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="8" y="7" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="8" y="9" width="4" height="1" fill="#D4AF37"/>' +
  '<rect x="10" y="10" width="2" height="1" fill="#8B5A2B"/>' +
  '<rect x="11" y="11" width="2" height="1" fill="#8B5A2B"/>' +
  '<rect x="12" y="12" width="2" height="1" fill="#6B4A2B"/>'
);

// 钻石药水：喷溅药水（钻石青液体 + 玻璃瓶）
const DIAMOND_POTION = wrap(
  '<rect x="6" y="2" width="4" height="1" fill="#6B4A2B"/>' +
  '<rect x="6" y="3" width="4" height="1" fill="#8B5A2B"/>' +
  '<rect x="5" y="4" width="6" height="1" fill="#A8D8F0"/>' +
  '<rect x="4" y="5" width="8" height="2" fill="#A8D8F0"/>' +
  '<rect x="4" y="7" width="8" height="4" fill="#5DECFF"/>' +
  '<rect x="5" y="11" width="6" height="1" fill="#5DECFF"/>' +
  '<rect x="6" y="12" width="4" height="1" fill="#3AA8C8"/>' +
  '<rect x="7" y="13" width="2" height="1" fill="#2A88A8"/>' +
  '<rect x="5" y="8" width="1" height="1" fill="#8FF8FF"/>' +
  '<rect x="6" y="9" width="1" height="1" fill="#8FF8FF"/>'
);

// 合金药水：喷溅药水（下界合金深灰液体）
const ALLOY_POTION = wrap(
  '<rect x="6" y="2" width="4" height="1" fill="#6B4A2B"/>' +
  '<rect x="6" y="3" width="4" height="1" fill="#8B5A2B"/>' +
  '<rect x="5" y="4" width="6" height="1" fill="#A8D8F0"/>' +
  '<rect x="4" y="5" width="8" height="2" fill="#A8D8F0"/>' +
  '<rect x="4" y="7" width="8" height="4" fill="#4A4A5E"/>' +
  '<rect x="5" y="11" width="6" height="1" fill="#4A4A5E"/>' +
  '<rect x="6" y="12" width="4" height="1" fill="#2A2A3E"/>' +
  '<rect x="7" y="13" width="2" height="1" fill="#1A1A2E"/>' +
  '<rect x="5" y="8" width="1" height="1" fill="#6A6A7E"/>' +
  '<rect x="6" y="9" width="1" height="1" fill="#6A6A7E"/>'
);

// 嘉豪：附魔金苹果（紫光金苹果，王者感）
const ENCHANTED_APPLE = wrap(
  '<rect x="6" y="3" width="4" height="1" fill="#5a8a3a"/>' +
  '<rect x="5" y="4" width="1" height="1" fill="#5a8a3a"/>' +
  '<rect x="10" y="4" width="2" height="1" fill="#6b4a2b"/>' +
  '<rect x="4" y="5" width="8" height="6" fill="#FFD700"/>' +
  '<rect x="3" y="6" width="10" height="4" fill="#FFD700"/>' +
  '<rect x="4" y="11" width="8" height="1" fill="#E8C84A"/>' +
  '<rect x="5" y="12" width="6" height="1" fill="#D4AF37"/>' +
  '<rect x="5" y="7" width="2" height="1" fill="#FFF4B8"/>' +
  '<rect x="8" y="6" width="1" height="1" fill="#C8A2E8"/>' +
  '<rect x="9" y="8" width="1" height="1" fill="#C8A2E8"/>' +
  '<rect x="6" y="9" width="1" height="1" fill="#C8A2E8"/>' +
  '<rect x="10" y="7" width="1" height="1" fill="#C8A2E8"/>'
);

// 重锤：锤（深灰锤头 + 棕柄）—— MC 1.21 Mace
const MACE = wrap(
  '<rect x="2" y="2" width="8" height="1" fill="#4A4A4A"/>' +
  '<rect x="2" y="3" width="8" height="3" fill="#6B6B6B"/>' +
  '<rect x="2" y="6" width="8" height="1" fill="#4A4A4A"/>' +
  '<rect x="3" y="2" width="1" height="1" fill="#D4AF37"/>' +
  '<rect x="8" y="2" width="1" height="1" fill="#D4AF37"/>' +
  '<rect x="3" y="6" width="1" height="1" fill="#D4AF37"/>' +
  '<rect x="8" y="6" width="1" height="1" fill="#D4AF37"/>' +
  '<rect x="5" y="7" width="2" height="2" fill="#8B5A2B"/>' +
  '<rect x="6" y="9" width="2" height="2" fill="#8B5A2B"/>' +
  '<rect x="7" y="11" width="2" height="2" fill="#6B4A2B"/>' +
  '<rect x="8" y="13" width="2" height="1" fill="#4A3220"/>'
);

// BUHC：靶子（MC Target Block 红白同心圆）
const TARGET = wrap(
  '<rect x="2" y="2" width="12" height="12" fill="#F5F5F5"/>' +
  '<rect x="2" y="2" width="12" height="1" fill="#D4D4D4"/>' +
  '<rect x="2" y="13" width="12" height="1" fill="#D4D4D4"/>' +
  '<rect x="2" y="2" width="1" height="12" fill="#D4D4D4"/>' +
  '<rect x="13" y="2" width="1" height="12" fill="#D4D4D4"/>' +
  '<rect x="4" y="4" width="8" height="8" fill="#E63946"/>' +
  '<rect x="5" y="5" width="6" height="6" fill="#F5F5F5"/>' +
  '<rect x="6" y="6" width="4" height="4" fill="#E63946"/>' +
  '<rect x="7" y="7" width="2" height="2" fill="#FFF4B8"/>'
);

// SMP：营火（MC Campfire 火焰 + 木柴）
const CAMPFIRE = wrap(
  '<rect x="7" y="2" width="2" height="1" fill="#FFD700"/>' +
  '<rect x="6" y="3" width="4" height="1" fill="#FF8C00"/>' +
  '<rect x="5" y="4" width="6" height="2" fill="#E67E22"/>' +
  '<rect x="6" y="6" width="4" height="1" fill="#D35400"/>' +
  '<rect x="3" y="7" width="10" height="1" fill="#6B4A2B"/>' +
  '<rect x="4" y="8" width="8" height="1" fill="#8B5A2B"/>' +
  '<rect x="3" y="9" width="2" height="2" fill="#6B4A2B"/>' +
  '<rect x="6" y="9" width="2" height="2" fill="#6B4A2B"/>' +
  '<rect x="9" y="9" width="2" height="2" fill="#6B4A2B"/>' +
  '<rect x="11" y="9" width="2" height="2" fill="#6B4A2B"/>' +
  '<rect x="4" y="11" width="8" height="1" fill="#4A3220"/>'
);

// DSMP：草方块（绿草顶 + 棕土壤）—— 生存服务器经典意象
const GRASS_BLOCK = wrap(
  '<rect x="2" y="3" width="12" height="1" fill="#7fbf5a"/>' +
  '<rect x="2" y="4" width="12" height="2" fill="#5a8a3a"/>' +
  '<rect x="2" y="6" width="12" height="1" fill="#6B4A2B"/>' +
  '<rect x="2" y="7" width="12" height="5" fill="#8B5A2B"/>' +
  '<rect x="2" y="12" width="12" height="1" fill="#4A3220"/>' +
  '<rect x="3" y="4" width="2" height="1" fill="#8fd46a"/>' +
  '<rect x="10" y="3" width="2" height="1" fill="#8fd46a"/>' +
  '<rect x="4" y="8" width="2" height="1" fill="#6B4A2B"/>' +
  '<rect x="9" y="9" width="2" height="1" fill="#6B4A2B"/>' +
  '<rect x="5" y="10" width="2" height="1" fill="#9a6a3a"/>'
);

// 矛锤：矛尖长杆 + 侧挂刺锤（银矛头 + 金护手 + 深灰锤头）
const SPEAR_MACE = wrap(
  '<rect x="7" y="1" width="2" height="1" fill="#E8E8E8"/>' +
  '<rect x="7" y="2" width="2" height="2" fill="#C8C8C8"/>' +
  '<rect x="7" y="4" width="2" height="1" fill="#A8A8A8"/>' +
  '<rect x="5" y="5" width="6" height="1" fill="#D4AF37"/>' +
  '<rect x="7" y="6" width="2" height="8" fill="#8B5A2B"/>' +
  '<rect x="7" y="14" width="2" height="1" fill="#6B4A2B"/>' +
  '<rect x="3" y="7" width="4" height="4" fill="#4A4A4A"/>' +
  '<rect x="2" y="8" width="1" height="2" fill="#6B6B6B"/>' +
  '<rect x="4" y="11" width="2" height="1" fill="#6B6B6B"/>' +
  '<rect x="3" y="8" width="1" height="1" fill="#6B6B6B"/>'
);

// 矿车：轨道矿车（灰车厢 + 双轮 + 合金轨）
const MINECART = wrap(
  '<rect x="3" y="5" width="10" height="1" fill="#8A8A8A"/>' +
  '<rect x="3" y="6" width="10" height="4" fill="#6B6B6B"/>' +
  '<rect x="4" y="7" width="8" height="2" fill="#2A2A2A"/>' +
  '<rect x="4" y="10" width="8" height="1" fill="#4A4A4A"/>' +
  '<rect x="4" y="11" width="2" height="2" fill="#2A2A2A"/>' +
  '<rect x="10" y="11" width="2" height="2" fill="#2A2A2A"/>' +
  '<rect x="2" y="13" width="12" height="1" fill="#4A4A5E"/>' +
  '<rect x="3" y="14" width="1" height="1" fill="#4A4A5E"/>' +
  '<rect x="6" y="14" width="1" height="1" fill="#4A4A5E"/>' +
  '<rect x="9" y="14" width="1" height="1" fill="#4A4A5E"/>' +
  '<rect x="12" y="14" width="1" height="1" fill="#4A4A5E"/>'
);

// 小鸟：像素小鸟（金黄身体 + 白眼黑瞳 + 橙喙橙爪，右侧朝向，小鸟闯关吉祥物）
const BIRD = wrap(
  '<rect x="6" y="3" width="6" height="1" fill="#FFD700"/>' +
  '<rect x="5" y="4" width="8" height="1" fill="#FFD700"/>' +
  '<rect x="4" y="5" width="10" height="6" fill="#FFD700"/>' +
  '<rect x="3" y="6" width="2" height="3" fill="#D4AF37"/>' +
  '<rect x="5" y="8" width="5" height="3" fill="#FFE68A"/>' +
  '<rect x="9" y="5" width="2" height="2" fill="#FFFFFF"/>' +
  '<rect x="10" y="6" width="1" height="1" fill="#1A1030"/>' +
  '<rect x="12" y="6" width="2" height="1" fill="#E67E22"/>' +
  '<rect x="12" y="7" width="1" height="1" fill="#C05F17"/>' +
  '<rect x="5" y="7" width="3" height="2" fill="#D4AF37"/>' +
  '<rect x="5" y="11" width="7" height="1" fill="#D4AF37"/>' +
  '<rect x="6" y="12" width="1" height="2" fill="#E67E22"/>' +
  '<rect x="9" y="12" width="1" height="2" fill="#E67E22"/>'
);

// ── Title 图标（ui-utils getPlayerTitle）──────────────────

// Champion：金苹果（同总榜，王者感）
// 复用 GOLDEN_APPLE

// Elite：钻石（青色菱形）
const DIAMOND_GEM = wrap(
  '<rect x="7" y="2" width="2" height="1" fill="#5DECFF"/>' +
  '<rect x="5" y="3" width="6" height="1" fill="#5DECFF"/>' +
  '<rect x="3" y="4" width="10" height="2" fill="#5DECFF"/>' +
  '<rect x="2" y="6" width="12" height="2" fill="#5DECFF"/>' +
  '<rect x="3" y="8" width="10" height="1" fill="#3AA8C8"/>' +
  '<rect x="4" y="9" width="8" height="1" fill="#3AA8C8"/>' +
  '<rect x="5" y="10" width="6" height="1" fill="#2A88A8"/>' +
  '<rect x="6" y="11" width="4" height="1" fill="#1A68A8"/>' +
  '<rect x="7" y="12" width="2" height="1" fill="#0A4888"/>' +
  '<rect x="4" y="4" width="2" height="1" fill="#8FF8FF"/>' +
  '<rect x="3" y="6" width="2" height="1" fill="#8FF8FF"/>'
);

// Pro：红石粉（红色十字）
const REDSTONE = wrap(
  '<rect x="7" y="2" width="2" height="12" fill="#E63946"/>' +
  '<rect x="2" y="7" width="12" height="2" fill="#E63946"/>' +
  '<rect x="6" y="2" width="4" height="12" fill="#FF6B7A"/>' +
  '<rect x="2" y="6" width="12" height="4" fill="#FF6B7A"/>' +
  '<rect x="7" y="2" width="2" height="12" fill="#C62828"/>' +
  '<rect x="2" y="7" width="12" height="2" fill="#C62828"/>' +
  '<rect x="7" y="7" width="2" height="2" fill="#FFD700"/>'
);

// Veteran：铁锭（灰色长方形 + 高光）
const IRON_INGOT = wrap(
  '<rect x="2" y="5" width="12" height="6" fill="#A8A8A8"/>' +
  '<rect x="2" y="5" width="12" height="1" fill="#D4D4D4"/>' +
  '<rect x="2" y="10" width="12" height="1" fill="#6B6B6B"/>' +
  '<rect x="2" y="5" width="1" height="6" fill="#6B6B6B"/>' +
  '<rect x="13" y="5" width="1" height="6" fill="#6B6B6B"/>' +
  '<rect x="4" y="6" width="8" height="1" fill="#E8E8E8"/>' +
  '<rect x="4" y="9" width="8" height="1" fill="#888888"/>'
);

// Rookie：橡木树苗（绿色小苗 + 棕根）
const SAPLING = wrap(
  '<rect x="7" y="2" width="2" height="1" fill="#5a8a3a"/>' +
  '<rect x="6" y="3" width="4" height="1" fill="#5a8a3a"/>' +
  '<rect x="5" y="4" width="6" height="2" fill="#6baa4a"/>' +
  '<rect x="4" y="6" width="8" height="1" fill="#6baa4a"/>' +
  '<rect x="6" y="7" width="4" height="1" fill="#5a8a3a"/>' +
  '<rect x="7" y="8" width="2" height="3" fill="#8B5A2B"/>' +
  '<rect x="6" y="11" width="4" height="1" fill="#6B4A2B"/>' +
  '<rect x="5" y="12" width="6" height="1" fill="#4A3220"/>'
);

// ── 导出 data URI 映射 ────────────────────────────────────
export const MC_ICONS = {
  // 模式（对齐 BOARD_TABS / MODE_ICONS 顺序）
  TOTAL:           svgToDataUri(GOLDEN_APPLE),
  EMOTION:         svgToDataUri(HEART),
  SHIELD:          svgToDataUri(SHIELD),
  CRYSTAL:         svgToDataUri(END_CRYSTAL),
  SWORD:           svgToDataUri(DIAMOND_SWORD),
  DIAMOND_POTION:  svgToDataUri(DIAMOND_POTION),
  ALLOY_POTION:    svgToDataUri(ALLOY_POTION),
  JIAHAO:          svgToDataUri(ENCHANTED_APPLE),
  MACE:            svgToDataUri(MACE),
  BUHC:            svgToDataUri(TARGET),
  SMP:             svgToDataUri(CAMPFIRE),
  DSMP:            svgToDataUri(GRASS_BLOCK),
  SPEAR_MACE:      svgToDataUri(SPEAR_MACE),
  MINECART:        svgToDataUri(MINECART),
  BIRD:            svgToDataUri(BIRD),
  // title（ui-utils getPlayerTitle）
  CHAMPION:        svgToDataUri(GOLDEN_APPLE),
  ELITE:           svgToDataUri(DIAMOND_GEM),
  PRO:             svgToDataUri(REDSTONE),
  VETERAN:         svgToDataUri(IRON_INGOT),
  ROOKIE:          svgToDataUri(SAPLING),
} as const;

export type McIconName = keyof typeof MC_ICONS;

// 兜底：未知模式 → 钻石
export const MC_ICON_FALLBACK = MC_ICONS.TOTAL;
