// ============================================================
// Tier Command · T8 生产水位迁移（一次性，方案 A 第二版 §八）
// ------------------------------------------------------------
// 用法：bun run scripts/tier-command-t8-migrate.ts
// 依赖：T3（contentSnapshot 存储）+ T4（inheritanceState 状态机 +
//       supersededBy 取代机制）+ T5（审批门禁）均已上线。
//
// 目标：将水位中 v1 世代旧键（无内容快照，内容不可核实）安全移交到
//       cfp1 快照体系，使审批继承判定与门禁（approve-gate ②）全量接管：
//   - 对每条无 contentSnapshot 且未被取代的旧键：查找「同槽位」（rowIndex
//     相同 + trim(targetName) 相同）且恰有一条带 cfp1 快照、未被取代的
//     v2 键 → 旧键标记 supersededBy = v2 键（T4 既有取代语义：
//     条目与其 approved 原样保留，只加标记不删除，审计可追）；
//   - 槽位无对应键或对应键多于一条 → 不动（保守；由管理员经 UI
//     「已人工核验」通道处理）；
//   - 迁移后触发一次真实同步（dryRun=false），让状态机以纯净索引重判
//     （旧键退出内容匹配索引 → 现存工单行自匹配 A_INHERITED，
//     历史审批自动延续、无快照歧义态清零）。
//
// 安全纪律：
//   - 迁移前把水位原值完整备份到 Config key
//     tier_command_sync_state.backup.t8_<时间戳>（回滚 = 将备份值写回主键）；
//   - 只增字段（supersededBy），不删除、不改写任何既有字段；
//   - 全程打印前后对照报告；零删除操作。
// ============================================================

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const KEY = 'tier_command_sync_state';
const CFP1 = 'cfp1';

interface FpEntry {
  firstSeenAt?: string; lastSeenAt?: string; rowIndex?: number;
  tier?: string | null; status?: string; targetName?: string | null;
  approved?: unknown; contentSnapshot?: { cfpVersion?: string; contentFp?: string } | null;
  inheritanceState?: string | null; legacyApprovedUnverified?: unknown; supersededBy?: string | null;
}

async function main() {
  const row = await db.config.findUnique({ where: { key: KEY } });
  if (!row?.value) { console.log('水位不存在：无可迁移对象'); return; }

  // 1. 备份（回滚 = 将备份值写回主键）
  const backupKey = `${KEY}.backup.t8_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  await db.config.create({ data: { key: backupKey, value: row.value } });
  console.log(`① 已备份原值 → Config[${backupKey}]（${row.value.length} bytes）`);

  // 2. 迁移：无快照旧键 → 恰一同槽位快照键则标记被取代
  const state = JSON.parse(row.value) as { version: number; updatedAt: string; fingerprints: Record<string, FpEntry> };
  const fps = state.fingerprints;
  const keys = Object.keys(fps);
  const migrated: Array<{ from: string; to: string }> = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const k of keys) {
    const e = fps[k]!;
    if (e.contentSnapshot && e.contentSnapshot.cfpVersion === CFP1) continue; // 快照键非迁移对象
    if (e.supersededBy) continue; // 已被取代
    const target = String(e.targetName ?? '').trim();
    const mates = keys.filter(m => {
      if (m === k) return false;
      const me = fps[m]!;
      if (me.supersededBy) return false;
      const s = me.contentSnapshot;
      if (!s || s.cfpVersion !== CFP1 || typeof s.contentFp !== 'string') return false;
      return me.rowIndex === e.rowIndex && String(me.targetName ?? '').trim() === target && target !== '';
    });
    if (mates.length === 1) {
      e.supersededBy = mates[0]!;
      migrated.push({ from: k, to: mates[0]! });
    } else {
      skipped.push({ key: k, reason: mates.length === 0 ? '同槽位无快照键' : `同槽位 ${mates.length} 条快照键（歧义，保守跳过）` });
    }
  }

  if (migrated.length > 0) {
    state.updatedAt = new Date().toISOString();
    await db.config.update({ where: { key: KEY }, data: { value: JSON.stringify(state) } });
  }
  console.log(`② 迁移完成：${migrated.length} 条旧键标记被取代，${skipped.length} 条保守跳过`);
  for (const m of migrated) {
    const e = fps[m.from]!;
    console.log(`   · ${m.from.slice(0, 12)}…（行${e.rowIndex} ${e.targetName}${e.approved ? ' · 含历史审批（原样保留）' : ''}）→ supersededBy ${m.to.slice(0, 12)}…`);
  }
  for (const s of skipped) console.log(`   · 跳过 ${s.key.slice(0, 12)}…（${s.reason}）`);

  // 3. 触发真实同步（dryRun=false），状态机以纯净索引重判
  const secretRow = await db.config.findUnique({ where: { key: 'session_secret' } });
  const owner = await db.adminUser.findFirst({ where: { role: 'OWNER' } });
  if (!secretRow?.value || !owner) { console.log('③ 跳过同步（无法铸造 token）：请手动在管理面板执行一次同步'); return; }
  const mac = crypto.createHmac('sha256', secretRow.value).update(owner.id).digest('hex').slice(0, 32);
  const res = await fetch('http://127.0.0.1:3000/api/v1/tier-command/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': `${owner.id}.${mac}` },
    body: JSON.stringify({ dryRun: false }),
  });
  const data = (await res.json()) as { ok: boolean; warnings?: string[]; rows?: Array<{ rowIndex: number; inheritance: { state: string }; approved: unknown }> };
  console.log(`③ 真实同步：HTTP ${res.status} ok=${data.ok}`);
  for (const w of data.warnings ?? []) console.log(`   ⚠ ${w}`);
  for (const r of data.rows ?? []) {
    console.log(`   行${r.rowIndex}: ${r.inheritance.state}${r.approved ? ' · 已审批延续' : ''}`);
  }

  // 4. 终态核验
  const after = await db.config.findUnique({ where: { key: KEY } });
  const af = after ? JSON.parse(after.value).fingerprints as Record<string, FpEntry> : {};
  const legacyLeft = Object.entries(af).filter(([, e]) => !(e.contentSnapshot?.cfpVersion === CFP1) && !e.supersededBy).length;
  const approvedCount = Object.values(af).filter(e => e.approved).length;
  console.log(`④ 终态：条目 ${Object.keys(af).length} · 未判定且未被取代的旧键 ${legacyLeft} · 含 approved 条目 ${approvedCount}`);
  console.log(`   回滚方式：将 Config[${backupKey}] 的 value 写回 Config[${KEY}]`);
}

main()
  .catch(err => { console.error('迁移失败（原值未受影响，可查备份键）：', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
