import { db } from '@/lib/db';
import { createHash, randomBytes } from 'node:crypto';

// ============================================================
// UNIFIED ACCOUNT V1 · P1（工单 2026-11-10）：一次性认证令牌服务
// ------------------------------------------------------------
// 设计（P0-C 设计稿 C2/C3，管理员批复采纳；与 schema AuthToken 对齐）：
//   - 令牌 = crypto.randomBytes(32) base64url（256 位熵）；
//   - 本表【只存 SHA-256 哈希】，明文令牌仅存在于邮件链接，绝不入库/入日志；
//   - 一次性：消费 = 按 tokenHash 原子 DELETE，删除成功即消费成功（重放无效）；
//   - 限时：expiresAt 到期即无效（邮箱验证 24h；P2 密码重置 30min 复用本表）；
//   - 重发即换新：同一玩家同类型旧令牌在签发时全部作废（防多链接并存）。
// ============================================================

export const TOKEN_TYPE_EMAIL_VERIFY = 'EMAIL_VERIFY';
// P2 预留（本阶段不使用）：TOKEN_TYPE_PASSWORD_RESET = 'PASSWORD_RESET'

export const EMAIL_VERIFY_TTL_HOURS = 24;

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * 为玩家签发一个指定类型的令牌。
 * 先作废该玩家同类型全部未消费旧令牌（重发即换新），再落库哈希。
 * 返回明文令牌（仅用于拼邮件链接；调用方绝不落盘/入日志）。
 */
export async function issueAuthToken(
  playerId: string,
  type: string,
  ttlHours: number,
  ip?: string | null,
): Promise<string> {
  await db.authToken.deleteMany({ where: { playerId, type } });
  const plaintext = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.authToken.create({
    data: { playerId, type, tokenHash: hashToken(plaintext), expiresAt, ip: ip ?? null },
  });
  return plaintext;
}

/**
 * 消费令牌（一次性、限时）。有效 → 返回 playerId 并原子删除该行；无效/过期/重放 → null。
 * 失败原因不区分（防探测），调用方统一按「链接无效或已过期」处理。
 * 并发安全：两个请求同时消费同一令牌时，仅一个 DELETE 成功（count=1）。
 */
export async function consumeAuthToken(type: string, plaintext: string): Promise<string | null> {
  if (!plaintext || plaintext.length < 20 || plaintext.length > 200) return null;
  const tokenHash = hashToken(plaintext);
  const row = await db.authToken.findUnique({
    where: { tokenHash },
    select: { playerId: true, type: true, expiresAt: true },
  }).catch(() => null);
  if (!row || row.type !== type || row.expiresAt.getTime() <= Date.now()) return null;
  const deleted = await db.authToken.deleteMany({ where: { tokenHash, type } });
  if (deleted.count !== 1) return null; // 已被并发消费（一次性硬保证）
  return row.playerId;
}
