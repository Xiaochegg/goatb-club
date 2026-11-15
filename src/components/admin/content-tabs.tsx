'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1092-L1218），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：内容配置 / 音乐管理 / 背景管理 三个 config 类小页签（同文件合并，按页签分别导出）。
// ============================================================
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { THEME_PRESETS, type ThemePreset } from '@/lib/constants';
import { toast } from '@/hooks/use-toast';

// --- Admin: Content Config ---
export function AdminContentConfig() {
  const { announcement, setAnnouncement } = useAppStore();
  const [subTab, setSubTab] = useState(0);
  const subTabs = ['网站公告', '关于排行榜', '段位说明', '嘉豪模式说明'];
  const configKeys = ['announcement', 'about', 'tier_explanation', 'jiahao_explanation'];
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  // P2-1 反馈补齐：保存此前零反馈（对齐 MusicManage 的 ✓ 已保存模式）
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loaded) {
      adminFetch('/api/v1/config').then(r => r.json()).then(data => {
        setValues(data.configs || {});
        setAnnouncement(data.configs?.announcement || '');
        setLoaded(true);
      });
    }
  }, [loaded, setAnnouncement]);

  const save = async (key: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await adminFetch('/api/v1/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: values[key] || '' }),
      });
      if (res.ok) {
        if (key === 'announcement') setAnnouncement(values[key] || '');
        toast({ title: '已保存', description: '内容配置已更新并即时生效' });
      } else {
        toast({ title: '保存失败', description: '请稍后重试', variant: 'destructive' });
      }
    } catch {
      toast({ title: '保存失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {subTabs.map((t, i) => (
          <button key={t} onClick={() => setSubTab(i)} className={`spring-press px-3 py-1.5 rounded-lg text-xs ${subTab === i ? 'bg-jade-500/15 text-jade-400' : 'text-muted-foreground'}`}>{t}</button>
        ))}
      </div>
      <textarea
        value={values[configKeys[subTab]] || ''}
        onChange={e => setValues({ ...values, [configKeys[subTab]]: e.target.value })}
        rows={8}
        className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background font-mono"
        placeholder="Markdown内容..."
      />
      <p className="text-xs text-muted-foreground">{(values[configKeys[subTab]] || '').length} 字符</p>
      <motion.button
        onClick={() => save(configKeys[subTab])}
        disabled={saving}
        className="spring-press px-4 py-2 rounded-xl bg-jade-500 text-jade-900 font-medium text-sm disabled:opacity-50 flex items-center gap-1.5"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {saving ? '保存中...' : '保存修改'}
      </motion.button>
    </div>
  );
}

// --- Admin: Music Manage ---
export function AdminMusicManage() {
  const { musicUrls, setMusicUrls } = useAppStore();
  const [urls, setUrls] = useState<string[]>(musicUrls);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await adminFetch('/api/v1/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'music_urls', value: JSON.stringify(urls) }),
    });
    setMusicUrls(urls);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-secondary-foreground">官方背景音乐</h3>
      {(['aurora', 'sunset', 'deepsea', 'forest', 'cosmos'] as ThemePreset[]).map((key, i) => (
        <div key={key} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-6">{i + 1}</span>
          <span className="text-xs text-white w-16">{THEME_PRESETS[key].name}</span>
          <input
            value={urls[i] || ''}
            onChange={e => { const u = [...urls]; u[i] = e.target.value; setUrls(u); }}
            placeholder="音频URL"
            className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        </div>
      ))}
      <motion.button onClick={save} className="spring-press px-4 py-2 rounded-xl bg-jade-500 text-jade-900 font-medium text-sm">
        {saved ? '✓ 已保存' : '保存修改'}
      </motion.button>
    </div>
  );
}

// --- Admin: Background Manage ---
export function AdminBgManage() {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-secondary-foreground">主题预设</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Object.entries(THEME_PRESETS).map(([key, preset]) => (
          <div key={key} className="bg-card border border-white/7 rounded-xl p-3" style={{ background: preset.bg + 'cc', borderColor: preset.accent + '30' }}>
            <h4 className="text-sm font-medium text-white">{preset.name}</h4>
            <p className="text-xs text-muted-foreground mt-1">{preset.description}</p>
            <div className="w-8 h-2 rounded-full mt-2" style={{ background: preset.accent }} />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">用户可通过 DIY 编辑器切换预设或上传自定义背景</p>
    </div>
  );
}
