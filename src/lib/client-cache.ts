/**
 * client-cache.ts — 客户端短 TTL 缓存 + 请求合并（C2/C3，轻量化改造 2026-11-03）
 *
 * 目标（v2 计划 3.4 节）：
 *   C2 请求收敛：stats（侧栏+页脚）、seasons（头部+页脚）的重复挂载请求
 *      共享同一缓存条目与在途 Promise，首屏挂载请求约 8 → 约 6。
 *   C3 缓存策略：玩家列表 / 统计 / 赛季设 30-60s 客户端 TTL（取 45s）；
 *      管理端写操作后定向失效（写后取数一律走 fresh 旁路，等价且更严格）；
 *      不新增 localStorage 业务缓存；管理端存档缓存保持现状。
 *
 * 语义纪律：
 *   - 仅内存缓存（模块级 Map），刷新页面即清零，无持久化。
 *   - dataVersion 变更（retryDataLoad）→ 全量失效：订阅 store，一次性接线。
 *   - 失败不入缓存：网络错误 / okRequired 下的非 2xx 均向上抛出，
 *     消费端行为与直连 fetch 逐字对齐。
 *   - 在途去重：并发调用共享同一 Promise，避免 TTL 边界的请求风暴。
 */

import { useAppStore } from './store';
import { consumeBootResponse } from './boot-data';

type Entry = { data: unknown; at: number };

const TTL_MS = 45_000; // 30-60s 区间中值（v2 计划 C3）
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export interface CachedFetchOptions {
  /** 覆盖默认 TTL（毫秒） */
  ttlMs?: number;
  /** true 时非 2xx 抛错（对齐 fetch 后手工检查 res.ok 的消费端，如 stats-sidebar） */
  okRequired?: boolean;
}

/** 带短 TTL 缓存与在途去重的 GET JSON。失败不缓存，语义对齐直连 fetch。 */
export function cachedFetchJSON<T = unknown>(url: string, opts?: CachedFetchOptions): Promise<T> {
  const ttl = opts?.ttlMs ?? TTL_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) {
    return Promise.resolve(hit.data as T);
  }
  const running = inflight.get(url);
  if (running) return running as Promise<T>;

  const p = (async () => {
    try {
      // P1 #2 boot 桥（批复 2026-11-08）：优先复用 HTML 解析期已发出的预取
      // Response（boot-data.ts）；未命中/失败回退原直连 fetch，语义逐字对齐。
      // 槽位一次性消费 + inflight 去重保证零重复请求。
      const boot = consumeBootResponse(url);
      const res = (boot ? await boot : null) ?? (await fetch(url));
      if (opts?.okRequired && !res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      cache.set(url, { data, at: Date.now() });
      return data as T;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

/** 定向失效：传 prefix 只清该前缀（如 '/api/v1/stats'）；不传全清。 */
export function invalidateClientCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k === prefix || k.startsWith(prefix)) cache.delete(k);
  }
}

// ── dataVersion 定向失效（C3：管理端写后失效复用既有机制）──────────
// store 的 retryDataLoad() bump dataVersion（V6 健康重试 / 手动重试共用）；
// 任何 bump 都意味着「数据可能已变」，此处一次性订阅并全量清缓存。
// store.ts 仅依赖 zustand/constants，静态导入无环；SSR 环境跳过接线。
if (typeof window !== 'undefined') {
  let lastVersion = useAppStore.getState().dataVersion;
  useAppStore.subscribe((s) => {
    if (s.dataVersion !== lastVersion) {
      lastVersion = s.dataVersion;
      cache.clear();
    }
  });
}
