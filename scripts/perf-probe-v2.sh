#!/usr/bin/env bash
# ============================================================
# GOATB · 超性能计划 P0 · 度量探针 v2（单体简单任务，只读零产品代码改动）
# ------------------------------------------------------------
# v1 = scripts/perf-probe.sh（留档不动）。v2 相对 v1 的增量（全部继承
# v1 报告 docs/perf/P0-BASELINE-2026-11-08.md 的 §五.#4 与 §二.4）：
#   1. LCP / longtask 补采：v1 用 getEntriesByType 拿不到（API 限制），
#      v2 注入 PerformanceObserver({buffered:true}) 显式补采；
#   2. longtask 归因：attribution containerSrc/containerName 聚合；
#   3. 取数瀑布完整化：v1 只看 /api/v1/players → v2 抓全部 /api/ 调用
#      （path/start/dur/bytes），可见 HTML→JS→水合→fetch 全链时序；
#   4. 10s 稳态观察窗：注入观察器度量 1.5s 轮询心跳（次数/间隔/字节/
#      累计时长）+ rAF 帧率（canvas 背景动画开销）+ JS heap；
#   5. 冷/热双轮：同会话二次导航（warm），量化浏览器缓存收益；
#   6. 截图证据：冷轮收割后榜单就绪态截图（desktop/mobile 各一）；
#   7. 汇总件：scripts/perf-probe-v2-summarize.ts 生成 summary.md。
# 用法：bash scripts/perf-probe-v2.sh
# 产出：docs/perf/raw-v2-<时间戳>/
#         {desktop,mobile}.{cold,warm}.json + .steady.json + .err
#         {desktop,mobile}.png  summary.md
# 诚实边界（必读，继承 v1 全部边界）：
#   - dev 产物口径：跑在 bun dev（Turbopack dev）上，绝对值显著劣于
#     生产构建；只用于同环境相对比较与瓶颈定位；
#   - 双会话并行共享沙箱 CPU，计时互相挤压（两视口差异不过度解读）；
#   - headless 环境：rAF 帧率若为 0 或异常低，可能是无 GPU 节流而非
#     页面真实开销，如实标注不下结论；
#   - LCP 观察窗含轮询重绘：稳态窗内 DOM 更新可能顶高 LCP 终值，
#     与首屏 LCP 语义不同，报告中分列。
# ============================================================
set -u
cd "$(dirname "$0")/.."

URL="http://localhost:3000"
OUT_DIR="docs/perf/raw-v2-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

# ---------- JS #1：全量冷/热采样（冷热共用一份） ----------
COLD_JS='(() => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const paints = performance.getEntriesByType("paint");
  const fp = paints.find(p => p.name === "first-paint");
  const fcp = paints.find(p => p.name === "first-contentful-paint");
  const lt = performance.getEntriesByType("longtask");
  const res = performance.getEntriesByType("resource");
  const byType = {};
  for (const r of res) {
    const t = r.initiatorType || "other";
    const b = byType[t] || (byType[t] = { count: 0, bytes: 0 });
    b.count++; b.bytes += (r.transferSize || 0);
  }
  const top8 = res.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
    .slice(0, 8).map(r => ({
      name: (r.name.split("?")[0].split("/").pop() || r.name).slice(0, 60),
      startMs: Math.round(r.startTime),
      durMs: Math.round(r.duration),
      bytes: r.transferSize || 0,
      cached: (r.transferSize === 0 && (r.decodedBodySize || 0) > 0)
    }));
  const apis = res.filter(r => r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest")
    .filter(r => r.name.indexOf("/api/") >= 0)
    .sort((a, b) => a.startTime - b.startTime)
    .map(r => ({
      path: (r.name.replace(location.origin, "").split("?")[0] || "").slice(0, 70),
      startMs: Math.round(r.startTime),
      durMs: Math.round(r.duration),
      bytes: r.transferSize || 0
    }));
  const lts = lt.map(e => ({
    durMs: Math.round(e.duration),
    startMs: Math.round(e.startTime),
    at: (e.attribution && e.attribution[0] && (e.attribution[0].containerSrc || e.attribution[0].containerName)) || ""
  })).sort((a, b) => b.durMs - a.durMs).slice(0, 5);
  const lcpTyped = (function () {
    const a = performance.getEntriesByType("largest-contentful-paint");
    const x = a[a.length - 1];
    return x ? { ms: Math.round(x.startTime), tag: x.element ? x.element.tagName : "?" } : null;
  })();
  const txt = document.body.innerText || "";
  return {
    viewport: [window.innerWidth, window.innerHeight],
    ttfbMs: Math.round(nav.responseStart || 0),
    dclMs: Math.round(nav.domContentLoadedEventEnd || 0),
    loadMs: Math.round(nav.loadEventEnd || 0),
    fpMs: fp ? Math.round(fp.startTime) : null,
    fcpMs: fcp ? Math.round(fcp.startTime) : null,
    lcpByType: lcpTyped,
    longtasksByType: { count: lt.length, totalMs: Math.round(lt.reduce((s, t) => s + t.duration, 0)), top: lts },
    resources: { count: res.length, totalBytes: res.reduce((s, r) => s + (r.transferSize || 0), 0), byType: byType, top8: top8 },
    apiWaterfall: apis,
    contentReady: txt.indexOf("LEADERBOARD") >= 0,
    bodyChars: txt.length,
    overflowPx: document.documentElement.scrollWidth - window.innerWidth,
    heapNow: performance.memory ? { usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576) } : null
  };
})()'

