// 全局类型声明（音乐播放器相关）
// Task 39：为 window.__MUSIC_ENV__ 等音乐播放器注入的全局变量提供类型
// Task 40：补 PlayableSong 类型 + preResolveArtist/getPlayableUrl 精确签名

export interface PlayableSong {
  id: string | number;
  name: string;
  artist: string;
  playUrl: string;
  duration?: number;
}

declare global {
  interface Window {
    // 音乐播放器环境变量（由 music-player-loader.tsx 注入）
    __MUSIC_ENV__?: {
      NCM_COOKIE?: string;
    };
    // music-config.js 注入
    MUSIC_CONFIG?: {
      apiList: Array<{
        name: string;
        baseUrl: string;
        type: 'tunehub' | 'gomusic' | 'ncm' | 'meting' | 'gdstudio';
        timeout: number;
        maxRetry: number;
      }>;
      currentApiIndex: number;
      artistId: string;
      playlistId: string;
      server: string;
      ncmCookie: string;
      playerPosition: string;
      playerVolume: number;
      showLyrics: boolean;
      showPlaylist: boolean;
      fallbackToNativeAudio: boolean;
      maxConsecutiveFailures: number;
      hideOnAllFail: boolean;
    };
    // music-api.js 注入
    MusicAPI?: {
      search: (keywords: string) => Promise<unknown>;
      getSongUrl: (songId: string | number) => Promise<unknown>;
      getArtistSongs: (artistId: string | number) => Promise<unknown>;
      getPlaylist: (playlistId: string | number) => Promise<unknown>;
      filterPlayableSongs: (songList: Array<{ id: string | number; name?: string }>) => Promise<unknown[]>;
      getCurrentApi: () => string;
      reset: () => void;
      // Task 40-2 新增：歌曲级跨 API 换源 + 预解析
      getPlayableUrl?: (songId: string | number) => Promise<string | null>;
      preResolveArtist?: (artistId: string | number) => Promise<PlayableSong[]>;
      preResolvePlaylist?: (playlistId: string | number) => Promise<PlayableSong[]>;
    };
    // music-player-init.js 注入
    // Arena Console V2.0（2026-11）：补全既有的公开展开/收起 API 类型——
    // 该 API 在 music-player-init.js 中早已实现（window.MusicPlayer 暴露），
    // 此处仅为 TypeScript 声明补全，播放器本身零改动。
    MusicPlayer?: {
      reset: () => void;
      getCurrentApi: () => string | undefined;
      expand: () => void;
      collapse: () => void;
      toggle: () => void;
      play: (idx?: number) => void;
      next: () => void;
      prev: () => void;
    };
    // （2026-12 清理：music-test.js 已移出生产加载链，MusicTest 类型声明同步移除）
    // liveling-music-player CDN 注入
    LivelingMusicPlayer?: new (options: Record<string, unknown>) => {
      mount: () => unknown;
      destroy?: () => void;
    };
  }
}

export {};
