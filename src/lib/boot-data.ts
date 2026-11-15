/**
 * boot-data.ts — 首屏取数前移（P1 #2，批复 2026-11-08「批准」）
 *
 * 探针 v2 实证（docs/perf/P0-BASELINE-V2-2026-11-08.md §四.F2）：
 *   首屏四路 GET（players/config/seasons/stats）全部在 React 水合完成后
 *   （~3.7s，被 1.4MB JS 下载+解析阻塞）才并发发起 → 榜单数据渲染被推到
 *   LCP 5.4s。本模块把「发起时机」前移到 HTML 解析阶段：
 *
 *   1. page.tsx return 顶部内联 BOOT_SCRIPT（SSR HTML 即带，位于框架 JS 之前）
 *      → 浏览器解析到该行立即 fetch 四路，与 JS 下载/解析完全并行；
 *   2. 水合后的既有消费点（cachedFetchJSON / bootAwareFetch）命中槽位即
 *      复用同一 Response（无重复请求），未命中自动回退原路径 fetch。
 *
 * 语义纪律：
 *   - 只预取公开只读 GET；auth/me（会话上下文）、admin/verify（管理员专用）、
 *     music/artist（播放器懒加载）不预取，行为零变化；
 *   - 槽位一次性消费（拿走即删）；boot 失败（catch→null）→ 回退正常 fetch，
 *     失败路径与直连 fetch 逐字对齐；
 *   - 幂等守卫：脚本被 React 水合重放等场景重复执行时不会重复发起 fetch；
 *   - SSR 安全：consumeBootResponse 有 typeof window 检查。
 */

declare global {
  interface Window {
    __goatbBoot?: Record<string, Promise<Response | null> | null>;
  }
}

/** 首屏四路公开只读 GET（URL 必须与消费点逐字一致） */
export const BOOT_URLS = [
  '/api/v1/players?limit=200', // api.ts PLAYERS_URL（fetchNormalizedPlayers）
  '/api/v1/config',            // page.tsx loadData
  '/api/v1/seasons',           // header.tsx（cachedFetchJSON）
  '/api/v1/stats',             // stats-sidebar.tsx（cachedFetchJSON）
] as const;

/** 内联引导脚本：HTML 解析到即发起四路 fetch（与框架 JS 完全并行） */
export const BOOT_SCRIPT = `(function(){try{var w=window;if(w.__goatbBoot)return;var s={};var u=${JSON.stringify(BOOT_URLS)};for(var i=0;i<u.length;i++){(function(url){try{s[url]=fetch(url,{credentials:'same-origin'}).catch(function(){return null})}catch(e){s[url]=null}})(u[i])}w.__goatbBoot=s}catch(e){}})();`;

// ============================================================
// 看门狗脚本（工单：手机 Brave 白屏修复 · 方案 D 强化版，管理员 2026-11-09 授权）
//
// 背景（诊断报告 §三 实验结论）：chunk 加载失败时 React 只是 Suspense
// 永久 pending，不 throw → error boundary 触发不了 → 骨架卡死无出口。
//
// 职责（全部 try/catch 包裹，任何失败静默跳过，绝不影响正常路径）：
//   1) 关键资源（script/link）加载失败 → 页面未就绪且本会话未自愈过
//      → 立即整页 reload（失败资源与 React 树解耦，reload 唯一可靠恢复）
//   2) 12s 未就绪（window.__goatbReady 未被 HomePage mount effect 置位）
//      → 同上 reload 一次（弱网/隧道挂起兜底）
//   3) 已自愈过仍未就绪 → 注入顶部非阻塞提示条（暖黄，可点击关闭），
//      不再 reload（防循环；sessionStorage 不可用时直接走提示条路径）
//
// 就绪信号：window.__goatbReady（HomePage 首个 mount effect 置位，
// 即 React 水合完成；数据加载慢不算未就绪——页面结构已可交互）。
// 幂等：__goatbWatchdog 键防重复执行（水合重放场景）。
// ============================================================
export const WATCHDOG_SCRIPT = `(function(){
try{
var w=window;
if(w.__goatbWatchdog)return;
w.__goatbWatchdog=true;
var K='goatb:watchdog-reload';
var retried=false;
try{retried=!!sessionStorage.getItem(K);}catch(e){retried=true;}
var ready=function(){return w.__goatbReady===true;};
var doReload=function(){
try{if(sessionStorage.getItem(K))return;sessionStorage.setItem(K,String(Date.now()));}catch(e){}
w.location.reload();
};
if(!retried){
w.addEventListener('error',function(e){
try{
var t=e.target;
if(!t||!t.tagName)return;
var tag=t.tagName.toUpperCase();
if(tag!=='SCRIPT'&&tag!=='LINK')return;
if(ready()||retried)return;
doReload();
}catch(x){}
},true);
setTimeout(function(){try{if(ready()||retried)return;doReload();}catch(x){}},12000);
}
setTimeout(function(){
try{
if(ready()||!retried)return;
var bar=document.createElement('div');
bar.setAttribute('role','status');
bar.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#26233a;color:#e8c268;font:13px/1.5 system-ui,-apple-system,\\'PingFang SC\\',\\'Microsoft YaHei\\',sans-serif;padding:10px 14px;text-align:center;';
bar.textContent='网络不稳定，部分资源加载受阻，内容可能不完整——可下拉刷新重试。';
bar.onclick=function(){if(bar.parentNode)bar.parentNode.removeChild(bar);};
(document.body||document.documentElement).appendChild(bar);
}catch(x){}
},12500);
}catch(e){}
})();`;

/**
 * 一次性消费 boot 槽：命中返回该路的 Response Promise（拿走即删），
 * 未命中 / SSR / boot 失败返回 null（调用方回退正常 fetch）。
 */
export function consumeBootResponse(url: string): Promise<Response | null> | null {
  if (typeof window === 'undefined') return null;
  const slots = window.__goatbBoot;
  if (!slots) return null;
  const slot = slots[url];
  if (!slot) return null;
  delete slots[url];
  return slot.catch(() => null);
}

/**
 * boot 感知 fetch（裸 fetch 消费点用，如 page.tsx 的 config）：
 * 命中 boot 槽复用其 Response，否则原样 fetch。
 */
export function bootAwareFetch(url: string): Promise<Response> {
  const boot = consumeBootResponse(url);
  if (!boot) return fetch(url);
  return boot.then(r => r ?? fetch(url)).catch(() => fetch(url));
}
