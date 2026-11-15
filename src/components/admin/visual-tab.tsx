'use client';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — PLAYER VISUAL MANAGEMENT 分区
// （trace 1a1cfcfc32dceef1 批示「通过」2026-11-12）
// ------------------------------------------------------------
// 子页签：配置编辑（Player Selector + Visual Editor + Publish/Reset）
//        预设中心 / 版本历史与回滚 / 全局默认
// 权限呈现：VIEWER 只读（写按钮禁用；服务端 403 双保险）。
// 批量发布前显示受影响玩家数量；完成后显示真实成功/失败数量。
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { adminFetch } from '@/lib/admin-fetch';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  Search, Loader2, Rocket, RotateCcw, Trash2, Save, Layers, History, Globe, Users2,
} from 'lucide-react';
import { VisualEditor, emptyDraft } from './visual-editor';
import type { VisualConfig } from '@/lib/visual/types';

// ── overview 数据形 ──
interface PlayerRow {
  id: string; name: string; avatarUrl: string | null; updatedAt: string;
  tierSample: Record<string, string>;
  visual: { enabled: boolean; status: string; version: number; presetId: string | null; presetName: string | null; updatedAt: string } | null;
}
interface PresetRow {
  id: string; name: string; description: string | null; isBuiltin: boolean;
  createdBy: string; updatedAt: string; assignedCount: number;
}
interface OverviewData { players: PlayerRow[]; presets: PresetRow[]; globalDefault: VisualConfig | null }
interface ConfigDetail {
  exists: boolean; enabled?: boolean; status?: string; version?: number;
  presetId?: string | null; presetName?: string | null;
  draft?: VisualConfig; published?: VisualConfig | null; updatedBy?: string | null;
}
interface RevisionRow {
  id: string; playerId: string | null; presetId: string | null; version: number;
  changedBy: string; changeSummary: string | null; createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT_ONLY: '仅草稿', PUBLISHED: '已发布', DIRTY: '有未发布修改',
};

