// ============================================================
// Tier Command · 名称与 Tier 分离识别视图层（TIER_WORKSPACE_V2）
// ------------------------------------------------------------
// 工单最高优先级规则（管理员 2026-11-09，优先级高于任何 UI/交互）：
//   1. Tier 标识不得自动并入玩家名称 —— 名称与 Tier 是两个独立字段；
//   2. 不能简单删除玩家名称末尾的字母和数字；
//   3. 如果玩家真实名称本身包含 MT4、LT5 等字符，必须保留原名并人工核对；
//   4. 不能仅凭 HT5、LT4 等字符串就认定它们一定是等级后缀；
//   5. 同名但不同 ID 不得合并；同 ID 不同名称进入改名核对；
//   6. 原始文本必须保留，保证可以追溯；
//   7. 无法确定的记录不得自动归档。
// 实施纪律：
//   - 本层为【读取端识别视图】：纯函数、零 IO、零写库、零数据修改；
//   - 已落库 testeeId（原始全文）永不被改写 —— 拆分结果仅用于展示/聚合；
//   - 有效等级词表 = constants.ts 现行 Tier 体系（HT/LT ×1-5 + 嘉豪 LZ/LL ×1-5），
//     不凭格式自行创建不存在的等级（MT 已于 2026-10 从体系裁剪）；
//   - 词表外形态（如 MT4）只能标「疑似标注 · 词表外」进人工核对，
//     绝不当作 Tier、绝不自动拆走；
//   - 身份判定顺序：① 原始全名精确匹配（真名含 token → 保留原名）→
//     ② 词表内候选的余串匹配（唯一命中才采信，多命中 = 歧义人工核对）；
//   - 本层结论永不直接驱动归档/写库 —— 归档仍走既有 ledger-approve 后端门禁。
// ============================================================

import { NORMAL_TIERS, JIAHAO_TIERS } from '../constants';

// ---------- 词表 ----------

/** 有效 Tier 词表（现行体系：HT/LT ×1-5 + LZ/LL ×1-5，大小写不敏感比较用） */
const TIER_VOCAB: ReadonlySet<string> = new Set([...NORMAL_TIERS, ...JIAHAO_TIERS]);

/**
 * 工单点名的候选格式：HT1–HT5 / MT1–MT5 / LT1–LT5。
 * 词表内（HT/LT/LZ/LL）→ 可作为「Tier 候选」展示；
 * 词表外（MT）→ 只能标「疑似标注 · 词表外」提示人工核对，绝不当作 Tier。
 * 纪律：除 MT 外不猜测其它两字母组合（避免把真实名称误拆）。
 */
const VOCAB_SUFFIX_RE = /(?:HT|LT|LZ|LL)\s*[1-5]/i;
const SUSPECT_SUFFIX_RE = /MT\s*[1-5]/i;

/** 名称标准化键（与 ingest.normalizeText 同口径；此处独立实现保持纯函数零依赖方向） */
export function normIdentityKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ---------- 识别视图 ----------

export interface IdentityView {
  /** 原始名称全文（永不修改、永不丢弃 —— 可追溯保证） */
  rawName: string;
  /**
   * 展示用纯名称：
   *  - 词表内候选且余串身份成立（SUFFIX 匹配）→ 余串；
   *  - 其余一切情况（含词表外 suspect）→ 原始全名（真名含 token 时必须保留原名）。
   */
  displayName: string;
  /** 词表内 Tier 候选（HT/LT/LZ/LL ×1-5）；仅尾缀形态命中且余串身份唯一成立时非空 */
  tierCandidate: string | null;
  /** 词表外疑似标注（如 MT4）：只提示人工核对，绝不当作 Tier，绝不自动拆走 */
  suspectToken: string | null;
  /** 是否发生了尾缀分离展示（displayName ≠ rawName） */
  suffixSplit: boolean;
  /** 原始全名本身命中词表 token（真名可能含 token → 必须保留原名并人工核对提示） */
  nameContainsToken: boolean;
  /** 身份判定依据 */
  matchBasis: 'EXACT' | 'EXACT_AMBIGUOUS' | 'SUFFIX' | 'SUFFIX_AMBIGUOUS' | 'NONE';
  /** 唯一匹配的 Player.id（SUFFIX_AMBIGUOUS/NONE 恒 null —— 绝不自动合并） */
  matchedPlayerId: string | null;
  /** 唯一匹配的 Player.name（展示用） */
  matchedPlayerName: string | null;
  /** 需要人工核对（工单：名称与 Tier 疑似混淆 → 已暂停自动处理，请管理员核对） */
  needsReview: boolean;
  /** 核对原因（普通中文，面向管理员） */
  reviewNote: string | null;
}

