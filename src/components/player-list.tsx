'use client';

import { useEffect, useMemo, useState, useCallback, useLayoutEffect, useRef, type FocusEvent as ReactFocusEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Shield, LocateFixed } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import {
  BOARD_TABS, ALL_MODES, MODE_LABELS,
  type GameMode,
} from '@/lib/constants';
import {
  getPlayerBoardScore,
  getSortedPlayers,
  computeTieRanks,
} from '@/lib/scoring';
import { isEligible } from '@/lib/eligibility';
import { McIcon } from '@/components/mc-icon';
import { MC_ICONS } from '@/lib/mc-icons';
import { PodiumStrip } from '@/components/podium-strip';
import { PlayerCard } from '@/components/player-card';
import { TieDrawerRow } from '@/components/tie-drawer-row';

// 并列抽屉折叠阈值：同一排名的玩家数 ≥ 此值时折叠为抽屉行。
// 2 人并列仍逐行展示（视觉上可接受）；3+ 人堆积才抽屉化。
const TIE_DRAWER_THRESHOLD = 3;

// 将已排好序的玩家列表按密集排名分组，3+ 人同排名 → 一个 drawer 组。
// 返回有序的列表项（单行 / 抽屉），渲染时保留原顺序与 FLIP 动画。
type ListItem<T> =
  | { kind: 'single'; player: T; key: string }
  | { kind: 'drawer'; players: T[]; key: string };

function groupByTies<T extends { id: string }>(
  players: T[],
  rankOf: (id: string) => number,
): ListItem<T>[] {
  const items: ListItem<T>[] = [];
  let i = 0;
  while (i < players.length) {
    const rank = rankOf(players[i].id);
    let j = i + 1;
    while (j < players.length && rankOf(players[j].id) === rank) j++;
    const group = players.slice(i, j);
    if (group.length >= TIE_DRAWER_THRESHOLD) {
      items.push({ kind: 'drawer', players: group, key: `tie-r${rank}-${i}` });
    } else {
      group.forEach(p => items.push({ kind: 'single', player: p, key: p.id }));
    }
    i = j;
  }
  return items;
}

// CG-1 · 定位脉冲 + 滚动（模块级：无 hook 依赖）
// pausedMotion → scrollIntoView 瞬时 + 不加金色脉冲（暂停动效契约）。
function locateAndFlash(row: HTMLElement) {
  const paused = useAppStore.getState().pausedMotion;
  row.scrollIntoView({ block: 'center', behavior: paused ? 'auto' : 'smooth' });
  if (!paused) {
    row.classList.add('lgx-row-locate');
    window.setTimeout(() => row.classList.remove('lgx-row-locate'), 1800);
  }
  row.focus({ preventScroll: true });
}

