// ============================================================
// Tier Command · 腾讯文档 sheet protobuf 解码器（P1-B 纯内存解析器）
// ------------------------------------------------------------
// 解码链（P0.6 实测 + P1 三项补证字节级取证，见 docs/tier-command-p1a-precheck.md）：
//   opendoc JSON → block_datas[i].related_sheet（base64 字符串，"eAF" 前缀 = 78 01 zlib 头）
//   → zlib inflate → protobuf wire 树 → 三类结构：
//     ① 稀疏值池：字符串池 f19.f5.f1×N（{f1: utf8} 项）+ 数值池 f19.f5.f3×N（{f1: fixed64 LE} 项）
//     ② (row,col)→池引用映射表：f19.f6×N（f1=row 缺省0 · f2=col 缺省0 · f3{f1=类型,f2{f1=ref},f4{f1=样式ref}}）
//     ③ 表单字段类型映射：root.f5(kind=13).f14.f4×N（f2{f1,f2}=列序 · f4.f3.f1.f1=类型串）
//   样式表：f19.f4.f2×N（f1.f1=样式号 300=datetime / 301=date · f3.f1.f1=格式串）
//
// 字节级纪律（补证1 结论，实现必须遵守）：
//   - 值池字符串项 = {f1: <utf8 bytes>}：取内层 f1 的 payload 直接 UTF-8 解码，
//     严禁对内层 payload 再做 protobuf 解析（纯 CJK 串会伪解析出异常大字段号）；
//   - 数值项 = {f1: fixed64 LE} = IEEE754 double（Excel 日期序列，1899-12-30 纪元）；
//   - 数值引用基线 = 129 + 池内下标（129→double#0）。
//     ⚠ 单样本假设（P1 补证2 如实标记）：P1-B 用全部现存行自动复核（双假设判别），
//       解析器同时记录 rawRef 供审计，绝不静默丢弃引用异常。
// 纯函数、零 IO、零状态、零写库（P1-B 仅内存）。
// ============================================================

import { inflateSync } from 'node:zlib';

/** 数值池引用基线：ref >= 129 视作数值池引用（ref-129=下标）。单样本假设，验证脚本逐行复核。 */
export const NUMERIC_REF_BASELINE = 129;

// ---------- protobuf wire 层 ----------

export interface WireField {
  num: number;
  wire: number;
  varint?: number;
  fixed64?: Uint8Array; // wire=1 原始 8 字节（小端）
  bytes: Uint8Array;    // wire=2 payload；其余为空
}

/**
 * varint 读取（number 实现）。
 * 精度边界：本解析器消费的 varint 值只有 标签/长度/引用/样式号/行列 等，
 * 均 < 2^49（< 2^53 double 安全整数）；超界显式报错，绝不静默截断。
 * （项目 tsconfig target < ES2020，不用 BigInt 字面量，避免动全局编译配置。）
 */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf: varint 越界');
    const b = buf[pos]!;
    pos += 1;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 49) throw new Error('protobuf: varint 超出 number 精度边界（>2^49）');
  }
}

/** 把一段 buffer 按 protobuf wire 格式切字段（宽松：未知字段保留 bytes 以便审计）。 */
export function readWireFields(buf: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    pos = p1;
    const num = Math.floor(key / 8);
    const wire = key % 8;
    if (num === 0) throw new Error(`protobuf: 非法字段号 0 @ offset ${pos}`);
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      fields.push({ num, wire, varint: v, bytes: new Uint8Array(0) });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error(`protobuf: fixed64 越界 @ offset ${pos}`);
      const raw = buf.slice(pos, pos + 8);
      pos += 8;
      fields.push({ num, wire, fixed64: raw, bytes: raw });
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error(`protobuf: fixed32 越界 @ offset ${pos}`);
      pos += 4;
      fields.push({ num, wire, bytes: new Uint8Array(0) });
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      const l = len;
      if (pos + l > buf.length) throw new Error(`protobuf: 长度字段越界 @ offset ${pos} len=${l}`);
      const payload = buf.slice(pos, pos + l);
      pos += l;
      fields.push({ num, wire, bytes: payload });
    } else {
      throw new Error(`protobuf: 不支持的 wire type ${wire} @ offset ${pos}`);
    }
  }
  return fields;
}

