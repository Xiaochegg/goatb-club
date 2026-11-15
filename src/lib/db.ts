import { PrismaClient } from '@prisma/client'
import path from 'node:path'
import { existsSync } from 'node:fs'

// ============================================================
// 部署兼容修复（2026-11）：DATABASE_URL 路径解析兜底。
// 运行时统一按当前工作目录重解析（bun run start / dev 的 cwd 恒为项目根）：
//   - file: 绝对路径且文件存在 → 原样保留（本沙箱历史行为不变）
//   - file: 绝对路径但文件不存在 → 改写为 <cwd>/db/custom.db
//   - file: 相对路径（A4, 2026-11-03）→ 解析为 <cwd>/<相对路径>：
//     Prisma 运行时对相对路径的解析基准是生成的 client 目录
//     （node_modules/.prisma/client），而非项目根，直接使用会指到
//     不存在的路径。这里统一提前解析为绝对路径消除该不确定性。
//   - 非 file: / 缺失 → 改写为 <cwd>/db/custom.db
// ============================================================
(() => {
  const fallback = 'file:' + path.join(process.cwd(), 'db', 'custom.db');
  const raw = process.env.DATABASE_URL || '';
  if (!raw.startsWith('file:')) {
    process.env.DATABASE_URL = fallback;
    return;
  }
  const p = raw.slice('file:'.length);
  if (path.isAbsolute(p)) {
    if (!existsSync(p)) {
      console.warn(`[db] DATABASE_URL 指向的文件不存在（${p}），回退到 <cwd>/db/custom.db`);
      process.env.DATABASE_URL = fallback;
    }
    return;
  }
  const abs = path.resolve(process.cwd(), p);
  if (!existsSync(abs)) {
    console.warn(`[db] DATABASE_URL 相对路径解析后不存在（${raw} → ${abs}），回退到 <cwd>/db/custom.db`);
    process.env.DATABASE_URL = fallback;
    return;
  }
  process.env.DATABASE_URL = 'file:' + abs;
})();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // OPT-C：query 日志仅 dev 开启（生产 standalone 进程不再逐条打印 SQL，
    // 减少序列化开销与日志体积）；dev 保留用于诊断。
    log: process.env.NODE_ENV === 'production' ? [] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ============================================================
// 2026-11-05 架构纠错：此处不再挂载任何备份调度器。
// 全系统唯一的「每小时第 1 分钟」备份调度器是独立常驻进程
// mini-services/backup-keeper；其复活由 src/instrumentation.ts
// 监督（dev 启动 → keeper 不在位则拉起）。调度器只允许一个入口，
// 不得在 lib/db.ts 与 instrumentation.ts 重复注册。
// ============================================================
