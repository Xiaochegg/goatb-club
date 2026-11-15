// ============================================================
// Admin fetch helper — 2026-11 环境兼容修复
// ============================================================
// 背景：管理员登录依赖 HttpOnly cookie（SameSite=Lax）。以下环境会让
// 浏览器不存/不回传该 cookie，导致登录成功但所有管理 API 401「未授权」：
//   1) 站点嵌入预览 iframe → 第三方 cookie 被浏览器拦截
//   2) 纯 HTTP 访问的生产构建 → Secure cookie 被丢弃（已同步修复 secure 按协议判定）
// 方案：登录响应返回 HMAC 签名 token（与 cookie 同值、同验签逻辑），
// 前端存 sessionStorage（仅当前标签页生命周期，关闭即清），管理请求
// 统一经 adminFetch 附带 X-Admin-Token 头。服务端 cookie 优先、头回退。
// ============================================================

const TOKEN_KEY = 'goatb_admin_token';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // 隐私模式等 storage 不可用场景
  }
}

export function setAdminToken(token: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch { /* 同上：storage 不可用时静默降级为纯 cookie 模式 */ }
}

export function clearAdminToken() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

/**
 * fetch 的管理端包装：自动附带 X-Admin-Token（存在时）。
 * 其余行为与原生 fetch 完全一致（credentials 默认 same-origin，cookie 照常携带）。
 */
export function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getAdminToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has('x-admin-token')) headers.set('x-admin-token', token);
  return fetch(input, { ...init, headers });
}
