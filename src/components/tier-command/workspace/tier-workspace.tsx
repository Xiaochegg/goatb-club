'use client';

// ============================================================
// Tier Workspace V2 · 工单中心主面板（TIER_WORKSPACE_V2_FULL_REDESIGN）
// ------------------------------------------------------------
// 六大区域（工单 §三）+ 保留通道：
//   S1 工单总览 / S2 玩家工单列表 / S3 玩家详情抽屉 /
//   S4 双表核对 / S5 玩家确认中心 / S6 操作审计历史 / 附加：整理表同步通道。
// 最高优先级规则落地：
//   - 黄色名称识别提醒固定在页面顶部（tab 之外），任何状态不消失；
//   - K/D 全局统一「K·击杀 / D·死亡」并归属测试者；
//   - 所有统计来自真实台账数据，绝不写死；
//   - 审批/拒绝/回档/确认全部复用既有后端门禁，本面板零新增写路径。
// 动画（工单 §五）：tab 指示 spring 滑动（layoutId）、区块淡入、
//   按钮 active 缩放、抽屉弹簧滑入；reduced-motion 全部退化；
//   transform/opacity 优先，动画可打断。
// ============================================================

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Inbox, Users, Table2, UserCheck, History, RefreshCw } from 'lucide-react';
import { useLedger } from './use-workspace-data';
import { NameGuardBanner } from './primitives';
import { OverviewSection, type WorkspaceFilter } from './overview-section';
import { PlayerListSection } from './player-list-section';
import { PlayerDetailDrawer } from './player-detail-drawer';
import { TwoTabSection } from './twotab-section';
import { ConfirmCenterSection } from './confirm-center-section';
import { AuditSection } from './audit-section';
import { LegacySyncSection } from './legacy-sync-section';
import { SPRING_TAB, NO_MOTION, WS } from './constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';

type TabKey = 'overview' | 'players' | 'twotab' | 'confirm' | 'audit' | 'legacy';

const TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'overview', label: '工单总览', icon: <Inbox className="h-3.5 w-3.5" aria-hidden="true" /> },
  { key: 'players', label: '玩家工单', icon: <Users className="h-3.5 w-3.5" aria-hidden="true" /> },
  { key: 'twotab', label: '双表核对', icon: <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> },
  { key: 'confirm', label: '确认中心', icon: <UserCheck className="h-3.5 w-3.5" aria-hidden="true" /> },
  { key: 'audit', label: '审计历史', icon: <History className="h-3.5 w-3.5" aria-hidden="true" /> },
  { key: 'legacy', label: '整理表通道', icon: <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> },
];

