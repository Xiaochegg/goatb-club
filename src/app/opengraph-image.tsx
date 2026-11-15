import { ImageResponse } from 'next/og';

// ============================================================
// SA-10 SEO：动态 OG 图片（Next.js opengraph-image 约定）
// 1200×630 社交分享卡片。英文文案（next/og 默认字体无 CJK 字形，
// 中文会渲染为 tofu 方块——故用英文保字形安全）。
// 运行时生成（serverless），数据更新即刷新。
// ============================================================

export const alt = 'GOATB Community Leaderboard';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0f0a1e 0%, #1a1030 50%, #0d1f1a 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        {/* 装饰光晕 */}
        <div
          style={{
            position: 'absolute',
            top: -100,
            right: -100,
            width: 400,
            height: 400,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(52,211,153,0.25) 0%, transparent 70%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -120,
            left: -80,
            width: 350,
            height: 350,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(191,90,242,0.2) 0%, transparent 70%)',
          }}
        />
        {/* 品牌标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #34d399, #10b981)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 40,
              fontWeight: 800,
              color: '#0f0a1e',
            }}
          >
            G
          </div>
          <div style={{ fontSize: 56, fontWeight: 800, color: '#34d399', letterSpacing: '-0.02em' }}>
            GOATB
          </div>
        </div>
        {/* 副标题 */}
        <div style={{ fontSize: 32, color: '#ffffff', fontWeight: 600, marginBottom: 12 }}>
          Community Leaderboard
        </div>
        <div style={{ fontSize: 20, color: 'rgba(255,255,255,0.5)' }}>
          Minecraft Competitive Rankings &middot; Live Tiers &amp; Scores
        </div>
        {/* 底部标签 */}
        <div
          style={{
            marginTop: 40,
            display: 'flex',
            gap: 12,
          }}
        >
          {['Total', 'Emotion', '9 Modes'].map((t) => (
            <div
              key={t}
              style={{
                padding: '8px 20px',
                borderRadius: 999,
                background: 'rgba(52,211,153,0.15)',
                border: '1px solid rgba(52,211,153,0.3)',
                color: '#34d399',
                fontSize: 16,
                fontWeight: 500,
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
