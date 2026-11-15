import crypto from 'crypto';
import { db } from './db';

// ============================================================
// 会话 Cookie 签名（自审核 P0 修复 + AUTH V2.0 PHASE 3 兼容演进）
// ── P0 修复（原样保留语义）──
// 修复前：cookie 直接存 AdminUser.id / Player.id（cuid），
//         而 Player.id 通过公开榜单 API 可见 → 任何人可伪造 cookie 冒充。
// 修复后：cookie 值 = `${id}.${HMAC-SHA256(id, secret).slice(0,32)}`
//         服务端验签通过才查库，伪造/篡改一律视为未登录。
// ── AUTH V2.0 PHASE 3（工单「支持撤销旧会话」）兼容演进 ──
// 签名输入绑定会话纪元：signSessionId(id, epoch) → HMAC(`${id}|${epoch}`)。
//   epoch 递增事件（管理员重置密码 / 禁用账号）使该主体全部既有签名值
//   立即失效 = 服务端会话撤销，而 Cookie 外在格式（id.mac32）与前端、
//   管理员登录入口（X-Admin-Token 回退）完全不变。
// 兼容读（legacy 分支）：verifySessionId 先按调用方给定 epoch 验签，失败
//   再回退验证旧格式 HMAC(id)——存量 cookie 在其自然过期前（≤7 天 maxAge）
//   继续有效，新签发的 cookie 一律为新格式。legacy 分支为一次性过渡兼容，
//   保留至管理员另行批复（成本=每失败验证多一次 HMAC 计算，无安全影响：
//   旧格式签名仍在同一 secret 保护下不可伪造）。
// 回滚：本文件由 .zbackups/2026-11-10-auth-v2-p3 留档；回滚=复原本文件
//   （epoch 列保留无消费方即无影响，见批次报告回滚专章）。
// secret 存 Config 表（key=session_secret），首次访问自动生成，
// 重启、重新部署均不失效，且不进代码仓库。
// 红线：secret 绝不经任何 HTTP 路径返回（PHASE 1 硬黑名单，SR-01 永久回归项）。
// ============================================================

let cachedSecret: string | null = null;

export async function getSessionSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const row = await db.config.findUnique({ where: { key: 'session_secret' } });
  if (row?.value) {
    cachedSecret = String(row.value);
    return cachedSecret;
  }

  // 首次生成并落库
  const secret = crypto.randomBytes(32).toString('hex');
  await db.config
    .upsert({
      where: { key: 'session_secret' },
      update: { value: secret },
      create: { key: 'session_secret', value: secret },
    })
    .catch(() => null);

  // upsert 可能并发竞争，回读一次以取到最终值
  const row2 = await db.config.findUnique({ where: { key: 'session_secret' } });
  cachedSecret = row2?.value ? String(row2.value) : secret;
  return cachedSecret;
}

/** 计算指定纪元下的会话签名值（epoch 缺省 0 = 未发生撤销事件的主体） */
function hmacWithEpoch(id: string, secret: string, epoch: number): string {
  return crypto.createHmac('sha256', secret).update(`${id}|${epoch}`).digest('hex').slice(0, 32);
}

/** 旧格式签名（PHASE 3 之前）：HMAC(id)——仅存量 cookie 过渡期兼容读使用 */
function hmacLegacy(id: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0, 32);
}

/** 恒时比较两个 mac，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * 签发会话签名值。epoch 缺省 0（管理员轨 PHASE 3 无 epoch 事件源，恒 0，
 * 行为等效旧版——管理员登录兼容，见批次报告「管理员登录兼容方案」专章）。
 */
export async function signSessionId(id: string, epoch = 0): Promise<string> {
  const secret = await getSessionSecret();
  return `${id}.${hmacWithEpoch(id, secret, epoch)}`;
}

/**
 * 验签：通过返回原始 id，失败返回 null。
 * 顺序：① 调用方给定 epoch 的新格式 → ② legacy 旧格式 HMAC(id)（过渡兼容读）。
 * 两分支均不泄露失败原因（返回 null 即未登录，防探测口径不变）。
 */
export async function verifySessionId(
  val: string | undefined | null,
  epoch = 0,
): Promise<string | null> {
  if (!val) return null;
  const dot = val.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = val.slice(0, dot);
  const mac = val.slice(dot + 1);
  if (!id || !mac) return null;
  const secret = await getSessionSecret();
  // ① 新格式：HMAC(id|epoch)
  if (safeEqual(mac, hmacWithEpoch(id, secret, epoch))) return id;
  // ② legacy 兼容读：HMAC(id)——仅使存量会话在其自然过期前继续有效
  if (safeEqual(mac, hmacLegacy(id, secret))) return id;
  return null;
}
