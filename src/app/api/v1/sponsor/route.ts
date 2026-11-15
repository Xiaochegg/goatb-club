import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// 赞助位接口（工单 2026-11-09：管理按钮左侧"赞助"入口 + 后台并行接入）
//
// 固定形式（复用 Config 表 key-value，零 schema 变更）：
//   sponsor_image   = 图片 dataURL（data:image/*;base64,...，空串=未设置）
//   sponsor_note    = 赞助说明文字（≤200 字）
//   sponsor_enabled = '1' 开放展示 / '0' 关闭
//
// 为什么独立端点而不走 /api/v1/config：
//   config GET 会全量 dump 所有键——base64 图片混入会拖慢全站首屏；
//   本端点只在赞助弹窗打开时按需请求，图片不污染 config 响应。
// ============================================================

const KEY_IMAGE = 'sponsor_image';
const KEY_NOTE = 'sponsor_note';
const KEY_ENABLED = 'sponsor_enabled';

/** 图片 dataURL 上限：4,000,000 字符 ≈ 3MB 原图（前端已压缩到 ~1080px/JPEG85） */
const MAX_IMAGE_CHARS = 4_000_000;
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 读三个固定键（缺省安全） */
async function readSponsorConfig() {
  const rows = await db.config.findMany({
    where: { key: { in: [KEY_IMAGE, KEY_NOTE, KEY_ENABLED] } },
  });
  const map: Record<string, string> = {};
  rows.forEach(r => { map[r.key] = r.value; });
  return map;
}

// GET /api/v1/sponsor —— 公开（前台赞助弹窗用）
export async function GET() {
  try {
    const map = await readSponsorConfig();
    const enabled = map[KEY_ENABLED] === '1';
    const image = enabled && map[KEY_IMAGE] ? map[KEY_IMAGE] : null;
    return NextResponse.json(
      {
        enabled,
        note: map[KEY_NOTE] ?? '',
        // 未启用时不回传图片（未开放态不给数据）
        image,
        hasImage: Boolean(map[KEY_IMAGE]),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Failed to fetch sponsor' }, { status: 500 });
  }
}

// PUT /api/v1/sponsor —— 管理员后台（OWNER/ADMIN）
export async function PUT(req: NextRequest) {
  // requireRole 返回 { admin, response }：response 非 null 即拦截（401/403）
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { imageDataUrl, note, enabled } = body as {
      imageDataUrl?: string | null;
      note?: string;
      enabled?: boolean;
    };

    const updates: Array<{ key: string; value: string }> = [];

    if (imageDataUrl !== undefined) {
      const v = imageDataUrl ?? '';
      if (v !== '') {
        if (!v.startsWith('data:image/')) {
          return NextResponse.json({ error: '图片格式无效（需 data:image/*;base64）' }, { status: 400 });
        }
        const mime = v.slice(5, v.indexOf(';'));
        if (!ALLOWED_MIME.includes(mime)) {
          return NextResponse.json({ error: `不支持的图片类型：${mime}` }, { status: 400 });
        }
        if (v.length > MAX_IMAGE_CHARS) {
          return NextResponse.json({ error: '图片过大（上限约 3MB）' }, { status: 400 });
        }
      }
      updates.push({ key: KEY_IMAGE, value: v });
    }

    if (note !== undefined) {
      const v = String(note).slice(0, 200);
      updates.push({ key: KEY_NOTE, value: v });
    }

    if (enabled !== undefined) {
      updates.push({ key: KEY_ENABLED, value: enabled ? '1' : '0' });
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
    }

    for (const u of updates) {
      await db.config.upsert({
        where: { key: u.key },
        update: { value: u.value },
        create: { key: u.key, value: u.value },
      });
    }

    await db.operationLog.create({
      data: {
        type: 'update',
        detail: `admin → sponsor 更新（${updates.map(u => u.key).join('、')}）`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    const map = await readSponsorConfig();
    return NextResponse.json({
      ok: true,
      enabled: map[KEY_ENABLED] === '1',
      note: map[KEY_NOTE] ?? '',
      hasImage: Boolean(map[KEY_IMAGE]),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to update sponsor' }, { status: 500 });
  }
}
