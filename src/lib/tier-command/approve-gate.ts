// ============================================================
// Tier Command · 审批门禁（T5 · approve 链分级拦截，方案 A 第二版 §五）
// ------------------------------------------------------------
// 职责：approve API 每行写入前的行级前置门禁（纯函数、零 IO），
//       消费 T4 审批继承状态机随水位落盘的判定（inheritanceState）与
//       T3 内容快照（contentSnapshot），实施分级拦截：
//
//   ① entry.approved（自身已审批）
//      → ALREADY_APPROVED（既有硬拦截，语义不变：严禁二次写榜）；
//      例外：entry.rollback（写入已被管理员回档恢复）→ 不触发硬拦截，
//      改为要求显式确认（未带 confirmAfterRollback=true
//      → ROLLBACK_REWRITE_CONFIRM_REQUIRED：回档后重新写入必须是有意行为）
//   ①′ entry.reviewRejected（管理员已拒绝，R2 新增）
//      → REVIEW_REJECTED：拒绝记录不是写入候选，仅管理员撤销拒绝后可恢复
//   ② 同内容冲突（T5 新增硬拦截）
//      水位中另一条「非 superseded、非已回档、cfp 版本一致、contentFp 相同」
//      的条目已审批，或本请求中已有同 contentFp 行成功写入
//      → CONTENT_ALREADY_APPROVED：同一份内容只允许落榜一次，
//        封堵「同内容多键 / A 态条目在其兄弟键先行写入后仍未携带 approved /
//        同请求批内重复」绕行道
//   ③ inheritanceState === 'C_AMBIGUOUS'（T4：多历史匹配/批内重复，审批归属不明）
//      → 未带 confirmAmbiguous=true → AMBIGUOUS_CONFIRMATION_REQUIRED
//        （「人工核对」在审批 API 层的强制落点，管理员显式确认后方放行）
//   ④ inheritanceState === 'LEGACY_UNVERIFIED'（T4：命中无快照历史条目，
//     内容一致性不可核实；legacyApprovedUnverified 仅存证展示，绝不触发
//     ALREADY_APPROVED —— T4 注释明示：由审批接口强制显式确认后放行）
//      → 未带 confirmLegacyUnverified=true → LEGACY_CONFIRMATION_REQUIRED；
//     inheritanceState 缺省（旧版水位条目，未经状态机判定）与 ④ 同为
//     「内容不可核实」认知态 → 同纪律要求显式核验（封堵经旧键绕过 ③ 的道）；
//     有存证时消息附原审批详情供人工核对
//   ⑤ A_INHERITED（历史未审批）/ B_CONTENT_CHANGED / D_NO_MATCH → 放行
//      （B 态「需重新审核」的落点即本次人工审批本身；diff 展示由 T6 UI 负责）
//
//   未知 inheritanceState 字符串（未来扩展态）→ 按 ⑤ 放行（向前兼容：
//   新态接入拦截须显式扩展本门禁，不允许静默收紧）。
//
// 纪律：
//   - 纯函数零 IO：水位与「本请求内已写入 contentFp 集合」由调用方
//     （approve route）读定后传入；本模块只判定、不落库；
//   - 拒绝路径零写入（Player/OperationLog/Config 均不动）；
//   - 纵深防御：own-approved 并发复查保留在 approve route 事务内
//     （防门禁读取与事务提交窗口内的并发双击），与本门禁互不替代；
//   - 残余风险（T8 数据迁移收口）：legacy 条目（无快照）之间 / legacy 条目
//     与快照条目之间无法做内容比对，同槽位多键需两次显式人工确认才可能
//     双写（每次均留 OperationLog 审计）；T8 回填快照后由 ② 全量接管。
// ============================================================

import { CFP_VERSION } from './content-fingerprint';
import type { SyncStateFingerprintEntry, TierApprovedRef } from './sync-state';

// ---------- 类型 ----------

export type ApproveGateRejectCode =
  | 'ALREADY_APPROVED'
  | 'CONTENT_ALREADY_APPROVED'
  | 'LEGACY_CONFIRMATION_REQUIRED'
  | 'AMBIGUOUS_CONFIRMATION_REQUIRED'
  | 'REVIEW_REJECTED'
  | 'ROLLBACK_REWRITE_CONFIRM_REQUIRED';

export interface ApproveGateInput {
  fingerprint: string;
  /** 水位条目（服务端真值，调用方自 readSyncState 取得） */
  entry: SyncStateFingerprintEntry;
  /** T5：存量/历史条目人工核验确认（LEGACY_UNVERIFIED 或未判定条目须 true 才放行） */
  confirmLegacyUnverified: boolean;
  /** T5：歧义工单人工核对确认（C_AMBIGUOUS 须 true 才放行） */
  confirmAmbiguous: boolean;
  /** R2：回档后重新写入确认（entry.approved 且 entry.rollback 时须 true 才放行） */
  confirmAfterRollback: boolean;
}

export interface ApproveGateContext {
  /** 完整水位（同内容冲突扫描用） */
  stateFingerprints: Record<string, SyncStateFingerprintEntry>;
  /** 本请求内已成功写入行的 contentFp（同批防双写；无快照行不登记） */
  inRequestApprovedContentFps: ReadonlySet<string>;
}

export type ApproveGateResult =
  | { action: 'ALLOW' }
  | { action: 'REJECT'; code: ApproveGateRejectCode; message: string };

// ---------- 消息 ----------