# ---------- JS #2：注入观察器（轮询 / LCP buffered / longtask buffered / rAF） ----------
INJECT_JS='(() => {
  window.__pv2 = { poll: [], lcp: [], longtasks: [], raf: 0, __raf: 0, t0: Date.now() };
  try {
    new PerformanceObserver(function (l) {
      for (const e of l.getEntries()) if ((e.name || "").indexOf("/api/") >= 0)
        window.__pv2.poll.push({ s: Math.round(e.startTime), d: Math.round(e.duration), b: e.transferSize || 0, p: (e.name.replace(location.origin, "").split("?")[0] || "").slice(0, 60) });
    }).observe({ type: "resource", buffered: false });
  } catch (err) {}
  try {
    new PerformanceObserver(function (l) {
      for (const e of l.getEntries()) window.__pv2.lcp.push({ ms: Math.round(e.startTime), size: e.size, tag: e.element ? e.element.tagName : "?" });
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (err) {}
  try {
    new PerformanceObserver(function (l) {
      for (const e of l.getEntries()) window.__pv2.longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime), at: (e.attribution && e.attribution[0] && (e.attribution[0].containerSrc || e.attribution[0].containerName)) || "" });
    }).observe({ type: "longtask", buffered: true });
  } catch (err) {}
  const loop = function () { window.__pv2.raf++; window.__pv2.__raf = requestAnimationFrame(loop); };
  window.__pv2.__raf = requestAnimationFrame(loop);
  return "injected";
})()'

# ---------- JS #3：观察窗收割 ----------
STEADY_JS='(() => {
  const p = window.__pv2 || { poll: [], lcp: [], longtasks: [], raf: 0, t0: Date.now() };
  if (p.__raf) cancelAnimationFrame(p.__raf);
  const winS = Math.max(1, Math.round((Date.now() - (p.t0 || Date.now())) / 1000));
  const iv = [];
  for (let i = 1; i < p.poll.length; i++) iv.push(p.poll[i].s - p.poll[i - 1].s);
  const pollByPath = {};
  for (const e of p.poll) {
    const k = e.p || "?";
    const b = pollByPath[k] || (pollByPath[k] = { count: 0, durMs: 0, bytes: 0 });
    b.count++; b.durMs += e.d; b.bytes += e.b;
  }
  const mem = performance.memory;
  return {
    observedWindowS: winS,
    rafFrames: p.raf,
    rafFps: +(p.raf / winS).toFixed(1),
    lcpUpdates: p.lcp.length,
    lcpFinal: p.lcp.length ? p.lcp[p.lcp.length - 1] : null,
    longtasksAll: p.longtasks.slice(0, 10),
    pollTotal: p.poll.length,
    pollByPath: pollByPath,
    pollGapMsAvg: iv.length ? Math.round(iv.reduce((a, b) => a + b, 0) / iv.length) : null,
    heapNow: mem ? { usedMB: +(mem.usedJSHeapSize / 1048576).toFixed(1), totalMB: +(mem.totalJSHeapSize / 1048576).toFixed(1) } : null
  };
})()'

# ---------- 采样函数 ----------
# probe_phase <session> <json前缀> <观察窗秒> <截图路径或空>
probe_phase() {
  local s="$1" pre="$2" obs="$3" shot="$4"
  agent-browser --session "$s" wait --load networkidle >/dev/null 2>&1
  sleep 2.5
  agent-browser --session "$s" eval "$COLD_JS" > "$OUT_DIR/$pre.json" 2> "$OUT_DIR/$pre.err"
  agent-browser --session "$s" eval "$INJECT_JS" >/dev/null 2>&1
  sleep "$obs"
  agent-browser --session "$s" eval "$STEADY_JS" > "$OUT_DIR/$pre.steady.json" 2> "$OUT_DIR/$pre.steady.err"
  if [ -n "$shot" ]; then
    agent-browser --session "$s" screenshot "$shot" >/dev/null 2>&1
  fi
}

# probe_session <name> <w> <h>：冷轮(10s窗+截图) → 热轮(6s窗)
probe_session() {
  local name="$1" w="$2" h="$3"
  local s="perf-v2-$name"
  agent-browser --session "$s" set viewport "$w" "$h" >/dev/null 2>&1
  agent-browser --session "$s" open "$URL" >/dev/null 2>&1
  probe_phase "$s" "$name.cold" 10 "$OUT_DIR/$name.png"
  agent-browser --session "$s" open "$URL" >/dev/null 2>&1
  probe_phase "$s" "$name.warm" 6 ""
  agent-browser --session "$s" close >/dev/null 2>&1
}

# ---------- 双会话并行（管理员指令：并行完成） ----------
probe_session desktop 1440 900 &
P1=$!
probe_session mobile 390 844 &
P2=$!
wait "$P1" "$P2"

# ---------- 汇总 ----------
echo "== probe v2 done, raw dir: $OUT_DIR"
bun run scripts/perf-probe-v2-summarize.ts "$OUT_DIR" || echo "(summarize 失败，raw JSON 仍在 $OUT_DIR)"
