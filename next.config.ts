import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 审计修复：dev-tools 指示徽标（nextjs-portal，左下角 36×36）与音乐 dock
  // 的「上一首」按钮(35,837 30×30)重叠，真实预览用户点击会落空。关闭指示器。
  devIndicators: false,
  // 2026-11-05 值守架构：backup-keeper（mini-services/backup-keeper）由
  // instrumentation 监督者在 dev 进程树内拉起 —— 本注释用于触发一次
  // dev 全量重启以激活 instrumentation.register()（Next dev 对
  // next.config 变更的官方语义）。
};

export default nextConfig;
/* 触发 Next dev 自动重启以加载新 instrumentation（keeper 常驻监督升级 2026-11-09） */
