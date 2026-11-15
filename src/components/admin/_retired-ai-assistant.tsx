'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1943-L2118），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// ------------------------------------------------------------
// 【下架留档件 · 不参与构建引用】
// R3-T3（批复 2026-11-08「下架聊天ai助手和管理ai助手」）：AI 助手页签已下架，
// 前端入口移除、后端 /api/v1/admin/ai-agent 走 503 SERVICE_RETIRED 闸门。
// 重组本批将本组件从活跃源文件（admin-panel.tsx）移出至本留档文件：
//   - 全仓无任何 import 指向本文件 → 打包器不拉取，访客/管理员零字节负担；
//   - 保留完整组件源码 → 恢复上架时（需管理员新批复）将本文件迁回 admin/
//     活跃文件并回填页签 + 渲染行 + 后续页签序号回拨，可逆。
// ============================================================
import { useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, AlertTriangle, Loader2 } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';

// --- Admin: AI Assistant (Agent that helps operate — review claims, audit anomalies, summarize) ---
function AdminAiAssistant() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    answer?: string;
    trace?: Array<{ type: string; tool?: string; args?: Record<string, unknown>; result?: unknown; content?: string }>;
    iterations?: number;
    error?: string;
  } | null>(null);
  const [history, setHistory] = useState<Array<{ task: string; answer: string; ts: number }>>([]);
  const [showTrace, setShowTrace] = useState(false);

  const send = async () => {
    const task = input.trim();
    if (!task || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await adminFetch('/api/v1/admin/ai-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ error: data?.error || `请求失败 (${res.status})` });
      } else {
        setResult({ answer: data.answer, trace: data.trace, iterations: data.iterations });
        setHistory(h => [{ task, answer: data.answer, ts: Date.now() }, ...h].slice(0, 10));
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'AI 助手服务不可用，请确认 mini-service 已启动（cd mini-services/admin-ai-assistant && bun run dev）' });
    } finally {
      setLoading(false);
    }
  };

  const quickActions = [
    { label: '审核待处理认领', task: '帮我查看当前有多少待审批的认领请求，并对每一条给出预审建议' },
    { label: '运营概览', task: '给我一份服务器运营快照：玩家总数、今日新增、各模式活跃度' },
    { label: '可疑数据排查', task: '列出所有可疑数据玩家（异常 K/D 或胜率），按严重程度排序' },
    { label: '最近操作', task: '查看最近 10 条管理操作日志' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-secondary-foreground flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-jade-400" /> AI 助手
          <span className="text-[9px] font-normal text-muted-foreground/70 border border-white/10 rounded-full px-1.5 py-0.5">Agent · 免费API</span>
        </h3>
      </div>

      <div className="rounded-lg bg-jade-500/5 border border-jade-500/15 px-3 py-2 text-[10px] text-muted-foreground leading-relaxed">
        这是一个会主动调用工具的 AI Agent（基于 z-ai-web-dev-sdk，完全免费）。它能查认领、审数据、找玩家、看日志——所有工具只读，最终操作仍需你在对应 tab 手动完成。
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-1.5">
        {quickActions.map(qa => (
          <button
            key={qa.label}
            onClick={() => { setInput(qa.task); }}
            disabled={loading}
            className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-white/5 text-white/70 hover:bg-jade-500/15 hover:text-jade-400 border border-white/8 transition-colors disabled:opacity-50"
          >
            {qa.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="向 AI 助手下达任务…（Enter 发送，Shift+Enter 换行）"
          rows={2}
          disabled={loading}
          className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-xs text-white placeholder:text-muted-foreground/50 focus:outline-none focus:border-jade-500/40 resize-none custom-scrollbar disabled:opacity-60"
        />
        <motion.button
          onClick={send}
          disabled={loading || !input.trim()}
          whileTap={{ scale: 0.96 }}
          aria-label="发送任务给 AI 助手"
          className="px-4 rounded-lg bg-jade-500/20 text-jade-400 border border-jade-500/30 hover:bg-jade-500/30 transition-colors disabled:opacity-40 flex items-center gap-1.5 text-xs font-semibold flex-shrink-0"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? '执行中' : '发送'}
        </motion.button>
      </div>

      {/* Error */}
      {result?.error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/25 px-3 py-2.5 text-[11px] text-red-300 flex items-start gap-2" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{result.error}</span>
        </div>
      )}

      {/* Answer */}
      {result?.answer && (
        <div className="rounded-lg bg-white/4 border border-white/8 px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-jade-400 uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> AI 回答
            </span>
            <div className="flex items-center gap-2">
              {result.iterations != null && (
                <span className="text-[9px] text-muted-foreground/60">{result.iterations} 轮 · {(result.trace?.length ?? 0)} 步</span>
              )}
              {result.trace && result.trace.length > 0 && (
                <button
                  onClick={() => setShowTrace(v => !v)}
                  aria-expanded={showTrace}
                  className="text-[10px] text-muted-foreground hover:text-white transition-colors"
                >
                  {showTrace ? '▾ 隐藏轨迹' : '▸ 工具轨迹'}
                </button>
              )}
            </div>
          </div>
          <div className="text-xs text-white/85 whitespace-pre-wrap leading-relaxed">{result.answer}</div>

          {/* Tool trace (collapsible) */}
          {showTrace && result.trace && result.trace.length > 0 && (
            <div className="mt-2 pt-2 border-t border-white/8 space-y-1.5">
              {result.trace.map((step, i) => (
                <div key={i} className="text-[10px] font-mono">
                  {step.type === 'tool_call' && (
                    <div className="text-jade-400/80">→ 调用 {step.tool}({JSON.stringify(step.args)})</div>
                  )}
                  {step.type === 'tool_result' && (
                    <div className="text-muted-foreground/70 pl-3 break-all">
                      ← {step.tool}: {JSON.stringify(step.result).slice(0, 200)}{JSON.stringify(step.result).length > 200 ? '…' : ''}
                    </div>
                  )}
                  {step.type === 'assistant_text' && (
                    <div className="text-white/60 pl-3">最终回答生成完毕</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <button
            onClick={() => setHistory([])}
            className="text-[10px] text-muted-foreground hover:text-red-300 transition-colors"
          >
            清空历史（{history.length}）
          </button>
          <div className="mt-1.5 space-y-1 max-h-[120px] overflow-y-auto custom-scrollbar">
            {history.map((h, i) => (
              <button
                key={i}
                onClick={() => { setInput(h.task); setResult(null); }}
                className="w-full text-left px-2 py-1.5 rounded-lg bg-white/3 hover:bg-white/5 text-[10px] transition-colors"
              >
                <span className="text-muted-foreground/60">{new Date(h.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-white/70 ml-2">{h.task}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminAiAssistant;
