'use client';
// ============================================================
// GOATB 管理后台 V3 控制台化重组
// （管理员批复 2026-11-11「简化管理员后台，但是功能要实权性可视化，
//   因为现在感觉布局太复杂」trace 1a1cc81dc488ffe9）
// ------------------------------------------------------------
// 旧壳复杂度归因（本批修复对象）：
//   ① max-w-3xl 小弹窗承载 9 个分区 → 内容拥挤；
//   ② 9 个横向文字页签塞一行、小屏溢出滚动、无图标无分组 → 方向感差；
//   ③ 页签内再套子页签（内容组 4 项、其中内容配置又套 4 项 = 三层嵌套）；
//   ④ 各分区实权不外显，能做什么要点进去才知道。
// V3 重组（仅改本壳文件；9 个页签组件本体零改动、chunk 边界与
// dynamic 拆包语义完全保留）：
//   ① 小弹窗 → 近全屏控制台（桌面 1080×~720，移动端全屏）；
//   ② 横向页签 → 左侧常驻分组侧栏（运营/内容/运维 三组 9 分区一屏
//      全见 = 实权可视化）；移动端为顶部横向图标轨道；
//   ③ 内容区头部显示当前分区「实权说明」（该分区能做什么一句话讲清）；
//   ④ 身份卡常驻（用户名 + 角色徽标 + VIEWER 只读提示 + 退出登录）。
// 回滚 = git revert 本文件即回旧壳（页签组件与 API 均未动）。
// 旧壳留档：.zbackups/2026-11-11-admin-console-v3/admin-index.tsx.orig
// 方案与验收矩阵：docs/BATCH-PLAN-admin-console-v3-2026-11-11.md
// ============================================================
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Settings, X, LogOut, Loader2, LayoutDashboard, Users, UserCheck,
  FileText, Trophy, Database, ClipboardList, HandCoins, Swords,
  ShieldCheck, Eye, Palette, type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { adminFetch, clearAdminToken } from '@/lib/admin-fetch';
import { SPRING_ROYAL } from '@/lib/constants';
import { cn } from '@/lib/utils';

function TabLoading() {
  return <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>;
}

// 按需页签（拆包语义与 V2 壳完全一致：打开后台 = 壳 + 当前分区模块，
// 切换分区 = 增量加载对应 chunk；合并组各自独立 chunk，互不牵连）
const AdminDashboard = dynamic(() => import('./dashboard-tab').then(m => m.AdminDashboard), { ssr: false, loading: () => <TabLoading /> });
const AdminPlayerManage = dynamic(() => import('./players-tab').then(m => m.AdminPlayerManage), { ssr: false, loading: () => <TabLoading /> });
const AdminClaims = dynamic(() => import('./claims-tab').then(m => m.AdminClaims), { ssr: false, loading: () => <TabLoading /> });
const AdminContentGroup = dynamic(() => import('./content-group').then(m => m.AdminContentGroup), { ssr: false, loading: () => <TabLoading /> });
const AdminSeasonManage = dynamic(() => import('./season-tab').then(m => m.AdminSeasonManage), { ssr: false, loading: () => <TabLoading /> });
const AdminOpsGroup = dynamic(() => import('./ops-group').then(m => m.AdminOpsGroup), { ssr: false, loading: () => <TabLoading /> });
const AdminSponsor = dynamic(() => import('./sponsor-tab').then(m => m.AdminSponsor), { ssr: false, loading: () => <TabLoading /> });
// 约 PVP 管理页签（工单 2026-11-10 V1.0）：只读工单总览
const AdminPvp = dynamic(() => import('./pvp-tab').then(m => m.AdminPvpTab), { ssr: false, loading: () => <TabLoading /> });
// PLAYER IDENTITY ENGINE V1.0（trace 1a1cfcfc32dceef1 批示「通过」）：玩家视觉管理中心
const AdminVisualManager = dynamic(() => import('./visual-tab').then(m => m.AdminVisualManager), { ssr: false, loading: () => <TabLoading /> });
// TIER_WORKSPACE_V2（工单 2026-11-09）：Tier 工单中心 V2.0 挂载
const TierTicketPanel = dynamic(() => import('@/components/tier-command/workspace/tier-workspace'), { ssr: false, loading: () => <TabLoading /> });

// ============================================================
// 分区导航配置 = 后台实权地图（三组九区，一屏全见）。
// desc = 分区实权说明（进分区前先讲清该区能做什么）。
// ============================================================
type SectionKey = 'dashboard' | 'players' | 'claims' | 'content' | 'season' | 'sponsor' | 'ops' | 'tier' | 'pvp' | 'visual';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  desc: string;
}

