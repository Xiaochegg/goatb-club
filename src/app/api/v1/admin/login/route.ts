import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyPassword } from '@/lib/password';
import type { AdminRole } from '@/lib/auth';
import { signSessionId } from '@/lib/session';

// ============================================================
// 登录限流（admin-login-ratelimit-v2，管理员批示「A执行」2026-11-12）
// ── 修复前缺陷（docs/DIAG-REPORT-admin-login-lockout-2026-11-11.md）──
//   单一 Map 按 X-Forwarded-For 分桶；本项目全部外部用户经网关后 XFF
//   同为 21.0.0.1 → 全体真实管理员共享「5 次/15min」失败桶，任何人的
//   失败都会把其他管理员（含正确密码）一起 429 锁死（互锁）。
// ── 方案 A：双键并行限流 ──
//   ① 用户名桶：针对单账号爆破/误输，10 次失败 / 15min（批示口径）。
//      不同管理员天然不同桶 → 共享网关 IP 不再互锁。
//   ② IP 后备桶：防「换用户名喷射」绕过用户名桶，30 次失败 / 15min
//      （阈值放宽到不易被正常误输触发；设计选择见批次报告）。
//   两桶任一命中即 429，判定先于密码校验（保留原安全属性）。
//   登录成功清空该用户名桶 + 该 IP 桶（正确凭据证明该 IP 当前有合法
//   用户，防共享 IP 场景桶残留导致慢速互锁复发）。
//   过期语义沿用原实现：距上次失败 >15min 的桶在下次访问时删除重计；
//   锁定窗口 = 距最后一次失败 15min；锁定期间 429 不延长窗口。
// ── 失败留痕（批示原文「失败尝试写入 OperationLog」）──
//   仅 401 路径写 type='warn' 行（login-fail · 用户名 · ip），绝不记密码；
//   429 拒绝不写（防锁定期轰炸放大审计面）；写入失败不阻断登录响应。
// ── 不变项 ──
//   429/401 文案逐字节不变（前端零改动依据）；Cookie/Token/审计成功日志
//   逻辑原样；password.ts / session.ts 冻结面不触碰。
// ============================================================

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USERNAME = 10; // 批示口径：单账号 10 次/15min
const MAX_PER_IP = 30;       // IP 后备桶（防用户名喷射，批次报告披露）

const loginAttemptsByUsername = new Map<string, { count: number; lastAttempt: number }>();
const loginAttemptsByIp = new Map<string, { count: number; lastAttempt: number }>();

/** 用户名桶键：trim + 小写归一（防大小写变体绕过）+ 截断（防 Map 内存滥用） */
function usernameKey(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().slice(0, 64);
}

/** IP 桶键：原样沿用 x-forwarded-for（缺省 unknown），仅截断 */
function ipKey(raw: string | null): string {
  return (raw || 'unknown').slice(0, 64);
}

/** 桶是否处于锁定状态；过期桶在访问时删除重计（沿用原语义） */
function isBucketLocked(
  map: Map<string, { count: number; lastAttempt: number }>,
  key: string,
  max: number,
  now: number,
): boolean {
  const attempt = map.get(key);
  if (!attempt) return false;
  if (now - attempt.lastAttempt > WINDOW_MS) {
    map.delete(key);
    return false;
  }
  return attempt.count >= max;
}

function recordFailure(
  map: Map<string, { count: number; lastAttempt: number }>,
  key: string,
  now: number,
): void {
  const current = map.get(key);
  map.set(key, { count: (current?.count || 0) + 1, lastAttempt: now });
}

const ADMIN_COOKIE_NAME = 'beclub_admin';

// POST /api/v1/admin/login
// 管理员登录（正式版，已清理 legacy env 密码模式）
// 必须提供 username + password，走 AdminUser 表 + scrypt 验证
// AUTH V2.0 PHASE 4（管理员批示「p4」2026-11-11）：签发绑定该管理员当前
// sessionEpoch（当前恒 0，输出与旧版逐字节等效）；未来凭证事件将 epoch+1
// 后，新登录签发新纪元签名、旧纪元 cookie/header 全部失效（统一底座归一，
// 见 docs/PLAN-auth-v2-phase4-admin-unified-session-2026-11-11.md）
export async function POST(req: NextRequest) {
  try {
    // Rate limiting（双键：用户名桶 + IP 后备桶；判定先于密码校验）
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const body = await req.json().catch(() => null);
    const uKey = usernameKey(body?.username);

    if (isBucketLocked(loginAttemptsByUsername, uKey, MAX_PER_USERNAME, now) ||
        isBucketLocked(loginAttemptsByIp, ipKey(ip), MAX_PER_IP, now)) {
      return NextResponse.json({ error: '尝试次数过多，请 15 分钟后再试' }, { status: 429 });
    }

    const username = body?.username;
    const password = body?.password;

    if (!username || !password) {
      return NextResponse.json({ error: '用户名和密码均为必填' }, { status: 400 });
    }

    // AdminUser 表验证
    const user = await db.adminUser.findUnique({ where: { username: String(username) } });
    if (!user || !verifyPassword(String(password), user.passwordHash)) {
      recordFailure(loginAttemptsByUsername, uKey, now);
      recordFailure(loginAttemptsByIp, ipKey(ip), now);
      // 失败留痕（批示「A执行」）：type=warn，含用户名与 ip，绝不记密码。
      // 仅 401 路径记录；429 不记录（防锁定期轰炸放大审计面）。
      await db.operationLog.create({
        data: {
          type: 'warn',
          detail: `login-fail · ${String(username).trim().slice(0, 64)} · ip=${ipKey(ip)}`,
          scoreChange: null,
          adminKey: String(username).trim().slice(0, 64),
          ip: ipKey(ip),
        },
      }).catch(() => {});
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const role = user.role as AdminRole;

    // 更新 lastLoginAt
    await db.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // Reset attempts on success（双键全清：用户名桶 + IP 桶）
    loginAttemptsByUsername.delete(uKey);
    loginAttemptsByIp.delete(ipKey(ip));

    // Set HttpOnly cookie — HMAC 签名值（防伪造，见 src/lib/session.ts）
    // secure 按真实请求协议判定（x-forwarded-proto 反代优先）：
    // 纯 HTTP 生产环境下 Secure cookie 会被浏览器丢弃 → 登录后全部 401（本次修复的根因之一）
    // PHASE 4：签发绑当前 sessionEpoch（恒 0 等效旧版）
    const proto = req.headers.get('x-forwarded-proto') || new URL(req.url).protocol.replace(':', '');
    const isHttps = proto.split(',')[0].trim() === 'https';
    const token = await signSessionId(user.id, user.sessionEpoch);
    const cookieStore = await cookies();
    cookieStore.set(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isHttps,
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
      sameSite: 'lax',
    });

    // Write login audit log
    await db.operationLog.create({
      data: {
        type: 'info',
        detail: `login · ${username} · role=${role}`,
        scoreChange: null,
        adminKey: username,
        ip,
      },
    }).catch(() => {});

    // token 与 cookie 同值（HMAC 签名）：cookie 被浏览器环境拦掉时
    // （iframe 第三方 cookie / 纯 HTTP 生产）前端存 sessionStorage 走
    // X-Admin-Token 头回退。仅经 JSON 响应下发，不入日志。
    return NextResponse.json({ success: true, role, username, token });
  } catch (error) {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
