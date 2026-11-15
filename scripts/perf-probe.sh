#!/usr/bin/env bash
# ============================================================
# GOATB · 超性能计划 P0 · 度量探针（单体简单任务，只读零产品代码改动）
# ------------------------------------------------------------
# 用法：bash scripts/perf-probe.sh
# 产出：docs/perf/raw-<时间戳>/{desktop,mobile}.json + .err
# 方法：
#   - 双 agent-browser 会话并行（desktop 1440×900 / mobile 390×844）；
#   - 全新会话 = 冷浏览器存储；wait networkidle + 2.5s 静置让水合与
#     首轮取数（players）完成后再采样；
#   - 采样源 = Performance API（navigation/paint/LCP/longtask/resource
#     buffered entries）+ 溢出检查 + 榜单内容就绪检查。
# 诚实边界（必读）：
#   - 本探针跑在 bun dev（Turbopack dev 产物）上，dev chunk 未压缩拆包，
#     绝对值显著劣于生产构建；本基线只用于「同环境相对比较与瓶颈定位」，
#     不得当作生产性能结论（沙箱禁 bun run build，生产基线留待部署环境）；
#   - 双会话并行共享沙箱 CPU，计时存在互相挤压噪声（报告已标注）。
# ============================================================
set -u
cd "$(dirname "$0")/.."

URL="http://localhost:3000"
OUT_DIR="docs/perf/raw-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

# 采样 JS（buffered entries；返回对象由 agent-browser 以 JSON 打印）
PROBE_JS='(() => {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const paints = performance.getEntriesByType("paint");
  const fcp = paints.find(p => p.name === "first-contentful-paint");
  const lcps = performance.getEntriesByType("largest-contentful-paint");
  const lcp = lcps[lcps.length - 1];
  const lt = performance.getEntriesByType("longtask");
  const res = performance.getEntriesByType("resource");
  const byType = {};
  for (const r of res) {
    const t = r.initiatorType || "other";
    const b = byType[t] || (byType[t] = { count: 0, bytes: 0 });
    b.count++; b.bytes += (r.transferSize || 0);
  }
  const top5 = res.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
    .slice(0, 5).map(r => ({ name: (r.name.split("/").pop() || r.name).slice(0, 70), bytes: r.transferSize || 0 }));
  const pf = res.filter(r => r.name.indexOf("/api/v1/players") >= 0)
    .map(r => ({ startMs: Math.round(r.startTime), durMs: Math.round(r.duration), bytes: r.transferSize || 0 }));
  const txt = document.body.innerText || "";
  return {
    viewport: [window.innerWidth, window.innerHeight],
    ttfbMs: Math.round(nav.responseStart || 0),
    dclMs: Math.round(nav.domContentLoadedEventEnd || 0),
    loadMs: Math.round(nav.loadEventEnd || 0),
    fcpMs: fcp ? Math.round(fcp.startTime) : null,
    lcp: lcp ? { ms: Math.round(lcp.startTime), size: lcp.size, tag: lcp.element ? lcp.element.tagName : "?" } : null,
    longTasks: { count: lt.length, totalMs: Math.round(lt.reduce((s, t) => s + t.duration, 0)) },
    resources: {
      count: res.length,
      totalBytes: res.reduce((s, r) => s + (r.transferSize || 0), 0),
      byType, top5
    },
    playersFetch: pf,
    contentReady: txt.indexOf("LEADERBOARD") >= 0,
    overflowPx: document.documentElement.scrollWidth - window.innerWidth
  };
})()'

probe() {
  local name="$1" w="$2" h="$3"
  local s="perf-$name"
  agent-browser --session "$s" set viewport "$w" "$h" >/dev/null 2>&1
  agent-browser --session "$s" open "$URL" >/dev/null 2>&1
  agent-browser --session "$s" wait --load networkidle >/dev/null 2>&1
  sleep 2.5
  agent-browser --session "$s" eval "$PROBE_JS" > "$OUT_DIR/$name.json" 2> "$OUT_DIR/$name.err"
  agent-browser --session "$s" close >/dev/null 2>&1
}

# 双会话并行（管理员指令：并行完成）
probe desktop 1440 900 &
P1=$!
probe mobile 390 844 &
P2=$!
wait "$P1" "$P2"

echo "== probe done, raw dir: $OUT_DIR"
ls -la "$OUT_DIR"
for f in "$OUT_DIR"/*.json; do
  echo "== $f"
  head -c 400 "$f"; echo
done
