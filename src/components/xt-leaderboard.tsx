'use client';

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { Filter } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import {
  BOARD_TABS, XT_MODE_ICONS, XT_RANK_TITLES_CN,
  NORMAL_MODES, getXtTierGroupsForMode,
  getXtRankInfo, isXtTested, xtTierBadgeClass,
  type GameMode, type BoardMode,
} from '@/lib/constants';
import {
  getSortedPlayers, getPlayerModeScore, getPlayerTotalScore,
  computeTieRanks, type ScoredPlayer,
} from '@/lib/scoring';
import { McIcon, ModeIcon } from '@/components/mc-icon';
import { PlayerList } from '@/components/player-list';
import { TierBadge } from '@/components/tier-badge';
import { PvpChallenges } from '@/components/pvp/pvp-challenges';
import type { TagStyle } from '@/lib/tag-styles';

// XT 榜徽章：有个性样式时由 TierBadge 接管（个性化外观即视觉主体），
// 无样式时保持 XT 原版 xtlb-badge 零改动（XT 规格不受影响）。
function XtTierBadge({ tier, tagStyle }: { tier: string; tagStyle?: TagStyle | null }) {
  const hasFx = !!tagStyle && (tagStyle.bgEffect !== 'none' || tagStyle.textEffect !== 'none' || !!tagStyle.textColor);
  if (hasFx) return <TierBadge tier={tier} size="sm" tagStyle={tagStyle} />;
  return <span className={`xtlb-badge ${xtTierBadgeClass(tier)}`}>{tier}</span>;
}

