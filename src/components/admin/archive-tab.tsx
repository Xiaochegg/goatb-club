'use client';
// ============================================================
// GOATB 管理面板重组（管理员批复 2026-11-08「管理员面板重组更精简，更便利拆包」）
// 本文件由 src/components/admin-panel.tsx 机械迁移（原 L98-L115 + L2120-L2325），零逻辑改动。
// 迁移映射与验证：docs/perf/REORG-BATCH-REPORT-2026-11-08.md
// 内容：数据存档页签（自动存档 + 导出/恢复）。handleExport 唯一使用者
// 是本页签，随迁入文件（原为模块级共享 helper）。
// ============================================================
// 2026-11-09 重做（管理员指令「你那个自动存档根本不是5分钟 写一个开关吧
// 这样数据不会丢失 切换的时候缓存不会更新 你一开始就先给我关着 5分钟
// 还有 我点进那个数据的地方 它自己不等5分钟」）：
//   - 旧「自动存档」是纯前端假快照（仅本页开着才写浏览器 localStorage，
//     页面一关即停，换设备/重置即失效）—— 本批整体退场；
//   - 新自动存档 = 服务器端真快照（backup-keeper 每 5 分钟加密双副本，
//     调度独立于本页面；开关持久化 Config.auto_backup_enabled，默认关）；
//   - 进本页即先存一份（page-enter，模块级 60s 节流防快速切页连拍）；
//   - 开关/状态每次新鲜拉取（cache: 'no-store'），切换后立即回读真实状态。
// ============================================================
// 2026-11-09 纠偏（管理员指令「我没让你冷却……我想保存的时候就导出，
// 手动保存不需要冷却，自动保存才需要冷却」）：
//   - 拆除上一批的「5 分钟恢复冷却」：手动动作（立即保存/导出/从缓存恢复/
//     从文件恢复）是管理员主动行为，永不拦截，随时可用；
//   - 「冷却」的正确归属 = 自动保存不许用空榜/坏状态顶掉好备份 ——
//     由备份执行体闸门（backup-core.gateCheck 空榜签名 → quarantine）收口；
//   - 新增空库检测提醒卡（管理员指令「你都没检测到它空了……部署后你也没
//     提示我是否导入缓存数据」）：0 玩家且存在含玩家的有效备份时醒目提示，
//     一键「从缓存恢复」/「忽略本次」（GET/POST /api/v1/db-health）；
//   - exportedAt 保留为纯信息字段（确认弹窗展示存档时刻）。
// ============================================================
// 2026-11-10 撤除（管理员指令「删掉点进到那个数据储存那边的界面就自动闪存的
// 功能必须是手动点击才可以，不然有时候会误存」）：
//   - page-enter「进页即存」整体退场：挂载本页签不再触发任何存档请求，
//     前端 60s 节流（lastPageEnterRunAt / PAGE_ENTER_THROTTLE_MS）一并移除；
//   - 保存唯一入口 = 「立即保存」按钮（manual）；管理员主动切换自动存档
//     开关时的「开启即存」（auto-on）属手动操作，维持 2026-11-09 既有裁定；
//   - 服务器端 POST /api/v1/admin/backup 零改动（仍兼容 page-enter 来源，
//     无人再发送即自然失效，可逆）；triggerLabel('page-enter') 保留，
//     历史备份清单中旧 trigger 记录仍可读。
//   - 改前原文件留档：docs/file-archive/2026-11-10-remove-page-enter/
// ============================================================
import { useRef, useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Save, FileDown, FileUp, RotateCcw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';
import { toast } from '@/hooks/use-toast';
import { ConfirmDialog } from './shared';
import { Switch } from '@/components/ui/switch';
import { validateArchivePayload } from '@/lib/archive-guard';

// ============================================================
// Helper: export full archive as JSON download.
// (Moved from page.tsx — only AdminArchive uses it.)
// ============================================================
function handleExport() {
  adminFetch('/api/v1/archive').then(r => {
    if (!r.ok) throw new Error('需要管理员权限');
    return r.json();
  }).then(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `goatb-archive-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
  }).catch(() => {
    toast({ title: '导出失败', description: '请先登录管理员账号', variant: 'destructive' });
  });
}

// --- 本地缓存快照（「立即保存」同步写一份，「从缓存恢复」兼容旧数据） ---
const ARCHIVE_KEY = 'goatb-archive';
const ARCHIVE_META_KEY = 'goatb-archive-meta';

interface ArchiveMeta { savedAt: string; source: 'auto' | 'manual' }

interface ServerBackupState {
  enabled: boolean;
  dbOk: boolean;
  keeperAlive: boolean;
  intervalMin: number;
  nextRunAt: string | null;
  newest: { file: string; encryptedAt: string; status: string; trigger?: string } | null;
  // 自动存档停机事实（管理员指令 2026-11-10：内容被侵犯 → 停机等核实）
  halt: { gateStatus: string; reason: string; at: string; trigger?: string; counts?: Record<string, number> | null } | null;
}

// 空库检测（GET /api/v1/db-health 返回事实）
interface DbHealthState {
  ok: boolean;
  playerCount: number;
  leaderboardEmpty: boolean;
  newestGoodBackup: { file: string; encryptedAt: string; playerCount: number; trigger?: string } | null;
  lastEmptySnapshot: { file: string; encryptedAt: string; trigger?: string } | null;
  alertSince: string | null;
  ackAt: string | null;
  alert: boolean;
}

function triggerLabel(t?: string): string {
  switch (t) {
    case 'manual': return '手动';
    case 'page-enter': return '进页即存';
    case 'auto-on': return '开启即存';
    case 'auto-5min': return '5分钟自动';
    case 'hourly': return '每小时例行';
    default: return '—';
  }
}

// 快照时刻本地化展示（MM-DD HH:mm:ss；坏值原样透传）
function fmtMetaTime(iso: string) {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return iso; }
}

export function AdminArchive() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingRestore, setPendingRestore] = useState<{ source: string; data: unknown } | null>(null);
  const [restoring, setRestoring] = useState(false);
  // 本地缓存 meta（「立即保存」写入；「从缓存恢复」读取）
  const [meta, setMeta] = useState<ArchiveMeta | null>(null);
  // 服务器端自动存档真实状态（每次新鲜拉取，绝不缓存）
  const [serverState, setServerState] = useState<ServerBackupState | null>(null);
  // 空库检测事实（GET /api/v1/db-health）
  const [dbHealth, setDbHealth] = useState<DbHealthState | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const serverBusyRef = useRef(false);

  const readMetaFromStorage = useCallback((): ArchiveMeta | null => {
    try {
      const raw = localStorage.getItem(ARCHIVE_META_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ArchiveMeta>;
      if (typeof parsed?.savedAt !== 'string') return null;
      return { savedAt: parsed.savedAt, source: parsed.source === 'manual' ? 'manual' : 'auto' };
    } catch { return null; }
  }, []);

  // ---- 空库检测事实（no-store：进页/操作后都看最新事实） ----
  const refreshDbHealth = useCallback(async (): Promise<void> => {
    try {
      const res = await adminFetch('/api/v1/db-health', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j?.ok) setDbHealth(j as DbHealthState);
    } catch { /* 拉取失败保持上次状态 */ }
  }, []);

  // ---- 服务器状态新鲜回读（no-store：切换开关后立即看到真实状态） ----
  const refreshServerState = useCallback(async (): Promise<void> => {
    try {
      const res = await adminFetch('/api/v1/admin/backup', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (!j?.ok) return;
      setServerState({
        enabled: !!j.autoSave?.enabled,
        dbOk: j.autoSave?.dbOk !== false,
        keeperAlive: !!j.status?.enabled,
        intervalMin: Number(j.status?.autoSave?.intervalMin ?? 5),
        nextRunAt: j.status?.autoSave?.nextRunAt ?? null,
        newest: j.manifest?.newestEntry ?? null,
        halt: j.status?.autosaveHalt ?? null,
      });
    } catch { /* 拉取失败保持上次状态；状态行如实展示 */ }
  }, []);

  // ---- 服务器端立即存档（manual 按钮专用；2026-11-10 起进页不再自动存档） ----
  const runServerBackup = useCallback(async (): Promise<boolean> => {
    if (serverBusyRef.current) return false;
    serverBusyRef.current = true;
    setManualBusy(true);
    try {
      const res = await adminFetch('/api/v1/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run', source: 'manual' }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        await refreshServerState();
        return true;
      }
      toast({ title: '本次未执行', description: j?.reason ?? '备份锁被占用或备份已暂停', variant: 'destructive' });
      return false;
    } catch {
      toast({ title: '服务器备份失败', description: '网络错误', variant: 'destructive' });
      return false;
    } finally {
      serverBusyRef.current = false;
      setManualBusy(false);
    }
  }, [refreshServerState]);

  // 「立即保存」：服务器加密双副本 + 本地缓存各一份（从缓存恢复照旧可用）。
  // 2026-11-10（管理员指令「保存的缓存必须有 KB，没 KB 的就不要保存」）：
  // 内容无效（不足 1KB / 结构不符）→ 直接弃用，绝不写入本地缓存。
  const performCacheSave = useCallback(async (): Promise<{ ok: boolean; invalid?: boolean; reason?: string }> => {
    try {
      const res = await adminFetch('/api/v1/archive');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const v = validateArchivePayload(data);
      if (!v.ok) return { ok: false, invalid: true, reason: v.reason };
      const next: ArchiveMeta = { savedAt: new Date().toISOString(), source: 'manual' };
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(data));
      localStorage.setItem(ARCHIVE_META_KEY, JSON.stringify(next));
      setMeta(next);
      return { ok: true };
    } catch { return { ok: false }; }
  }, []);

  const saveNow = async () => {
    setManualBusy(true);
    const cacheRes = await performCacheSave();
    const srvOk = await runServerBackup();
    if (cacheRes.invalid) {
      // 2026-11-10：没 KB 的缓存直接弃用（不写入本地），等待有效内容再保存
      toast({ title: '缓存内容无效，已弃用', description: `${cacheRes.reason ?? '格式不符'}。本地缓存未写入（服务器备份不受影响）`, variant: 'destructive' });
    } else if (srvOk && cacheRes.ok) toast({ title: '已保存', description: '服务器加密双副本 + 本地缓存各一份' });
    else if (srvOk) toast({ title: '服务器已备份', description: '本地缓存写入失败（浏览器配额不足）', variant: 'destructive' });
    else if (cacheRes.ok) toast({ title: '已保存到本地缓存', description: '服务器备份未执行成功（见状态行）', variant: 'destructive' });
    else toast({ title: '保存失败', description: '网络错误', variant: 'destructive' });
    void refreshDbHealth();
  };

  // ---- 挂载：回填本地 meta + 新鲜拉服务器状态/空库事实 ----
  // 2026-11-10（管理员指令「必须手动点击才可以，不然有时候会误存」）：
  // 原「进页即存」（page-enter + 60s 节流）已撤除 —— 挂载本页签绝不触发
  // 任何存档请求，保存只走「立即保存」手动按钮。
  useEffect(() => {
    setMeta(readMetaFromStorage());
    void refreshServerState();
    void refreshDbHealth();
  }, [readMetaFromStorage, refreshServerState, refreshDbHealth]);

  // ---- 自动存档停机核实（管理员指令 2026-11-10「等待管理员核实自动关闭」）----
  const verifyHalt = async () => {
    setVerifyBusy(true);
    try {
      const res = await adminFetch('/api/v1/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-autosave-halt' }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        toast({ title: '已核实，停机自动关闭', description: j.cleared ? '自动存档恢复调度（若内容仍无效会再次停机保护）' : '当前本无停机标记' });
        await refreshServerState();
      } else {
        toast({ title: '核实失败', description: j?.error ?? '请稍后重试', variant: 'destructive' });
      }
    } catch {
      toast({ title: '核实失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setVerifyBusy(false);
    }
  };

  // ---- 自动存档开关（默认关；开启时服务器已先存一份） ----
  const toggleAutoSave = async (next: boolean) => {
    setSwitchBusy(true);
    try {
      const res = await adminFetch('/api/v1/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-auto-save', enabled: next }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        // 2026-11-10：开启即存（auto-on）若遇停机被拒，如实透出（开关本身已生效）
        const skipNote = next && j?.immediate?.skipped
          ? `（注意：停机中，本次开启即存已被拒绝：${j.immediate?.reason ?? ''}）`
          : '';
        toast({
          title: next ? '自动存档已开启' : '自动存档已关闭',
          description: next
            ? `服务器端每 5 分钟自动快照，无需保持本页打开；已先存一份${skipNote}`
            : '已停止周期自动快照（每小时例行备份不受影响）',
        });
        await refreshServerState();
      } else {
        toast({ title: '开关设置失败', description: j?.error ?? '请稍后重试', variant: 'destructive' });
      }
    } catch {
      toast({ title: '开关设置失败', description: '网络错误', variant: 'destructive' });
    } finally {
      setSwitchBusy(false);
    }
  };

  const exportFile = async () => {
    handleExport();
  };

  const restoreFromFile = () => {
    fileInputRef.current?.click();
  };

  // 文件选择后仅做 JSON 合法性检查 → 入待确认态。
  // 2026-11-09 纠偏：手动恢复永不拦截（冷却机制已拆除），时刻仅作展示。
  // 2026-11-10（管理员指令「导入必须检测是否有 KB，没 KB 直接弃用」）：
  // 内容无效（<1KB / 结构不符）→ 弃用，不入待确认态。
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const v = validateArchivePayload(data);
      if (!v.ok) {
        toast({ title: '文件内容无效，已弃用', description: v.reason ?? '格式不符', variant: 'destructive' });
        return;
      }
      setPendingRestore({ source: `文件「${file.name}」`, data });
    } catch {
      toast({ title: '文件格式错误', description: '仅接受合法的存档 JSON', variant: 'destructive' });
    }
    // 允许重复选择同一文件再次触发 onChange
    e.target.value = '';
  };

  // 2026-11-09 纠偏：从缓存恢复零拦截（缓存存在即可进入确认弹窗；
  // meta 只影响弹窗里显示的存档时刻，缺失不再构成拒绝理由）。
  // 2026-11-10（管理员指令「导入必须检测缓存是否有 KB，没 KB 直接弃用」）：
  // 被侵犯缓存（<1KB / 结构不符）→ 弃用本次恢复，不进确认弹窗。
  const restoreFromCache = async () => {
    const cached = localStorage.getItem(ARCHIVE_KEY);
    if (!cached) {
      toast({ title: '本地暂无缓存快照', description: '点击「立即保存」立即生成（自动存档在服务器端，不受本页影响）', variant: 'destructive' });
      return;
    }
    try {
      const data = JSON.parse(cached);
      const v = validateArchivePayload(data);
      if (!v.ok) {
        toast({ title: '缓存内容无效，已弃用', description: `${v.reason ?? '格式不符'}。可用「从文件恢复」或服务器加密备份代替`, variant: 'destructive' });
        return;
      }
      setPendingRestore({ source: '本地缓存', data });
    } catch {
      toast({ title: '缓存数据错误', variant: 'destructive' });
    }
  };

  // 确认后执行恢复；成功后延迟刷新让 toast 可见
  const doRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      const res = await adminFetch('/api/v1/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingRestore.data),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        toast({ title: '恢复成功', description: '页面即将刷新以加载恢复后的数据' });
        setTimeout(() => window.location.reload(), 800);
      } else {
        // 如实透出服务器原因（鉴权/格式/上限等）
        toast({ title: '恢复被拒绝', description: j?.error ?? '请检查存档内容或稍后重试', variant: 'destructive' });
        setRestoring(false);
        setPendingRestore(null);
      }
    } catch {
      toast({ title: '恢复失败', description: '网络错误', variant: 'destructive' });
      setRestoring(false);
      setPendingRestore(null);
    }
  };

  // ---- 空榜提醒「忽略本次」（恢复非空后提醒自动重新武装） ----
  const ackDbAlert = async () => {
    try {
      const res = await adminFetch('/api/v1/db-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ack' }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.ok) {
        setDbHealth(prev => prev ? { ...prev, alert: false, ackAt: typeof j.ackAt === 'string' ? j.ackAt : prev.ackAt } : prev);
        toast({ title: '已忽略本次提醒', description: '数据库恢复非空后，空榜提醒会自动重新武装' });
      } else {
        toast({ title: '操作失败', description: j?.error ?? '请稍后重试', variant: 'destructive' });
      }
    } catch {
      toast({ title: '操作失败', description: '网络错误', variant: 'destructive' });
    }
  };

  // 确认弹窗展示的存档时刻（取自存档数据自带的 exportedAt）
  const pendingData = pendingRestore?.data as { exportedAt?: string } | null | undefined;
  const pendingExportedAt = typeof pendingData?.exportedAt === 'string' ? pendingData.exportedAt : null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-secondary-foreground">数据存档</h3>

      {/* 2026-11-10 新增：自动存档停机横幅（内容被侵犯 → 5 分钟请求被拒绝，等待管理员核实） */}
      {serverState?.halt && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 space-y-2" role="alert">
          <p className="text-sm font-semibold text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
            自动存档已停机 —— 检测到被侵犯的存档内容
          </p>
          <p className="text-xs text-muted-foreground">
            判定：{serverState.halt.gateStatus === 'reject' ? '内容无效（损坏/过小/缺表）' : '空库/空榜签名'}
            · {serverState.halt.reason}
            {serverState.halt.counts && typeof serverState.halt.counts.Player === 'number' ? ` · Player=${serverState.halt.counts.Player}` : ''}
            （{fmtMetaTime(serverState.halt.at)} · 触发源 {triggerLabel(serverState.halt.trigger)}）。
            5 分钟自动保存请求已被直接拒绝；手动保存/恢复不受影响。核实后停机自动关闭（点下方按钮，或完成一次有效的「立即保存」）。
          </p>
          <button
            onClick={() => { void verifyHalt(); }}
            disabled={verifyBusy}
            className="spring-press px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-xs text-red-300 hover:bg-red-500/30 flex items-center gap-1 disabled:opacity-50"
          >
            <ShieldCheck className="w-3 h-3" aria-hidden /> {verifyBusy ? '核实中…' : '已核实，恢复自动存档'}
          </button>
        </div>
      )}

      {/* 2026-11-09 新增：空库检测提醒（0 玩家但存在含玩家的有效备份时醒目提示） */}
      {dbHealth?.alert && dbHealth.newestGoodBackup && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2" role="alert">
          <p className="text-sm font-semibold text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
            数据库当前为空（0 玩家）—— 疑似数据丢失
          </p>
          <p className="text-xs text-muted-foreground">
            最近一份有效备份：{fmtMetaTime(dbHealth.newestGoodBackup.encryptedAt)}
            （{dbHealth.newestGoodBackup.playerCount} 玩家{dbHealth.newestGoodBackup.trigger ? ` · ${triggerLabel(dbHealth.newestGoodBackup.trigger)}` : ''}）。
            若为意外丢失：可点「从缓存恢复」立即回退（本浏览器缓存，按名字合并写回）；
            服务器加密备份（{dbHealth.newestGoodBackup.file}）需运维脚本恢复。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { void restoreFromCache(); }}
              className="spring-press px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-xs text-amber-300 hover:bg-amber-500/30 flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" aria-hidden /> 从缓存恢复
            </button>
            <button
              onClick={() => { void ackDbAlert(); }}
              className="spring-press px-3 py-1.5 rounded-lg border border-white/10 text-xs text-muted-foreground hover:text-white hover:bg-white/5"
            >
              忽略本次（确认为有意清榜）
            </button>
          </div>
        </div>
      )}

      {/* 服务器端自动存档开关（默认关；调度在 backup-keeper，独立于本页面） */}
      <div className="rounded-xl border border-white/10 p-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary-foreground">自动存档（服务器端）</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            开启后每 {serverState?.intervalMin ?? 5} 分钟自动快照一次（加密双副本），无需保持本页打开 · 进本页不会自动保存（保存仅限手动「立即保存」） · 空榜快照只进隔离区，绝不顶掉好备份
          </p>
          <p className="text-xs text-muted-foreground mt-0.5" aria-live="polite">
            {serverState ? (
              <>
                当前：<span className={serverState.enabled ? 'text-emerald-400' : 'text-muted-foreground'}>
                  {serverState.enabled ? '已开启' : '已关闭（默认）'}
                </span>
                {serverState.enabled && serverState.nextRunAt
                  ? ` · 下轮 ${fmtMetaTime(serverState.nextRunAt)}`
                  : ''}
                {' · 最近快照：'}
                {serverState.newest
                  ? `${fmtMetaTime(serverState.newest.encryptedAt)}（${triggerLabel(serverState.newest.trigger)}${serverState.newest.status === 'quarantine' ? ' · ⚠隔离区' : ''}）`
                  : '暂无'}
                {!serverState.dbOk ? ' · ⚠开关状态读取异常，按关闭处理' : ''}
                {manualBusy ? ' · 正在保存…' : ''}
              </>
            ) : (
              '状态读取中…'
            )}
          </p>
          {meta && (
            <p className="text-xs text-muted-foreground mt-0.5">
              本地缓存：{fmtMetaTime(meta.savedAt)}（{meta.source === 'auto' ? '自动' : '手动'}）· 可随时从缓存恢复
            </p>
          )}
          {dbHealth && !dbHealth.alert && dbHealth.playerCount > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5" aria-live="polite">
              数据库：{dbHealth.playerCount} 玩家 · 正常
            </p>
          )}
        </div>
        <Switch
          checked={!!serverState?.enabled}
          onCheckedChange={(v) => { void toggleAutoSave(v); }}
          disabled={switchBusy || !serverState}
          aria-label="自动存档开关"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <motion.button onClick={saveNow} disabled={manualBusy} className="spring-press px-3 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:bg-white/5 flex items-center justify-center gap-1 disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> 立即保存
        </motion.button>
        <motion.button onClick={exportFile} className="spring-press px-3 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:bg-white/5 flex items-center justify-center gap-1">
          <FileDown className="w-3.5 h-3.5" /> 导出存档
        </motion.button>
        <motion.button onClick={restoreFromFile} className="spring-press px-3 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:bg-white/5 flex items-center justify-center gap-1">
          <FileUp className="w-3.5 h-3.5" /> 从文件恢复
        </motion.button>
        <motion.button onClick={() => { void restoreFromCache(); }} className="spring-press px-3 py-2 rounded-xl border border-white/10 text-sm text-muted-foreground hover:text-white hover:bg-white/5 flex items-center justify-center gap-1">
          <RotateCcw className="w-3.5 h-3.5" /> 从缓存恢复
        </motion.button>
      </div>
      <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileUpload} className="hidden" />

      {/* 恢复存档二次确认（手动动作零拦截；存档时刻仅作展示，缺失不构成拒绝理由）*/}
      <ConfirmDialog
        open={!!pendingRestore}
        onOpenChange={o => { if (!o) setPendingRestore(null); }}
        title="确认恢复存档？"
        description={`将把${pendingRestore?.source ?? ''}的内容合并写回服务器（同名玩家更新、缺的重建；不删除存档里没有的玩家）。存档时刻：${pendingExportedAt ? fmtMetaTime(pendingExportedAt) : '未知（旧存档，仍可恢复）'}。`}
        confirmLabel="确认恢复"
        onConfirm={doRestore}
        busy={restoring}
      />
    </div>
  );
}
