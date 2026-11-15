import { NextResponse } from 'next/server';

// ============================================================
// Music Hot Songs API
// Uses NeteaseCloudMusicApi's crypto module for weapi encryption
// Then calls NetEase API directly from server side
// ============================================================

const NETEASE_HOST = 'music.163.com';
const HOT_PLAYLIST_ID = '3778678';

interface HotSong {
  id: number;
  name: string;
  artists: string;
  album: string;
  cover: string;
  duration: number;
}

// In-memory cache (TTL: 10 minutes)
let cachedSongs: { songs: HotSong[]; timestamp: number } | null = null;
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

async function fetchHotSongs(): Promise<HotSong[]> {
  // Method 1: weapi encryption (most reliable)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ncmCrypto = require('NeteaseCloudMusicApi/util/crypto');
    const encrypted = ncmCrypto.weapi({ id: HOT_PLAYLIST_ID, n: 1000, s: 0 });
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
        return tracks.slice(0, 100).map((t: Record<string, unknown>) => {
          const ar = t.ar || t.artists;
          const al = t.al || t.album;
          return {
            id: t.id as number,
            name: (t.name as string) || '未知',
            artists: Array.isArray(ar) ? (ar as Array<{ name: string }>).map(a => a.name).join(' / ') : '未知歌手',
            album: al?.name || '',
            cover: al?.picUrl || '',
            duration: (t.dt || t.duration || 0) as number,
          };
        });
      }
    }
  } catch (e) {
    console.error('weapi playlist error:', e);
  }

  // Method 2: Direct API (no encryption)
  try {
    const res = await fetchWithTimeout(
      `https://${NETEASE_HOST}/api/playlist/detail?id=${HOT_PLAYLIST_ID}`,
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
        return tracks.slice(0, 50).map((t: Record<string, unknown>) => {
          const artists = t.artists as Array<{ name: string }> | undefined;
          const album = t.album as { name: string; picUrl: string } | undefined;
          return {
            id: t.id as number,
            name: (t.name as string) || '未知',
            artists: artists ? artists.map(a => a.name).join(' / ') : '未知歌手',
            album: album?.name || '',
            cover: album?.picUrl || '',
            duration: (t.duration as number) || 0,
          };
        });
      }
    }
  } catch (e) {
    console.error('direct playlist error:', e);
  }

  return [];
}

export async function GET() {
  if (cachedSongs && Date.now() - cachedSongs.timestamp < CACHE_TTL) {
    return NextResponse.json({ songs: cachedSongs.songs, cached: true });
  }

  try {
    const songs = await fetchHotSongs();
    if (songs.length > 0) {
      cachedSongs = { songs, timestamp: Date.now() };
      return NextResponse.json({ songs, cached: false });
    }
    if (cachedSongs) {
      return NextResponse.json({ songs: cachedSongs.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: '音乐服务暂不可用，请稍后重试' }, { status: 503 });
  } catch (error) {
    if (cachedSongs) {
      return NextResponse.json({ songs: cachedSongs.songs, cached: true, stale: true });
    }
    return NextResponse.json({ songs: [], error: String(error) }, { status: 500 });
  }
}
