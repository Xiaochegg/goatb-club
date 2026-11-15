'use client';

// ============================================================
// Route Error Boundary（工单：手机 Brave 白屏修复 · 方案 B · 管理员 2026-11-09 授权）
//
// 背景（诊断报告 docs/EMERGENCY-BRAVE-WHITE-SCREEN-DIAG-2026-11-09.md）：
//   首屏任一 chunk 加载失败时，React 19 会丢弃 SSR 内容，此前项目无兜底
//   → 用户看到永久白屏/骨架卡死，无提示、无重试入口。
//
// 职责：
//   1) chunk 加载失败（Shields 拦截/弱网丢包/部署后旧 chunk 失效）
//      → 本会话自动整页 reload 一次（sessionStorage 防循环）；
//      已重载过仍失败 → 停在本页显示手动重试与豁免指引。
//   2) 其它页面渲染错误 → 显示与主题一致的深色兜底页，提供重试。
//
// 红线约束：
//   - 零外部依赖：不 import framer-motion/gsap/three 等任何库——
//     触发本页的场景里那些 chunk 本身可能就是坏的；
//   - 样式全内联：不依赖全局 CSS（弱网下 CSS 可能未加载，白屏成因之一）；
//   - 可逆性：本文件为新增独立文件，删除即回滚，零侵入既有代码。
// ============================================================

import { useEffect } from 'react';

/** 自动整页恢复的去重标记（session 级：一次会话最多自动 reload 一次） */
const RETRY_FLAG = 'goatb:chunk-retry';

/** 判定是否为 chunk/动态模块加载失败（Shields 拦截、弱网超时、旧部署 chunk 失效） */
function isChunkLoadError(err: Error & { digest?: string }): boolean {
  if (err.name === 'ChunkLoadError') return true;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('loading chunk') ||
    msg.includes('chunkloaderror') ||
    msg.includes('dynamically imported module') ||
    msg.includes('failed to fetch dynamically')
  );
}

/** 安全读取 sessionStorage（隐私模式/存储禁用时静默跳过） */
function safeGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 存储不可用时放弃自动恢复，仅显示手动重试（不 throw）
  }
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 渲染期直接推导（不依赖 effect/state）：若本会话已自动恢复过，直接展示手动指引。
  // 时序：首次渲染无标记→ effect 设置标记并 reload → 重载后仍失败 → 此处命中标记显示指引。
  const isChunk = isChunkLoadError(error);
  const chunkRetried = isChunk && Boolean(safeGet(RETRY_FLAG));

  useEffect(() => {
    // 控制台留痕（供管理员远程取证）；技术细节不作为页面主文案
    console.error('[goatb-error]', error);

    if (isChunk && !chunkRetried) {
      // 本会话首次 chunk 失败：整页 reload 是唯一可靠恢复路径
      // （失败的 chunk 与 React 树解耦，reset() 无法重新下载 chunk）
      safeSet(RETRY_FLAG, String(Date.now()));
      window.location.reload();
    }
  }, [error, isChunk, chunkRetried]);

  const handleRetry = () => {
    try {
      window.sessionStorage.removeItem(RETRY_FLAG);
    } catch {
      // 忽略
    }
    reset();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: '24px',
        background: '#1a1a2e',
        color: '#e8e6f0',
        textAlign: 'center',
        fontFamily:
          'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          border: '2px solid #7c6fd0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          color: '#a78bfa',
        }}
      >
        !
      </div>

      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '0.04em' }}>
        页面加载遇到问题
      </h1>

      <p style={{ margin: 0, maxWidth: 420, fontSize: 14, lineHeight: 1.7, color: '#b9c0c7' }}>
        可能是网络波动导致部分资源未能加载，点击下方按钮即可重试；
        若持续出现，请检查网络后稍后再试。
      </p>

      {chunkRetried ? (
        <p
          style={{
            margin: 0,
            maxWidth: 420,
            fontSize: 13,
            lineHeight: 1.7,
            color: '#e8c268',
          }}
        >
          已尝试自动恢复仍未成功——资源可能被浏览器安全功能拦截。
          可尝试将该站的 Shields/广告拦截设为本站豁免后刷新。
        </p>
      ) : null}

      <button
        type="button"
        onClick={handleRetry}
        style={{
          marginTop: 8,
          minHeight: 44,
          padding: '0 32px',
          borderRadius: 12,
          border: 'none',
          background: '#7c6fd0',
          color: '#ffffff',
          fontSize: 15,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        重新加载
      </button>

      {error.digest ? (
        <small style={{ fontSize: 12, color: '#7d8590' }}>
          错误编号：{error.digest}
        </small>
      ) : null}
    </div>
  );
}
