// ============================================================
// Tier Command · 腾讯文档 opendoc 只读客户端（P1-B 纯内存解析器配套）
// ------------------------------------------------------------
// 职责：拉取指定公开 sheet 文档的 opendoc 原始响应，剥 JSONP 壳，
//       定位 block_datas[].related_sheet（base64），交由 protobuf-parse 解码。
// 本文件只做网络 IO + JSON 定位，不做任何业务解释；零凭据、零写库。
//
// 调用纪律（P0.6 实测硬约束，docs/tier-command-p06-single-doc-sync.md §1.3）：
//   1. 必须带浏览器 UA + Referer（裸请求 401，实测）
//   2. 必须限频：进程内最小间隔 + 失败退避重试
//   3. 文档权限必须保持"所有人可查看"：权限收紧时 padType=blankpage，
//      本客户端显式报错（绝不静默返回错数据）
// 参数组（P0.6 实证 5/5 稳定 + P1 补证 3/3 稳定）：完整参数含 tab=，
//   缺 tab= 会返回 blankpage（1369B 可 distinguish）；t= 任意 cache-buster。
// 进程内存态（lastFetchAt）仅用于限频，不持久化 —— 符合"P1-B 幂等仅内存"决策。
// ============================================================

/** 目标文档（单文档定制，P0.6 范围收缩决策；Config 覆盖留待 P1-C） */
export const TIER_DOC_ID = 'DUExqcGxpT1NzcFFX';
export const TIER_DOC_TAB_ID = 'y344e4';
export const TIER_DOC_URL = `https://docs.qq.com/sheet/${TIER_DOC_ID}`;

const OPENDOC_ENDPOINT = 'https://docs.qq.com/dop-api/opendoc';

/** 分页窗口（与前端一致 endrow=60）；max_row 超出时由调用方显式标记，不静默截断
 *  V1（TIER_RECORD_RECOGNITION_REBUILD_V1，批复 2026-11-09）：ingest 归档通道
 *  以可选 endRow 参数解除自我设限（实测 endrow=1000 一次拉全量，偏移分页不可用
 *  也无需使用，报告 §1.5）；本常量与现行 sync 通道行为不变（默认 60）。 */
export const OPENDOC_END_ROW = 60;
/** ingest 归档通道拉取窗口（报告 §1.5 实测：覆盖 maxRow=16 全量；越界守卫保留） */
export const OPENDOC_END_ROW_INGEST = 1000;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_MIN_INTERVAL_MS = 10_000; // 手动同步场景天然低频（P0.6 §1.3）

/** 浏览器同款头（实测必需：裸请求 401） */
function browserHeaders(referer: string): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: referer,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
}

/** P0.6 实证的完整参数组（缺 tab= 会 blankpage）——泛化版：tab 可指定；
 *  endRow 可选（默认 60 = 现行行为零变化；ingest 传 1000） */
export function buildOpendocUrlForTab(tabId: string, cacheBuster: string, endRow: number = OPENDOC_END_ROW): string {
  const params = new URLSearchParams({
    u: '',
    noEscape: '1',
    enableSmartsheetSplit: '1',
    tab: tabId,
    startrow: '0',
    endrow: String(endRow),
    needSheetState: '1',
    sliceStates: '1',
    block_end_col: '31',
    block_end_row: '255',
    block_start_col: '0',
    block_start_row: '0',
    id: TIER_DOC_ID,
    normal: '1',
    outformat: '1',
    wb: '1',
    nowb: '0',
    callback: 'clientVarsCallback',
    xsrf: '',
    t: cacheBuster,
  });
  return `${OPENDOC_ENDPOINT}?${params.toString()}`;
}

/** 现行同步目标（y344e4 整理表）——向后兼容包装 */
export function buildOpendocUrl(cacheBuster: string): string {
  return buildOpendocUrlForTab(TIER_DOC_TAB_ID, cacheBuster);
}

