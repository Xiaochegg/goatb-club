import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const admins = await db.adminUser.findMany({ select: { id: true, username: true, role: true, createdAt: true, lastLoginAt: true } });
console.log('AdminUser rows:', JSON.stringify(admins, null, 1));
const cfg = await db.config.findMany({ select: { key: true } });
console.log('Config keys:', cfg.map(c => c.key).join(', '));
await db.$disconnect();
