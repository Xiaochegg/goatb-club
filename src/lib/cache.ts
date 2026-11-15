// ============================================================
// lib/cache.ts — Lightweight in-memory TTL cache for hot API routes.
//
// Why: sandbox has 4GB / 0 swap. Repeated heavy DB queries (stats
// aggregation, full-table leaderboard) cause memory spikes under
// concurrency. A 15-60s shared cache collapses N concurrent requests
// into 1 DB round-trip and serves the rest from memory.
//
// Design:
//   - Module-level Map<string, Entry> — survives across requests in
//     the same Node process (Next dev/standalone). Lost on restart,
//     which is fine (callers recompute).
//   - stale-while-revalidate: if a key is expired but present, we
//     return the stale value immediately and kick off a background
//     refresh so the next request gets fresh data. This keeps p99
//     low even when the upstream fetch is slow.
//   - Single-flight: concurrent callers for the same key share one
//     in-flight promise, preventing thundering-herd DB spikes.
//   - Optional invalidate() for admin mutations to bust the cache.
// ============================================================

/** Sentinel for "no data yet" (placeholder entry while a cold-miss fetch is
 * in flight). Using a unique symbol instead of `undefined` lets callers
 * legitimately cache `undefined` as a real value without being mistaken for
 * a placeholder. */
const NO_DATA: unique symbol = Symbol('cache.no-data');
type Data<T> = T | typeof NO_DATA;

interface EntryInternal {
  data: Data<unknown>;
  expires: number;
  refreshing?: Promise<unknown>;
}

const store = new Map<string, EntryInternal>();

// OPT-C：容量上限——players:list:{search} 这类含用户输入的键此前无限累积
// （每个新搜索串一个键），长会话下内存缓慢增长。FIFO 淘汰最旧条目即可
// （缓存 miss 只是一次重算，无正确性影响）。
const MAX_CACHE_ENTRIES = 500;

/**
 * Read a cached value if present and not expired.
 * Returns null on miss or expiry (does NOT return stale — use withCache for SWR).
 * Note: if the cached value is legitimately `undefined`, this returns `undefined`
 * (not null) — callers should use `=== null` to distinguish a miss.
 */
export function getCached<T>(key: string): T | null {
  const e = store.get(key);
  if (!e || Date.now() > e.expires) return null;
  return (e.data === NO_DATA ? undefined : e.data) as T | null;
}

/**
 * Store a value with a TTL (ms). Overwrites any existing entry.
 */
export function setCached<T>(key: string, data: T, ttlMs: number): void {
  if (!store.has(key) && store.size >= MAX_CACHE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { data: data as unknown as Data<unknown>, expires: Date.now() + ttlMs });
}

/**
 * Invalidate one key (e.g. after a mutation that affects it).
 * Deleting the entry is enough: any in-flight refresh for this key holds
 * a reference to the OLD entry object, and on completion it checks
 * `store.get(key) === oldEntry`. After deletion (or replacement by a
 * newer write), the reference check fails and the stale result is
 * discarded. Other keys' entries/references are untouched.
 */
export function invalidate(key: string): void {
  store.delete(key);
}

/**
 * Invalidate all keys matching a prefix. Only the entries whose keys match
 * the prefix are deleted; entries outside the prefix keep their object
 * identity, so their in-flight refreshes are unaffected.
 */
