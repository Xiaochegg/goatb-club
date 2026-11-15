// ============================================================
// W5-T1 · 全主题对比度扫描（v2 — alpha 保留 + 三层合成 + opacity 祖先链）
// ============================================================
// 修复 v1 三处缺陷：
//   1. parseColor 丢 alpha → 现在 rgba 全程保留
//   2. 不合成 → 现在 bg_final = panel×α + gradient×(1-α)，
//      text_final = text×a + bg_final×(1-a)，a = text.alpha × opacity 祖先链
//   3. gradient 取最坏 stop → 每停算一次合成后对比度，取 min
//
// 三层结构：
//   [TS 纯函数层] parseColor / parseGradient / composite / contrast / computeContrast
//      → 可脱离浏览器自测
//   [self-test 层] 3 对已知值，不过则不碰 15 主题
//   [浏览器采集层] eval 只取原始 style（color / opacity / backgroundColor /
//      backgroundImage / 祖先链），不算对比度
//
// 运行：
//   bun run scripts/w5-contrast-scan.ts --selftest     # 仅跑自测
//   bun run scripts/w5-contrast-scan.ts --smoke        # 仅 aurora 一主题
//   bun run scripts/w5-contrast-scan.ts                # 全 15 主题
// 前置：dev 服务器在线 + agent-browser 已 open localhost:3000
// ============================================================

import { execSync } from 'child_process';

// ─── 1. 纯函数层（可自测，无浏览器依赖） ──────────────────────

interface Rgb { r: number; g: number; b: number; }
interface Rgba extends Rgb { a: number; }

/** 解析颜色（保留 alpha），支持 #hex / rgb / rgba / hsl 兜底 */
function parseColor(raw: string): Rgba | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'currentcolor') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  // #hex (3 or 6)
  const hexM = s.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/);
  if (hexM) {
    let h = hexM[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  // rgba / rgb
  const rgbM = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,]+([0-9.]+))?\s*\)/);
  if (rgbM) {
    return {
      r: parseInt(rgbM[1]), g: parseInt(rgbM[2]), b: parseInt(rgbM[3]),
      a: rgbM[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbM[4]))) : 1,
    };
  }
  return null;
}

/** 解析 linear-gradient 取所有 stop（保留 alpha）*/
function parseGradientStops(bgImage: string): Rgba[] {
  if (!bgImage || bgImage === 'none') return [];
  const stops: Rgba[] = [];
  const colorRe = /rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+(?:[\s,]+[0-9.]+)?\s*\)|#[0-9a-f]{6}|#[0-9a-f]{3}/gi;
  const matches = bgImage.match(colorRe);
  if (matches) {
    for (const m of matches) {
      const c = parseColor(m);
      if (c) stops.push(c);
    }
  }
  return stops;
}

