// ============================================================
// Reset an AdminUser password (owner self-service, no API needed).
//
// Run:
//   ADMIN_USERNAME=owner ADMIN_NEW_PASSWORD='...' bun run scripts/reset-admin-password.ts
//
// Security rules:
//   - Password is passed ONLY via env var, never written to any
//     project file, never logged, never embedded in this script.
//   - DB stores a scrypt hash ("salt:hash", 512-bit key), same
//     scheme as src/lib/password.ts.
// ============================================================

import { db } from '../src/lib/db';
import { hashPassword, verifyPassword } from '../src/lib/password';

const USERNAME_MIN = 3;
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
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_NEW_PASSWORD;

  if (!username || !password) {
    console.error('✗ 用法: ADMIN_USERNAME=... ADMIN_NEW_PASSWORD=... bun run scripts/reset-admin-password.ts');
    process.exit(1);
  }

  const issues = passwordStrength(password);
  if (issues.length > 0) {
    console.error(`✗ 密码强度不足: ${issues.join(' / ')}`);
    process.exit(1);
  }

  const user = await db.adminUser.findUnique({ where: { username } });
  if (!user) {
    console.error(`✗ 管理员不存在: ${username}`);
    process.exit(1);
  }

  if (verifyPassword(password, user.passwordHash)) {
    console.error('✗ 新密码与当前密码相同，请换一个');
    process.exit(1);
  }

  await db.adminUser.update({
    where: { username },
    data: { passwordHash: hashPassword(password) },
  });

  // 复核：确认新哈希能验证通过（只校验布尔结果，不输出任何密码内容）
  const after = await db.adminUser.findUniqueOrThrow({ where: { username } });
  const ok = verifyPassword(password, after.passwordHash);
  if (!ok) {
    console.error('✗ 更新后校验失败，请重试');
    process.exit(1);
  }

  console.log(`✓ ${username} 的密码已更新（scrypt 哈希已重写，强度校验通过）`);
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
