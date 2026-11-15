// ============================================================
// Next.js 服务端启动钩子（instrumentation）
// ------------------------------------------------------------
// 职责一：恢复 Tier 收集表自动同步调度器
//   （开关/间隔持久化在 Config 表；若此前管理员已开启，则重启后
//    自动恢复定时器并立即先拉一轮 —— 管理员指令 2026-11-09）。
// 职责二：backup-keeper 监督者（2026-11-05 架构纠错的规定职责，
//   此前 instrumentation 文件缺失、监督从未挂接 —— 本轮补挂）：
//   dev 启动时检查 keeper 心跳，不在位则 detached 拉起
//   （容器重置场景：dev 被拉起 → 把 keeper 带回 → 小时桶补位）。
//   2026-11-09 监督升级（管理员指令「写一个开关吧」落地所需）：
//   监督从「仅启动时一次」升级为每 60s 常驻巡检 —— keeper 若在中途
//   死亡（OOM/误杀），下一个巡检周期即被拉回，5 分钟自动存档不因
//   单次 keeper 意外而长期空窗。仍是「监督者」职责，绝非备份定时器：
//   备份调度唯一入口仍是 mini-services/backup-keeper。
// 纪律：本文件绝不抛错、绝不阻塞启动、绝不注册备份定时器；
//   仅 nodejs runtime 执行。
// ============================================================
// 职责三（审计 P1-5 修复，批示「执行全部」2026-11-13）：chat-service 监督
//   修复前 chat-service 无任何自启/监督链路（:3003 常态不可达），而前端
//   Dock 聊天入口常驻可点 —— 用户点击即失败（审计 P1-5「实时聊天后端
//   未运行且无自启监督」）。本职责对齐职责二模式：启动检查 + 每 60s
//   巡检，缺位则 detached 拉起 mini-services/chat-service（其自带
//   /health 探活与端口占用守卫，多入口并发拉起安全）。监督者职责，
//   绝不实现聊天逻辑本身。
// ============================================================

const g = globalThis as unknown as {
  __goatbKeeperWatchdog?: ReturnType<typeof setInterval>;
  __goatbChatWatchdog?: ReturnType<typeof setInterval>;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { ensureAutoIngestStarted } = await import('./lib/tier-command/auto-ingest');
    await ensureAutoIngestStarted();
  } catch (e) {
    console.error('[instrumentation] tier-auto-ingest 启动恢复失败（不影响服务器）:', e);
  }
  try {
    const { ensureKeeperAlive } = await import('./lib/backup/keeper-supervisor');
    ensureKeeperAlive();
    // 常驻监督：每 60s 巡检一次（幂等：心跳新鲜则零动作；认领文件 + keeper
    // 单例锁双重防重复拉起）。globalThis 守卫防 dev 热重载注册多个巡检器。
    if (!g.__goatbKeeperWatchdog) {
      g.__goatbKeeperWatchdog = setInterval(() => {
        void (async () => {
          try {
            const { checkKeeperAlive } = await import('./lib/backup/keeper-supervisor');
            checkKeeperAlive();
          } catch { /* 监督失败绝不影响服务器 */ }
        })();
      }, 60_000);
      g.__goatbKeeperWatchdog.unref?.();
    }
  } catch (e) {
    console.error('[instrumentation] keeper 监督失败（不影响服务器）:', e);
  }
  try {
    const { ensureChatAlive } = await import('./lib/chat/chat-supervisor');
    await ensureChatAlive();
    // 常驻监督：每 60s 巡检一次（幂等：/health 200 则零动作；认领文件 +
    // chat-service 端口探测双重防重复拉起）。globalThis 守卫防 dev 热重载
    // 注册多个巡检器。
    if (!g.__goatbChatWatchdog) {
      g.__goatbChatWatchdog = setInterval(() => {
        void (async () => {
          try {
            const { checkChatAlive } = await import('./lib/chat/chat-supervisor');
            await checkChatAlive();
          } catch { /* 监督失败绝不影响服务器 */ }
        })();
      }, 60_000);
      g.__goatbChatWatchdog.unref?.();
    }
  } catch (e) {
    console.error('[instrumentation] chat-service 监督失败（不影响服务器）:', e);
  }
}
