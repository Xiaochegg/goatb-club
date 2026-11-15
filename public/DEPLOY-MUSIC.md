# 音乐播放器部署与维护指南

本文档配套 `public/js/` 下的音乐播放器方案（Task 38 + Task 39）。
当前降级链：**TuneHub → go-music-api → NCM-Enhanced → Meting-API → GD-Studio → 原生 audio**

---

## 一、降级链说明

`public/js/music-config.js` 的 `apiList` 按优先级从高到低排列。
`music-api.js` 会从 `currentApiIndex` 开始尝试，失败自动降级到下一个。
所有 API 失败时降级为原生 `<audio>` 标签（`fallbackToNativeAudio: true`）。

| 顺序 | 名称 | type | 状态 | 说明 |
|------|------|------|------|------|
| 1 | TuneHub | `tunehub` | 公开可用 | 禁止商用，服务器资源有限，避免高频并发 |
| 2 | go-music-api | `gomusic` | **TODO 占位** | 需自建，智能换源（按歌名+歌手+时长匹配替代音源） |
| 3 | NCM-Enhanced | `ncm` | **TODO 占位** | 需自建，配合 unblockmusic-utils 自动解灰 |
| 4 | Meting-API | `meting` | 公开可用 | 第三方 Meting 实例 |
| 5 | GD-Studio | `gdstudio` | 公开可用 | GD Studio 公开 API |

**TODO 占位处理**：`music-api.js` 的 `isApiPlaceholder()` 会识别 `baseUrl` 以 `TODO:` 开头的 API 并自动跳过，降级到下一个可用 API。未自建的 API 无需删除，保留占位方便后续填入。

---

## 二、自建 API 部署方案

### 方案 A：Docker 部署 NeteaseCloudMusicApiEnhanced（推荐）

```bash
# 拉取镜像
docker pull moefurina/ncm-api:latest

# 运行（端口自定，这里用 3100 避免与 Next.js 3000 冲突）
docker run -d --name ncm-api -p 3100:3000 moefurina/ncm-api:latest

# 验证
curl http://localhost:3100/search?keywords=test
```

部署后，编辑 `public/js/music-config.js`：

```javascript
{
  name: "NCM-Enhanced",
  baseUrl: "https://your-ncm-domain.com",  // 替换 TODO:NCM_BASEURL
  type: "ncm",
  timeout: 3000,
  maxRetry: 1
}
```

### 方案 B：Vercel 部署（无需服务器）

