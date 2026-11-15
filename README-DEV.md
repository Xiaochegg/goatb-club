# GOATB 社区排行榜 — 开发文档

> MC PvP 深度社区排行榜。视觉标杆 + 竞技可信度双达标。

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | Next.js (App Router) | 16.x |
| 语言 | TypeScript | 5.x |
| UI 库 | React | 19.x |
| 样式 | Tailwind CSS + shadcn/ui (New York) | 4.x |
| 状态 | Zustand (client) + TanStack Query (server) | — |
| 动画 | Framer Motion | 12.x |
| 图表 | Recharts | 2.x |
| 数据库 ORM | Prisma | 6.x |
| 数据库 | SQLite | — |
| 实时 | Socket.IO (chat-service mini-service, port 3003) | 4.x |
| 认证 | NextAuth.js v4 + 自建 AdminUser RBAC | — |
| AI | z-ai-web-dev-sdk (仅后端) | — |
| 包管理 | bun | — |

## 环境要求

- Node.js ≥ 20
- bun ≥ 1.3
- 端口 3000 (Next dev) / 3003 (chat socket.io) / 81 (Caddy gateway)

## 快速开始

```bash
# 安装依赖
bun install

# 启动开发服务器（前台 + 后台 mini-service）
bun run dev                    # Next dev on :3000
bun run dev --filter chat-service  # 或 cd mini-services/chat-service && bun run dev

# 数据库
bun run db:push                # 推 schema 到 SQLite（破坏性，dev 用）
bun run db:generate            # 生成 Prisma Client

# 代码质量
bun run lint                   # ESLint
```

启动后访问 `http://localhost:3000/`（沙箱内通过 Caddy 网关 :81 暴露）。

> ⚠️ 沙箱环境：外部访问走 Caddy 网关，不要直连 localhost 端口。WebSocket 用 `io("/?XTransformPort=3003")`，API 跨端口用 `?XTransformPort=3003` query。

## 项目结构

```
prisma/schema.prisma          # 数据模型（Player / Config / OperationLog / AdminUser / Season / RankSnapshot）
src/lib/constants.ts          # 模式/段位/主题/评分常量与类型
src/lib/scoring.ts            # 评分引擎（单一真相源）
src/lib/store.ts              # Zustand 全局状态
src/app/page.tsx              # 唯一用户可见路由（单文件全组件内联，~5100 行）
src/app/globals.css           # 全局样式 + LGX 设计系统 token
src/app/api/v1/               # API 路由（players / stats / seasons / admin / ...）
mini-services/chat-service/   # Socket.IO 实时服务（独立 bun 项目，:3003）
```

## 数据模型（当前）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `Player` | 玩家 | tiers(JSON: {SHIELD:"HT1",...}) / overrideScores / stats(JSON) / likes / emotionText |
| `Config` | KV 配置 | key / value |
| `OperationLog` | 管理审计 | type / detail / beforeData / afterData / ip / sessionId |
| `AdminUser` | 管理员 RBAC | username / passwordHash / role(OWNER\|ADMIN\|MODERATOR\|VIEWER) |
| `Season` | 赛季 | name / startAt / endAt / status |
| `RankSnapshot` | 排名历史快照 | playerId / mode / rank / score / seasonId |

> ⚠️ SQLite 无 JSONB / 生成列 / 视图；tiers/stats/overrideScores 用 `String` 存 JSON，应用层 `JSON.parse`。

## 评分体系（当前）

- 段位：NormalTier (HT1-LT5, 10 级) + JiahaoTier (LZ1-LL5, 10 级，嘉豪模式专属)
- 分值：NORMAL_TIER_SCORES (HT1=50 → LT5=1) / JIAHAO_TIER_SCORES (LZ1=4550 → LL5=950)
- 总分：8 个普通模式 tier 分数之和（JIAHAO 排除）
- overrideScores 可手动覆盖某模式分数（null = 用 tier 分）
- `src/lib/scoring.ts` 是唯一真相源，前后端共用

## 9 个游戏模式

`SHIELD 盾斧 / CRYSTAL 水晶 / SWORD 剑斗 / DIAMOND_POTION 钻石药水 / ALLOY_POTION 合金药水 / JIAHAO 嘉豪 / MACE 重锤 / BUHC / SMP`

> ⚠️ 嘉豪版/心动版（EMOTION 感动榜）是社区专属功能，**绝对不要碰**（用户明确要求）。

## 常用命令

```bash
bun run lint          # 代码质量检查
bun run db:push       # 推 schema 变更到 SQLite
tail -f dev.log       # 看开发服务器日志
```

## 不要做的事

- 不要 `bun run build`（沙箱不支持）
- 不要直连 localhost:3000/3003（走 Caddy 网关）
- 不要在客户端用 z-ai-web-dev-sdk（仅后端）
- 不要改既有中英文文案（只做版式/组件/数据层）
- 不要碰嘉豪版/感动榜（EMOTION）社区功能
- 不要硬编码颜色 hex（走 CSS 变量 --jade-* / --primary 等）

## 已知技术债

- `src/app/page.tsx` 5100+ 行单文件，待拆分（已多次延期）
- `globals.css` 残留 3 个无引用旧 CSS 类
- `showEmptySlots` 开关无消费点（历史遗留）
