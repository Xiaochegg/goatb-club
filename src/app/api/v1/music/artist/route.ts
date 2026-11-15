import { NextResponse } from 'next/server';

// ============================================================
// Music Artist Songs API (Task 41)
// 服务端 weapi 直连网易，获取歌手热门歌曲（不受浏览器 CORS 限制）
// 用途：前端播放器默认数据源（小车 artistId=123561221）
// 响应格式：{ songs: HotSong[] } —— 与 /api/v1/music/hot 一致
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

// In-memory cache (TTL: 10 minutes)
const artistCache = new Map<number, { songs: HotSong[]; timestamp: number }>();
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

async function fetchArtistSongs(artistId: number): Promise<HotSong[]> {
  // Method 1: weapi /weapi/v1/artist/{id}（歌手主页，返回 hotSongs 热门50首）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({ id: artistId, limit: 50, offset: 0, total: true });
    const body = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/weapi/v1/artist/${artistId}`,
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
      const tracks = data?.hotSongs || data?.artist?.hotSongs;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.slice(0, 50).map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('weapi artist error:', e);
  }

  // Method 2: Direct API（部分免费场景可用）
  try {
    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/api/artist/${artistId}`,
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
      const tracks = data?.hotSongs || data?.artist?.hotSongs;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.slice(0, 50).map(mapTrack).filter(Boolean) as HotSong[];
      }
    }
  } catch (e) {
    console.error('direct artist error:', e);
  }

  return [];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const idParam = searchParams.get('id');
  const artistId = Number(idParam || '123561221'); // 默认小车

  if (isNaN(artistId) || artistId <= 0) {
    return NextResponse.json({ songs: [], error: 'Invalid artist id' }, { status: 400 });
  }

  const cached = artistCache.get(artistId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({ songs: cached.songs, cached: true });
  }

  try {
    const songs = await fetchArtistSongs(artistId);
    if (songs.length > 0) {
      artistCache.set(artistId, { songs, timestamp: Date.now() });
      return NextResponse.json({ songs, cached: false });
    }
    if (cached) {
      return NextResponse.json({ songs: cached.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: '音乐服务暂不可用，请稍后重试' }, { status: 503 });
  } catch (error) {
    if (cached) {
      return NextResponse.json({ songs: cached.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: String(error) }, { status: 500 });
  }
}
