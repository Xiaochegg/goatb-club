'use client';

import React, { useEffect, useState } from 'react';
import { Heart, Sword, Trophy, Users } from 'lucide-react';
import { cachedFetchJSON } from '@/lib/client-cache';

// ============================================================
// Component: ServerStatusBar — one honest strip of real numbers
// 拆分自 src/app/page.tsx (split-footer, 2026-10)
// C2/C3（2026-11-03）：stats+seasons 经 client-cache 共享缓存（TTL 45s），
// 与侧栏/头部请求收敛；无 polling；失败静默（additive）。
// ============================================================
function ServerStatusBar() {
  const [info, setInfo] = useState<{
    players: number; likes: number; kd: string; winRate: string;
    seasonName: string | null; seasonDay: number | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // C2/C3：经 client-cache 与侧栏（stats）/头部（seasons）共享同一缓存条目，
        // 页脚不再独立发重复请求；失败静默语义不变。
        const [statsData, seasonsData] = await Promise.all([
          cachedFetchJSON<{ overview?: { totalPlayers?: number; totalLikes?: number; aggStats?: { kd?: string; winRate?: string } } }>('/api/v1/stats'),
          cachedFetchJSON<{ seasons?: Array<{ status: string; name: string; startAt?: string | null }> }>('/api/v1/seasons'),
        ]);
        if (cancelled) return;
        const active = (seasonsData.seasons || []).find((s: { status: string }) => s.status === 'ACTIVE');
        let seasonDay: number | null = null;
        if (active?.startAt) {
          const started = new Date(active.startAt).getTime();
          if (!Number.isNaN(started)) seasonDay = Math.max(1, Math.floor((Date.now() - started) / 86400000) + 1);
        }
        setInfo({
          players: statsData.overview?.totalPlayers ?? 0,
          likes: statsData.overview?.totalLikes ?? 0,
          kd: statsData.overview?.aggStats?.kd ?? '—',
          winRate: statsData.overview?.aggStats?.winRate ?? '—',
          seasonName: active?.name ?? null,
          seasonDay,
        });
      } catch {
        // Status strip is additive — absence is graceful
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;
  return (
    // V3：WidgetDock FAB 下线，原移动端 pr-[68px] 让位区取消，状态胶囊恢复居中。
    <div className="flex items-center justify-center min-w-0">
      {/* flex-wrap + max-w-full：200% 字号 / 窄屏时状态项换行而非撑破容器 */}
      <div className="liquid-glass-subtle v2l-card rounded-full px-4 py-1.5 flex flex-wrap items-center justify-center gap-2.5 text-[0.625rem] text-white/50 border border-white/5 max-w-full min-w-0" role="status" aria-label="服务器状态">
        <span className="flex items-center gap-1"><Users className="w-3 h-3" />{info.players} 名玩家</span>
        <span className="w-px h-3 bg-white/10" aria-hidden="true" />
        <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{info.likes} 赞</span>
        <span className="w-px h-3 bg-white/10" aria-hidden="true" />
        <span className="flex items-center gap-1"><Sword className="w-3 h-3" />K/D {info.kd} · 胜率 {info.winRate}</span>
        {info.seasonName && (
          <>
            <span className="w-px h-3 bg-white/10" aria-hidden="true" />
            <span className="flex items-center gap-1 text-jade-400/80"><Trophy className="w-3 h-3" />{info.seasonName}{info.seasonDay ? ` · 第 ${info.seasonDay} 天` : ' · 进行中'}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Component: MusicCopyrightNotice — 版权声明条（P2 壳预渲染 SSR 化，批复 2026-11-08「开工P2」）
//
// 动机（P2 只读诊断，2026-11-08）：该条原由音乐播放器空闲链延迟注入
// （水合后 requestIdleCallback → config/api/init/copyright 四脚本 →
// notice.js 末位执行），实测成为 desktop/mobile LCP 终值元素
// （id=music-copyright-notice，size 39324，冷轮 dev ~5.4s 才绘制）。
// SSR 化后随首帧在初始 HTML 中绘制，LCP 收敛到真实内容上屏时刻。
//
// 唯一真值源说明：文本/样式复制自 public/js/music-copyright-notice.js
// （冻结件，本批零改动）。该脚本内置 hasNotice() 幂等守卫——检测到本
// 元素存在即整体跳过注入，脚本保留作「footer 缺失时自愈兜底」。
// ⚠️ 双侧同步约束：修改版权文本/样式必须同步 music-copyright-notice.js
//    的 INLINE_STYLE 与 HTML 常量（两处同源，任一侧改动须双侧对齐）。
// ============================================================
const NOTICE_STYLE: React.CSSProperties = {
  width: '100%',
  textAlign: 'center',
  color: 'rgba(255,255,255,0.28)',
  fontSize: '10px',
  lineHeight: 1.6,
  padding: '6px 12px 0',
  marginTop: '4px',
  borderTop: '1px solid rgba(255,255,255,0.04)',
  letterSpacing: '0.02em',
};

// 文本与 music-copyright-notice.js 的 HTML 常量逐字同源（含缩进换行，
// 渲染层空白折叠后视觉一致）
const NOTICE_TEXT = `
    本站为非盈利个人项目，音乐播放器仅供个人学习、研究及非商业交流使用。
    所有音频通过第三方公开 API 实时流式获取（仅做流式播放传输，不下载、不存储、不缓存），版权归原作者及原音乐平台所有。
    本站不存储任何音频文件，不提供下载，不用于任何商业用途。
    特别声明：本站核心音乐内容「小车」的原创歌曲版权归其本人所有。
    如版权方有异议，请联系删除。
  `;

// ============================================================
// Component: Footer — minimal brand line (above dock space)
// ============================================================
export function Footer() {
  return (
    // V3（trace 1a1d6d98a9b358a5）：WidgetDock FAB 已随统一液态玻璃 Dock 下线，
    // 移动端右侧 68px 让位区取消；桌面底部新增 76px dock 空间预算
    // （dock 高约 64px + 12px 呼吸缝）——版权声明不再沉入 dock 之下。
    // 移动端 84px 预算维持（5 项胶囊与旧 4 项同高）。
    <footer className="mt-auto px-6 pt-4 pb-[calc(max(env(safe-area-inset-bottom),16px)+84px)] lg:pb-[calc(max(env(safe-area-inset-bottom),16px)+76px)] flex flex-col items-center gap-2.5">
      <ServerStatusBar />
      {/* Arena Console V2.0：品牌行文字对比档统一走 --ink-lo（外围视觉，逻辑不变） */}
      <span className="text-[10px] tracking-wider" style={{ color: 'var(--ink-lo)' }}>GOATB · Design Engineering 2026</span>
      {/* P2 壳预渲染：版权声明条 SSR 化（置于 footer 末位 = 原 appendChild 位置） */}
      <div id="music-copyright-notice" style={NOTICE_STYLE}>{NOTICE_TEXT}</div>
    </footer>
  );
}
