'use client';

// ============================================================
// Tier Workspace V2 · SECTION 04 双表核对（独立只读辅助模块）
// ------------------------------------------------------------
// 工单 §三.S4：分别展示收集表与整理表；每张表显示连接状态/工作表名称/
//   实际读取数量/最近读取时间/读取是否成功；核对六分类可点击查看记录。
// 纪律：两表分别读取、任一失败如实标注（绝不把失败显示为成功、绝不把
//   未读取的表显示为已核对）；纯只读不写库；不改变单表同步通道。
// 布局：桌面两表并排；移动单列。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Table2, Loader2, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { SPRING_EXPAND, NO_MOTION, WS } from './constants';
import { WSBadge } from './primitives';

// ---------- API 契约（/api/v1/tier-command/inventory-compare） ----------

interface TabReadResult {
  tabId: string; tabName: string; ok: boolean;
  fetchedAt: string | null; rowCount: number | null;
  headers: string[] | null; error: string | null; docErrorCode: string | null;
  identityUncertain: Array<{ tabId: string; rowIndex: number; rawName: string; note: string }>;
  notes: string[];
}

interface ComparisonPayload {
  identical: boolean; matchedCount: number;
  onlyLedger: Array<{ rowIndex: number; preview: string }>;
  onlyCollect: Array<{ rowIndex: number; preview: string }>;
  contentDiff: Array<{ rowALabel: string; rowBLabel: string; diffs: Array<{ label: string; a: string; b: string }> }>;
  identityUncertain: Array<{ tabId: string; rowIndex: number; rawName: string; note: string }>;
  duplicatesLedger: Array<{ count: number; preview: string }>;
  duplicatesCollect: Array<{ count: number; preview: string }>;
}

interface CompareResponse {
  ok: boolean;
  fetchedAt?: string;
  tabs?: TabReadResult[];
  comparison?: ComparisonPayload | null;
  notes?: string[];
  message?: string; error?: string;
}

type DiffTab = 'same' | 'onlyLedger' | 'onlyCollect' | 'diff' | 'identity' | 'dupes';

const DIFF_TABS: Array<{ key: DiffTab; label: string }> = [
  { key: 'same', label: '两表相同' },
  { key: 'onlyLedger', label: '仅整理表存在' },
  { key: 'onlyCollect', label: '仅收集表存在' },
  { key: 'diff', label: '内容存在差异' },
  { key: 'identity', label: '身份待确认' },
  { key: 'dupes', label: '重复记录' },
];

// ---------- 共享 fetcher（纯取数，无 setState） ----------

async function fetchCompare(): Promise<{ ok: boolean; json: CompareResponse | null; errorMsg: string | null }> {
  try {
    const res = await adminFetch('/api/v1/tier-command/inventory-compare');
    const json = (await res.json()) as CompareResponse;
    if (!res.ok || !json.ok) {
      return { ok: false, json: null, errorMsg: json.message || json.error || `双表核对失败（HTTP ${res.status}）` };
    }
    return { ok: true, json, errorMsg: null };
  } catch {
    return { ok: false, json: null, errorMsg: '双表核对请求发送失败（网络异常），请稍后重试' };
  }
}