// ---------- 双 tab 清单解析（R3 双表盘点，批复 2026-11-07） ----------

/**
 * tab 清单项（实测实证 2026-11-08，probe 探针）:
 *   - 当前 tab：clientVars.collab_client_vars.padSubId（如 y344e4）；
 *   - 其余关联 tab：clientVars.relative[]（{sub_id, sub_type:"grid", doc_url,...}，
 *     无 name/hidden 字段 —— 双 tab 审计报告 §1 的 header[0].d[] 路径在实测中
 *     不存在，以本探针实证为准（报告更正见批次报告）。
 */
export interface DocTabInfo {
  id: string;      // sub_id（如 y344e4 / d5roro）
  type: string;    // sub_type（grid = 表格）
  self: boolean;   // 是否本次响应的当前 tab（padSubId 命中）
  name: string;    // 预留：relative 结构无 name，恒 ''（UI 用角色标签兜底）
  hidden: boolean; // 预留：relative 结构无 hidden，恒 false
}

/**
 * 从 opendoc 原始响应（JSONP）解析文档 tab 清单（只读，纯函数）。
 * = 当前 tab（self）+ relative[] 其余关联 tab（去重）；
 * 防御式：任何结构缺失/非数组 → 仅返回已确认部分，绝不抛错阻断快照主流程。
 */
export function parseTabListFromRaw(rawBody: string): DocTabInfo[] {
  const tabs: DocTabInfo[] = [];
  const seen = new Set<string>();
  try {
    const json = JSON.parse(peelJsonp(rawBody)) as Record<string, unknown>;
    const cv = (json.clientVars ?? null) as Record<string, unknown> | null;
    if (cv && typeof cv === 'object' && !Array.isArray(cv)) {
      // ① 当前 tab（self）
      const ccv = (cv.collab_client_vars ?? null) as Record<string, unknown> | null;
      const selfId = ccv && typeof ccv === 'object' && typeof ccv.padSubId === 'string' ? ccv.padSubId : null;
      if (selfId) {
        tabs.push({ id: selfId, type: 'grid', self: true, name: '', hidden: false });
        seen.add(selfId);
      }
      // ② 其余关联 tab
      const rel = Array.isArray(cv.relative) ? cv.relative : [];
      for (const item of rel) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const t = item as Record<string, unknown>;
        if (typeof t.sub_id !== 'string' || t.sub_id === '' || seen.has(t.sub_id)) continue;
        seen.add(t.sub_id);
        tabs.push({
          id: t.sub_id,
          type: typeof t.sub_type === 'string' ? t.sub_type : '',
          self: false,
          name: '',
          hidden: false,
        });
      }
    }
  } catch {
    /* 坏 JSON：返回已收集部分（可能为空），调用方降级 */
  }
  return tabs;
}

export type TencentDocErrorCode =
  | 'HTTP_STATUS'
  | 'HTTP_401'
  | 'BLANKPAGE'
  | 'BAD_JSONP'
  | 'NO_CLIENT_VARS'
  | 'NO_TEXT_BLOCK'
  | 'NO_RELATED_SHEET'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'NETWORK';