export interface IdentityPlayerIndex {
  /** normKey(Player.name) → Player.id（同键多 id = 榜单同名条目） */
  byNormName: Map<string, string[]>;
}

export function buildIdentityIndex(players: Array<{ id: string; name: string }>): IdentityPlayerIndex {
  const byNormName = new Map<string, string[]>();
  for (const p of players) {
    const k = normIdentityKey(p.name);
    if (!k) continue;
    const arr = byNormName.get(k);
    if (arr) arr.push(p.id);
    else byNormName.set(k, [p.id]);
  }
  return { byNormName };
}

/**
 * 名称尾缀候选检测（不猜测、不武断）：
 *  - token 必须位于【字符串末尾】（其后不允许再有任何字符）；
 *  - 词表内 token 前若为分隔符（空格/逗号/加号/顿号/斜杠等）→ ingest 旧管线已拆
 *    （testeeTierCand 已有值），此处仅处理【紧贴形态】作为兜底统一出口；
 *  - 词表外 MT 形态 → 只记 suspectToken，displayName 不变。
 */
function detectTrailingToken(rawName: string): { vocabToken: string | null; suspectToken: string | null } {
  const text = String(rawName ?? '').trim();
  if (!text) return { vocabToken: null, suspectToken: null };

  let vocabToken: string | null = null;
  let suspectToken: string | null = null;

  // 词表内：末尾紧贴/带空白分隔均视为候选（不要求前分隔符 —— 拆分与否则交给身份匹配裁决）
  const vm = VOCAB_SUFFIX_RE.exec(text);
  if (vm && vm.index + vm[0].length === text.length) {
    vocabToken = vm[0].replace(/\s+/g, '').toUpperCase();
  } else {
    const sm = SUSPECT_SUFFIX_RE.exec(text);
    if (sm && sm.index + sm[0].length === text.length) {
      suspectToken = sm[0].replace(/\s+/g, '').toUpperCase();
    }
  }
  return { vocabToken, suspectToken };
}

/**
 * 名称与 Tier 分离识别（工单强制规则的唯一实现入口）：
 * ① 原始全名在榜单唯一/多命中 → EXACT / EXACT_AMBIGUOUS：保留原名（真名含 token 场景）；
 * ② 词表内尾缀候选 + 余串在榜单唯一命中 → SUFFIX：displayName=余串，tierCandidate=token；
 * ③ 余串多命中 → SUFFIX_AMBIGUOUS：绝不自动合并，整组人工核对；
 * ④ 全部未命中 → NONE：显示原名（词表内候选仍展示为「候选」但明确标注待核对）。
 */
