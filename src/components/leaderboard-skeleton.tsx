// ============================================================
// Component: LeaderboardSkeleton — 榜单加载骨架屏（CG-1 现成组件替换）
// 基件：shadcn/ui Skeleton（项目内建 ui/skeleton.tsx，MIT）
// 替换：原纯 spinner（无形状预示，加载完成布局跳动）
// 形状：按 DOM 序复刻 PodiumStrip（3 cell，1.25fr/1fr/1fr 网格）
//   + lgx-row 主行（6 行）→ 加载完成零布局跳动（CLS≈0）
// 暂停契约：pausedMotion（MotionConfig 不覆盖 CSS 动画 → 此处显式
//   animate-none）+ prefers-reduced-motion（motion-reduce:animate-none）
// ============================================================
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppStore } from '@/lib/store';

export function LeaderboardSkeleton() {
  const pausedMotion = useAppStore((s) => s.pausedMotion);
  const sk = cn('bg-white/[0.06]', pausedMotion ? 'animate-none' : 'motion-reduce:animate-none');
  return (
    <div className="px-4 lg:px-3 mb-4" role="status" aria-label="榜单加载中">
      {/* 前三领奖台占位 — 与 .lgx-podium 同网格同 DOM 序（1.25fr/1fr/1fr） */}
      <div className="lgx-podium" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <div key={i} className="lgx-podium-cell">
            <Skeleton className={cn(sk, 'h-3 w-9 rounded-sm')} />
            <Skeleton className={cn(sk, 'h-10 w-10 rounded-[10px]')} />
            <Skeleton className={cn(sk, 'h-3 w-16 rounded-sm')} />
            <Skeleton className={cn(sk, 'h-2.5 w-12 rounded-sm')} />
          </div>
        ))}
      </div>
      {/* 榜单行占位 — 复刻 lgx-row 主行结构（rank/skin/名字/段位/评分） */}
      <div className="mt-2 space-y-1" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="lgx-row pointer-events-none">
            <div className="lgx-row-main">
              <Skeleton className={cn(sk, 'h-3.5 w-6 rounded-sm')} />
              <Skeleton className={cn(sk, 'h-[34px] w-[34px] rounded-[10px]')} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className={cn(sk, 'h-3 w-24 max-w-[42%] rounded-sm')} />
                <Skeleton className={cn(sk, 'h-2 w-16 max-w-[30%] rounded-sm')} />
              </div>
              <Skeleton className={cn(sk, 'h-4 w-11 rounded-md')} />
              <Skeleton className={cn(sk, 'h-3 w-7 rounded-sm')} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
