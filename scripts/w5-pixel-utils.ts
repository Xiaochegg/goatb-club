// ============================================================
// W5 · 像素采样工具（带通道自检 + 锚点校验）
// ============================================================
// 防止通道错位：从 sharp().raw() 的 info.channels 动态取步长
// 断言 data.length === width*height*channels，不满足抛错
// 锚点校验：先测已知纯色区域，不过则后面所有数都不算
// ============================================================

import sharp from 'sharp';

export interface PixelSample {
  r: number; g: number; b: number;
}

export interface ScanResult {
  label: string;
  bbox: { x: number; y: number; w: number; h: number };
  otsuThreshold: number;
  foregroundCount: number;
  backgroundCount: number;
  textMedian: PixelSample;      // 文字主体色（前景像素中位数）
  bgMedian: PixelSample;        // 背景色（背景像素中位数）
  ratio: number;                // WCAG 对比度
  threshold: number;            // 阈值
  pass: boolean;
}

export interface ScanContext {
  file: string;
  width: number;
  height: number;
  channels: number;
  data: Buffer;
  timestamp: string;
}

/** 加载截图 + 通道自检断言 */
export async function loadScreenshot(file: string): Promise<ScanContext> {
  const meta = await sharp(file).metadata();
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });

  // 硬断言：data.length 必须等于 width*height*channels
  const expected = info.width * info.height * info.channels;
  if (data.length !== expected) {
    throw new Error(
      `通道自检失败: data.length(${data.length}) !== width(${info.width})×height(${info.height})×channels(${info.channels})=${expected}\n` +
      `可能原因：sharp raw() 输出通道数与预期不符，或图像损坏`
    );
  }

  return {
    file,
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
    timestamp: new Date().toISOString(),
  };
}

/** 取像素（动态步长，不写死 *4）*/
export function getPixel(ctx: ScanContext, x: number, y: number): PixelSample {
  if (x < 0 || x >= ctx.width || y < 0 || y >= ctx.height) {
    throw new Error(`像素越界: (${x},${y}) 超出 ${ctx.width}×${ctx.height}`);
  }
  const i = (y * ctx.width + x) * ctx.channels;
  return { r: ctx.data[i], g: ctx.data[i + 1], b: ctx.data[i + 2] };
}

/** 锚点校验：测已知纯色区域，预期值不匹配则抛错 */
export function assertAnchor(
  ctx: ScanContext,
  x: number,
  y: number,
  expected: PixelSample,
  tolerance: number = 30,
  label: string = 'anchor',
): void {
  const actual = getPixel(ctx, x, y);
  const dr = Math.abs(actual.r - expected.r);
  const dg = Math.abs(actual.g - expected.g);
  const db = Math.abs(actual.b - expected.b);
  if (dr > tolerance || dg > tolerance || db > tolerance) {
    throw new Error(
      `锚点校验失败 [${label}]: (${x},${y}) 实际 rgb(${actual.r},${actual.g},${actual.b}) ` +
      `与预期 rgb(${expected.r},${expected.g},${expected.b}) 偏差超 ${tolerance} ` +
      `(dr=${dr},dg=${dg},db=${db})\n` +
      `锚点不过，后面所有采样数据都不算`
    );
  }
}

function relativeLuminance(c: PixelSample): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(a: PixelSample, b: PixelSample): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Otsu 阈值法分析某区域 */
export function otsuScan(
  ctx: ScanContext,
  label: string,
  bbox: { x: number; y: number; w: number; h: number },
  threshold: number,
): ScanResult {
  const { x, y, w, h } = bbox;
  // 收集区域内所有像素亮度
  const pixels: Array<{ p: PixelSample; l: number }> = [];
  for (let yy = y; yy < Math.min(y + h, ctx.height); yy++) {
    for (let xx = x; xx < Math.min(x + w, ctx.width); xx++) {
      const p = getPixel(ctx, xx, yy);
      pixels.push({ p, l: relativeLuminance(p) });
    }
  }
  if (pixels.length === 0) {
    throw new Error(`区域无像素: ${label} bbox(${x},${y},${w},${h})`);
  }
  pixels.sort((a, b) => a.l - b.l);

  // Otsu 阈值
  let bestT = 0, bestVar = 0;
  const total = pixels.length;
  const sum = pixels.reduce((a, b) => a + b.l, 0);
  let sumB = 0, countB = 0;
  for (let i = 0; i < total; i++) {
    sumB += pixels[i].l;
    countB++;
    const wB = countB / total;
    const wF = 1 - wB;
    if (total - countB === 0) break;
    const mB = sumB / countB;
    const mF = (sum - sumB) / (total - countB);
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; bestT = pixels[i].l; }
  }

  // 分离前景/背景
  const fg: PixelSample[] = [];
  const bg: PixelSample[] = [];
  for (const { p, l } of pixels) {
    if (l > bestT) fg.push(p);
    else bg.push(p);
  }
  if (fg.length === 0) {
    throw new Error(`无前景像素: ${label} Otsu阈值=${bestT.toFixed(2)}`);
  }

  fg.sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
  bg.sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
  const textMedian = fg[Math.floor(fg.length / 2)];
  const bgMedian = bg[Math.floor(bg.length / 2)] || pixels[0].p;
  const ratio = contrastRatio(textMedian, bgMedian);

  return {
    label, bbox, otsuThreshold: Number(bestT.toFixed(2)),
    foregroundCount: fg.length, backgroundCount: bg.length,
    textMedian, bgMedian, ratio: Number(ratio.toFixed(2)),
    threshold, pass: ratio >= threshold,
  };
}
