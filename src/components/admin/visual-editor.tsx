'use client';

// ============================================================
// PLAYER IDENTITY ENGINE V1.0 — Visual Editor + Live Preview
// （trace 1a1cfcfc32dceef1 批示「通过」2026-11-12）
// ------------------------------------------------------------
// - 六对象（形状/尺寸/位置/图层/入场/环境/交互/主色）参数编辑
// - 时间轴：顺序编排 + 时间参数编辑 + 整体重播（任务书 §八，
//   先交付可靠顺序编排；拖拽式时间轴 NOT IMPLEMENTED 如实标注）
// - 事件绑定编辑（§十一，只列有真实数据源的事件）
// - 实时预览：模拟数据 + 真实引擎渲染，桌面/手机视口切换；
//   预览绝不写库（configOverride 仅本地态）
// ============================================================

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Play, RotateCcw, Trash2, Copy, Plus, Monitor, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VisualStageProvider, useVisualStage } from '@/components/visual/visual-stage';
import { VisualBox, VisualAmbientBackground } from '@/components/visual/visual-objects';
import {
  ACCENT_TOKENS, DIRECTIONS, EASINGS, EFFECT_KEYS, EVENT_KEYS, OBJECT_TARGETS,
  PERF_MODES, SHAPE_KINDS, SIZE_PRESETS, TRIGGERS,
  type EffectKey, type EventKey, type ObjectTarget, type TimelineSegment, type VisualConfig,
} from '@/lib/visual/types';

// ── 展示名（中文） ──
const EFFECT_LABEL: Record<EffectKey, string> = {
  PRISM: '01 棱镜玻璃', PORTAL: '02 空间传送', HOLOGRAM: '03 全息投影', AURORA: '04 极光流动',
  ORBIT: '05 轨道环绕', PARTICLE: '06 粒子构成', LIQUID: '07 液态变形', DIMENSION: '08 空间翻转',
  REVEAL: '09 分层揭幕', PHOTON: '10 光子扫掠',
};
const OBJECT_LABEL: Record<ObjectTarget, string> = {
  AVATAR: '头像框', PROFILE_CARD: '玩家资料卡', RANK_BADGE: '等级徽章',
  STATS_CARD: '战绩数据卡', BACKGROUND: '背景装饰层', FLOATING_PANEL: '弹出信息窗',
};
const TRIGGER_LABEL: Record<string, string> = {
  AUTO: '自动播放', CLICK: '点击播放', HOVER: '悬停播放', SCROLL: '滚动触发',
  DELAYED: '延迟播放', SEQUENCE: '按时间轴', TOGGLE: '开关切换',
};
const EVENT_LABEL: Record<EventKey, string> = {
  PLAYER_PROFILE_OPEN: '面板打开', PLAYER_PROFILE_CLOSE: '面板关闭',
  RANK_CHANGED: '名次变化', TIER_CHANGED: '段位变化', STATISTICS_UPDATED: '战绩更新',
  LEADERBOARD_POSITION_CHANGED: '榜单位置变化', PLAYER_CARD_EXPANDED: '明细展开', TAB_CHANGED: '模式切换',
};
const SHAPE_LABEL: Record<string, string> = {
  ROUNDED_RECT: '圆角矩形', CIRCLE: '圆形', ELLIPSE: '椭圆', HEXAGON: '六边形', CUSTOM_RADIUS: '自定义圆角',
};
const SIZE_LABEL: Record<string, string> = { XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL', CUSTOM: '自定义宽高' };

// ── 小原语 ──
function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[11px] text-foreground/80 whitespace-nowrap">{label}</div>
        {hint && <div className="text-[9px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-shrink-0 w-[150px]">{children}</div>
    </div>
  );
}
function SliderRow({ label, value, min, max, step = 1, unit, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-foreground/80">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground">{value}{unit}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={v => onChange(v[0])} />
    </div>
  );
}

