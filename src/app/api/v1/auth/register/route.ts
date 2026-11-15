import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/password';
import { setPlayerCookie } from '@/lib/player-auth';
import { issueSessionMarker } from '@/lib/session-ledger';
import { findPlayerByGameName } from '@/lib/game-name';

// ============================================================
// POST /api/v1/auth/register — AUTH V2.0 PHASE 3 改造版
// ------------------------------------------------------------
// 工单依据（2026-11-10/11）：
//   ①「彻底取消 Brevo、SMTP、邮件验证码、邮箱验证及邮件 API 依赖」→
//     本路由不再签发验证令牌、不再发送任何邮件（R-1，邮件链路整体退役）。
//   ②「保留邮箱作为唯一登录账号，注册后直接登录」（管理员批复原话；
//     PHASE 7 验收一「注册后直接登录」）→ 注册成功即建立会话（Set-Cookie），
//     前端既有 data.success → setPlayer 分支零改动承接（R-2）。
//   ③「不需要 Brevo 凭证即可正常运行」（PHASE 7 验收一）——本路由已零邮件依赖。
// 防枚举口径（变更披露，台账风险 R9）：
//   「邮箱已占用」分支维持统一响应（HTTP 200 + success:false + neutral 统一文案，
//   无 Set-Cookie）；「注册成功」分支返回 success:true + Set-Cookie——响应面差异
//   使注册接口可探测邮箱存在性（管理员批复已知悉，D-1 选定）；缓解=既有
//   5/15min/IP 限流 + 玩家 email 从不公开输出（sanitizePlayerOutput 白名单）。
//   游戏ID 冲突维持 409（ID 为榜单公开信息，无枚举向量）。
// 纪律：本路由不写任何明文口令入日志。
// ============================================================

const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();

// 邮箱格式：非空白@非空白.非空白（宽松校验，防垃圾输入）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 「邮箱已占用」统一文案（与 PHASE 1 时代逐字节一致的口径保留：
// 文案不再指向邮件验证，改为登录指引；两处 success:false 分支共用同一构造器）
const UNIFORM_OCCUPIED_MSG =
  '注册请求已处理：该邮箱可能已注册，请直接使用邮箱与密码登录；' +
  '若忘记密码，请联系管理员申请重置。';

