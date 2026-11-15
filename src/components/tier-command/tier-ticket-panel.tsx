'use client';

// ============================================================
// Tier Command · 工单面板（P1-C 同步 → P2 审批写榜 → T6 五态 → R2 分组审核）
// ------------------------------------------------------------
// R2 分组审核与回档（2026-11-06，用户拍板需求逐条落地）：
//  1. 按「测试者」（F 列被测玩家 = 写榜对象/积分产生者）分组堆叠全部记录，
//     组内按测试日期+提交时间从新到旧；换考核者仍同组；考核者相同但测试者
//     不同不合并；被测玩家身份不确定（游戏 id 为空）归入「待核实」桶（置底）；
//  2. 每条记录独立保留（日期/提交时间/考核者/项目/tier/胜场/评价/审核状态），
//     不合并多次测试；
//  3. 重复检测：多字段组合键（测试者+日期+考核者+项目+tier）疑似重复徽章，
//     对方已写入 → 防重复录入强信号；同内容硬拦截仍由后端 cfp1 门禁承担；
//  4. 管理员可勾选任意一条或多条单独写入（无整组强制，无全选，硬约束不变）；
//  5. 每条记录独立「通过（写入）」勾选与「拒绝」按钮；拒绝持久化（跨同步），
//     后续同步不再作为候选；仅「撤销拒绝」恢复；不删腾讯文档原始数据，
//     不影响该测试者未来新记录；
//  6. 每位测试者组头汇总：记录数/最近测试日期/考核者/模式/目标 tier/处理状态；
//  7. 「总览日志」旁独立「回档」按钮：弹窗列出可回档历史写入（时间/操作人/
//     涉及记录/变更内容），选择性勾选回档；恢复范围（tiers 单字段）+ 二次
//     确认；执行时逐项复核（当前段位≠写入结果 → 阻止并注明原因，不覆盖
//     回档后新记录）；失败不显示成功；无可靠备份/范围不明禁止执行。
// R3 双表盘点与清空保护（2026-11-07，管理员批复）：
//  8. 「双表盘点」卡片：只读拉取 687 收集表 + 整理表 raw 矩阵 + 业务列比对
//     （批复：两个表都要看；一比一全部重复 → 维持单表同步即可；
//     程序不自动跨表取数，687 表新工单需人工整理进整理表后才会同步）；
//  9. 文档清空保护：同步检测到文档被清空 → 自动化缓存导入重置展示
//     （从批次快照缓存 tier_command_batch_cache 原样恢复；水位/审批/文档零改动）。
// 绝对硬约束（用户指令 2026-11-04，沿用不变）：
//  1. AI 只出建议（advisoryOnly），绝不执行写操作、绝不自动勾选；
//  2. 每行必须管理员手动勾选，无预设勾选/默认全选/一键全选；
//  3. 「确认写入」初始禁用，≥1 行手动勾选后启用，二次确认后才发请求；
//  4. 跳过行须先勾「创建并写入」；失败行不可写入；
//  5. 写榜对象 = ⑥列被测玩家（服务端 targetName 真值防篡改）。
// ============================================================

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History, Loader2, RefreshCw, Undo2, AlertTriangle, Archive, Table2 } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { TierLedgerSection } from '@/components/tier-command/tier-ledger-section';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ALL_MODES, MODE_LABELS, type GameMode } from '@/lib/constants';

// ---------- 类型（与 sync / approve / review / rollback API 对齐） ----------

interface AiSuggestion {
  verdict: 'approve' | 'doubt' | 'reject';
  reasons: string[];
  advisoryOnly: true;
}

interface ApprovedInfo {
  at: string;
  by: string;
  tier: string;
  mode: string;
  playerId: string | null;
  playerName: string;
  created: boolean;
  logId: string | null;
}

/** T6：内容变更 diff 项（与 T4 状态机 ContentDiffItem 对齐） */
interface ContentDiffItem {
  field: string;
  label: string;
  oldDisplay: string;
  newDisplay: string;
  informationalOnly: boolean;
}

/** T6：审批继承五态（与 T4 状态机 InheritanceDecision 对齐，UI 子集透传） */
type InheritanceState =
  | 'A_INHERITED' | 'B_CONTENT_CHANGED' | 'C_AMBIGUOUS' | 'D_NO_MATCH' | 'LEGACY_UNVERIFIED';

interface InheritanceInfo {
  state: InheritanceState;
  matchedBy: string;
  matchedKeys: string[];
  matchedFirstSeenAt: string | null;
  inheritedApproved: ApprovedInfo | null;
  legacyApprovedUnverified: ApprovedInfo | null;
  changedFields: ContentDiffItem[];
  ambiguity: string | null;
  duplicateInBatch: boolean;
  summary: string;
}

interface SyncRow {
  rowIndex: number;
  cells: {
    submitter: string;
    submittedAt: string;
    project: string;
    testDate: string;
    tester: string;
    testee: string;
    testTier: string;
    score: string;
    recording: string;
    testeeWins: string;
    testerWins: string;
    review: string;
    legacyReview: string;
  };
  status: 'READY' | 'PLAYER_MISSING' | 'INVALID';
  reasons: string[];
  playerMatch: {
    tester: { status: string; playerName: string | null; pendingEntry: boolean };
    testee: { status: string; playerName: string | null; pendingEntry: boolean };
  };
  fingerprint: string;
  isDuplicate: boolean;
  /** T6：审批继承状态机判定（T4 同步响应透传；旧载荷缺省） */
  inheritance?: InheritanceInfo;
  aiSuggestion: AiSuggestion;
  approved: ApprovedInfo | null;
  modeHint: { mode: string | null; confidence: string };
  /** R2：管理员拒绝标记（持久化；非候选，仅撤销恢复） */
  reviewRejected?: { at: string; by: string; reason: string | null } | null;
  /** R2：回档标记（历史写入已被恢复；重写须确认） */
  rolledBack?: { at: string; by: string } | null;
  /** R2：多字段疑似重复命中（测试者+日期+考核者+项目+tier） */
  dupSuspects?: Array<{ rowIndex: number; approved: boolean; at: string | null }>;
}

interface SyncResponse {
  ok: boolean;
  dryRun: boolean;
  fetchedAt: string;
  docRowCount: number;
  parsedCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  newCount: number;
  duplicateCount: number;
  rows: SyncRow[];
  warnings: string[];
  message?: string;
  error?: string;
  /** R3：清空保护 meta（同步检测到文档被清空时存在；旧载荷缺省） */
  meta?: {
    clearedDetected?: boolean;
    cacheFallback?: { savedAt: string; rowCount: number } | null;
  };
}

interface ApproveRowResult {
  rowIndex: number;
  fingerprint: string;
  playerName: string | null;
  status: 'APPROVED' | 'REJECTED';
  code?: string;
  message?: string;
  playerId?: string;
  created?: boolean;
  logId?: string | null;
}

interface ApproveResponse {
  ok: boolean;
  approvedCount: number;
  rejectedCount: number;
  results: ApproveRowResult[];
  message?: string;
  error?: string;
}

/** R2：拒绝/撤销拒绝响应 */
interface ReviewResponse {
  ok: boolean;
  action: string;
  okCount: number;
  failCount: number;
  results: Array<{ fingerprint: string; status: 'OK' | 'FAILED'; message?: string }>;
  message?: string;
  error?: string;
}

/** R2：回档候选 */
interface RollbackCandidate {
  logId: string;
  at: string;
  operator: string;
  rowIndex: number | null;
  playerName: string | null;
  mode: string | null;
  tierFrom: string | null;
  tierTo: string | null;
  created: boolean;
  fingerprint: string | null;
  stateRolledBack: boolean;
  currentTier: string | null;
  restoreTierDisplay: string;
  rollbackable: boolean;
  blockedReason: string | null;
}

interface RollbackResponse {
  ok: boolean;
  rolledBackCount: number;
  failedCount: number;
  results: Array<{ logId: string; playerName: string | null; status: 'ROLLED_BACK' | 'FAILED'; message?: string }>;
  message?: string;
  error?: string;
}

// ---------- 展示辅助 ----------