// ============================================================
// MockPlayerCard — 预览用模拟玩家卡（真实引擎渲染，绝不写库）
// ============================================================
function MockPlayerCard() {
  return (
    <div className="relative rounded-2xl border border-white/10 bg-black/40 p-3 space-y-2 overflow-hidden" style={{ minHeight: 260 }}>
      <VisualAmbientBackground />
      <VisualBox target="PROFILE_CARD" className="rounded-xl bg-white/[0.06] p-3">
        <div className="flex items-center gap-3 w-full">
          <VisualBox target="AVATAR" className="flex-shrink-0">
            <div className="w-full h-full flex items-center justify-center text-xl font-bold overflow-hidden bg-gradient-to-br from-emerald-500/60 to-teal-700/60 text-white">
              G
            </div>
          </VisualBox>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-white truncate">预览玩家</div>
            <div className="text-[9px] text-white/50">@preview · 模拟数据</div>
          </div>
          <VisualBox target="RANK_BADGE" className="flex-shrink-0">
            <div className="px-2 py-1 rounded-md bg-amber-400/15 border border-amber-400/40 text-[10px] font-bold text-amber-300">HT1</div>
          </VisualBox>
        </div>
      </VisualBox>
      <div className="grid grid-cols-2 gap-2">
        <VisualBox target="STATS_CARD" className="rounded-xl bg-white/[0.06] px-3 py-2.5">
          <div className="text-[9px] uppercase tracking-widest text-white/50">总分</div>
          <div className="text-lg font-bold text-white number-score">2,847</div>
        </VisualBox>
        <VisualBox target="STATS_CARD" className="rounded-xl bg-white/[0.06] px-3 py-2.5">
          <div className="text-[9px] uppercase tracking-widest text-white/50">排名</div>
          <div className="text-lg font-bold text-white number-score">#1</div>
        </VisualBox>
      </div>
      <VisualBox target="FLOATING_PANEL" className="rounded-xl bg-white/[0.06] px-3 py-2.5">
        <div className="text-[10px] text-white/60">弹出信息窗 · 预览对象</div>
      </VisualBox>
    </div>
  );
}

/** 预览舞台（独立 provider；configOverride = 编辑中的草稿） */
export function VisualPreviewPane({ config, className }: { config: VisualConfig; className?: string }) {
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('mobile');
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-foreground/80">实时预览（模拟数据）</div>
        <div className="flex gap-1">
          <Button variant={viewport === 'mobile' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setViewport('mobile')}>
            <Smartphone className="w-3.5 h-3.5" />
          </Button>
          <Button variant={viewport === 'desktop' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setViewport('desktop')}>
            <Monitor className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <VisualStageProvider configOverride={config} preview>
        <div className={cn('mx-auto transition-all', viewport === 'mobile' ? 'w-[280px]' : 'w-full')}>
          <MockPlayerCard />
        </div>
        <PreviewControls />
      </VisualStageProvider>
    </div>
  );
}

/** 预览控制条：整体重播 + 性能分级指示 */
function PreviewControls() {
  const stage = useVisualStage();
  if (!stage) return null;
  return (
    <div className="flex items-center justify-between mx-auto mt-2 w-fit gap-2">
      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={stage.replay}>
        <Play className="w-3 h-3 mr-1" /> 重播入场
      </Button>
      <Badge variant="outline" className="text-[9px] font-mono">
        {stage.perf}
      </Badge>
    </div>
  );
}

