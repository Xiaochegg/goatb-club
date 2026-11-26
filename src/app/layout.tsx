import type { Metadata, Viewport } from "next";
import "./fonts.css"; // 本地字体快照（像素字体/Geist 全自托管，编译期零 Google 依赖）
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { MotionProvider } from "@/components/motion-provider";
// 2026-12：旧 MusicPlayerLoader 脚本链已拆除——播放器改为页面内 React 组件
//（MusicDrawerPlayer，挂载于 page.tsx），点击 Dock 音乐键必然弹出。
import { THEME_PRESETS, XT_MODE_ICONS } from "@/lib/constants";

// 响应式规范：显式 viewport（禁 user-scalable=no / maximum-scale，保留缩放能力）；
// viewportFit=cover 让底部 dock 的 env(safe-area-inset-bottom) 生效
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://goatb.club"),
  title: "GOATB 社区排行榜",
  description: "GOATB Club - Minecraft游戏社区排行榜，竞技段位与积分体系。实时排名、多模式段位、感动值榜单。",
  applicationName: "GOATB",
  keywords: ["Minecraft", "排行榜", "GOATB", "段位", "竞技", "社区", "leaderboard"],
  authors: [{ name: "GOATB Club" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  // SA-10 SEO：社交分享卡片
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "https://goatb.club",
    siteName: "GOATB 社区排行榜",
    title: "GOATB 社区排行榜",
    description: "Minecraft 游戏社区排行榜 — 实时排名、多模式段位、感动值榜单",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "GOATB 社区排行榜",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "GOATB 社区排行榜",
    description: "Minecraft 游戏社区排行榜 — 实时排名、多模式段位、感动值榜单",
    images: ["/opengraph-image"],
  },
  robots: { index: true, follow: true },
};

// ============================================================
// 主题防闪 boot 脚本（用户反馈 2026-10：背景瞬间闪成紫色）——
// 根因：主题默认 aurora（紫），localStorage 里的已存主题要等 React
// hydration 后的 useEffect 才应用 → 首屏先画紫再切走 = FOUC。
// 方案：head 内阻塞脚本在首次绘制前把已存主题渐变/自定义背景写进
// --goatb-bg CSS 变量（page.tsx 根容器 background 全走该变量），
// SSR/客户端渲染的 style 字符串一致 → 零 hydration mismatch、零闪色。
// 渐变映射由服务端从 THEME_PRESETS 序列化注入，单一来源零漂移。
// 2026-12：默认主题切为 void（液态玻璃，纯黑深空）——首次访问
// （无 localStorage）按 void 预写变量与 data-theme，首帧即深空玻璃。
// ============================================================
const themeBootScript = (() => {
  const map = JSON.stringify(
    Object.fromEntries(Object.entries(THEME_PRESETS).map(([k, v]) => [k, v.gradient]))
  );
  // data-theme 同步预写（橡皮管主题 2026-11-17）：globals.css 的
  // html[data-theme='rubberhose'] 场景变形依赖该属性；在 --goatb-bg
  // 同一阻塞脚本里写入 → 首帧即正确主题场景，零闪。
  // 无存档主题时默认 'void'（与 store.ts 初始 theme 一致）。
  return `(function(){try{var M=${map};var el=document.documentElement;var t=null,bg=null;try{t=localStorage.getItem('goatb-theme');bg=localStorage.getItem('goatb-bg');}catch(e){}
if(!t){t='void';}
if(bg){el.style.setProperty('--goatb-bg','url("'+String(bg).replace(/["\\\\]/g,'')+'") center/cover no-repeat');}
else if(t&&M[t]){el.style.setProperty('--goatb-bg',M[t]);}
if(t&&M[t]){el.setAttribute('data-theme',t);}}catch(e){}})();`;
})();

// XT 模式图标预加载（用户反馈 2026-10：切模式图标要 ~0.5s 才出现）——
// 图标为 public 静态 jpg，dev/网关响应 max-age=0 强制重验证，高 RTT
// 链路下与全站请求抢带宽 → 首次进单模式榜时图标迟现。head 内 preload
// 提权 + 提前完成取图，切榜时走内存缓存即时呈现。
const xtIconPreloads = Array.from(new Set(Object.values(XT_MODE_ICONS))).filter(Boolean) as string[];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <style
          dangerouslySetInnerHTML={{
            // --goatb-bg 兜底默认 = 默认主题 void 渐变（无 localStorage 时）：
            // 纯黑深空画布（液态玻璃 2026-12）——render-blocking CSS 下载前/
            // 失败后，浏览器画布默认纯白 → 内联声明深黑底，把"白屏窗口"
            // 变成 void 深空窗口（与 html[data-theme='void'] 画布一致）
            __html: `:root{--goatb-bg:${THEME_PRESETS.void.gradient}}html{background:#030305}`,
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {xtIconPreloads.map(src => (
          <link key={src} rel="preload" as="image" href={src} fetchPriority="high" />
        ))}
      </head>
      <body className="antialiased">
        {/* 字体变量 --font-geist-sans / --font-geist-mono / --font-mc-pixel
            由 fonts.css 的 :root 提供（本地 @font-face，无 next/font 依赖） */}
        <MotionProvider>
          {children}
        </MotionProvider>
        <Toaster />
        {/* 音乐播放器：2026-12 起为 page.tsx 内 MusicDrawerPlayer（React 抽屉组件，零脚本注入） */}
      </body>
    </html>
  );
}
