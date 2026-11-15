// ============================================================
// Seed the first OWNER admin account.
// Run: bun run scripts/seed-admin.ts
//
// If AdminUser table already has rows, this script does nothing
// (idempotent). Otherwise it creates one OWNER from env vars or
// interactive prompts:
//   ADMIN_SEED_USERNAME (default: owner)
//   ADMIN_SEED_PASSWORD (required — no default for security)
// ============================================================

import { db } from '../src/lib/db';
import { hashPassword } from '../src/lib/password';

async function main() {
  const existing = await db.adminUser.count();
  if (existing > 0) {
    console.log(`✓ AdminUser table already has ${existing} record(s). Skipping seed.`);
    return;
  }

  const username = process.env.ADMIN_SEED_USERNAME || 'owner';
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) {
    console.error('✗ Set ADMIN_SEED_PASSWORD env var before running this script.');
    console.error('  Example: ADMIN_SEED_PASSWORD=your-secret bun run scripts/seed-admin.ts');
    process.exit(1);
  }

  const passwordHash = hashPassword(password);
  const user = await db.adminUser.create({
    data: {
      username,
      passwordHash,
      role: 'OWNER',
    },
  });

  console.log(`✓ Created OWNER account:`);
  console.log(`    id:       ${user.id}`);
  console.log(`    username: ${user.username}`);
  console.log(`    role:     ${user.role}`);
  console.log(`    lastLoginAt: (never)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
