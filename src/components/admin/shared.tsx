'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L48-L115），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：管理面板跨页签共享件（ConfirmDialog + 弹层 z 层常量）。
// ============================================================
import { Loader2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// 管理后台弹层统一抬升到 z-[200]：AdminPanel 容器是 z-[100] 的 fixed modal，
// shadcn Dialog/Sheet 默认 z-50 会被压在下面——所有 Portal 弹层显式提层。
export const OVERLAY_Z = 'z-[200]';
export const CONFIRM_PANEL = `${OVERLAY_Z} liquid-glass-strong border-white/10 rounded-[var(--radius-liquid-lg)]`;

// ============================================================
// ConfirmDialog — 破坏性操作二次确认（P2-1）。
// 受控模式：open + onOpenChange + onConfirm；确认中禁用按钮防连点。
// 替换散落各 tab 的 window.confirm()/alert()（原生弹窗阻塞主线程、
// 无主题样式、单行删除/日志清除/存档恢复此前甚至零确认）。
// ============================================================
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, onConfirm, destructive = true, busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={o => { if (!o && !busy) onOpenChange(false); }}>
      <AlertDialogContent className={CONFIRM_PANEL}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={e => { e.preventDefault(); onConfirm(); }}
            disabled={busy}
            className={destructive
              ? 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500'
              : 'bg-jade-500 text-jade-900 hover:bg-jade-400 focus-visible:ring-jade-500'}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