const STATUS_BADGE: Record<SyncRow['status'], { label: string; cls: string }> = {
  READY: { label: '✓ 成功', cls: 'bg-jade-500/15 text-jade-400 border-jade-500/30' },
  PLAYER_MISSING: { label: '⏭ 跳过 · 待建条目', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  INVALID: { label: '✗ 失败', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

const AI_BADGE: Record<AiSuggestion['verdict'], { label: string; cls: string }> = {
  approve: { label: '建议通过', cls: 'bg-jade-500/15 text-jade-400 border-jade-500/30' },
  doubt: { label: '存疑', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  reject: { label: '建议拒绝', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

/** T6：审批关联五态徽章（A 态命中历史审批时由调用方覆写 label） */
const INHERITANCE_BADGE: Record<InheritanceState, { label: string; cls: string }> = {
  A_INHERITED: { label: 'A · 内容一致', cls: 'bg-jade-500/15 text-jade-400 border-jade-500/30' },
  B_CONTENT_CHANGED: { label: 'B · 内容已变更', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  C_AMBIGUOUS: { label: 'C · 归属歧义', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  D_NO_MATCH: { label: 'D · 新工单', cls: 'bg-white/5 text-white/60 border-white/15' },
  LEGACY_UNVERIFIED: { label: 'L · 存量待核验', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
};

/** R2：总览日志四类徽章 */
const LOG_KIND_BADGE: Record<string, { label: string; cls: string }> = {
  approve: { label: '写入', cls: 'bg-jade-500/15 text-jade-300 border-jade-500/30' },
  rollback: { label: '回档', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  reject: { label: '拒绝', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  restore: { label: '撤销拒绝', cls: 'bg-white/5 text-white/60 border-white/15' },
};

/** T6：审批关联列详情文案（B=逐字段 diff / C=歧义说明 / L=存证+说明；其余=summary） */
function inheritanceDetail(r: SyncRow): string {
  const inh = r.inheritance;
  if (!inh) return '';
  if (inh.state === 'B_CONTENT_CHANGED' && inh.changedFields.length > 0) {
    return inh.changedFields
      .map(f => `${f.label}：${f.oldDisplay} → ${f.newDisplay}${f.informationalOnly ? '（仅展示，不入指纹）' : ''}`)
      .join('\n');
  }
  if (inh.state === 'C_AMBIGUOUS') return inh.ambiguity ?? inh.summary;
  if (inh.state === 'LEGACY_UNVERIFIED') {
    const ref = inh.legacyApprovedUnverified;
    const ev = ref
      ? `原审批存证：${ref.by} @ ${ref.at.slice(0, 10)} 写入 ${ref.tier}/${ref.mode}`
      : '历史条目无内容快照，内容一致性不可核实';
    return `${ev}\n${inh.summary}`;
  }
  return inh.summary;
}

function fmtShortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return String(iso).slice(0, 19).replace('T', ' ');
}

function fmtLogTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- R2：按测试者分组（纯展示层计算，不改后端语义） ----------

const UNVERIFIED_KEY = '__UNVERIFIED__';

interface RowGroup {
  key: string;
  /** 组名（测试者游戏 id；待核实桶为空） */
  testee: string;
  /** 身份不确定（游戏 id 为空，无法确认写榜对象）→ 待核实 */
  uncertain: boolean;
  /** 任一行测试者玩家缺失（待建条目） */
  missingPlayer: boolean;
  rows: SyncRow[];
  /** 组内最新测试日期（'YYYY-MM-DD'；空为 ''） */
  latestDate: string;
}

function buildGroups(rows: SyncRow[]): RowGroup[] {
  const map = new Map<string, RowGroup>();
  for (const r of rows) {
    const testee = (r.cells.testee ?? '').trim();
    const uncertain = testee === '';
    const key = uncertain ? UNVERIFIED_KEY : testee;
    let g = map.get(key);
    if (!g) {
      g = { key, testee, uncertain, missingPlayer: false, rows: [], latestDate: '' };
      map.set(key, g);
    }
    if (r.playerMatch.testee.status === 'MISSING') g.missingPlayer = true;
    g.rows.push(r);
    const d = (r.cells.testDate ?? '').slice(0, 10);
    if (d > g.latestDate) g.latestDate = d;
  }
  const groups = [...map.values()];
  // 组内：测试日期从新到旧 → 提交时间从新到旧 → 行号从大到小
  for (const g of groups) {
    g.rows.sort((a, b) => {
      const da = (a.cells.testDate ?? '').slice(0, 10);
      const dbb = (b.cells.testDate ?? '').slice(0, 10);
      if (da !== dbb) return dbb.localeCompare(da);
      const sa = a.cells.submittedAt ?? '';
      const sb = b.cells.submittedAt ?? '';
      if (sa !== sb) return sb.localeCompare(sa);
      return b.rowIndex - a.rowIndex;
    });
  }
  // 组间：待核实桶置底，其余按最新测试日期从新到旧
  groups.sort((a, b) => {
    if (a.uncertain !== b.uncertain) return a.uncertain ? 1 : -1;
    if (a.latestDate !== b.latestDate) return b.latestDate.localeCompare(a.latestDate);
    return a.key.localeCompare(b.key);
  });
  return groups;
}

/** 组头汇总（需求 6：记录数/最近测试/考核者/模式/处理状态） */
function groupSummary(g: RowGroup): { testers: string; projects: string; tiers: string; counts: Array<{ label: string; cls: string; n: number }> } {
  const uniq = (arr: string[]) => [...new Set(arr.filter(v => v && v.trim()))];
  const testers = uniq(g.rows.map(r => r.cells.tester)).slice(0, 4);
  const projects = uniq(g.rows.map(r => r.cells.project)).slice(0, 4);
  const tiers = uniq(g.rows.map(r => r.cells.testTier));
  const written = g.rows.filter(r => r.approved && !r.rolledBack).length;
  const rolledBack = g.rows.filter(r => r.rolledBack).length;
  const rejected = g.rows.filter(r => r.reviewRejected).length;
  const invalid = g.rows.filter(r => r.status === 'INVALID' && !r.reviewRejected).length;
  const pending = g.rows.length - written - rolledBack - rejected - invalid;
  const counts: Array<{ label: string; cls: string; n: number }> = [
    { label: '待审核', cls: 'text-white/70', n: pending },
    { label: '已写入', cls: 'text-jade-400', n: written },
    { label: '已回档', cls: 'text-amber-400', n: rolledBack },
    { label: '已拒绝', cls: 'text-red-400', n: rejected },
  ];
  if (invalid > 0) counts.push({ label: '校验失败', cls: 'text-red-300/80', n: invalid });
  return { testers: testers.join('、') || '—', projects: projects.join('、') || '—', tiers: tiers.join('、') || '—', counts };
}

// ---------- R3：双表 dry-run 盘点（批复 2026-11-07：两表都要看 + 一比一重复→维持单表） ----------

interface DocTabInfo { id: string; type: string; self: boolean; name: string; hidden: boolean; }
interface InventoryRow { rowIndex: number; cells: string[]; joined: string; }
interface TabInventoryPayload {
  tabId: string;
  tabName: string;
  sheetTitle: string | null;
  headers: string[];
  rowCount: number;
  rows: InventoryRow[];
  notes: string[];
}
interface InventoryResponse {
  ok: boolean;
  fetchedAt?: string;
  targetTabId?: string;
  tabs?: DocTabInfo[];
  inventory?: TabInventoryPayload;
  code?: string;
  message?: string;
  error?: string;
  retryAfterMs?: number;
}

/** 客户端业务列比对（与后端 compareInventories 同口径：cells[0..9] 去空白多重集匹配；墓碑列不参与） */
function compareInventoriesClient(a: TabInventoryPayload, b: TabInventoryPayload) {
  const bizKey = (r: InventoryRow) => r.cells.slice(0, 10).join('\u0001').replace(/\s+/g, '');
  const pool = new Map<string, InventoryRow[]>();
  for (const r of b.rows) {
    const k = bizKey(r);
    const arr = pool.get(k);
    if (arr) arr.push(r);
    else pool.set(k, [r]);
  }
  const consumed = new Set<InventoryRow>();
  const onlyA: InventoryRow[] = [];
  let matchedCount = 0;
  for (const r of a.rows) {
    const hit = pool.get(bizKey(r))?.find(c => !consumed.has(c));
    if (hit) { consumed.add(hit); matchedCount += 1; } else onlyA.push(r);
  }
  const onlyB = b.rows.filter(r => !consumed.has(r));
  return {
    identical: a.rows.length > 0 && a.rows.length === b.rows.length && onlyA.length === 0 && onlyB.length === 0,
    matchedCount,
    onlyA,
    onlyB,
  };
}

function inventoryRowPreview(r: InventoryRow): string {
  const vals = r.cells.map(c => c.trim()).filter(v => v !== '');
  return vals.length > 0 ? vals.slice(0, 6).join(' · ') : '（整行空白）';
}

function fmtFallbackTime(iso: string | undefined): string {
  if (!iso) return '未知时刻';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

/** 双表盘点卡片：只读拉取两表 raw 矩阵 + 比对结论（零写库/零写文档/不改变同步语义） */
function TwoTabInventory() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [phaseText, setPhaseText] = useState('');
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [inventories, setInventories] = useState<Record<string, TabInventoryPayload>>({});
  const [error, setError] = useState<string | null>(null);

  async function waitCountdown(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      setPhaseText(`文档拉取限频窗口等待中…（${Math.ceil((end - Date.now()) / 1000)}s 后自动重试）`);
      await new Promise(r => setTimeout(r, Math.min(1000, Math.max(end - Date.now(), 1))));
    }
  }

  async function loadWithRetry(tabId: string | null): Promise<InventoryResponse | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const qs = tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
      const res = await adminFetch(`/api/v1/tier-command/inventory${qs}`);
      const data = (await res.json()) as InventoryResponse;
      if (res.status === 429 || data.code === 'RATE_LIMITED') {
        await waitCountdown(Math.min(Math.max(data.retryAfterMs ?? 10_500, 1000), 20_000));
        continue;
      }
      if (!res.ok || !data.ok || !data.inventory) {
        setError(data.message || data.error || `盘点拉取失败（HTTP ${res.status}）`);
        return null;
      }
      return data;
    }
    setError('限频窗口多次未过，盘点中止（请稍后再试）');
    return null;
  }

  async function runInventory() {
    setPhase('loading');
    setError(null);
    setInventories({});
    setPrimaryId(null);
    try {
      setPhaseText('正在拉取整理表（现行同步目标 y344e4）…');
      const primary = await loadWithRetry(null);
      if (!primary?.inventory) { setPhase('error'); return; }
      const tabList = primary.tabs ?? [];
      setPrimaryId(primary.inventory.tabId);
      setInventories({ [primary.inventory.tabId]: primary.inventory });
      const others = tabList.filter(t => t.type === 'grid' && !t.self && t.id !== primary.inventory!.tabId);
      for (const t of others) {
        setPhaseText(`正在拉取「${t.name || t.id}」…（限频纪律：两表拉取需间隔，等待窗口自动续拉）`);
        const r = await loadWithRetry(t.id);
        if (!r?.inventory) { setPhase('error'); return; }
        setInventories(prev => ({ ...prev, [r.inventory!.tabId]: r.inventory! }));
      }
      setPhase('done');
      setPhaseText('');
    } catch {
      setError('盘点请求发送失败（网络异常），请稍后重试');
      setPhase('error');
    }
  }

  const invList = Object.values(inventories);
  const primaryInv = primaryId ? inventories[primaryId] ?? null : null;
  const otherInvs = invList.filter(i => i.tabId !== primaryId);
  const hasLoadedAny = invList.length > 0;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden" aria-label="双表盘点（只读）">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors"
        aria-expanded={open}
      >
        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-white/50 shrink-0" aria-hidden="true" />
          : <ChevronRight className="w-3.5 h-3.5 text-white/50 shrink-0" aria-hidden="true" />}
        <Table2 className="w-3.5 h-3.5 text-white/50 shrink-0" aria-hidden="true" />
        <span className="text-xs font-bold text-white whitespace-nowrap">双表盘点（687 收集表 vs 整理表 · 只读）</span>
        <span className="text-[10px] text-white/40 truncate">批复：两表都要看；一比一全部重复 → 维持单表同步</span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={runInventory}
              disabled={phase === 'loading'}
              aria-busy={phase === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold bg-white/5 text-white border border-white/15 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]"
            >
              {phase === 'loading'
                ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                : <Table2 className="w-3 h-3" aria-hidden="true" />}
              {phase === 'loading' ? '盘点中…' : hasLoadedAny ? '重新盘点' : '开始盘点'}
            </button>
            <span className="text-[10px] text-white/40">只读拉取腾讯文档（不写库 / 不改文档）；两表拉取遵守 10s 限频纪律，第二表自动等待续拉</span>
          </div>

          {phase === 'loading' && phaseText && (
            <div className="flex items-center gap-1.5 text-[11px] text-white/60" role="status">
              <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden="true" />
              {phaseText}
            </div>
          )}
          {phase === 'error' && error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {/* 比对结论（逐对照表） */}
          {phase === 'done' && primaryInv && otherInvs.map(ot => {
            const cmp = compareInventoriesClient(primaryInv, ot);
            return (
              <div key={ot.tabId} className="flex flex-col gap-2">
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2 text-[11px] ${
                    cmp.identical
                      ? 'border-jade-500/30 bg-jade-500/10 text-jade-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {cmp.identical
                    ? `比对结论：两表数据行一比一完全重复（${cmp.matchedCount}/${primaryInv.rowCount} 行一致）—— 按批复维持单表同步（整理表 ${primaryInv.tabId}）即可，无需切换目标。`
                    : `比对结论：两表存在差异（共同 ${cmp.matchedCount} 行 · 仅整理表 ${cmp.onlyA.length} 行 · 仅「${ot.tabName || ot.tabId}」${cmp.onlyB.length} 行）。对照表中的新工单不会自动进入同步链路，需人工整理进整理表后方可见（程序不跨表取数）。`}
                </div>
                {!cmp.identical && (cmp.onlyA.length > 0 || cmp.onlyB.length > 0) && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                      <div className="text-[10px] font-bold text-white/70 mb-1">仅整理表有（{cmp.onlyA.length} 行）</div>
                      <div className="max-h-24 overflow-y-auto custom-scrollbar space-y-0.5">
                        {cmp.onlyA.map(r => (
                          <div key={`a-${r.rowIndex}`} className="text-[10px] text-white/60 whitespace-nowrap">
                            <span className="text-white/35">行{r.rowIndex}</span> {inventoryRowPreview(r)}
                          </div>
                        ))}
                        {cmp.onlyA.length === 0 && <div className="text-[10px] text-white/35">（无）</div>}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                      <div className="text-[10px] font-bold text-white/70 mb-1">仅「{ot.tabName || ot.tabId}」有（{cmp.onlyB.length} 行）</div>
                      <div className="max-h-24 overflow-y-auto custom-scrollbar space-y-0.5">
                        {cmp.onlyB.map(r => (
                          <div key={`b-${r.rowIndex}`} className="text-[10px] text-white/60 whitespace-nowrap">
                            <span className="text-white/35">行{r.rowIndex}</span> {inventoryRowPreview(r)}
                          </div>
                        ))}
                        {cmp.onlyB.length === 0 && <div className="text-[10px] text-white/35">（无）</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* 逐表卡片：表头 + 全行原貌（687 表也完整可见） */}
          {invList.map(inv => (
            <div key={inv.tabId} className="rounded-lg border border-white/10 bg-white/[0.03] overflow-hidden">
              <div className="flex items-center gap-2 flex-wrap px-2.5 py-1.5 text-[11px]">
                <span className="font-bold text-white">{inv.tabName || (inv.tabId === primaryId ? '整理表（同步目标）' : '收集表（关联表）')}</span>
                <span className="text-white/40 font-mono text-[10px]">{inv.tabId}</span>
                {inv.tabId === primaryId && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-jade-500/15 text-jade-400 border border-jade-500/30">同步目标</span>
                )}
                <span className="text-white/60">数据 {inv.rowCount} 行</span>
                {inv.sheetTitle && <span className="text-white/30 text-[10px] truncate max-w-[220px]" title={inv.sheetTitle}>{inv.sheetTitle}</span>}
              </div>
              {inv.notes.length > 0 && (
                <ul className="px-2.5 pb-1 text-[10px] text-amber-300/90 space-y-0.5">
                  {inv.notes.map((n, i) => <li key={i}>⚠ {n}</li>)}
                </ul>
              )}
              <div className="px-2.5 pb-1 text-[10px] text-white/40 flex flex-wrap gap-1">
                <span className="shrink-0">表头：</span>
                {inv.headers.map((h, i) => (
                  <span key={i} className={`px-1 py-0.5 rounded border text-[9px] ${h.trim() ? 'border-white/15 bg-white/5 text-white/70' : 'border-white/10 text-white/30'}`}>
                    {h.trim() || '(空列)'}
                  </span>
                ))}
              </div>
              <div className="max-h-48 overflow-y-auto custom-scrollbar px-2.5 pb-2 space-y-0.5">
                {inv.rows.map(r => (
                  <div key={r.rowIndex} className="text-[10px] text-white/70 whitespace-nowrap">
                    <span className="text-white/35 font-mono">行{r.rowIndex}</span> {inventoryRowPreview(r)}
                  </div>
                ))}
                {inv.rows.length === 0 && <div className="text-[10px] text-white/40">（无数据行）</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Tier 工单审核与写入子区 ----------

function SyncSection({ onApproved }: { onApproved?: () => void }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [dryRun, setDryRun] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 勾选状态：全部初始为空 —— 无预设勾选、无默认全选（硬约束 2）
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [createFlag, setCreateFlag] = useState<Record<string, boolean>>({});
  const [modeChoice, setModeChoice] = useState<Record<string, string>>({});
  // T6：C/L 行确认子项（默认不勾；勾选后方激活行勾选，随请求携带确认位）
  const [confirmAmbig, setConfirmAmbig] = useState<Record<string, boolean>>({});
  const [confirmLegacy, setConfirmLegacy] = useState<Record<string, boolean>>({});
  // R2：回档后重写确认子项
  const [confirmRewrite, setConfirmRewrite] = useState<Record<string, boolean>>({});
  // R2：组折叠状态（默认全部展开 —— 堆叠展示全部记录）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // 审批请求状态
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveResult, setApproveResult] = useState<ApproveResponse | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // R2：拒绝 / 撤销拒绝
  const [rejectTarget, setRejectTarget] = useState<SyncRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [restoreBusyFp, setRestoreBusyFp] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  const rows = result?.rows ?? [];
  const groups = buildGroups(rows);

  // 可勾选判定：已写入行/已拒绝行/失败行不可勾；跳过行须先勾「创建并写入」子项；
  // C 行须先勾「已核对歧义」、L 行须先勾「已人工核验」、已回档行须先勾「回档后重写确认」
  // （与后端 T5/R2 门禁同矩阵，防无效提交）
  const canCheck = (r: SyncRow): boolean => {
    if (r.approved && !r.rolledBack) return false;
    if (r.reviewRejected) return false;
    if (r.status === 'INVALID') return false;
    if (r.rolledBack && confirmRewrite[r.fingerprint] !== true) return false;
    if (r.status === 'PLAYER_MISSING' && createFlag[r.fingerprint] !== true) return false;
    const st = r.inheritance?.state;
    if (st === 'C_AMBIGUOUS' && confirmAmbig[r.fingerprint] !== true) return false;
    if (st === 'LEGACY_UNVERIFIED' && confirmLegacy[r.fingerprint] !== true) return false;
    return true; // READY / PLAYER_MISSING（已勾创建）/ A / B / D（含已回档已确认）
  };
  const checkedRows = rows.filter(r => checked[r.fingerprint] === true && canCheck(r));
  const createCount = checkedRows.filter(r => r.status === 'PLAYER_MISSING').length;
  const missingModeRows = checkedRows.filter(r => !modeChoice[r.fingerprint]);
  const writeEnabled = checkedRows.length > 0 && missingModeRows.length === 0;
  // T6/R2：确认框特殊行计数
  const ambigCount = checkedRows.filter(r => r.inheritance?.state === 'C_AMBIGUOUS').length;
  const legacyCount = checkedRows.filter(r => r.inheritance?.state === 'LEGACY_UNVERIFIED').length;
  const rewriteCount = checkedRows.filter(r => r.rolledBack).length;

  async function runSync() {
    setStatus('loading');
    setErrorMsg(null);
    setApproveResult(null);
    setApproveError(null);
    setReviewNotice(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const data = (await res.json()) as SyncResponse;
      if (!res.ok || !data.ok) {
        setResult(null);
        setErrorMsg(data.message || data.error || `同步失败（HTTP ${res.status}）`);
        setStatus('error');
        return;
      }
      setResult(data);
      // 硬约束 2：新同步数据绝不预勾选 —— 勾选态保持空
      setChecked({});
      setCreateFlag({});
      setModeChoice({});
      setConfirmAmbig({});
      setConfirmLegacy({});
      setConfirmRewrite({});
      setStatus('success');
    } catch {
      setResult(null);
      setErrorMsg('同步请求发送失败（网络异常），请稍后重试');
      setStatus('error');
    }
  }

  function toggleCheck(r: SyncRow, next: boolean) {
    setChecked(prev => ({ ...prev, [r.fingerprint]: next && canCheck(r) }));
  }

  function toggleCreate(r: SyncRow, next: boolean) {
    setCreateFlag(prev => ({ ...prev, [r.fingerprint]: next }));
    // 子项勾选 → 激活该行勾选（跳过行路径）；取消 → 行勾选一并撤销
    setChecked(prev => ({ ...prev, [r.fingerprint]: next }));
  }

  function setMode(fp: string, mode: string) {
    setModeChoice(prev => ({ ...prev, [fp]: mode }));
  }

  function toggleConfirmAmbig(r: SyncRow, next: boolean) {
    setConfirmAmbig(prev => ({ ...prev, [r.fingerprint]: next }));
    setChecked(prev => ({ ...prev, [r.fingerprint]: next }));
  }

  function toggleConfirmLegacy(r: SyncRow, next: boolean) {
    setConfirmLegacy(prev => ({ ...prev, [r.fingerprint]: next }));
    setChecked(prev => ({ ...prev, [r.fingerprint]: next }));
  }

  function toggleConfirmRewrite(r: SyncRow, next: boolean) {
    setConfirmRewrite(prev => ({ ...prev, [r.fingerprint]: next }));
    setChecked(prev => ({ ...prev, [r.fingerprint]: next }));
  }

  // ---- R2：拒绝 / 撤销拒绝（每条记录独立按钮；持久化在服务端水位） ----

  async function submitReject() {
    if (!rejectTarget) return;
    setReviewBusy(true);
    setReviewNotice(null);
    const target = rejectTarget;
    try {
      const res = await adminFetch('/api/v1/tier-command/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', fingerprints: [target.fingerprint], reason: rejectReason }),
      });
      const data = (await res.json()) as ReviewResponse;
      if (!res.ok || !data.ok) {
        setReviewNotice({ ok: false, msg: data.message || data.error || `拒绝失败（HTTP ${res.status}）` });
        return;
      }
      setReviewNotice({ ok: true, msg: data.message ?? '已拒绝' });
      // 本地回填拒绝标记（无需整页重新同步）
      setResult(prev => prev
        ? { ...prev, rows: prev.rows.map(r => r.fingerprint === target.fingerprint
            ? { ...r, reviewRejected: { at: new Date().toISOString(), by: '本次会话', reason: rejectReason.trim() || null } }
            : r) }
        : prev);
      setRejectTarget(null);
      setRejectReason('');
      onApproved?.(); // 拒绝产生审计日志 → 刷新总览日志
    } catch {
      setReviewNotice({ ok: false, msg: '拒绝请求发送失败（网络异常），请稍后重试' });
    } finally {
      setReviewBusy(false);
    }
  }

  async function restoreReject(r: SyncRow) {
    setRestoreBusyFp(r.fingerprint);
    setReviewNotice(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', fingerprints: [r.fingerprint] }),
      });
      const data = (await res.json()) as ReviewResponse;
      if (!res.ok || !data.ok) {
        setReviewNotice({ ok: false, msg: data.message || data.error || `撤销拒绝失败（HTTP ${res.status}）` });
        return;
      }
      setReviewNotice({ ok: true, msg: data.message ?? '已撤销拒绝' });
      setResult(prev => prev
        ? { ...prev, rows: prev.rows.map(x => x.fingerprint === r.fingerprint ? { ...x, reviewRejected: null } : x) }
        : prev);
      onApproved?.();
    } catch {
      setReviewNotice({ ok: false, msg: '撤销请求发送失败（网络异常），请稍后重试' });
    } finally {
      setRestoreBusyFp(null);
    }
  }

  // ---- 审批写入（勾选任意 1..N 条；跨组自由组合，无整组强制） ----

  async function submitApprove() {
    setApproving(true);
    setApproveError(null);
    try {
      const approvedRows = checkedRows.map(r => ({
        rowIndex: r.rowIndex,
        fingerprint: r.fingerprint,
        playerName: r.cells.testee,
        tier: r.cells.testTier,
        mode: modeChoice[r.fingerprint],
        createIfMissing: r.status === 'PLAYER_MISSING' && createFlag[r.fingerprint] === true,
        // T6：C/L 确认位（T5 门禁放行通道；未勾选时为 false → 后端 fail-safe 拒绝）
        confirmAmbiguous: r.inheritance?.state === 'C_AMBIGUOUS' ? confirmAmbig[r.fingerprint] === true : undefined,
        confirmLegacyUnverified: r.inheritance?.state === 'LEGACY_UNVERIFIED' ? confirmLegacy[r.fingerprint] === true : undefined,
        // R2：回档后重写确认位
        confirmAfterRollback: r.rolledBack ? confirmRewrite[r.fingerprint] === true : undefined,
      }));
      const res = await adminFetch('/api/v1/tier-command/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedRows }),
      });
      const data = (await res.json()) as ApproveResponse;
      if (!res.ok || !data.ok) {
        setApproveError(data.message || data.error || `写入失败（HTTP ${res.status}）`);
        return;
      }
      setApproveResult(data);
      onApproved?.(); // 审批产生新审计日志 → 通知父级刷新「总览日志」
      // 已写入行本地回填 approved 展示 + 撤销勾选（防重复提交）
      const approvedByFp = new Map(data.results.filter(x => x.status === 'APPROVED').map(x => [x.fingerprint, x]));
      if (result) {
        setResult({
          ...result,
          rows: result.rows.map(r => {
            const ok = approvedByFp.get(r.fingerprint);
            return ok
              ? {
                  ...r,
                  approved: {
                    at: new Date().toISOString(), by: '本次会话', tier: r.cells.testTier,
                    mode: modeChoice[r.fingerprint] ?? '', playerId: ok.playerId ?? null,
                    playerName: r.cells.testee, created: ok.created ?? false, logId: ok.logId ?? null,
                  },
                }
              : r;
          }),
        });
      }
      setChecked({});
      setCreateFlag({});
      setConfirmAmbig({});
      setConfirmLegacy({});
      setConfirmRewrite({});
    } catch {
      setApproveError('写入请求发送失败（网络异常），请稍后重试');
    } finally {
      setApproving(false);
      setConfirmOpen(false);
    }
  }

  const btnCls =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]';
  const btnState =
    status === 'loading'
      ? 'bg-white/10 text-white border border-white/20'
      : status === 'success'
        ? 'bg-jade-500/20 text-jade-300 border border-jade-500/40 hover:bg-jade-500/30'
        : status === 'error'
          ? 'bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25'
          : 'bg-jade-500/15 text-jade-300 border border-jade-500/30 hover:bg-jade-500/25';

  return (
    <div className="flex flex-col gap-3" aria-label="数据同步操作区">
      {/* 操作行：立即同步 + dryRun 开关 */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={runSync}
          disabled={status === 'loading'}
          className={`${btnCls} ${btnState}`}
          aria-busy={status === 'loading'}
        >
          {status === 'loading' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          {status === 'loading' ? '同步中…' : status === 'success' ? '已同步 · 再次同步' : status === 'error' ? '失败 · 点击重试' : '立即同步'}
        </button>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={e => setDryRun(e.target.checked)}
            disabled={status === 'loading'}
            className="accent-jade-500 w-3.5 h-3.5"
          />
          仅预演（dryRun，不写指纹水位）
        </label>
      </div>

      {/* R3：双表盘点（只读；批复 2026-11-07） */}
      <TwoTabInventory />

      {/* 同步错误态 */}
      {status === 'error' && errorMsg && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* R2：拒绝/撤销结果提示 */}
      {reviewNotice && (
        <div
          role="status"
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
            reviewNotice.ok
              ? 'border-jade-500/30 bg-jade-500/10 text-jade-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{reviewNotice.msg}</span>
        </div>
      )}

      {/* 审批结果 / 错误 */}
      {approveError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{approveError}</span>
        </div>
      )}
      {approveResult && (
        <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] max-h-32 overflow-y-auto">
          <span className="font-bold text-white">{approveResult.message}</span>
          {approveResult.results.map(x => (
            <span key={x.fingerprint} className={x.status === 'APPROVED' ? 'text-jade-400' : 'text-red-300'}>
              · 行{x.rowIndex} {x.status === 'APPROVED' ? `✓ 已写入（${x.created ? '新建玩家' : '更新 tier'}）` : `✗ ${x.message ?? '被拒绝'}`}
            </span>
          ))}
        </div>
      )}

      {/* 成功态：汇总条 + 警告 + 按测试者分组堆叠 */}
      {status === 'success' && result && (
        <div className="flex flex-col gap-2">
          {/* R3：清空保护横幅（自动化缓存导入 / 无法导入，批复 2026-11-07） */}
          {result.meta?.clearedDetected && (
            <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                文档清空保护已触发{result.meta.cacheFallback ? ' · 自动化缓存导入完成' : ''}
              </div>
              {result.meta.cacheFallback ? (
                <div className="text-amber-200/90">
                  腾讯文档当前为空（0 数据行）：本次展示已自动回退到本地缓存快照（保存于 {fmtFallbackTime(result.meta.cacheFallback.savedAt)}，共 {result.meta.cacheFallback.rowCount} 行）。工单数据未丢失，指纹水位与审批记录不受影响；文档恢复数据后重新同步即切回实时内容。
                </div>
              ) : (
                <div className="text-amber-200/90">
                  腾讯文档当前为空（0 数据行）且本地无可用缓存快照，无法自动导入。请尽快核实文档是否被误清空。
                </div>
              )}
            </div>
          )}
          {/* 汇总条 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-white/90">
            <span className="font-bold text-white">
              本次解析 {result.parsedCount} 行
            </span>
            <span className="text-jade-400">成功 {result.successCount}</span>
            <span className="text-red-400">失败 {result.failedCount}</span>
            <span className="text-amber-400">跳过 {result.skippedCount}</span>
            <span className="text-white">新增 {result.newCount}</span>
            <span className="text-white/60">重复 {result.duplicateCount}</span>
            <span className="text-white/60">分组 {groups.length} 组</span>
            {result.meta?.cacheFallback && (
              <span className="text-amber-300">缓存导入 {result.meta.cacheFallback.rowCount} 行</span>
            )}
            {result.dryRun && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 border border-white/15 tracking-wider">
                DRY RUN · 未写指纹
              </span>
            )}
          </div>

          {/* 警告 */}
          {result.warnings.length > 0 && (
            <ul className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300 space-y-0.5 max-h-24 overflow-y-auto">
              {result.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          {/* R2：按测试者分组堆叠（组头=汇总，组内=逐条独立记录） */}
          <div className="flex flex-col gap-2 max-h-[640px] overflow-y-auto pr-1">
            {groups.map(g => {
              const sum = groupSummary(g);
              const isCollapsed = collapsed[g.key] === true;
              return (
                <div key={g.key} className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                  {/* 组头（点击折叠/展开） */}
                  <button
                    type="button"
                    onClick={() => setCollapsed(prev => ({ ...prev, [g.key]: !isCollapsed }))}
                    className="w-full flex items-center gap-2 flex-wrap px-3 py-2 text-left hover:bg-white/[0.04] transition-colors"
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed
                      ? <ChevronRight className="w-3.5 h-3.5 text-white/50 shrink-0" aria-hidden="true" />
                      : <ChevronDown className="w-3.5 h-3.5 text-white/50 shrink-0" aria-hidden="true" />}
                    <span className="text-xs font-bold text-white whitespace-nowrap">
                      {g.uncertain ? (
                        <span className="text-amber-300">待核实（无法确认被测玩家）</span>
                      ) : (
                        <>
                          <span className="text-white/50">测:</span>{g.testee}
                        </>
                      )}
                    </span>
                    {g.missingPlayer && !g.uncertain && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        待建条目
                      </span>
                    )}
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 text-white/60 border border-white/10">
                      {g.rows.length} 条记录
                    </span>
                    <span className="text-[10px] text-white/50 whitespace-nowrap">
                      最近测试 {g.latestDate || '—'} · 考核者 {sum.testers} · 模式 {sum.projects} · tier {sum.tiers}
                    </span>
                    <span className="text-[10px] whitespace-nowrap flex items-center gap-2 ml-auto flex-wrap">
                      {sum.counts.filter(c => c.n > 0).map(c => (
                        <span key={c.label} className={c.cls}>{c.label} {c.n}</span>
                      ))}
                    </span>
                  </button>

                  {/* 组内记录（逐条独立：日期/提交时间/考核者/项目/tier/胜场/评价/状态/操作） */}
                  {!isCollapsed && (
                    <div className="border-t border-white/10 overflow-x-auto">
                      <table className="w-full min-w-[1520px] text-[11px]">
                        <thead className="bg-white/[0.04] text-white/70">
                          <tr>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">行号</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">测试日期</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">提交时间</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap" title="E 列考核员（执行考核的一方，不写榜）">考核者</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">测试项目</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">目标 tier</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap" title="测试者胜场 / 考核员胜场（H 列 / I 列）">胜场 测/考</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">评价</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">校验状态</th>
                            <th
                              className="text-left font-bold px-2 py-1.5 whitespace-nowrap"
                              title="T4 审批继承状态机判定：A 内容一致（可继承）/ B 内容已变更（需重审）/ C 归属歧义（需人工核对）/ D 新工单 / L 存量待核验"
                            >
                              审批关联
                            </th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap" title="多字段重复检测：同测试者+同日期+同考核者+同项目+tier">重复检测</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">AI 建议（仅供参考）</th>
                            <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">写入模式</th>
                            <th className="text-left font-bold px-2 py-1.5 min-w-[170px]">审核状态 · 操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map(r => {
                            const badge = STATUS_BADGE[r.status];
                            const ai = AI_BADGE[r.aiSuggestion.verdict];
                            const checkable = canCheck(r);
                            const isChecked = checked[r.fingerprint] === true;
                            const isMissing = r.status === 'PLAYER_MISSING' && !(r.approved && !r.rolledBack);
                            const isWritten = !!r.approved && !r.rolledBack;
                            const isRejected = !!r.reviewRejected;
                            const dup = r.dupSuspects ?? [];
                            return (
                              <tr key={r.fingerprint} className={`border-t border-white/5 hover:bg-white/[0.03] align-top ${isRejected ? 'opacity-60' : ''}`}>
                                <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">{r.rowIndex}</td>
                                <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">{r.cells.testDate || '—'}</td>
                                <td className="px-2 py-1.5 text-white/60 whitespace-nowrap">{r.cells.submittedAt || '—'}</td>
                                <td className="px-2 py-1.5 text-white/70 max-w-[130px] truncate" title={`考核员（E 列）：${r.cells.tester}`}>
                                  {r.cells.tester || '—'}
                                </td>
                                <td className="px-2 py-1.5 text-white/80 max-w-[110px] truncate" title={r.cells.project}>
                                  {r.cells.project || '—'}
                                </td>
                                <td className="px-2 py-1.5 text-white/90 whitespace-nowrap font-bold">{r.cells.testTier || '—'}</td>
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  <span className={/[^\d/ ]/.test(`${r.cells.testeeWins}/${r.cells.testerWins}`) ? 'text-amber-300' : 'text-white/80'}>
                                    {r.cells.testeeWins || '—'} / {r.cells.testerWins || '—'}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-white/60 max-w-[110px] truncate" title={r.cells.review || r.cells.legacyReview || ''}>
                                  {r.cells.review || r.cells.legacyReview || '—'}
                                </td>
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge.cls}`} title={r.reasons.join('；')}>
                                    {badge.label}
                                  </span>
                                </td>
                                {/* T6：审批关联五态（A/B/C/D/L）+ 详情 */}
                                <td className="px-2 py-1.5 max-w-[170px]">
                                  {r.inheritance ? (
                                    <div className="flex flex-col gap-0.5">
                                      <span
                                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap w-fit ${
                                          r.inheritance.state === 'A_INHERITED' && r.inheritance.inheritedApproved
                                            ? 'bg-jade-500/25 text-jade-300 border-jade-500/40'
                                            : INHERITANCE_BADGE[r.inheritance.state].cls
                                        }`}>
                                        {r.inheritance.state === 'A_INHERITED' && r.inheritance.inheritedApproved
                                          ? 'A · 继承历史审批'
                                          : INHERITANCE_BADGE[r.inheritance.state].label}
                                      </span>
                                      {inheritanceDetail(r) && (
                                        <p className="text-[10px] text-white/50 whitespace-pre-line line-clamp-3" title={inheritanceDetail(r)}>
                                          {inheritanceDetail(r)}
                                        </p>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-white/40" title="旧版同步载荷：无继承判定字段">—</span>
                                  )}
                                </td>
                                {/* R2：重复检测（多字段组合键；对方已写入 = 防重复录入强信号） */}
                                <td className="px-2 py-1.5 max-w-[150px]">
                                  {dup.length > 0 ? (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap w-fit bg-red-500/15 text-red-300 border-red-500/30">
                                        疑似重复 ×{dup.length}
                                      </span>
                                      <p
                                        className="text-[10px] text-white/50 line-clamp-2"
                                        title={`同「测试者+日期+考核者+项目+tier」命中：${dup.map(s => `行${s.rowIndex}${s.approved ? '（已写入）' : '（未处理）'}`).join('、')}${dup.some(s => s.approved) ? ' —— 其中含已写入记录，写入将构成重复录入' : ''}`}
                                      >
                                        {dup.map(s => `行${s.rowIndex}${s.approved ? '（已写入）' : ''}`).join('、')}
                                      </p>
                                    </div>
                                  ) : r.isDuplicate ? (
                                    <span className="text-white/50" title="行指纹/内容指纹命中历史记录">重复</span>
                                  ) : (
                                    <span className="text-jade-400">新增</span>
                                  )}
                                </td>
                                {/* AI 建议：仅供参考，无权勾选/写库（硬约束 1） */}
                                <td className="px-2 py-1.5 max-w-[170px]">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${ai.cls}`}>
                                    {ai.label}
                                  </span>
                                  {r.aiSuggestion.reasons.length > 0 && (
                                    <p className="mt-0.5 text-[10px] text-white/50 line-clamp-3" title={r.aiSuggestion.reasons.join('；')}>
                                      {r.aiSuggestion.reasons.join('；')}
                                    </p>
                                  )}
                                </td>
                                {/* 写入模式：管理员逐行显式选择（modeHint 仅预选） */}
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  {isWritten ? (
                                    <span className="text-white/60">{r.approved!.mode}</span>
                                  ) : checkable ? (
                                    <select
                                      aria-label={`行${r.rowIndex} 写入模式`}
                                      value={modeChoice[r.fingerprint] ?? ''}
                                      onChange={e => setMode(r.fingerprint, e.target.value)}
                                      className="bg-black/40 border border-white/15 rounded px-1 py-0.5 text-[10px] text-white max-w-[90px]"
                                    >
                                      <option value="">选择模式…</option>
                                      {ALL_MODES.map(m => (
                                        <option key={m} value={m}>{MODE_LABELS[m as GameMode]}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                                {/* 审核状态 · 操作（R2：逐条 通过（写入）/拒绝/撤销拒绝） */}
                                <td className="px-2 py-1.5 min-w-[170px]">
                                  {isWritten ? (
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-jade-500/20 text-jade-300 border border-jade-500/40 whitespace-nowrap">
                                      ✓ 已写入{r.approved!.created ? ' · 新建' : ''}
                                    </span>
                                  ) : isRejected ? (
                                    <div className="flex flex-col gap-1">
                                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30 w-fit whitespace-nowrap">
                                        已拒绝 · 非候选
                                      </span>
                                      <span className="text-[10px] text-white/50">
                                        {r.reviewRejected!.by} @ {fmtShortTime(r.reviewRejected!.at)}{r.reviewRejected!.reason ? ` · ${r.reviewRejected!.reason}` : ''}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => void restoreReject(r)}
                                        disabled={restoreBusyFp === r.fingerprint}
                                        className="w-fit text-[10px] font-bold px-2 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-50 min-h-[28px]"
                                      >
                                        {restoreBusyFp === r.fingerprint ? '撤销中…' : '撤销拒绝'}
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <label className={`inline-flex items-center gap-1.5 ${checkable ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            disabled={!checkable}
                                            onChange={e => toggleCheck(r, e.target.checked)}
                                            className="accent-jade-500 w-3.5 h-3.5"
                                            aria-label={`通过并写入 行${r.rowIndex} ${r.cells.testee}`}
                                          />
                                          <span className="text-white/80">通过·写入</span>
                                        </label>
                                        {/* 每条记录独立「拒绝」按钮（R2）：拒绝后持久标记，不再作为候选 */}
                                        <button
                                          type="button"
                                          onClick={() => { setRejectTarget(r); setRejectReason(''); }}
                                          className="text-[10px] font-bold px-2 py-1 rounded-lg bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/25 transition-colors min-h-[28px]"
                                          aria-label={`拒绝 行${r.rowIndex} ${r.cells.testee}`}
                                        >
                                          拒绝
                                        </button>
                                      </div>
                                      {r.rolledBack && (
                                        <span className="text-[10px] text-amber-300">
                                          已回档（{r.rolledBack.by} @ {fmtShortTime(r.rolledBack.at)}）· 重写须确认
                                        </span>
                                      )}
                                      {isMissing && (
                                        <label className="inline-flex items-start gap-1.5 cursor-pointer max-w-[180px]">
                                          <input
                                            type="checkbox"
                                            checked={createFlag[r.fingerprint] === true}
                                            onChange={e => toggleCreate(r, e.target.checked)}
                                            className="accent-amber-500 w-3.5 h-3.5 mt-0.5"
                                            aria-label={`行${r.rowIndex} 创建玩家并写入`}
                                          />
                                          <span className="text-[10px] text-amber-300 leading-snug">
                                            找不到玩家 {r.cells.testee}？勾选此项以创建玩家并写入榜单
                                          </span>
                                        </label>
                                      )}
                                      {/* T6：C 行「已核对歧义」确认子项 */}
                                      {r.status !== 'INVALID' && r.inheritance?.state === 'C_AMBIGUOUS' && (
                                        <label className="inline-flex items-start gap-1.5 cursor-pointer max-w-[180px]">
                                          <input
                                            type="checkbox"
                                            checked={confirmAmbig[r.fingerprint] === true}
                                            onChange={e => toggleConfirmAmbig(r, e.target.checked)}
                                            className="accent-red-500 w-3.5 h-3.5 mt-0.5"
                                            aria-label={`行${r.rowIndex} 已人工核对审批归属歧义`}
                                          />
                                          <span className="text-[10px] text-red-300 leading-snug">
                                            历史审批归属歧义 —— 勾选确认已人工核对后方可写入
                                          </span>
                                        </label>
                                      )}
                                      {/* T6：L 行「已人工核验」确认子项 */}
                                      {r.status !== 'INVALID' && r.inheritance?.state === 'LEGACY_UNVERIFIED' && (
                                        <label className="inline-flex items-start gap-1.5 cursor-pointer max-w-[180px]">
                                          <input
                                            type="checkbox"
                                            checked={confirmLegacy[r.fingerprint] === true}
                                            onChange={e => toggleConfirmLegacy(r, e.target.checked)}
                                            className="accent-amber-500 w-3.5 h-3.5 mt-0.5"
                                            aria-label={`行${r.rowIndex} 已人工核验存量内容一致`}
                                          />
                                          <span className="text-[10px] text-amber-300 leading-snug">
                                            存量工单内容不可核实{r.inheritance.legacyApprovedUnverified
                                              ? `（原审批 ${r.inheritance.legacyApprovedUnverified.by}）`
                                              : ''} —— 勾选确认已人工核验后方可写入
                                          </span>
                                        </label>
                                      )}
                                      {/* R2：已回档行「回档后重写确认」子项 */}
                                      {r.status !== 'INVALID' && r.rolledBack && (
                                        <label className="inline-flex items-start gap-1.5 cursor-pointer max-w-[180px]">
                                          <input
                                            type="checkbox"
                                            checked={confirmRewrite[r.fingerprint] === true}
                                            onChange={e => toggleConfirmRewrite(r, e.target.checked)}
                                            className="accent-amber-500 w-3.5 h-3.5 mt-0.5"
                                            aria-label={`行${r.rowIndex} 回档后重写确认`}
                                          />
                                          <span className="text-[10px] text-amber-300 leading-snug">
                                            该写入已被回档 —— 勾选「回档后重写确认」方可再次写入
                                          </span>
                                        </label>
                                      )}
                                      {r.status === 'INVALID' && (
                                        <span className="text-[10px] text-red-300/80">校验失败行不可写入（修复后重新同步）</span>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
            {groups.length === 0 && (
              <div className="rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-6 flex items-center justify-center">
                <span className="text-[11px] text-muted-foreground/70">文档解析 0 行 —— 无可展示记录</span>
              </div>
            )}
          </div>

          {/* 底部写入条：初始禁用（硬约束 3/5） */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                disabled={!writeEnabled || approving}
                onClick={() => setConfirmOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold bg-jade-500/20 text-jade-200 border border-jade-500/40 hover:bg-jade-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[38px]"
              >
                {approving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                确认写入 Tier 榜{checkedRows.length > 0 ? `（已勾选 ${checkedRows.length} 条）` : ''}
              </button>
              <span className="text-[10px] text-muted-foreground">
                {checkedRows.length === 0
                  ? '未勾选任何记录 —— 任意一条或多条均可单独写入（无全选，AI 不会替你勾选）'
                  : missingModeRows.length > 0
                    ? `还有 ${missingModeRows.length} 条未选择写入模式`
                    : `写入对象为每条记录的被测玩家（⑥列）· 操作将记入审计日志`}
              </span>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground/70">
            数据源：腾讯文档「tier测试工单（收集结果）」· 拉取时刻 {result.fetchedAt} · 按测试者分组堆叠 · 每条记录独立审核 · AI 建议仅供参考
          </p>
        </div>
      )}

      {/* 二次确认框（硬约束 5） */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="bg-[#111] border border-white/15 max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">确认写入 Tier 榜？</AlertDialogTitle>
            <AlertDialogDescription className="text-white/70 text-xs leading-relaxed">
              即将写入 <b className="text-jade-300">{checkedRows.length}</b> 条记录，其中包含新建{' '}
              <b className="text-amber-300">{createCount}</b> 名玩家，确认？
              <span className="block mt-2 text-[11px] text-white/50">
                写入对象（⑥列被测玩家）：
                {checkedRows.map(r => `${r.cells.testee} → ${modeChoice[r.fingerprint]} ${r.cells.testTier}`).join('；') || '—'}
                {ambigCount > 0 && (
                  <span className="block text-red-300/80">其中归属歧义 {ambigCount} 条（已勾选「已核对歧义」，后端将校验确认位）</span>
                )}
                {legacyCount > 0 && (
                  <span className="block text-amber-300/80">其中存量待核验 {legacyCount} 条（已勾选「已人工核验」，内容一致性由本次人工核验担责）</span>
                )}
                {rewriteCount > 0 && (
                  <span className="block text-amber-300/80">其中回档后重写 {rewriteCount} 条（已勾选「回档后重写确认」）</span>
                )}
                <br />每次写入将记录审计日志（操作人/指纹/行号/改动前后快照），重复提交会被幂等拦截。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approving} className="bg-transparent text-white/70 border border-white/15 hover:bg-white/5 text-xs">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={approving}
              onClick={e => {
                e.preventDefault(); // 阻断默认关闭，等请求完成
                void submitApprove();
              }}
              className="bg-jade-600 hover:bg-jade-500 text-white text-xs font-bold"
            >
              {approving ? '写入中…' : '确认写入'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* R2：拒绝确认框（每条记录独立拒绝；原因可选） */}
      <AlertDialog open={rejectTarget !== null} onOpenChange={o => { if (!o && !reviewBusy) setRejectTarget(null); }}>
        <AlertDialogContent className="bg-[#111] border border-white/15 max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">
              拒绝记录{rejectTarget ? ` · 行${rejectTarget.rowIndex} ${rejectTarget.cells.testee || '（身份待核实）'}` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-white/70 text-xs leading-relaxed">
              拒绝后该记录将<b className="text-red-300">持久标记为「已拒绝」</b>，后续同步不再作为写入候选；
              腾讯文档原始数据不受影响，该测试者未来新记录不受影响。
              <span className="block mt-1">仅管理员「撤销拒绝」可恢复（恢复前保留完整审计日志）。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            maxLength={200}
            placeholder="拒绝原因（可选，≤200 字，将记入审计日志）"
            disabled={reviewBusy}
            className="bg-black/40 border-white/15 text-white text-xs"
            aria-label="拒绝原因"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewBusy} className="bg-transparent text-white/70 border border-white/15 hover:bg-white/5 text-xs">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={reviewBusy}
              onClick={e => {
                e.preventDefault();
                void submitReject();
              }}
              className="bg-red-600 hover:bg-red-500 text-white text-xs font-bold"
            >
              {reviewBusy ? '处理中…' : '确认拒绝'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------- R2：写入回档弹窗 ----------

function RollbackDialog({ open, onOpenChange, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<RollbackCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  // 二次确认（恢复范围展示 → 确认执行）
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<RollbackResponse | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const rollbackable = candidates?.filter(c => c.rollbackable) ?? [];
  const selectedRows = rollbackable.filter(c => selected[c.logId] === true);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setResult(null);
      setExecError(null);
      setSelected({});
      try {
        const res = await adminFetch('/api/v1/tier-command/rollback');
        const data = (await res.json()) as { ok: boolean; candidates?: RollbackCandidate[]; message?: string; error?: string };
        if (!alive) return;
        if (!res.ok || !data.ok) {
          setLoadError(data.message || data.error || `回档候选加载失败（HTTP ${res.status}）`);
          setCandidates(null);
          return;
        }
        setCandidates(data.candidates ?? []);
      } catch {
        if (!alive) return;
        setLoadError('回档候选请求发送失败（网络异常）');
        setCandidates(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  async function executeRollback() {
    if (selectedRows.length === 0) return;
    setExecuting(true);
    setExecError(null);
    try {
      const res = await adminFetch('/api/v1/tier-command/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logIds: selectedRows.map(c => c.logId) }),
      });
      const data = (await res.json()) as RollbackResponse;
      if (!res.ok || !data.ok) {
        // 失败绝不显示成功
        setExecError(data.message || data.error || `回档失败（HTTP ${res.status}）`);
        return;
      }
      setResult(data);
      onChanged?.();
      setSelected({});
      // 重新拉取候选（反映新的可回档状态）
      try {
        const res2 = await adminFetch('/api/v1/tier-command/rollback');
        const data2 = (await res2.json()) as { ok: boolean; candidates?: RollbackCandidate[] };
        if (res2.ok && data2.ok) setCandidates(data2.candidates ?? []);
      } catch { /* 刷新失败不掩盖回档结果 */ }
    } catch {
      setExecError('回档请求发送失败（网络异常），请稍后重试');
    } finally {
      setExecuting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!executing) onOpenChange(o); }}>
      <DialogContent className="bg-[#111] border border-white/15 max-w-3xl" aria-label="写入回档弹窗">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Undo2 className="w-4 h-4 text-amber-400" aria-hidden="true" />
            写入回档
          </DialogTitle>
          <DialogDescription className="text-white/60 text-xs leading-relaxed">
            列出可回档的历史写入操作（时间/操作人/涉及记录/变更内容）。
            恢复范围 = 该次写入改动的 tiers 字段（不动玩家其他数据、不删除条目）；
            执行时逐项复核 —— 玩家段位在该次写入后已有其他变更的将被阻止（不覆盖回档后新记录）；
            无可靠备份或范围不明的项禁止执行；回档全程保留审计日志。
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4" role="status">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            回档候选加载中…
          </div>
        )}
        {!loading && loadError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{loadError}</span>
          </div>
        )}
        {!loading && candidates && (
          <div className="flex flex-col gap-2">
            {/* 候选列表 */}
            <div className="rounded-lg border border-white/10 overflow-hidden">
              <div className="max-h-72 overflow-y-auto overflow-x-auto">
                <table className="w-full min-w-[780px] text-[11px]">
                  <thead className="sticky top-0 bg-white/[0.06] backdrop-blur text-white/70">
                    <tr>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">时间</th>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">操作人</th>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">涉及记录</th>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">变更内容</th>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">状态</th>
                      <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">选择</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map(c => (
                      <tr key={c.logId} className="border-t border-white/5 hover:bg-white/[0.03] align-top">
                        <td className="px-2 py-1.5 text-white/70 whitespace-nowrap">{fmtLogTime(c.at)}</td>
                        <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">{c.operator}</td>
                        <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">
                          {c.playerName ? `行${c.rowIndex ?? '?'} · ${c.playerName}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">
                          {c.mode ? (
                            <>
                              <span className="text-white/60">{MODE_LABELS[c.mode as GameMode] ?? c.mode}</span>{' '}
                              <span>{c.tierFrom ?? '无'}→<b className="text-jade-300">{c.tierTo ?? '?'}</b></span>
                              {c.created && (
                                <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                  新建玩家
                                </span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-1.5 max-w-[220px]">
                          {c.stateRolledBack ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-white/5 text-white/50 border-white/15">已回档</span>
                          ) : c.rollbackable ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-jade-500/15 text-jade-300 border-jade-500/30" title={`当前该模式段位：${c.currentTier ?? '无'} → 恢复为 ${c.restoreTierDisplay}`}>
                              可回档
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-red-500/15 text-red-300 border-red-500/30 cursor-help" title={c.blockedReason ?? ''}>
                              禁止
                              <span className="ml-1 font-normal">{c.blockedReason?.slice(0, 18) ?? ''}…</span>
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            checked={selected[c.logId] === true}
                            disabled={!c.rollbackable || c.stateRolledBack || executing}
                            onChange={e => setSelected(prev => ({ ...prev, [c.logId]: e.target.checked }))}
                            className="accent-amber-500 w-3.5 h-3.5"
                            aria-label={`选择回档 ${c.playerName ?? ''} 行${c.rowIndex ?? '?'}`}
                          />
                        </td>
                      </tr>
                    ))}
                    {candidates.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-[11px] text-muted-foreground/70">
                          暂无可回档的历史写入 —— 完成一次工单审批写入后，此处将列出回档候选
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 回档结果（逐项成败；失败绝不显示为成功） */}
            {result && (
              <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] max-h-32 overflow-y-auto">
                <span className="font-bold text-white">{result.message}</span>
                {result.results.map(x => (
                  <span key={x.logId} className={x.status === 'ROLLED_BACK' ? 'text-jade-400' : 'text-red-300'}>
                    · {x.playerName ?? x.logId.slice(0, 8)} {x.status === 'ROLLED_BACK' ? '✓ 已回档恢复' : `✗ ${x.message ?? '被阻止'}`}
                  </span>
                ))}
              </div>
            )}
            {execError && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{execError}</span>
              </div>
            )}

            <DialogFooter className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] text-muted-foreground mr-auto">
                已选 {selectedRows.length} 项 · 仅可回档项可勾选 · 执行时逐项复核
              </span>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={executing}
                className="rounded-lg px-3 py-2 text-xs text-white/70 border border-white/15 hover:bg-white/5 transition-colors disabled:opacity-50 min-h-[36px]"
              >
                关闭
              </button>
              <button
                type="button"
                disabled={selectedRows.length === 0 || executing}
                onClick={() => setConfirmOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[36px]"
              >
                {executing && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                回档所选{selectedRows.length > 0 ? `（${selectedRows.length} 项）` : ''}
              </button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>

      {/* 二次确认：展示恢复范围 → 确认执行 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="bg-[#111] border border-white/15 max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">确认回档 {selectedRows.length} 项？</AlertDialogTitle>
            <AlertDialogDescription className="text-white/70 text-xs leading-relaxed">
              <span className="block font-bold text-white/80 mb-1">恢复范围（逐项）：</span>
              {selectedRows.map(c => (
                <span key={c.logId} className="block text-[11px] text-white/60">
                  · {c.playerName} · {MODE_LABELS[c.mode ?? ''] ?? c.mode}{' '}
                  {c.tierTo}→<b className="text-amber-300">{c.restoreTierDisplay}</b>
                  {c.created ? '（新建条目 → 恢复为空段位，保留条目不删除）' : '（恢复为写入前段位）'}
                </span>
              ))}
              <span className="block mt-2 text-[11px] text-white/50">
                仅恢复 tiers 字段，不动玩家其他数据；执行时逐项复核当前段位（不符即阻止，绝不覆盖回档后新记录）；
                回档全程留审计日志，源操作日志永不删除。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={executing} className="bg-transparent text-white/70 border border-white/15 hover:bg-white/5 text-xs">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={executing}
              onClick={e => {
                e.preventDefault();
                void executeRollback();
              }}
              className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold"
            >
              {executing ? '回档中…' : '确认回档'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

// ---------- 总览日志（真实 OperationLog 只读接入 + R2 独立回档按钮） ----------

interface AuditLogEntry {
  id: string;
  at: string;
  operator: string;
  kind?: 'approve' | 'rollback' | 'reject' | 'restore' | null;
  rowIndex: number | null;
  playerName: string | null;
  mode: string | null;
  tierTo: string | null;
  created: boolean;
  detail: string;
}

interface LogsResponse {
  ok: boolean;
  logs: AuditLogEntry[];
  message?: string;
  error?: string;
}

function AuditLogSection({ refreshKey }: { refreshKey: number }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // R2：回档弹窗 + 本地刷新版本（回档成功后自刷新）
  const [rbOpen, setRbOpen] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await adminFetch('/api/v1/tier-command/logs');
        const data = (await res.json()) as LogsResponse;
        if (!alive) return;
        if (!res.ok || !data.ok) {
          setErrorMsg(data.message || data.error || `日志加载失败（HTTP ${res.status}）`);
          setState('error');
          return;
        }
        setLogs(data.logs);
        setState('ready');
      } catch {
        if (!alive) return;
        setErrorMsg('日志请求发送失败（网络异常），请稍后重试');
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey, version]);

  return (
    <div className="flex flex-col gap-3" aria-label="审批审计日志区">
      {state === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4" role="status">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          日志加载中…
        </div>
      )}
      {state === 'error' && errorMsg && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
      {state === 'ready' && logs.length === 0 && (
        <div
          className="rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-6 flex items-center justify-center"
          aria-label="审批日志空态"
        >
          <span className="text-[11px] text-muted-foreground/70">暂无审批记录 —— 完成一次工单审批写入后，此处将显示审计日志</span>
        </div>
      )}
      {state === 'ready' && logs.length > 0 && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <div className="max-h-96 overflow-y-auto overflow-x-auto">
            <table className="w-full min-w-[720px] text-[11px]">
              <thead className="sticky top-0 bg-white/[0.06] backdrop-blur text-white/70">
                <tr>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">时间</th>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">类型</th>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">操作人</th>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">工单行 · 玩家</th>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">写入 Tier</th>
                  <th className="text-left font-bold px-2 py-1.5 whitespace-nowrap">备注</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => {
                  const modeLabel = l.mode ? (MODE_LABELS[l.mode as GameMode] ?? l.mode) : null;
                  const kindBadge = l.kind ? LOG_KIND_BADGE[l.kind] : null;
                  return (
                    <tr key={l.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                      <td className="px-2 py-1.5 text-white/70 whitespace-nowrap">{fmtLogTime(l.at)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {kindBadge ? (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${kindBadge.cls}`}>
                            {kindBadge.label}
                          </span>
                        ) : (
                          <span className="text-white/40">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">{l.operator}</td>
                      <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">
                        {l.rowIndex !== null && l.playerName ? (
                          <span title={l.detail}>行{l.rowIndex} · {l.playerName}</span>
                        ) : (
                          <span className="text-white/50 max-w-[320px] truncate inline-block align-middle" title={l.detail}>{l.detail}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">
                        {l.tierTo ? (
                          <span>
                            {modeLabel && <span className="text-white/60">{modeLabel} · </span>}
                            <span className="font-bold text-jade-300">{l.tierTo}</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {l.created ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            新建玩家
                          </span>
                        ) : (
                          <span className="text-white/40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {state === 'ready' && logs.length > 0 && (
        <p className="text-[10px] text-muted-foreground/70">
          最近 {logs.length} 条工单审计（OperationLog 只读）· 写入 / 回档 / 拒绝 / 撤销拒绝 · 每条含操作人与操作详情
        </p>
      )}

      {/* R2：独立「回档」按钮 + 弹窗（位于工单日志旁） */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRbOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors min-h-[36px]"
          aria-label="打开写入回档"
        >
          <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
          回档
        </button>
        <span className="text-[10px] text-muted-foreground">
          选择性回档历史写入（恢复范围明确 · 不覆盖回档后新记录 · 全程留审计日志）
        </span>
      </div>
      <RollbackDialog open={rbOpen} onOpenChange={setRbOpen} onChanged={() => setVersion(v => v + 1)} />
    </div>
  );
}

// ---------- 面板主体 ----------

export default function TierTicketPanel() {
  // 审批/拒绝 → key 自增 → 总览日志重新拉取（联动刷新）
  const [logRefreshKey, setLogRefreshKey] = useState(0);

  return (
    <section aria-label="Tier 工单" className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            Tier 工单
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground border border-secondary-foreground/30 tracking-wider">
              R2
            </span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            腾讯文档「tier测试工单」接入模块 —— 工单源：tier测试工单（收集结果）
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* Tier 工单审核与写入（R2：按测试者分组 + 逐条审核 + 回档） */}
        <div className="rounded-xl border border-jade-500/25 bg-white/[0.03] p-4 flex flex-col gap-3 md:col-span-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-jade-500/15 border border-jade-500/30">
                <RefreshCw className="w-4 h-4 text-jade-400" aria-hidden="true" />
              </span>
              <h3 className="text-sm font-bold text-white">Tier 工单审核与写入</h3>
            </div>
            <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-jade-500/15 text-jade-300 border border-jade-500/30 tracking-wider">
              已上线
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            按「测试者」分组堆叠全部记录（组内按测试日期从新到旧；换考核者仍同组；身份不确定归「待核实」）→
            每条记录独立审核（通过·写入 / 拒绝，拒绝持久化、仅撤销恢复）→ 多字段重复检测（对方已写入即强提醒）→
            勾选任意一条或多条写入（二次确认 + 幂等防重 + 审计日志）；支持回档恢复误写入（恢复范围明确、不覆盖后续变更）
          </p>
          <SyncSection onApproved={() => setLogRefreshKey(k => k + 1)} />
        </div>

        {/* 归档台账（TIER_RECORD_RECOGNITION_REBUILD_V1，管理员批复 2026-11-09）：
            收集表 d5roro 玩家优先识别 + 完全相同才合并 + 幂等自动归档 + 玩家确认 */}
        <div className="rounded-xl border border-jade-500/25 bg-white/[0.03] p-4 flex flex-col gap-3 md:col-span-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-jade-500/15 border border-jade-500/30">
                <Archive className="w-4 h-4 text-jade-400" aria-hidden="true" />
              </span>
              <h3 className="text-sm font-bold text-white">归档台账（收集表识别与自动归档）</h3>
            </div>
            <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-jade-500/15 text-jade-300 border border-jade-500/30 tracking-wider">
              V1 · 已上线
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            数据源：收集表 d5roro（真实拉取，与整理表同步通道互不影响）—— 玩家名称优先识别（提交者仅审计）→
            完全相同业务字段才合并（任一不同独立保留）→ 四层排序（玩家名 → 考核组合 → 测试日期旧→新）→
            幂等归档（同一行重复拉取仅计数，绝不重复累计）→ 逐条人工审批写入 → 已注册玩家本人确认（或提出异议）；
            双方胜场独立记录展示，击杀/死亡文档未提供显式标注（不补 0、不推算、不入评分）
          </p>
          <TierLedgerSection onApproved={() => setLogRefreshKey(k => k + 1)} />
        </div>

        {/* 总览日志（OperationLog 只读接入 + R2 独立回档按钮） */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 flex flex-col gap-3 md:col-span-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-jade-500/15 border border-jade-500/30">
                <History className="w-4 h-4 text-jade-400" aria-hidden="true" />
              </span>
              <h3 className="text-sm font-bold text-white">总览日志</h3>
            </div>
            <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground border border-white/10 tracking-wider">
              只读 · 审计
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            工单审计历史（最近 30 条）—— 时间 / 类型（写入·回档·拒绝·撤销拒绝）/ 操作人 / 记录与变更内容；新建玩家单列标注
          </p>
          <AuditLogSection refreshKey={logRefreshKey} />
        </div>
      </div>
    </section>
  );
}
