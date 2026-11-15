// ============================================================
// archive-guard.ts —— 存档内容有效性校验（管理员指令 2026-11-10）
// ============================================================
// 管理员原话（机制定义）：
//   「必须是检测你所缓存的，保存的缓存是否有 KB 的，如果没 KB 的
//    就直接弃用，直到保存到有 KB 的」
//
// 判据（按管理员原话「有KB的」）：
//   1. 结构有效：根节点为对象且含 players 数组（与恢复接口既有校验一致）；
//   2. 大小有效：序列化后字节数 ≥ 1KB（MIN_ARCHIVE_BYTES）。
//      真实存档（≥1 玩家 + 操作日志 + 配置）远超 1KB；
//      不足 1KB = 空榜壳/被截断/被污染的「被侵犯缓存」→ 直接弃用。
//
// 接入点（全链路同判据，双端共用本模块）：
//   - POST /api/v1/archive（服务端收口：从缓存恢复 / 从文件恢复）→ 400 拒绝；
//   - archive-tab performCacheSave（立即保存写缓存前）→ 没 KB 不写入；
//   - archive-tab restoreFromCache / handleFileUpload（进确认弹窗前）→ 弃用。
//
// 运行环境：浏览器 + Node 均有 TextEncoder，零依赖，双端可用。
// ============================================================

export const MIN_ARCHIVE_BYTES = 1024; // 1KB —— 「有KB」判据（管理员 2026-11-10）

export interface ArchiveValidation {
  ok: boolean;
  bytes?: number;
  reason?: string;
}

/** 序列化后字节长度（TextEncoder 统计 UTF-8 字节，中文不虚报） */
export function archiveByteLength(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return 0; // 循环引用等无法序列化 = 无效内容
  }
}

/** 存档内容有效性：结构 + KB 双判据；不通过 = 「被侵犯缓存」→ 调用方必须弃用 */
export function validateArchivePayload(data: unknown): ArchiveValidation {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: '存档根节点必须是对象' };
  }
  if (!Array.isArray((data as { players?: unknown }).players)) {
    return { ok: false, reason: '缺少 players 数组（存档格式不符）' };
  }
  const bytes = archiveByteLength(data);
  if (bytes < MIN_ARCHIVE_BYTES) {
    return {
      ok: false,
      bytes,
      reason: `内容仅 ${bytes} 字节，不足 1KB（有 KB 才算有效缓存）`,
    };
  }
  return { ok: true, bytes };
}
