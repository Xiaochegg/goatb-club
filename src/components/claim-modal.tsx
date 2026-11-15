// ============================================================
// Component: ClaimModal — 认领我的榜单条目（认领机制 v1）
// 从「我的」面板打开：列出可认领的匿名条目（email 为 null），
// 选中一条提交 pending 请求，等管理员在后台审批。
// 红线文案写进 UI：认领仅身份绑定，不影响分数/段位/感动榜。
// 提交走 POST /api/v1/claims；错误信息直接透出服务端文案。
// ============================================================
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserCheck, ShieldCheck, Loader2, X, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { getAvatarInitial, getAvatarColor } from '@/lib/ui-utils';

const springIn = { type: 'spring' as const, stiffness: 220, damping: 24, mass: 0.9 };

export interface ClaimableEntry {
  id: string;
  name: string;
}

interface ClaimModalProps {
  open: boolean;
  onClose: () => void;
  claimable: ClaimableEntry[];
  onSubmitted: () => void;
}

export function ClaimModal({ open, onClose, claimable, onSubmitted }: ClaimModalProps) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 打开时重置状态
  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setQuery('');
      setError(null);
      // 下一个 tick 聚焦搜索框（等动画挂载）
      const t = setTimeout(() => searchRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = claimable.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  const handleSubmit = async () => {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: selectedId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || '提交失败，请稍后再试');
        return;
      }
      toast({ description: '✅ 认领请求已提交，等待管理员审批' });
      onSubmitted();
      onClose();
    } catch {
      setError('网络异常，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-3"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="认领我的榜单条目"
            initial={{ y: 24, scale: 0.92, opacity: 0, filter: 'blur(10px)' }}
            animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ y: 24, scale: 0.85, opacity: 0, filter: 'blur(8px)' }}
            transition={springIn}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-sm liquid-glass-strong rounded-[var(--radius-liquid-lg)] overflow-hidden"
          >
            <div className="h-1 gold-bar" />
            <div className="p-5">
              {/* 头部 */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-secondary-foreground" />
                  <h3 className="text-sm font-bold text-white tracking-tight">认领我的榜单条目</h3>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-7 h-7 rounded-full liquid-glass-subtle flex items-center justify-center hover:text-white transition-colors"
                  aria-label="关闭认领弹窗"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed mb-3">
                选择榜单上属于你的条目（未绑定邮箱的匿名条目），提交后由管理员审批。
              </p>

              {/* 搜索 */}
              <div className="relative mb-2.5">
                <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="搜索玩家名…"
                  aria-label="搜索可认领条目"
                  className="w-full liquid-glass-subtle rounded-[var(--radius-liquid-md)] pl-9 pr-3 py-2 text-[12px] text-white placeholder:text-muted-foreground/70 outline-none border border-white/10 focus:border-secondary-foreground/40 transition-colors"
                />
              </div>

              {/* 可认领列表 */}
              <div className="max-h-56 overflow-y-auto custom-scrollbar rounded-[var(--radius-liquid-md)] border border-white/5 -mx-0.5 px-0.5" role="listbox" aria-label="可认领条目列表">
                {filtered.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-[11px] text-muted-foreground">
                      {claimable.length === 0 ? '当前没有可认领的条目' : '没有匹配的条目'}
                    </p>
                  </div>
                ) : (
                  filtered.map(p => {
                    const selected = p.id === selectedId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => setSelectedId(selected ? null : p.id)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all mb-1',
                          selected
                            ? 'bg-secondary/20 border border-secondary-foreground/40'
                            : 'border border-transparent hover:bg-white/[0.06]',
                        )}
                      >
                        <span
                          className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                          style={{ background: getAvatarColor(p.name) }}
                          aria-hidden="true"
                        >
                          {getAvatarInitial(p.name)}
                        </span>
                        <span className="text-[12px] font-semibold text-white truncate flex-1">{p.name}</span>
                        {selected && <ShieldCheck className="w-4 h-4 text-jade-400 flex-shrink-0" />}
                      </button>
                    );
                  })
                )}
              </div>

              {/* 错误提示 */}
              {error && (
                <p className="text-[11px] text-destructive bg-destructive/10 border border-destructive/25 rounded-lg px-3 py-2 mt-2.5" role="alert">
                  {error}
                </p>
              )}

              {/* 红线提示（写进 UI） */}
              <p className="text-[10px] text-destructive/90 leading-relaxed mt-3 flex items-start gap-1.5">
                <span aria-hidden="true">🔒</span>
                <span>认领仅用于身份绑定，不影响任何分数、段位或感动榜数据</span>
              </p>

              {/* 提交 */}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!selectedId || submitting}
                aria-label="提交认领请求"
                className={cn(
                  'w-full mt-3 rounded-[var(--radius-liquid-md)] px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-semibold transition-all active:scale-[0.98]',
                  selectedId
                    ? 'bg-secondary text-secondary-foreground hover:bg-secondary/90'
                    : 'bg-white/5 text-muted-foreground cursor-not-allowed',
                  submitting && 'opacity-60 cursor-wait',
                )}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? '提交中…' : '提交认领请求'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