// ============================================================
// VisualEditor — 完整编辑器
// ============================================================
export function VisualEditor({
  draft, onDraftChange, readOnly = false, extraActions,
}: {
  draft: VisualConfig;
  onDraftChange: (c: VisualConfig) => void;
  readOnly?: boolean;
  extraActions?: React.ReactNode;
}) {
  const [tab, setTab] = useState('objects');
  const ro = readOnly;

  const patchObject = (target: ObjectTarget, patch: Partial<NonNullable<VisualConfig['objects'][ObjectTarget]>>) => {
    const next: VisualConfig = {
      ...draft,
      objects: { ...draft.objects, [target]: { ...(draft.objects[target] ?? {}), ...patch } },
    };
    onDraftChange(next);
  };
  const getObj = (target: ObjectTarget) => draft.objects?.[target] ?? {};

  // ── 时间轴操作 ──
  const setTimeline = (segs: TimelineSegment[]) => onDraftChange({ ...draft, timeline: segs });
  const addSegment = () => {
    if (draft.timeline.length >= 12) return;
    const maxStart = draft.timeline.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    setTimeline([...draft.timeline, {
      id: `seg-${Date.now() % 100000}-${draft.timeline.length + 1}`,
      target: 'PROFILE_CARD', effect: 'PRISM',
      start: Math.min(maxStart, 6000), duration: 700, intensity: 60,
    }]);
  };
  const patchSegment = (id: string, patch: Partial<TimelineSegment>) =>
    setTimeline(draft.timeline.map(s => (s.id === id ? { ...s, ...patch } : s)).sort((a, b) => a.start - b.start));
  const dupSegment = (s: TimelineSegment) =>
    setTimeline([...draft.timeline, { ...s, id: `seg-${Date.now() % 100000}-${draft.timeline.length + 1}` }].sort((a, b) => a.start - b.start));
  const delSegment = (id: string) => setTimeline(draft.timeline.filter(s => s.id !== id));

  const perfMode = draft.perfMode ?? 'FULL';

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <TabsList className="h-8">
          <TabsTrigger value="objects" className="text-[11px] h-7">对象与效果</TabsTrigger>
          <TabsTrigger value="timeline" className="text-[11px] h-7">时间轴</TabsTrigger>
          <TabsTrigger value="events" className="text-[11px] h-7">事件反馈</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          <Select value={perfMode} onValueChange={v => !ro && onDraftChange({ ...draft, perfMode: v as VisualConfig['perfMode'] })} disabled={ro}>
            <SelectTrigger className="h-7 w-[130px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERF_MODES.map(m => (
                <SelectItem key={m} value={m} className="text-[11px]">{m === 'FULL' ? 'FULL 完整' : m === 'BALANCED' ? 'BALANCED 均衡' : m === 'LITE' ? 'LITE 轻量' : 'STATIC 静态'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Switch checked={draft.ambientEnabled === true} onCheckedChange={v => !ro && onDraftChange({ ...draft, ambientEnabled: v })} disabled={ro} />
            <span className="text-[10px] text-muted-foreground">环境层</span>
          </div>
          {extraActions}
        </div>
      </div>

      {/* ── 对象与效果 ── */}
      <TabsContent value="objects" className="mt-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Accordion type="multiple" defaultValue={['AVATAR', 'PROFILE_CARD']} className="w-full">
            {OBJECT_TARGETS.map(target => {
              const o = getObj(target);
              const ep = (o.entrance?.params ?? {}) as Record<string, unknown>;
              return (
                <AccordionItem key={target} value={target}>
                  <AccordionTrigger className="text-[12px] py-2.5 hover:no-underline">
                    <span className="flex items-center gap-2">
                      {OBJECT_LABEL[target]}
                      {o.entrance && <Badge variant="outline" className="text-[8px] px-1 py-0">{o.entrance.effect}</Badge>}
                      {o.ambient && <Badge variant="secondary" className="text-[8px] px-1 py-0">环境 {o.ambient}</Badge>}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="pb-3">
                    <div className="grid sm:grid-cols-2 gap-x-5">
                      <div>
                        <Row label="形状">
                          <Select value={(o.shape ?? 'ROUNDED_RECT')} onValueChange={v => patchObject(target, { shape: v as never })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{SHAPE_KINDS.map(s => <SelectItem key={s} value={s} className="text-[11px]">{SHAPE_LABEL[s]}</SelectItem>)}</SelectContent>
                          </Select>
                        </Row>
                        {(o.shape === 'CUSTOM_RADIUS' || o.shape === 'ROUNDED_RECT' || !o.shape) && (
                          <SliderRow label="圆角" value={o.customRadius ?? 16} min={0} max={48} unit="px" onChange={v => patchObject(target, { customRadius: v })} />
                        )}
                        <Row label="尺寸档位">
                          <Select value={(o.sizePreset ?? 'M')} onValueChange={v => patchObject(target, { sizePreset: v as never })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{SIZE_PRESETS.map(s => <SelectItem key={s} value={s} className="text-[11px]">{SIZE_LABEL[s]}</SelectItem>)}</SelectContent>
                          </Select>
                        </Row>
                        {o.sizePreset === 'CUSTOM' && (
                          <div className="flex gap-2 py-1.5">
                            <Input type="number" className="h-7 text-[11px]" placeholder="宽" value={o.customWidth ?? 320} onChange={e => patchObject(target, { customWidth: Number(e.target.value) })} disabled={ro} />
                            <Input type="number" className="h-7 text-[11px]" placeholder="高" value={o.customHeight ?? 200} onChange={e => patchObject(target, { customHeight: Number(e.target.value) })} disabled={ro} />
                          </div>
                        )}
                        <Row label="宽高比" hint="空 = 自适应">
                          <Select value={(o.aspectRatio || 'auto')} onValueChange={v => patchObject(target, { aspectRatio: v === 'auto' ? '' : v })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto" className="text-[11px]">自适应</SelectItem>
                              {['1:1', '4:3', '16:9', '3:4'].map(r => <SelectItem key={r} value={r} className="text-[11px]">{r}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </Row>
                        <SliderRow label="位置 X" value={o.positionX ?? 0} min={-40} max={40} unit="px" onChange={v => patchObject(target, { positionX: v })} />
                        <SliderRow label="位置 Y" value={o.positionY ?? 0} min={-40} max={40} unit="px" onChange={v => patchObject(target, { positionY: v })} />
                        <SliderRow label="图层顺序" value={o.zLayer ?? 1} min={0} max={9} onChange={v => patchObject(target, { zLayer: v })} />
                        <SliderRow label="移动端缩放" value={o.mobileScale ?? 100} min={50} max={100} unit="%" onChange={v => patchObject(target, { mobileScale: v })} />
                      </div>
                      <div>
                        <Row label="主色调">
                          <Select value={(o.accentColor ?? 'inherit')} onValueChange={v => patchObject(target, { accentColor: v })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{ACCENT_TOKENS.map(t => <SelectItem key={t} value={t} className="text-[11px]">{t}</SelectItem>)}</SelectContent>
                          </Select>
                        </Row>
                        <Row label="悬停反馈">
                          <Select value={(o.interaction ?? 'NONE')} onValueChange={v => patchObject(target, { interaction: v as never })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {['NONE', 'LIFT', 'GLOW', 'TILT'].map(i => (
                                <SelectItem key={i} value={i} className="text-[11px]">{i === 'NONE' ? '无' : i === 'LIFT' ? '悬浮抬升' : i === 'GLOW' ? '辉光' : '3D 倾斜'}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Row>
                        <Row label="入场效果">
                          <Select
                            value={o.entrance?.effect ?? 'NONE'}
                            onValueChange={v => patchObject(target, {
                              entrance: v === 'NONE' ? null : {
                                effect: v as EffectKey,
                                trigger: o.entrance?.trigger ?? 'AUTO',
                                params: o.entrance?.params ?? {},
                              },
                            })}
                            disabled={ro}
                          >
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE" className="text-[11px]">无</SelectItem>
                              {EFFECT_KEYS.map(k => <SelectItem key={k} value={k} className="text-[11px]">{EFFECT_LABEL[k]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </Row>
                        {o.entrance && (
                          <>
                            <Row label="触发方式" hint="悬停自动附带点击（移动端）">
                              <Select value={o.entrance.trigger} onValueChange={v => patchObject(target, { entrance: { ...o.entrance!, trigger: v as never } })} disabled={ro}>
                                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                <SelectContent>{TRIGGERS.map(t => <SelectItem key={t} value={t} className="text-[11px]">{TRIGGER_LABEL[t]}</SelectItem>)}</SelectContent>
                              </Select>
                            </Row>
                            <SliderRow label="持续时间" value={(ep.duration as number) ?? 700} min={200} max={3000} step={50} unit="ms" onChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, duration: v } } })} />
                            <SliderRow label="延迟" value={(ep.delay as number) ?? 0} min={0} max={3000} step={50} unit="ms" onChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, delay: v } } })} />
                            <SliderRow label="强度" value={(ep.intensity as number) ?? 60} min={0} max={100} unit="%" onChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, intensity: v } } })} />
                            <SliderRow label="终态透明度" value={(ep.opacity as number) ?? 100} min={0} max={100} unit="%" onChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, opacity: v } } })} />
                            <SliderRow label="终态缩放" value={(ep.scale as number) ?? 100} min={50} max={120} unit="%" onChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, scale: v } } })} />
                            <Row label="方向">
                              <Select value={(ep.direction as string) ?? 'center'} onValueChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, direction: v as never } } })} disabled={ro}>
                                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                <SelectContent>{DIRECTIONS.map(d => <SelectItem key={d} value={d} className="text-[11px]">{d}</SelectItem>)}</SelectContent>
                              </Select>
                            </Row>
                            <Row label="缓动">
                              <Select value={(ep.easing as string) ?? EASINGS[4]} onValueChange={v => patchObject(target, { entrance: { ...o.entrance!, params: { ...o.entrance!.params, easing: v as never } } })} disabled={ro}>
                                <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                                <SelectContent>{EASINGS.map(e => <SelectItem key={e} value={e} className="text-[11px]">{e.length > 18 ? e.slice(0, 16) + '…' : e}</SelectItem>)}</SelectContent>
                              </Select>
                            </Row>
                          </>
                        )}
                        <Row label="环境动画" hint="需全局环境层开启">
                          <Select value={o.ambient ?? 'NONE'} onValueChange={v => patchObject(target, { ambient: v === 'NONE' ? null : (v as EffectKey) })} disabled={ro}>
                            <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE" className="text-[11px]">无</SelectItem>
                              {EFFECT_KEYS.map(k => <SelectItem key={k} value={k} className="text-[11px]">{EFFECT_LABEL[k]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </Row>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
          <div>
            <VisualPreviewPane config={draft} />
          </div>
        </div>
      </TabsContent>

      {/* ── 时间轴（顺序编排 + 时间参数；重播走预览） ── */}
      <TabsContent value="timeline" className="mt-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground">
                按开始时间排序执行；时间轴片段会覆写对应对象的入场延迟/时长/强度。最多 12 段。
              </p>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={addSegment} disabled={ro || draft.timeline.length >= 12}>
                <Plus className="w-3 h-3 mr-1" /> 添加片段
              </Button>
            </div>
            <ScrollArea className="max-h-[420px]">
              <div className="space-y-2 pr-2">
                {draft.timeline.length === 0 && (
                  <div className="text-center text-[11px] text-muted-foreground py-8">暂无时间轴片段 — 对象将按各自入场参数独立播放</div>
                )}
                {draft.timeline.map((s, i) => (
                  <div key={s.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-[9px] font-mono">#{i + 1} · {s.start}ms</Badge>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => dupSegment(s)} disabled={ro} aria-label="复制片段"><Copy className="w-3 h-3" /></Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400" onClick={() => delSegment(s.id)} disabled={ro} aria-label="删除片段"><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Row label="目标对象">
                        <Select value={s.target} onValueChange={v => patchSegment(s.id, { target: v as ObjectTarget })} disabled={ro}>
                          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{OBJECT_TARGETS.map(t => <SelectItem key={t} value={t} className="text-[11px]">{OBJECT_LABEL[t]}</SelectItem>)}</SelectContent>
                        </Select>
                      </Row>
                      <Row label="效果">
                        <Select value={s.effect} onValueChange={v => patchSegment(s.id, { effect: v as EffectKey })} disabled={ro}>
                          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{EFFECT_KEYS.map(k => <SelectItem key={k} value={k} className="text-[11px]">{EFFECT_LABEL[k]}</SelectItem>)}</SelectContent>
                        </Select>
                      </Row>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="w-[110px]">
                        <Label className="text-[10px] text-muted-foreground">开始 (ms)</Label>
                        <Input type="number" min={0} max={6000} step={50} className="h-7 text-[11px] mt-0.5" value={s.start} onChange={e => patchSegment(s.id, { start: Math.max(0, Math.min(6000, Number(e.target.value) || 0)) })} disabled={ro} />
                      </div>
                      <div className="flex-1 min-w-[130px]">
                        <SliderRow label="持续" value={s.duration} min={200} max={3000} step={50} unit="ms" onChange={v => patchSegment(s.id, { duration: v })} />
                      </div>
                      <div className="flex-1 min-w-[130px]">
                        <SliderRow label="强度" value={s.intensity} min={0} max={100} unit="%" onChange={v => patchSegment(s.id, { intensity: v })} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
          <div>
            <VisualPreviewPane config={draft} />
          </div>
        </div>
      </TabsContent>

      {/* ── 事件反馈 ── */}
      <TabsContent value="events" className="mt-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground pb-1">
              仅响应【真实业务数据变化】；同一事件 3 秒冷却。无对应数据变化时绝不播放（ACHIEVEMENT_UNLOCKED 无真实数据源，本期未开放）。
            </p>
            {EVENT_KEYS.map(key => {
              const b = draft.events?.[key];
              return (
                <div key={key} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium">{EVENT_LABEL[key]}</span>
                    <Switch checked={b?.enabled === true} onCheckedChange={v => onDraftChange({
                      ...draft,
                      events: { ...draft.events, [key]: { enabled: v, effect: b?.effect ?? 'PHOTON', intensity: b?.intensity ?? 70, duration: b?.duration ?? 900 } },
                    })} disabled={ro} />
                  </div>
                  {b?.enabled === true && (
                    <div className="grid grid-cols-3 gap-2 mt-2">
                      <Row label="效果">
                        <Select value={b.effect} onValueChange={v => onDraftChange({ ...draft, events: { ...draft.events, [key]: { ...b, effect: v as EffectKey } } })} disabled={ro}>
                          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent>{EFFECT_KEYS.map(k => <SelectItem key={k} value={k} className="text-[11px]">{EFFECT_LABEL[k]}</SelectItem>)}</SelectContent>
                        </Select>
                      </Row>
                      <SliderRow label="强度" value={b.intensity} min={0} max={100} unit="%" onChange={v => onDraftChange({ ...draft, events: { ...draft.events, [key]: { ...b, intensity: v } } })} />
                      <SliderRow label="持续" value={b.duration} min={400} max={2500} step={50} unit="ms" onChange={v => onDraftChange({ ...draft, events: { ...draft.events, [key]: { ...b, duration: v } } })} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <VisualPreviewPane config={draft} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}

/** 空白草稿（编辑器初始态） */
export function emptyDraft(): VisualConfig {
  return { version: 1, perfMode: 'FULL', ambientEnabled: false, objects: {}, timeline: [], events: {} };
}

/** 预设重置提示按钮（编辑器顶栏可选动作） */
export function ResetDraftButton({ onReset }: { onReset: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onReset}>
      <RotateCcw className="w-3 h-3 mr-1" /> 重置草稿
    </Button>
  );
}
