'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L839-L1090），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：玩家编辑表单（PlayerEditPanel，唯一使用者是本文件抽屉）+ 编辑抽屉
// （PlayerEditDrawer，由 page.tsx 独立 dynamic 引用，经 admin-panel.tsx 壳 re-export 保持导出面不变）。
// ============================================================
import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, Loader2, X } from 'lucide-react';
import { useAppStore, type PlayerData } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import {
  ALL_MODES, MODE_LABELS, MODE_ICONS, TIER_COLORS, TIER_BG_COLORS,
  calcKD, calcWinRate, getTiersForMode,
  type GameMode, type PlayerStats,
} from '@/lib/constants';
import { getPlayerTotalScore } from '@/lib/scoring';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';
import { fetchNormalizedPlayers } from '@/lib/api';
import { McIcon } from '@/components/mc-icon';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';

// --- Player Edit Panel ---
export function PlayerEditPanel({ player, onSaved }: { player: PlayerData; onSaved: (response?: Response) => void }) {
  const [editMode, setEditMode] = useState<GameMode>('SHIELD');
  const [tiers, setTiers] = useState(player.tiers);
  const [overrideScore, setOverrideScore] = useState<string>(() => {
    const ov = player.overrideScores?.['SHIELD'];
    return ov !== null && ov !== undefined ? String(ov) : '';
  });
  const [stats, setStats] = useState<PlayerStats>(player.stats?.['SHIELD'] || { kills: 0, deaths: 0, wins: 0, matches: 0 });
  const [avatarUrl, setAvatarUrl] = useState(player.avatarUrl || '');
  // P2-1: 保存 loading 态（此前连点无防抖无反馈）
  const [saving, setSaving] = useState(false);

  const handleEditModeChange = (mode: GameMode) => {
    setEditMode(mode);
    setStats(player.stats?.[mode] || { kills: 0, deaths: 0, wins: 0, matches: 0 });
    const ov = player.overrideScores?.[mode];
    setOverrideScore(ov !== null && ov !== undefined ? String(ov) : '');
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const newOverrideScores = { ...player.overrideScores };
      if (overrideScore.trim()) {
        newOverrideScores[editMode] = parseInt(overrideScore);
      } else {
        newOverrideScores[editMode] = null;
      }
      const newStats = { ...player.stats };
      newStats[editMode] = stats;

      const res = await adminFetch(`/api/v1/players/${player.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatarUrl: avatarUrl || null,
          tiers,
          overrideScores: newOverrideScores,
          stats: newStats,
        }),
      });
      onSaved(res);
    } finally {
      setSaving(false);
    }
  };

  const validTiers = getTiersForMode(editMode);

  return (
    <>
    <div className="divider-refined" />
    <div className="p-3 space-y-3">
      {/* Avatar */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label htmlFor="edit-avatar-url" className="text-xs text-muted-foreground">头像URL</label>
          <Input
            id="edit-avatar-url"
            value={avatarUrl}
            onChange={e => setAvatarUrl(e.target.value)}
            className="w-full mt-1 h-8 rounded-lg bg-white/5 border-white/10 text-sm text-white"
          />
        </div>
      </div>

      {/* Mode select */}
      <div>
        <div className="text-xs text-muted-foreground">模式</div>
        <div role="group" aria-label="选择模式" className="flex flex-wrap gap-1 mt-1">
          {ALL_MODES.map(m => (
            <button key={m} onClick={() => handleEditModeChange(m)} className={`spring-press px-2 py-1 rounded-lg text-xs ${editMode === m ? 'bg-jade-500/15 text-jade-400' : 'text-muted-foreground hover:bg-white/5'}`}>
              <McIcon src={MODE_ICONS[m]} className="w-3 h-3 inline-block align-middle" /> {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Tier select */}
      <div>
        <div className="text-xs text-muted-foreground">段位</div>
        <div role="group" aria-label="选择段位" className="flex flex-wrap gap-1 mt-1">
          {validTiers.map(t => (
            <button
              key={t}
              onClick={() => setTiers({ ...tiers, [editMode]: t })}
              className={`spring-press px-2 py-1 rounded-lg text-xs font-mono ${tiers[editMode] === t ? 'font-bold' : 'text-muted-foreground'}`}
              style={tiers[editMode] === t ? { background: TIER_BG_COLORS[t], color: TIER_COLORS[t] } : {}}
            >
              {t}
            </button>
          ))}
          <button onClick={() => { const nt = { ...tiers }; delete nt[editMode]; setTiers(nt); }} aria-label="清除段位" className="spring-press px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-[#e74c3c]">清除</button>
        </div>
      </div>

      {/* Override score */}
      <div>
        <label htmlFor="edit-override-score" className="text-xs text-muted-foreground">覆盖分数（留空使用段位分数）</label>
        <Input
          id="edit-override-score"
          value={overrideScore}
          onChange={e => setOverrideScore(e.target.value)}
          type="number"
          className="w-full mt-1 h-8 rounded-lg bg-white/5 border-white/10 text-sm text-white"
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2">
        {(['kills', 'deaths', 'wins', 'matches'] as const).map(key => (
          <div key={key}>
            <label htmlFor={`edit-stat-${key}`} className="text-xs text-muted-foreground">{key === 'kills' ? '击杀' : key === 'deaths' ? '死亡' : key === 'wins' ? '胜利' : '场次'}</label>
            <Input
              id={`edit-stat-${key}`}
              value={stats[key]}
              onChange={e => setStats({ ...stats, [key]: parseInt(e.target.value) || 0 })}
              type="number"
              className="w-full mt-1 h-8 px-2 rounded-lg bg-white/5 border-white/10 text-sm text-white"
            />
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-xs">
        <span className="text-[#5ce6e6]">K/D: {calcKD(stats)}</span>
        <span className="text-secondary-foreground">胜率: {calcWinRate(stats)}</span>
      </div>

      <motion.button
        onClick={save}
        disabled={saving}
        className="spring-press w-full py-2 rounded-xl bg-jade-500 text-jade-900 font-semibold text-sm disabled:opacity-50 flex items-center justify-center"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 inline mr-1" />}
        {saving ? '保存中...' : '保存修改'}
      </motion.button>
    </div>
    </>
  );
}

// ============================================================
// Player Edit Drawer — right-slide-in panel for editing a player.
// Reads editingPlayerId from store, reuses PlayerEditPanel content.
// P2-1: 手写 framer-motion 抽屉 → shadcn Sheet —— 免费获得焦点陷阱、
// body 滚动锁、Escape 关闭与 aria 标注（此前均缺失）。
// 关闭逻辑（backdrop 点击/Escape/保存完成）由 Sheet onOpenChange 统一接管。
// ============================================================
export function PlayerEditDrawer() {
  const { editingPlayerId, setEditingPlayerId, players, setPlayers } = useAppStore();
  const player = players.find(p => p.id === editingPlayerId);
  const open = !!editingPlayerId && !!player;
  const [undoLogId, setUndoLogId] = useState<string | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshPlayers = useCallback(async () => {
    setPlayers(await fetchNormalizedPlayers({ fresh: true }));
  }, [setPlayers]);

  // Cleanup undo timer on unmount
  useEffect(() => {
    return () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); };
  }, []);

  const handleSaved = async (response?: Response) => {
    await refreshPlayers();
    // Extract logId for undo
    try {
      const data = response ? await response.json() : null;
      if (data?.logId) {
        setUndoLogId(data.logId);
        // Auto-hide undo prompt after 6 seconds
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        undoTimerRef.current = setTimeout(() => setUndoLogId(null), 6000);
      }
    } catch { /* response already consumed */ }
  };

  const undo = async () => {
    if (!undoLogId) return;
    try {
      const res = await adminFetch(`/api/v1/undo?logId=${undoLogId}`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setUndoLogId(null);
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        await refreshPlayers();
        setEditingPlayerId(null);
      }
    } catch { /* network error — keep prompt */ }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={o => { if (!o) setEditingPlayerId(null); }}>
        <SheetContent
          side="right"
          className="z-[200] w-full max-w-md sm:max-w-md liquid-glass-strong border-white/10 overflow-y-auto custom-scrollbar p-0"
        >
          {player && (
            <>
              <SheetHeader className="sticky top-0 z-10 liquid-glass-strong px-4 py-3 flex flex-row items-center gap-2.5 border-b border-white/8 space-y-0 text-left">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: getAvatarColor(player.name) }}>
                  {getAvatarInitial(player.name)}
                </div>
                <div className="min-w-0 flex-1 pr-8">
                  {/* pr-8 避让 Sheet 内建右上角关闭按钮 */}
                  <SheetTitle className="text-sm font-bold text-white truncate">编辑 · {player.name}</SheetTitle>
                  <SheetDescription className="text-[10px] text-muted-foreground">
                    总分 {getPlayerTotalScore(player).toLocaleString()}
                  </SheetDescription>
                </div>
              </SheetHeader>

              {/* Edit form (reuses PlayerEditPanel, pass response for undo) */}
              <PlayerEditPanel player={player} onSaved={handleSaved} />
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Undo toast — shows for 6s after save（置于 Sheet 外避免 transform 包含块）*/}
      <AnimatePresence>
        {undoLogId && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[210] liquid-glass-strong rounded-full px-4 py-2.5 flex items-center gap-3 shadow-xl"
          >
            <span className="text-xs text-white/80">已保存修改</span>
            <button
              onClick={undo}
              className="text-xs font-bold text-jade-400 hover:text-jade-300 transition-colors px-2 py-1 rounded-full bg-jade-500/10"
            >
              撤销
            </button>
            <button
              onClick={() => setUndoLogId(null)}
              aria-label="关闭提示"
              className="text-muted-foreground hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
