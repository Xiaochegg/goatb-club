'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L1607-L1723），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：操作日志页签（服务端分页 + 清除确认）。
// ============================================================
import { useState, useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { ConfirmDialog } from './shared';

// --- Admin: Operation Logs ---
export function AdminOpLogs() {
  const [logs, setLogs] = useState<Array<{ id: string; type: string; detail: string; scoreChange: string | null; createdAt: string }>>([]);
  // P2-1 反馈补齐：加载态 + 清除前二次确认（此前清除零确认）
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // C1 分页（轻量化改造）：服务端分页 page/pageSize（默认每页 30，上限 30）
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const reqSeqRef = useRef(0); // 丢弃过期页响应（快速翻页竞态防护）

  const loadPage = useCallback(async (p: number) => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      const r = await adminFetch(`/api/v1/logs?page=${p}&pageSize=30`);
      const data = await r.json();
      if (seq !== reqSeqRef.current) return; // 已有更新请求，丢弃过期响应
      setLogs(data.logs || []);
      setTotal(data.total || 0);
      setPage(data.page || 1);
      setPageCount(data.pageCount || 1);
    } catch {
      // 拉取失败保留旧数据，不打断当前视图
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(1);
  }, [loadPage]);

  const clearLogs = async () => {
    setClearing(true);
    try {
      await adminFetch('/api/v1/logs', { method: 'DELETE' });
      await loadPage(1); // 清除后回到第 1 页（将看到清除留痕记录）
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-secondary-foreground">操作日志 · 共{total}条</h3>
        <motion.button
          onClick={() => setConfirmClear(true)}
          disabled={total === 0 || clearing}
          aria-label="清除日志"
          className="spring-press text-xs text-muted-foreground hover:text-[#e74c3c] disabled:opacity-50"
        >
          清除
        </motion.button>
      </div>
      <div className="space-y-1.5 max-h-[300px] overflow-y-auto custom-scrollbar">
        {loading ? (
          <p className="text-xs text-muted-foreground text-center py-4 flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
          </p>
        ) : (
          <>
            {logs.map(log => (
              <div key={log.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/3 text-xs">
                <span className="text-muted-foreground">{new Date(log.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-white/70">{log.type}</span>
                <span className="flex-1 text-white/50 truncate">{log.detail}</span>
                {log.scoreChange && (
                  <span className={log.scoreChange.startsWith('+') ? 'text-jade-400' : 'text-[#e74c3c]'}>{log.scoreChange}</span>
                )}
              </div>
            ))}
            {logs.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">暂无操作记录 — 修改玩家段位后会自动记录</p>}
          </>
        )}
      </div>

      {/* C1 分页控件：上一页 / 第 X / Y 页 / 下一页（服务端分页，每页 30 条） */}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground" role="navigation" aria-label="日志分页">
          <button
            onClick={() => loadPage(page - 1)}
            disabled={page <= 1 || loading}
            aria-label="上一页"
            className="spring-press px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none"
          >
            上一页
          </button>
          <span aria-live="polite">第 {page} / {pageCount} 页</span>
          <button
            onClick={() => loadPage(page + 1)}
            disabled={page >= pageCount || loading}
            aria-label="下一页"
            className="spring-press px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none"
          >
            下一页
          </button>
        </div>
      )}

      {/* P2-1: 清除日志二次确认 */}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="确认清除全部操作日志？"
        description={`${total} 条记录将被永久移除，清除后无法追溯管理操作历史。`}
        confirmLabel="确认清除"
        onConfirm={clearLogs}
        busy={clearing}
      />
    </div>
  );
}
