import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, requireRole } from '@/lib/auth';
import { generateApiKey, hashKey, logApiEvent } from '@/lib/api-gate';

// ============================================================
// W4-T4 · API Key 签发/吊销管理
// POST   /api/v1/admin/api-keys — 签发新 Key（明文仅返回一次）
// GET    /api/v1/admin/api-keys — 列出所有 Key（只返回 prefix，不含明文）
// DELETE /api/v1/admin/api-keys?id=xxx — 吊销 Key
// ============================================================

// GET — 列出所有 Key（脱敏，无明文）
export async function GET() {
  const guard = await requireAdmin();
  if (guard) return guard;
  const keys = await db.apiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, keyPrefix: true, scopes: true, status: true,
      quota: true, originAllow: true, expiresAt: true,
      createdAt: true, revokedAt: true, lastUsedAt: true,
    },
  });
  return NextResponse.json({ keys });
}

// AUTH V2.0 安全修复专项（2026-11-11）：签发 Key=凭证面操作，限 OWNER/ADMIN
export async function POST(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  try {
    const body = await req.json();
    const { name, quota, scopes, originAllow, expiresAt } = body;
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const { plaintext, hash, prefix } = generateApiKey();
    const key = await db.apiKey.create({
      data: {
        name: name.trim(),
        keyHash: hash,
        keyPrefix: prefix,
        scopes: scopes || 'leaderboard.read',
        quota: typeof quota === 'number' ? quota : 1000,
        originAllow: originAllow ? JSON.stringify(originAllow) : '[]',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    await logApiEvent('api_key_issue', `admin → ApiKey · ${key.name} (${prefix})`, ip, null, JSON.stringify({ id: key.id, name: key.name, scopes: key.scopes }));
    // 明文仅此一次返回
    return NextResponse.json({ key: { ...key, plaintext }, message: '明文 key 仅此一次返回，请妥善保存' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
  }
}

// AUTH V2.0 安全修复专项（2026-11-11）：吊销 Key=修改操作，限 OWNER/ADMIN
export async function DELETE(req: NextRequest) {
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const existing = await db.apiKey.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    const before = JSON.stringify({ id, name: existing.name, status: existing.status });
    const updated = await db.apiKey.update({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    await logApiEvent('api_key_revoke', `admin → ApiKey · ${existing.name} REVOkED`, ip, before, JSON.stringify({ id, status: 'REVOKED' }));
    return NextResponse.json({ key: { id: updated.id, status: updated.status } });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  }
}
