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
 * 要素に一時的な発光エフェクトを適用します。
 * @param {HTMLElement|null|undefined} el
 */
export function applyGlowEffect(el) {
  if (!el) return;
  
  const rect = el.getBoundingClientRect();
  const flash = document.createElement('div');
  flash.style.position = 'fixed';
  flash.style.top = rect.top + 'px';
  flash.style.left = rect.left + 'px';
  flash.style.width = rect.width + 'px';
  flash.style.height = rect.height + 'px';
  flash.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
  flash.style.pointerEvents = 'none';
  flash.style.zIndex = '10005';
  flash.style.borderRadius = window.getComputedStyle(el).borderRadius || '0px';
  
  document.body.appendChild(flash);
  
  // Set initial opacity without transition
  flash.style.transition = 'none';
  flash.style.opacity = '0.5';
  
  // Start fade out in the next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flash.style.transition = 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
      flash.style.opacity = '0';
    });
  });

  // Cleanup
  setTimeout(() => {
    if (flash.parentNode) flash.remove();
  }, 600);
}

/**
 * 開発者ツールのショートカットをブロックします。
 */
export function blockDevtoolsShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
      e.preventDefault();
      if (window.veloceAPI && window.veloceAPI.invoke) {
        window.veloceAPI.invoke('toggle_devtools');
      } else if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke('toggle_devtools');
      }
    }
  });
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