const NAV_GROUPS: Array<{ group: string; items: SectionDef[] }> = [
  {
    group: '运营',
    items: [
      { key: 'dashboard', label: '总览', icon: LayoutDashboard, desc: '玩家 / 评分 / 点赞 / 异常数据一屏掌握' },
      { key: 'players', label: '玩家管理', icon: Users, desc: '新增 · 编辑 · 删除 · 批量导入 · 一键重算 · 密码协助' },
      { key: 'claims', label: '认领审批', icon: UserCheck, desc: '玩家认领请求 通过 / 拒绝 一键裁决' },
    ],
  },
  {
    group: '内容',
    items: [
      { key: 'content', label: '内容管理', icon: FileText, desc: '公告 · 说明文案 · 音乐 · 背景 · 个性标签' },
      { key: 'season', label: '赛季', icon: Trophy, desc: '赛季创建 · 启用 · 删除' },
      { key: 'visual', label: '玩家视觉', icon: Palette, desc: '专属特效 · 形状尺寸 · 时间轴 · 预设 · 版本回滚' },
      { key: 'sponsor', label: '赞助', icon: HandCoins, desc: '赞助位管理 · 玩家祝福语' },
    ],
  },
  {
    group: '运维',
    items: [
      { key: 'ops', label: '数据运维', icon: Database, desc: '服务器自动存档 · 操作日志 · 沙盒数据' },
      { key: 'tier', label: 'Tier 工单', icon: ClipboardList, desc: '总览 · 玩家工单 · 双表核对 · 确认中心 · 审计 · 整理表通道' },
      { key: 'pvp', label: '约战管理', icon: Swords, desc: '约战工单总览（只读）' },
    ],
  },
];

const ALL_SECTIONS: SectionDef[] = NAV_GROUPS.flatMap(g => g.items);

// 分区 → 组件映射（与 V2 壳条件渲染等价：key={active} 保证切换即卸载重挂，
// 各分区本地态语义不变）
const SECTION_COMPONENTS: Record<SectionKey, React.ComponentType> = {
  dashboard: AdminDashboard,
  players: AdminPlayerManage,
  claims: AdminClaims,
  content: AdminContentGroup,
  season: AdminSeasonManage,
  visual: AdminVisualManager,
  sponsor: AdminSponsor,
  ops: AdminOpsGroup,
  tier: TierTicketPanel,
  pvp: AdminPvp,
};