export class TencentDocError extends Error {
  code: TencentDocErrorCode;
  httpStatus: number | null;
  constructor(code: TencentDocErrorCode, message: string, httpStatus: number | null = null) {
    super(`[tencent-doc:${code}] ${message}`);
    this.name = 'TencentDocError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface OpendocSnapshot {
  docId: string;
  tabId: string;
  fetchedAt: string;          // ISO（拉取时刻）
  httpStatus: number;
  bytes: number;              // 原始响应字节数
  padType: string;            // 'sheet' 正常；'blankpage' = 权限/参数异常
  maxRow: number;             // JSON 层 max_row（表头 + 数据行）
  maxCol: number;             // JSON 层 max_col
  relatedSheets: string[];    // base64（当前实证恒 1 块；多块时调用方必须显式处理）
  endRowRequested: number;    // 请求窗口（分页守卫用：maxRow-1 > endRow-1 → 未实证分页）
  cacheBuster: string;
}

interface OpendocTopLevel {
  padType?: unknown;
  clientVars?: unknown;
}

interface CollabVars {
  collab_client_vars?: unknown;
}

interface TextBlockCarrier {
  initialAttributedText?: unknown;
}

/** 剥 JSONP：clientVarsCallback({...}); → {...} */
export function peelJsonp(raw: string): string {
  const start = raw.indexOf('(');
  const end = raw.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) {
    throw new TencentDocError('BAD_JSONP', `响应非 JSONP 包裹（前 48 字节: ${raw.slice(0, 48).replace(/\s+/g, ' ')}）`);
  }
  return raw.slice(start + 1, end);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从 opendoc 响应定位数据结构并提取 related_sheet base64 数组。
 * 结构路径（P0.6/P1 实证）：
 *   clientVars.collab_client_vars.initialAttributedText.text[0].{max_row,max_col,block_datas[].related_sheet}
 */
export function locateSheetData(rawBody: string): Omit<OpendocSnapshot, 'docId' | 'tabId' | 'fetchedAt' | 'httpStatus' | 'bytes' | 'cacheBuster' | 'endRowRequested'> {
  const json = JSON.parse(peelJsonp(rawBody)) as OpendocTopLevel;

  const padType = typeof json.padType === 'string' ? json.padType : '';
  if (padType !== 'sheet') {
    // 权限收紧 / 参数组缺失 → 腾讯返回 blankpage（实测 1369B）
    throw new TencentDocError('BLANKPAGE', `padType=${padType || '<missing>'}（非 sheet），文档不可读或参数组不完整`);
  }

  const cv = json.clientVars;
  if (!isRecord(cv)) throw new TencentDocError('NO_CLIENT_VARS', '响应缺 clientVars');
  const ccv = (cv as unknown as CollabVars).collab_client_vars;
  if (!isRecord(ccv)) throw new TencentDocError('NO_CLIENT_VARS', '响应缺 collab_client_vars');
  const iat = (ccv as unknown as TextBlockCarrier).initialAttributedText;
  if (!isRecord(iat)) throw new TencentDocError('NO_TEXT_BLOCK', '响应缺 initialAttributedText');
  const text = iat.text;
  if (!Array.isArray(text) || text.length === 0 || !isRecord(text[0])) {
    throw new TencentDocError('NO_TEXT_BLOCK', 'initialAttributedText.text 非数组或为空');
  }
  const t0 = text[0] as Record<string, unknown>;

  const maxRow = typeof t0.max_row === 'number' ? t0.max_row : typeof ccv.maxRow === 'number' ? ccv.maxRow : 0;
  const maxCol = typeof t0.max_col === 'number' ? t0.max_col : 0;

  const blockDatas = Array.isArray(t0.block_datas) ? t0.block_datas : [];
  const relatedSheets: string[] = [];
  for (const bd of blockDatas) {
    if (isRecord(bd) && typeof bd.related_sheet === 'string') {
      relatedSheets.push(bd.related_sheet);
    }
  }
  if (relatedSheets.length === 0) {
    throw new TencentDocError('NO_RELATED_SHEET', 'block_datas 内未找到 related_sheet 字符串');
  }

  return { padType, maxRow, maxCol, relatedSheets };
}

// 进程内限频水位（仅内存，重启即清 —— 符合 P1-B 决策）
let lastFetchAt = 0;

/** 距下次可拉取的剩余毫秒数（0 = 可立即拉取；盘点端点 429 重试用） */
export function rateLimitRemainingMs(minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS): number {
  return Math.max(0, lastFetchAt + minIntervalMs - Date.now());
}

export interface FetchSheetOptions {
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  cacheBuster?: string;
  /** V1：拉取窗口（默认 60 = 现行行为；ingest 传 OPENDOC_END_ROW_INGEST=1000） */
  endRow?: number;
  /** 双表盘点专用：命中限频时等待窗口过去而非立即抛错
   *  （上限 maxWaitMs，超出仍显式 RATE_LIMITED——绝不无限等待） */
  waitRateLimit?: boolean;
  maxWaitMs?: number;
}

/**
 * 拉取当前 sheet 快照（只读）—— 现行同步目标（y344e4）向后兼容包装。
 */
export async function fetchSheetSnapshot(opts: FetchSheetOptions = {}): Promise<OpendocSnapshot> {
  return fetchTabSnapshot(TIER_DOC_TAB_ID, opts);
}

export interface TabAwareSnapshot extends OpendocSnapshot {
  /** 本次响应解析出的文档 tab 清单（opendoc 响应文档级字段，任意 tab 均携带） */
  tabs: DocTabInfo[];
}

/**
 * 拉取指定 tab 的 sheet 快照（只读，R3 双表盘点泛化版）。
 * - 限频：距上次成功/失败拉取不足 minIntervalMs 时抛 RATE_LIMITED；
 *   waitRateLimit=true 时改为等待窗口过去（上限 maxWaitMs，默认 15s）后再拉；
 * - 重试：网络级失败按 1s/3s 退避；业务级失败（401/blankpage/解析）不重试（重试无意义）。
 */
export async function fetchTabSnapshot(
  tabId: string,
  opts: FetchSheetOptions = {},
): Promise<TabAwareSnapshot> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const endRow = opts.endRow ?? OPENDOC_END_ROW; // 缺省 = 现行行为零变化

