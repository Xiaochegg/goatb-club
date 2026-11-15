// ============================================================
// Tier Command · 多字段重复检测组合键（R2，纯函数零 IO）
// ------------------------------------------------------------
// 需求（用户 2026-11-06 拍板）：重复检测综合「测试者+日期+时间+模式」等
//   多字段，不只看积分；并识别已写入记录防重复录入。
//
// 与既有指纹的关系（三套并行、语义不同）：
//   - 行指纹（pipeline.fingerprintTicket）：含物理行号 —— 水位主键；
//   - 内容指纹（content-fingerprint cfp1）：全部 12 槽精确内容 —— 同一逻辑工单；
//   - dupKey（本模块）：业务要素组合键（测试者+测试日期+考核者+项目+tier）——
//     「同测试者同日同考核者同模式同目标段位」的疑似重复/重复录入检测，
//     不含胜场/评价/提交时间等易变槽（修正胜场或补填评价不影响判定）。
//
// 纪律：
//   - 测试者（写榜对象 gameId）或测试日期缺失 → dupKey=null（身份/时间不明，
//     不参与比对，绝不猜测）；
//   - 组合键为 advisory 信源：命中仅产生「疑似重复」提示（UI 徽章+警告），
//     不自动拦截 —— 同日同人同考核者的两场真实测试由管理员人工裁决；
//     「同一份内容仅允许写入一次」的硬拦截仍由 cfp1（approve-gate ②）承担；
//   - 纯函数、零 IO、零写库（与 column-map/content-fingerprint 同纪律）。
// ============================================================

import { CFP_VERSION, type TierContentSnapshot } from './content-fingerprint';

/** 槽位分隔符（业务要素值均为表格文本，\u0001 控制符已被内容净化排除，不碰撞） */
const DUP_FS = '\u0001';

export const DUP_KEY_VERSION = 'dup1';

export interface DupKeyInput {
  /** 测试者（写榜对象）游戏 id —— 缺失 → null */
  testeeGameId: string | null | undefined;
  /** 测试日期显示串（'2026-11-03'）—— 缺失 → null */
  testDateDisplay: string | null | undefined;
  /** 考核员游戏 id（可为空串：历史行常态） */
  testerGameId: string | null | undefined;
  /** 测试项目原文（模式信源） */
  projectRaw: string | null | undefined;
  /** 目标 tier（归一化大写优先，未命中词表用原文） */
  tier: string | null | undefined;
}

/**
 * 计算重复检测组合键（'dup1:<hash 前缀可读串>'）。
 * 返回 null = 要素不足（测试者或日期缺失），不参与重复比对。
 */
export function computeDupKey(input: DupKeyInput): string | null {
  const testee = String(input.testeeGameId ?? '').trim();
  const testDate = String(input.testDateDisplay ?? '').trim();
  if (!testee || !testDate) return null;
  const parts = [
    DUP_KEY_VERSION,
    testee,
    testDate,
    String(input.testerGameId ?? '').trim(),
    String(input.projectRaw ?? '').trim(),
    String(input.tier ?? '').trim(),
  ];
  return parts.join(DUP_FS);
}

/**
 * 由持久化内容快照复算 dupKey（水位旧条目无 dupKey 字段时的兼容通道；
 * 与 computeDupKey 同一组合语义：快照 14 逻辑字段 → 5 业务要素）。
 * 无快照 / cfp 版本不符 / 要素不足 → null（不猜测）。
 */
export function dupKeyFromSnapshot(s: TierContentSnapshot | null | undefined): string | null {
  if (!s || s.cfpVersion !== CFP_VERSION) return null;
  const testeeGameId = s.testee.kind === 'text' ? s.testee.gameId : '';
  const testDateDisplay = s.testDate.kind === 'date' || s.testDate.kind === 'datetime'
    ? (s.testDate.display ?? '').slice(0, 10)   // D 列到日；datetime 串取日期段
    : '';
  const testerGameId = s.tester.kind === 'text' ? s.tester.gameId : '';
  const projectRaw = s.project.kind === 'text' ? s.project.raw : '';
  const tier = s.targetTier.kind === 'tier'
    ? (s.targetTier.normalized ?? '')
    : s.targetTier.kind === 'text' ? s.targetTier.raw : '';
  return computeDupKey({ testeeGameId, testDateDisplay, testerGameId, projectRaw, tier });
}
