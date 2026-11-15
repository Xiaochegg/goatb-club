import { NextResponse } from 'next/server';

// ============================================================
// Music Toplist API (Task 41)
// 服务端 weapi 直连网易，获取任意歌单/榜单歌曲（不受浏览器 CORS 限制）
// 用途：播放器内置多个热门榜（飙升/新歌/热歌/原创/ACG/抖音）
// 响应格式：{ songs: HotSong[] } —— 与 /api/v1/music/hot 一致
//
// 网易云官方榜单 ID：
//   19723756 = 飙升榜
//   3779629  = 新歌榜
//   3778678  = 热歌榜（与 /api/v1/music/hot 相同，保留 hot 路由作快捷入口）
//   2884035  = 原创榜
//   991319590= ACG榜
//   745956260= 抖音榜
// ============================================================

const NETEASE_HOST = 'music.163.com';

interface HotSong {
  id: number;
  name: string;
  artists: string;
  album: string;
  cover: string;
  duration: number;
}

// 多榜单缓存（按 playlistId 分桶，TTL 10 分钟）
const toplistCache = new Map<string, { songs: HotSong[]; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000;

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
  const ar = (t.ar || t.artists) as Array<{ name: string }> | undefined;
  const al = (t.al || t.album) as { name?: string; picUrl?: string } | undefined;
  return {
    id,
    name: (t.name as string) || '未知',
    artists: Array.isArray(ar) ? ar.map(a => a.name).join(' / ') : '未知歌手',
    album: al?.name || '',
    cover: al?.picUrl || '',
    duration: ((t.dt || t.duration || 0) as number) || 0,
  };
}

async function fetchToplist(playlistId: string): Promise<HotSong[]> {
  // Method 1: weapi /weapi/v6/playlist/detail（与 hot 路由同一接口，支持任意歌单 ID）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({ id: playlistId, n: 1000, s: 0 });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/weapi/v6/playlist/detail`,
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
      const tracks = data?.playlist?.tracks || data?.result?.tracks || data?.songs;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.slice(0, 100).map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('weapi toplist error:', e);
  }

  // Method 2: Direct API（部分免费场景可用）
  try {
    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/api/playlist/detail?id=${playlistId}`,
      {
        headers: {
          'Referer': 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (res.ok) {
      const data = await res.json();
      const tracks = data?.result?.tracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.slice(0, 50).map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('direct toplist error:', e);
  }

  return [];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = (searchParams.get('id') || '').trim();

  if (!id) {
    return NextResponse.json({ songs: [], error: 'Missing playlist id' }, { status: 400 });
  }

  const cached = toplistCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({ songs: cached.songs, cached: true });
  }

  try {
    const songs = await fetchToplist(id);
    if (songs.length > 0) {
      toplistCache.set(id, { songs, timestamp: Date.now() });
      return NextResponse.json({ songs, cached: false });
    }
    if (cached) {
      return NextResponse.json({ songs: cached.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: '榜单暂不可用，请稍后重试' }, { status: 503 });
  } catch (error) {
    if (cached) {
      return NextResponse.json({ songs: cached.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: String(error) }, { status: 500 });
  }
}
