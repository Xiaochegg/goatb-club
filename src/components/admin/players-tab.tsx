'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L419-L837），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：玩家管理页签（列表/搜索/批量操作/导入）。
// ============================================================
import React, { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, RefreshCw, Plus, ChevronUp, ChevronDown,
  Eye, Trash2, Loader2, Settings, KeyRound,
} from 'lucide-react';
import { useAppStore, type PlayerData } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { ALL_MODES, MODE_LABELS, type GameMode } from '@/lib/constants';
import { getPlayerTotalScore } from '@/lib/scoring';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';
import { fetchNormalizedPlayers } from '@/lib/api';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { CONFIRM_PANEL, ConfirmDialog } from './shared';
import { AdminPasswordResetDialog } from './password-reset-dialog';

// Memoized player row — only re-renders when THIS row's selection state or
// player data changes. Previously every checkbox toggle re-rendered ALL N
// rows (O(N) per click) causing lag with many players. Now: O(1) per click.
// Row receives `isSelected` boolean (not the whole Set) so identity is stable
// across unrelated selection changes.
// P2-1: 原生 checkbox → shadcn Checkbox；手写 ⋯ 菜单（window click 监听
// 关闭、无键盘/焦点/Escape 支持）→ shadcn DropdownMenu；onDelete 改为
// 弹出受控 ConfirmDialog 二次确认（此前单行删除零确认）。
const PlayerManageRow = React.memo(function PlayerManageRow({
  player, isSelected, onToggleSelect, onView, onEdit, onDelete, onPasswordReset,
}: {
  player: PlayerData;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onPasswordReset: (player: PlayerData) => void;
}) {
  return (
    <div className="bg-card border border-white/7 rounded-xl overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelect(player.id)}
          className="flex-shrink-0"
          aria-label={`选中 ${player.name}`}
        />
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: getAvatarColor(player.name) }}>
          {getAvatarInitial(player.name)}
        </div>
        <span className="text-sm font-medium text-white flex-1 truncate">{player.name}</span>
        <span className="text-xs text-jade-400 font-mono number-score flex-shrink-0">{getPlayerTotalScore(player).toLocaleString()}</span>
        {/* Quick actions — shadcn DropdownMenu（键盘/焦点/Escape 免费，自管开关态）*/}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="快速操作"
              className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-muted-foreground hover:text-white hover:bg-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Settings className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40 z-[200] liquid-glass-strong border-white/10 rounded-xl">
            <DropdownMenuItem onClick={() => onView(player.id)} className="gap-2 text-xs text-white/80">
              <Eye className="w-3.5 h-3.5" /> 查看详情
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(player.id)} className="gap-2 text-xs text-white/80">
              <Settings className="w-3.5 h-3.5" /> 编辑玩家
            </DropdownMenuItem>
            {/* AUTH V2.0 PHASE 3：密码重置协助（重置密码/禁用/恢复，工单二） */}
            <DropdownMenuItem onClick={() => onPasswordReset(player)} className="gap-2 text-xs text-white/80">
              <KeyRound className="w-3.5 h-3.5" /> 密码重置协助
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDelete(player.id)}
              className="gap-2 text-xs text-[var(--system-red)] focus:bg-red-500/10 focus:text-[var(--system-red)]"
            >
              <Trash2 className="w-3.5 h-3.5" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