function pick(msg: WireField[], num: number, wire: number): WireField | undefined {
  return msg.find(f => f.num === num && f.wire === wire);
}

function pickAll(msg: WireField[], num: number, wire: number): WireField[] {
  return msg.filter(f => f.num === num && f.wire === wire);
}

function varintOf(f: WireField | undefined, fallback: number): number {
  return f?.varint !== undefined ? f.varint : fallback;
}

// ---------- 结构类型 ----------

export interface SheetStyle {
  id: number;      // 样式号（300/301…）
  format: string;  // 'yyyy/m/d h:mm:ss;@' 等
}

export type CellKind = 'string' | 'number' | 'empty' | 'unknown';

export interface DecodedCell {
  row: number;             // sheet 行号（0=表头行）
  col: number;             // 0..8
  kind: CellKind;
  text: string | null;     // kind=string
  number: number | null;   // kind=number（Excel 序列等）
  styleRef: number | null; // f3.f4.f1 原始样式引用（语义未定死，仅审计+交叉核对）
  rawRef: number;          // f3.f2.f1 原始池引用（审计用；-1=该格未出现在映射中）
}

export interface DecodedSheet {
  sheetId: string;                 // y344e4
  sheetTitle: string | null;       // 「tier测试工单（收集结果）」
  headers: string[];               // 行0 全列
  headerFormTypes: (string | null)[]; // 按列：<author>/<time>/RADIO/DATE/SIMPLE…（剥掉尾部 ID 数字）
  rows: DecodedCell[][];           // 数据行（按 sheet 行号升序，row 从 1 起）
  rowNumbers: number[];            // 与 rows 对齐
  blockRowMax: number | null;      // f19.f3.f4（行数-1 线索，与 JSON 层 max_row 交叉核对用）
  blockColMax: number | null;      // f19.f3.f5（列数-1 线索）
  stringPool: string[];
  numericPool: number[];
  styles: SheetStyle[];
  numericRefBaseline: number;
  anomalies: string[];             // 引用越界 / 伪解析防御触发 / 结构意外等（绝不静默）
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function toHexPreview(bytes: Uint8Array, max = 24): string {
  return Array.from(bytes.slice(0, max)).map(b => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? '…' : '');
}

/** 值池字符串项：{f1: <utf8>} —— 内层 payload 直接解码，禁止二次 wire 解析（补证1）。 */
function decodeStringPoolItem(item: Uint8Array, anomalies: string[], idx: number): string {
  const fields = readWireFields(item);
  const f1 = pick(fields, 1, 2);
  const payload = f1 ? f1.bytes : item; // 无 f1 时退化为整段（并记异常）
  if (!f1) anomalies.push(`string_pool[${idx}]: 缺内层 f1，按整段 UTF-8 兜底解码`);
  try {
    return utf8Decoder.decode(payload);
  } catch {
    anomalies.push(`string_pool[${idx}]: payload 非 UTF-8，hex=${toHexPreview(payload)}`);
    return '';
  }
}

function decodeNumericPoolItem(item: Uint8Array, anomalies: string[], idx: number): number {
  const fields = readWireFields(item);
  const f1 = pick(fields, 1, 1);
  if (!f1?.fixed64 || f1.fixed64.length !== 8) {
    anomalies.push(`numeric_pool[${idx}]: 缺 f1/fixed64，hex=${toHexPreview(item)}`);
    return NaN;
  }
  const dv = new DataView(f1.fixed64.buffer, f1.fixed64.byteOffset, f1.fixed64.byteLength);
  return dv.getFloat64(0, true); // little-endian
}

/** 样式表 f19.f4.f2×N：{f1:{f1:样式号}, f3:{f1:格式串本体}}（格式串仅嵌套一层，直接是 payload） */
function parseStyleTable(f4Msg: WireField[]): SheetStyle[] {
  const styles: SheetStyle[] = [];
  for (const entry of pickAll(f4Msg, 2, 2)) {
    const em = readWireFields(entry.bytes);
    const idMsg = pick(em, 1, 2);   // {f1/w0: 样式号}
    const fmtMsg = pick(em, 3, 2);  // {f1/w2: 格式串 payload（本体，非嵌套消息）}
    if (!idMsg || !fmtMsg) continue;
    const id = varintOf(pick(readWireFields(idMsg.bytes), 1, 0), NaN);
    const fmtField = pick(readWireFields(fmtMsg.bytes), 1, 2);
    if (!Number.isFinite(id) || !fmtField) continue;
    try {
      styles.push({ id, format: utf8Decoder.decode(fmtField.bytes) });
    } catch {
      /* 格式串非 UTF-8：跳过（样式仅审计用途） */
    }
  }
  return styles;
}

/** 表单字段类型串剥 ID：'RADIO1793751299389mw1d7kn3' → 'RADIO'；'<author>' 原样。 */
export function stripFormFieldTypeId(raw: string): string {
  const m = /^([^0-9]+)/.exec(raw);
  return m ? m[1]! : raw;
}

/**
 * 解码 related_sheet（base64 → zlib → protobuf → 稀疏矩阵）。
 * 抛错 = 结构性失败（调用方应整批失败）；anomalies = 可继续但需人工知晓。
 */
export function decodeRelatedSheet(base64: string): DecodedSheet {
  const anomalies: string[] = [];
  const compressed = Buffer.from(base64, 'base64');
  if (compressed.length < 2 || compressed[0] !== 0x78) {
    throw new Error(`related_sheet 非 zlib 流（头字节 ${toHexPreview(compressed, 2)}）`);
  }
  const inflated = inflateSync(compressed);
  const root = readWireFields(inflated);
  const rootMsg = pick(root, 1, 2);
  if (!rootMsg) throw new Error('related_sheet: 缺 root.f1 主消息');
  const inner = readWireFields(rootMsg.bytes);

  let sheetId = '';
  let sheetTitle: string | null = null;
  let dataBlock: Uint8Array | null = null;
  const formTypesRaw: Array<{ col: number; raw: string }> = [];

  for (const block of pickAll(inner, 5, 2)) {
    const bm = readWireFields(block.bytes);
    const kind = varintOf(pick(bm, 1, 0), -1);
    if (kind === 4) {
      // 元信息块：f3{f1=sheetId} · f4{f1=标题}
      const meta = readWireFields(block.bytes);
      const f3 = pick(meta, 3, 2);
      if (f3) {
        const idF = pick(readWireFields(f3.bytes), 1, 2);
        if (idF) sheetId = utf8Decoder.decode(idF.bytes);
      }
      const f4 = pick(meta, 4, 2);
      if (f4) {
        const tF = pick(readWireFields(f4.bytes), 1, 2);
        if (tF) sheetTitle = utf8Decoder.decode(tF.bytes);
      }
    } else if (kind === 13) {
      // 表单字段类型映射：f14.f4×N（f1=2 的条目才带类型串；f2{f1,f2}=列序，空消息=col0）
      const f14 = pick(bm, 14, 2);
      if (!f14) continue;
      const f14m = readWireFields(f14.bytes);
      for (const entry of pickAll(f14m, 4, 2)) {
        const em = readWireFields(entry.bytes);
        const entryKind = varintOf(pick(em, 1, 0), -1);
        if (entryKind !== 2) continue; // f1=1 的条目是选项/宽度等元数据，非类型映射
        const colMsg = pick(em, 2, 2);
        let col = 0;
        if (colMsg && colMsg.bytes.length > 0) {
          const cm = readWireFields(colMsg.bytes);
          col = varintOf(pick(cm, 2, 0), varintOf(pick(cm, 1, 0), 0));
        }
        const f4e = pick(em, 4, 2);
        if (!f4e) continue;
        const f4m = readWireFields(f4e.bytes);
        const f3m = pick(f4m, 3, 2);
        if (!f3m) continue;
        const f1n = pick(readWireFields(f3m.bytes), 1, 2);
        if (!f1n) continue;
        const typeF = pick(readWireFields(f1n.bytes), 1, 2);
        if (!typeF) continue;
        formTypesRaw.push({ col, raw: utf8Decoder.decode(typeF.bytes) });
      }
    } else if (kind === 18) {
      const f19 = pick(bm, 19, 2);
      if (f19) dataBlock = f19.bytes;
    }
  }

  if (!dataBlock) throw new Error('related_sheet: 未找到数据块 f5(kind=18).f19');

  const dbm = readWireFields(dataBlock);

  // f19.f3：{f1=sheetId, f4=行数-1?, f5=列数-1?}（单样本线索，仅交叉核对）
  let blockRowMax: number | null = null;
  let blockColMax: number | null = null;
  const f3 = pick(dbm, 3, 2);
  if (f3) {
    const f3m = readWireFields(f3.bytes);
    const r = varintOf(pick(f3m, 4, 0), NaN);
    const c = varintOf(pick(f3m, 5, 0), NaN);
    blockRowMax = Number.isFinite(r) ? r : null;
    blockColMax = Number.isFinite(c) ? c : null;
    const idF = pick(f3m, 1, 2);
    if (idF && !sheetId) sheetId = utf8Decoder.decode(idF.bytes);
  }

  // f19.f4：样式表
  let styles: SheetStyle[] = [];
  const f4style = pick(dbm, 4, 2);
  if (f4style) styles = parseStyleTable(readWireFields(f4style.bytes));

  // f19.f5：值池（字符串 + 数值）
  const stringPool: string[] = [];
  const numericPool: number[] = [];
  const f5pool = pick(dbm, 5, 2);
  if (!f5pool) throw new Error('related_sheet: 数据块缺值池 f19.f5');
  const poolMsg = readWireFields(f5pool.bytes);
  for (const item of pickAll(poolMsg, 1, 2)) {
    stringPool.push(decodeStringPoolItem(item.bytes, anomalies, stringPool.length));
  }
  for (const item of pickAll(poolMsg, 3, 2)) {
    numericPool.push(decodeNumericPoolItem(item.bytes, anomalies, numericPool.length));
  }

  // 引用区重叠守卫：字符串池一旦涨到 >= 基线，0..N 与数值区语义重叠，必须显式异常
  if (stringPool.length >= NUMERIC_REF_BASELINE) {
    anomalies.push(
      `ref_zone_overlap: 字符串池长度 ${stringPool.length} 已达数值引用基线 ${NUMERIC_REF_BASELINE}，` +
      '引用解析出现语义重叠，需升级基线协议（当前按字符串池优先）',
    );
  }

  // f19.f6：稀疏 (row,col)→引用 映射
  interface RawCell { row: number; col: number; type: number; ref: number; styleRef: number | null }
  const rawCells: RawCell[] = [];
  for (const entry of pickAll(dbm, 6, 2)) {
    const em = readWireFields(entry.bytes);
    const row = varintOf(pick(em, 1, 0), 0);
    const col = varintOf(pick(em, 2, 0), 0);
    const f3c = pick(em, 3, 2);
    if (!f3c) continue;
    const cm = readWireFields(f3c.bytes);
    const type = varintOf(pick(cm, 1, 0), -1);
    let ref = 0;
    const refMsg = pick(cm, 2, 2);
    if (refMsg && refMsg.bytes.length > 0) {
      ref = varintOf(pick(readWireFields(refMsg.bytes), 1, 0), 0);
    }
    let styleRef: number | null = null;
    const styleMsg = pick(cm, 4, 2);
    if (styleMsg && styleMsg.bytes.length > 0) {
      const sm = readWireFields(styleMsg.bytes);
      const sv = varintOf(pick(sm, 1, 0), NaN);
      styleRef = Number.isFinite(sv) ? sv : null;
    }
    rawCells.push({ row, col, type, ref, styleRef });
  }

  // 引用解引用（类型感知；2026-11-05 行5~6 字节级实证修订，见 docs/tier-command-doc-v3-inline-wins.md）
  //   - type=2（数值格）：ref ≥ 129 → 数值池 [ref-129]（日期序列等大值）；
  //     ref < 129 → 内联小整数：ref 本身即值（腾讯对小整数不经池直存，
  //     实证：r4/r5 胜场格 ref=5/2 与 5/1，与 M 列评价原文「5-1」精确吻合；
  //     旧「字符串池优先」策略曾将其误解为池内标签文本——已废除）；
  //     空格由映射条目缺失表达（不出现在 f6），ref=0 合法（值 0）。
  //   - type=4（文本格）：字符串池 [ref]。
  //   - 其他类型（未实证形态）：维持字符串池优先→数值池的历史兜底 + anomaly 显式上报。
  function resolve(cell: RawCell): DecodedCell {
    const base: DecodedCell = {
      row: cell.row, col: cell.col, kind: 'empty', text: null, number: null,
      styleRef: cell.styleRef, rawRef: cell.ref,
    };
    if (cell.type === 2) {
      if (cell.ref >= NUMERIC_REF_BASELINE) {
        const numericIdx = cell.ref - NUMERIC_REF_BASELINE;
        if (numericIdx < numericPool.length) {
          return { ...base, kind: 'number', number: numericPool[numericIdx] ?? null };
        }
        anomalies.push(
          `cell(${cell.row},${cell.col}): 数值格引用 ${cell.ref} 越出数值池` +
          `（数值区 ${NUMERIC_REF_BASELINE}..${NUMERIC_REF_BASELINE + numericPool.length - 1}）→ unknown`,
        );
        return { ...base, kind: 'unknown' };
      }
      return { ...base, kind: 'number', number: cell.ref };
    }
    if (cell.ref < stringPool.length) {
      return { ...base, kind: 'string', text: stringPool[cell.ref] ?? null };
    }
    const numericIdx = cell.ref - NUMERIC_REF_BASELINE;
    if (cell.ref >= NUMERIC_REF_BASELINE && numericIdx < numericPool.length) {
      anomalies.push(
        `cell(${cell.row},${cell.col}): type=${cell.type} 非数值格命中数值池引用 ${cell.ref}` +
        '（未实证形态，按数值解入，请人工复核）',
      );
      return { ...base, kind: 'number', number: numericPool[numericIdx] ?? null };
    }
    anomalies.push(
      `cell(${cell.row},${cell.col}): 引用 ${cell.ref} 落在两池之外` +
      `（字符串池 0..${stringPool.length - 1}，数值区 ${NUMERIC_REF_BASELINE}..${NUMERIC_REF_BASELINE + numericPool.length - 1}）→ unknown`,
    );
    return { ...base, kind: 'unknown' };
  }

  // 组矩阵：行 0 = 表头，数据行 = 1..maxRow
  const colCount = rawCells.length > 0 ? Math.max(...rawCells.map(c => c.col + 1)) : 0;
  const rowCount = rawCells.length > 0 ? Math.max(...rawCells.map(c => c.row)) + 1 : 0;
  const grid: DecodedCell[][] = Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: colCount }, (_, c) => ({
      row: r, col: c, kind: 'empty' as CellKind, text: null, number: null, styleRef: null, rawRef: -1,
    })),
  );
  for (const cell of rawCells) {
    grid[cell.row]![cell.col] = resolve(cell);
  }

  const headers = grid[0]?.map(c => (c.kind === 'string' ? c.text ?? '' : '')) ?? [];
  const rows = grid.slice(1);
  const rowNumbers = rows.map((_, i) => i + 1);

  const headerFormTypes: (string | null)[] = [];
  for (let c = 0; c < colCount; c++) {
    const hit = formTypesRaw.find(t => t.col === c);
    headerFormTypes.push(hit ? stripFormFieldTypeId(hit.raw) : null);
  }

  return {
    sheetId,
    sheetTitle,
    headers,
    headerFormTypes,
    rows,
    rowNumbers,
    blockRowMax,
    blockColMax,
    stringPool,
    numericPool,
    styles,
    numericRefBaseline: NUMERIC_REF_BASELINE,
    anomalies,
  };
}