function relativeLuminance(c: Rgb): number {
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(c.r) + 0.7152 * toLin(c.g) + 0.0722 * toLin(c.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 合成：fg over bg（premultiplied alpha）*/
function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

/** 背景层 — 从最靠近 text 的层到最远（页面）的层 */
interface BgLayer {
  source: string;          // debug: 哪个 DOM 节点
  kind: 'solid' | 'gradient';
  colors: Rgba[];          // solid=1 个；gradient=N 个 stops（含 alpha）
  rawImage?: string;       // gradient 原始 backgroundImage 字符串（位置感知用）
  bbox?: { x: number; y: number; w: number; h: number };  // gradient 所在块 viewport bbox
}

interface ContrastInputs {
  textRgba: Rgba;          // text 元素 color（含 alpha）
  opacityChain: number;    // text.opacity × 透明祖先 opacity 连乘（不含 panel 自身）
  layers: BgLayer[];       // 背景层栈（top→bottom）；至少 1 层
  textCx?: number;         // text 元素中心 viewport x（位置感知用）
  textCy?: number;         // text 元素中心 viewport y
}

/** 多层合成：取每层一个候选色，自顶向下合成，返回最终 Rgb */
function compositeLayers(picks: Rgba[]): Rgb {
  // 自顶向下：第一层 over 第二层 over ... over 最底层
  let acc: Rgb = { r: picks[0].r, g: picks[0].g, b: picks[0].b };
  let accA = picks[0].a;
  for (let i = 1; i < picks.length; i++) {
    const p = picks[i];
    // acc（已合成）over p
    acc = {
      r: acc.r * accA + p.r * (1 - accA),
      g: acc.g * accA + p.g * (1 - accA),
      b: acc.b * accA + p.b * (1 - accA),
    };
    accA = accA + p.a * (1 - accA);
  }
  return acc;
}

/**
 * 多层最坏情况对比度：
 *   对每层各取一个候选色（solid 取唯一，gradient 遍历各 stop）
 *   bg_final   = compositeLayers([layer1_pick, layer2_pick, ...])
 *   text_a     = textRgba.a × opacityChain
 *   text_final = textRgb × text_a + bg_final × (1 - text_a)
 *   ratio      = contrast(text_final, bg_final)
 *   return min(ratio)  — 笛卡尔积枚举所有组合，取最坏
 */
function computeContrast(inputs: ContrastInputs): number {
  if (inputs.layers.length === 0) return 0;
  // 笛卡尔积（cap 总组合数避免爆炸）
  const MAX_COMBOS = 64;
  let combos: Rgba[][] = [[]];
  for (const layer of inputs.layers) {
    if (layer.colors.length === 0) continue;
    const next: Rgba[][] = [];
    for (const c of combos) {
      for (const col of layer.colors) {
        next.push([...c, col]);
      }
    }
    combos = next;
    if (combos.length > MAX_COMBOS) {
      // 截断（取前 MAX_COMBOS 个）— 实践中 3×3×3=27 远低于 64
      combos = combos.slice(0, MAX_COMBOS);
      break;
    }
  }
  const effectiveA = Math.max(0, Math.min(1, inputs.textRgba.a * inputs.opacityChain));
  const textRgba: Rgba = { ...inputs.textRgba, a: effectiveA };
  let worst = Infinity;
  for (const picks of combos) {
    if (picks.length === 0) continue;
    const bgFinal = compositeLayers(picks);
    const textFinal = compositeOver(textRgba, bgFinal);
    const ratio = contrastRatio(textFinal, bgFinal);
    if (ratio < worst) worst = ratio;
  }
  return worst === Infinity ? 0 : worst;
}

// ─── 1b. 位置感知 gradient 采样（v2.1 新增） ──────────────────
// v2 的 computeContrast 取全局最坏 stop，对 linear-gradient(135deg, dark, light, dark)
// 这类「中段亮、两端暗」的渐变会过度报告——文字在左侧/右侧时 t 不在中段，
// 实际背景比最坏 stop 暗得多。位置感知模式按文字中心 t 插值取色。

interface GradientStop { color: Rgba; pos: number; }  // pos: 0-1
interface ParsedGradient { angle: number; stops: GradientStop[]; }  // angle: radians

/** 解析 linear-gradient 字符串 → {angle, stops with positions} */
function parseGradient(raw: string): ParsedGradient | null {
  if (!raw) return null;
  const m = raw.match(/linear-gradient\(\s*(?:(\d+(?:\.\d+)?)deg|to\s+([\w\s]+?))\s*,\s*(.+)\)\s*$/i);
  if (!m) return null;
  let angle: number;
  if (m[1]) {
    angle = parseFloat(m[1]) * Math.PI / 180;
  } else if (m[2]) {
    const dirMap: Record<string, number> = {
      'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
      'top right': 45, 'right top': 45,
      'bottom right': 135, 'right bottom': 135,
      'bottom left': 225, 'left bottom': 225,
      'top left': 315, 'left top': 315,
    };
    angle = (dirMap[m[2].toLowerCase().trim()] ?? 180) * Math.PI / 180;
  } else {
    angle = Math.PI;  // default: to bottom (180deg)
  }
  // 解析 stops：匹配 "color [pos]" ，color 可以是 rgba(...) 或 #hex
  const stopsStr = m[3];
  const stopRe = /(rgba?\([^)]+\)|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s*(\d+(?:\.\d+)?%)?/g;
  const stops: GradientStop[] = [];
  let match: RegExpExecArray | null;
  while ((match = stopRe.exec(stopsStr)) !== null) {
    const c = parseColor(match[1]);
    if (!c) continue;
    const pos = match[2] ? parseFloat(match[2]) / 100 : -1;  // -1 = 待分配
    stops.push({ color: c, pos });
  }
  if (stops.length === 0) return null;
  // 分配缺失的 pos：首尾 0/1，中间均分
  stops[0].pos = stops[0].pos < 0 ? 0 : stops[0].pos;
  stops[stops.length - 1].pos = stops[stops.length - 1].pos < 0 ? 1 : stops[stops.length - 1].pos;
  // 找到第一个/最后一个已指定的 pos，中间未指定的均分
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].pos < 0) {
      // 找下一个已指定的
      let next = i + 1;
      while (next < stops.length - 1 && stops[next].pos < 0) next++;
      // 找前一个已指定的（i-1 必定已指定，因为前面的循环已补）
      const prev = i - 1;
      const range = stops[next].pos - stops[prev].pos;
      const steps = next - prev;
      for (let j = i; j < next; j++) {
        stops[j].pos = stops[prev].pos + range * (j - prev) / steps;
      }
    }
  }
  return { angle, stops };
}