export function resolveIdentity(rawName: string, index: IdentityPlayerIndex): IdentityView {
  const text = String(rawName ?? '').trim();
  const { vocabToken, suspectToken } = detectTrailingToken(text);

  const base: IdentityView = {
    rawName: text,
    displayName: text,
    tierCandidate: null,
    suspectToken,
    suffixSplit: false,
    nameContainsToken: false,
    matchBasis: 'NONE',
    matchedPlayerId: null,
    matchedPlayerName: null,
    needsReview: false,
    reviewNote: null,
  };
  if (!text) return base;

  // ① 原始全名精确匹配（优先 —— 真名含 token 必须保留原名）
  const exactHits = index.byNormName.get(normIdentityKey(text));
  if (exactHits && exactHits.length === 1) {
    return {
      ...base,
      nameContainsToken: vocabToken !== null || suspectToken !== null,
      matchBasis: 'EXACT',
      matchedPlayerId: exactHits[0]!,
      matchedPlayerName: text,
      needsReview: vocabToken !== null || suspectToken !== null,
      reviewNote:
        vocabToken !== null
          ? `原始名称以「${vocabToken}」结尾且与榜单条目完全一致 —— 可能是真实名称（保留原名），也可能是名称＋标注（需拆分）。请管理员核对后再处理。`
          : suspectToken !== null
            ? `原始名称以「${suspectToken}」结尾（词表外标注形态）且与榜单条目一致 —— 请管理员核对该字符串是否属于真实名称。`
            : null,
    };
  }
  if (exactHits && exactHits.length > 1) {
    return {
      ...base,
      nameContainsToken: vocabToken !== null || suspectToken !== null,
      matchBasis: 'EXACT_AMBIGUOUS',
      needsReview: true,
      reviewNote: `原始名称与榜单 ${exactHits.length} 个同名条目匹配（同名不同 ID 不得自动合并）—— 请管理员核对。`,
    };
  }

  // ② 词表内尾缀候选 → 余串匹配（唯一命中才采信；绝不“简单删除末尾字母数字”）
  if (vocabToken) {
    const head = text.slice(0, text.length - vocabToken.length).replace(/[\s,，、;；|/／+＋·]+$/u, '').trim();
    if (head) {
      const hits = index.byNormName.get(normIdentityKey(head));
      if (hits && hits.length === 1) {
        return {
          ...base,
          displayName: head,
          tierCandidate: vocabToken,
          suffixSplit: true,
          matchBasis: 'SUFFIX',
          matchedPlayerId: hits[0]!,
          matchedPlayerName: head,
          needsReview: false,
          reviewNote: null,
        };
      }
      if (hits && hits.length > 1) {
        return {
          ...base,
          tierCandidate: vocabToken,
          nameContainsToken: true,
          matchBasis: 'SUFFIX_AMBIGUOUS',
          needsReview: true,
          reviewNote: `去除尾缀「${vocabToken}」后与榜单 ${hits.length} 个同名条目匹配（同名不同 ID 不得自动合并）—— 请管理员核对。`,
        };
      }
      // 余串未命中榜单：保留原名展示 + 词表内候选提示（不得自动归档的边界场景之一）
      return {
        ...base,
        tierCandidate: vocabToken,
        nameContainsToken: true,
        needsReview: true,
        reviewNote: `原始名称以「${vocabToken}」结尾但去除后未命中任何榜单条目 —— 无法确证是标注还是真名，请管理员核对（未建条目不自动创建）。`,
      };
    }
    // 整名即 token（如 "HT5"）：无余串可匹配 → 人工核对
    return {
      ...base,
      tierCandidate: vocabToken,
      nameContainsToken: true,
      needsReview: true,
      reviewNote: `原始名称仅为「${vocabToken}」，无玩家名称部分 —— 请管理员核对。`,
    };
  }

  // ③ 词表外 suspect（MT 等）：只提示，不拆
  if (suspectToken) {
    return {
      ...base,
      nameContainsToken: true,
      needsReview: true,
      reviewNote: `原始名称以「${suspectToken}」结尾（疑似标注 · 词表外，本项目现行等级不含 ${suspectToken.slice(0, 2)}）—— 按纪律不自动拆分、不当作等级，请管理员核对。`,
    };
  }

  // ④ 普通未命中
  return base;
}

// ---------- 聚合键（按玩家聚合；同名不同 ID 不合并） ----------

/**
 * 玩家聚合键（仅用于读取端展示分组，绝不写库）：
 *  - 唯一匹配 → `P:<playerId>`（同玩家跨名称变体/跨 ID 变体聚合到同一主条目）；
 *  - 未匹配/歧义 → `N:<normKey(displayName)>`（未建条目组，明确标注身份待核对）；
 *    同 normKey 的未建条目行仅【展示层】聚在一起，每行原始全文与状态独立保留，
 *    归档/审批仍逐条走既有后端门禁（本层不产生任何授权）。
 */
export function identityAggKey(v: IdentityView): string {
  if (v.matchedPlayerId) return `P:${v.matchedPlayerId}`;
  return `N:${normIdentityKey(v.displayName)}`;
}

/** 工单要求的固定识别候选格式说明（不创建不存在的等级） */
export const IDENTITY_VOCAB_NOTE =
  '有效等级词表：HT1–HT5、LT1–LT5、LZ1–LZ5、LL1–LL5（现行 Tier 体系）；' +
  'MT1–MT5 等词表外形态仅提示人工核对，不创建等级、不自动拆分。';
