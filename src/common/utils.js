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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/**
 * サポート対象の音声ファイル拡張子一覧（将来の形式拡張を容易にするための定義テーブル）
 */
export const AUDIO_EXTENSIONS = ['.mp3'];

/**
 * カバー画像のない音声ファイル（MP3）向けプレースホルダSVG（Lucide "music" アイコン準拠・事前Base64化）
 */
export const AUDIO_PLACEHOLDER_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSJub25lIiBzdHJva2U9IiM0NDQiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik05IDE4VjVsMTItMnYxMyI+PC9wYXRoPjxjaXJjbGUgY3g9IjYiIGN5PSIxOCIgcj0iMyI+PC9jaXJjbGU+PGNpcmNsZSBjeD0iMTgiIGN5PSIxNiIgcj0iMyI+PC9jaXJjbGU+PC9zdmc+';

/**
 * 対象ファイルがサポート対象の音声形式（現在は MP3）であるかを判定する
 * @param {string} filePath - ファイルパス
 * @returns {boolean} 音声形式であれば true
 */
export function isAudioFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  return AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function getStreamUrl(filePath, baseSrc) {
  if (filePath && (filePath.toLowerCase().endsWith('.mp4') || isAudioFile(filePath))) {
    const tokenParam = window.videoServerToken ? `&token=${encodeURIComponent(window.videoServerToken)}` : '';
    if (window.videoServerPort) {
      return `http://localhost:${window.videoServerPort}/?path=` + encodeURIComponent(filePath) + tokenParam;
    }
    console.warn("videoServerPort is missing! Falling back for", filePath);
    try {
      const urlObj = new URL(baseSrc);
      return urlObj.protocol + '//stream.localhost/?path=' + encodeURIComponent(filePath) + tokenParam;
    } catch (e) {
      return 'https://stream.localhost/?path=' + encodeURIComponent(filePath) + tokenParam;
    }
  }
  return baseSrc;
}

/**
 * 音声ファイルの埋め込みカバー画像をビューアー表示用のオリジナル解像度で取得するURLを生成する
 * サムネイルキャッシュや Rust 側HTTPサーバーとホスト名を 127.0.0.1 に統一する
 * @param {string} filePath - 音声ファイルパス
 * @returns {string} HTTPサーバーURL（ポート未確定時は空文字）
 */
export function getAudioCoverUrl(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const tokenParam = (typeof window !== 'undefined' && window.videoServerToken)
    ? `&token=${encodeURIComponent(window.videoServerToken)}`
    : '';
  if (typeof window !== 'undefined' && window.videoServerPort) {
    return `http://127.0.0.1:${window.videoServerPort}/?path=${encodeURIComponent(filePath)}&cover=1${tokenParam}`;
  }
  return '';
}

/**
 * URL がローカルメディアHTTPサーバー（127.0.0.1 / localhost）を指しているか判定する
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalMediaServerUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'));
}

/**
 * 秒数を m:ss または h:mm:ss 形式に整形する
 * @param {number} seconds - 秒数
 * @returns {string}
 */
export function formatDurationSeconds(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * 対象ファイルが動画形式（MP4/WebM/AVI/MKV/MOV）であるかを判定する
 * @param {string} filePath - ファイルパス
 * @returns {boolean} 動画形式であれば true
 */
export function isVideoFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.avi') || lower.endsWith('.mkv') || lower.endsWith('.mov');
}
