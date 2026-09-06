export function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

/**
 * HTML特殊文字をエスケープします。
 * @param {string} str
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 要素内のアイコン（SVG）またはテキストのアウトラインだけを一時的に発光させます。
 * 背景矩形を光らせず、描画されている線・輪郭線のみに drop-shadow / text-shadow を適用します。
 * @param {HTMLElement|null|undefined} el
 */
export function applyGlowEffect(el) {
  if (!el) return;

  const svg = el.tagName === 'svg' ? el : (el.querySelector ? el.querySelector('svg') : null);
  const target = svg || el;
  const isSvg = !!svg || el.tagName === 'svg';
  const glowClass = isSvg ? 'outline-glow-svg' : 'outline-glow-text';

  // アニメーションの再トリガーに対応
  target.classList.remove('outline-glow-svg', 'outline-glow-text');
  void target.offsetWidth; // Reflow強制でCSSアニメーションをリスタート
  target.classList.add(glowClass);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    target.classList.remove(glowClass);
    target.removeEventListener('animationend', cleanup);
  };
  target.addEventListener('animationend', cleanup, { once: true });

  // 万一のイベント未発火に対するフェイルセーフ
  setTimeout(cleanup, 650);
}

/**
 * 開発者ツールのショートカットをブロックします。
 */
export function blockDevtoolsShortcuts() {
  const blockHandler = (e) => {
    if (
      e.key === 'F12' || e.code === 'F12' || 
      (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I' || e.code === 'KeyI' || e.key.toLowerCase() === 'i'))
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  
  window.addEventListener('keydown', blockHandler, { capture: true });
  window.addEventListener('keyup', blockHandler, { capture: true });
  window.addEventListener('keypress', blockHandler, { capture: true });
  document.addEventListener('keydown', blockHandler, { capture: true });
}

export function getStreamUrl(filePath, baseSrc) {
  if (filePath.toLowerCase().endsWith('.mp4')) {
    if (window.videoServerPort) {
      return `http://localhost:${window.videoServerPort}/?path=` + encodeURIComponent(filePath);
    }
    console.warn("videoServerPort is missing! Falling back for", filePath);
    try {
      const urlObj = new URL(baseSrc);
      return urlObj.protocol + '//stream.localhost/?path=' + encodeURIComponent(filePath);
    } catch (e) {
      return 'https://stream.localhost/?path=' + encodeURIComponent(filePath);
    }
  }
  return baseSrc;
}
