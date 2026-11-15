'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1439-L1605），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：沙盒模式页签（模拟数据生成/清除）。
// ============================================================
import { useState } from 'react';
import { Sparkles, Plus, Trash2, Loader2 } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { adminFetch } from '@/lib/admin-fetch';
import { fetchNormalizedPlayers } from '@/lib/api';
import { Slider } from '@/components/ui/slider';
import { ConfirmDialog } from './shared';

// --- Admin: Sandbox (demo data generator) ---
export function AdminSandbox() {
  const { players, setPlayers } = useAppStore();
  const [count, setCount] = useState(100);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  // P2-1: confirm() → 受控 ConfirmDialog
  const [confirmClear, setConfirmClear] = useState(false);

  const demoCount = players.filter(p => p.name.startsWith('[DEMO]')).length;

  const seed = async () => {
    setSeeding(true);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/v1/sandbox/seed?count=${count}`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setMsg({ type: 'success', text: `已生成 ${data.created} 名模拟玩家（前缀 [DEMO]）` });
        // Refresh player list
        setPlayers(await fetchNormalizedPlayers({ fresh: true }));
      } else {
        setMsg({ type: 'error', text: data.error || '生成失败' });
      }
    } catch {
      setMsg({ type: 'error', text: '网络错误' });
    }
    setSeeding(false);
  };

  // P2-1: 原生 confirm → ConfirmDialog；清除执行拆出为纯函数
  const clear = async () => {
    setClearing(true);
    setMsg(null);
    try {
      const res = await adminFetch('/api/v1/sandbox/clear', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setMsg({ type: 'success', text: `已删除 ${data.deleted} 名模拟玩家` });
        setPlayers(await fetchNormalizedPlayers({ fresh: true }));
      } else {
        setMsg({ type: 'error', text: data.error || '清除失败' });
      }
    } catch {
      setMsg({ type: 'error', text: '网络错误' });
    }
    setClearing(false);
    setConfirmClear(false);
  };

  return (
    <div className="space-y-4">
      <div className="liquid-glass-subtle rounded-xl p-4">
        <h3 className="text-sm font-semibold text-secondary-foreground flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4" /> 沙盒模式 · 模拟数据
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          生成带合理段位分布、战绩、感动文字的模拟玩家，用于测试排行榜、搜索、管理操作。所有模拟玩家以 <code className="text-jade-400 bg-white/5 px-1 rounded">[DEMO]</code> 前缀标记，可一键清除，绝不影响真实数据。
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-center">
          <div className="bg-white/5 rounded-lg p-2">
            <div className="text-[10px] text-muted-foreground uppercase">当前模拟</div>
            <div className="text-lg font-bold text-jade-400 number-score">{demoCount}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2">
            <div className="text-[10px] text-muted-foreground uppercase">真实玩家</div>
            <div className="text-lg font-bold text-white number-score">{players.length - demoCount}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2">
            <div className="text-[10px] text-muted-foreground uppercase">总数</div>
            <div className="text-lg font-bold text-white number-score">{players.length}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2">
            <div className="text-[10px] text-muted-foreground uppercase">上限</div>
            <div className="text-lg font-bold text-white number-score">10000</div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label htmlFor="sandbox-count" className="text-xs text-muted-foreground flex items-center justify-between mb-1">
              <span>生成数量</span>
              <span className="text-jade-400 font-bold number-score">{count}</span>
            </label>
            {/* P2-1: 原生 range → shadcn Slider（主题轨道/拖拽点/键盘方向键）*/}
            <Slider
              id="sandbox-count"
              value={[count]}
              onValueChange={v => setCount(v[0] ?? count)}
              min={10}
              max={1000}
              step={10}
              aria-label="生成数量"
              className="w-full"
            />
            <div className="flex gap-1 mt-1.5">
              {[10, 50, 100, 500, 1000].map(n => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    count === n ? 'bg-jade-500/20 text-jade-400' : 'bg-white/5 text-muted-foreground hover:text-white'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={seed}
              disabled={seeding}
              className="flex-1 spring-press px-3 min-h-[44px] rounded-xl bg-jade-500/15 text-jade-400 border border-jade-500/30 text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {seeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {seeding ? '生成中...' : `生成 ${count} 名模拟玩家`}
            </button>
            <button
              onClick={() => setConfirmClear(true)}
              disabled={clearing || demoCount === 0}
              className="spring-press px-3 min-h-[44px] rounded-xl bg-red-500/10 text-red-400 border border-red-500/30 text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {clearing ? '清除中...' : '清除全部'}
            </button>
          </div>
        </div>

        {msg && (
          <div className={`mt-3 p-2.5 rounded-lg text-xs ${
            msg.type === 'success' ? 'bg-jade-500/10 text-jade-400' :
            msg.type === 'error' ? 'bg-red-500/10 text-red-400' :
            'bg-white/5 text-muted-foreground'
          }`}>
            {msg.text}
          </div>
        )}
      </div>

      {/* P2-1: 清除模拟数据二次确认 */}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`确认删除全部 ${demoCount} 名模拟玩家？`}
        description="仅删除 [DEMO] 前缀的模拟数据，真实玩家不受影响。"
        confirmLabel="确认清除"
        onConfirm={clear}
        busy={clearing}
      />

      <div className="text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-white/80">模拟数据特征：</p>
        <ul className="space-y-0.5 ml-3">
          <li>• 段位按真实阶梯分布（HT1/LT1 稀少，HT4/LT4 最多）</li>
          <li>• 每位玩家随机参与 1-5 个模式，含嘉豪模式</li>
          <li>• 战绩与段位匹配（高段位高胜率多击杀）</li>
          <li>• 20% 玩家带感动文字 + 点赞数</li>
          <li>• 名字前缀 [DEMO]，便于辨识与清除</li>
        </ul>
      </div>
    </div>
  );
}
