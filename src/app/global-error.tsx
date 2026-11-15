'use client';

// ============================================================
// Global Error Boundary（工单：手机 Brave 白屏修复 · 方案 B · 管理员 2026-11-09 授权）
//
// 与 error.tsx 的分工：
//   - error.tsx：页面树级错误（root layout 仍可用，页面内容崩溃时接管）
//   - 本文件：root layout 自身崩溃时的最后防线，必须自带 <html><body>
//
// 红线约束（同 error.tsx）：
//   - 零外部依赖、零 import 任何组件/库（root 崩溃场景任何依赖都不可信）；
//   - 样式全内联（全局 CSS 此刻必然不可用）；
//   - 深色主题与 GOATB 一致，杜绝白屏；
//   - 新增独立文件，删除即回滚，零侵入既有代码。
//
// 恢复策略：root 级崩溃时 reset() 复现概率高，直接整页 reload 最可靠；
//   reload 由浏览器重新请求全部资源，顺带覆盖 chunk 失效场景。
// ============================================================

import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 控制台留痕（供管理员远程取证）
    console.error('[goatb-global-error]', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: '#1a1a2e',
          color: '#e8e6f0',
          fontFamily:
            'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
        }}
      >
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
            textAlign: 'center',
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
            页面暂时无法显示
          </h1>

          <p style={{ margin: 0, maxWidth: 420, fontSize: 14, lineHeight: 1.7, color: '#b9c0c7' }}>
            站点核心资源加载失败，点击下方按钮重新加载；
            若持续出现，请检查网络后稍后再试。
          </p>

          <button
            type="button"
            onClick={() => window.location.reload()}
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
      </body>
    </html>
  );
}