export function invalidatePrefix(prefix: string): void {
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/**
 * Convenience: bust all player-list and stats caches at once.
 * Call this after ANY mutation that changes player data (create,
 * update, delete, like, recalc, import, batch-delete, claim approve,
 * sandbox seed/clear, undo). This is the single source of truth for
 * "player data changed" cache invalidation.
 */
export function bustPlayerCaches(): void {
  invalidatePrefix('players:');
  invalidate('stats:overview');
}

/**
 * Clear the entire cache. Mainly for tests / admin "purge" action.
 */
export function clearCache(): void {
  store.clear();
}

/**
 * Get-or-compute with TTL + single-flight + stale-while-revalidate.
 *
 * - Fresh hit  → return cached data immediately
 * - Stale hit  → return stale data, refresh in background (non-blocking)
 * - Miss       → run fn, cache, return (other concurrent callers await the same promise)
 *
 * @param key    cache key (include params, e.g. "stats:overview")
 * @param ttlMs  time-to-live in ms (fresh window)
 * @param fn     producer — only called on miss or background refresh
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const e = store.get(key) as (EntryInternal & { data: Data<T> }) | undefined;

  // Fresh hit — but only if the entry has real data (not a cold-miss
  // placeholder whose data is NO_DATA while a fetch is in flight).
  if (e && e.data !== NO_DATA && now <= e.expires) {
    return e.data as T;
  }

  // Stale hit (expired but has data) — return stale, refresh in background (SWR)
  if (e && e.data !== NO_DATA) {
    if (!e.refreshing) {
      // Capture the entry object reference at refresh start. On completion,
      // only write back if store.get(key) still returns THIS SAME object.
      // If invalidate(key) deleted the entry, or a newer request replaced it
      // with a new object, the reference check fails and we discard our
      // (potentially stale) result — preventing the race where a pre-invalidate
      // refresh clobbers fresh data written by a post-invalidate request.
      // Reference identity is atomic, per-key, and needs no extra state.
      const entryAtStart = e;
      const refreshPromise = (async () => {
        try {
          const data = await fn();
          if (store.get(key) === entryAtStart) {
            store.set(key, { data, expires: Date.now() + ttlMs });
          }
          return data;
        } catch (err) {
          console.error(`[cache] background refresh failed for "${key}":`, err);
          throw err;
        } finally {
          // Self-heal: clear our in-flight marker on the SAME entry so the
          // next SWR call can start a new refresh. We do NOT delete the
          // entry — the stale data remains servable until a future refresh
          // succeeds. Skip if the entry was replaced or invalidated.
          if (store.get(key) === entryAtStart) {
            entryAtStart.refreshing = undefined;
          }
        }
      })();
      // The SWR caller returns e.data synchronously and never awaits this
      // promise. Attach a noop catcher so a failed background refresh does
      // not surface as an unhandled rejection (the error is already logged
      // above). The rejection is still observable to anyone awaiting
      // e.refreshing directly.
      refreshPromise.catch(() => {});
      e.refreshing = refreshPromise;
    }
    return e.data as T;
  }

  // Single-flight: an in-flight cold-miss fetch exists (placeholder entry
  // with data=NO_DATA). Reuse its promise instead of starting a second fetch.
  // All concurrent callers share one fetch — if it fails, all see the rejection
  // (this is correct single-flight semantics: one fetch, one outcome). The
  // placeholder's catch will self-heal (delete the entry), so the NEXT request
  // (after this failure) does a clean cold miss.
  if (e?.refreshing && e.data === NO_DATA) {
    return e.refreshing as Promise<T>;
  }

  // Cold miss — kick off the fetch. The placeholder object itself is the
  // identity token: on completion we only commit if store.get(key) still
  // returns THIS placeholder. If invalidate(key) deleted it, or a newer
  // request replaced it, we discard our result. No counter/map needed.
  const placeholder: EntryInternal = {
    data: NO_DATA,
    expires: now + ttlMs,
  };
  const p = (async () => {
    try {
      const data = await fn();
      if (store.get(key) === placeholder) {
        store.set(key, { data: data as unknown as Data<unknown>, expires: Date.now() + ttlMs });
      }
      return data;
    } catch (err) {
      // Self-heal: remove our placeholder so the next request does a clean
      // cold miss. Otherwise the placeholder (data=NO_DATA) would pollute
      // getCached and confuse single-flight. Only delete if it is still ours.
      if (store.get(key) === placeholder) {
        store.delete(key);
      }
      throw err;
    } finally {
      // Only clear the marker if our placeholder is still the current entry.
      // After delete() in catch, store.get(key) !== placeholder, so this is
      // a no-op on the failure path.
      if (store.get(key) === placeholder) {
        placeholder.refreshing = undefined;
      }
    }
  })();
  placeholder.refreshing = p;
  store.set(key, placeholder);
  return p;
}

/**
 * Stats helper for an admin/dashboard "cache health" view.
 */
export function cacheStats(): { keys: number; entries: { key: string; expires: string; stale: boolean }[] } {
  const now = Date.now();
  const entries = Array.from(store.entries()).map(([key, e]) => ({
    key,
    expires: new Date(e.expires).toISOString(),
    stale: now > e.expires,
  }));
  return { keys: store.size, entries };
}
