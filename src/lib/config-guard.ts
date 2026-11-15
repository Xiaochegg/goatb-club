// ============================================================
// AUTH V2.0 安全修复专项（管理员批示 2026-11-11，trace 1a1ca610ea9222e1）
// session_secret 永久硬性黑名单 —— 读取/导出/写入/恢复四路统一收口
// ------------------------------------------------------------
// 依据：FINAL GLOBAL AUDIT（docs/AUTH-V2-FINAL-GLOBAL-AUDIT-2026-11-11.md）
//   §7-G3/G6：Phase 1 修复在 /api/v1/config 主路径收口，但 archive 导出
//   出口可带出根密钥、config PUT 与 archive 恢复可覆写任意键。本模块将
//   「认证根信任 material 永不经 HTTP 返回/被覆写」升级为全仓共享不变量。
// 红线出处：src/lib/session.ts:25（「secret 绝不经任何 HTTP 路径返回」）。
// 唯一合法写入方：getSessionSecret() 首次自举（服务端内部，无 HTTP 面）。
// 扩展：新增受保护键只改此处一处（单一事实源），所有 Config 出入口
//   （config GET/PUT、archive GET/POST）强制消费本清单。
// ============================================================

/** 受保护配置键清单（命中：读取/导出=不出、写入/恢复=拒绝） */
export const NEVER_RETURN_KEYS: ReadonlySet<string> = new Set(['session_secret']);

/** 键是否受保护（对非字符串输入恒 false，防运行时异常） */
export function isProtectedConfigKey(key: unknown): boolean {
  return typeof key === 'string' && NEVER_RETURN_KEYS.has(key);
}