// ============================================================
// Component: Player List — liquid glass container with flow
// 整体从 page.tsx 拆出（wave-5）。本组件自包含：
//   - 从 useAppStore 取 9 个状态（players/activeMode/sortHighFirst/
//     searchQuery/setSelectedPlayerId/tierFilter/statusFilter/
//     minMatches/period/setPeriod）
//   - 内部 useMemo 计算 sorted/eligible/modeRanks/rankById/eligibleRanks
//   - 内部渲染 PodiumStrip + PlayerCard 列表 + 未参评折叠区
// modeRanks 同时喂 PodiumStrip 和 PlayerCard，与 JSX 强耦合，
// 整体搬迁比「计算留顶层 + props 传」更干净（零跨文件依赖）。
// ============================================================
export function PlayerList() {
  const { players, activeMode, sortHighFirst, searchQuery, setSelectedPlayerId, tierFilter, statusFilter, minMatches, period, setPeriod, currentUserId, showEmptySlots } = useAppStore();
  const sorted = useMemo(() => getSortedPlayers(players, activeMode, sortHighFirst, searchQuery, { tierFilter, statusFilter }), [players, activeMode, sortHighFirst, searchQuery, tierFilter, statusFilter]);

  // W2-T5: 时效切换 — URL query ?period=week|season|all 持久化
  useEffect(() => {
    // 挂载时读 URL query 初始化 period
    const params = new URLSearchParams(window.location.search);
    const p = params.get('period');
    if (p === 'week' || p === 'season' || p === 'all') {
      if (p !== period) setPeriod(p);
    }
  }, []);
  useEffect(() => {
    // period 变化时同步 URL query（不触发导航）
    const url = new URL(window.location.href);
    if (period === 'all') url.searchParams.delete('period');
    else url.searchParams.set('period', period);
    window.history.replaceState(null, '', url.toString());
  }, [period]);

  // W2-T4: 参评资格分流 — EMOTION 感动榜不受门槛影响（保护约束），全部进主列表
  const isEmotionBoard = activeMode === 'EMOTION';
  const { eligible, ineligible } = useMemo(() => {
    if (isEmotionBoard) return { eligible: sorted, ineligible: [] };
    const el = sorted.filter(p => isEligible(p, minMatches));
    const inel = sorted.filter(p => !isEligible(p, minMatches));
    return { eligible: el, ineligible: inel };
  }, [sorted, minMatches, isEmotionBoard]);

  // 未参评折叠区展开状态
  const [showIneligible, setShowIneligible] = useState(false);

  // 2026-10 重构：移除 modeRanks（9 模式排名图）——卡片不再显示段位带，
  // 完整 Mode Tier Matrix 在详情弹窗。省去 9×N 排序计算，列表更快。
  // 2026-10 并列规则：当前榜单（activeMode）全列表的并列感知排名。
  // 同积分玩家同名次（并列第一），排序先后由 getSortedPlayers 破平键决定
  // （战绩评分 desc → 名字字母序）。
  const rankById = useMemo(() => {
    const ranks = computeTieRanks(sorted, p => getPlayerBoardScore(p, activeMode));
    const map = new Map<string, number>();
    sorted.forEach((p, i) => map.set(p.id, ranks[i]));
    return map;
  }, [sorted, activeMode]);
  const rankOf = useCallback((id: string) => rankById.get(id) ?? 0, [rankById]);
  const eligibleRanks = useMemo(() => eligible.map(p => rankOf(p.id)), [eligible, rankOf]);

  // CG-1 · 定位到我（Trophy UI current-user-focus 轻量借鉴，MIT）
  // 当前用户在主列表区（#4 起，前三名领奖台常驻可见）时显示 sticky chip。
  const meRow = useMemo(
    () => (currentUserId ? eligible.slice(3).find(p => p.id === currentUserId) ?? null : null),
    [eligible, currentUserId],
  );
  const locateMe = useCallback(() => {
    if (!currentUserId) return;
    const esc = CSS.escape(currentUserId);
    const row = document.getElementById(`player-${esc}`);
    if (row) { locateAndFlash(row); return; }
    // 目标行可能在折叠的并列抽屉内（DOM 不存在）→ 按排名展开抽屉后再定位
    const header = document.querySelector(`[data-tie-rank="${rankOf(currentUserId)}"]`) as HTMLElement | null;
    if (!header) return;
    header.click();
    window.setTimeout(() => {
      const r = document.getElementById(`player-${esc}`);
      if (r) locateAndFlash(r);
    }, 280);
  }, [currentUserId, rankOf]);

  // SA-09 无障碍：Flip 重排后焦点恢复——键盘用户排序/切榜后不丢焦点
  // framer-motion layout 保留 DOM 节点（key=player.id），焦点通常自然保留；
  // 但被聚焦的玩家若滚出可视列表/被过滤，焦点会丢——此时恢复到列表首行。
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusedPlayerId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // 重排后：若之前聚焦的玩家仍在列表，聚焦其新位置；否则聚焦首行
    const prevId = focusedPlayerId.current;
    if (prevId) {
      const target = el.querySelector(`#player-${CSS.escape(prevId)}`) as HTMLElement | null;
      if (target) { target.focus({ preventScroll: true }); return; }
    }
    // 焦点丢失 → 首行（仅当列表内原本有焦点时才抢，避免页面滚动到此）
    if (document.activeElement && el.contains(document.activeElement)) {
      const first = el.querySelector('[id^="player-"]') as HTMLElement | null;
      first?.focus({ preventScroll: true });
    }
  }, [rankById]);
  const onFocusIn = useCallback((e: ReactFocusEvent) => {
    const target = (e.target as HTMLElement).closest('[id^="player-"]') as HTMLElement | null;
    focusedPlayerId.current = target?.id.replace('player-', '') ?? null;
  }, []);

  // 并列抽屉分组：PodiumStrip 占前 3 位，列表区从第 4 位起；
  // 对 eligible.slice(3) 按密集排名分组，3+ 人同排名 → 抽屉行。
  const listItems = useMemo(
    () => groupByTies(eligible.slice(3), rankOf),
    [eligible, rankOf],
  );

  // AU 审计修复（2026-11）：「显示空位」此前是死按钮（store 有态、无渲染消费方）。
  // 现补齐：开启后榜单补齐到至少 10 个席位，空席渲染为幽灵行（虚线框 +
  // 虚位以待），传达「俱乐部榜单常设 10 席、冲榜即占」的叙事。
  // 仅在无搜索/筛选收窄时展示（搜索结果里补空位是噪声）。
  const EMPTY_BOARD_MIN = 10;
  const emptySlotCount = useMemo(
    () => (showEmptySlots && !searchQuery && !tierFilter ? Math.max(0, EMPTY_BOARD_MIN - eligible.length) : 0),
    [showEmptySlots, searchQuery, tierFilter, eligible.length],
  );

  // SA-09 无障碍：aria-live 区域广播排名变化（屏幕阅读器用户感知重排）
  // 用「render 期 adjust state on change」模式（React 官方推荐）而非 useEffect setState
  // （React 19 react-hooks/set-state-in-effect 规则禁用 effect 内 setState）
  const [rankAnnounce, setRankAnnounce] = useState('');
  const [prevTopKey, setPrevTopKey] = useState<string | null>(null);
  const topKey = eligible[0] ? `${eligible[0].id}:${rankOf(eligible[0].id)}` : '';
  if (topKey !== prevTopKey) {
    setPrevTopKey(topKey);
    if (prevTopKey !== null && eligible[0]) {
      setRankAnnounce(`排名更新：${eligible[0].name} 升至第 ${rankOf(eligible[0].id)} 名`);
    }
  }

  const handleLike = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/v1/players/${id}/like`, { method: 'POST' });
      if (res.ok) {
        const { likes } = await res.json();
        // V6: mark as self-initiated BEFORE the socket echo comes back,
        // so triggerLiveLike won't double-increment (echo guard)
        useAppStore.getState().markSelfLike(id);
        useAppStore.setState(s => ({
          players: s.players.map(p => p.id === id ? { ...p, likes } : p),
        }));
        // Broadcast to other clients via LIVE socket (M4)
        window.dispatchEvent(new CustomEvent('goatb:live-emit', { detail: { type: 'like', payload: id } }));
      }
    } catch {}
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedPlayerId(id);
  }, [setSelectedPlayerId]);

  return (
    <div className="px-4 lg:px-3 mb-4">
      {/* SA-09 无障碍：sr-only aria-live 区域，屏幕阅读器广播排名变化 */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{rankAnnounce}</div>
      {/* List header — W2-T6: 计数文案「有效参评 N · 未认证 M」 + W2-T5: 时效切换 */}
      <div className="flex items-center justify-between mb-2.5 px-1 gap-2">
        <span className="text-xs text-white/60 number-score tracking-wider uppercase flex items-center gap-2 min-w-0">
          {isEmotionBoard ? (
            <span>{sorted.length} Players</span>
          ) : (
            <>
              <span>有效参评 <b className="text-white/80">{eligible.length}</b></span>
              {ineligible.length > 0 && (
                <span className="text-white/35">· 未认证 {ineligible.length}</span>
              )}
            </>
          )}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* W2-T5: 时效切换控件（感动榜不显示）*/}
          {!isEmotionBoard && (
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]" role="group" aria-label="时效切换">
              {(['all', 'week', 'season'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors',
                    period === p
                      ? 'bg-jade-500/20 text-jade-200'
                      : 'text-white/45 hover:text-white/70'
                  )}
                  aria-pressed={period === p}
                >
                  {p === 'all' ? '历史' : p === 'week' ? '本周' : '本赛季'}
                </button>
              ))}
            </div>
          )}
          {activeMode !== 'EMOTION' && (
            <span className="text-xs text-white/70 flex items-center gap-1">
              <McIcon src={activeMode === 'TOTAL' ? MC_ICONS.TOTAL : (BOARD_TABS.find(t => t.key === activeMode)?.icon || MC_ICONS.TOTAL)} className="w-3.5 h-3.5" />
              <span>{activeMode === 'TOTAL' ? '总榜' : MODE_LABELS[activeMode as GameMode]}</span>
            </span>
          )}
        </div>
      </div>

      {/* W2-T5: week/season 档无快照时的诚实提示 */}
      {!isEmotionBoard && period !== 'all' && (
        <div className="mb-2 px-2 py-1 rounded-md bg-amber-500/[0.06] border border-amber-500/15 text-[10px] text-amber-200/60">
          {period === 'week' ? '本周' : '本赛季'}快照积累中，当前显示实时数据（快照系统每 6h 自动采集）
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] py-10 text-center flex flex-col items-center gap-2">
          <Search className="w-7 h-7 text-jade-400/35" aria-hidden="true" />
          <p className="text-sm text-white/55 font-medium">{searchQuery ? '没有找到匹配的玩家' : '暂无玩家'}</p>
          <p className="text-xs text-white/30">{searchQuery ? '试试其他关键词或清空筛选' : '玩家数据将在录入后展示'}</p>
        </div>
      ) : eligible.length === 0 && !isEmotionBoard ? (
        <div className="liquid-glass-subtle rounded-[var(--radius-liquid-md)] py-10 text-center flex flex-col items-center gap-2">
          <Shield className="w-7 h-7 text-jade-400/35" aria-hidden="true" />
          <p className="text-sm text-white/55 font-medium">当前模式暂无有效参评玩家</p>
          <p className="text-xs text-white/30">需 ≥{minMatches} 场对局自动参评</p>
        </div>
      ) : (
        <>
          {/* LGX · Podium Strip — top-3 honor band above the rows */}
          <PodiumStrip players={eligible} mode={activeMode} onSelect={handleSelect} onLike={handleLike} ranks={eligibleRanks} />

          {/* LGX · Ranking rows — #04 onward, dense 2-line rows.
             Mobile: natural page flow (no nested scroll trap).
             Desktop: capped height with its own scrollbar.
             并列抽屉：3+ 人同排名时折叠为单行抽屉，点击展开看全部。 */}
          <div ref={listRef} onFocus={onFocusIn} className="mt-2 space-y-1 sm:max-h-[620px] sm:overflow-y-auto custom-scrollbar sm:pr-1 sm:-mr-1">
            {/* CG-1 · 定位到我 chip — sticky 常驻（列表滚动区内跟随，移动端随页滚动）。
                点击滚动定位到当前用户行 + 金色脉冲；行在折叠并列抽屉内时先展开再定位；
                暂停动效时瞬时定位不加脉冲（locateAndFlash 内部降级）。 */}
            {meRow && (
              <div className="sticky top-[72px] z-20 flex justify-end pointer-events-none pr-0.5 sm:top-1.5">
                <motion.button
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={locateMe}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-jade-500/25 bg-[rgba(20,20,40,0.82)] px-2.5 py-1 text-[10px] font-medium text-jade-200 backdrop-blur-md transition-colors hover:border-jade-400/45 hover:text-jade-100 spring-press-subtle"
                  aria-label={`定位到我的排名：第 ${rankOf(meRow.id)} 名`}
                >
                  <LocateFixed className="h-3 w-3" aria-hidden="true" />
                  <span>定位到我 · #{rankOf(meRow.id)}</span>
                </motion.button>
              </div>
            )}
            <AnimatePresence mode="popLayout">
              {listItems.map((item) =>
                item.kind === 'single' ? (
                  <motion.div
                    key={item.key}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{
                      /* Re-rank FLIP: transform-only, fast settle — rows
                         glide in one ~200ms wave. Opacity-only mount, no
                         per-row stagger (12 rows × stagger = jank). */
                      layout: { type: 'spring', stiffness: 480, damping: 42, mass: 0.8 },
                      opacity: { duration: 0.18 },
                      scale: { duration: 0.16 },
                    }}
                  >
                    <PlayerCard
                      player={item.player}
                      rank={rankOf(item.player.id)}
                      mode={activeMode}
                      onSelect={handleSelect}
                      onLike={handleLike}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key={item.key}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{
                      layout: { type: 'spring', stiffness: 480, damping: 42, mass: 0.8 },
                      opacity: { duration: 0.18 },
                      scale: { duration: 0.16 },
                    }}
                  >
                    <TieDrawerRow
                      rank={rankOf(item.players[0].id)}
                      players={item.players}
                      mode={activeMode}
                      onSelect={handleSelect}
                      onLike={handleLike}
                      rankOf={rankOf}
                    />
                  </motion.div>
                ),
              )}
            </AnimatePresence>
            {/* AU 审计修复：空位幽灵行（showEmptySlots）—— 补齐到 10 席 */}
            {emptySlotCount > 0 && (
              <>
                {Array.from({ length: emptySlotCount }, (_, i) => eligible.length + i + 1).map((slotRank) => (
                  <div
                    key={`empty-slot-${slotRank}`}
                    className="lgx-row lgx-row-empty"
                    aria-hidden="true"
                  >
                    <div className="lgx-row-main">
                      <span className="lgx-rank number-score">{slotRank}</span>
                      <span className="flex-1 min-w-0 text-[11px] text-white/25 tracking-widest select-none">
                        虚位以待 · 冲榜即占
                      </span>
                      <span className="text-[9px] text-white/15 number-score">—</span>
                    </div>
                  </div>
                ))}
                <p className="sr-only">当前 {eligible.length} 名玩家上榜，榜单常设 {EMPTY_BOARD_MIN} 席。</p>
              </>
            )}
          </div>

          {/* W2-T4 · 未参评折叠区 — 0W0L 玩家，opacity .45 + 待认证标签，不可点进详情 */}
          {ineligible.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setShowIneligible(s => !s)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg liquid-glass-subtle text-xs text-white/55 hover:text-white/75 transition-colors"
                aria-expanded={showIneligible}
              >
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true">{showIneligible ? '▾' : '▸'}</span>
                  未认证玩家 ({ineligible.length})
                </span>
                <span className="text-white/30">待 ≥{minMatches} 场自动参评</span>
              </button>
              <AnimatePresence>
                {showIneligible && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1 mt-1.5">
                      {ineligible.map((player, index) => (
                        <PlayerCard
                          key={player.id}
                          player={player}
                          rank={rankOf(player.id)}
                          mode={activeMode}
                          onSelect={handleSelect}
                          onLike={handleLike}
                          ineligible
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </div>
  );
}
