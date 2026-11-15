'use client';

// ============================================================
// Admin Sponsor Tab — 赞助位管理（工单 2026-11-09，管理员授权）
//
// 与前台 header 赞助弹窗并行接入同一接口 /api/v1/sponsor（固定形式）：
//   PUT { imageDataUrl?: string|null, note?: string, enabled?: boolean }
//
// 功能：上传/更换图片（前端压缩 ≤1080px JPEG85）、启用开关、说明文字、
//       清除图片；当前状态预览。
// 纪律：仅走赞助接口；不碰其他 config 键；图片上限由服务端二次校验。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, Upload, Trash2, Loader2, Save, MessageCircle, RefreshCw, Check } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { adminFetch } from '@/lib/admin-fetch';

interface SponsorState {
  enabled: boolean;
  note: string;
  image: string | null;   // enabled 时才有
  hasImage: boolean;
}

// ============================================================
// 祝福语列表项（GET /api/v1/sponsor/blessings，工单 2026-11-09）
// ============================================================
interface BlessingItem {
  id: string;
  content: string;
  nickname: string | null;
  status: string;   // NEW | READ
  createdAt: string;
}

/** 紧凑时间：MM-DD HH:mm */
function formatBlessTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 图片压缩：最长边 1080px、JPEG 0.85（透明底垫白，避免变黑）；GIF 不压缩直读 */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
  if (file.type === 'image/gif') return dataUrl; // GIF 保帧直读（超限由服务端拦截）

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解析失败'));
    el.src = dataUrl;
  });
  const MAX_EDGE = 1080;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // 压缩不可用 → 原图直传（服务端兜底校验）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function AdminSponsor() {
  const [state, setState] = useState<SponsorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'image' | 'note' | 'enabled' | 'clear' | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [draftImage, setDraftImage] = useState<string | null>(null); // 本地压缩后的待保存图
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/sponsor');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setState({ enabled: !!data.enabled, note: data.note ?? '', image: data.image ?? null, hasImage: !!data.hasImage });
      setDraftNote(data.note ?? '');
      setDraftImage(null);
      setMsg(null);
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const put = async (payload: Record<string, unknown>, kind: 'image' | 'note' | 'enabled' | 'clear') => {
    setSaving(kind);
    setMsg(null);
    try {
      const res = await adminFetch('/api/v1/sponsor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '保存失败');
      setState({ enabled: !!data.enabled, note: data.note ?? '', image: data.image ?? null, hasImage: !!data.hasImage });
      setDraftNote(data.note ?? '');
      setDraftImage(null);
      setMsg({ type: 'success', text: '已保存，前台赞助弹窗即时生效。' });
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(null);
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    try {
      const dataUrl = await compressImage(file);
      setDraftImage(dataUrl);
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '图片处理失败' });
    }
  };

  const previewSrc = draftImage ?? (state?.enabled ? state.image : null);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 正在加载赞助设置…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* 头部说明 */}
      <div className="flex items-center gap-2">
        <Heart className="w-4 h-4 text-jade-400" aria-hidden="true" />
        <h3 className="text-sm font-semibold">赞助位管理</h3>
        <span className="text-[11px] text-muted-foreground">图片展示于前台「赞助」弹窗</span>
      </div>

      {msg ? (
        <div
          role="status"
          className={`text-xs px-3 py-2 rounded-lg border ${
            msg.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : 'bg-red-500/10 border-red-500/25 text-red-300'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      {/* 当前图片预览 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-xs font-medium text-white/70 mb-3">图片</p>
        {previewSrc ? (
          <div className="flex flex-col items-center gap-3">
            
            <img
              src={previewSrc}
              alt="赞助图片预览"
              className="max-h-64 w-auto max-w-full object-contain rounded-lg border border-white/10 bg-white/[0.03]"
            />
            {draftImage ? (
              <p className="text-[11px] text-amber-300">新图片待保存（覆盖现有图片）</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-6">
            <Heart className="w-7 h-7 text-white/20" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              {state?.hasImage ? '已有图片（当前未启用，打开开关后展示）' : '尚未设置图片'}
            </p>
          </div>
        )}

        {/* 上传/保存/清除 */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            aria-label="选择赞助图片"
            onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[40px]"
            onClick={() => fileRef.current?.click()}
            disabled={saving !== null}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
            {state?.hasImage || draftImage ? '更换图片' : '上传图片'}
          </Button>
          {draftImage ? (
            <Button
              type="button"
              size="sm"
              className="min-h-[40px] bg-jade-500/90 hover:bg-jade-500 text-[#0d1f16]"
              onClick={() => put({ imageDataUrl: draftImage }, 'image')}
              disabled={saving !== null}
            >
              {saving === 'image' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : <Save className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />}
              保存新图
            </Button>
          ) : null}
          {state?.hasImage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[40px] text-red-300 hover:text-red-200 hover:border-red-400/40"
              onClick={() => put({ imageDataUrl: null }, 'clear')}
              disabled={saving !== null}
            >
              {saving === 'clear' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />}
              清除图片
            </Button>
          ) : null}
        </div>
      </div>

      {/* 启用开关 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-white/70">前台展示开关</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">关闭后前台弹窗显示「暂未开放」</p>
        </div>
        <Switch
          checked={!!state?.enabled}
          disabled={saving !== null}
          onCheckedChange={(v) => put({ enabled: v }, 'enabled')}
          aria-label="赞助位前台展示开关"
        />
      </div>

      {/* 说明文字 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-xs font-medium text-white/70 mb-2">说明文字（可选，≤200 字）</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={draftNote}
            maxLength={200}
            placeholder="例如：所有赞助将用于服务器维护，感谢支持！"
            onChange={(e) => setDraftNote(e.target.value)}
            className="min-h-[40px] text-sm"
            aria-label="赞助说明文字"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-[40px] shrink-0"
            disabled={saving !== null || draftNote === state?.note}
            onClick={() => put({ note: draftNote }, 'note')}
          >
            {saving === 'note' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : <Save className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />}
            保存文字
          </Button>
        </div>
      </div>

      {/* 玩家祝福语（工单 2026-11-09：赞助弹窗右下角送祝福 → 后台可查）*/}
      <BlessingsSection />
    </div>
  );
}

// ============================================================
// BlessingsSection — 玩家祝福语区块（工单 2026-11-09）
// 数据源 GET /api/v1/sponsor/blessings（adminFetch 门禁 OWNER/ADMIN/MODERATOR）
// 功能：未读徽章、单条/全部标已读、删除；长列表 max-h-96 滚动
// ============================================================
function BlessingsSection() {
  const [items, setItems] = useState<BlessingItem[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/v1/sponsor/blessings?limit=100');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setItems(Array.isArray(data.items) ? data.items : []);
      setUnread(Number(data.unread) || 0);
      setTotal(Number(data.total) || 0);
      setMsg(null);
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const markRead = async (payload: { ids?: string[]; markAllRead?: boolean }, key: string) => {
    setBusy(key);
    setMsg(null);
    try {
      const res = await adminFetch('/api/v1/sponsor/blessings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '操作失败');
      await load();
      setMsg({ type: 'success', text: `已标记 ${data.updated ?? 0} 条为已读` });
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '操作失败' });
    } finally {
      setBusy(null);
    }
  };

  const removeOne = async (item: BlessingItem) => {
    if (!window.confirm(`删除这条祝福语？（${item.nickname ?? '匿名'}：${item.content.slice(0, 30)}${item.content.length > 30 ? '…' : ''}）`)) return;
    setBusy(`del-${item.id}`);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/v1/sponsor/blessings?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '删除失败');
      await load();
      setMsg({ type: 'success', text: '已删除' });
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '删除失败' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      {/* 头部：标题 + 未读徽章 + 刷新 + 全部标已读 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <MessageCircle className="w-4 h-4 text-[#bf5af2]" aria-hidden="true" />
        <h4 className="text-sm font-semibold text-white/85">玩家祝福语</h4>
        {unread > 0 ? (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#bf5af2]/15 text-[#c9b8f5] border border-[#bf5af2]/30 tabular-nums">
            {unread} 未读
          </span>
        ) : null}
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">共 {total} 条</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[36px] h-9 px-2.5"
          onClick={load}
          disabled={loading || busy !== null}
          aria-label="刷新祝福语列表"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[36px] h-9 text-xs"
          onClick={() => markRead({ markAllRead: true }, 'all')}
          disabled={loading || busy !== null || unread === 0}
        >
          {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5 mr-1" aria-hidden="true" />}
          全部标已读
        </Button>
      </div>

      {msg ? (
        <div
          role="status"
          className={`text-xs px-3 py-2 rounded-lg border mb-3 ${
            msg.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : 'bg-red-500/10 border-red-500/25 text-red-300'
          }`}
        >
          {msg.text}
        </div>
      ) : null}

      {/* 列表（长列表滚动：max-h-96 overflow-y-auto） */}
      {loading && items === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 正在加载祝福语…
        </div>
      ) : items && items.length > 0 ? (
        <div className="max-h-96 overflow-y-auto custom-scrollbar space-y-2 pr-1" aria-label="玩家祝福语列表">
          {items.map((item) => {
            const isNew = item.status === 'NEW';
            return (
              <div
                key={item.id}
                className={`flex items-start justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-3 ${isNew ? 'border-l-2 border-l-[#bf5af2]' : ''}`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-white/85 break-words">{item.content}</p>
                  <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
                    <span>{item.nickname ?? '匿名'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBlessTime(item.createdAt)}</span>
                    {isNew ? (
                      <span className="text-[9px] font-bold px-1.5 py-px rounded-full bg-[#bf5af2]/15 text-[#c9b8f5] border border-[#bf5af2]/30">NEW</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {isNew ? (
                    <button
                      type="button"
                      onClick={() => markRead({ ids: [item.id] }, `read-${item.id}`)}
                      disabled={busy !== null}
                      className="min-h-[32px] min-w-[32px] h-8 px-2 rounded-lg text-[11px] text-white/60 hover:text-emerald-300 hover:border-emerald-400/40 border border-transparent hover:border transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                      aria-label={`标已读：${item.content.slice(0, 10)}`}
                      data-tip="标已读"
                    >
                      {busy === `read-${item.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeOne(item)}
                    disabled={busy !== null}
                    className="min-h-[32px] min-w-[32px] h-8 px-2 rounded-lg text-white/40 hover:text-red-300 hover:border-red-400/40 border border-transparent hover:border transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a78bfa]"
                    aria-label={`删除：${item.content.slice(0, 10)}`}
                    data-tip="删除"
                  >
                    {busy === `del-${item.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1.5 py-6">
          <MessageCircle className="w-6 h-6 text-white/15" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">还没有祝福语 —— 玩家在赞助弹窗右下角「送祝福」提交后将出现在这里</p>
        </div>
      )}
    </div>
  );
}