function occupiedResponse() {
  return NextResponse.json(
    { success: false, error: UNIFORM_OCCUPIED_MSG, neutral: true },
    { status: 200 },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.count >= 5 && now - attempt.lastAttempt < 15 * 60 * 1000) {
      return NextResponse.json({ error: '尝试次数过多，请稍后再试' }, { status: 429 });
    }

    const { email, password, name } = await req.json();

    if (!email || !password || !name) {
      return NextResponse.json({ error: '邮箱、密码、游戏ID 均为必填' }, { status: 400 });
    }
    if (!EMAIL_RE.test(String(email))) {
      return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密码至少 6 位' }, { status: 400 });
    }
    // P3-23（审计 2026-11-13）：补上限 128 位 —— 超长密码会让 scrypt 每次
    // 请求全量计算造成 CPU 放大；上下限 6-128 与 change-password 同口径。
    if (password.length > 128) {
      return NextResponse.json({ error: '密码长度需在 6-128 位之间' }, { status: 400 });
    }
    if (String(name).trim().length < 2) {
      return NextResponse.json({ error: '游戏ID 至少 2 个字符' }, { status: 400 });
    }

    // 防枚举核心：邮箱已占用 → 计入限流 + 静默返回统一响应（不创建、不泄露）
    // 邮箱不挡路修复（批示 trace 1a1d04505a0fd5e9「不管什么邮箱都可以认领，
    // 反正都是管理员去确认」）：占位邮箱（挂在无凭据代录条目上的虚拟邮箱）
    // 不再按「已注册」拦截 —— 那条路是死路：玩家按提示去登录却没有密码，
    // 最终只能找管理员。新口径：
    //   · 邮箱被「真账号」（有 passwordHash）持有 → 维持统一静默文案（防枚举不变）；
    //   · 邮箱仅被「占位条目」持有 → 不拦截：名字也撞条目则走名字认领通道，
    //     名字未撞则直接引导认领「挂着该邮箱的条目」（claimAvailable 通道复用）。
    const existingEmail = await db.player.findFirst({
      where: { email: String(email).toLowerCase() },
    });
    if (existingEmail && existingEmail.passwordHash) {
      loginAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });
      return occupiedResponse();
    }

    // 游戏ID 唯一性（榜单公开信息，冲突提示不含邮箱存在性信息）
    // 准确度修复（批示 2026-11-12 trace 1a1d027ae7f6abd1）：两级匹配
    // （精确 → NFKC/小写/去空白归一化兑底）——修复「GoatX vs goatx /
    // ＧＯＡＴＸ / 带空格」近似名漏判：旧逻辑只做精确等值，近似名直接
    // 注册成新条目，榜单双近似名且认领通道永不开启（根因①）。
    const existingName = await findPlayerByGameName(String(name));
    if (existingName) {
      loginAttempts.set(ip, { count: (attempt?.count || 0) + 1, lastAttempt: now });
      // ── 认领通道直达（工单 2026-11-12 管理员指示：注册撞名不再死路）──
      // 目标条目无凭据（管理员代录）时，响应携带 claimAvailable，
      // 前端据此展示「申请认领该条目」通道（POST /api/v1/auth/register-claim）。
      // 管理员审批通过 = 该条目占位邮箱（虚拟邮箱）替换为玩家正式邮箱 + 凭据落位。
      // 可认领判据（同批修复，根因②）：无凭据即可认领（passwordHash 为空）——
      // 管理员代录条目无论是匿名还是带占位邮箱，真实玩家都能走认领；
      // 目标已有真账号（有 passwordHash）→ 维持原 409 口径（去登录）。
      const claimable = !existingName.passwordHash;
      return NextResponse.json(
        {
          error: claimable
            ? '该游戏ID已有榜单条目（管理员代录占位）。如果你的就是这条，填好邮箱密码后可直接申请认领，管理员确认后会把条目改绑为你的邮箱'
            : '该游戏ID已被占用（如为你的条目，请登录后使用「认领我的榜单条目」功能）',
          claimAvailable: claimable,
          targetPlayerId: claimable ? existingName.id : undefined,
          targetName: claimable ? existingName.name : undefined,
          targetHasEmail: claimable ? !!existingName.email : undefined,
        },
        { status: 409 },
      );
    }

    // 邮箱占位兜底（批示 trace 1a1d04505a0fd5e9）：名字未撞任何条目，但邮箱
    // 恰好挂在某个占位代录条目上（管理员录虚拟邮箱时用了玩家真实邮箱等场景）
    // → 不走注册新建（email UNIQUE 会撞占位条目），改为引导认领该条目。
    // 名字撞名优先级更高（已在上方 claimAvailable 分支返回）。
    if (existingEmail && !existingEmail.passwordHash) {
      return NextResponse.json(
        {
          error: '你填写的邮箱已作为占位邮箱挂在榜单条目「' + existingEmail.name + '」上。如果这条就是你的，可直接提交认领申请，管理员确认后该条目将正式绑定你的邮箱',
          claimAvailable: true,
          targetPlayerId: existingEmail.id,
          targetName: existingEmail.name,
          targetHasEmail: true,
        },
        { status: 409 },
      );
    }

    // 创建账号（空段位/战绩，管理员后续填写）→ 注册成功即登录（R-2）
    const passwordHash = hashPassword(String(password));
    const player = await db.player.create({
      data: {
        name: String(name).trim(),
        email: String(email).toLowerCase(),
        passwordHash,
      },
    });

    // 注册成功即建立会话（新建玩家 sessionEpoch=0；工单「注册后直接登录」）
    await setPlayerCookie(player.id, player.sessionEpoch);
    // AUTH V2.0 会话安全中心：留痕+标记（best-effort，失败不阻断）
    await issueSessionMarker(player.id, { ip, userAgent: req.headers.get('user-agent') }).catch(() => {});

    // 注册审计日志（管理员可见；沿用原格式）
    await db.operationLog
      .create({
        data: {
          type: 'info',
          detail: `register · ${player.name} · ${player.email}`,
          scoreChange: null,
          adminKey: player.name,
          ip,
        },
      })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      player: { id: player.id, name: player.name, email: player.email, mustChangePassword: false },
    });
  } catch (error) {
    return NextResponse.json({ error: '注册失败' }, { status: 500 });
  }
}