export function AdminVisualManager() {
  const { toast } = useToast();
  const adminRole = useAppStore(s => s.adminRole);
  const canWrite = adminRole === 'OWNER' || adminRole === 'ADMIN';

  const [subTab, setSubTab] = useState('editor');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<ConfigDetail | null>(null);
  const [draft, setDraft] = useState<VisualConfig>(emptyDraft());
  const [busy, setBusy] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchPresetId, setBatchPresetId] = useState<string>('');
  const [presetNameDialog, setPresetNameDialog] = useState<{ open: boolean; name: string; desc: string }>({ open: false, name: '', desc: '' });
  // 全局默认面板重挂载计数（overview 刷新/保存成功后 +1 → 初始态重新注入）
  const [globalVersion, setGlobalVersion] = useState(0);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch('/api/v1/admin/visual/overview');
      const d = await r.json();
      setOverview(d.players ? d : null);
      setGlobalVersion(v => v + 1);
    } catch {
      toast({ title: '加载失败', description: '总览数据读取失败', variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // ── 选中玩家 → 拉草稿 ──
  const loadDetail = useCallback(async (playerId: string) => {
    setDetail(null);
    try {
      const r = await adminFetch(`/api/v1/admin/visual/config?playerId=${encodeURIComponent(playerId)}`);
      const d: ConfigDetail = await r.json();
      setDetail(d);
      if (d.exists && d.draft) setDraft(d.draft);
      else {
        // 初始草稿 = 继承链现状起点（无个人配置 → 空白，引擎回落全局默认）
        setDraft(emptyDraft());
      }
    } catch {
      toast({ title: '读取失败', description: '玩家视觉配置读取失败', variant: 'destructive' });
    }
  }, [toast]);

  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  // ── 版本历史 ──
  const loadRevisions = useCallback(async (playerId: string | null) => {
    try {
      const q = playerId ? `?playerId=${encodeURIComponent(playerId)}` : '';
      const r = await adminFetch(`/api/v1/admin/visual/revisions${q}`);
      const d = await r.json();
      setRevisions(d.revisions ?? []);
    } catch { setRevisions([]); }
  }, []);
  useEffect(() => { loadRevisions(subTab === 'global' ? null : selectedId); }, [subTab, selectedId, loadRevisions]);

  const refreshAll = () => { loadOverview(); if (selectedId) loadDetail(selectedId); };

  // ── 动作：保存草稿 / 发布 / 清除 / 回滚 ──
  const saveDraft = async () => {
    if (!selectedId) return;
    setBusy('save');
    try {
      const r = await adminFetch('/api/v1/admin/visual/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: selectedId, config: draft }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      toast({ title: '草稿已保存', description: '发布后玩家侧生效' });
      refreshAll();
    } catch (e) {
      toast({ title: '保存失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const publish = async () => {
    if (!selectedId) return;
    setBusy('publish');
    try {
      const r = await adminFetch('/api/v1/admin/visual/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: selectedId, summary: '编辑器发布' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '发布失败');
      toast({ title: `已发布 v${d.version}`, description: '玩家面板即时生效' });
      refreshAll();
    } catch (e) {
      toast({ title: '发布失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const clearOverride = async () => {
    if (!selectedId) return;
    setBusy('clear');
    try {
      const r = await adminFetch(`/api/v1/admin/visual/config?playerId=${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '清除失败');
      toast({ title: '已清除个人覆盖', description: '该玩家回落预设/全局默认' });
      refreshAll();
    } catch (e) {
      toast({ title: '清除失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  // ── 预设中心动作 ──
  const createPresetFromDraft = async () => {
    setBusy('preset-create');
    try {
      const r = await adminFetch('/api/v1/admin/visual/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: presetNameDialog.name, description: presetNameDialog.desc, config: draft }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '创建失败');
      toast({ title: '预设已创建', description: d.name });
      setPresetNameDialog({ open: false, name: '', desc: '' });
      refreshAll();
    } catch (e) {
      toast({ title: '创建失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const deletePreset = async (p: PresetRow) => {
    setBusy(`preset-del-${p.id}`);
    try {
      const r = await adminFetch(`/api/v1/admin/visual/presets/${p.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '删除失败');
      toast({ title: '预设已删除', description: `${d.detachedPlayers ?? 0} 个玩家配置回落继承链` });
      refreshAll();
    } catch (e) {
      toast({ title: '删除失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const applyPresetToPlayer = async (p: PresetRow) => {
    if (!selectedId) return;
    setBusy(`preset-apply-${p.id}`);
    try {
      // 先写 presetId + 把预设配置灌为草稿（读取预设 config → 本地 PUT）
      const pr = await adminFetch('/api/v1/admin/visual/presets');
      const pd = await pr.json();
      const full = (pd.presets ?? []).find((x: { id: string }) => x.id === p.id);
      await adminFetch('/api/v1/admin/visual/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: selectedId, config: full?.config ?? {}, presetId: p.id }),
      });
      toast({ title: '预设已载入草稿', description: `「${p.name}」→ 确认后点发布` });
      refreshAll();
    } catch (e) {
      toast({ title: '载入失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  // ── 批量发布 ──
  const runBatch = async () => {
    setBusy('batch');
    try {
      const r = await adminFetch('/api/v1/admin/visual/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds: batchIds, presetId: batchPresetId, summary: '批量预设发布' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '批量发布失败');
      toast({ title: `批量完成：成功 ${d.successCount} / 失败 ${d.failCount}`, description: `预设「${d.presetName}」· 受影响 ${d.affected}` });
      setBatchDialogOpen(false);
      setBatchIds([]);
      refreshAll();
    } catch (e) {
      toast({ title: '批量失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const rollback = async (rev: RevisionRow) => {
    setBusy(`rollback-${rev.id}`);
    try {
      const r = await adminFetch('/api/v1/admin/visual/revisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId: rev.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '回滚失败');
      toast({ title: `已回滚至 v${rev.id ? d.rolledBackFrom : ''}`, description: `当前版本 v${d.version}` });
      refreshAll();
    } catch (e) {
      toast({ title: '回滚失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const saveGlobal = async (config: VisualConfig) => {
    setBusy('global');
    try {
      const r = await adminFetch('/api/v1/admin/visual/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, summary: '管理端更新全局默认' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      toast({ title: '全局默认已更新', description: '作用于全部未覆盖玩家' });
      loadOverview();
    } catch (e) {
      toast({ title: '保存失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const filteredPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!overview) return [];
    return q ? overview.players.filter(p => p.name.toLowerCase().includes(q)) : overview.players;
  }, [overview, search]);

  const selectedPlayer = overview?.players.find(p => p.id === selectedId) ?? null;

  if (loading) {
    return <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList className="h-8">
          <TabsTrigger value="editor" className="text-[11px] h-7"><Users2 className="w-3 h-3 mr-1" />配置编辑</TabsTrigger>
          <TabsTrigger value="presets" className="text-[11px] h-7"><Layers className="w-3 h-3 mr-1" />预设中心</TabsTrigger>
          <TabsTrigger value="revisions" className="text-[11px] h-7"><History className="w-3 h-3 mr-1" />版本历史</TabsTrigger>
          <TabsTrigger value="global" className="text-[11px] h-7"><Globe className="w-3 h-3 mr-1" />全局默认</TabsTrigger>
        </TabsList>

        {/* ═══ 配置编辑 ═══ */}
        <TabsContent value="editor" className="mt-3">
          <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
            {/* Player Selector */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索玩家…" className="h-8 pl-8 text-[12px]" />
              </div>
              {batchIds.length > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-jade-500/30 bg-jade-500/10 px-2.5 py-1.5">
                  <span className="text-[10px] text-jade-300">已选 {batchIds.length} 名玩家</span>
                  <div className="flex gap-1">
                    {canWrite && (
                      <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => setBatchDialogOpen(true)} disabled={!batchPresetId && batchPresetId === ''}>
                        批量发布
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setBatchIds([])}>清除</Button>
                  </div>
                </div>
              )}
              <ScrollArea className="max-h-[520px] rounded-lg border border-white/10">
                <div className="p-1.5 space-y-0.5">
                  {filteredPlayers.map(p => (
                    <div
                      key={p.id}
                      className={cn(
                        'group flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
                        selectedId === p.id ? 'bg-jade-500/15' : 'hover:bg-white/5',
                      )}
                      onClick={() => setSelectedId(p.id)}
                    >
                      <Checkbox
                        checked={batchIds.includes(p.id)}
                        onCheckedChange={v => setBatchIds(ids => v ? [...ids, p.id] : ids.filter(x => x !== p.id))}
                        onClick={e => e.stopPropagation()}
                        aria-label={`选择 ${p.name} 参与批量`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-white truncate">{p.name}</div>
                        <div className="text-[9px] text-muted-foreground">
                          {p.visual
                            ? `${STATUS_LABEL[p.visual.status] ?? p.visual.status} · v${p.visual.version}${p.visual.presetName ? ` · ${p.visual.presetName}` : ''}`
                            : '继承全局/预设'}
                        </div>
                      </div>
                      {p.visual?.status === 'PUBLISHED' && <span className="w-1.5 h-1.5 rounded-full bg-jade-400 flex-shrink-0" />}
                      {p.visual?.status === 'DIRTY' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />}
                    </div>
                  ))}
                  {filteredPlayers.length === 0 && (
                    <div className="text-center text-[11px] text-muted-foreground py-6">无匹配玩家</div>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Editor 列 */}
            <div className="min-w-0">
              {!selectedPlayer ? (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] py-16 text-center text-[12px] text-muted-foreground">
                  从左侧选择一名玩家开始配置专属视觉身份
                </div>
              ) : (
                <div className="space-y-3">
                  {/* 状态头 */}
                  <div className="flex items-center justify-between gap-2 flex-wrap rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-bold text-white truncate">{selectedPlayer.name}</span>
                      {selectedPlayer.visual ? (
                        <Badge variant="outline" className="text-[9px]">
                          {STATUS_LABEL[selectedPlayer.visual.status] ?? selectedPlayer.visual.status} · v{selectedPlayer.visual.version}
                          {selectedPlayer.visual.presetName ? ` · 预设:${selectedPlayer.visual.presetName}` : ''}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[9px]">无独立配置 · 继承中</Badge>
                      )}
                      {detail?.exists && detail.status === 'DIRTY' && (
                        <Badge className="text-[9px] bg-amber-400/15 text-amber-300 border border-amber-400/30">草稿领先于发布</Badge>
                      )}
                    </div>
                    {canWrite && (
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={saveDraft} disabled={busy !== null}>
                          {busy === 'save' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}保存草稿
                        </Button>
                        <Button size="sm" className="h-7 text-[11px]" onClick={publish} disabled={busy !== null}>
                          {busy === 'publish' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Rocket className="w-3 h-3 mr-1" />}发布
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-[11px] text-red-400" onClick={clearOverride} disabled={busy !== null}>
                          <RotateCcw className="w-3 h-3 mr-1" />重置
                        </Button>
                      </div>
                    )}
                  </div>
                  {!canWrite && (
                    <p className="text-[10px] text-amber-400/80">当前角色 {adminRole} 为只读视角 — 编辑器可预览，保存/发布由 OWNER/ADMIN 执行。</p>
                  )}
                  <VisualEditor draft={draft} onDraftChange={setDraft} readOnly={!canWrite} />
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ═══ 预设中心 ═══ */}
        <TabsContent value="presets" className="mt-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-[11px] text-muted-foreground">
                预设只保存受控配置参数；玩家独立覆盖不反向改变共享预设。内置预设可编辑不可删除。
              </p>
              {canWrite && selectedId && (
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPresetNameDialog({ open: true, name: '', desc: '' })}>
                  <Layers className="w-3 h-3 mr-1" />将当前玩家草稿存为新预设
                </Button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {(overview?.presets ?? []).map(p => (
                <div key={p.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-bold text-white truncate">{p.name}</span>
                    {p.isBuiltin && <Badge variant="secondary" className="text-[8px]">内置</Badge>}
                  </div>
                  <p className="text-[10px] text-muted-foreground line-clamp-2 min-h-[24px]">{p.description || '—'}</p>
                  <div className="text-[9px] text-muted-foreground">关联 {p.assignedCount} 名玩家 · {p.createdBy}</div>
                  {canWrite && (
                    <div className="flex gap-1.5 pt-1">
                      <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 flex-1" onClick={() => applyPresetToPlayer(p)} disabled={!selectedId || busy !== null}>
                        载入选中玩家
                      </Button>
                      {!p.isBuiltin && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400" onClick={() => deletePreset(p)} disabled={busy !== null} aria-label={`删除预设 ${p.name}`}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ═══ 版本历史与回滚 ═══ */}
        <TabsContent value="revisions" className="mt-3">
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              {selectedPlayer ? `「${selectedPlayer.name}」的发布历史（append-only；回滚产生新版本号）` : '选择玩家查看其版本历史；全局快照在「全局默认」页签'}
            </p>
            <ScrollArea className="max-h-[480px]">
              <div className="space-y-1.5 pr-2">
                {revisions.length === 0 && (
                  <div className="text-center text-[11px] text-muted-foreground py-8">暂无版本记录</div>
                )}
                {revisions.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[11px] text-white">
                        <span className="font-mono font-bold">v{r.version}</span>
                        <span className="ml-2 text-muted-foreground">{r.changeSummary || '—'}</span>
                      </div>
                      <div className="text-[9px] text-muted-foreground">{r.changedBy} · {new Date(r.createdAt).toLocaleString('zh-CN')}</div>
                    </div>
                    {canWrite && (
                      <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 flex-shrink-0" onClick={() => rollback(r)} disabled={busy !== null}>
                        <RotateCcw className="w-3 h-3 mr-1" />回滚至此
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </TabsContent>

        {/* ═══ 全局默认 ═══ */}
        <TabsContent value="global" className="mt-3">
          <GlobalDefaultPanel
            key={globalVersion}
            initial={overview?.globalDefault ?? null}
            canWrite={canWrite}
            busy={busy === 'global'}
            onSave={saveGlobal}
          />
        </TabsContent>
      </Tabs>

      {/* 批量发布确认弹窗（显示受影响数量） */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">批量发布预设</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-[12px] text-muted-foreground">
              将对 <span className="font-bold text-white">{batchIds.length}</span> 名玩家发布同一预设配置（覆盖各自独立配置）。
            </p>
            <Select value={batchPresetId} onValueChange={setBatchPresetId}>
              <SelectTrigger className="h-8 text-[12px]"><SelectValue placeholder="选择预设" /></SelectTrigger>
              <SelectContent>
                {(overview?.presets ?? []).map(p => (
                  <SelectItem key={p.id} value={p.id} className="text-[12px]">{p.name}{p.isBuiltin ? '（内置）' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button size="sm" onClick={runBatch} disabled={!batchPresetId || busy !== null}>
              {busy === 'batch' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}确认发布 {batchIds.length} 名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 预设命名弹窗 */}
      <Dialog open={presetNameDialog.open} onOpenChange={v => setPresetNameDialog(s => ({ ...s, open: v }))}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">另存为视觉预设</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Input placeholder="预设名称（≤40 字）" value={presetNameDialog.name} onChange={e => setPresetNameDialog(s => ({ ...s, name: e.target.value }))} maxLength={40} />
            <Input placeholder="描述（可选，≤120 字）" value={presetNameDialog.desc} onChange={e => setPresetNameDialog(s => ({ ...s, desc: e.target.value }))} maxLength={120} />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPresetNameDialog(s => ({ ...s, open: false }))}>取消</Button>
            <Button size="sm" onClick={createPresetFromDraft} disabled={!presetNameDialog.name.trim() || busy !== null}>
              {busy === 'preset-create' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}创建预设
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// GlobalDefaultPanel — 全局默认视觉（继承链第 1 层）
// ============================================================
function GlobalDefaultPanel({ initial, canWrite, busy, onSave }: {
  initial: VisualConfig | null;
  canWrite: boolean;
  busy: boolean;
  onSave: (c: VisualConfig) => void;
}) {
  // initial 由父级以 key 重挂载方式注入（避免 effect 内 setState 级联渲染）
  const [cfg, setCfg] = useState<VisualConfig>(initial ?? emptyDraft());

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-[11px] text-muted-foreground">
          全局默认作用于【没有任何个人/预设配置】的玩家；优先级最低（个人覆盖 &gt; 群组预设 &gt; 全局默认）。
        </p>
        {canWrite && (
          <Button size="sm" className="h-7 text-[11px]" onClick={() => onSave(cfg)} disabled={busy}>
            {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Globe className="w-3 h-3 mr-1" />}保存全局默认
          </Button>
        )}
      </div>
      <VisualEditor draft={cfg} onDraftChange={setCfg} readOnly={!canWrite} />
    </div>
  );
}