/** 计算文字中心在 gradient 轴上的 t (0-1) */
function computeGradientT(
  textCx: number, textCy: number,
  blockX: number, blockY: number, blockW: number, blockH: number,
  angle: number,
): number {
  // CSS gradient: 0deg=to top, 90deg=to right, 135deg=to bottom-right
  // 方向向量 (sin θ, -cos θ) in screen coords (y down)
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  // gradient 线长度 = |W·dx| + |H·dy|
  const length = Math.abs(blockW * dx) + Math.abs(blockH * dy);
  if (length === 0) return 0.5;
  // 文字中心相对 block 中心
  const relX = textCx - (blockX + blockW / 2);
  const relY = textCy - (blockY + blockH / 2);
  // 投影到 gradient 方向
  const proj = relX * dx + relY * dy;
  // t = 0.5 + proj/length（block 中心在 t=0.5）
  return Math.max(0, Math.min(1, 0.5 + proj / length));
}

/** 在 t 处插值 gradient 颜色 */
function interpolateGradientAt(stops: GradientStop[], t: number): Rgba {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= stops[0].pos) return stops[0].color;
  if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
      const range = stops[i + 1].pos - stops[i].pos;
      if (range === 0) return stops[i + 1].color;
      const f = (t - stops[i].pos) / range;
      return {
        r: stops[i].color.r + (stops[i + 1].color.r - stops[i].color.r) * f,
        g: stops[i].color.g + (stops[i + 1].color.g - stops[i].color.g) * f,
        b: stops[i].color.b + (stops[i + 1].color.b - stops[i].color.b) * f,
        a: stops[i].color.a + (stops[i + 1].color.a - stops[i].color.a) * f,
      };
    }
  }
  return stops[stops.length - 1].color;
}

/**
 * 位置感知对比度：对 gradient 层按文字中心 t 插值取色，solid 层不变。
 * 不做笛卡尔积——每层只取 1 个色（gradient=插值色，solid=唯一色），单次合成。
 */
function computeContrastPositionAware(inputs: ContrastInputs): number {
  if (inputs.layers.length === 0) return 0;
  if (inputs.textCx === undefined || inputs.textCy === undefined) return 0;
  const picks: Rgba[] = [];
  for (const layer of inputs.layers) {
    if (layer.kind === 'gradient' && layer.rawImage && layer.bbox) {
      const parsed = parseGradient(layer.rawImage);
      if (parsed) {
        const t = computeGradientT(
          inputs.textCx, inputs.textCy,
          layer.bbox.x, layer.bbox.y, layer.bbox.w, layer.bbox.h,
          parsed.angle,
        );
        picks.push(interpolateGradientAt(parsed.stops, t));
        continue;
      }
    }
    // solid 或 gradient 解析失败 → 取第一个色
    if (layer.colors.length > 0) picks.push(layer.colors[0]);
  }
  if (picks.length === 0) return 0;
  const bgFinal = compositeLayers(picks);
  const effectiveA = Math.max(0, Math.min(1, inputs.textRgba.a * inputs.opacityChain));
  const textRgba: Rgba = { ...inputs.textRgba, a: effectiveA };
  const textFinal = compositeOver(textRgba, bgFinal);
  return contrastRatio(textFinal, bgFinal);
}

// ─── 2. Self-test 层 ────────────────────────────────────────

