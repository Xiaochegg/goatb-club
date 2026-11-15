import { db } from '@/lib/db';

// ============================================================
// game-name — 游戏ID 匹配工具（认领机制准确度修复，批示 trace 1a1d027ae7f6abd1）
// ------------------------------------------------------------
// 根因①：旧认领链路的撞名判定只有精确等值（findUnique(name)）——
// 管理员代录「GoatX」，正式玩家输入「goatx / ＧＯＡＴＸ / GoatX 」时
// 撞名检测漏判 → 直接注册出重复条目，认领通道永远不开启。
// 修复：两级匹配 = 精确 findUnique（快路径）→ 归一化兜底。
// 归一化：NFKC（折叠全角字母数字等兼容形式）+ 小写 + 去所有空白。
// 实现取整表 JS 比较（玩家表 ≤ 千级、注册低频；不用 LIKE——SQLite
// LIKE 仅 ASCII 不区分大小写且 %/_ 通配符有歧义，两头的坑都避开）。
// 仅服务端使用；不修改任何数据。
// ============================================================

/** 游戏ID 归一化键：NFKC 折叠全角 + 小写 + 去空白（纯函数，无副作用） */
export function normalizeGameName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * 按游戏ID查玩家（两级匹配）：
 * 1) 精确 findUnique（绝大多数命中，零额外成本）
 * 2) 归一化兜底：全表取 id/name + 凭据存在性（不出表外），JS 归一相等比较；
 *    命中后回表取完整行。
 * 返回完整 Player 行或 null。调用方（register / register-claim）据此决定
 * 认领通道开启与否；可认领判据统一为「无凭据」= passwordHash 为空。
 */
export async function findPlayerByGameName(name: string) {
  const trimmed = name.trim();
  const exact = await db.player.findUnique({ where: { name: trimmed } });
  if (exact) return exact;
  const norm = normalizeGameName(trimmed);
  if (!norm) return null;
  const candidates = await db.player.findMany({
    select: { id: true, name: true, email: true, passwordHash: true },
    take: 2000,
  });
  const hit = candidates.find((p) => normalizeGameName(p.name) === norm);
  if (!hit) return null;
  return db.player.findUnique({ where: { id: hit.id } });
}
