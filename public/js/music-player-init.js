// music-player-init.js - 左下角浮动图标音乐播放器
// Task 41：迁移重构——收起为小图标 / 展开为浮窗 / 拖拽 / 搜索 / 多榜单 tab
//
// 架构（Task 41）：
//   旧 React Modal（music-player-modal.tsx）已下线，菜单栏音乐入口已隐藏。
//   本播放器成为唯一音乐入口，左下角浮动：
//     - 收起态：52×52 圆形音乐图标，可拖拽，点击展开
//     - 展开态：320px 浮窗，含 tab（XCXY/飙升/新歌/热歌/原创）+ 搜索 + 列表 + 播放控件
//
// 数据流（全部同源服务端路由，无 CORS，最稳定）：
//   列表 → /api/v1/music/artist?id=123561221（小车 全部热门歌曲）
//        → /api/v1/music/toplist?id={榜单ID}（飙升/新歌/热歌/原创）
//        → /api/v1/music/search?keywords=xxx（网易云搜索）
//   播放 → /api/v1/music/stream/{songId}（服务端 weapi 直连，流式代理，dev 实测 206）
//   换源 → audio error 时 MusicAPI.getPlayableUrl 跨 API 换源（后备）
//
// 持久化：localStorage 存 收起态/拖拽位置/音量/当前tab，不存音频（版权底线，流式播放）
// 移动端：pointer 事件 + touch-action（none 在拖拽手柄/进度条，manipulation 在按钮）
// 暴露：window.MusicPlayer = { expand, collapse, toggle, play, next, prev, reset }
(function () {
  'use strict';

  var CONFIG = window.MUSIC_CONFIG || {};
  var STORAGE_COLLAPSED = 'mp-collapsed';
  var STORAGE_POS = 'music-player-pos';
  var STORAGE_VOL = 'music-player-volume';
  var STORAGE_TAB = 'mp-tab';

  // ========== 全局状态 ==========
  var state = {
    songs: [],              // 当前 tab 的歌曲列表 [{id,name,artist,cover,duration}]
    currentIndex: -1,
    isPlaying: false,
    collapsed: true,        // 默认收起为图标
    activeTab: 'xcxy',      // xcxy | surge | new | hot | original | search
    searchKeyword: '',
    loadingList: false,
    listError: '',
    unplayable: {},         // songId → true
    resolving: false,
    requestSeq: 0,          // PERF P0：列表请求代数（切 tab/搜索递增，过期响应丢弃）
    root: null,
    audio: null
  };

  // ========== 工具 ==========
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function fmtTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }
  function clampPos(x, y, w, h) {
    var maxX = window.innerWidth - w - 8;
    var maxY = window.innerHeight - h - 8;
    return {
      x: Math.max(8, Math.min(maxX, x)),
      y: Math.max(8, Math.min(maxY, y))
    };
  }
  function loadPos() {
    try {
      var raw = localStorage.getItem(STORAGE_POS);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) { /* ignore */ }
    return null;
  }
  function savePos(x, y) {
    try { localStorage.setItem(STORAGE_POS, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }
  function loadVolume() {
    try {
      var v = parseFloat(localStorage.getItem(STORAGE_VOL));
      if (!isNaN(v) && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return typeof CONFIG.playerVolume === 'number' ? CONFIG.playerVolume : 0.72;
  }
  function saveVolume(v) {
    try { localStorage.setItem(STORAGE_VOL, String(v)); } catch (e) {}
  }
  function loadCollapsed() {
    try { return localStorage.getItem(STORAGE_COLLAPSED) === '1'; } catch (e) { return true; }
  }
  function saveCollapsed(v) {
    try { localStorage.setItem(STORAGE_COLLAPSED, v ? '1' : '0'); } catch (e) {}
  }
  function loadTab() {
    try {
      var t = localStorage.getItem(STORAGE_TAB) || 'xcxy';
      // AU 审计修复（2026-11）：search 是伪 tab（搜索关键词不持久化），
      // 重载后恢复 search 只会得到空列表「暂无歌曲」——回退默认榜单。
      return t === 'search' ? 'xcxy' : t;
    } catch (e) { return 'xcxy'; }
  }
  function saveTab(v) {
    try { localStorage.setItem(STORAGE_TAB, v); } catch (e) {}
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ========== Tab 定义 ==========
  // 每个 tab 对应一个数据源（同源服务端路由）
  var TABS = [
    { id: 'xcxy',      name: '小车', url: '/api/v1/music/artist?id=' + (CONFIG.artistId || '123561221') },
    { id: 'surge',     name: '飙升', url: '/api/v1/music/toplist?id=19723756' },
    { id: 'new',       name: '新歌', url: '/api/v1/music/toplist?id=3779629' },
    { id: 'hot',       name: '热歌', url: '/api/v1/music/toplist?id=3778678' },
    { id: 'original',  name: '原创', url: '/api/v1/music/toplist?id=2884035' },
  ];

  // ========== 注入样式 ==========
  // FX-07 液态玻璃升级：金紫渐变外环 + 顶缘流光 + 分层高光 + safe-area + no-backdrop 兜底
  // 类名与 DOM 结构不变——纯视觉层重写，拖拽/播放/持久化逻辑零改动
  function injectStyle() {
    if (document.getElementById('mp-style')) return;
    var css = '' +
// ---- 收起态：液态玻璃圆钮 ----
'.mp-icon {' +
'  position: fixed; z-index: 9999; width: 52px; height: 52px; border-radius: 50%;' +
'  background: radial-gradient(120% 120% at 28% 22%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.02) 42%),' +
'              linear-gradient(140deg, rgba(32,32,38,0.66) 0%, rgba(52,46,66,0.58) 100%);' +
'  backdrop-filter: blur(22px) saturate(180%); -webkit-backdrop-filter: blur(22px) saturate(180%);' +
'  box-shadow: inset 0 1px 1px rgba(255,255,255,0.18), inset 0 -6px 12px rgba(0,0,0,0.22),' +
'              0 10px 28px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30);' +
'  display: flex; align-items: center; justify-content: center;' +
'  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;' +
'  transition: transform 180ms cubic-bezier(0.2,0.9,0.2,1), box-shadow 180ms ease;' +
'}' +
'/* 金紫渐变外环（conic + mask 挖空中心，液态玻璃 signature rim） */' +
'.mp-icon::before {' +
'  content: ""; position: absolute; inset: -1px; border-radius: 50%; padding: 1px;' +
'  background: conic-gradient(from 210deg, rgba(212,175,55,0.85), rgba(191,90,242,0.55), rgba(255,255,255,0.22), rgba(212,175,55,0.85));' +
'  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);' +
'  -webkit-mask-composite: xor; mask-composite: exclude;' +
'  pointer-events: none;' +
'}' +
'/* 顶部高光弧面（玻璃厚度的斜射反光） */' +
'.mp-icon::after {' +
'  content: ""; position: absolute; top: 5%; left: 16%; right: 16%; height: 34%;' +
'  border-radius: 50%;' +
'  background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0));' +
'  pointer-events: none;' +
'}' +
'.mp-icon:hover {' +
'  transform: translateY(-2px) scale(1.06);' +
'  box-shadow: inset 0 1px 1px rgba(255,255,255,0.22), inset 0 -6px 12px rgba(0,0,0,0.22),' +
'              0 14px 32px rgba(0,0,0,0.5), 0 0 18px rgba(212,175,55,0.28), 0 0 30px rgba(191,90,242,0.18);' +
'}' +
'.mp-icon:active { transform: scale(0.97); }' +
'.mp-icon.is-dragging { cursor: grabbing; transform: scale(1.02); transition: none; }' +
'.mp-icon-svg { width: 24px; height: 24px; color: rgba(255,255,255,0.92); position: relative; z-index: 1;' +
'  filter: drop-shadow(0 0 6px rgba(212,175,55,0.35)); }' +
'.mp-icon-pulse {' +
'  position: absolute; top: 3px; right: 3px; width: 9px; height: 9px; border-radius: 50%; z-index: 2;' +
'  background: radial-gradient(circle at 35% 35%, #E080FF, #BF5AF2 62%);' +
'  box-shadow: 0 0 10px rgba(191,90,242,0.95), 0 0 4px rgba(255,255,255,0.6);' +
'  animation: mp-pulse 1.4s ease-in-out infinite;' +
'}' +
'@keyframes mp-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }' +
// ---- 展开态：液态玻璃浮窗 ----
'.mp-root {' +
'  position: fixed; z-index: 9999; width: 320px; max-width: calc(100vw - 24px);' +
'  background: radial-gradient(140% 90% at 50% -8%, rgba(191,90,242,0.10) 0%, rgba(191,90,242,0) 46%),' +
'              linear-gradient(150deg, rgba(28,28,32,0.78) 0%, rgba(40,38,50,0.72) 55%, rgba(30,30,36,0.76) 100%);' +
'  backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%);' +
'  border: 1px solid rgba(255,255,255,0.13); border-radius: 18px;' +
'  box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.22),' +
'              0 24px 56px -12px rgba(0,0,0,0.6), 0 6px 18px rgba(0,0,0,0.4),' +
'              0 0 42px rgba(191,90,242,0.07);' +
'  color: rgba(255,255,255,0.86); overflow: hidden; user-select: none; -webkit-user-select: none;' +
'  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;' +
'  font-size: 12px;' +
'}' +
'/* 顶缘流光线（金紫 signature gleam，与站内 .liquid-glass::before 同语言） */' +
'.mp-root::before {' +
'  content: ""; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; z-index: 1;' +
'  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55) 30%, rgba(212,175,55,0.45) 50%, rgba(255,255,255,0.55) 70%, transparent);' +
'  pointer-events: none;' +
'}' +
'.mp-header {' +
'  display: flex; align-items: center; justify-content: space-between;' +
'  padding: 10px 14px; cursor: grab; touch-action: none;' +
'  background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0));' +
'  border-bottom: 1px solid rgba(255,255,255,0.07);' +
'}' +
'.mp-header.is-dragging { cursor: grabbing; }' +
'.mp-title {' +
'  font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: rgba(255,255,255,0.92);' +
'  display: flex; align-items: center; gap: 6px;' +
'}' +
'.mp-title-dot {' +
'  width: 7px; height: 7px; border-radius: 50%;' +
'  background: radial-gradient(circle at 35% 35%, #E080FF, #BF5AF2 62%);' +
'  box-shadow: 0 0 8px rgba(191,90,242,0.75);' +
'}' +
'.mp-header-btns { display: flex; align-items: center; gap: 2px; }' +
'.mp-toggle {' +
'  background: transparent; border: none; color: rgba(255,255,255,0.55);' +
'  font-size: 18px; line-height: 1; padding: 4px 6px; cursor: pointer;' +
'  touch-action: manipulation; border-radius: 6px;' +
'}' +
'.mp-toggle:hover { color: rgba(255,255,255,0.95); background: rgba(255,255,255,0.06); }' +
// ---- Tab 栏 ----
'.mp-tabs {' +
'  display: flex; gap: 2px; padding: 6px 10px; overflow-x: auto; overscroll-behavior: contain;' +
'  border-bottom: 1px solid rgba(255,255,255,0.04);' +
'  scrollbar-width: none;' +
'}' +
'.mp-tabs::-webkit-scrollbar { display: none; }' +
'.mp-tab {' +
'  flex-shrink: 0; padding: 5px 10px; border-radius: 8px; font-size: 11px; font-weight: 500;' +
'  color: rgba(255,255,255,0.55); background: transparent; border: none; cursor: pointer;' +
'  touch-action: manipulation; white-space: nowrap; transition: all 140ms ease;' +
'}' +
'.mp-tab:hover { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.04); }' +
'.mp-tab.is-active {' +
'  color: #fff; background: linear-gradient(135deg, rgba(191,90,242,0.28), rgba(191,90,242,0.16));' +
'  box-shadow: inset 0 0 0 1px rgba(191,90,242,0.38), inset 0 1px 0 rgba(255,255,255,0.10);' +
'}' +
// ---- 键盘可达性（金色 focus 环，站内金 #D4AF37） ----
'.mp-tab:focus-visible, .mp-btn:focus-visible, .mp-search-btn:focus-visible, .mp-toggle:focus-visible {' +
'  outline: 2px solid rgba(212,175,55,0.75); outline-offset: 2px;' +
'}' +
// ---- 搜索行 ----
'.mp-search { padding: 6px 10px 8px; display: flex; gap: 6px; }' +
'.mp-search-input {' +
'  flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);' +
'  border-radius: 8px; padding: 6px 10px; color: rgba(255,255,255,0.9); font-size: 11px;' +
'  outline: none; touch-action: manipulation;' +
'}' +
'.mp-search-input::placeholder { color: rgba(255,255,255,0.35); }' +
'.mp-search-input:focus { border-color: rgba(191,90,242,0.5); background: rgba(255,255,255,0.08); }' +
'.mp-search-btn {' +
'  flex-shrink: 0; padding: 6px 12px; border-radius: 8px; font-size: 11px; font-weight: 500;' +
'  background: rgba(191,90,242,0.2); color: #D977FF; border: 1px solid rgba(191,90,242,0.3);' +
'  cursor: pointer; touch-action: manipulation; transition: background 120ms ease;' +
'}' +
'.mp-search-btn:hover { background: rgba(191,90,242,0.3); }' +
'.mp-search-btn:disabled { opacity: 0.4; cursor: not-allowed; }' +
// ---- 列表 ----
'.mp-list-wrap { max-height: 220px; overflow: hidden; }' +
'.mp-list {' +
'  max-height: 220px; overflow-y: auto; overscroll-behavior: contain;' +
'  touch-action: pan-y; padding: 4px 0;' +
'}' +
'.mp-list::-webkit-scrollbar { width: 4px; }' +
'.mp-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }' +
'.mp-item {' +
'  display: flex; align-items: center; padding: 7px 14px; cursor: pointer;' +
'  touch-action: manipulation; gap: 8px; transition: background 100ms ease;' +
'}' +
'.mp-item:hover { background: rgba(255,255,255,0.05); }' +
'.mp-item.is-current { background: rgba(191,90,242,0.14); }' +
'.mp-item-index {' +
'  font-size: 10px; color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums;' +
'  width: 20px; text-align: right; flex-shrink: 0;' +
'}' +
'.mp-item.is-current .mp-item-index { color: #D977FF; }' +
'.mp-item-name {' +
'  flex: 1; font-size: 11px; color: rgba(255,255,255,0.78);' +
'  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
'}' +
'.mp-item.is-current .mp-item-name { color: #fff; font-weight: 600; }' +
'.mp-item-artist { font-size: 10px; color: rgba(255,255,255,0.4); flex-shrink: 0; max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
'.mp-item-bad { font-size: 9px; color: rgba(255,90,90,0.8); flex-shrink: 0; }' +
'.mp-empty { padding: 24px 14px; text-align: center; color: rgba(255,255,255,0.4); font-size: 11px; }' +
'.mp-loading { padding: 20px 14px; text-align: center; color: rgba(255,255,255,0.5); font-size: 11px; }' +
'.mp-spin { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #D977FF; border-radius: 50%; animation: mp-spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }' +
'@keyframes mp-spin { to { transform: rotate(360deg); } }' +
// ---- 底部播放区 ----
'.mp-footer { border-top: 1px solid rgba(255,255,255,0.06); padding: 10px 14px 12px; }' +
'.mp-now { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-height: 32px; }' +
'.mp-cover {' +
'  width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; overflow: hidden;' +
'  background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center;' +
'  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);' +
'}' +
'.mp-cover img { width: 100%; height: 100%; object-fit: cover; }' +
'.mp-cover-icon { font-size: 16px; color: rgba(255,255,255,0.3); }' +
'.mp-info { flex: 1; min-width: 0; }' +
'.mp-song {' +
'  font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.95);' +
'  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
'}' +
'.mp-artist {' +
'  font-size: 10px; color: rgba(255,255,255,0.45); margin-top: 1px;' +
'  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
'}' +
'.mp-progress { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }' +
'.mp-time {' +
'  font-size: 10px; color: rgba(255,255,255,0.45); font-variant-numeric: tabular-nums;' +
'  min-width: 32px; text-align: center; flex-shrink: 0;' +
'}' +
'.mp-bar {' +
'  position: relative; flex: 1; height: 4px; background: rgba(255,255,255,0.1);' +
'  border-radius: 2px; cursor: pointer; touch-action: none;' +
'}' +
'.mp-bar-fill {' +
'  position: absolute; left: 0; top: 0; bottom: 0;' +
'  background: linear-gradient(90deg, #BF5AF2, #D977FF); border-radius: 2px; width: 0%;' +
'  box-shadow: 0 0 6px rgba(191,90,242,0.45);' +
'}' +
'.mp-bar-thumb {' +
'  position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 50%;' +
'  background: #fff; transform: translate(-50%, -50%);' +
'  box-shadow: 0 0 6px rgba(191,90,242,0.7); pointer-events: none;' +
'}' +
'.mp-controls { display: flex; align-items: center; gap: 6px; }' +
'.mp-btn {' +
'  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);' +
'  color: rgba(255,255,255,0.85); width: 30px; height: 30px; border-radius: 50%;' +
'  cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center;' +
'  padding: 0; touch-action: manipulation; transition: background 120ms ease, transform 120ms ease;' +
'}' +
'.mp-btn:hover { background: rgba(255,255,255,0.12); }' +
'.mp-btn:active { transform: scale(0.92); }' +
'.mp-btn.mp-btn-primary {' +
'  width: 38px; height: 38px;' +
'  background: linear-gradient(140deg, #C96BF5 0%, #BF5AF2 45%, #9B4DCA 100%);' +
'  border-color: rgba(233,168,255,0.5);' +
'  box-shadow: 0 0 14px rgba(191,90,242,0.45), inset 0 1px 0 rgba(255,255,255,0.35); font-size: 13px;' +
'}' +
'.mp-btn.mp-btn-primary:hover { background: linear-gradient(140deg, #D07DF8 0%, #C96BF5 45%, #AB5DD8 100%); }' +
'.mp-spacer { flex: 1; }' +
'.mp-vol-icon { font-size: 12px; color: rgba(255,255,255,0.5); width: 16px; text-align: center; flex-shrink: 0; }' +
'.mp-hidden { display: none !important; }' +
// ---- 无 backdrop-filter 环境（老 Android WebView 等）：提高不透明度兜底 ----
'@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {' +
'  .mp-icon { background: linear-gradient(140deg, rgba(34,34,40,0.97), rgba(52,48,64,0.95)); }' +
'  .mp-root { background: linear-gradient(150deg, rgba(30,30,36,0.98), rgba(42,40,52,0.97)); }' +
'}' +
// ---- 小屏适配 ----
'@media (max-width: 400px) {' +
'  .mp-root { border-radius: 16px; }' +
'}' +
'@media (prefers-reduced-motion: reduce) {' +
'  .mp-icon, .mp-btn, .mp-tab { transition: none !important; }' +
'  .mp-icon:hover { transform: none; }' +
'  .mp-icon-pulse { animation: none !important; }' +
'}';
    var style = document.createElement('style');
    style.id = 'mp-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ========== 数据获取（同源服务端路由，无 CORS）==========
  // 统一规范化为 {id, name, artist, cover, duration}
  function normalizeSongs(data) {
    var songs = (data && data.songs) || [];
    return songs.map(function (s) {
      return {
        id: Number(s.id),
        name: s.name || '未知',
        artist: s.artists || '未知歌手',
        cover: s.cover || '',
        duration: Number(s.duration) || 0
      };
    }).filter(function (s) { return s.id > 0; });
  }

  function fetchList(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) { return normalizeSongs(data); })
      .catch(function (e) {
        console.warn('[Player] fetchList 失败:', url, e && e.message);
        return [];
      });
  }

  function loadTabData(tabId) {
    state.activeTab = tabId;
    saveTab(tabId);
    state.loadingList = true;
    state.listError = '';
    // PERF P0：代数令牌——快速切 tab/连续搜索时，旧 fetch 响应回来直接丢弃，
    // 防止慢响应覆盖新 tab 的列表（UI 与 tab 错位竞态）
    var seq = ++state.requestSeq;
    renderList();
    renderTabs();

    var url;
    if (tabId === 'search') {
      if (!state.searchKeyword) {
        state.loadingList = false;
        state.songs = [];
        renderList();
        return;
      }
      url = '/api/v1/music/search?keywords=' + encodeURIComponent(state.searchKeyword) + '&limit=30';
    } else {
      var tab = TABS.filter(function (t) { return t.id === tabId; })[0];
      if (!tab) return;
      url = tab.url;
    }

    fetchList(url).then(function (songs) {
      if (seq !== state.requestSeq) return;  // 过期响应（期间用户已切走）→ 丢弃
      // 小车 tab：歌手名统一显示为「小车」（网易云返回的是合作艺人长串）
      if (tabId === 'xcxy') {
        songs = songs.map(function (s) {
          return { id: s.id, name: s.name, artist: '小车', cover: s.cover, duration: s.duration };
        });
      }
      state.songs = songs;
      state.loadingList = false;
      state.currentIndex = -1;
      state.unplayable = {};
      renderList();
      updateInfo();
      if (!songs.length) {
        state.listError = tabId === 'search' ? '未找到相关歌曲' : '暂无歌曲数据';
        renderList();
      }
    });
  }

  // ========== DOM 构建 ==========
  function svgIcon(name) {
    var icons = {
      music: '<svg class="mp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    };
    return icons[name] || '';
  }

  function buildIconDOM() {
    var icon = document.createElement('div');
    icon.className = 'mp-icon';
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', '展开音乐播放器');
    icon.innerHTML = svgIcon('music') + '<span class="mp-icon-pulse mp-hidden" data-mp-pulse></span>';
    document.body.appendChild(icon);
    return icon;
  }

  function buildRootDOM() {
    var root = document.createElement('div');
    root.className = 'mp-root mp-hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '音乐播放器');
    var tabsHtml = TABS.map(function (t) {
      return '<button class="mp-tab" data-mp-tab="' + t.id + '" type="button">' + escapeHtml(t.name) + '</button>';
    }).join('');
    root.innerHTML =
      '<div class="mp-header" data-mp-drag>' +
        '<span class="mp-title"><span class="mp-title-dot"></span>音乐</span>' +
        '<div class="mp-header-btns">' +
          '<button class="mp-toggle" data-mp-collapse type="button" aria-label="收起为图标" title="收起为图标">−</button>' +
        '</div>' +
      '</div>' +
      '<div class="mp-tabs" data-mp-tabs>' + tabsHtml + '</div>' +
      '<div class="mp-search">' +
        '<input class="mp-search-input" data-mp-search-input type="text" placeholder="搜索网易云音乐..." aria-label="搜索关键词" />' +
        '<button class="mp-search-btn" data-mp-search-btn type="button">搜索</button>' +
      '</div>' +
      '<div class="mp-list-wrap"><div class="mp-list" data-mp-list></div></div>' +
      '<div class="mp-footer">' +
        '<div class="mp-now">' +
          '<div class="mp-cover" data-mp-cover><span class="mp-cover-icon">♪</span></div>' +
          '<div class="mp-info">' +
            '<div class="mp-song" data-mp-song>—</div>' +
            '<div class="mp-artist" data-mp-artist>未播放</div>' +
          '</div>' +
        '</div>' +
        '<div class="mp-progress">' +
          '<span class="mp-time" data-mp-cur>0:00</span>' +
          '<div class="mp-bar" data-mp-seek>' +
            '<div class="mp-bar-fill" data-mp-seek-fill></div>' +
            '<div class="mp-bar-thumb" data-mp-seek-thumb style="left:0%"></div>' +
          '</div>' +
          '<span class="mp-time" data-mp-dur>0:00</span>' +
        '</div>' +
        '<div class="mp-controls">' +
          '<button class="mp-btn" data-mp-prev type="button" aria-label="上一首">◀</button>' +
          '<button class="mp-btn mp-btn-primary" data-mp-play type="button" aria-label="播放">▶</button>' +
          '<button class="mp-btn" data-mp-next type="button" aria-label="下一首">▶</button>' +
          '<span class="mp-spacer"></span>' +
          '<span class="mp-vol-icon" data-mp-vol-icon>🔊</span>' +
          '<div class="mp-bar" data-mp-vol style="width:60px;">' +
            '<div class="mp-bar-fill" data-mp-vol-fill></div>' +
            '<div class="mp-bar-thumb" data-mp-vol-thumb style="left:100%"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    state.audio = new Audio();
    state.audio.preload = 'metadata';
    state.audio.volume = loadVolume();
    return root;
  }

  // ========== 位置恢复 ==========
  function restorePosition(el, isIcon) {
    var saved = loadPos();
    var w = isIcon ? 52 : 320;
    var h = el.offsetHeight || (isIcon ? 52 : 480);
    if (saved) {
      var clamped = clampPos(saved.x, saved.y, w, h);
      el.style.left = clamped.x + 'px';
      el.style.top = clamped.y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    } else {
      // 默认左下角（safe-area：iOS 底部小黑条不压住浮窗）
      el.style.left = '20px';
      el.style.right = 'auto';
      el.style.bottom = 'calc(16px + env(safe-area-inset-bottom, 0px))';
      el.style.top = 'auto';
    }
  }

  // ========== 渲染 ==========
  function renderTabs() {
    $all('[data-mp-tab]', state.root).forEach(function (btn) {
      var isActive = btn.getAttribute('data-mp-tab') === state.activeTab;
      btn.classList.toggle('is-active', isActive);
    });
    // 搜索 tab 是动态的，不在 TABS 里——当 activeTab=search 时高亮搜索按钮态
    var searchBtn = $('[data-mp-search-btn]', state.root);
    if (searchBtn) searchBtn.style.opacity = state.activeTab === 'search' ? '1' : '0.7';
  }

  function renderList() {
    var list = $('[data-mp-list]', state.root);
    if (!list) return;
    if (state.loadingList) {
      list.innerHTML = '<div class="mp-loading"><span class="mp-spin"></span>加载中...</div>';
      return;
    }
    if (state.listError && !state.songs.length) {
      list.innerHTML = '<div class="mp-empty">' + escapeHtml(state.listError) + '</div>';
      return;
    }
    if (!state.songs.length) {
      list.innerHTML = '<div class="mp-empty">暂无歌曲</div>';
      return;
    }
    var html = state.songs.map(function (s, i) {
      var cur = i === state.currentIndex ? ' is-current' : '';
      var bad = state.unplayable[s.id] ? '<span class="mp-item-bad" title="不可播放">✕</span>' : '';
      var dur = s.duration ? ' <span style="color:rgba(255,255,255,0.3);font-size:9px;">' + fmtTime(s.duration / 1000) + '</span>' : '';
      return '<div class="mp-item' + cur + '" data-mp-item="' + i + '">' +
        '<span class="mp-item-index">' + (i + 1) + '</span>' +
        '<span class="mp-item-name">' + escapeHtml(s.name) + dur + '</span>' +
        '<span class="mp-item-artist">' + escapeHtml(s.artist) + '</span>' +
        bad +
      '</div>';
    }).join('');
    list.innerHTML = html;
    $all('[data-mp-item]', list).forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.getAttribute('data-mp-item'), 10);
        play(idx);
      });
    });
  }

  function updateInfo() {
    var song = state.currentIndex >= 0 ? state.songs[state.currentIndex] : null;
    $('[data-mp-song]', state.root).textContent = song ? song.name : (state.songs.length ? '—' : '未选择歌曲');
    $('[data-mp-artist]', state.root).textContent = song ? song.artist : (state.songs.length ? '选择一首播放' : '暂无歌曲');
    // 封面
    var cover = $('[data-mp-cover]', state.root);
    if (song && song.cover) {
      cover.innerHTML = '<img src="' + escapeHtml(song.cover) + '" alt="" />';
    } else {
      cover.innerHTML = '<span class="mp-cover-icon">♪</span>';
    }
    var playBtn = $('[data-mp-play]', state.root);
    playBtn.textContent = state.isPlaying ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', state.isPlaying ? '暂停' : '播放');
    // 收起态脉冲
    var pulse = $('[data-mp-pulse]');
    if (pulse) pulse.classList.toggle('mp-hidden', !state.isPlaying);
  }

  function updateProgress() {
    var a = state.audio;
    var cur = a.currentTime || 0;
    var dur = a.duration || 0;
    $('[data-mp-cur]', state.root).textContent = fmtTime(cur);
    $('[data-mp-dur]', state.root).textContent = fmtTime(dur);
    var pct = dur > 0 ? (cur / dur) * 100 : 0;
    $('[data-mp-seek-fill]', state.root).style.width = pct + '%';
    $('[data-mp-seek-thumb]', state.root).style.left = pct + '%';
  }

  function updateVolume() {
    var v = state.audio.volume;
    $('[data-mp-vol-fill]', state.root).style.width = (v * 100) + '%';
    $('[data-mp-vol-thumb]', state.root).style.left = (v * 100) + '%';
    $('[data-mp-vol-icon]', state.root).textContent = v === 0 ? '🔇' : (v < 0.5 ? '🔉' : '🔊');
  }

  // ========== 播放控制 ==========
  function play(idx) {
    if (!state.songs.length) return;
    if (idx < 0 || idx >= state.songs.length) return;
    var song = state.songs[idx];
    if (state.unplayable[song.id]) {
      return nextAvailable(idx);
    }
    state.currentIndex = idx;
    state.isPlaying = false;
    // 直接用 stream 路由（dev 实测 206，最稳定）
    var streamUrl = '/api/v1/music/stream/' + song.id;
    state.audio.src = streamUrl;
    state.audio.play().then(function () {
      state.isPlaying = true;
      updateInfo();
      renderList();
    }).catch(function (err) {
      console.warn('[Player] 播放启动失败:', song.name, err && err.message);
      // autoplay 策略可能拒绝，等 error 事件换源
    });
    updateInfo();
    renderList();
  }

  function next() {
    if (!state.songs.length) return;
    var n = (state.currentIndex + 1) % state.songs.length;
    play(n);
  }
  function prev() {
    if (!state.songs.length) return;
    var p = (state.currentIndex - 1 + state.songs.length) % state.songs.length;
    play(p);
  }

  // 跳过不可播放，找下一首可播放
  function nextAvailable(fromIdx) {
    if (!state.songs.length) return;
    var n = state.songs.length;
    for (var step = 1; step <= n; step++) {
      var i = (fromIdx + step) % n;
      var s = state.songs[i];
      if (!state.unplayable[s.id]) {
        play(i);
        return;
      }
    }
    state.currentIndex = -1;
    state.isPlaying = false;
    try { state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load(); } catch (e) {}  // PERF P1: load() 强制 abort 流请求
    updateInfo();
    renderList();
    console.warn('[Player] 全部歌曲不可播放');
  }

  function togglePlay() {
    if (state.currentIndex < 0) {
      if (state.songs.length) play(0);
      return;
    }
    if (state.audio.paused) {
      state.audio.play().then(function () {
        state.isPlaying = true;
        updateInfo();
      }).catch(function (err) {
        console.warn('[Player] 继续播放失败:', err && err.message);
      });
    } else {
      state.audio.pause();
      state.isPlaying = false;
      updateInfo();
    }
  }

  // ========== 失效换源（audio error 事件触发）==========
  function handleAudioError() {
    if (state.resolving) return;
    var song = state.songs[state.currentIndex];
    if (!song) return;
    state.resolving = true;
    console.warn('[Player] 音频错误，尝试换源:', song.name);

    // 后备：MusicAPI.getPlayableUrl 跨 API 换源
    if (window.MusicAPI && typeof window.MusicAPI.getPlayableUrl === 'function') {
      window.MusicAPI.getPlayableUrl(song.id).then(function (newUrl) {
        state.resolving = false;
        if (newUrl && newUrl.indexOf('stream/') < 0) {
          // 拿到不同源 URL 才换（避免重复 stream 路由）
          state.audio.src = newUrl;
          state.audio.play().then(function () {
            state.isPlaying = true;
            updateInfo();
            renderList();
          }).catch(function () {
            state.unplayable[song.id] = true;
            nextAvailable(state.currentIndex);
          });
          return;
        }
        // 换源无新 URL → 标记不可播放并跳下一首
        state.unplayable[song.id] = true;
        nextAvailable(state.currentIndex);
      }).catch(function (e) {
        state.resolving = false;
        console.warn('[Player] 换源异常:', e && e.message);
        state.unplayable[song.id] = true;
        nextAvailable(state.currentIndex);
      });
    } else {
      state.resolving = false;
      state.unplayable[song.id] = true;
      nextAvailable(state.currentIndex);
    }
  }

  // ========== 拖拽（pointer 事件，click vs drag 阈值区分）==========
  function bindDrag(el, opts) {
    opts = opts || {};
    var handle = opts.handle || el;
    var dragging = false;
    var moved = false;
    var startX = 0, startY = 0, origX = 0, origY = 0;
    var DRAG_THRESHOLD = 5;

    handle.addEventListener('pointerdown', function (e) {
      // 不挡按钮点击
      if (e.target.closest('[data-mp-collapse]') || e.target.closest('[data-mp-play]') ||
          e.target.closest('[data-mp-prev]') || e.target.closest('[data-mp-next]') ||
          e.target.closest('[data-mp-tab]') || e.target.closest('[data-mp-search-btn]') ||
          e.target.closest('[data-mp-search-input]') || e.target.closest('[data-mp-item]') ||
          e.target.closest('[data-mp-seek]') || e.target.closest('[data-mp-vol]')) {
        return;
      }
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      var rect = el.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      el.style.left = origX + 'px';
      el.style.top = origY + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      handle.classList.add('is-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      var w = el.offsetWidth, h = el.offsetHeight;
      var clamped = clampPos(origX + dx, origY + dy, w, h);
      el.style.left = clamped.x + 'px';
      el.style.top = clamped.y + 'px';
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      var rect = el.getBoundingClientRect();
      savePos(rect.left, rect.top);
      publishZone();  // 拖拽落点变了，重算胶囊避让占位
      // 未移动 = 点击：触发 onClick（图标点击展开 / 浮窗 header 不触发）
      if (!moved && typeof opts.onClick === 'function') {
        opts.onClick(e);
      }
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ========== 进度/音量条 ==========
  function bindBar(barEl, onChange) {
    var active = false;
    function apply(e) {
      var rect = barEl.getBoundingClientRect();
      var r = (e.clientX - rect.left) / rect.width;
      r = Math.max(0, Math.min(1, r));
      onChange(r);
    }
    barEl.addEventListener('pointerdown', function (e) {
      active = true;
      try { barEl.setPointerCapture(e.pointerId); } catch (_) {}
      apply(e);
      e.preventDefault();
      e.stopPropagation();
    });
    barEl.addEventListener('pointermove', function (e) {
      if (!active) return;
      apply(e);
    });
    function end(e) {
      active = false;
      try { barEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    barEl.addEventListener('pointerup', end);
    barEl.addEventListener('pointercancel', end);
  }

  // ========== 收起 / 展开 ==========
  // —— 布局协作：发布底部占位（导航胶囊避让）——
  // 把当前可见形态（展开浮窗 / 收起圆钮）的底部占位高度（距视口底缘）
  // 发布到 :root 的 --mp-zone-h，供桌面导航胶囊
  // （.nav-capsule-desktop-wrap 的 bottom: var(--mp-zone-h)）
  // 在「页头 → 播放器顶缘」的净空区内垂直居中，不再被本面板遮住下半段。
  // 仅当面板横带与胶囊相交（默认左下角）且停靠在视口下部 30% 以下时发布；
  // 拖离左轨 / 顶到上部时不占位，胶囊恢复全高居中。
  function publishZone() {
    var el = null;
    if (state.root && !state.root.classList.contains('mp-hidden')) el = state.root;
    else if (state.icon && !state.icon.classList.contains('mp-hidden')) el = state.icon;
    var h = 0;
    if (el) {
      var r = el.getBoundingClientRect();
      if (r.height > 0 && r.top >= innerHeight * 0.3) {
        var cap = document.querySelector('.nav-capsule-desktop');
        var capR = cap ? cap.getBoundingClientRect() : null;
        var inRailBand = capR ? (r.left < capR.right && r.right > capR.left) : (r.left < 360);
        if (inRailBand) h = Math.max(0, innerHeight - r.top + 16);
      }
    }
    document.documentElement.style.setProperty('--mp-zone-h', h + 'px');
  }
  function expand() {
    state.collapsed = false;
    saveCollapsed(false);
    if (state.icon) state.icon.classList.add('mp-hidden');
    if (state.root) state.root.classList.remove('mp-hidden');
    publishZone();
  }
  function collapse() {
    state.collapsed = true;
    saveCollapsed(true);
    if (state.root) state.root.classList.add('mp-hidden');
    if (state.icon) state.icon.classList.remove('mp-hidden');
    publishZone();
  }
  function toggle() {
    if (state.collapsed) expand(); else collapse();
  }

  // ========== 控件绑定 ==========
  function bindControls() {
    // Tab 切换
    $all('[data-mp-tab]', state.root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tabId = btn.getAttribute('data-mp-tab');
        loadTabData(tabId);
      });
    });
    // 搜索
    var searchInput = $('[data-mp-search-input]', state.root);
    var searchBtn = $('[data-mp-search-btn]', state.root);
    function doSearch() {
      var kw = (searchInput.value || '').trim();
      if (!kw) return;
      state.searchKeyword = kw;
      state.activeTab = 'search';
      loadTabData('search');
    }
    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSearch();
    });
    // 播放控件
    $('[data-mp-play]', state.root).addEventListener('click', togglePlay);
    $('[data-mp-prev]', state.root).addEventListener('click', prev);
    $('[data-mp-next]', state.root).addEventListener('click', next);
    $('[data-mp-collapse]', state.root).addEventListener('click', collapse);
    // 进度 / 音量
    bindBar($('[data-mp-seek]', state.root), function (r) {
      if (state.audio.duration) {
        state.audio.currentTime = r * state.audio.duration;
        updateProgress();
      }
    });
    bindBar($('[data-mp-vol]', state.root), function (r) {
      state.audio.volume = r;
      saveVolume(r);
      updateVolume();
    });
    // audio 事件
    state.audio.addEventListener('timeupdate', updateProgress);
    state.audio.addEventListener('loadedmetadata', updateProgress);
    state.audio.addEventListener('play', function () { state.isPlaying = true; updateInfo(); });
    state.audio.addEventListener('pause', function () { state.isPlaying = false; updateInfo(); });
    state.audio.addEventListener('ended', next);
    state.audio.addEventListener('error', function () {
      if (state.audio.src) handleAudioError();
    });
  }

  // ========== 全部失败处理 ==========
  function handleAllFail() {
    console.warn('[Player] 所有 API 失败（music-api-all-fail 事件）');
    // 不隐藏播放器——服务端路由可能仍可用，仅标记
  }

  // ========== 初始化 ==========
  function initPlayer() {
    injectStyle();
    state.icon = buildIconDOM();
    state.root = buildRootDOM();
    restorePosition(state.icon, true);
    restorePosition(state.root, false);

    // 拖拽绑定
    bindDrag(state.icon, { handle: state.icon, onClick: expand });
    bindDrag(state.root, { handle: $('[data-mp-drag]', state.root) });

    bindControls();
    updateVolume();
    updateProgress();
    renderTabs();

    // 全部失败监听
    // PERF P1：先移除旧监听再绑定（幂等）——reset() 会重跑 initPlayer，
    // 否则每次 reset 堆一个 window 级监听器（泄漏 + handleAllFail 重复执行）
    window.removeEventListener('music-api-all-fail', handleAllFail);
    window.addEventListener('music-api-all-fail', handleAllFail);

    // 视口变化 → 重算底部占位（幂等绑定，防 reset() 堆叠）
    window.removeEventListener('resize', publishZone);
    window.addEventListener('resize', publishZone);

    // 面板自身尺寸变化（列表异步加载撑高、tab 切换）→ 重算占位。
    // 若只靠 init 时发布一次，量到的是未加载内容的矮面板，
    // 内容撑高后胶囊会重新被遮住 —— 必须持续跟踪。
    if (typeof ResizeObserver !== 'undefined') {
      if (!state._mpRO) state._mpRO = new ResizeObserver(publishZone);
      state._mpRO.disconnect();
      if (state.root) state._mpRO.observe(state.root);
      if (state.icon) state._mpRO.observe(state.icon);
    }

    // 恢复收起态
    state.collapsed = loadCollapsed();
    if (state.collapsed) {
      state.root.classList.add('mp-hidden');
      state.icon.classList.remove('mp-hidden');
    } else {
      state.icon.classList.add('mp-hidden');
      state.root.classList.remove('mp-hidden');
    }
    publishZone();  // 初始占位（含 localStorage 恢复的展开态/拖拽位）

    // 恢复 tab 并加载数据
    var savedTab = loadTab();
    state.activeTab = savedTab;
    loadTabData(savedTab);

    updateInfo();
    console.log('[Player] 初始化完成，收起态:', state.collapsed, '当前 tab:', state.activeTab);
  }

  // ========== 启动 ==========
  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPlayer);
    } else {
      initPlayer();
    }
  }

  boot();

  // 暴露接口
  window.MusicPlayer = {
    expand: expand,
    collapse: collapse,
    toggle: toggle,
    play: function (idx) { if (typeof idx === 'number') play(idx); else togglePlay(); },
    next: function () { next(); },
    prev: function () { prev(); },
    loadTab: loadTabData,
    search: function (kw) {
      var input = $('[data-mp-search-input]', state.root);
      if (input) input.value = kw;
      state.searchKeyword = kw;
      if (state.collapsed) expand();
      loadTabData('search');
    },
    reset: function () {
      state.songs = [];
      state.currentIndex = -1;
      state.isPlaying = false;
      state.unplayable = {};
      state.resolving = false;
      try { if (state.audio) { state.audio.pause(); state.audio.removeAttribute('src'); state.audio.load(); } } catch (e) {}  // PERF P1: load() 强制 abort
      if (state.root) state.root.remove();
      if (state.icon) state.icon.remove();
      state.root = null;
      state.icon = null;
      state.audio = null;
      initPlayer();
    },
    getCurrentApi: function () { return window.MusicAPI && window.MusicAPI.getCurrentApi ? window.MusicAPI.getCurrentApi() : 'GOATB-Server'; }
  };
})();