export function AdminPanel() {
  const { adminPanelOpen, setAdminPanelOpen, isAdmin, setIsAdmin, adminRole, setAdminRole, adminUsername, setAdminUsername } = useAppStore();
  const [active, setActive] = useState<SectionKey>('dashboard');

  const current = ALL_SECTIONS.find(s => s.key === active) ?? ALL_SECTIONS[0];
  const CurrentIcon = current.icon;
  const CurrentSection = SECTION_COMPONENTS[active];

  // 退出登录：清服务端 cookie + 本地 token + 前端状态，避免残留半登录态
  const handleLogout = async () => {
    try { await adminFetch('/api/v1/admin/logout', { method: 'POST' }); } catch { /* 网络失败也照样清本地 */ }
    clearAdminToken();
    setIsAdmin(false);
    setAdminRole(null);
    setAdminUsername(null);
    setAdminPanelOpen(false);
  };

  if (!isAdmin) return null;

  return (
    <AnimatePresence>
      {adminPanelOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-stretch justify-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => setAdminPanelOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="管理后台控制台"
            initial={{ scale: 0.96, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 16 }}
            transition={SPRING_ROYAL}
            onClick={e => e.stopPropagation()}
            className="relative w-full h-full sm:w-[min(1080px,94vw)] sm:h-[min(720px,90vh)] liquid-glass-strong sm:rounded-[var(--radius-liquid-lg)] overflow-hidden flex flex-col"
          >
            <div className="h-1.5 gold-bar flex-shrink-0" />

            <div className="flex flex-1 min-h-0">
              {/* ── 桌面侧栏：三组九区常驻（实权地图）+ 身份卡 ── */}
              <aside className="hidden md:flex w-52 flex-shrink-0 flex-col border-r border-white/10 bg-black/20">
                <div className="px-4 pt-4 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-jade-500/15 border border-jade-500/30 flex items-center justify-center flex-shrink-0">
                      <Settings className="w-4 h-4 text-jade-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-white leading-none">管理后台</div>
                      <div className="text-[10px] text-muted-foreground mt-1">GOATB 控制台</div>
                    </div>
                  </div>
                </div>

                <nav className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2 space-y-3" aria-label="后台分区导航">
                  {NAV_GROUPS.map(group => (
                    <div key={group.group}>
                      <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">{group.group}</div>
                      <div className="space-y-0.5">
                        {group.items.map(item => {
                          const ItemIcon = item.icon;
                          const isActive = active === item.key;
                          return (
                            <button
                              key={item.key}
                              onClick={() => setActive(item.key)}
                              aria-current={isActive || undefined}
                              className={cn(
                                'relative w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-all text-left focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                isActive ? 'bg-jade-500/15 text-jade-400' : 'text-muted-foreground hover:text-white hover:bg-white/5',
                              )}
                            >
                              {isActive && (
                                <motion.span
                                  layoutId="admin-nav-indicator"
                                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-jade-400"
                                  transition={SPRING_ROYAL}
                                />
                              )}
                              <ItemIcon className="w-4 h-4 flex-shrink-0" />
                              <span className="truncate">{item.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>

                {/* 身份卡：实权身份常驻可见（VIEWER = 只读身份提示，对齐 AUTH V2.0 语义） */}
                <div className="border-t border-white/10 p-3">
                  <div className="flex items-center gap-2 px-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-jade-400 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate">{adminUsername || 'admin'}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                        <span>{adminRole || '—'}</span>
                        {adminRole === 'VIEWER' && (
                          <span className="inline-flex items-center gap-0.5 text-amber-400"><Eye className="w-2.5 h-2.5" />只读</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-400 hover:bg-white/5 transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-primary"
                      data-tip="退出登录" aria-label="退出登录"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </aside>

              {/* ── 内容列 ── */}
              <div className="flex-1 flex flex-col min-w-0">
                {/* 移动端顶栏（桌面隐藏：桌面关闭钮在分区头部、退出在侧栏身份卡） */}
                <div className="md:hidden flex items-center justify-between px-3 h-12 border-b border-white/10 flex-shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Settings className="w-4 h-4 text-jade-400 flex-shrink-0" />
                    <span className="text-sm font-bold text-white">管理后台</span>
                    {adminRole && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-jade-500/15 text-jade-400 border border-jade-500/30">
                        {adminRole}{adminRole === 'VIEWER' ? ' · 只读' : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleLogout}
                      className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-400 transition-colors focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label="退出登录"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setAdminPanelOpen(false)}
                      className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-white transition-colors focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label="关闭"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                {/* 移动端分区轨道：三组九区横向滚动（图标 + 名称） */}
                <nav className="md:hidden overflow-x-auto scrollbar-hide border-b border-white/5 px-2 py-2 flex-shrink-0" aria-label="后台分区导航">
                  <div className="flex gap-1">
                    {ALL_SECTIONS.map(item => {
                      const ItemIcon = item.icon;
                      const isActive = active === item.key;
                      return (
                        <button
                          key={item.key}
                          onClick={() => setActive(item.key)}
                          aria-current={isActive || undefined}
                          className={cn(
                            'flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium whitespace-nowrap flex-shrink-0 transition-all focus-visible:ring-2 focus-visible:ring-primary',
                            isActive ? 'bg-jade-500/15 text-jade-400' : 'text-muted-foreground',
                          )}
                        >
                          <ItemIcon className="w-4 h-4" />
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </nav>

                {/* 分区头部：当前位置 + 实权说明（我要在哪、这里能做什么） */}
                <header className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-white/5 flex-shrink-0">
                  <div className="w-8 h-8 rounded-lg bg-jade-500/15 border border-jade-500/30 flex items-center justify-center flex-shrink-0">
                    <CurrentIcon className="w-4 h-4 text-jade-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-bold text-white leading-none">{current.label}</h2>
                    <p className="text-[11px] text-muted-foreground mt-1 truncate">{current.desc}</p>
                  </div>
                  <button
                    onClick={() => setAdminPanelOpen(false)}
                    className="hidden md:flex w-8 h-8 items-center justify-center rounded-lg text-muted-foreground hover:text-white hover:bg-white/5 transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-primary"
                    data-tip="关闭" aria-label="关闭"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </header>

                {/* 分区内容（key=active：与 V2 条件渲染等价，切换即卸载） */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-6">
                  <CurrentSection key={active} />
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
