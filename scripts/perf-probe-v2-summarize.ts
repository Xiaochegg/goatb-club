/**
 * GOATB · 超性能计划 P0 · 探针 v2 汇总件（只读，零产品代码改动）
 * 用法：bun run scripts/perf-probe-v2-summarize.ts <rawDir>
 * 输入：<rawDir>/{desktop,mobile}.{cold,warm}.json + {cold,warm}.steady.json（perf-probe-v2.sh 产出）
 * 输出：<rawDir>/summary.md + stdout 同文
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Any = Record<string, any>;

function readJson(p: string): Any | null {
  try {
    const s = readFileSync(p, "utf8").trim();
    const i = s.indexOf("{");
    if (i < 0) return null;
    return JSON.parse(s.slice(i)) as Any;
  } catch {
    return null;
  }
}

function readErr(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

const kb = (b: unknown): string => {
  const n = Number(b) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`;
};
const ms = (v: unknown): string => (v === null || v === undefined ? "null" : `${Math.round(Number(v))}ms`);

function fmtRes(r: Any | null | undefined): string {
  if (!r) return "null";
  return `${r.count} / ${kb(r.totalBytes)}`;
}

function fmtLcp(l: Any | null | undefined): string {
  if (!l) return "null（API 限制，见稳态窗口 buffered 补采）";
  return `${l.ms}ms (${l.tag}·size${l.size ?? "?"})`;
}

function fmtLongtasks(list: Any[] | undefined, cap: number): string {
  if (!list || list.length === 0) return "无";
  return list
    .slice(0, cap)
    .map((t) => `d=${t.durMs ?? t.d}ms@s${t.startMs ?? t.s}${t.at ? ` at=${String(t.at).slice(0, 50)}` : ""}`)
    .join("；");
}

function fmtWaterfall(apis: Any[] | undefined): string {
  if (!apis || apis.length === 0) return "无 API 调用记录";
  const total = apis.reduce((s, a) => s + (a.bytes || 0), 0);
  const head = apis
    .slice(0, 8)
    .map((a) => `${a.startMs}ms·${a.durMs}ms·${kb(a.bytes)}·${a.path}`)
    .join("<br>");
  return `共${apis.length}次/${kb(total)}<br>${head}`;
}

function fmtSteady(s: Any | null): string[] {
  if (!s) return ["(稳态收割缺失，见 .err)"];
  const lines: string[] = [];
  lines.push(`- 观察窗：${s.observedWindowS}s（rAF ${s.rafFrames} 帧 → **${s.rafFps} fps**；headless 无 GPU，帧率偏低可能是环境节流而非页面真实开销）`);
  const pbp = (s.pollByPath || {}) as Any;
  const keys = Object.keys(pbp);
  if (keys.length === 0) {
    lines.push(`- 观察窗内 API 轮询：0 次（1.5s 轮询本应产生约窗长/1.5 次——若为 0 需人工核查轮询是否挂在别处或页面休眠）`);
  } else {
    for (const k of keys) {
      const v = pbp[k];
      lines.push(`- 轮询 ${k}：${v.count} 次 / 累计 ${v.durMs}ms / ${kb(v.bytes)}（间隔均值 ${s.pollGapMsAvg ?? "?"}ms）`);
    }
  }
  lines.push(`- LCP 终值（buffered 补采，含稳态重绘顶高，语义≠首屏 LCP）：${fmtLcp(s.lcpFinal)}（更新 ${s.lcpUpdates ?? 0} 次）`);
  lines.push(`- longtask（buffered 补采）：${fmtLongtasks(s.longtasksAll, 5)}`);
  lines.push(`- heap：used ${s.heapNow ? s.heapNow.usedMB + "MB" : "null"} / total ${s.heapNow ? s.heapNow.totalMB + "MB" : "null"}`);
  return lines;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法: bun run scripts/perf-probe-v2-summarize.ts <rawDir>");
    process.exit(1);
  }
  const out: string[] = [];
  out.push(`# 探针 v2 原始汇总（${dir}）`);
  out.push("");
  out.push(
    "> 生成于 " +
      new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) +
      " · 脚本 scripts/perf-probe-v2.sh + perf-probe-v2-summarize.ts · dev 产物口径，绝对值不作生产结论"
  );

  for (const name of ["desktop", "mobile"]) {
    const cold = readJson(join(dir, `${name}.cold.json`));
    const coldSteady = readJson(join(dir, `${name}.cold.steady.json`));
    const warm = readJson(join(dir, `${name}.warm.json`));
    const warmSteady = readJson(join(dir, `${name}.warm.steady.json`));
    const errs = [
      readErr(join(dir, `${name}.cold.err`)),
      readErr(join(dir, `${name}.cold.steady.err`)),
      readErr(join(dir, `${name}.warm.err`)),
      readErr(join(dir, `${name}.warm.steady.err`)),
    ].filter(Boolean);

    out.push("");
    out.push(`## ${name}`);
    if (!cold && !warm) {
      out.push("");
      out.push(`**冷/热采样均缺失**${errs.length ? `：${errs.join(" | ").slice(0, 300)}` : "（无 err 记录）"}`);
      continue;
    }

    out.push("");
    out.push("### 采样对比（冷轮=全新会话；热轮=同会话二次导航）");
    out.push("");
    const rows = [
      { k: "TTFB / DCL / load", cold: cold ? `${ms(cold.ttfbMs)} / ${ms(cold.dclMs)} / ${ms(cold.loadMs)}` : "null", warm: warm ? `${ms(warm.ttfbMs)} / ${ms(warm.dclMs)} / ${ms(warm.loadMs)}` : "-" },
      { k: "FP / FCP", cold: cold ? `${ms(cold.fpMs)} / ${ms(cold.fcpMs)}` : "null", warm: warm ? `${ms(warm.fpMs)} / ${ms(warm.fcpMs)}` : "-" },
      { k: "LCP（byType 兜底，预期 null）", cold: cold ? fmtLcp(cold.lcpByType) : "null", warm: warm ? fmtLcp(warm.lcpByType) : "-" },
      { k: "资源（个数 / 传输字节）", cold: cold ? fmtRes(cold.resources) : "null", warm: warm ? fmtRes(warm.resources) : "-" },
      { k: "script 字节/个数", cold: cold?.resources?.byType?.script ? `${kb(cold.resources.byType.script.bytes)} / ${cold.resources.byType.script.count}个` : "0", warm: warm?.resources?.byType?.script ? `${kb(warm.resources.byType.script.bytes)} / ${warm.resources.byType.script.count}个` : "-" },
      { k: "fetch(API) 字节/个数", cold: cold?.resources?.byType?.fetch ? `${kb(cold.resources.byType.fetch.bytes)} / ${cold.resources.byType.fetch.count}个` : "0", warm: warm?.resources?.byType?.fetch ? `${kb(warm.resources.byType.fetch.bytes)} / ${warm.resources.byType.fetch.count}个` : "-" },
      { k: "榜单就绪 / 溢出px", cold: cold ? `${cold.contentReady ? "✅" : "❌"} / ${cold.overflowPx}` : "null", warm: warm ? `${warm.contentReady ? "✅" : "❌"} / ${warm.overflowPx}` : "-" },
      { k: "heap usedMB", cold: cold?.heapNow ? `${cold.heapNow.usedMB}` : "null", warm: warm?.heapNow ? `${warm.heapNow.usedMB}` : "-" },
    ];
    out.push("| 指标 | 冷轮 | 热轮 |");
    out.push("| --- | --- | --- |");
    for (const r of rows) out.push(`| ${r.k} | ${r.cold} | ${r.warm} |`);

    if (cold) {
      out.push("");
      out.push("**API 取数瀑布（冷轮，全部 /api/ 调用按开始时刻排序）**：");
      out.push("");
      out.push(fmtWaterfall(cold.apiWaterfall));
      out.push("");
      out.push(`**Top 资源（冷轮，按传输字节）**：${(cold.resources?.top8 || []).map((r: Any) => `${r.name}·${kb(r.bytes)}${r.cached ? "(cached)" : ""}·${r.startMs}ms`).join(" → ")}`);
      out.push("");
      out.push(`**longtask（byType 兜底）**：${fmtLongtasks(cold.longtasksByType?.top, 5)}`);
    }

    out.push("");
    out.push("### 稳态观察窗·冷轮（注入后 10s 收割 + 截图）");
    out.push("");
    for (const l of fmtSteady(coldSteady)) out.push(l);

    out.push("");
    out.push("### 稳态观察窗·热轮（二次导航后注入，6s 收割）");
    out.push("");
    for (const l of fmtSteady(warmSteady)) out.push(l);

    if (errs.length) {
      out.push("");
      out.push(`> err 记录：${errs.join(" | ").slice(0, 300)}`);
    }
  }

  const text = out.join("\n") + "\n";
  writeFileSync(join(dir, "summary.md"), text);
  console.log(text);
  console.log(`\n== summary.md 已写入 ${dir}`);
}

main();