export default function TierWorkspace() {
  const reduced = useReducedMotion();
  const { data, loading, error, reload } = useLedger();
  const [tab, setTab] = useState<TabKey>('overview');
  const [filter, setFilter] = useState<WorkspaceFilter>('ALL');
  const [detailAggKey, setDetailAggKey] = useState<string | null>(null);
  const [auditKey, setAuditKey] = useState(0);
  const [loadingLocal, setLoadingLocal] = useState(false);

  const recordsByAggKey = useMemo(() => {
    const m = new Map<string, typeof records>();
    const records = data?.records ?? [];
    for (const r of records) {
      const arr = m.get(r.aggKey);
      if (arr) arr.push(r);
      else m.set(r.aggKey, [r]);
    }
    return m;
  }, [data]);

  const detailPlayer = detailAggKey ? (data?.players.find(p => p.aggKey === detailAggKey) ?? null) : null;
  const detailRecords = detailAggKey ? (recordsByAggKey.get(detailAggKey) ?? []) : [];

  function handleSelectFilter(f: WorkspaceFilter) {
    setFilter(f);
    setTab('players');
  }

  function handleWorkspaceChanged() {
    void reload();
    setAuditKey(k => k + 1);
  }

  const spring = reduced ? NO_MOTION : SPRING_TAB;

  return (
    <section
      aria-label="Tier 工单中心"
      className={`flex flex-col gap-3.5 rounded-2xl border border-white/[0.06] p-3 sm:p-4 ${WS.shell}`}
      data-testid="tier-workspace-v2"
    >
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-bold text-white">
            Tier 工单中心
            <span className="rounded-full border border-[rgba(191,90,242,0.4)] bg-[rgba(191,90,242,0.12)] px-2 py-0.5 text-[10px] font-bold tracking-wider text-[#d0a6f7]">
              V2.0
            </span>
          </h3>
          <p className={`mt-0.5 text-xs leading-relaxed ${WS.subText}`}>
            按玩家聚合的工单工作台 —— 名称与 Tier 分离 · K/D 归属测试者 · 双表分别核对 · 未确认不计数
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setLoadingLocal(true); void reload().then(() => setLoadingLocal(false)); }}
          disabled={loading}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:bg-white/[0.08] active:scale-[0.97] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading || loadingLocal ? 'animate-spin' : ''}`} aria-hidden="true" />
          刷新台账
        </button>
      </div>

      {/* 名称识别保护（黄色常驻提醒 —— 工单最高优先级规则，任何 tab 均可见） */}
      <NameGuardBanner identityReviewCount={data?.stats.identityReviewCount ?? 0} />

      {/* 台账加载错误 */}
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-300">
          {error}
        </div>
      )}

      {/* Tab 导航（选中背景 spring 平滑移动） */}
      <div className="flex gap-1 overflow-x-auto scrollbar-hide rounded-xl border border-white/[0.06] bg-black/25 p-1" role="tablist" aria-label="工单中心区域">
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`relative inline-flex min-h-[38px] flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                active ? 'text-white' : 'text-[#93a89a] hover:text-white/90'
              }`}
              data-testid={`ws-tab-${t.key}`}
            >
              {active && (
                <motion.span
                  layoutId={reduced ? undefined : 'ws-tab-pill'}
                  transition={spring}
                  className="absolute inset-0 rounded-lg border border-[rgba(191,90,242,0.45)] bg-[rgba(191,90,242,0.14)]"
                  aria-hidden="true"
                />
              )}
              <span className="relative flex items-center gap-1.5">
                {t.icon}
                {t.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* 区块内容（轻微淡入；tab 可打断） */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={reduced ? NO_MOTION : { duration: 0.22, ease: 'easeOut' }}
        >
          {tab === 'overview' && (data?.stats ? (
            <OverviewSection
              stats={data.stats}
              reduced={reduced}
              activeFilter={filter}
              onSelectFilter={handleSelectFilter}
            />
          ) : (
            <OverviewSkeleton />
          ))}

          {tab === 'players' && (
            <PlayerListSection
              players={data?.players ?? []}
              recordsByAggKey={recordsByAggKey}
              loading={loading}
              reduced={reduced}
              filter={filter}
              onFilterChange={setFilter}
              onOpenDetail={p => setDetailAggKey(p.aggKey)}
            />
          )}

          {tab === 'twotab' && <TwoTabSection reduced={reduced} />}

          {tab === 'confirm' && <ConfirmCenterSection records={data?.records ?? []} />}

          {tab === 'audit' && <AuditSection refreshKey={auditKey} reduced={reduced} />}

          {tab === 'legacy' && (
            <div className="flex flex-col gap-3">
              <p className={`text-[10px] leading-relaxed ${WS.faintText}`}>
                整理表 y344e4 同步审核通道（既有能力原样保留）：手动同步 → 分组审核 → 逐条勾选写入 / 拒绝 → 回档。
                每行必须手动勾选，无全选；AI 建议仅供参考，绝不代操作。
              </p>
              <LegacySyncSection onApproved={handleWorkspaceChanged} />
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* S3 玩家详情抽屉 */}
      <PlayerDetailDrawer
        player={detailPlayer}
        records={detailRecords}
        open={detailAggKey !== null}
        reduced={reduced}
        onClose={() => setDetailAggKey(null)}
        onChanged={handleWorkspaceChanged}
      />
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-busy="true" aria-label="总览加载中">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-[68px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
      ))}
    </div>
  );
}
