/**
 * OPT-B：客户端玩家取数共享层（消除 7 处复制粘贴）
 *
 * 服务端 Prisma Player.tiers / overrideScores / stats 存的是 JSON 字符串
 * （SQLite 无原生 JSON 列），前端消费前必须 parse。此前 page.tsx ×3 +
 * admin-panel.tsx ×4 各写一份相同逻辑，漂移风险高（AU 轮 limit=50 截断
 * bug 即源于多处各自维护 URL）。
 *
 * C3（轻量化改造 2026-11-03）：默认走 45s 短 TTL 客户端缓存（短 TTL 内
 * 重挂载/重试免重复下载）；管理端四处「写后刷新」调用一律传 { fresh: true }
 * 旁路缓存——比「写后失效」更严格，保证管理面板永远读到最新数据。
 * dataVersion bump（健康重试/手动重试）时缓存由 client-cache 订阅自动清空。
 */
import type { PlayerData } from './store';
import { cachedFetchJSON } from './client-cache';

const PLAYERS_URL = '/api/v1/players?limit=200';

/** 直连取数（保持 OPT-B 原语义：不检查 res.ok、players 缺失时返回 []） */
async function fetchPlayersJSON(): Promise<{ players?: Record<string, unknown>[] }> {
  const res = await fetch(PLAYERS_URL);
  return await res.json().catch(() => ({}));
}

/**
 * 拉取玩家列表并规范化（tiers/overrideScores/stats 字符串 → 对象）。
 * 默认带 45s 客户端 TTL 缓存（C3）；管理端写后刷新必须传 { fresh: true }。
 * 缓存路径下 JSON 解析异常会向上抛出（交由调用方的 V6 重试兜底），
 * 不再静默吞成 []——200-坏 JSON 属不可达路径，行为收紧已登记。
 */
export async function fetchNormalizedPlayers(opts?: { fresh?: boolean }): Promise<PlayerData[]> {
  const data = opts?.fresh
    ? await fetchPlayersJSON()
    : await cachedFetchJSON<{ players?: Record<string, unknown>[] }>(PLAYERS_URL);
  return ((data.players || []) as Record<string, unknown>[]).map(p => ({
    ...p,
    tiers: JSON.parse((p.tiers as string) || '{}'),
    overrideScores: JSON.parse((p.overrideScores as string) || '{}'),
    stats: JSON.parse((p.stats as string) || '{}'),
  })) as PlayerData[];
}
