// ============================================================
// W4 · API 网关逻辑（三态开关 + Key 校验 + 限流 + AI 黑名单）
// ============================================================
// 被 middleware.ts 调用。Next.js 16 middleware 支持 nodejs runtime，
// 可直接用 Prisma。带 5s 内存缓存避免每次请求查开关状态。
//
// 三态：
//   OFF → 503 API_DISABLED（默认，硬约束 4）
//   WHITELIST → 无 Key 403 / Key 无效 403 / 超配额 429
//   OPEN → 无 Key 放行但限流 20/min/IP，超限 429
//
// AI UA 黑名单：GPTBot/ClaudeBot/CCBot 等 → 403（所有模式）
// 蜜罐 _sig：请求带 _sig 字段 → 403（标记为爬虫）

import { db } from './db';
import { CONFIG_KEYS, type ApiGateState } from './constants';
import crypto from 'crypto';

// --- 开关状态缓存（5s TTL，避免每次请求查 DB）---
let cachedState: { value: ApiGateState; ts: number } | null = null;
const STATE_CACHE_TTL = 5000;

export async function getPublicApiState(): Promise<ApiGateState> {
  if (cachedState && Date.now() - cachedState.ts < STATE_CACHE_TTL) {
    return cachedState.value;
  }
  const row = await db.config.findUnique({ where: { key: CONFIG_KEYS.PUBLIC_API } });
  let v = (row?.value as ApiGateState) || 'OFF';

  // W4-T3: 检查临时开启是否过期，过期自动回落 OFF（请求驱动，无需 cron）
  if (v !== 'OFF') {
    const expiryRow = await db.config.findUnique({ where: { key: 'public_api_expires' } });
    if (expiryRow?.value) {
      const expires = new Date(expiryRow.value);
      if (expires < new Date()) {
        // 过期了，自动回落
        const prevState = v;
        await db.config.update({
          where: { key: CONFIG_KEYS.PUBLIC_API },
          data: { value: 'OFF' },
        }).catch(() => null);
        await db.config.deleteMany({
          where: { key: 'public_api_expires' },
        }).catch(() => null);
        // 护栏 2：写一条站内通知 Config（前端角标可读取，不静默过期）
        await db.config.upsert({
          where: { key: 'api_auto_expire_notice' },
          update: { value: `API 开关于 ${new Date().toISOString()} 自动过期回落 OFF（原状态 ${prevState}）` },
          create: { key: 'api_auto_expire_notice', value: `API 开关于 ${new Date().toISOString()} 自动过期回落 OFF（原状态 ${prevState}）` },
        }).catch(() => null);
        await logApiEvent('api_auto_expire', `public_api auto-expired ${prevState}→OFF`, null, JSON.stringify({ state: prevState }), JSON.stringify({ state: 'OFF' }));
        v = 'OFF';
      }
    }
  }

  cachedState = { value: v, ts: Date.now() };
  return v;
}

/** 清除开关缓存（后台改值后调用，热生效）*/
export function clearApiStateCache() {
  cachedState = null;
}

// --- AI UA 黑名单 ---
const AI_UA_BLACKLIST = [
  'GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web',
  'CCBot', 'Google-Extended', 'PerplexityBot', 'Bytespider',
  'Applebot-Extended', 'anthropic-ai', 'cohere-ai',
];

export function isAiBot(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return AI_UA_BLACKLIST.some(bot => ua.includes(bot.toLowerCase()));
}

// --- 限流（内存计数器，每 IP 20/min for OPEN，每 Key 按配额 for WHITELIST）---
const ipRequests = new Map<string, { count: number; windowStart: number }>();
const keyRequests = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW = 60_000; // 1 分钟
const OPEN_IP_LIMIT = 20;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const r = ipRequests.get(ip);
  if (!r || now - r.windowStart > RATE_WINDOW) {
    ipRequests.set(ip, { count: 1, windowStart: now });
    return true;
  }
  r.count++;
  return r.count <= OPEN_IP_LIMIT;
}

