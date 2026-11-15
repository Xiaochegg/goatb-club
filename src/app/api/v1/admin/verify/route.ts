import { NextResponse } from 'next/server';
import { getCurrentAdmin } from '@/lib/auth';

// GET /api/v1/admin/verify - Check admin session and return identity
export async function GET() {
  try {
    const admin = await getCurrentAdmin();
    if (!admin) {
      return NextResponse.json({ isAdmin: false });
    }
    return NextResponse.json({
      isAdmin: true,
      username: admin.username,
      role: admin.role,
      source: admin.source,
    });
  } catch {
    return NextResponse.json({ isAdmin: false });
  }
}
