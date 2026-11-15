import { NextResponse } from 'next/server';

// ============================================================
// Music Search API (Task 41)
// 服务端 weapi 直连网易搜索（不受浏览器 CORS 限制）
// 用途：播放器内置"网易云搜索"
// 响应格式：{ songs: HotSong[] } —— 与 /api/v1/music/hot 一致
// ============================================================

const NETEASE_HOST = 'music.163.com';

interface HotSong {
  id: number;
  name: string;
  artists: string;
  artistId: number | null;  // Task 41: 首位歌手 ID（用于跳转歌手主页）
  album: string;
  cover: string;
  duration: number;
}

// 短缓存（搜索结果 3 分钟，避免高频重复搜索打网易接口）
const searchCache = new Map<string, { songs: HotSong[]; timestamp: number }>();
const CACHE_TTL = 3 * 60 * 1000;
const CACHE_MAX = 100; // 最多缓存 100 个关键词

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

function mapTrack(t: Record<string, unknown>): HotSong | null {
  const id = t.id as number;
  if (!id) return null;
  const ar = (t.ar || t.artists) as Array<{ id?: number; name: string }> | undefined;
  const al = (t.al || t.album) as { name?: string; picUrl?: string } | undefined;
  return {
    id,
    name: (t.name as string) || '未知',
    artists: Array.isArray(ar) ? ar.map(a => a.name).join(' / ') : '未知歌手',
    artistId: Array.isArray(ar) && ar[0]?.id ? Number(ar[0].id) : null,
    album: al?.name || '',
    cover: al?.picUrl || '',
    duration: ((t.dt || t.duration || 0) as number) || 0,
  };
}

async function searchSongs(keywords: string, limit: number): Promise<HotSong[]> {
  // Method 1: weapi /weapi/search/get（type=1 单曲搜索）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({
      s: keywords,
      type: 1,          // 1=单曲 10=专辑 100=歌手 1000=歌单
      limit,
      offset: 0,
    });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/weapi/search/get`,
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
      const tracks = data?.result?.songs;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('weapi search error:', e);
  }

  // Method 2: cloudsearch（备用）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({
      s: keywords,
      type: 1,
      limit,
      offset: 0,
    });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/weapi/cloudsearch/get/web`,
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
      const tracks = data?.result?.songs;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('weapi cloudsearch error:', e);
  }

  return [];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keywords = (searchParams.get('keywords') || '').trim();
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || '30'), 1), 100);

  if (!keywords) {
    return NextResponse.json({ songs: [], error: 'Missing keywords' }, { status: 400 });
  }

  const cacheKey = `${keywords}::${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({ songs: cached.songs, cached: true });
  }

  try {
    const songs = await searchSongs(keywords, limit);
    if (songs.length > 0) {
      // 简单 LRU：超上限清最旧的
      if (searchCache.size >= CACHE_MAX) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey) searchCache.delete(oldestKey);
      }
      searchCache.set(cacheKey, { songs, timestamp: Date.now() });
      return NextResponse.json({ songs, cached: false });
    }
    return NextResponse.json({ songs: [], error: '未找到相关歌曲' }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ songs: [], error: String(error) }, { status: 500 });
  }
}
