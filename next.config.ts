import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 2026-12 音乐 API 替换 v2：UNM 解灰引擎（@neteasecloudmusicapienhanced/
  // unblockmusic-utils 及 mini-service）已整体移除，新解灰链（GD-Studio curl
  // 子进程 + 酷我自实现兜底）均为纯 HTTP/子进程调用，无需 external 标记。
  // NeteaseCloudMusicApi/util/crypto 仍用于 weapi 加密（见 ncm-source.ts）。
  serverExternalPackages: ["NeteaseCloudMusicApi"],
  // 审计修复：dev-tools 指示徽标（nextjs-portal，左下角 36×36）与音乐 dock
  // 的「上一首」按钮(35,837 30×30)重叠，真实预览用户点击会落空。关闭指示器。
  devIndicators: false,
  // 2026-11-05 值守架构：backup-keeper（mini-services/backup-keeper）由
  // instrumentation 监督者在 dev 进程树内拉起 —— 本注释用于触发一次
  // dev 全量重启以激活 instrumentation.register()（Next dev 对
  // next.config 变更的官方语义）。
  // ── 安全响应头（审计 2026-11-24 F4 / 2026-11-25 修订）──
  // 最小安全头集：nosniff 防 MIME 嗅探、Referrer-Policy 收敛引用泄露、
  // Permissions-Policy 关闭高危设备能力。
  // 2026-11-25 修订：移除 X-Frame-Options: SAMEORIGIN —— sandbox 预览面板
  // 以跨源 iframe 嵌入工作区站点，SAMEORIGIN 使浏览器静默拒绝渲染 →
  // 面板白屏。管理后台防点击劫持由登录态（session epoch）+ 交互确认兜底。
  // CSP 暂不启用（站点含内联 boot 脚本与三方案背景系统，需先盘点全部
  // inline/script-src 再分阶段上线，避免一刀切破坏渲染）。
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
/* 触发 Next dev 自动重启以加载新 instrumentation（keeper 常驻监督升级 2026-11-09） */