function runSelfTest(): { name: string; expected: number; actual: number; pass: boolean; note: string }[] {
  const cases: Array<{ name: string; inputs: ContrastInputs; expected: number; note: string }> = [
    {
      name: '纯黑 on 纯白',
      inputs: {
        textRgba: { r: 0, g: 0, b: 0, a: 1 },
        opacityChain: 1,
        layers: [{ source: 'page', kind: 'solid', colors: [{ r: 255, g: 255, b: 255, a: 1 }] }],
      },
      expected: 21.0,
      note: 'WCAG 最大对比度',
    },
    {
      name: '纯白 on 纯黑',
      inputs: {
        textRgba: { r: 255, g: 255, b: 255, a: 1 },
        opacityChain: 1,
        layers: [{ source: 'page', kind: 'solid', colors: [{ r: 0, g: 0, b: 0, a: 1 }] }],
      },
      expected: 21.0,
      note: 'WCAG 最大对比度（反向）',
    },
    {
      name: 'rgba(0,0,0,0.5) on 纯白',
      inputs: {
        textRgba: { r: 0, g: 0, b: 0, a: 0.5 },
        opacityChain: 1,
        layers: [{ source: 'page', kind: 'solid', colors: [{ r: 255, g: 255, b: 255, a: 1 }] }],
      },
      expected: 4.0,  // 合成后为中灰 (127,127,127)，gamma-corrected L≈0.212
      note: 'WCAG 标准答案 ~4.0；WebAIM 同值。手算：sRGB 127/255=0.498 → linear=((0.498+0.055)/1.055)^2.4 ≈ 0.212；contrast=(1.0+0.05)/(0.212+0.05) ≈ 4.01。',
    },
    {
      name: '半透明白字 on 半透明 gold 渐变 on 深色页面（三层）',
      inputs: {
        textRgba: { r: 255, g: 255, b: 255, a: 0.56 },
        opacityChain: 1,
        layers: [
          // Layer 1: 面板 faint white（rgba(255,255,255,0.035)）
          { source: 'panel', kind: 'solid', colors: [{ r: 255, g: 255, b: 255, a: 0.035 }] },
          // Layer 2: gold 渐变（两 stop：alpha 0.1 / 0.02）
          { source: 'gold-grad', kind: 'gradient', colors: [
            { r: 212, g: 175, b: 55, a: 0.1 },
            { r: 212, g: 175, b: 55, a: 0.02 },
          ] },
          // Layer 3: aurora 页面渐变（最坏 stop = #1a0a2e）
          { source: 'page', kind: 'solid', colors: [{ r: 26, g: 10, b: 46, a: 1 }] },
        ],
      },
      expected: 5.5,  // 半透明白 + faint white panel + faint gold + dark page → 应接近 lgx-sub 的 6.3 略低
      note: '三层合成 sanity check：不应出现 1-2 的假低值（v1 bug）；正确值应在 5-7 区间',
    },
  ];
  // 位置感知专用 self-test：验证 parseGradient + computeGradientT + interpolateGradientAt
  // 已知场景：linear-gradient(135deg, #000 0%, #fff 50%, #000 100%) on 1000×1000 block
  //   文字在 (0, 0) [top-left] → t=0 → #000 → 白字对比度 21
  //   文字在 (500, 500) [center] → t=0.5 → #fff → 白字对比度 1.0
  //   文字在 (250, 250) → t=(250+250)/(1000+1000)=0.25 → lerp(#000, #fff, 0.5)=#7f7f7f → 白字对比度 ~4.0
  //   文字在 (750, 750) → t=(750+750)/2000=0.75 → lerp(#fff, #000, 0.5)=#7f7f7f → 白字对比度 ~4.0
  const posCases: Array<{ name: string; expected: number; actual: number; pass: boolean; note: string }> = [];
  const testGrad = 'linear-gradient(135deg, #000000 0%, #ffffff 50%, #000000 100%)';
  const testBbox = { x: 0, y: 0, w: 1000, h: 1000 };
  const testParsed = parseGradient(testGrad);
  if (testParsed) {
    const testPoints = [
      { name: 'pos-aware: 白字 @ top-left (t=0, #000)', cx: 0, cy: 0, expected: 21.0 },
      { name: 'pos-aware: 白字 @ center (t=0.5, #fff)', cx: 500, cy: 500, expected: 1.0 },
      { name: 'pos-aware: 白字 @ (250,250) (t=0.25, #7f7f7f)', cx: 250, cy: 250, expected: 4.0 },
      { name: 'pos-aware: 白字 @ (750,750) (t=0.75, #7f7f7f)', cx: 750, cy: 750, expected: 4.0 },
    ];
    for (const p of testPoints) {
      const inputs: ContrastInputs = {
        textRgba: { r: 255, g: 255, b: 255, a: 1 },
        opacityChain: 1,
        textCx: p.cx, textCy: p.cy,
        layers: [{ source: 'test', kind: 'gradient', colors: testParsed.stops.map(s => s.color), rawImage: testGrad, bbox: testBbox }],
      };
      // worst-stop 应该都返回 1.0（最坏 stop = #fff）
      // position-aware 应返回 expected
      const worstActual = computeContrast(inputs);
      const posActual = computeContrastPositionAware(inputs);
      const pass = Math.abs(posActual - p.expected) < 0.3;
      posCases.push({
        name: p.name,
        expected: p.expected,
        actual: Number(posActual.toFixed(3)),
        pass,
        note: `worst-stop=${worstActual.toFixed(2)} (应为 1.0) → pos-aware=${posActual.toFixed(2)}`,
      });
    }
  }
  const baseCases = cases.map(c => {
    const actual = computeContrast(c.inputs);
    const pass = Math.abs(actual - c.expected) < 0.6;
    return { name: c.name, expected: c.expected, actual: Number(actual.toFixed(3)), pass, note: c.note };
  });
  return [...baseCases, ...posCases];
}

// ─── 3. 浏览器采集层 ───────────────────────────────────────

