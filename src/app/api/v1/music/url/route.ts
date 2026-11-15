import { NextResponse } from 'next/server';

// ============================================================
// Music Song URL API
// Uses NeteaseCloudMusicApi's crypto module for weapi encryption
// Then calls NetEase API directly from server side
// ============================================================

const NETEASE_HOST = 'music.163.com';

// In-memory cache for song URLs (TTL: 30 minutes)
const urlCache = new Map<number, { url: string; timestamp: number }>();
const URL_CACHE_TTL = 30 * 60 * 1000;

async function fetchWithTimeout(url: string, options?: RequestInit, timeout = 15000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function getSongUrl(songId: number): Promise<string | null> {
  // Method 1: weapi encryption (most reliable)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({
      ids: `[${songId}]`,
      level: 'standard',
      encodeType: 'aac',
    });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/weapi/song/enhance/player/url/v1`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
          'Accept': '*/*',
          'Cookie': 'MUSIC_U=; __csrf=',
        },
        body,
      }
    );

    if (res.ok) {
      const data = await res.json();
      const url = data?.data?.[0]?.url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  } catch (e) {
    console.error('weapi song URL error:', e);
  }

  // Method 2: Direct API (sometimes works for free songs)
  try {
    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/api/song/enhance/player/url/v1?id=${songId}&level=standard`,
      {
        headers: {
          'Referer': 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (res.ok) {
      const text = await res.text();
      if (text) {
        try {
          const data = JSON.parse(text);
          const url = data?.data?.[0]?.url;
          if (typeof url === 'string' && url.length > 0) return url;
        } catch {
          // Invalid JSON from direct API, skip
        }
      }
    }
  } catch {
    // Direct API unavailable, skip
  }

  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing song id' }, { status: 400 });
  }

  const songId = Number(id);
  if (isNaN(songId)) {
    return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });
  }

  // Check cache
  const cached = urlCache.get(songId);
  if (cached && Date.now() - cached.timestamp < URL_CACHE_TTL) {
    return NextResponse.json({ url: cached.url, cached: true });
  }

  try {
    const url = await getSongUrl(songId);
    if (url) {
      urlCache.set(songId, { url, timestamp: Date.now() });
      return NextResponse.json({ url, cached: false });
    }
    return NextResponse.json({ url: null, error: '无法获取播放地址（可能需要VIP或歌曲下架）' }, { status: 404 });
  } catch (error) {
    if (cached) {
      return NextResponse.json({ url: cached.url, cached: true, stale: true });
    }
    return NextResponse.json({ url: null, error: String(error) }, { status: 500 });
  }
}