// ============================================================
// Component: XtLeaderboard — XT PVP Tier 规格榜（用户指令 2026-10）
// 直接 copy upload/xt_pvp_tier_cleaned.html 的排行榜规格：
//   ① 模式 Tab（XT 芯片样式：图标上/文字下；总榜 = 🏆；模式名字不变，
//      有 XT 实拍图的模式替换为 XT 图标，无对应物的保留原像素图标）
//   ② 搜索框（XT 样式，绑定原 store.searchQuery）+ 筛选面板
//     （防抄袭差异化加回：总榜按中文称号过滤行、单模式榜按 Tier 组过滤列；
//      纯视图层过滤，排名/点数/表格规格零改动）
//   ③ 总榜 = 四列表格：# | 玩家(名字+中文称号) | 积分 | 全模式（强→弱）
//     （表头与称号已中文化——防抄袭差异化，用户指令 2026-10）
//   ④ 单模式榜 = 分组矩阵：Tier 1~5 列（HT/LT 原版阶梯，用户指令 2026-10），每列玩家芯片
// 注：XT 模板的公告条（notice-bar）已移除（用户指令 2026-10：黑框没用，
//     不如顶部既有公告小弹窗）——公告仅由 page.tsx 顶部弹窗承载。
// 感动榜（EMOTION）按硬约束保持原渲染（PlayerList 委托），不并入 XT 表格。
// 点数/徽章配色/头衔阈值沿用 XT 模板值（constants.ts），段位阶梯已回归原版 HT/LT × 5（2026-10）。
// 仅称号文案中文化。
// ============================================================
export function XtLeaderboard() {
  // OPT-B：selector 化——榜单是全站最大渲染子树，任何无关 store 变化
  // （点赞/聊天未读/announcement 等）都不应触发全表重渲染。
  const players = useAppStore((s) => s.players);
  const activeMode = useAppStore((s) => s.activeMode);
  const setActiveMode = useAppStore((s) => s.setActiveMode);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSelectedPlayerId = useAppStore((s) => s.setSelectedPlayerId);
  const [filterOpen, setFilterOpen] = useState(false);
  const [tierFilter, setTierFilter] = useState<string[]>([]);
  const searchRowRef = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback((id: string) => setSelectedPlayerId(id), [setSelectedPlayerId]);

  // 切模式重置筛选（同名组跨模式语义不同，重置更可预期）——
  // render 期间 diff 重置模式（React 官方推荐式，避免 effect 内 setState 级联渲染）
  const [prevMode, setPrevMode] = useState(activeMode);
  if (prevMode !== activeMode) {
    setPrevMode(activeMode);
    setTierFilter([]);
    setFilterOpen(false);
  }

  // 筛选面板：点击外部 / Escape 关闭（与 header 赛季 popover 语义一致）
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (searchRowRef.current && !searchRowRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterOpen]);

  // 筛选项：总榜 = 中文称号阶梯；单模式 = Tier 组标签；感动榜不筛选（硬约束）
  const filterOptions = useMemo(() => {
    if (activeMode === 'TOTAL') return [...XT_RANK_TITLES_CN];
    if (activeMode === 'EMOTION') return [];
    return getXtTierGroupsForMode(activeMode as GameMode).map(g => g.label);
  }, [activeMode]);

  const toggleFilter = useCallback((opt: string) => {
    setTierFilter(prev => prev.includes(opt) ? prev.filter(x => x !== opt) : [...prev, opt]);
  }, []);

  return (
    <div className="xtlb-root px-4 lg:px-3 mb-4">
      {/* ② XT 模式 Tab —— 图标在上文字在下，横向滚动 */}
      <div className="xtlb-tabs" role="tablist" aria-label="榜单模式">
        {BOARD_TABS.map(tab => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeMode === tab.key}
            aria-label={tab.label}
            className={`xtlb-tab${activeMode === tab.key ? ' active' : ''}`}
            onClick={() => setActiveMode(tab.key)}
          >
            {tab.key === 'TOTAL' ? (
              <span className="xtlb-tab-trophy" aria-hidden="true">🏆</span>
            ) : XT_MODE_ICONS[tab.key as GameMode] ? (
              <img
                className="xtlb-tab-icon"
                src={XT_MODE_ICONS[tab.key as GameMode]}
                alt=""
                aria-hidden="true"
                decoding="async"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <McIcon src={tab.icon} className="w-4 h-4 shrink-0" />
            )}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* ③ XT 搜索框 + 筛选（防抄袭差异化） */}
      <div className="xtlb-search-row" ref={searchRowRef}>
        <PvpChallenges />
        <input
          className="xtlb-search"
          type="search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索玩家名字…"
          aria-label="搜索玩家名字"
        />
        {filterOptions.length > 0 && (
          <button
            type="button"
            className={`xtlb-filter-btn${tierFilter.length > 0 ? ' active' : ''}`}
            onClick={() => setFilterOpen(o => !o)}
            aria-expanded={filterOpen}
            aria-haspopup="true"
            aria-label="筛选"
          >
            <Filter className="w-3.5 h-3.5" aria-hidden="true" />
            筛选{tierFilter.length > 0 ? ` · ${tierFilter.length}` : ''}
          </button>
        )}
        {filterOpen && filterOptions.length > 0 && (
          <div className="xtlb-filter-panel" role="group" aria-label="筛选条件">
            <span className="xtlb-filter-label">
              {activeMode === 'TOTAL' ? '按称号筛选（多选）' : '按段位组筛选（多选）'}
            </span>
            <div className="xtlb-filter-chips">
              {filterOptions.map(opt => (
                <button
                  key={opt}
                  type="button"
                  className={`xtlb-filter-chip${tierFilter.includes(opt) ? ' active' : ''}`}
                  aria-pressed={tierFilter.includes(opt)}
                  onClick={() => toggleFilter(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            {tierFilter.length > 0 && (
              <button type="button" className="xtlb-filter-clear" onClick={() => setTierFilter([])}>
                清除筛选
              </button>
            )}
          </div>
        )}
      </div>

      {activeMode === 'EMOTION' ? (
        /* 感动榜：硬约束保护 —— 保持原有渲染与行为不变 */
        <PlayerList />
      ) : activeMode === 'TOTAL' ? (
        <OverallBoard players={players} search={searchQuery} tierFilter={tierFilter} onSelect={handleSelect} />
      ) : (
        <ModeMatrixBoard players={players} mode={activeMode} search={searchQuery} tierFilter={tierFilter} onSelect={handleSelect} />
      )}
    </div>
  );
}

// ============================================================
// 总榜 —— XT renderOverall 规格：# | 玩家 | 积分 | 全模式（强→弱）
// （表头中文化=防抄袭差异化；列序/点数/排序规格与 XT 一致）
// ============================================================
function OverallBoard({ players, search, tierFilter, onSelect }: {
  players: ScoredPlayer[];
  search: string;
  tierFilter: string[];
  onSelect: (id: string) => void;
}) {
  // 排序/过滤/破平沿用站内引擎（积分 desc → 战绩评分 → 名字），与 XT 一致积分降序
  const sorted = useMemo(
    () => getSortedPlayers(players, 'TOTAL', true, search),
    [players, search],
  );
  const ranks = useMemo(
    () => computeTieRanks(sorted, p => getPlayerTotalScore(p)),
    [sorted],
  );
  // 全局排名 Map：筛选只隐藏行，排名号保持全榜口径（不被筛选压缩重排）
  const rankMap = useMemo(() => {
    const m = new Map<string, number>();
    sorted.forEach((p, i) => m.set(p.id, ranks[i]));
    return m;
  }, [sorted, ranks]);
  // 称号筛选（中文称号，视图层过滤）
  const visible = useMemo(() => {
    if (tierFilter.length === 0) return sorted;
    return sorted.filter(p => tierFilter.includes(getXtRankInfo(getPlayerTotalScore(p)).title));
  }, [sorted, tierFilter]);

  if (visible.length === 0) return <XtEmpty search={search} noResult={tierFilter.length > 0} />;

  return (
    <div className="xtlb-tablewrap">
      <table className="xtlb-table">
        <thead>
          <tr>
            <td scope="col">#</td>
            <td scope="col" className="xtlb-th-left">玩家</td>
            <td scope="col">积分</td>
            <td scope="col">全模式（强→弱）</td>
          </tr>
        </thead>
        <tbody>
          {visible.map(p => {
            const rank = rankMap.get(p.id) ?? 0;
            const total = getPlayerTotalScore(p);
            const rankInfo = getXtRankInfo(total);
            const rankCls = rank === 1 ? 'xtlb-rank1' : rank === 2 ? 'xtlb-rank2' : rank === 3 ? 'xtlb-rank3' : '';
            // 已测模式（有段位字符串），按积分 best→worst
            const testedModes = NORMAL_MODES
              .filter(m => isXtTested(p.tiers?.[m]))
              .map(m => ({ mode: m, tier: String(p.tiers?.[m]), score: getPlayerModeScore(p, m) }))
              .sort((a, b) => b.score - a.score);
            return (
              <tr key={p.id} className="xtlb-row" onClick={() => onSelect(p.id)}>
                <td className={`xtlb-rank-cell ${rankCls}`}>{rank}</td>
                <td className="xtlb-player-cell">
                  <button
                    type="button"
                    className="xtlb-player-name"
                    onClick={e => { e.stopPropagation(); onSelect(p.id); }}
                  >
                    <strong>{p.name}</strong>
                  </button>
                  <div className={`xtlb-player-title ${rankInfo.cssClass}`}>{rankInfo.title}</div>
                </td>
                <td className="xtlb-point-cell"><b>{total.toLocaleString()}</b></td>
                <td className="xtlb-modes-cell">
                  {testedModes.map(({ mode, tier }) => (
                    <div className="xtlb-mode-cell" key={mode}>
                      <ModeIcon mode={mode as GameMode} size="md" />
                      <XtTierBadge tier={tier} tagStyle={p.tagStyle} />
                    </div>
                  ))}
                  {testedModes.length === 0 && <span className="xtlb-noxt">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// 单模式榜 —— XT renderSingle 规格：Tier 1~5 分组矩阵（原版 HT/LT 阶梯）
// 每列一列玩家芯片（模式图标 + 名字 + 段位徽章），列内按积分序
// ============================================================
function ModeMatrixBoard({ players, mode, search, tierFilter, onSelect }: {
  players: ScoredPlayer[];
  mode: BoardMode;
  search: string;
  tierFilter: string[];
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => getXtTierGroupsForMode(mode as GameMode), [mode]);
  // 该模式有段位字符串的玩家，按站内引擎排序（积分 desc → 评分 → 名字）
  const list = useMemo(
    () => getSortedPlayers(players, mode, true, search)
      .filter(p => isXtTested(p.tiers?.[mode])),
    [players, mode, search],
  );
  const groupPlayers = useMemo(
    () => groups.map(g => list.filter(p => g.tiers.includes(String(p.tiers?.[mode]).toUpperCase()))),
    [groups, list, mode],
  );
  const maxRows = useMemo(() => groupPlayers.reduce((mx, g) => Math.max(mx, g.length), 0), [groupPlayers]);
  // Tier 组筛选（视图层过滤列，隐藏未选组；排名/分组规格零改动）
  // 2026-11-14 部署验收整改：空组一并隐藏——段位组无玩家时不再渲染空列，
  // 消除移动端横向左滑时出现的大片空白（用户报告「左滑大空缺陷」）。
  // 空列对 XT 规格无信息量（表头仍在、格内无芯片），隐藏后宽度自适应实际
  // 参测人数，矩阵只在有内容时才出现横向滚动。全部为空时走 XtEmpty 兜底。
  const visibleIdx = useMemo(
    () => groups
      .map((_, i) => i)
      .filter(i => !tierFilter.length || tierFilter.includes(groups[i].label))
      .filter(i => groupPlayers[i].length > 0),
    [groups, groupPlayers, tierFilter],
  );

  if (list.length === 0 || maxRows === 0) return <XtEmpty search={search} />;
  if (visibleIdx.length === 0) return <XtEmpty search="" noResult />;

  return (
    <div className="xtlb-tablewrap">
      <table className="xtlb-table">
        <thead>
          <tr>
            {visibleIdx.map(i => (
              <td key={groups[i].label} scope="col">
                <div className="xtlb-tier-head">{groups[i].label}</div>
              </td>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxRows }, (_, row) => (
            <tr key={row}>
              {visibleIdx.map(i => {
                const g = groups[i];
                const p = groupPlayers[i][row];
                if (!p) return <td key={g.label} />;
                const tier = String(p.tiers?.[mode]).toUpperCase();
                return (
                  <td key={g.label} className="xtlb-matrix-cell">
                    <button
                      type="button"
                      className="xtlb-chip"
                      onClick={() => onSelect(p.id)}
                      title={`${p.name} · ${tier}`}
                    >
                      <ModeIcon mode={mode as GameMode} size="chip" />
                      <span className="xtlb-chip-name">{p.name}</span>
                      <XtTierBadge tier={tier} tagStyle={p.tagStyle} />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 模式图标：统一走 mc-icon.tsx 共享 ModeIcon（XT 实拍图 + screen 混合，
// 无对应物回退像素 SVG）——与个人面板/详情弹窗/侧栏同源，避免双实现漂移。

function XtEmpty({ search, noResult }: { search: string; noResult?: boolean }) {
  return (
    <div className="xtlb-empty" role="status">
      {noResult ? '没有匹配当前筛选的分组/玩家' : search ? '没有找到匹配的玩家' : '该模式暂无已测玩家'}
    </div>
  );
}