export function TwoTabSection({ reduced }: { reduced: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('loading');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<DiffTab>('same');
  const spring = reduced ? NO_MOTION : SPRING_EXPAND;

  // 首次加载（setState 全部在 await 后；卸载守卫）
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetchCompare();
      if (!alive) return;
      setData(r.json);
      setError(r.ok ? null : r.errorMsg);
      setPhase(r.ok ? 'done' : 'error');
    })();
    return () => { alive = false; };
  }, []);

  // 手动重新核对（事件侧调用）
  const load = useCallback(async () => {
    const r = await fetchCompare();
    setData(r.json);
    setError(r.ok ? null : r.errorMsg);
    setPhase(r.ok ? 'done' : 'error');
  }, []);

  const tabs = data?.tabs ?? [];
  const cmp = data?.comparison ?? null;

  const counts: Record<DiffTab, number> = {
    same: cmp ? cmp.matchedCount : 0,
    onlyLedger: cmp?.onlyLedger.length ?? 0,
    onlyCollect: cmp?.onlyCollect.length ?? 0,
    diff: cmp?.contentDiff.length ?? 0,
    identity: cmp?.identityUncertain.length ?? 0,
    dupes: (cmp?.duplicatesLedger.length ?? 0) + (cmp?.duplicatesCollect.length ?? 0),
  };

  return (
    <div className="flex flex-col gap-3" data-testid="ws-twotab">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { setPhase('loading'); void load(); }}
          disabled={phase === 'loading'}
          aria-busy={phase === 'loading'}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:bg-white/[0.08] active:scale-[0.97] disabled:opacity-50"
        >
          {phase === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          {phase === 'loading' ? '双表读取中…（限频窗口自动等待）' : '重新读取并核对'}
        </button>
        <span className={`text-[10px] ${WS.faintText}`}>只读拉取腾讯文档两张工作表（不写库 / 不改文档 / 不影响单表同步通道）</span>
      </div>

      {phase === 'error' && error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* 两表状态卡（并排；独立成败） */}
      <div className="grid gap-2.5 md:grid-cols-2">
        {tabs.map(t => (
          <div key={t.tabId} className={`rounded-xl border p-3 ${t.ok ? 'border-emerald-400/20 bg-[rgba(14,20,16,0.65)]' : 'border-orange-500/30 bg-orange-500/[0.05]'}`}>
            <div className="flex items-center gap-2">
              <Table2 className="h-3.5 w-3.5 shrink-0 text-[#93a89a]" aria-hidden="true" />
              <span className="min-w-0 truncate text-xs font-bold text-white">{t.tabName}</span>
              <span className="font-mono text-[10px] text-[#6d7f72]">{t.tabId}</span>
              {t.ok ? (
                <WSBadge label="读取成功" cls="ml-auto border-emerald-400/25 bg-emerald-400/10 text-emerald-300" />
              ) : (
                <WSBadge label="读取失败" cls="ml-auto border-orange-500/30 bg-orange-500/10 text-orange-300" />
              )}
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-[#93a89a]">
              <span>实际读取数量：<b className="text-white/85">{t.rowCount ?? '—'}</b> 行</span>
              <span>最近读取：<b className="text-white/85">{t.fetchedAt ? t.fetchedAt.slice(0, 19).replace('T', ' ') : '未读取'}</b></span>
            </div>
            {!t.ok && t.error && (
              <p className="mt-1 text-[10px] leading-relaxed text-orange-300">
                失败原因：{t.error}{t.docErrorCode ? `（${t.docErrorCode}）` : ''} —— 本次不产出该表比对结论，绝不把失败显示为成功。
              </p>
            )}
            {t.notes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[10px] text-amber-300/80">
                {t.notes.map((n, i) => <li key={i}>⚠ {n}</li>)}
              </ul>
            )}
          </div>
        ))}
        {phase === 'loading' && tabs.length === 0 && (
          <>
            <div className="h-24 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
            <div className="h-24 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
          </>
        )}
      </div>

      {/* 核对结论 / 六分类 */}
      {phase === 'done' && !cmp && (
        <div role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-200/90">
          至少一张工作表读取失败 —— 本次不产出比对结论（绝不对残缺数据下结论）。请稍后重试。
        </div>
      )}
      {phase === 'done' && cmp && (
        <>
          <div
            role="status"
            className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
              cmp.identical
                ? 'border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300'
                : 'border-amber-400/30 bg-amber-400/[0.07] text-amber-200/90'
            }`}
          >
            {cmp.identical
              ? `比对结论：两表数据行一比一完全重复（${cmp.matchedCount} 行一致）—— 按批复维持单表同步（整理表 y344e4）即可。`
              : `比对结论：两表存在差异（一致 ${cmp.matchedCount} 行 · 仅整理表 ${cmp.onlyLedger.length} 行 · 仅收集表 ${cmp.onlyCollect.length} 行 · 内容差异 ${cmp.contentDiff.length} 组）。收集表中的新工单不会自动进入同步链路，需人工整理进整理表后方可见（程序不跨表取数）。`}
          </div>

          {/* 六分类标签 */}
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="核对分类">
            {DIFF_TABS.map(t => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeDiff === t.key}
                onClick={() => setActiveDiff(t.key)}
                className={`relative inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${
                  activeDiff === t.key ? 'text-white' : 'text-[#93a89a] hover:text-white'
                }`}
              >
                {activeDiff === t.key && (
                  <motion.span
                    layoutId={reduced ? undefined : 'ws-diff-pill'}
                    transition={spring}
                    className="absolute inset-0 rounded-lg border border-[rgba(191,90,242,0.45)] bg-[rgba(191,90,242,0.14)]"
                    aria-hidden="true"
                  />
                )}
                <span className="relative">{t.label}</span>
                <span className="relative rounded-full bg-black/30 px-1.5 text-[9px] font-mono">{counts[t.key]}</span>
              </button>
            ))}
          </div>

          {/* 分类内容 */}
          <motion.div
            key={activeDiff}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="min-h-[80px] rounded-xl border border-white/[0.06] bg-black/20 p-3"
          >
            {activeDiff === 'same' && (
              <p className="text-[11px] text-[#93a89a]">
                两表业务字段完全一致的行：<b className="text-white/90">{cmp.matchedCount}</b> 组。
                {cmp.identical ? '全部数据行一致。' : '其余行见其它分类。'}
              </p>
            )}
            {activeDiff === 'onlyLedger' && (
              <RowList empty="（无）仅整理表存在的行为 0 —— 收集表全部行都在整理表中有对应或存在差异" rows={cmp.onlyLedger} />
            )}
            {activeDiff === 'onlyCollect' && (
              <RowList
                empty="（无）仅收集表存在的行为 0"
                rows={cmp.onlyCollect}
                foot="这些行不会自动进入同步链路；需人工整理进整理表后才会被同步（程序不跨表取数）。"
              />
            )}
            {activeDiff === 'diff' && (
              cmp.contentDiff.length === 0 ? (
                <p className={`text-[11px] ${WS.faintText}`}>（无）未发现「同一测试者+日期+项目」但内容不同的配对行</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {cmp.contentDiff.map((p, i) => (
                    <div key={i} className="rounded-lg border border-white/[0.06] bg-[rgba(12,18,14,0.6)] p-2.5 text-[11px]">
                      <p className="mb-1 font-bold text-white/85">{p.rowALabel} ↔ {p.rowBLabel}</p>
                      <ul className="space-y-0.5">
                        {p.diffs.map((d, j) => (
                          <li key={j} className="text-[#93a89a]">
                            <span className="font-bold text-amber-300/90">{d.label}</span>：整理表「{d.a || '（空）'}」↔ 收集表「{d.b || '（空）'}」
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )
            )}
            {activeDiff === 'identity' && (
              cmp.identityUncertain.length === 0 ? (
                <p className="text-[11px] text-emerald-300/85">（无）两表「测试者」列均通过名称与 Tier 分离识别检查</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[11px] text-amber-300">名称与 Tier 疑似混淆，已暂停自动处理，请管理员核对：</p>
                  {cmp.identityUncertain.map((u, i) => (
                    <div key={i} className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5 text-[11px]">
                      <span className="font-mono text-amber-200">{u.tabId}</span>
                      <span className="ml-2 text-white/85">行{u.rowIndex} ·「{u.rawName}」</span>
                      <span className="mt-0.5 block text-[10px] text-amber-200/75">{u.note}</span>
                    </div>
                  ))}
                </div>
              )
            )}
            {activeDiff === 'dupes' && (
              (cmp.duplicatesLedger.length === 0 && cmp.duplicatesCollect.length === 0) ? (
                <p className="text-[11px] text-emerald-300/85">（无）两表内部均无业务字段完全一致的重复行</p>
              ) : (
                <div className="flex flex-col gap-2 text-[11px]">
                  {cmp.duplicatesLedger.length > 0 && (
                    <div>
                      <p className="mb-1 font-bold text-white/85">整理表内重复（{cmp.duplicatesLedger.length} 组）—— 同步侧按幂等键合并，绝不重复归档：</p>
                      {cmp.duplicatesLedger.map((g, i) => (
                        <p key={i} className="text-[#93a89a]">· {g.count} 行：{g.preview}</p>
                      ))}
                    </div>
                  )}
                  {cmp.duplicatesCollect.length > 0 && (
                    <div>
                      <p className="mb-1 font-bold text-white/85">收集表内重复（{cmp.duplicatesCollect.length} 组）—— 归档台账按 bizKey 完全一致才合并：</p>
                      {cmp.duplicatesCollect.map((g, i) => (
                        <p key={i} className="text-[#93a89a]">· {g.count} 行：{g.preview}</p>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}
          </motion.div>

          {(data?.notes ?? []).length > 0 && (
            <ul className={`space-y-0.5 text-[10px] ${WS.faintText}`}>
              {(data?.notes ?? []).map((n, i) => <li key={i}>· {n}</li>)}
            </ul>
          )}
        </>
      )}

      <div className="flex items-start gap-1.5 text-[10px] leading-relaxed text-[#6d7f72]">
        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>双表核对为独立辅助模块：原始记录不删除、每条整理结果可追溯到来源行号；读取失败不会误报为成功，未读取的表不会显示为已核对。</span>
      </div>
    </div>
  );
}

function RowList({ rows, empty, foot }: { rows: Array<{ rowIndex: number; preview: string }>; empty: string; foot?: string }) {
  if (rows.length === 0) {
    return (
      <div>
        <p className="text-[11px] text-emerald-300/85">{empty}</p>
        {foot && <p className={`mt-1 text-[10px] ${WS.faintText}`}>{foot}</p>}
      </div>
    );
  }
  return (
    <div>
      <div className="max-h-40 space-y-0.5 overflow-y-auto custom-scrollbar">
        {rows.map(r => (
          <div key={r.rowIndex} className="truncate text-[10px] text-[#93a89a]">
            <span className="font-mono text-[#6d7f72]">行{r.rowIndex}</span> {r.preview}
          </div>
        ))}
      </div>
      {foot && <p className={`mt-1 text-[10px] ${WS.faintText}`}>{foot}</p>}
    </div>
  );
}