  const now = Date.now();
  const waitMs = lastFetchAt + minIntervalMs - now;
  if (waitMs > 0) {
    if (opts.waitRateLimit) {
      const capped = Math.min(waitMs, opts.maxWaitMs ?? 15_000);
      if (capped < waitMs) {
        throw new TencentDocError('RATE_LIMITED', `距上次拉取不足 ${minIntervalMs}ms（等待上限 ${capped}ms 不足），请 ${waitMs}ms 后重试`);
      }
      await new Promise(r => setTimeout(r, capped));
    } else {
      throw new TencentDocError('RATE_LIMITED', `距上次拉取不足 ${minIntervalMs}ms，请 ${waitMs}ms 后重试`);
    }
  }
  lastFetchAt = Date.now();

  const cacheBuster = opts.cacheBuster ?? Date.now().toString(16);
  const url = buildOpendocUrlForTab(tabId, cacheBuster, endRow);

  let lastErr: Error = new TencentDocError('NETWORK', '未执行');
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: browserHeaders(TIER_DOC_URL),
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = await res.text();
      if (res.status === 401) {
        throw new TencentDocError('HTTP_401', 'opendoc 401：浏览器头缺失/失效或权限收紧', 401);
      }
      if (!res.ok) {
        throw new TencentDocError('HTTP_STATUS', `opendoc HTTP ${res.status}`, res.status);
      }
      const located = locateSheetData(body);
      return {
        docId: TIER_DOC_ID,
        tabId,
        fetchedAt: new Date().toISOString(),
        httpStatus: res.status,
        bytes: Buffer.byteLength(body, 'utf8'),
        padType: located.padType,
        maxRow: located.maxRow,
        maxCol: located.maxCol,
        relatedSheets: located.relatedSheets,
        endRowRequested: endRow,
        cacheBuster,
        tabs: parseTabListFromRaw(body),
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // 业务级失败（明确 4xx/blankpage/结构错）重试无意义 → 直接上抛
      if (err instanceof TencentDocError) throw err;
      if (controller.signal.aborted) {
        lastErr = new TencentDocError('TIMEOUT', `opendoc 超时（${timeoutMs}ms）`);
      }
      // 网络级失败：退避后重试
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 3000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
