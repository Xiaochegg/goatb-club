import { db } from '@/lib/db';
import { requireRole, getCurrentAdmin } from '@/lib/auth';
import { NEVER_RETURN_KEYS } from '@/lib/config-guard';
import { NextRequest, NextResponse } from 'next/server';
import { CONFIG_KEYS } from '@/lib/constants';
import { bustPlayerCaches } from '@/lib/cache';

// ============================================================
// AUTH V2.0 · Phase 1 紧急安全修复（2026-11-10，PHASE 0 审计实锤）：
//   修复前：GET /api/v1/config?key=任意键 无鉴权直读任意 Config 行——
//   含 session_secret（HMAC 会话签名根密钥），未登录可取 → 可自签
//   beclub_admin/beclub_player cookie → 完全接管（PHASE 0 报告 §2.5-1）。
//   修复后：
//     1) 公开白名单 PUBLIC_CONFIG_KEYS：匿名仅可读前端启动合法依赖的
//        非敏感运营键（page.tsx 匿名消费实测仅 announcement + min_matches，
//        白名单另含 feature_claim/player_tag_styles/api_auto_expire_notice/
//        public_api 等公开面键，保持既有公开能力零回退）；
//     2) 白名单外的 key 直读与全图读取：要求管理员（401 口径与
//        requireAdmin 一致，不泄露键存在性）；
//     3) session_secret 列入硬黑名单：【对任何身份】（含管理员）都绝不
//        经 HTTP 返回——服务端签名始终经 getSessionSecret() 直读 DB，
//        无任何前端/管理面板需要经 HTTP 取它（纵深防御）。
//   兼容性核验（零破坏）：匿名 boot 预取 '/api/v1/config'（boot-data.ts
//   BOOT_URLS）→ 白名单全图含 announcement/min_matches ✓；管理后台
//   content-tabs 全图（adminFetch 附凭据）→ 仅少 session_secret（无消费方）✓；
//   tag-styles-tab '?key=player_tag_styles' → 白名单内 ✓。
// ============================================================

// 匿名可读白名单（全部为公开面运营键；新增公开键须逐项审批记录）
const PUBLIC_CONFIG_KEYS = new Set([
  'announcement',
  'min_matches',
  'feature_claim',
  'player_tag_styles',
  'api_auto_expire_notice',
  'public_api',
]);

// 硬黑名单：任何身份、任何路径形态都绝不返回（认证根信任 material）
// AUTH V2.0 安全修复专项（2026-11-11）：黑名单升级为全仓共享单一事实源
// src/lib/config-guard.ts——config GET/PUT 与 archive GET/POST 四路统一消费，
// session_secret 读取/导出/写入/恢复全部封死（终审计 §7-G3/G6 修复）

// GET /api/v1/config?key=xxx
export async function GET(req: NextRequest) {
  try {
    const key = req.nextUrl.searchParams.get('key');
    const admin = await getCurrentAdmin();
    if (key) {
      // 硬黑名单优先：对任何身份统一 401（与未授权同响应，不泄露键存在性）
      if (NEVER_RETURN_KEYS.has(key)) {
        return NextResponse.json(
          { error: '未授权 — 请先登录管理员账号', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      }
      if (PUBLIC_CONFIG_KEYS.has(key)) {
        const config = await db.config.findUnique({ where: { key } });
        return NextResponse.json({ value: config?.value ?? '' });
      }
      // 白名单外：管理员方可直读
      if (!admin) {
        return NextResponse.json(
          { error: '未授权 — 请先登录管理员账号', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      }
      const config = await db.config.findUnique({ where: { key } });
      return NextResponse.json({ value: config?.value ?? '' });
    }
    // 全图：匿名 → 仅白名单键；管理员 → 全部键（硬黑名单仍排除）
    const configs = await db.config.findMany();
    const map: Record<string, string> = {};
    configs.forEach(c => {
      if (NEVER_RETURN_KEYS.has(c.key)) return;
      if (admin || PUBLIC_CONFIG_KEYS.has(c.key)) map[c.key] = c.value;
    });
    return NextResponse.json({ configs: map });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch config' }, { status: 500 });
  }
}

// PUT /api/v1/config - Update config
export async function PUT(req: NextRequest) {
  // AUTH V2.0 安全修复专项（2026-11-11）：RBAC 升格——VIEWER 只读，
  // 配置写入限 OWNER/ADMIN（对齐 auth.ts canEditConfig 语义，spec §19）
  const guard = await requireRole('OWNER', 'ADMIN');
  if (guard.response) return guard.response;

  try {
    const body = await req.json();
    const { key, value } = body;

    if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });

    // session_secret 永久硬性黑名单（写侧）：任何身份（含 OWNER）都不可经 HTTP 覆写根密钥
    if (NEVER_RETURN_KEYS.has(String(key))) {
      return NextResponse.json(
        { error: '该配置键受保护：禁止写入', code: 'PROTECTED_KEY' },
        { status: 400 }
      );
    }

    const config = await db.config.upsert({
      where: { key },
      update: { value: value ?? '' },
      create: { key, value: value ?? '' },
    });

    await db.operationLog.create({
      data: {
        type: 'update',
        detail: `admin → config · ${key} = ${String(value ?? '').slice(0, 40)}`,
        scoreChange: null,
        adminKey: 'admin',
      },
    }).catch(() => {});

    // 玩家个性标签样式变更 → 立即清榜单缓存，让前台 15s TTL 之外也能即时生效
    if (key === CONFIG_KEYS.PLAYER_TAG_STYLES) {
      bustPlayerCaches();
    }

    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}
