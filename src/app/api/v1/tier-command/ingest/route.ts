// ============================================================
// Tier Command · 收集表 ingest 归档 API（TIER_RECORD_RECOGNITION_REBUILD_V1）
// ------------------------------------------------------------
// POST /api/v1/tier-command/ingest
//   鉴权：requireRole('OWNER','ADMIN')
//   入参：{ dryRun?: boolean }
//   行为：真实拉取收集表 d5roro（endrow=1000）→ 墓碑过滤 → 现行管线解析
//         （v3.1 视图适配）→ 标准化 → 玩家识别 → 幂等落库（rowFingerprint
//         唯一约束 + bizKey 完全相同合并）→ TierSyncBatch 批次日志
//   纪律：
//     - 整理表 y344e4 现行 sync 通道零改动（水位互不污染）；
//     - 本端点不写 Player.tiers（归档写入走 ledger-approve 人工审批）；
//     - 不删任何原始数据；墓碑/空行跳过留数；垃圾行进待核对；
//     - 幂等：同来源行重复 ingest 仅计数（idempotentHits），绝不重复累计；
//     - 失败显式报错（绝不返回空结果冒充成功）。
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { TencentDocError } from '@/lib/tier-command/tencent-doc-client';
import { ingestCollectSheet } from '@/lib/tier-command/ingest';

export const dynamic = 'force-dynamic';

type ErrorCode = 'DOC_FETCH_FAILED' | 'DOC_PERMISSION_DENIED' | 'HEADER_DRIFT' | 'PARSE_FAILED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL';

const HTTP: Record<ErrorCode, number> = {
  DOC_FETCH_FAILED: 502,
  DOC_PERMISSION_DENIED: 502,
  HEADER_DRIFT: 422,
  PARSE_FAILED: 500,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

const MSG: Record<ErrorCode, string> = {
  DOC_FETCH_FAILED: '拉取腾讯文档失败（网络/超时/限频/响应结构异常），请稍后重试',
  DOC_PERMISSION_DENIED: '文档不可读：权限可能已收紧或参数组失效（非「所有人可查看」状态）',
  HEADER_DRIFT: '表头结构漂移：文档列结构发生变更，已整批拒绝解析（静默解析已阻止）',
  PARSE_FAILED: '文档数据块解码失败（zlib/protobuf 层异常）',
  UNAUTHORIZED: '未授权 — 请先登录管理员账号',
  FORBIDDEN: '权限不足 — 需要 OWNER 或 ADMIN 角色',
  INTERNAL: '归档管线内部错误（批次已留痕，重试安全）',
};

export async function POST(request: Request) {
  const gate = await requireRole('OWNER', 'ADMIN');
  if (gate.response) return gate.response;

  let dryRun = false;
  try {
    const body = (await request.json()) as { dryRun?: boolean } | null;
    dryRun = body?.dryRun === true;
  } catch {
    dryRun = false;
  }

  try {
    const result = await ingestCollectSheet({ dryRun });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TencentDocError) {
      const code: ErrorCode = err.code === 'HTTP_401' || err.code === 'BLANKPAGE'
        ? 'DOC_PERMISSION_DENIED'
        : err.code === 'BAD_JSONP' || err.code === 'NO_TEXT_BLOCK' || err.code === 'NO_RELATED_SHEET'
          ? 'HEADER_DRIFT'
          : 'DOC_FETCH_FAILED';
      return NextResponse.json(
        { ok: false, code, message: MSG[code], detail: { docErrorCode: err.code, raw: err.message } },
        { status: HTTP[code] },
      );
    }
    // 非文档类异常（如 DB）：如实上报，不假报成功
    return NextResponse.json(
      { ok: false, code: 'INTERNAL' as ErrorCode, message: MSG.INTERNAL, detail: { reason: err instanceof Error ? err.message : String(err) } },
      { status: HTTP.INTERNAL },
    );
  }
}