export function AdminPlayerManage() {
  const { players, setPlayers, setSelectedPlayerId, setEditingPlayerId } = useAppStore();
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [importMode, setImportMode] = useState<GameMode>('SHIELD');
  const [importJson, setImportJson] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  // P2-1 反馈补齐：单行删除二次确认 / 一键重算与创建的 loading 态
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [recalcing, setRecalcing] = useState(false);
  const [creating, setCreating] = useState(false);
  // AUTH V2.0 PHASE 3：密码重置协助弹窗目标（工单二）
  const [resetTarget, setResetTarget] = useState<PlayerData | null>(null);

  // PHASE 3：搜索维度扩展——游戏ID + 邮箱（工单二「按邮箱搜索用户」；
  // email 仅为管理员视角数据，匿名视角无此字段）
  const filtered = useMemo(() => {
    if (!search) return players;
    const q = search.toLowerCase();
    return players.filter(p =>
      p.name.includes(search) || (p.email ? p.email.toLowerCase().includes(q) : false)
    );
  }, [players, search]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allFilteredSelected = useMemo(
    () => filtered.length > 0 && filtered.every(p => selectedIds.has(p.id)),
    [filtered, selectedIds],
  );
  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (filtered.length > 0 && filtered.every(p => next.has(p.id))) {
        filtered.forEach(p => next.delete(p.id));
      } else {
        filtered.forEach(p => next.add(p.id));
      }
      return next;
    });
  }, [filtered]);

  const refreshPlayers = useCallback(async () => {
    setPlayers(await fetchNormalizedPlayers({ fresh: true }));
  }, [setPlayers]);

  const createPlayer = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await adminFetch('/api/v1/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        toast({ title: `已添加 ${newName.trim()}` });
        setNewName('');
        await refreshPlayers();
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: '添加失败', description: data.error || '未知错误', variant: 'destructive' });
      }
    } catch {
      toast({ title: '添加失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  // P2-1: 单行删除改为先弹受控 ConfirmDialog（此前零确认直接删）
  const requestDelete = useCallback((id: string) => {
    const target = players.find(p => p.id === id);
    if (target) setConfirmDelete({ id, name: target.name });
  }, [players]);

  const deletePlayer = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const res = await adminFetch(`/api/v1/players/${confirmDelete.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ title: '删除失败', description: data.error || '未知错误', variant: 'destructive' });
        return;
      }
      toast({ title: `已删除 ${confirmDelete.name}` });
      await refreshPlayers();
    } catch {
      toast({ title: '删除失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  // Stable row action callbacks — keep identity constant across re-renders
  // so React.memo on PlayerManageRow stays effective during selection churn.
  const handleView = useCallback((id: string) => {
    setSelectedPlayerId(id);
  }, [setSelectedPlayerId]);
  const handleEdit = useCallback((id: string) => {
    setEditingPlayerId(id);
  }, [setEditingPlayerId]);

  // P2-1: window.confirm → AlertDialog 触发；删除逻辑拆出为纯执行函数
  const doBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBatchDeleting(true);
    try {
      const res = await adminFetch('/api/v1/players/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: '批量删除失败', description: data.error || '未知错误', variant: 'destructive' });
        return;
      }
      setSelectedIds(new Set());
      await refreshPlayers();
      toast({ title: `已删除 ${data.deleted} 个玩家` });
    } catch {
      toast({ title: '批量删除失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setBatchDeleting(false);
    }
  };

  // P2-1: JSON 解析错误与网络错误分离提示（此前混为同一个 alert）
  const handleImport = async () => {
    let data: unknown;
    try {
      data = JSON.parse(importJson);
    } catch {
      toast({ title: 'JSON 格式错误', description: '请检查粘贴的内容', variant: 'destructive' });
      return;
    }
    try {
      const res = await adminFetch('/api/v1/players/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: importMode, data }),
      });
      const result = await res.json();
      if (!res.ok) {
        toast({ title: '导入失败', description: result.error || '未知错误', variant: 'destructive' });
        return;
      }
      toast({ title: '导入完成', description: `创建 ${result.created} · 更新 ${result.updated} · 错误 ${result.errors}` });
      setImportJson('');
      setShowImport(false);
      await refreshPlayers();
    } catch {
      toast({ title: '导入失败', description: '网络错误', variant: 'destructive' });
    }
  };

  // P2-1 反馈补齐：一键重算此前完全静默（无 loading/无结果提示）
  const recalcAll = async () => {
    if (recalcing) return;
    setRecalcing(true);
    try {
      const res = await adminFetch('/api/v1/players/recalc', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ title: '重算失败', description: data.error || '请稍后重试', variant: 'destructive' });
        return;
      }
      await refreshPlayers();
      toast({ title: '重算完成', description: '已按当前段位与战绩重算全部评分' });
    } catch {
      toast({ title: '重算失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setRecalcing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索玩家"
            aria-label="搜索玩家"
            className="w-full pl-9 rounded-xl bg-white/5 border-white/10 text-white placeholder:text-muted-foreground/60"
          />
        </div>
        <motion.button onClick={refreshPlayers} aria-label="刷新玩家列表" className="spring-press px-3 py-2 rounded-xl border border-white/10 text-muted-foreground hover:text-white text-xs">
          <RefreshCw className="w-4 h-4" />
        </motion.button>
        <motion.button
          onClick={recalcAll}
          disabled={recalcing}
          className="spring-press px-3 py-2 rounded-xl border border-secondary-foreground/30 text-secondary-foreground text-xs font-medium disabled:opacity-50 flex items-center gap-1.5"
        >
          {recalcing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {recalcing ? '重算中...' : '一键重算'}
        </motion.button>
      </div>

      {/* Create */}
      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createPlayer()}
          placeholder="新玩家名称"
          aria-label="新玩家名称"
          className="flex-1 rounded-xl bg-white/5 border-white/10 text-white placeholder:text-muted-foreground/60"
        />
        <motion.button
          onClick={createPlayer}
          aria-label="添加玩家"
          disabled={creating}
          className="spring-press px-4 py-2 rounded-xl bg-jade-500 text-jade-900 font-medium text-sm disabled:opacity-50 flex items-center"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        </motion.button>
      </div>

      {/* Import */}
      <div>
        <button onClick={() => setShowImport(!showImport)} className="spring-press text-xs text-secondary-foreground flex items-center gap-1">
          {showImport ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          批量导入段位 JSON
        </button>
        <AnimatePresence>
          {showImport && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="mt-2 space-y-2">
                {/* P2-1: 原生 select → shadcn Select（键盘导航/主题样式统一）*/}
                <Select value={importMode} onValueChange={v => setImportMode(v as GameMode)}>
                  <SelectTrigger
                    aria-label="导入模式"
                    className="w-full rounded-xl bg-white/5 border-white/10 text-sm text-white focus-visible:ring-offset-background"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[200] liquid-glass-strong border-white/10">
                    {ALL_MODES.map(m => <SelectItem key={m} value={m}>{MODE_LABELS[m]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Textarea
                  value={importJson}
                  onChange={e => setImportJson(e.target.value)}
                  placeholder='[{"name":"玩家1","tier":"HT1"}]'
                  rows={4}
                  className="w-full rounded-xl bg-white/5 border-white/10 text-white placeholder:text-muted-foreground/60 font-mono text-sm"
                />
                <motion.button onClick={handleImport} className="spring-press px-4 py-2 rounded-xl bg-secondary-foreground text-[#0f0f1a] font-medium text-sm">
                  导入
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
          <span className="text-xs text-red-300 flex-1">已选 {selectedIds.size} 个玩家</span>
          <motion.button
            onClick={() => setSelectedIds(new Set())}
            className="spring-press px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-white border border-white/10"
            disabled={batchDeleting}
          >
            取消
          </motion.button>
          {/* P2-1: 批量删除二次确认弹层（触发器即删除按钮）*/}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <motion.button
                disabled={batchDeleting}
                className="spring-press px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center gap-1.5"
              >
                {batchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                批量删除 ({selectedIds.size})
              </motion.button>
            </AlertDialogTrigger>
            <AlertDialogContent className={CONFIRM_PANEL}>
              <AlertDialogHeader>
                <AlertDialogTitle>确认删除选中的 {selectedIds.size} 个玩家？</AlertDialogTitle>
                <AlertDialogDescription>
                  这些玩家的段位、战绩与评分将被永久移除，此操作不可撤销。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={batchDeleting}>取消</AlertDialogCancel>
                <AlertDialogAction
                  onClick={e => { e.preventDefault(); doBatchDelete(); }}
                  disabled={batchDeleting}
                  className="bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500"
                >
                  {batchDeleting && <Loader2 className="w-4 h-4 animate-spin" />}
                  确认删除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {/* Player List */}
      <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
        {/* Select-all header */}
        {filtered.length > 0 && (
          <label className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <Checkbox
              checked={allFilteredSelected}
              onCheckedChange={toggleSelectAll}
              className="flex-shrink-0"
              aria-label="全选"
            />
            {allFilteredSelected ? '取消全选' : `全选 (${filtered.length})`}
          </label>
        )}
        {filtered.map(player => (
          <PlayerManageRow
            key={player.id}
            player={player}
            isSelected={selectedIds.has(player.id)}
            onToggleSelect={toggleSelect}
            onView={handleView}
            onEdit={handleEdit}
            onDelete={requestDelete}
            onPasswordReset={setResetTarget}
          />
        ))}
        {/* P2-1: 搜索空态（此前无结果时静默空白）*/}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-6">
            {search ? `未找到匹配「${search}」的玩家` : '暂无玩家'}
          </p>
        )}
      </div>

      {/* P2-1: 单行删除二次确认（受控）*/}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={o => { if (!o) setConfirmDelete(null); }}
        title={`确认删除玩家 ${confirmDelete?.name ?? ''}？`}
        description="该玩家的段位、战绩与评分将被永久移除，此操作不可撤销。"
        confirmLabel="确认删除"
        onConfirm={deletePlayer}
        busy={deleting}
      />

      {/* AUTH V2.0 PHASE 3：密码重置协助弹窗（重置密码/禁用/恢复）；key 按 target.id
          重挂，保证每次打开均为干净初始态（含拉取 loading） */}
      <AdminPasswordResetDialog
        key={resetTarget?.id ?? 'none'}
        target={resetTarget}
        onClose={() => setResetTarget(null)}
      />
    </div>
  );
}