1. Fork [NeteaseCloudMusicApiEnhanced](https://github.com//NeteaseCloudMusicApiEnhanced) 仓库
2. 在 Vercel 控制台点 "New Project" → 导入 Fork 的仓库
3. 直接 "Deploy"（无需额外配置，Vercel 自动识别）
4. 部署完成后拿到域名（如 `https://your-ncm.vercel.app`）
5. 填入 `music-config.js` 的 `baseUrl`

### 方案 C：go-music-api 部署

```bash
git clone https://github.com/gmh5225/go-music-api
cd go-music-api
docker build -t go-music-api .
docker run -d --name go-music-api -p 3200:3000 go-music-api
```

填入 `music-config.js`：

```javascript
{
  name: "go-music-api",
  baseUrl: "https://your-gomusic-domain.com",  // 替换 TODO:GOMUSIC_BASEURL
  type: "gomusic",
  timeout: 3000,
  maxRetry: 1
}
```

### 环境要求

- Node.js 22+
- 推荐使用 pnpm 管理依赖
- Docker 20+

---

## 三、敏感信息配置（cookie）

自建 NeteaseCloudMusicApiEnhanced 访问需登录的接口（如歌单、歌手歌曲）时需要 cookie。

### 配置方式（环境变量，勿硬编码）

1. 在项目根目录 `.env` 文件添加：

```bash
# 公开到客户端的环境变量必须用 NEXT_PUBLIC_ 前缀
NEXT_PUBLIC_NCM_COOKIE=MUSIC_U=xxxxx; __csrf=yyyyy
```

2. `music-player-loader.tsx` 会自动读取并注入到 `window.__MUSIC_ENV__.NCM_COOKIE`
3. `music-config.js` 会自动从 `window.__MUSIC_ENV__` 填充到 `ncmCookie`
4. `music-api.js` 的 `ncm` type 分支会自动把 cookie 拼接到请求 URL

### 获取 cookie

1. 浏览器登录网易云音乐（music.163.com）
2. F12 → Application → Cookies → 复制 `MUSIC_U` 和 `__csrf` 的值
3. 拼接为 `MUSIC_U=xxx; __csrf=yyy`

### 安全提示

- `NEXT_PUBLIC_` 前缀变量会内联到客户端 bundle，**仅放可公开的配置**
- 真正敏感的 cookie 应通过自建 API 中转（前端调你的 API，API 带 cookie 调网易云），不直接暴露到前端
- 本方案为"0利益"个人学习场景，cookie 暴露风险可控；商用场景必须用 API 中转

---

## 四、播放器 UI 配置

`music-config.js` 的播放器 UI 配置项：

```javascript
playerPosition: "bottom-left",  // bottom-left / bottom-right
playerVolume: 0.72,             // 0-1
showLyrics: true,               // 显示歌词
showPlaylist: true,             // 显示播放列表
```

liveling-music-player 默认渲染为左下角 55×55px 圆形按钮（`.lp-root > .lp-disc-btn`），点击展开完整面板。

### 替换播放器（可选）

用户提供的备选播放器组件：
- **NeteaseMiniPlayer v2 (NMP v2)**：高颜值无依赖，data-* 属性配置，无需写 JS
- **@candymade/bpm**：基于 Preact，APlayer 风格
- **@lijuu/musicplayerwidget**：轻量 React 组件

替换时需同步改 `music-player-init.js` 的 `new LivelingMusicPlayer(...)` 调用。

---

## 五、常见问题排查

### 1. API 返回 302 重定向
**正常现象**。播放器和 `fetch` 会自动跟随跳转，无需额外处理。

### 2. 歌曲预检过滤太多
`filterPlayableSongs` 过滤掉不可播放的歌曲。过滤过多可能是：
- API 暂时限流 → 等几分钟，控制台执行 `window.MusicPlayer.reset()` 重置
- VIP 歌曲/版权限制 → 正常过滤，无法播放
- API 返回格式变化 → 检查 `music-api.js` 的 `getSongUrl` 解析逻辑

### 3. 移动端拖拽不灵敏
检查播放器容器的 `touch-action` CSS 属性。`music-player-loader.tsx` 已注入：

```css
.lp-root, .lp-panel, .lp-disc-btn {
  touch-action: manipulation;  /* 允许点击/滚动，禁双击缩放 */
}
```

确保**没有**设为 `touch-action: none`（会阻止滚动）。

### 4. 播放器不显示
按顺序检查：
1. 控制台是否有 `[MusicAPI] 适配层已加载` 日志 → 无则 `music-api.js` 未加载
2. 控制台是否有 `[Player] 播放器初始化成功` → 无则 liveling CDN 加载失败
3. `window.MUSIC_CONFIG` 是否存在 → 无则 `music-config.js` 未加载
4. `.lp-root` 元素是否存在 → `document.querySelector('.lp-root')`
5. 连续失败超 `maxConsecutiveFailures`(默认3) 次会隐藏播放器 → `window.MusicPlayer.reset()`

### 5. 全部 API 失败
- 自动降级为原生 `<audio>`（`fallbackToNativeAudio: true`）
- 原生 audio 也加载失败 → 显示"暂无可用音源"
- 连续失败超阈值 → 隐藏播放器（`hideOnAllFail: true`）

---

## 六、长期维护

### 调整降级链顺序
直接编辑 `public/js/music-config.js` 的 `apiList` 数组顺序即可，无需改其他文件。
`music-api.js` 从 `currentApiIndex: 0` 开始按数组顺序尝试。

### 某个 API 长期失效
两种方式：
1. **删除该 API 条目**：从 `apiList` 数组移除
2. **降级优先级**：移到数组末尾

### 调试入口（浏览器控制台）
- `window.MusicAPI.getCurrentApi()` — 查当前用的哪个 API
- `window.MusicPlayer.reset()` — 重置回第一优先级 API
- `window.MUSIC_CONFIG` — 查看完整配置
- `window.__MUSIC_ENV__` — 查看注入的环境变量

### TuneHub 使用注意
- 明确禁止商用
- 服务器资源有限，避免高频并发请求
- 建议自建 go-music-api 或 NCM-Enhanced 作为稳定替代

---

## 七、文件清单

| 文件 | 作用 |
|------|------|
| `public/js/music-config.js` | 全局配置（API 列表/内容源/UI/降级策略/env 注入） |
| `public/js/music-api.js` | 多 API 适配层（降级 + 重试 + 防跳歌预检 + TODO 占位跳过） |
| `public/js/music-player-init.js` | liveling 实例化 + 原生 audio 降级 + 全失败隐藏 |
| `public/js/music-copyright-notice.js` | 版权声明（优先注入 footer 内，保 sticky 铁律） |
| `src/components/music-player/music-player-loader.tsx` | next/script 加载 CDN + 链式加载 4 个 JS + env/touch-action 注入 |
| `src/types/music-player.d.ts` | 全局类型声明（Window 接口扩展） |
| `public/DEPLOY-MUSIC.md` | 本文档 |

---

## 八、版权声明

本站音乐播放器仅供个人学习、研究及非商业交流使用。
所有音频通过第三方公开 API 实时获取，版权归原作者及原音乐平台所有。
本站不存储任何音频文件，不提供下载，不用于商业用途。
特别声明：本站核心音乐内容「小车」的原创歌曲版权归其本人所有。
如版权方有异议，请联系删除。
