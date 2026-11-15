// ============================================================
// Tier Command · AI 建议引擎（P2，规则判断，零模型调用、零写操作）
// ------------------------------------------------------------
// 绝对硬约束（用户指令 2026-11-04）：
//   - AI 只出建议（建议通过/存疑/拒绝 + 理由），绝不执行任何写操作，
//     绝不改变行状态，无权自动勾选；
//   - 本引擎为纯函数：输入已解析工单行快照，输出建议与理由；
//     前端展示时必须带「AI 建议，仅供参考」标注。
// 规则集（可随实战扩充；全部 advisory，不拦截流程）：
//   R1 比分悬殊（≥5:0 或 ≥0:5 或净胜≥5）→ 存疑（疑似对手弃赛/刷分；
//      v2 起比分列为软删除 legacy 信源，仅历史行触发）
//   R1b 胜场悬殊（v2 新增，新比分信源）：测试者/考核员胜场均已填且
//      净胜≥5 → 存疑（语义同 R1，适配新表单）
//   R2 tier 跨度大：被测玩家⑥列拆出原 tier 候选与⑦列测试 tier 相差
//      ≥3 个小级 → 存疑（跳档嫌疑）
//   R3 录屏规则矛盾（v2 起仅历史行可能触发：录屏列已软删除）
//   R4 行校验失败（INVALID）→ 建议拒绝（含全部 error 级原因）
//   R5 行玩家缺失（PLAYER_MISSING）→ 存疑（需建号后写入，人工确认身份）
//   R6 无异常 READY 行 → 建议通过
// 纯函数、零 IO、零写库。
// ============================================================

import type { TierTicketRow } from './pipeline';
import { TIER_TOKEN_RE } from './column-map';

export type AiVerdict = 'approve' | 'doubt' | 'reject';

export interface AiSuggestion {
  verdict: AiVerdict;
  /** 理由（可读中文，逐条） */
  reasons: string[];
  /** 恒为 true：UI 必须标注「AI 建议，仅供参考」 */
  advisoryOnly: true;
}

/** '无需录屏' 类文案识别（R3） */
const NO_RECORDING_RE = /无需录屏|无录屏|免录屏|不需要录屏|没有录屏|无/;

/** tier 序列跨度表（R2）：词表线性序，跨度以「小级」计 */
const TIER_ORDER: string[] = [
  'LT1', 'LT2', 'LT3', 'LT4', 'LT5',
  'HT1', 'HT2', 'HT3', 'HT4', 'HT5',
  'LZ1', 'LZ2', 'LZ3', 'LZ4', 'LZ5',
  'LL1', 'LL2', 'LL3', 'LL4', 'LL5',
];

function tierSpan(from: string, to: string): number | null {
  const i = TIER_ORDER.indexOf(from.toUpperCase());
  const j = TIER_ORDER.indexOf(to.toUpperCase());
  if (i === -1 || j === -1) return null;
  return Math.abs(j - i);
}

/** LT3 及以上可免录屏（按表头『lt3及以上填无需录屏』语义） */
function recordingExempt(tier: string | null): boolean {
  if (!tier) return false;
  const up = tier.toUpperCase();
  return /^(LT[3-5]|HT[1-5]|LZ[1-5]|LL[1-5])$/.test(up);
}

/** 比分悬殊（R1）：'5:0' 形态已由管线 isScorePattern 校验过；此处做悬殊度判断 */
function isLopsidedScore(scoreRaw: string): boolean {
  const m = /^\s*(\d+)\s*[:：]\s*(\d+)\s*$/.exec(scoreRaw);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Math.abs(a - b) >= 5;
}

/**
 * 单行建议（纯函数）。
 * 输入直接复用 P1-B 管线输出行；不做任何状态修改。
 */
export function suggestForTicketRow(t: TierTicketRow): AiSuggestion {
  const reasons: string[] = [];

  // R4 行校验失败 → 建议拒绝
  if (t.status === 'INVALID') {
    const errs = t.issues.filter(i => i.level === 'error').map(i => i.message);
    return {
      verdict: 'reject',
      reasons: errs.length > 0 ? errs : ['行校验未通过（存在 error 级问题）'],
      advisoryOnly: true,
    };
  }

  // R1 比分悬殊（v2 软删除 legacy 信源：仅历史行有数据时触发）
  if (t.score.raw && isLopsidedScore(t.score.raw)) {
    reasons.push(`比分 ${t.score.raw} 悬殊（净胜≥5），存在对手弃赛/刷分嫌疑`);
  }

  // R1b 胜场悬殊（v2 新比分信源：测试者/考核员胜场）
  if (t.testeeWins.value !== null && t.testerWins.value !== null) {
    const diff = Math.abs(t.testeeWins.value - t.testerWins.value);
    if (diff >= 5) {
      reasons.push(`胜场悬殊：测试者 ${t.testeeWins.value} / 考核员 ${t.testerWins.value}（净胜 ${diff}），存在对手弃赛/刷分嫌疑`);
    }
  }

  // R2 tier 跨度（⑥列拆出的原 tier 候选 vs ⑦列测试tier）
  const fromTier = t.testee.tierCandidateNormalized;
  const toTier = t.testTier.normalized;
  if (fromTier && toTier) {
    const span = tierSpan(fromTier, toTier);
    if (span !== null && span >= 3) {
      reasons.push(`tier 跨度大：原 ${fromTier} → 测试 ${toTier}（跨 ${span} 小级），存在跳档嫌疑`);
    }
  }

  // R3 录屏规则矛盾
  if (t.recording && NO_RECORDING_RE.test(t.recording) && !recordingExempt(toTier)) {
    reasons.push(`tier ${toTier ?? '未知'} 按规则应附录屏，但录屏栏填「${t.recording}」`);
  }

  // R5 玩家缺失
  if (t.status === 'PLAYER_MISSING') {
    const missing = [t.tester, t.testee]
      .filter(p => p.matched.status === 'MISSING')
      .map(p => p.matched.playerName);
    reasons.push(`玩家不存在（${missing.join('、')}）：需建号后写入，请人工确认身份`);
  }

  // R6 汇总
  if (reasons.length === 0) {
    return { verdict: 'approve', reasons: ['行校验通过，比分/tier 跨度/录屏规则均无异常'], advisoryOnly: true };
  }
  return { verdict: 'doubt', reasons, advisoryOnly: true };
}

/**
 * 从原始单元格文本里提取⑥列被测玩家原 tier 候选（R2 用，
 * 管线内 parseIdPlusTierCell 已做防御拆分；这里仅在纯文本场景使用）。
 * 导出仅供测试对照，主流程走 pipeline 的 tierCandidateNormalized。
 */
export function extractTierToken(raw: string): string | null {
  const m = TIER_TOKEN_RE.exec(String(raw ?? ''));
  return m ? m[0].replace(/\s+/g, '').toUpperCase() : null;
}