const MSG = {
  ALREADY_APPROVED: '幂等拦截：该工单已审批写入过，拒绝二次写榜',
  CONTENT_ALREADY_APPROVED: '同内容工单已审批写入过，拒绝二次写榜（同一份内容仅允许写入一次）',
  AMBIGUOUS_CONFIRMATION_REQUIRED:
    '该工单历史审批归属存在歧义（多条同内容/同对象历史条目或批内内容重复）：' +
    '需人工核对后勾选「已核对歧义」确认，才能写入',
} as const;

/** 审批标记人类可读（存证/冲突详情展示用） */
function fmtApproved(r: TierApprovedRef): string {
  const at = String(r.at ?? '').slice(0, 19).replace('T', ' ');
  return `${r.by} @ ${at} 写入 ${r.tier}/${r.mode}`;
}

// ---------- 门禁 ----------

/**
 * 行级审批门禁（判定顺序即优先级：硬拦截 → 同内容冲突 → 分级确认）。
 * 返回 ALLOW 才允许进入后续（快照完整性/状态门禁/事务写榜）流程。
 */
export function evaluateApproveGate(
  input: ApproveGateInput,
  ctx: ApproveGateContext,
): ApproveGateResult {
  const { fingerprint, entry, confirmLegacyUnverified, confirmAmbiguous, confirmAfterRollback } = input;

  // ① 自身已审批（既有硬拦截，语义与 P2 完全一致）；
  //    R2 例外：写入已被回档恢复 → 不硬拦截，改为显式确认通道
  if (entry.approved) {
    if (!entry.rollback) {
      return { action: 'REJECT', code: 'ALREADY_APPROVED', message: MSG.ALREADY_APPROVED };
    }
    if (!confirmAfterRollback) {
      const rbAt = String(entry.rollback.at ?? '').slice(0, 19).replace('T', ' ');
      return {
        action: 'REJECT',
        code: 'ROLLBACK_REWRITE_CONFIRM_REQUIRED',
        message:
          `该工单写入已被回档（${entry.rollback.by} @ ${rbAt} 恢复）：重新写入须勾选「回档后重写确认」，` +
          '确保是有意行为而非误操作',
      };
    }
  }

  // ①′ 管理员已拒绝（R2）：拒绝记录不是写入候选，仅撤销拒绝后恢复
  if (entry.reviewRejected) {
    const rjAt = String(entry.reviewRejected.at ?? '').slice(0, 19).replace('T', ' ');
    return {
      action: 'REJECT',
      code: 'REVIEW_REJECTED',
      message:
        `该记录已被拒绝（${entry.reviewRejected.by} @ ${rjAt}${entry.reviewRejected.reason ? ` · 原因：${entry.reviewRejected.reason}` : ''}）：` +
        '不作为写入候选，须先撤销拒绝',
    };
  }

  // ② 同内容冲突扫描（仅 cfp 版本可识别的快照条目参与；legacy 条目无快照不可比对）
  const snap = entry.contentSnapshot;
  if (snap && snap.cfpVersion === CFP_VERSION && typeof snap.contentFp === 'string') {
    if (ctx.inRequestApprovedContentFps.has(snap.contentFp)) {
      return {
        action: 'REJECT',
        code: 'CONTENT_ALREADY_APPROVED',
        message: '同内容工单已在本请求中审批写入，拒绝二次写榜（同一份内容仅允许写入一次）',
      };
    }
    for (const [key, sib] of Object.entries(ctx.stateFingerprints)) {
      // R2：已回档兄弟条目不参与同内容冲突扫描（其写入已被恢复，历史不拦未来）
      if (!sib || key === fingerprint || sib.supersededBy || sib.rollback) continue;
      const s = sib.contentSnapshot;
      if (s && s.cfpVersion === snap.cfpVersion && s.contentFp === snap.contentFp && sib.approved) {
        return {
          action: 'REJECT',
          code: 'CONTENT_ALREADY_APPROVED',
          message:
            `同内容工单已审批写入过（历史条目 行${sib.rowIndex} · ${fmtApproved(sib.approved)}），` +
            '拒绝二次写榜（同一份内容仅允许写入一次）',
        };
      }
    }
  }

  // ③④ 分级确认（T4 状态机判定消费；state === null = 旧版未判定条目，与 legacy 同纪律）
  const state = entry.inheritanceState ?? null;
  if (state === 'C_AMBIGUOUS' && !confirmAmbiguous) {
    return { action: 'REJECT', code: 'AMBIGUOUS_CONFIRMATION_REQUIRED', message: MSG.AMBIGUOUS_CONFIRMATION_REQUIRED };
  }
  if ((state === 'LEGACY_UNVERIFIED' || state === null) && !confirmLegacyUnverified) {
    let message: string;
    if (state === 'LEGACY_UNVERIFIED' && entry.legacyApprovedUnverified) {
      message =
        `存量工单内容一致性不可核实（历史无内容快照）：原审批存证 ${fmtApproved(entry.legacyApprovedUnverified)}。` +
        '请人工核验内容一致后勾选「已人工核验」确认，才能写入';
    } else if (state === 'LEGACY_UNVERIFIED') {
      message =
        '存量工单内容一致性不可核实（命中历史条目但无内容快照）：' +
        '请人工核验后勾选「已人工核验」确认，才能写入';
    } else {
      message =
        '存量工单未经审批继承状态机判定（旧版水位条目，无内容快照，内容一致性不可核实）：' +
        '请人工核验后勾选「已人工核验」确认，才能写入';
    }
    return { action: 'REJECT', code: 'LEGACY_CONFIRMATION_REQUIRED', message };
  }

  // ⑤ 放行：A_INHERITED（历史未审批）/ B_CONTENT_CHANGED / D_NO_MATCH / 未知扩展态
  return { action: 'ALLOW' };
}
