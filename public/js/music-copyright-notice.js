// music-copyright-notice.js - 自动生成版权声明
// 集成自用户提供的音乐播放器方案（Task 38）
//
// ⚠️ 项目铁律适配（Task 38 调整）：
// 原方案为 position:fixed; bottom:0，会覆盖项目 sticky footer（mt-auto 铁律）。
// 本版改为：优先注入到 <footer> 内部作为其子元素（static 布局，随 footer 自然流动），
// footer 未渲染时轮询 3 秒，超时才回退到 fixed bottom（且 bottom 偏移避开 footer）。
// 这样既保留版权声明，又不破坏 sticky footer 铁律。
(function() {
  'use strict';

  // footer 内嵌版样式：匹配项目 footer 的 10px / 白色低透明 风格但更小
  const INLINE_STYLE = `
    width: 100%;
    text-align: center;
    color: rgba(255,255,255,0.28);
    font-size: 10px;
    line-height: 1.6;
    padding: 6px 12px 0;
    margin-top: 4px;
    border-top: 1px solid rgba(255,255,255,0.04);
    letter-spacing: 0.02em;
  `;

  // 兜底 fixed 样式（仅在 footer 始终找不到时使用）
  const FIXED_STYLE = `
    position: fixed; bottom: 0; left: 0; right: 0;
    background: rgba(0,0,0,0.75); color: #ccc;
    font-size: 11px; padding: 6px 12px;
    text-align: center; z-index: 9998;
    line-height: 1.5;
  `;

  const HTML = `
    本站为非盈利个人项目，音乐播放器仅供个人学习、研究及非商业交流使用。
    所有音频通过第三方公开 API 实时流式获取（仅做流式播放传输，不下载、不存储、不缓存），版权归原作者及原音乐平台所有。
    本站不存储任何音频文件，不提供下载，不用于任何商业用途。
    特别声明：本站核心音乐内容「小车」的原创歌曲版权归其本人所有。
    如版权方有异议，请联系删除。
  `;

  function buildNotice(styleText) {
    const notice = document.createElement('div');
    notice.id = 'music-copyright-notice';
    notice.setAttribute('style', styleText);
    notice.innerHTML = HTML;
    return notice;
  }

  function hasNotice() {
    return document.getElementById('music-copyright-notice') !== null;
  }

  function tryInjectIntoFooter() {
    if (hasNotice()) return true;
    const footer = document.querySelector('footer');
    if (!footer) return false;
    // 注入到 footer 末尾，作为其子元素（static，随 footer 流动）
    footer.appendChild(buildNotice(INLINE_STYLE));
    console.log('[Copyright] 版权声明已注入 footer 内');
    return true;
  }

  function fallbackFixed() {
    if (hasNotice()) return;
    document.body.appendChild(buildNotice(FIXED_STYLE));
    console.warn('[Copyright] footer 未找到，版权声明回退 fixed bottom');
  }

  function start() {
    // 立即试一次（DOM 可能已就绪）
    if (tryInjectIntoFooter()) return;

    // footer 是 client component，可能未渲染 → 轮询最多 3 秒
    const startTs = Date.now();
    const POLL_INTERVAL = 150;
    const timer = setInterval(() => {
      if (tryInjectIntoFooter()) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startTs > 3000) {
        clearInterval(timer);
        fallbackFixed();
      }
    }, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
