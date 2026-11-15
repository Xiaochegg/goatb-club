// music-api.js - 多API适配层，自动降级 + 防跳歌
// 集成自用户提供的音乐播放器方案（Task 38 + Task 39 补充 gomusic/ncm 分支）
(function() {
  'use strict';

  const CONFIG = window.MUSIC_CONFIG;
  let currentApiIndex = CONFIG.currentApiIndex;
  let consecutiveFailures = 0;

  // ========== 工具函数 ==========
  function fetchWithTimeout(url, options = {}, timeout = 3000) {
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('请求超时')), timeout)
      )
    ]);
  }

  async function fetchWithRetry(url, options, maxRetry, timeout) {
    for (let i = 0; i <= maxRetry; i++) {
      try {
        const res = await fetchWithTimeout(url, options, timeout);
        if (res.ok) return res;
        if (i === maxRetry) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (i === maxRetry) throw e;
        console.warn(`[MusicAPI] 第${i + 1}次重试...`, e.message);
      }
    }
  }

  // ========== 获取当前 API ==========
  function getCurrentApi() {
    return CONFIG.apiList[currentApiIndex];
  }

  function switchToNextApi() {
    if (currentApiIndex < CONFIG.apiList.length - 1) {
      currentApiIndex++;
      console.warn(`[MusicAPI] 降级到: ${getCurrentApi().name}`);
      return true;
    }
    return false;
  }

  // ========== 检查 API 是否可用（TODO 占位跳过）==========
  function isApiPlaceholder(api) {
    return !api.baseUrl || typeof api.baseUrl === 'string' && api.baseUrl.startsWith('TODO:');
  }

  // ========== Task 40-2 新增：歌曲级跨 API 换源辅助函数 ==========
  // 构建获取播放链接的端点（与 getSongUrl 的 switch 逻辑一致；独立抽出避免污染主降级链 currentApiIndex）
  function buildSongUrlEndpoint(api, songId) {
    switch (api.type) {
      case 'tunehub':
        return `${api.baseUrl}/?source=netease&id=${songId}&type=url`;
      case 'gomusic':
        // go-music-api：智能换源，song/url 端点会自动匹配可播放替代音源
        return `${api.baseUrl}/song/url?id=${songId}`;
      case 'ncm':
        // NeteaseCloudMusicApiEnhanced：/song/url，配合 unblockmusic-utils 自动解灰
        return `${api.baseUrl}/song/url?id=${songId}${CONFIG.ncmCookie ? '&cookie=' + encodeURIComponent(CONFIG.ncmCookie) : ''}`;
      case 'meting':
        return `${api.baseUrl}/?server=netease&type=url&id=${songId}`;
      case 'gdstudio':
        return `${api.baseUrl}?types=url&source=netease&id=${songId}`;
      default:
        throw new Error('未知 API 类型');
    }
  }

  // 解析各 API 返回的播放链接（各 API 响应结构不同）
  function parseSongUrl(data, apiType) {
    if (!data) return null;
    switch (apiType) {
      case 'server':
        // GOATB-Server：/api/v1/music/url 返回 {url: string|null, cached} 或 404 {url:null,error}
        return data.url || null;
      case 'tunehub':
        // tunefree：302 重定向或 {code, data:{url}}
        return data.data?.url || data.url || null;
      case 'gomusic':
        // go-music-api：netease 兼容格式 {data:[{url}]} 或 {data:{url}}
        if (Array.isArray(data.data)) return data.data[0]?.url || null;
        return data.data?.url || data.url || null;
      case 'ncm':
        // NeteaseCloudMusicApiEnhanced：{data:[{url}]}
        if (Array.isArray(data.data)) return data.data[0]?.url || null;
        return data.data?.url || data.url || null;
      case 'meting':
        // Meting-API：url 接口返回 {url} 或 [{url}]
        if (Array.isArray(data)) return data[0]?.url || null;
        return data.url || data.data?.url || null;
      case 'gdstudio':
        // GD-Studio：url 接口返回 {url} 或 {data:{url}}
        return data.url || data.data?.url || (Array.isArray(data.data) ? data.data[0]?.url : null) || null;
      default:
        return data.data?.url || data.url || (Array.isArray(data.data) ? data.data[0]?.url : null) || null;
    }
  }

  // 验证 url 是否真正可播放（非空、非 null 字符串、非 vip 标记、非 403 错误页、合法 http(s)）
  function isValidPlayableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url === '' || url === 'null' || url === 'undefined') return false;
    if (/vip/i.test(url)) return false;                          // vip 标记过滤
    if (!/^https?:\/\//i.test(url)) return false;              // 拒绝非 http(s) 字符串（如 403 HTML 错误页）
    return true;
  }

  // 统一歌曲列表解析：从各 API 不同的响应结构提取 [{id, name, artist, duration?}]
  // 兼容：meting 直接数组 / netease 的 data.songs / data.hotSongs / data.playlist.tracks / data.tracks / gdstudio 的 list
  function normalizeSongs(rawData, apiType) {
    if (!rawData) return [];
    let list = [];
    if (Array.isArray(rawData)) {
      list = rawData;                                            // meting 风格
    } else if (Array.isArray(rawData.data)) {
      list = rawData.data;
    } else if (rawData.data && Array.isArray(rawData.data.songs)) {
      list = rawData.data.songs;                                 // netease search/artist/song/detail
    } else if (rawData.data && Array.isArray(rawData.data.hotSongs)) {
      list = rawData.data.hotSongs;                              // netease artist hotSongs
    } else if (rawData.data && Array.isArray(rawData.data.tracks)) {
      list = rawData.data.tracks;                                // netease playlist tracks
    } else if (rawData.data && rawData.data.playlist && Array.isArray(rawData.data.playlist.tracks)) {
      list = rawData.data.playlist.tracks;                       // netease playlist detail (alt)
    } else if (rawData.data && rawData.data.list && Array.isArray(rawData.data.list)) {
      list = rawData.data.list;                                  // gdstudio list in data
    } else if (Array.isArray(rawData.songs)) {
      list = rawData.songs;
    } else if (Array.isArray(rawData.hotSongs)) {
      list = rawData.hotSongs;
    } else if (rawData.playlist && Array.isArray(rawData.playlist.tracks)) {
      list = rawData.playlist.tracks;
    } else if (Array.isArray(rawData.list)) {
      list = rawData.list;                                       // gdstudio flat list
    } else if (Array.isArray(rawData.tracks)) {
      list = rawData.tracks;
    }

    return list.map(s => {
      if (!s || typeof s !== 'object') return null;
      const id = s.id ?? s.song_id ?? s.songId ?? s.url_id;
      const name = s.name ?? s.title ?? s.song_name ?? '';
      let artist = '';
      if (Array.isArray(s.ar)) {
        artist = s.ar.map(a => a?.name).filter(Boolean).join('/');
      } else if (Array.isArray(s.artists)) {
        artist = s.artists.map(a => a?.name).filter(Boolean).join('/');
      } else if (typeof s.artist === 'string') {
        artist = s.artist;
      } else if (s.ar_name) {
        artist = s.ar_name;
      }
      const duration = s.dt ?? s.duration ?? undefined;
      if (id == null) return null;                              // 没 id 无法换源，丢弃
      const out = { id, name: String(name || ''), artist: String(artist || '') };
      if (duration != null) out.duration = duration;
      return out;
    }).filter(Boolean);
  }

  // ========== 统一请求入口（带降级） ==========
  async function requestWithFallback(endpointBuilder) {
    while (currentApiIndex < CONFIG.apiList.length) {
      const api = getCurrentApi();
      // TODO 占位的 API（未自建）直接跳过，降级到下一个
      if (isApiPlaceholder(api)) {
        console.warn(`[MusicAPI] ${api.name} 未配置（baseUrl 为 TODO 占位），跳过`);
        if (!switchToNextApi()) break;
        continue;
      }
      try {
        const url = endpointBuilder(api);
        const res = await fetchWithRetry(url, {}, api.maxRetry, api.timeout);
        const data = await res.json();
        // 检查返回是否有效（Task 41: 加 data.songs —— GOATB-Server 的 artist/search/hot 路由返回 {songs:[...]} 壳）
        if (data && (data.code === 200 || data.code === 0 || data.status === 200 || data.data || Array.isArray(data.songs))) {
          consecutiveFailures = 0;
          return data;
        }
        throw new Error('返回数据无效');
      } catch (e) {
        console.warn(`[MusicAPI] ${api.name} 失败:`, e.message);
        if (!switchToNextApi()) break;
      }
    }
    consecutiveFailures++;
    if (consecutiveFailures >= CONFIG.maxConsecutiveFailures && CONFIG.hideOnAllFail) {
      console.error('[MusicAPI] 连续失败次数过多，隐藏播放器');
      window.dispatchEvent(new CustomEvent('music-api-all-fail'));
    }
    throw new Error('所有 API 均不可用');
  }

  // ========== 核心方法：搜索 ==========
  async function search(keywords) {
    return requestWithFallback((api) => {
      switch (api.type) {
        case 'server':
          // GOATB-Server：同源服务端 weapi 搜索（/api/v1/music/search，无 CORS）
          return `${api.baseUrl}/search?keywords=${encodeURIComponent(keywords)}&limit=30`;
        case 'tunehub':
          return `${api.baseUrl}/?source=netease&keywords=${encodeURIComponent(keywords)}&type=search`;
        case 'gomusic':
          // go-music-api：基于 music-lib，搜索端点兼容 NeteaseCloudMusicApi 格式
          return `${api.baseUrl}/search?keywords=${encodeURIComponent(keywords)}`;
        case 'ncm':
          // NeteaseCloudMusicApiEnhanced：标准端点 /search
          return `${api.baseUrl}/search?keywords=${encodeURIComponent(keywords)}`;
        case 'meting':
          return `${api.baseUrl}/?server=netease&type=search&id=${encodeURIComponent(keywords)}`;
        case 'gdstudio':
          return `${api.baseUrl}?types=search&source=netease&name=${encodeURIComponent(keywords)}`;
        default:
          throw new Error('未知 API 类型');
      }
    });
  }

  // ========== 核心方法：获取播放链接 ==========
  async function getSongUrl(songId) {
    return requestWithFallback((api) => {
      switch (api.type) {
        case 'server':
          // GOATB-Server：现有 /api/v1/music/url（weapi 拿播放链接，返回 {url} 或 404）
          return `${api.baseUrl}/url?id=${songId}`;
        case 'tunehub':
          return `${api.baseUrl}/?source=netease&id=${songId}&type=url`;
        case 'gomusic':
          // go-music-api：智能换源，song/url 端点会自动匹配可播放替代音源
          return `${api.baseUrl}/song/url?id=${songId}`;
        case 'ncm':
          // NeteaseCloudMusicApiEnhanced：/song/url，配合 unblockmusic-utils 自动解灰
          return `${api.baseUrl}/song/url?id=${songId}${CONFIG.ncmCookie ? '&cookie=' + encodeURIComponent(CONFIG.ncmCookie) : ''}`;
        case 'meting':
          return `${api.baseUrl}/?server=netease&type=url&id=${songId}`;
        case 'gdstudio':
          return `${api.baseUrl}?types=url&source=netease&id=${songId}`;
        default:
          throw new Error('未知 API 类型');
      }
    });
  }

  // ========== 核心方法：获取歌手歌曲 ==========
  async function getArtistSongs(artistId) {
    return requestWithFallback((api) => {
      switch (api.type) {
        case 'server':
          // GOATB-Server：Task 41 新增 /api/v1/music/artist（weapi 歌手热门50首，返回 {songs}）
          return `${api.baseUrl}/artist?id=${artistId}`;
        case 'tunehub':
          return `${api.baseUrl}/?source=netease&id=${artistId}&type=artist`;
        case 'gomusic':
          // go-music-api：/artists/:id 或 /artist/songs
          return `${api.baseUrl}/artist/songs?id=${artistId}`;
        case 'ncm':
          // NeteaseCloudMusicApiEnhanced：/artist/songs
          return `${api.baseUrl}/artist/songs?id=${artistId}${CONFIG.ncmCookie ? '&cookie=' + encodeURIComponent(CONFIG.ncmCookie) : ''}`;
        case 'meting':
          return `${api.baseUrl}/?server=netease&type=artist&id=${artistId}`;
        case 'gdstudio':
          return `${api.baseUrl}?types=artist&source=netease&id=${artistId}`;
        default:
          throw new Error('未知 API 类型');
      }
    });
  }

  // ========== 核心方法：获取歌单 ==========
  async function getPlaylist(playlistId) {
    return requestWithFallback((api) => {
      switch (api.type) {
        case 'server':
          // GOATB-Server：现有 /api/v1/music/hot（热歌榜，作为同源歌单源）
          return `${api.baseUrl}/hot`;
        case 'tunehub':
          return `${api.baseUrl}/?source=netease&id=${playlistId}&type=playlist`;
        case 'gomusic':
          // go-music-api：/playlist/detail
          return `${api.baseUrl}/playlist/detail?id=${playlistId}`;
        case 'ncm':
          // NeteaseCloudMusicApiEnhanced：/playlist/detail
          return `${api.baseUrl}/playlist/detail?id=${playlistId}${CONFIG.ncmCookie ? '&cookie=' + encodeURIComponent(CONFIG.ncmCookie) : ''}`;
        case 'meting':
          return `${api.baseUrl}/?server=netease&type=playlist&id=${playlistId}`;
        case 'gdstudio':
          return `${api.baseUrl}?types=playlist&source=netease&id=${playlistId}`;
        default:
          throw new Error('未知 API 类型');
      }
    });
  }

  // ========== 防跳歌：批量预检可播放性（Task 40-2 换源 + Task 41 并发化）==========
  // Task 41 关键优化：串行 50 首 × 1-2s/首 = 30-100 秒预解析（体验崩坏）→
  // 改为 5 并发分批 + 上限 30 首 ≈ 6 秒完成；超出部分点播时按需换源（audio error 兜底）
  async function filterPlayableSongs(songList) {
    const playable = [];
    const list = (songList || []).slice(0, 30);               // 预检上限 30 首
    const CONCURRENCY = 5;                                     // 5 并发，避免打爆 API
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const batch = list.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (song) => {
        try {
          const url = await getPlayableUrl(song.id);
          if (url) {
            song.playUrl = url;                                // 附带 playUrl 供消费方直接使用
            return song;
          }
          console.warn(`[MusicAPI] 歌曲不可播放（全 API 换源失败），已过滤: ${song.name}`);
          return null;
        } catch (e) {
          console.warn(`[MusicAPI] 预检失败: ${song.name}`, e.message);
          return null;
        }
      }));
      for (const r of results) if (r) playable.push(r);
    }
    return playable;
  }

  // ========== Task 40-2 新增：歌曲级跨 API 自动换源 ==========
  // 遍历所有非 TODO 占位的 API，对单首歌逐一尝试 getSongUrl，第一个有效 url 即返回。
  // 关键：不污染主降级链 currentApiIndex（用本地 i 索引），不触发 music-api-all-fail 事件（那是 API 级全局失败的信号）。
  // 解决用户痛点："无版权/加V歌曲加载不出来直接跳下一首" —— 单首歌在 API A 拿不到 url 会去 API B 试，而不是跳过这首歌。
  async function getPlayableUrl(songId) {
    if (songId == null) return null;
    for (let i = 0; i < CONFIG.apiList.length; i++) {
      const api = CONFIG.apiList[i];
      if (isApiPlaceholder(api)) {
        console.warn(`[MusicAPI][换源] ${api.name} 未配置（TODO 占位），跳过`);
        continue;
      }
      try {
        // Task 41: server 类型特殊处理 —— 用 /url 接口预检可播性（VIP/下架返回 404 {url:null}），
        // 命中后返回同源 stream 流式代理路径（支持 Range seek，无 CORS/混合内容问题）
        if (api.type === 'server') {
          const endpoint = `${api.baseUrl}/url?id=${songId}`;
          const res = await fetchWithRetry(endpoint, {}, api.maxRetry, api.timeout);
          const data = await res.json();
          if (data && data.url) {
            console.log(`[MusicAPI][换源] 命中 ${api.name}（第${i + 1}优先级）: songId=${songId} → 同源 stream 代理`);
            return `/api/v1/music/stream/${songId}`;
          }
          console.warn(`[MusicAPI][换源] ${api.name} 无可用 url（VIP/下架），尝试下一 API: songId=${songId}`);
          continue;
        }
        const endpoint = buildSongUrlEndpoint(api, songId);
        const res = await fetchWithRetry(endpoint, {}, api.maxRetry, api.timeout);
        const data = await res.json();
        const url = parseSongUrl(data, api.type);
        if (isValidPlayableUrl(url)) {
          console.log(`[MusicAPI][换源] 命中 ${api.name}（第${i + 1}优先级）: songId=${songId}`);
          return url;                                            // 第一个有效 url 即返回
        }
        console.warn(`[MusicAPI][换源] ${api.name} 返回无效 url，尝试下一 API: songId=${songId}`);
      } catch (e) {
        console.warn(`[MusicAPI][换源] ${api.name} 异常:`, e.message);
      }
    }
    console.warn(`[MusicAPI][换源] 全部 API 均无有效 url: songId=${songId}`);
    return null;
  }

  // 预解析歌手歌曲：API 级降级拿原始列表 → normalizeSongs 统一格式 → filterPlayableSongs 预解析 playUrl
  // 返回 [{id, name, artist, playUrl, duration?}]，消费方拿到即可直接播放无需再查 url
  async function preResolveArtist(artistId) {
    const rawData = await getArtistSongs(artistId);
    // await 返回后立即同步快照当前 API 类型（无 await 间隔，单线程安全）
    const apiType = getCurrentApi().type;
    const songs = normalizeSongs(rawData, apiType);
    console.log(`[MusicAPI][预解析] 歌手 ${artistId} 原始 ${songs.length} 首，开始预检可播放性`);
    return await filterPlayableSongs(songs);
  }

  // 预解析歌单：API 级降级拿原始列表 → normalizeSongs 统一格式 → filterPlayableSongs 预解析 playUrl
  // 返回 [{id, name, artist, playUrl, duration?}]
  async function preResolvePlaylist(playlistId) {
    const rawData = await getPlaylist(playlistId);
    const apiType = getCurrentApi().type;
    const songs = normalizeSongs(rawData, apiType);
    console.log(`[MusicAPI][预解析] 歌单 ${playlistId} 原始 ${songs.length} 首，开始预检可播放性`);
    return await filterPlayableSongs(songs);
  }

  // ========== 暴露接口 ==========
  window.MusicAPI = {
    search,
    getSongUrl,
    getArtistSongs,
    getPlaylist,
    filterPlayableSongs,
    getCurrentApi: () => getCurrentApi().name,
    reset: () => {
      currentApiIndex = 0;
      consecutiveFailures = 0;
    },
    // Task 40-2 新增：歌曲级跨 API 换源 + 预解析 + 统一列表解析
    getPlayableUrl,                                              // (songId) => Promise<string|null>
    preResolveArtist,                                            // (artistId) => Promise<PlayableSong[]>
    preResolvePlaylist,                                          // (playlistId) => Promise<PlayableSong[]>
    normalizeSongs                                               // (rawData, apiType) => PlayableSong[]
  };

  console.log('[MusicAPI] 适配层已加载，当前 API:', getCurrentApi().name);
})();
