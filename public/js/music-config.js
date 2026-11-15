// music-config.js - 全局音乐配置，只改这里！
// 集成自用户提供的音乐播放器方案（Task 38 + Task 39 补充降级链 + Task 41 服务端第 0 优先级）
// 修改 playlistId 为你的网易云歌单真实 ID 即可启用歌单模式
//
// 降级链（Task 41 最终顺序）：
//   GOATB-Server(同源服务端weapi) → TuneHub → go-music-api → 自建NCM-Enhanced → Meting-API → GD-Studio → 原生audio
// 第 0 优先级 GOATB-Server 走本项目服务端 /api/v1/music/*（服务端 weapi 直连网易，
// 不受浏览器 CORS 限制，最稳定），第三方公开 API 作为后备。
// go-music-api 与 ncm-enhanced 需自建服务，baseUrl 为 TODO 占位，
// 未自建时自动跳过（TODO 占位会在 music-api.js 里被识别为不可用并降级到下一个）。
window.MUSIC_CONFIG = {
  // ========== API 配置（按优先级降级）==========
  // 部署文档见 /public/DEPLOY-MUSIC.md
  apiList: [
    {
      // Task 41 新增：本项目服务端 API（同源，无 CORS，最稳定）
      // artist → /api/v1/music/artist?id=xxx（小车 真实歌曲）
      // search → /api/v1/music/search?keywords=xxx（网易云搜索）
      // url    → /api/v1/music/url?id=xxx（weapi 拿播放链接）
      // stream → /api/v1/music/stream/{id}（流式播放代理）
      name: "GOATB-Server",
      baseUrl: "/api/v1/music",
      type: "server",
      timeout: 8000,
      maxRetry: 1
    },
    {
      name: "TuneHub",
      baseUrl: "https://api.tunefree.fun/api",
      type: "tunehub",
      timeout: 3000,
      maxRetry: 1
      // 注意：TuneHub 禁止商用且服务器资源有限，避免高频并发
    },
    {
      // go-music-api：基于 music-lib，支持网易云/QQ/酷狗/Bilibili，智能换源（按歌名+歌手+时长匹配替代音源）
      // 自建部署：git clone https://github.com/gmh5225/go-music-api && docker build . && docker run -p 3000:3000
      // 未自建时保留 TODO，music-api.js 会识别 TODO 并跳过该 API
      name: "go-music-api",
      baseUrl: "TODO:GOMUSIC_BASEURL",  // 例如 https://your-gomusic.example.com
      type: "gomusic",
      timeout: 3000,
      maxRetry: 1
    },
    {
      // NeteaseCloudMusicApiEnhanced：原版 NeteaseCloudMusicApi 社区维护分支，自 v4.28.0 起独立维护
      // 配合 @neteasecloudmusicapienhanced/unblockmusic-utils 实现自动解灰换源
      // Docker 一键部署：docker pull moefurina/ncm-api:latest && docker run -p 3000:3000 moefurina/ncm-api
      // Vercel 部署：Fork 仓库后直接 Deploy
      // 环境要求：Node.js 22+，推荐 pnpm
      // 敏感信息（cookie）通过 ncmCookie 配置项注入（见下方），勿硬编码
      name: "NCM-Enhanced",
      baseUrl: "TODO:NCM_BASEURL",  // 例如 https://your-ncm.example.com
      type: "ncm",
      timeout: 3000,
      maxRetry: 1
    },
    {
      name: "Meting-API",
      baseUrl: "https://api-music.liveling.top/api",
      type: "meting",
      timeout: 3000,
      maxRetry: 1
    },
    {
      name: "GD-Studio",
      baseUrl: "https://music-api.gdstudio.xyz/api.php",
      type: "gdstudio",
      timeout: 3000,
      maxRetry: 0
    }
  ],

  // ========== 当前默认使用的 API 索引 ==========
  currentApiIndex: 0,

  // ========== 内容源配置 ==========
  // 小车 的歌手 ID（网易云音乐人，代表作《低空李龙飞》）
  artistId: "123561221",
  // 你的歌单 ID —— 请手动替换！从网易云网页版歌单链接里复制
  // 例如 https://music.163.com/playlist?id=12345678 → playlistId: "12345678"
  playlistId: "TODO:PLAYLIST_ID",
  // 音乐平台
  server: "netease",

  // ========== Task 41: 热门榜单（多个歌单 ID，mp-root 播放器多 tab 切换）==========
  // 网易云官方榜单 ID（同源服务端 weapi，无 CORS）
  toplists: [
    { id: "19723756", name: "飙升" },
    { id: "3779629",  name: "新歌" },
    { id: "3778678",  name: "热歌" },
    { id: "2884035",  name: "原创" },
  ],


  // ========== 敏感信息（环境变量注入，勿硬编码）==========
  // 自建 NeteaseCloudMusicApiEnhanced 的 cookie，用于访问需要登录的接口
  // 通过 window.__MUSIC_ENV__ 注入（由 music-player-loader.tsx 从 Next.js env 读取）
  // 若未配置则留空，ncm type 分支会跳过需登录的接口
  ncmCookie: "",  // 自动从 window.__MUSIC_ENV__?.NCM_COOKIE 填充

  // ========== 播放器 UI 配置 ==========
  playerPosition: "bottom-left",  // bottom-left / bottom-right
  playerVolume: 0.72,
  showLyrics: true,
  showPlaylist: true,

  // ========== 降级与容错 ==========
  fallbackToNativeAudio: true,   // API 全挂时降级为原生 audio
  maxConsecutiveFailures: 3,      // 连续失败几次后隐藏播放器
  hideOnAllFail: true,            // 全部失败时隐藏播放器
};

// ========== 从环境变量注入敏感信息 ==========
// music-player-loader.tsx 会设置 window.__MUSIC_ENV__ = { NCM_COOKIE: process.env.NEXT_PUBLIC_NCM_COOKIE }
// 这里在 config 加载时读取并填充到 ncmCookie
(function injectEnv() {
  try {
    const env = window.__MUSIC_ENV__ || {};
    if (env.NCM_COOKIE && !window.MUSIC_CONFIG.ncmCookie) {
      window.MUSIC_CONFIG.ncmCookie = env.NCM_COOKIE;
    }
  } catch (e) {
    console.warn('[MusicConfig] 环境变量注入失败:', e);
  }
})();