const THEMES = [
  'aurora', 'midnight', 'navy', 'pine', 'burgundy', 'charcoal',
  'graphite', 'deepgray', 'obsidian', 'jadeblack', 'slate',
  'sunset', 'deepsea', 'forest', 'cosmos',
];

const COMPONENTS = [
  { selector: '.lgx-name', label: '玩家名(正文)', threshold: 4.5 },
  { selector: '.lgx-sub', label: '副信息(正文)', threshold: 4.5 },
  { selector: '.lgx-rating-num', label: 'RATING数字(大字)', threshold: 3.0 },
  { selector: '.lgx-tier', label: '段位徽章', threshold: 3.0 },
  { selector: '.lgx-podium-name', label: '前三名(大字)', threshold: 3.0 },
  { selector: '.lgx-mode-rank-num', label: '模式排名(小字)', threshold: 4.5 },
];

interface RawLayerInfo {
  source: string;
  bgColor: string;   // 原始 backgroundColor 字符串
  bgImage: string;   // 原始 backgroundImage 字符串
  bbox?: { x: number; y: number; w: number; h: number };  // 该层所在元素的 viewport bbox（位置感知用）
}

interface RawStyleInputs {
  label: string;
  selector: string;
  threshold: number;
  found: boolean;
  textRgba: Rgba | null;
  opacityChain: number;
  layers: RawLayerInfo[];   // 自顶向下（最靠近 text 的层在前）
  textBbox?: { cx: number; cy: number };  // 文字元素中心 viewport 坐标（位置感知用）
  missing?: boolean;
}

/**
 * 浏览器侧只采原始 style：
 *  - text color + opacity
 *  - 祖先链：每个有 bg（color 非透明 OR image 非 none）的祖先 → 一层
 *  - 透明祖先 → opacity 连乘（panel 未找到前）
 * 不算对比度（所有数学在 TS 侧，可自测）
 */
async function collectStyleInputs(): Promise<RawStyleInputs[]> {
  const jsCode = `(function(){
    var comps = ${JSON.stringify(COMPONENTS)};
    var results = [];
    function alphaOf(bgColor){
      if (!bgColor) return 0;
      if (bgColor === 'transparent') return 0;
      var m = bgColor.match(/rgba?\\(\\s*\\d+[\\s,]+\\d+[\\s,]+\\d+(?:[\\s,]+([0-9.]+))?/);
      if (!m) return 1;
      return m[1] !== undefined ? parseFloat(m[1]) : 1;
    }
    function parseRgba(str){
      if (!str) return null;
      var m = str.match(/rgba?\\(\\s*(\\d+)[\\s,]+(\\d+)[\\s,]+(\\d+)(?:[\\s,]+([0-9.]+))?/);
      if (!m) return null;
      return {r:+m[1], g:+m[2], b:+m[3], a: m[4]!==undefined?+m[4]:1};
    }
    function descNode(node){
      if (!node) return '';
      var tag = node.tagName.toLowerCase();
      var cls = '';
      if (node.className && typeof node.className === 'string') {
        cls = '.' + node.className.split(/\\s+/).filter(Boolean).slice(0,2).join('.');
      }
      return '<' + tag + cls + '>';
    }
    comps.forEach(function(c){
      var el = document.querySelector(c.selector);
      if (!el) {
        results.push({label: c.label, selector: c.selector, threshold: c.threshold,
          found: false, textRgba: null, opacityChain: 1, layers: [], missing: true});
        return;
      }
      var cs = getComputedStyle(el);
      var textRgba = parseRgba(cs.color);
      var opacityChain = parseFloat(cs.opacity) || 1;
      // 文字元素中心 viewport 坐标（位置感知用）
      var elRect = el.getBoundingClientRect();
      var textBbox = {cx: elRect.left + elRect.width/2, cy: elRect.top + elRect.height/2};
      var layers = [];
      var panelFound = false;
      // 走祖先链：
      //   - 透明祖先 → opacity 连乘（panel 未找到前）
      //   - 第一个有 bg（color 或 image）的祖先 → panel，停止 opacity walk
      //   - 继续向上收集更多 bg 层（gradient 在 panel 之上）
      var node = el.parentElement;
      var guard = 0;
      while (node && guard < 30) {
        guard++;
        var pcs = getComputedStyle(node);
        var bg = pcs.backgroundColor;
        var bgImg = pcs.backgroundImage;
        var bgAlpha = alphaOf(bg);
        var hasImg = bgImg && bgImg !== 'none';
        var isBodyHtml = node === document.body || node === document.documentElement;
        if (!panelFound) {
          if (bgAlpha > 0 || hasImg) {
            // 找到 panel（第一层）— 收集 + bbox，停止 opacity walk
            var r = node.getBoundingClientRect();
            layers.push({source: descNode(node), bgColor: bg, bgImage: hasImg ? bgImg : '', bbox: {x: r.left, y: r.top, w: r.width, h: r.height}});
            panelFound = true;
          } else {
            // 透明祖先 — opacity 连乘
            var op = parseFloat(pcs.opacity) || 1;
            if (op < 1) opacityChain *= op;
          }
        } else {
          // 已有 panel — 继续收集上层 bg（页面 gradient 等）
          if (bgAlpha > 0 || hasImg) {
            var r2 = node.getBoundingClientRect();
            layers.push({source: descNode(node), bgColor: bg, bgImage: hasImg ? bgImg : '', bbox: {x: r2.left, y: r2.top, w: r2.width, h: r2.height}});
          }
        }
        node = node.parentElement;
      }
      // 兜底：若没找到任何层，从 body 取 bg
      if (layers.length === 0) {
        var bodyCs = getComputedStyle(document.body);
        var bodyBg = bodyCs.backgroundColor;
        var bodyImg = bodyCs.backgroundImage;
        if (alphaOf(bodyBg) > 0 || (bodyImg && bodyImg !== 'none')) {
          var br = document.body.getBoundingClientRect();
          layers.push({source: '<body>', bgColor: bodyBg, bgImage: bodyImg && bodyImg !== 'none' ? bodyImg : '', bbox: {x: br.left, y: br.top, w: br.width, h: br.height}});
        }
      }
      results.push({
        label: c.label, selector: c.selector, threshold: c.threshold,
        found: true, textRgba: textRgba, opacityChain: opacityChain,
        layers: layers, textBbox: textBbox
      });
    });
    return JSON.stringify(results);
  })()`;

  // 用 --stdin 避免引号转义问题
  const tmpFile = '/tmp/w5-eval-script.js';
  await Bun.write(tmpFile, jsCode);
  let raw: string;
  try {
    raw = execSync(`cat ${tmpFile} | agent-browser eval --stdin`, {
      timeout: 20000, encoding: 'utf8',
    }).trim();
  } catch (e) {
    return [{ label: 'BROWSER_ERROR', selector: '', threshold: 0, found: false,
      textRgba: null, opacityChain: 0, layers: [], missing: true }];
  }
  // eval --stdin 返回值是 JSON 字符串（带引号），需双层 parse
  let arr: any[];
  try {
    const first = JSON.parse(raw);
    const inner = typeof first === 'string' ? first : raw;
    arr = JSON.parse(inner);
  } catch {
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error('  ⚠ eval 输出解析失败，raw head:', raw.slice(0, 200));
      return [];
    }
  }
  return arr as RawStyleInputs[];
}

