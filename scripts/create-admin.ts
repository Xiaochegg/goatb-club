// ============================================================
// Create an additional admin account (multi-admin support).
//
// 与 seed-admin.ts 的区别：seed-admin 只在 AdminUser 表为空时创建
// 首个 OWNER；本脚本用于追加独立管理员，按 username 幂等：
//   - 用户名已存在 → 报错退出（不覆盖、不改密码、不动 role）
//   - 不存在 → 以指定 role 创建
//
// Run:
//   ADMIN_NEW_USERNAME=nuankon ADMIN_NEW_PASSWORD='...' ADMIN_NEW_ROLE=ADMIN \
//     bun run scripts/create-admin.ts
//
// Security rules（与 reset-admin-password.ts 同一纪律）:
//   - 密码只经环境变量传入：不写入任何项目文件、不打印、不进日志
//   - 强度校验：≥12 位且含大小写/数字/符号四类
//   - DB 仅存 scrypt 哈希（"salt:hash"，512-bit key，src/lib/password.ts）
//   - 已有账号（如 owner）永不被本脚本触碰
// ============================================================

import { db } from '../src/lib/db';
import { hashPassword } from '../src/lib/password';

const VALID_ROLES = ['OWNER', 'ADMIN', 'MODERATOR', 'VIEWER'] as const;
const PW_MIN_LEN = 12;

function passwordStrength(pw: string): string[] {
  const issues: string[] = [];
  if (pw.length < PW_MIN_LEN) issues.push(`长度 < ${PW_MIN_LEN}`);
  if (!/[a-z]/.test(pw)) issues.push('缺小写字母');
  if (!/[A-Z]/.test(pw)) issues.push('缺大写字母');
  if (!/[0-9]/.test(pw)) issues.push('缺数字');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('缺符号');
  return issues;
}

async function main() {
  const username = process.env.ADMIN_NEW_USERNAME;
  const password = process.env.ADMIN_NEW_PASSWORD;
  const role = process.env.ADMIN_NEW_ROLE || 'ADMIN';

  if (!username || !password) {
    console.error('✗ 用法: ADMIN_NEW_USERNAME=... ADMIN_NEW_PASSWORD=... [ADMIN_NEW_ROLE=ADMIN] bun run scripts/create-admin.ts');
    process.exit(1);
  }
  if (!(VALID_ROLES as readonly string[]).includes(role)) {
    console.error(`✗ 非法 role: ${role}（可选 ${VALID_ROLES.join('|')}）`);
    process.exit(1);
  }

  const issues = passwordStrength(password);
  if (issues.length > 0) {
    console.error(`✗ 密码强度不足: ${issues.join(' / ')}`);
    process.exit(1);
  }

  // 幂等护栏：同名账号存在即拒绝 —— 不覆盖既有凭证/权限
  const existing = await db.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.error(`✗ 用户名已存在: ${username}（创建于 ${existing.createdAt.toISOString()}，role=${existing.role}）。如需改密请用 reset-admin-password.ts`);
    process.exit(1);
  }

  const user = await db.adminUser.create({
    data: { username, passwordHash: hashPassword(password), role },
  });

  const total = await db.adminUser.count();
  console.log(`✓ 管理员创建成功:`);
  console.log(`    id:       ${user.id}`);
  console.log(`    username: ${user.username}`);
  console.log(`    role:     ${user.role}`);
  console.log(`  当前管理员总数: ${total}（既有账号未受影响）`);
  console.log(`  · 明文仅存在于本次环境变量中，未写入任何项目文件`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