export function checkKeyQuota(keyHash: string, quota: number): boolean {
  const now = Date.now();
  const r = keyRequests.get(keyHash);
  if (!r || now - r.windowStart > RATE_WINDOW) {
    keyRequests.set(keyHash, { count: 1, windowStart: now });
    return true;
  }
  r.count++;
  return r.count <= quota;
}

// --- Key 哈希与校验 ---
export function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(24).toString('hex');
  const plaintext = `sk_live_${random}`;
  return {
    plaintext,
    hash: hashKey(plaintext),
    prefix: plaintext.slice(0, 12),
  };
}

export interface KeyValidation {
  valid: boolean;
  keyHash?: string;
  quota?: number;
  scopes?: string[];
  reason?: string;
}

export async function validateApiKey(authHeader: string | null, origin: string | null): Promise<KeyValidation> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, reason: 'missing_bearer' };
  }
  const plaintext = authHeader.slice(7);
  const hash = hashKey(plaintext);

  const key = await db.apiKey.findUnique({ where: { keyHash: hash } });
  if (!key) return { valid: false, reason: 'not_found' };
  if (key.status === 'REVOKED') return { valid: false, reason: 'revoked' };
  if (key.expiresAt && key.expiresAt < new Date()) {
    return { valid: false, reason: 'expired' };
  }
  // origin 校验
  if (key.originAllow && key.originAllow !== '[]') {
    const allowed: string[] = JSON.parse(key.originAllow);
    if (allowed.length > 0 && origin && !allowed.includes(origin)) {
      return { valid: false, reason: 'origin_mismatch' };
    }
  }
  return {
    valid: true,
    keyHash: hash,
    quota: key.quota,
    scopes: key.scopes.split(',').map(s => s.trim()),
  };
}

// --- 审计日志 ---
export async function logApiEvent(
  type: string,
  detail: string,
  ip: string | null,
  before?: string,
  after?: string,
) {
  await db.operationLog.create({
    data: {
      type,
      detail,
      adminKey: 'api-gate',
      beforeData: before || null,
      afterData: after || null,
      ip,
      sessionId: null,
    },
  }).catch(() => null);
}

// --- 网关主逻辑 ---
export interface GateResult {
  allowed: boolean;
  status: number;
  body: { error: string; code?: string };
}

export async function apiGate(
  pathname: string,
  headers: Headers,
  ip: string,
): Promise<GateResult> {
  const ua = headers.get('user-agent');
  const origin = headers.get('origin');

  // 蜜罐 _sig 检查（请求头或 query 带 _sig = 爬虫标记）
  const sig = headers.get('x-sig') || new URL(pathname, 'http://x').searchParams.get('_sig');
  if (sig) {
    return { allowed: false, status: 403, body: { error: 'Forbidden', code: 'CANARY_TRIGGERED' } };
  }

  // AI UA 黑名单（所有模式生效）
  if (isAiBot(ua)) {
    return { allowed: false, status: 403, body: { error: 'Forbidden', code: 'AI_BOT_BLOCKED' } };
  }

  const state = await getPublicApiState();

  if (state === 'OFF') {
    return { allowed: false, status: 503, body: { error: 'API disabled', code: 'API_DISABLED' } };
  }

  if (state === 'WHITELIST') {
    const key = await validateApiKey(headers.get('authorization'), origin);
    if (!key.valid) {
      return { allowed: false, status: 403, body: { error: 'Forbidden', code: key.reason } };
    }
    if (key.keyHash && key.quota && !checkKeyQuota(key.keyHash, key.quota)) {
      return { allowed: false, status: 429, body: { error: 'Quota exceeded', code: 'KEY_QUOTA_EXCEEDED' } };
    }
    return { allowed: true, status: 200, body: { error: '' } };
  }

  // OPEN
  if (!checkRateLimit(ip)) {
    return { allowed: false, status: 429, body: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' } };
  }
  return { allowed: true, status: 200, body: { error: '' } };
}
