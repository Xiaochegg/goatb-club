// ============================================================
// 请求真实 IP 提取（安全审计 2026-11-24 · F2 修复）
// ============================================================
// 背景：网关（Caddy）后所有请求的 x-forwarded-for 均为同一跳，
// 直接用 XFF 做限流桶键会导致「全员同桶」互锁 DoS（任一用户连续失败
// 即锁死全体）；若绕过网关直连，XFF 又可被伪造绕过限流。
// Caddyfile 已通过 header_up 注入 X-Real-IP（remote_host），因此取键
// 优先级：X-Real-IP > XFF 首跳 > unknown。
//
// 用途边界：仅用于限流桶键与审计留痕，IP 不作为身份凭证，不做信任判断。

const MAX_KEY_LEN = 64;

export function getRequestIp(req: Request): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim().slice(0, MAX_KEY_LEN);
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, MAX_KEY_LEN);
  return 'unknown';
}
