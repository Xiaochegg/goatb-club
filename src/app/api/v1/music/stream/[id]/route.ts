import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// Music Stream API - Pure Streaming Proxy (Task 41 重构)
// 版权合规改造：移除 disk 缓存（旧版 tee 写盘 music-cache/*.m4a），
// 改为纯流式透传 —— 只做流式播放传输，不下载、不存储、不缓存音频。
// - Range 请求透传网易 CDN（支持 seek）
// - 206/200 透传
// - URL 内存缓存保留（只缓存 url 字符串，非音频数据）
// ============================================================

const NETEASE_HOST = 'music.163.com';

// URL cache (30 min) —— 仅缓存 url 字符串，非音频
const urlCache = new Map<number, { url: string; ts: number }>();
const URL_TTL = 30 * 60 * 1000;

async function getRemoteUrl(songId: number): Promise<string | null> {
  const c = urlCache.get(songId);
  if (c && Date.now() - c.ts < URL_TTL) return c.url;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('NeteaseCloudMusicApi/util/crypto');
    const enc = crypto.weapi({ ids: `[${songId}]`, level: 'standard', encodeType: 'aac' });
    const body = `params=${encodeURIComponent(enc.params)}&encSecKey=${encodeURIComponent(enc.encSecKey)}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    const res = await fetch(`https://${NETEASE_HOST}/weapi/song/enhance/player/url/v1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36',
        'Cookie': 'MUSIC_U=; __csrf=',
      },
      body, signal: ac.signal,
    });
    clearTimeout(t);

    if (res.ok) {
      const d = await res.json();
      const url: string | undefined = d?.data?.[0]?.url;
      if (url) { urlCache.set(songId, { url, ts: Date.now() }); return url; }
    }
  } catch (e) { console.error(`[Stream] weapi err ${songId}:`, e); }
  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const songId = Number(idStr);
  if (!songId || isNaN(songId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  // Get remote URL
  const remoteUrl = await getRemoteUrl(songId);
  if (!remoteUrl) {
    return NextResponse.json({ error: '无法获取播放地址（可能需要VIP或歌曲下架）' }, { status: 404 });
  }

  // 纯流式透传：Range 原样转发，206/200 原样返回（支持 seek）
  try {
    const range = req.headers.get('range');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60000);
    const res = await fetch(remoteUrl, {
      signal: ac.signal,
      headers: range ? { Range: range } : undefined,
    });
    clearTimeout(t);

    if (!res.ok || !res.body) {
      // 网易 CDN 拒绝（403 等）→ 让前端换源
      return NextResponse.json({ error: 'Source fetch failed' }, { status: 502 });
    }

    const headers = new Headers();
    headers.set('Content-Type', res.headers.get('content-type') || 'audio/mp4');
    const len = res.headers.get('content-length');
    if (len) headers.set('Content-Length', len);
    const cr = res.headers.get('content-range');
    if (cr) headers.set('Content-Range', cr);
    headers.set('Accept-Ranges', res.headers.get('accept-ranges') || 'bytes');
    headers.set('X-Cache', 'STREAM'); // 纯流式，无缓存

    return new NextResponse(res.body, { status: res.status, headers });
  } catch (e) {
    console.error(`[Stream] Proxy err ${songId}:`, e);
    return NextResponse.json({ error: 'Stream failed' }, { status: 502 });
  }
}
