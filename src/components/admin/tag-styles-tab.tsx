'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L2327-L2555），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：玩家个性标签样式编辑器页签。
// ============================================================
import { useState, useCallback, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Search, Save, RotateCcw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { TierBadge } from '@/components/tier-badge';
import {
  TAG_BG_EFFECTS, TAG_TEXT_EFFECTS, DEFAULT_TAG_STYLE,
  parseTagStyles, serializeTagStyles, type TagStyle,
} from '@/lib/tag-styles';
import { ConfirmDialog } from './shared';

// --- Admin: Player Tag Styles（玩家个性标签样式编辑器）---
// 管理员可为每位玩家定制段位徽章的背景光效、文字光效与文字颜色。
// 数据存于 Config.player_tag_styles（JSON），复用 /api/v1/config GET/PUT；
// 保存后 config 路由自动 bustPlayerCaches，榜单即时刷新。
// 实时预览：draft 变更即时反映在 TierBadge 上（三尺寸同屏对比）。
export function AdminTagStyles() {
  const { players } = useAppStore();
  const [styles, setStyles] = useState<Record<string, TagStyle>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TagStyle>(DEFAULT_TAG_STYLE);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetAllOpen, setResetAllOpen] = useState(false);

  const loadStyles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/config?key=player_tag_styles');
      const data = await res.json();
      setStyles(parseTagStyles(data.value));
    } catch {
      toast({ title: '加载失败', description: '无法读取标签样式', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStyles(); }, [loadStyles]);

  // 选中玩家时载入其现有样式到 draft（不依赖 styles，避免保存后 draft 被重置）
  useEffect(() => {
    if (!selectedId) return;
    setDraft(styles[selectedId] ?? DEFAULT_TAG_STYLE);
  }, [selectedId]);

  const selectedPlayer = players.find(p => p.id === selectedId) ?? null;
  const previewTier = selectedPlayer ? (Object.values(selectedPlayer.tiers)[0] || 'HT1') : 'HT1';

  const filteredPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players.filter(p => !q || p.name.toLowerCase().includes(q)).slice(0, 50);
  }, [players, search]);

  const dirty = useMemo(() => {
    if (!selectedId) return false;
    const cur = styles[selectedId];
    const isDefault = draft.bgEffect === 'none' && draft.textEffect === 'none' && draft.textColor === '';
    if (!cur) return !isDefault;
    return cur.bgEffect !== draft.bgEffect || cur.textEffect !== draft.textEffect || cur.textColor !== draft.textColor;
  }, [selectedId, styles, draft]);

  const persist = useCallback(async (next: Record<string, TagStyle>) => {
    setSaving(true);
    try {
      const res = await adminFetch('/api/v1/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'player_tag_styles', value: serializeTagStyles(next) }),
      });
      if (res.ok) { setStyles(next); return true; }
      toast({ title: '保存失败', description: '服务器拒绝写入', variant: 'destructive' });
      return false;
    } catch {
      toast({ title: '保存失败', description: '网络错误', variant: 'destructive' });
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = async () => {
    if (!selectedId) return;
    const isDefault = draft.bgEffect === 'none' && draft.textEffect === 'none' && draft.textColor === '';
    const next = { ...styles };
    if (isDefault) delete next[selectedId]; else next[selectedId] = draft;
    if (await persist(next)) {
      toast({ title: '已保存生效', description: `${selectedPlayer?.name} 的个性标签已应用，榜单即时刷新` });
    }
  };

  const handleResetOne = async () => {
    if (!selectedId) return;
    const next = { ...styles };
    delete next[selectedId];
    setDraft(DEFAULT_TAG_STYLE);
    if (await persist(next)) {
      toast({ title: '已恢复默认', description: `${selectedPlayer?.name} 的标签样式已重置` });
    }
  };

  const handleResetAll = async () => {
    setResetAllOpen(false);
    setDraft(DEFAULT_TAG_STYLE);
    if (await persist({})) {
      toast({ title: '已恢复全部默认', description: '所有玩家的个性标签样式已清除' });
    }
  };

  const styledCount = Object.keys(styles).length;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-secondary-foreground flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-jade-400" /> 玩家个性标签样式
      </h3>
      <p className="text-xs text-muted-foreground">
        为玩家定制段位徽章的背景光效、文字光效与文字颜色。彩虹文字为专属独特样式，带循环扫光动效。已定制 <b className="text-jade-400">{styledCount}</b> 位玩家。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 左：玩家选择列表 */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索玩家名字…" className="pl-7 h-8 text-xs" />
          </div>
          <div className="border border-white/10 rounded-lg max-h-64 overflow-y-auto custom-scrollbar">
            {loading ? (
              <div className="p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…</div>
            ) : filteredPlayers.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground text-center">暂无玩家。请先在「玩家管理」添加。</div>
            ) : filteredPlayers.map(p => {
              const firstTier = Object.values(p.tiers)[0];
              return (
                <button key={p.id} onClick={() => setSelectedId(p.id)}
                  className={cn('w-full px-3 py-2 flex items-center justify-between gap-2 text-left text-xs transition-colors border-b border-white/5 last:border-0',
                    selectedId === p.id ? 'bg-jade-500/15 text-jade-400' : 'hover:bg-white/5 text-muted-foreground')}>
                  <span className="truncate">{p.name}</span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    {firstTier && <TierBadge tier={firstTier} size="sm" tagStyle={styles[p.id] ?? null} />}
                    {styles[p.id] && <span className="w-1.5 h-1.5 rounded-full bg-jade-400" title="已定制" />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 右：编辑器 + 实时预览 */}
        <div className="space-y-3">
          {!selectedPlayer ? (
            <div className="border border-dashed border-white/10 rounded-lg p-6 text-center text-xs text-muted-foreground">
              ← 从左侧选择一位玩家开始编辑
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-white/10 bg-black/20 p-4 flex flex-col items-center gap-2">
                <div className="text-[10px] text-muted-foreground tracking-wider uppercase">实时预览</div>
                <div className="flex items-center gap-2 py-2">
                  <TierBadge tier={previewTier} size="lg" tagStyle={draft} />
                  <TierBadge tier={previewTier} size="md" tagStyle={draft} />
                  <TierBadge tier={previewTier} size="sm" tagStyle={draft} />
                </div>
                <div className="text-[10px] text-muted-foreground">{selectedPlayer.name} · {previewTier}</div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">背景光效</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {TAG_BG_EFFECTS.map(e => (
                    <button key={e.value} onClick={() => setDraft(d => ({ ...d, bgEffect: e.value }))} title={e.desc}
                      className={cn('px-2 py-1.5 rounded-lg text-[11px] border transition-all',
                        draft.bgEffect === e.value ? 'border-jade-500/60 bg-jade-500/15 text-jade-400' : 'border-white/10 text-muted-foreground hover:bg-white/5')}>
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">文字光效</div>
                <div className="grid grid-cols-1 gap-1.5">
                  {TAG_TEXT_EFFECTS.map(e => (
                    <button key={e.value} onClick={() => setDraft(d => ({ ...d, textEffect: e.value }))} title={e.desc}
                      className={cn('px-2 py-1.5 rounded-lg text-[11px] border transition-all text-left',
                        draft.textEffect === e.value ? 'border-jade-500/60 bg-jade-500/15 text-jade-400' : 'border-white/10 text-muted-foreground hover:bg-white/5')}>
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground mb-1">文字颜色（任意自定义{draft.textEffect !== 'none' ? '·当前被文字光效覆盖' : ''}）</div>
                <div className="flex items-center gap-2">
                  <input type="color" value={draft.textColor || '#ffffff'} onChange={e => setDraft(d => ({ ...d, textColor: e.target.value }))}
                    className="w-9 h-9 rounded-lg border border-white/10 bg-transparent cursor-pointer" aria-label="选择文字颜色" />
                  <Input value={draft.textColor} onChange={e => setDraft(d => ({ ...d, textColor: e.target.value }))}
                    placeholder="#ffffff 或留空用段位默认色" className="h-9 text-xs flex-1" />
                  <button onClick={() => setDraft(d => ({ ...d, textColor: '' }))}
                    className="px-2 h-9 rounded-lg border border-white/10 text-[11px] text-muted-foreground hover:text-white hover:bg-white/5">清除</button>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <motion.button onClick={handleSave} disabled={!dirty || saving}
                  className={cn('spring-press flex-1 px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5',
                    dirty && !saving ? 'bg-jade-500/20 text-jade-400 border border-jade-500/40' : 'border border-white/10 text-muted-foreground opacity-60')}>
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 保存生效
                </motion.button>
                <button onClick={handleResetOne} disabled={saving}
                  className="px-3 py-2 rounded-lg text-xs border border-white/10 text-muted-foreground hover:text-white hover:bg-white/5 flex items-center gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" /> 恢复默认
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-white/5 flex justify-end">
        <button onClick={() => setResetAllOpen(true)} disabled={saving || styledCount === 0}
          className="text-[11px] text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-40">
          恢复全部玩家默认样式
        </button>
      </div>

      <ConfirmDialog
        open={resetAllOpen}
        onOpenChange={setResetAllOpen}
        title="恢复全部玩家默认样式？"
        description="将清除所有玩家的个性标签样式设置，可通过重新编辑恢复。"
        confirmLabel="确认恢复全部"
        onConfirm={handleResetAll}
      />
    </div>
  );
}