/** 将 RawLayerInfo（原始字符串）转为 BgLayer（解析后的 Rgba[] + rawImage + bbox） */
function buildLayers(rawLayers: RawLayerInfo[]): BgLayer[] {
  const out: BgLayer[] = [];
  for (const rl of rawLayers) {
    // 优先 gradient（bg-image）
    if (rl.bgImage && rl.bgImage !== 'none') {
      const stops = parseGradientStops(rl.bgImage);
      if (stops.length > 0) {
        out.push({ source: rl.source, kind: 'gradient', colors: stops, rawImage: rl.bgImage, bbox: rl.bbox });
        continue;
      }
    }
    // 兜底 solid（bg-color）
    if (rl.bgColor && rl.bgColor !== 'transparent') {
      const c = parseColor(rl.bgColor);
      if (c && c.a > 0) {
        out.push({ source: rl.source, kind: 'solid', colors: [c], bbox: rl.bbox });
        continue;
      }
    }
    // 极少数情况：bg-image 解析失败 + bg-color 透明 → 跳过此层
  }
  return out;
}

// 切主题：localStorage + reload（store 不在全局，eval 取不到 setTheme）
// 若 localStorage eval 失败（页面掉到 about:blank），用 navigate（不 open，避免 OOM）
function switchTheme(theme: string) {
  const setLs = () => {
    execSync(`agent-browser eval "localStorage.setItem('goatb-theme','${theme}')"`,
      { timeout: 5000, encoding: 'utf8', stdio: 'pipe' });
  };
  try {
    setLs();
  } catch {
    // 页面可能掉到 about:blank — 用 navigate（open 会触发 dev server OOM）
    execSync('agent-browser navigate http://localhost:3000', { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
    execSync('agent-browser wait 3000', { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
    setLs();
  }
  execSync('agent-browser reload', { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
  execSync('agent-browser wait 2500', { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
}

// ─── 4. 主流程 ──────────────────────────────────────────────

const mode = process.argv.find(a => a.startsWith('--')) || '--full';

console.log('=== W5 对比度扫描 v2（alpha 保留 + 三层合成） ===\n');

// Step 1: self-test
console.log('▶ Step 1: self-test（4 对已知值）');
const selfTestResults = runSelfTest();
let selfTestPass = true;
for (const r of selfTestResults) {
  const status = r.pass ? '✅' : '❌';
  console.log(`  ${status} ${r.name}: expected ${r.expected}, actual ${r.actual}`);
  if (!r.pass) {
    selfTestPass = false;
    console.log(`     note: ${r.note}`);
  }
}

if (!selfTestPass) {
  console.log('\n🔴 self-test 不过 — 不碰 15 主题。请审 note 修正公式后重跑。');
  process.exit(1);
}
console.log('  → self-test 全过\n');

if (mode === '--selftest') {
  console.log('（--selftest 模式，到此结束）');
  process.exit(0);
}

// Step 2: 扫描
// --themes=a,b,c 指定主题列表（分批跑避免 OOM）
const themesArg = process.argv.find(a => a.startsWith('--themes='));
const themesToScan = themesArg ? themesArg.slice('--themes='.length).split(',')
  : mode === '--smoke' ? ['aurora']
  : mode === '--samples' ? ['pine', 'obsidian']
  : THEMES;
console.log(`▶ Step 2: 扫描 ${themesToScan.length} 主题 ${themesArg ? `(${themesToScan.join(',')})` : mode === '--smoke' ? '(smoke)' : mode === '--samples' ? '(samples)' : '(全量)'}\n`);

interface ComponentResult extends RawStyleInputs {
  layers: any[];       // built BgLayer[] for reporting
  ratio: number;       // worst-stop ratio (v2)
  pass: boolean;       // worst-stop pass
  posRatio: number;    // position-aware ratio (v2.1)
  posPass: boolean;    // position-aware pass
  textCx?: number;     // text center x (debug)
  textCy?: number;     // text center y (debug)
}
const allResults: Array<{ theme: string; components: ComponentResult[] }> = [];

// 预热：确保 agent-browser 在 localhost:3000（用 navigate 不 open，避免 OOM 杀 dev）
console.log('▶ Step 1.5: 预热 agent-browser → localhost:3000');
try {
  execSync('agent-browser navigate http://localhost:3000', { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
  execSync('agent-browser wait 3000', { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  console.log('  ⚠ 预热 navigate 失败，继续尝试（可能已在页面）');
}

for (const theme of themesToScan) {
  console.log(`▶ 主题: ${theme}`);
  try {
    switchTheme(theme);
    const raws = await collectStyleInputs();
    const components: ComponentResult[] = raws.map(r => {
      const builtLayers = r.found ? buildLayers(r.layers) : [];
      let ratio = 0, posRatio = 0;
      if (r.found && r.textRgba && builtLayers.length > 0) {
        const ci: ContrastInputs = {
          textRgba: r.textRgba,
          opacityChain: r.opacityChain,
          layers: builtLayers,
          textCx: r.textBbox?.cx,
          textCy: r.textBbox?.cy,
        };
        ratio = computeContrast(ci);
        posRatio = computeContrastPositionAware(ci);
      }
      return {
        ...r, layers: builtLayers,
        ratio: Number(ratio.toFixed(2)), pass: ratio >= r.threshold,
        posRatio: Number(posRatio.toFixed(2)), posPass: posRatio >= r.threshold,
        textCx: r.textBbox?.cx, textCy: r.textBbox?.cy,
      };
    });
    for (const c of components) {
      if (!c.found) {
        console.log(`    ${c.label}: NOT FOUND (${c.selector})`);
      } else {
        const wStatus = c.pass ? '✅' : '❌';
        const pStatus = c.posPass ? '✅' : '❌';
        const delta = (c.posRatio - c.ratio).toFixed(2);
        const deltaStr = Number(delta) > 0 ? `+${delta}` : delta;
        console.log(`    worst ${wStatus} ${c.ratio}  |  pos ${pStatus} ${c.posRatio}  (Δ${deltaStr})  |  ${c.label}  [cx=${c.textCx?.toFixed(0)},cy=${c.textCy?.toFixed(0)}]`);
      }
    }
    allResults.push({ theme, components });
  } catch (e: any) {
    console.log(`  ⚠ 主题 ${theme} 扫描失败: ${String(e.message || e).slice(0, 150)}`);
    allResults.push({ theme, components: [] });
  }
  console.log('');
}

// Step 3: 报告
const lines: string[] = [];
lines.push('# W5 · 全主题对比度审计报告 v2.1\n');
lines.push('> **v2.1 — 在 v2 基础上加位置感知 gradient 采样。**');
lines.push('> v2 取全局最坏 stop（笛卡尔积 min），对 `linear-gradient(135deg, dark, light, dark)` 这类「中段亮、两端暗」的渐变过度报告——文字在左侧/右侧时 t 不在中段亮带。');
lines.push('> v2.1 按文字中心在 gradient 轴上的 t 插值取色，反映真实呈现。两列并排：worst-stop（v2）vs position-aware（v2.1）。');
lines.push('> 视口：1280×577（agent-browser 默认）。正文 ≥ 4.5:1，大字 ≥ 3:1。');
lines.push('> 生成时间：' + new Date().toISOString() + '\n');

lines.push('## self-test\n');
lines.push('| 用例 | 预期 | 实测 | 通过 | note |');
lines.push('|---|---|---|---|---|');
for (const r of selfTestResults) {
  lines.push(`| ${r.name} | ${r.expected} | ${r.actual} | ${r.pass ? '✅' : '❌'} | ${r.note || ''} |`);
}
lines.push('');

let totalWorstPass = 0, totalWorstFail = 0;
let totalPosPass = 0, totalPosFail = 0;
const falseLows: Array<{ theme: string; label: string; worst: number; pos: number; delta: number; threshold: number }> = [];
const trueFails: Array<{ theme: string; label: string; worst: number; pos: number; threshold: number }> = [];

for (const { theme, components } of allResults) {
  lines.push(`## 主题：${theme}\n`);
  lines.push('| 组件 | worst-stop | worst 结果 | pos-aware | pos 结果 | Δ | 阈值 | text-pos |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of components) {
    if (!c.found) {
      lines.push(`| ${c.label} | — | ⚠️ NOT FOUND | — | — | — | ${c.threshold} | — |`);
      continue;
    }
    const wStatus = c.pass ? '✅' : '❌';
    const pStatus = c.posPass ? '✅' : '❌';
    const delta = (c.posRatio - c.ratio).toFixed(2);
    const deltaStr = Number(delta) > 0 ? `+${delta}` : delta;
    const pos = c.textCx !== undefined ? `(${c.textCx.toFixed(0)},${c.textCy?.toFixed(0)})` : '—';
    lines.push(`| ${c.label} | ${c.ratio} | ${wStatus} | ${c.posRatio} | ${pStatus} | ${deltaStr} | ${c.threshold} | ${pos} |`);
    if (c.pass) totalWorstPass++; else totalWorstFail++;
    if (c.posPass) totalPosPass++; else totalPosFail++;
    // 分类：worst 失败但 pos 通过 = 假低值；两者都失败 = 真失败
    if (!c.pass && c.posPass) {
      falseLows.push({ theme, label: c.label, worst: c.ratio, pos: c.posRatio, delta: Number(deltaStr), threshold: c.threshold });
    }
    if (!c.pass && !c.posPass) {
      trueFails.push({ theme, label: c.label, worst: c.ratio, pos: c.posRatio, threshold: c.threshold });
    }
  }
  lines.push('');
}

lines.push('## 汇总\n');
lines.push(`- worst-stop（v2）：通过 ${totalWorstPass} / 不通过 ${totalWorstFail}`);
lines.push(`- position-aware（v2.1）：通过 ${totalPosPass} / 不通过 ${totalPosFail}\n`);

if (falseLows.length > 0) {
  lines.push(`## 假低值（worst ❌ → pos ✅，共 ${falseLows.length} 项）\n`);
  lines.push('| 主题 | 组件 | worst | pos | Δ | 阈值 |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of falseLows) {
    lines.push(`| ${f.theme} | ${f.label} | ${f.worst} | ${f.pos} | ${f.delta > 0 ? '+' : ''}${f.delta} | ${f.threshold} |`);
  }
  lines.push('');
}

if (trueFails.length > 0) {
  lines.push(`## 真失败（worst ❌ 且 pos ❌，共 ${trueFails.length} 项）\n`);
  lines.push('| 主题 | 组件 | worst | pos | 阈值 |');
  lines.push('|---|---|---|---|---|');
  for (const f of trueFails) {
    lines.push(`| ${f.theme} | ${f.label} | ${f.worst} | ${f.pos} | ${f.threshold} |`);
  }
  lines.push('');
}

const report = lines.join('\n');
await Bun.write('docs/theme-audit.md', report);
console.log(`▶ 报告已生成: docs/theme-audit.md`);
console.log(`▶ worst-stop: 通过 ${totalWorstPass} / 不通过 ${totalWorstFail}`);
console.log(`▶ position-aware: 通过 ${totalPosPass} / 不通过 ${totalPosFail}`);
console.log(`▶ 假低值（worst❌→pos✅）: ${falseLows.length} 项`);
console.log(`▶ 真失败（worst❌且pos❌）: ${trueFails.length} 项`);
