import { viewerState } from './viewer-state.js';
import {
  applyGlowEffect as glowElement,
  formatDurationSeconds,
  isAudioFile,
  AUDIO_PLACEHOLDER_URL
} from '../common/utils.js';
import {
  extractMetadataFields,
  parsePromptTags,
  buildInspectorSections
} from '../common/metadata-format.js';

/**
 * ビューア画面のUIとDOM操作を管理するクラス
 */
class ViewerUI {
  static ICONS = {
    MINIMIZE: `<svg viewBox="0 0 10 1" width="10" height="1"><rect width="10" height="1" fill="currentColor"/></svg>`,
    MAXIMIZE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
    RESTORE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1"/><polyline points="3,3 3,1 9,1 9,7 7,7" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
    CLOSE: `<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0,0 L10,10 M10,0 L0,10" stroke="currentColor" stroke-width="1"/></svg>`
  };

  /**
   * @param {ViewerState} state - ビューア状態のインスタンス
   */
  constructor(state) {
    this.state = state;
    this.elements = {
      viewerImg: document.getElementById('viewer-img')
    };
  }

  /**
   * 画像の変形（ズーム・パン・回転）とフィルター（シャープネス）を適用し、画面の描画を更新します。
   */
  updateImageRendering() {
    if (!this.elements.viewerImg) return;
    let filters = [];
    if (this.state.isUnsharped) filters.push('url(#unsharp-filter)');
    this.elements.viewerImg.style.filter = filters.length > 0 ? filters.join(' ') : 'none';
    
    if (this.state.isImmersiveArranged) {
      let r = ((this.state.currentRotation % 360) + 360) % 360;
      let tx = this.state.currentTranslateX * this.state.flipX;
      let ty = this.state.currentTranslateY * this.state.flipY;
      let posX = tx;
      let posY = ty;

      if (r === 90) {
        posX = ty;
        posY = -tx;
      } else if (r === 180) {
        posX = -tx;
        posY = -ty;
      } else if (r === 270) {
        posX = -ty;
        posY = tx;
      }
      
      let comp = this.state.compensateScale || 1.0;
      this.elements.viewerImg.style.objectPosition = `calc(50% + ${posX}px) calc(50% + ${posY}px)`;
      this.elements.viewerImg.style.transform = `translate(0px, 0px) scale(${this.state.flipX}, ${this.state.flipY}) rotate(${this.state.currentRotation}deg) scale(${this.state.currentScale * comp})`;
    } else {
      let comp = this.state.compensateScale || 1.0;
      this.elements.viewerImg.style.objectPosition = '50% 50%';
      this.elements.viewerImg.style.transform = `translate(${this.state.currentTranslateX}px, ${this.state.currentTranslateY}px) scale(${this.state.flipX}, ${this.state.flipY}) rotate(${this.state.currentRotation}deg) scale(${this.state.currentScale * comp})`;
    }
  }

  /**
   * フルスクリーン状態などを考慮して、ウィンドウ枠（ボーダー）とコントロールボタンの表示状態を更新します。
   */
  applyBorderVisibility() {
    if (this.state.isFullscreen) return;
    const overlay = document.getElementById('border-overlay');
    if (overlay) overlay.classList.toggle('border-hidden', !this.state.isBorderVisible);
    const controls = document.getElementById('window-controls');
    if (controls) {
      controls.classList.toggle('controls-hidden', !this.state.isBorderVisible);
      controls.classList.remove('fs-hidden');
    }
  }
  
  /**
   * 画像上のマウスカーソルの種類を変更します。
   * @param {string} type - CSSのcursorプロパティに設定する値（例: 'grab', 'default'）
   */
  setCursor(type) {
    if (this.elements.viewerImg) this.elements.viewerImg.style.cursor = type;
  }

  /**
   * アイコンや要素を発光させます。
   * @param {HTMLElement} el 対象の要素
   */
  applyGlowEffect(el) {
    glowElement(el);
  }

  /**
   * ループ境界（先頭または末尾への折り返し）到達時の視覚的フィードバックを発火します。
   * 画面両端・外周に微弱なアクセント発光（viewer-edge-glow）を適用し、軽量なトースト通知を表示します。
   * @param {'start'|'end'} boundary - 'start' (末尾から先頭へループ) または 'end' (先頭から末尾へループ)
   */
  triggerLoopFeedback(boundary) {
    const body = document.body;
    if (body) {
      if (this._edgeGlowTimer) {
        clearTimeout(this._edgeGlowTimer);
        body.classList.remove('viewer-edge-glow');
        void body.offsetWidth; // リフローを強制してアニメーションを再トリガー
      }
      body.classList.add('viewer-edge-glow');
      this._edgeGlowTimer = setTimeout(() => {
        body.classList.remove('viewer-edge-glow');
        this._edgeGlowTimer = null;
      }, 400);
    }

    const message = boundary === 'start' ? '先頭に戻りました' : '末尾に戻りました';
    const toastFn = (typeof window !== 'undefined' && typeof window.showToast === 'function')
      ? window.showToast
      : (typeof globalThis !== 'undefined' && typeof globalThis.showToast === 'function')
        ? globalThis.showToast
        : (typeof showToast === 'function' ? showToast : null);
    if (typeof toastFn === 'function') {
      toastFn(message, 1500, 'info');
    }
  }
}

export { ViewerUI };
export const viewerUI = new ViewerUI(viewerState);

// ============================================================================
// トースト通知
// ============================================================================

/**
 * ビューアー用の軽量トースト通知を表示します。
 * DOM要素の再利用と自動破棄を行い、メイン画面と同一のスタイルを適用します。
 * @param {string} message - 通知メッセージ (HTML文字列可)
 * @param {number} [duration=3000] - 表示時間 (ms)
 * @param {string} [type='info'] - トースト種別 ('info' | 'success' | 'warning' | 'error')
 */
export function showToast(message, duration = 3000, type = 'info', options = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-message ${type}`;
  if (options && options.isHtml === true && typeof message === 'string') {
    toast.innerHTML = message;
  } else {
    toast.textContent = message;
  }
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  const hideTimeout = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 200);
  }, duration);

  return { toast, container, hideTimeout };
}

if (typeof window !== 'undefined') {
  window.showToast = showToast;
}

// ============================================================================
// 設定・永続化アクセスヘルパー
// ============================================================================

const VIEWER_VOLUME_KEY = 'viewerVolume';
const VIEWER_MUTED_KEY = 'viewerMuted';
const VIEWER_PLAY_MODE_VIDEO_KEY = 'viewerPlayModeVideo';
const VIEWER_PLAY_MODE_AUDIO_KEY = 'viewerPlayModeAudio';

/**
 * SettingsStore（フォールバック時は localStorage）から設定値を読み込む
 * @param {string} key
 * @returns {string|null}
 */
export function readViewerSetting(key) {
  if (typeof window !== 'undefined' && window.SettingsStore && typeof window.SettingsStore.getItem === 'function') {
    return window.SettingsStore.getItem(key);
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return null;
}

/**
 * SettingsStore（フォールバック時は localStorage）へ設定値を保存する
 * @param {string} key
 * @param {string} value
 */
export function writeViewerSetting(key, value) {
  const strVal = String(value);
  if (typeof window !== 'undefined' && window.SettingsStore && typeof window.SettingsStore.setItem === 'function') {
    window.SettingsStore.setItem(key, strVal);
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, strVal);
  }
}

// ============================================================================
// 音量・ミュート設定
// ============================================================================

/**
 * 永続化された音量（0.0 〜 1.0、未設定時は 1.0）を取得する
 * @returns {number}
 */
export function getSavedViewerVolume() {
  const raw = readViewerSetting(VIEWER_VOLUME_KEY);
  if (raw === null || raw === undefined || raw === '') return 1;
  const num = parseFloat(raw);
  if (isNaN(num)) return 1;
  return Math.max(0, Math.min(1, num));
}

/**
 * 永続化されたミュート状態を取得する（未設定時は引数の既定値に従う）
 * @param {boolean} [defaultIfUnset=false]
 * @returns {boolean}
 */
export function getSavedViewerMuted(defaultIfUnset = false) {
  const raw = readViewerSetting(VIEWER_MUTED_KEY);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return Boolean(defaultIfUnset);
}

/**
 * 対象メディア要素（<video> / <audio>）へ保存済みの音量・ミュート状態を適用する
 * @param {HTMLMediaElement} media
 * @param {boolean} [defaultMutedIfUnset=false]
 */
export function applyVolumeSettingsToMedia(media, defaultMutedIfUnset = false) {
  if (!media) return;
  try {
    media.volume = getSavedViewerVolume();
  } catch (e) {}
  media.muted = getSavedViewerMuted(defaultMutedIfUnset);
}

// ============================================================================
// 再生モード定義と制御
// ============================================================================

export const PLAY_MODES = {
  STOP: 'stop',
  REPEAT: 'repeat',
  AUTO_NEXT: 'auto_next',
};

export const PLAY_MODE_ORDER = [PLAY_MODES.STOP, PLAY_MODES.REPEAT, PLAY_MODES.AUTO_NEXT];

export const PLAY_MODE_INFO = {
  [PLAY_MODES.STOP]: {
    label: '停止',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"></rect></svg>',
  },
  [PLAY_MODES.REPEAT]: {
    label: 'リピート',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>',
  },
  [PLAY_MODES.AUTO_NEXT]: {
    label: '自動送り',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" x2="19" y1="5" y2="19"></line></svg>',
  },
};

let playModeBtnElement = null;

/**
 * 指定メディア種別（'video' または 'audio'）の保存された再生モードを取得する。
 * 未設定時または不正値時は既定値の 'repeat' を返す。
 * @param {'video'|'audio'} [mediaType='video']
 * @returns {'stop'|'repeat'|'auto_next'}
 */
export function getSavedViewerPlayMode(mediaType = 'video') {
  const key = (mediaType === 'audio') ? VIEWER_PLAY_MODE_AUDIO_KEY : VIEWER_PLAY_MODE_VIDEO_KEY;
  const raw = readViewerSetting(key);
  if (raw === PLAY_MODES.STOP || raw === PLAY_MODES.REPEAT || raw === PLAY_MODES.AUTO_NEXT) {
    return raw;
  }
  return PLAY_MODES.REPEAT;
}

/**
 * 指定メディア種別（'video' または 'audio'）の再生モードを永続化する。
 * @param {'video'|'audio'} mediaType
 * @param {'stop'|'repeat'|'auto_next'} mode
 */
export function saveViewerPlayMode(mediaType, mode) {
  const key = (mediaType === 'audio') ? VIEWER_PLAY_MODE_AUDIO_KEY : VIEWER_PLAY_MODE_VIDEO_KEY;
  const validMode = (mode === PLAY_MODES.STOP || mode === PLAY_MODES.REPEAT || mode === PLAY_MODES.AUTO_NEXT)
    ? mode
    : PLAY_MODES.REPEAT;
  writeViewerSetting(key, validMode);
}

/**
 * 対象メディア要素へ保存済みの再生モード設定（loopフラグ）を反映する。
 * @param {HTMLMediaElement} media
 * @param {'video'|'audio'} [mediaType]
 */
export function applyPlayModeToMedia(media, mediaType) {
  if (!media) return;
  const type = mediaType || (media.tagName === 'AUDIO' ? 'audio' : 'video');
  const mode = getSavedViewerPlayMode(type);
  media.loop = (mode === PLAY_MODES.REPEAT);
}

// ============================================================================
// メディア判定・状態管理
// ============================================================================

let currentAudioElement = null;

export function setCurrentAudioElement(el) {
  currentAudioElement = el;
}

export function getCurrentAudioElement() {
  return currentAudioElement;
}

export function isAudioPlaceholderMedia(media) {
  if (!media) return false;
  if (media.classList && media.classList.contains('audio-placeholder')) return true;
  if (typeof media.src === 'string' && media.src === AUDIO_PLACEHOLDER_URL) return true;
  if (media.dataset && media.dataset.audioPath) {
    const natW = media.naturalWidth || 0;
    const natH = media.naturalHeight || 0;
    if (natW === 0 || natH === 0) return true;
  }
  return false;
}

export function getMediaWidth(media) {
  if (!media) return 1;
  if (isAudioPlaceholderMedia(media)) return 480;
  return media.tagName === 'VIDEO' ? (media.videoWidth || 1) : (media.naturalWidth || 1);
}

export function getMediaHeight(media) {
  if (!media) return 1;
  if (isAudioPlaceholderMedia(media)) return 480;
  return media.tagName === 'VIDEO' ? (media.videoHeight || 1) : (media.naturalHeight || 1);
}

/**
 * 対象メディア要素でコントロールバーを既定表示すべきかを判定する
 * 音声ファイル（<audio>）では設定にかかわらず常時表示し、動画（<video>）は設定に従う
 * @param {HTMLMediaElement|null} media
 * @returns {boolean}
 */
export function shouldShowSeekBarForMedia(media) {
  if (!isPlayableMedia(media)) return false;
  if (media.tagName === 'AUDIO') return true;
  return isDefaultSeekBarEnabled();
}

export function isPlayableMedia(media) {
  return !!(media && (media.tagName === 'VIDEO' || media.tagName === 'AUDIO'));
}

/**
 * 現在ビューアで再生制御対象となるメディア要素（<audio> または <video>）を返す
 * @returns {HTMLMediaElement|null}
 */
export function getActivePlaybackMedia() {
  if (currentAudioElement && currentAudioElement.tagName === 'AUDIO') {
    return currentAudioElement;
  }
  const activeImg = (viewerUI && viewerUI.elements && viewerUI.elements.viewerImg) || document.getElementById('viewer-img');
  if (activeImg && activeImg.tagName === 'VIDEO') {
    return activeImg;
  }
  return null;
}

/**
 * 現在ビューアで音声ファイル（MP3）を表示中かを判定する
 * @returns {boolean}
 */
export function isCurrentlyDisplayingAudio() {
  if (isAudioFile(viewerState.currentImagePath)) return true;
  if (currentAudioElement && currentAudioElement.tagName === 'AUDIO') return true;
  const imgEl = (viewerUI && viewerUI.elements && viewerUI.elements.viewerImg) || document.getElementById('viewer-img');
  if (imgEl && imgEl.dataset && imgEl.dataset.audioPath) return true;
  return false;
}

/**
 * 現在ビューアで音声ファイル（MP3）のプレースホルダ（カバー画像なし／未ロード）を表示中かを判定する
 * カバー画像が登録されており正常にロード・表示されている場合は false を返す
 * @returns {boolean}
 */
export function isCurrentlyDisplayingAudioPlaceholder() {
  if (!isCurrentlyDisplayingAudio()) return false;
  const imgEl = (viewerUI && viewerUI.elements && viewerUI.elements.viewerImg) || document.getElementById('viewer-img');
  return isAudioPlaceholderMedia(imgEl);
}

/**
 * 再生モード切替ボタンのアイコンおよびタイトルを現在のメディア種別のモードに同期する。
 */
export function updatePlayModeButtonUI() {
  if (!playModeBtnElement) return;
  const mediaType = isCurrentlyDisplayingAudio() ? 'audio' : 'video';
  const mode = getSavedViewerPlayMode(mediaType);
  const info = PLAY_MODE_INFO[mode] || PLAY_MODE_INFO[PLAY_MODES.REPEAT];
  playModeBtnElement.innerHTML = info.icon;
  playModeBtnElement.title = `再生モード：${info.label}`;
}

/**
 * 現在のメディア種別に応じた再生モードを 停止 → リピート → 自動送り の順に循環切替する。
 * @returns {'stop'|'repeat'|'auto_next'} 切替後の再生モード
 */
export function cycleViewerPlayMode() {
  const mediaType = isCurrentlyDisplayingAudio() ? 'audio' : 'video';
  const currentMode = getSavedViewerPlayMode(mediaType);
  const currentIndex = PLAY_MODE_ORDER.indexOf(currentMode);
  const nextMode = PLAY_MODE_ORDER[(currentIndex + 1) % PLAY_MODE_ORDER.length];
  saveViewerPlayMode(mediaType, nextMode);
  updatePlayModeButtonUI();

  const activeMedia = getActivePlaybackMedia();
  if (activeMedia) {
    activeMedia.loop = (nextMode === PLAY_MODES.REPEAT);
  }

  const info = PLAY_MODE_INFO[nextMode] || PLAY_MODE_INFO[PLAY_MODES.REPEAT];
  const toastFn = (typeof window !== 'undefined' && typeof window.showToast === 'function') ? window.showToast : showToast;
  toastFn(`再生モード：${info.label}`);
  return nextMode;
}

/**
 * 現在再生対象のメディア（動画・音声）の音量を指定パーセント（±5等）増減させ、永続化・UI同期・トースト通知を行う
 * @param {number} deltaPercent - 増減パーセント（例: +5, -5）
 * @returns {boolean} 適用された場合は true
 */
export function adjustActiveMediaVolumeByPercent(deltaPercent) {
  const activeMedia = getActivePlaybackMedia();
  if (!isPlayableMedia(activeMedia)) return false;

  const currentVol = (typeof activeMedia.volume === 'number' && !isNaN(activeMedia.volume))
    ? activeMedia.volume
    : getSavedViewerVolume();
  const currentMuted = (typeof activeMedia.muted === 'boolean')
    ? activeMedia.muted
    : getSavedViewerMuted(false);

  const nextPercent = Math.max(0, Math.min(100, Math.round(currentVol * 100) + deltaPercent));
  const nextVol = nextPercent / 100;

  if (deltaPercent > 0 && currentMuted) {
    writeViewerSetting(VIEWER_MUTED_KEY, 'false');
  }
  writeViewerSetting(VIEWER_VOLUME_KEY, String(nextVol));
  applyVolumeSettingsToMedia(activeMedia, currentMuted && deltaPercent <= 0);

  if (videoSeekBarContainer && typeof videoSeekBarContainer.updateVolumeControls === 'function') {
    videoSeekBarContainer.updateVolumeControls();
  }
  showToast(`音量 ${nextPercent}%`);
  return true;
}

/**
 * 現在再生対象のメディア（動画・音声）の再生位置を指定秒数（±5等）シークし、[0, duration] にクランプする
 * @param {number} deltaSeconds - シーク秒数（例: +5, -5）
 * @returns {boolean} シークが実行された場合は true
 */
export function seekActiveMediaBySeconds(deltaSeconds) {
  const activeMedia = getActivePlaybackMedia();
  if (!isPlayableMedia(activeMedia)) return false;

  const duration = activeMedia.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }

  const current = (typeof activeMedia.currentTime === 'number' && Number.isFinite(activeMedia.currentTime))
    ? activeMedia.currentTime
    : 0;
  const nextTime = Math.max(0, Math.min(duration, current + deltaSeconds));
  activeMedia.currentTime = nextTime;

  if (videoSeekBarContainer && typeof videoSeekBarContainer.updateProgress === 'function') {
    videoSeekBarContainer.updateProgress();
  }
  return true;
}

/**
 * 再生中の音声要素（<audio>）を確実に停止・破棄し、音声残りやバックグラウンド再生を防ぐ
 */
export function stopAndDiscardAudio() {
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.removeAttribute('src');
      if (typeof currentAudioElement.load === 'function') {
        currentAudioElement.load();
      }
    } catch (e) {}
    if (typeof currentAudioElement.remove === 'function') {
      currentAudioElement.remove();
    }
    currentAudioElement = null;
  }
}

// ============================================================================
// コントロールバー・音量ポップアップUI
// ============================================================================

let videoSeekBarContainer = null;
let volumePopupElement = null;
let volumeBtnElement = null;
let isVolumePopupOutsideListenerBound = false;

/**
 * 音量ポップアップが現在開いているかを返す。
 * @returns {boolean} 開いていれば true
 */
export function isVolumePopupOpen() {
  return Boolean(volumePopupElement && volumePopupElement.style.display === 'flex');
}

/**
 * 音量ポップアップの表示状態と関連 ARIA 属性を同期する。
 * @param {boolean} open 表示する場合は true
 */
export function setVolumePopupOpen(open) {
  if (!volumePopupElement) return;
  const nextOpen = Boolean(open);
  volumePopupElement.style.display = nextOpen ? 'flex' : 'none';
  if (videoSeekBarContainer) {
    videoSeekBarContainer.classList.toggle('volume-popup-open', nextOpen);
  }
  if (volumeBtnElement) {
    volumeBtnElement.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }
}

/**
 * 音量ポップアップを閉じる。
 */
export function closeVolumePopup() {
  setVolumePopupOpen(false);
}

export function isDefaultSeekBarEnabled() {
  return (typeof window !== 'undefined' && window.SettingsStore
    ? window.SettingsStore.getItem('showViewerSeekBar')
    : (typeof localStorage !== 'undefined' ? localStorage.getItem('showViewerSeekBar') : null)) === 'true';
}

export function ensureVideoSeekBarContainer() {
  if (videoSeekBarContainer) {
    if (!videoSeekBarContainer.isConnected && document.body) {
      document.body.appendChild(videoSeekBarContainer);
    }
    return videoSeekBarContainer;
  }

  videoSeekBarContainer = document.createElement('div');
  videoSeekBarContainer.id = 'video-controls-container';
  
  const playBtn = document.createElement('button');
  playBtn.id = 'video-play-btn';
  const playIcon = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  playBtn.innerHTML = pauseIcon; // 初期状態は再生中なのでポーズアイコン

  const seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.id = 'video-seek-bar';
  seekBar.min = 0;
  seekBar.max = 100;
  seekBar.step = 0.1;
  seekBar.value = 0;

  const timeDisplay = document.createElement('div');
  timeDisplay.id = 'video-time-display';
  timeDisplay.innerText = '0:00 / 0:00';

  const volumeOnIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
  const volumeZeroIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg>';
  const volumeMutedIcon = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';

  const actionsContainer = document.createElement('div');
  actionsContainer.id = 'video-controls-actions';

  const playModeBtn = document.createElement('button');
  playModeBtn.id = 'video-play-mode-btn';
  playModeBtn.type = 'button';
  playModeBtnElement = playModeBtn;
  updatePlayModeButtonUI();

  playModeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleViewerPlayMode();
  });

  const volumeWrapper = document.createElement('div');
  volumeWrapper.id = 'video-volume-btn-wrapper';

  const volumeBtn = document.createElement('button');
  volumeBtn.id = 'video-volume-btn';
  volumeBtn.type = 'button';
  volumeBtn.title = '音量';
  volumeBtn.setAttribute('aria-haspopup', 'true');
  volumeBtn.setAttribute('aria-expanded', 'false');
  volumeBtn.setAttribute('aria-controls', 'video-volume-popup');
  volumeBtnElement = volumeBtn;

  const volumePopup = document.createElement('div');
  volumePopup.id = 'video-volume-popup';
  volumePopup.style.display = 'none';
  volumePopupElement = volumePopup;

  const volumeSliderWrapper = document.createElement('div');
  volumeSliderWrapper.id = 'video-volume-slider-wrapper';

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.id = 'video-volume-slider';
  volumeSlider.min = 0;
  volumeSlider.max = 1;
  volumeSlider.step = 0.01;
  volumeSlider.value = String(getSavedViewerVolume());
  volumeSlider.title = '音量';

  const muteBtn = document.createElement('button');
  muteBtn.id = 'video-mute-btn';
  muteBtn.type = 'button';
  muteBtn.title = 'ミュート切替';

  volumeSliderWrapper.appendChild(volumeSlider);
  volumePopup.appendChild(volumeSliderWrapper);
  volumePopup.appendChild(muteBtn);
  volumeWrapper.appendChild(volumeBtn);
  volumeWrapper.appendChild(volumePopup);
  actionsContainer.appendChild(playModeBtn);
  actionsContainer.appendChild(volumeWrapper);

  videoSeekBarContainer.appendChild(playBtn);
  videoSeekBarContainer.appendChild(seekBar);
  videoSeekBarContainer.appendChild(timeDisplay);
  videoSeekBarContainer.appendChild(actionsContainer);
  document.body.appendChild(videoSeekBarContainer);

  // シークバー・音量ポップアップ操作時に画面のパン（移動）やクリック判定が誤爆するのを防ぐ
  const stopPropagation = (e) => e.stopPropagation();
  ['mousedown', 'mousemove', 'mouseup', 'wheel', 'click', 'dblclick', 'contextmenu'].forEach(event => {
    videoSeekBarContainer.addEventListener(event, stopPropagation);
    volumePopup.addEventListener(event, stopPropagation);
  });

  if (!isVolumePopupOutsideListenerBound) {
    isVolumePopupOutsideListenerBound = true;
    const handleOutsidePopupPointer = (e) => {
      if (!isVolumePopupOpen()) return;
      if (volumeWrapper && !volumeWrapper.contains(e.target)) {
        closeVolumePopup();
      }
    };
    // コントロールバーの stopPropagation によりバブルが止まる要素（シークバー等）やバー外クリックも捕捉するためキャプチャフェーズで監視
    document.addEventListener('mousedown', handleOutsidePopupPointer, true);
    document.addEventListener('click', handleOutsidePopupPointer, true);
  }

  // グローバルキャプチャリングフェーズでのメディアイベント監視
  // DOMに追加される各video/audio要素にリスナーを個別にバインドするコストを削減
  document.addEventListener('timeupdate', (e) => {
    const activeMedia = getActivePlaybackMedia();
    if (videoSeekBarContainer && videoSeekBarContainer.style.display !== 'none' && e.target === activeMedia) {
      videoSeekBarContainer.updateProgress();
    }
  }, true);

  document.addEventListener('play', (e) => {
    const activeMedia = getActivePlaybackMedia();
    if (videoSeekBarContainer && videoSeekBarContainer.style.display !== 'none' && e.target === activeMedia) {
      videoSeekBarContainer.updatePlayStateIcon();
    }
  }, true);

  document.addEventListener('pause', (e) => {
    const activeMedia = getActivePlaybackMedia();
    if (videoSeekBarContainer && videoSeekBarContainer.style.display !== 'none' && e.target === activeMedia) {
      videoSeekBarContainer.updatePlayStateIcon();
    }
  }, true);

  let isSeeking = false;

  playBtn.addEventListener('click', () => {
    const activeMedia = getActivePlaybackMedia();
    if (isPlayableMedia(activeMedia)) {
      if (activeMedia.paused) {
        activeMedia.play();
      } else {
        activeMedia.pause();
      }
    }
    playBtn.blur();
  });

  let lastPausedState = null;
  videoSeekBarContainer.updatePlayStateIcon = () => {
    const activeMedia = getActivePlaybackMedia();
    if (isPlayableMedia(activeMedia)) {
      if (activeMedia.paused !== lastPausedState) {
        lastPausedState = activeMedia.paused;
        playBtn.innerHTML = activeMedia.paused ? playIcon : pauseIcon;
      }
    }
  };

  let lastVolumeBtnState = null;
  let lastMutedIconState = null;
  videoSeekBarContainer.updateVolumeControls = () => {
    const activeMedia = getActivePlaybackMedia();
    const rawVol = isPlayableMedia(activeMedia) ? activeMedia.volume : getSavedViewerVolume();
    const vol = (typeof rawVol === 'number' && !isNaN(rawVol)) ? Math.max(0, Math.min(1, rawVol)) : 1;
    const muted = isPlayableMedia(activeMedia) ? activeMedia.muted : getSavedViewerMuted(false);
    volumeSlider.value = String(vol);

    const nextVolumeBtnState = muted ? 'muted' : (vol === 0 ? 'zero' : 'on');
    if (nextVolumeBtnState !== lastVolumeBtnState) {
      lastVolumeBtnState = nextVolumeBtnState;
      volumeBtn.innerHTML = muted
        ? volumeMutedIcon
        : (vol === 0 ? volumeZeroIcon : volumeOnIcon);
    }

    if (muted !== lastMutedIconState) {
      lastMutedIconState = muted;
      muteBtn.innerHTML = muted ? volumeMutedIcon : volumeOnIcon;
      muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }
  };
  videoSeekBarContainer.updateVolumeControls();

  volumeBtn.addEventListener('click', () => {
    const nextOpen = !isVolumePopupOpen();
    setVolumePopupOpen(nextOpen);
    if (nextOpen && videoSeekBarContainer.updateVolumeControls) {
      videoSeekBarContainer.updateVolumeControls();
    }
    volumeBtn.blur();
  });

  muteBtn.addEventListener('click', () => {
    const activeMedia = getActivePlaybackMedia();
    const currentMuted = isPlayableMedia(activeMedia) ? activeMedia.muted : getSavedViewerMuted(false);
    const nextMuted = !currentMuted;
    writeViewerSetting(VIEWER_MUTED_KEY, nextMuted ? 'true' : 'false');
    if (isPlayableMedia(activeMedia)) {
      activeMedia.muted = nextMuted;
    }
    videoSeekBarContainer.updateVolumeControls();
    muteBtn.blur();
  });

  volumeSlider.addEventListener('input', () => {
    const rawVal = parseFloat(volumeSlider.value);
    const vol = isNaN(rawVal) ? 1 : Math.max(0, Math.min(1, rawVal));
    writeViewerSetting(VIEWER_VOLUME_KEY, String(vol));
    const activeMedia = getActivePlaybackMedia();
    if (isPlayableMedia(activeMedia)) {
      try {
        activeMedia.volume = vol;
      } catch (e) {}
    }
    videoSeekBarContainer.updateVolumeControls();
  });

  volumeSlider.addEventListener('change', () => {
    volumeSlider.blur();
  });

  volumeSlider.addEventListener('mouseup', () => {
    volumeSlider.blur();
  });

  seekBar.addEventListener('input', () => {
    isSeeking = true;
    const activeMedia = getActivePlaybackMedia();
    if (isPlayableMedia(activeMedia) && activeMedia.duration) {
      const time = (seekBar.value / 100) * activeMedia.duration;
      activeMedia.currentTime = time;
      const nextText = formatDurationSeconds(time) + ' / ' + formatDurationSeconds(activeMedia.duration);
      if (timeDisplay.textContent !== nextText) {
        timeDisplay.textContent = nextText;
      }
    }
  });

  seekBar.addEventListener('change', () => {
    isSeeking = false;
    seekBar.blur();
  });

  seekBar.addEventListener('mouseup', () => {
    seekBar.blur();
  });

  // マウスカーソルがシークバー領域から離れた際、内部コントロールのフォーカスを解除して
  // ホバー解除とともに確実に元の透明度へ戻し、スペースキー等のキーボードショートカットとの競合を防ぐ
  videoSeekBarContainer.addEventListener('mouseleave', () => {
    if (videoSeekBarContainer.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  });

  videoSeekBarContainer.updateProgress = () => {
    if (isSeeking) return;
    const activeMedia = getActivePlaybackMedia();
    if (isPlayableMedia(activeMedia) && activeMedia.duration) {
      seekBar.value = (activeMedia.currentTime / activeMedia.duration) * 100;
      const nextText = formatDurationSeconds(activeMedia.currentTime) + ' / ' + formatDurationSeconds(activeMedia.duration);
      if (timeDisplay.textContent !== nextText) {
        timeDisplay.textContent = nextText;
      }
      videoSeekBarContainer.updatePlayStateIcon();
    }
  };

  videoSeekBarContainer.updatePlayModeUI = updatePlayModeButtonUI;

  return videoSeekBarContainer;
}

export function setVideoSeekBarVisibility(visible) {
  const activeMedia = getActivePlaybackMedia();
  if (!visible || !isPlayableMedia(activeMedia)) {
    closeVolumePopup();
    if (videoSeekBarContainer) {
      videoSeekBarContainer.style.display = 'none';
    }
    return;
  }

  ensureVideoSeekBarContainer();
  if (videoSeekBarContainer.updatePlayStateIcon) {
    videoSeekBarContainer.updatePlayStateIcon();
  }
  if (videoSeekBarContainer.updateVolumeControls) {
    videoSeekBarContainer.updateVolumeControls();
  }
  if (videoSeekBarContainer.updatePlayModeUI) {
    videoSeekBarContainer.updatePlayModeUI();
  }
  if (videoSeekBarContainer.updateProgress) {
    videoSeekBarContainer.updateProgress();
  }
  videoSeekBarContainer.style.display = 'flex';
}

export function toggleVideoSeekBar() {
  const activeMedia = getActivePlaybackMedia();
  if (!isPlayableMedia(activeMedia)) {
    showToast("動画・音声ではありません", 3000, 'warning');
    return;
  }

  ensureVideoSeekBarContainer();
  const isVisible = videoSeekBarContainer.style.display === 'flex';
  setVideoSeekBarVisibility(!isVisible);
}

// ============================================================================
// メディア再生終了（ended）イベントハンドラ
// ============================================================================

let _onMediaEndedNextCallback = null;

/**
 * 自動送りモード時の「次のファイルへ進む」処理ハンドラを登録する
 * @param {Function} callback
 */
export function setMediaEndedNextHandler(callback) {
  _onMediaEndedNextCallback = callback;
}

if (typeof document !== 'undefined') {
  document.addEventListener('ended', (e) => {
    const activeMedia = getActivePlaybackMedia();
    if (e.target === activeMedia) {
      if (videoSeekBarContainer && videoSeekBarContainer.style.display !== 'none') {
        videoSeekBarContainer.updatePlayStateIcon();
      }

      const mediaType = isCurrentlyDisplayingAudio() ? 'audio' : 'video';
      const mode = getSavedViewerPlayMode(mediaType);
      if (mode === PLAY_MODES.AUTO_NEXT) {
        if (typeof _onMediaEndedNextCallback === 'function') {
          _onMediaEndedNextCallback();
        }
      }
    }
  }, true);
}

// ============================================================================
// メタデータオーバーレイ（I キー）
// ============================================================================

const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
let _lastCopiedOverlayTags = '';
let _metadataOverlayHideTimer = null;
let currentMetadataSeq = 0;

/**
 * メタデータオーバーレイのDOM要素を生成または取得します。
 * @returns {HTMLElement}
 */
export function createMetadataOverlay() {
  let overlay = document.getElementById('viewer-metadata-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'viewer-metadata-overlay';
    overlay.className = 'viewer-metadata-overlay';

    const header = document.createElement('div');
    header.className = 'viewer-metadata-header';

    const title = document.createElement('span');
    title.className = 'viewer-metadata-title';
    title.textContent = 'メタデータ';

    header.appendChild(title);

    const content = document.createElement('div');
    content.id = 'viewer-metadata-content';
    content.className = 'viewer-metadata-content inspector-data';

    overlay.appendChild(header);
    overlay.appendChild(content);

    // 画像操作やドラッグへのイベント伝播を防止
    overlay.addEventListener('click', async (e) => {
      e.stopPropagation();

      // ドラッグ等によるテキスト選択が行われている場合は、個別タグクリックコピーを発火させない
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
        return;
      }

      // セクション全体のコピーボタン処理
      const copyBtn = e.target.closest('.diff-copy-btn');
      if (copyBtn) {
        const text = copyBtn.getAttribute('data-copy-text');
        if (text) {
          await navigator.clipboard.writeText(text);
          showToast('クリップボードにコピーしました', 2000, 'success');
          glowElement(copyBtn);
        }
        return;
      }

      // 個別タグチップのクリックコピー処理（Ctrl+クリックで追加コピー）
      const tagEl = e.target.closest('.diff-tag');
      if (tagEl) {
        const text = tagEl.textContent;
        if (text) {
          let textToCopy = text;
          let isAppended = false;
          if (e.ctrlKey && _lastCopiedOverlayTags) {
            isAppended = true;
            const currentTags = _lastCopiedOverlayTags.split(',').map(t => t.trim()).filter(t => t);
            if (!currentTags.includes(text)) {
              textToCopy = _lastCopiedOverlayTags + ', ' + text;
            } else {
              textToCopy = _lastCopiedOverlayTags;
            }
          }
          _lastCopiedOverlayTags = textToCopy;
          await navigator.clipboard.writeText(textToCopy);
          const displayTxt = textToCopy.length > 20 ? textToCopy.substring(0, 20) + '...' : textToCopy;
          const prefix = isAppended ? '追加コピーしました: ' : 'コピーしました: ';
          showToast(`${prefix}${displayTxt}`, 2000, 'success');
          glowElement(tagEl);
        }
      }
    });

    /**
     * プロンプトボックス内のドラッグ選択コピー時のフォーマット調整:
     * メイン画面のインスペクター・Diff画面と同一の挙動とし、
     * タグ単位で選択されたテキストをカンマ区切りでクリップボードに格納する。
     */
    overlay.addEventListener('copy', (e) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const promptLook = e.target.closest('.prompt-look');
      if (!promptLook) return;

      const clone = selection.getRangeAt(0).cloneContents();
      const tempDiv = document.createElement('div');
      tempDiv.appendChild(clone);
      const tags = tempDiv.querySelectorAll('.diff-tag');
      if (tags.length > 0) {
        tags.forEach(tag => { tag.textContent = tag.textContent + ", "; });
        let copiedText = tempDiv.textContent.replace(/,\s*$/, '').trim();
        e.clipboardData.setData('text/plain', copiedText);
        e.preventDefault();
      }
    });

    overlay.addEventListener('dblclick', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('mouseup', (e) => e.stopPropagation());
    overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    document.body.appendChild(overlay);
  }
  return overlay;
}

/**
 * メイン画面のインスペクターと同一構造のセクションDOM要素を生成します。
 * @param {string} title
 * @param {*} value
 * @param {boolean} [isParam=false]
 * @param {boolean} [isRaw=false]
 * @param {string|null} [subLabel=null]
 * @returns {HTMLElement}
 */
function createInspectorSectionElement(title, value, isParam = false, isRaw = false, subLabel = null, isPosition = false, sectionObj = null, filePath = null) {
  const section = document.createElement('div');
  section.className = 'inspector-section inspector-section-block';

  const h3 = document.createElement('h3');
  h3.className = 'inspector-section-h3';

  const titleWrapper = document.createElement('span');
  titleWrapper.className = 'inspector-title-wrapper';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  titleWrapper.appendChild(titleSpan);

  if (subLabel && subLabel !== 'Text to Image') {
    const subWrapper = document.createElement('span');
    subWrapper.className = 'sublabel-tags-wrapper';
    const labels = subLabel.split(' + ');
    labels.forEach(lbl => {
      let modifier = '';
      if (lbl.includes('Inpainting')) modifier = ' sublabel-tag--inpainting';
      else if (lbl.includes('Vibe Transfer')) modifier = ' sublabel-tag--vibe';
      else if (lbl.includes('Character Reference')) modifier = ' sublabel-tag--char-ref';
      else if (lbl.includes('Image to Image') || lbl.includes('Img2Img')) modifier = ' sublabel-tag--img2img';
      else if (lbl === 'Alpha Channel') modifier = ' sublabel-tag--alpha-channel';
      else modifier = ' sublabel-tag--muted';

      const span = document.createElement('span');
      span.className = `sublabel-tag${modifier}`;
      span.textContent = `[${lbl}]`;
      subWrapper.appendChild(span);
    });
    titleWrapper.appendChild(subWrapper);
  }

  h3.appendChild(titleWrapper);

  const isCopyable = !!sectionObj?.copyable;
  if (isCopyable) {
    const copyWrapper = document.createElement('div');
    copyWrapper.className = 'inspector-copy-wrapper';

    const copyBtn = document.createElement('span');
    copyBtn.className = 'diff-copy-btn';
    copyBtn.title = 'コピー';
    copyBtn.setAttribute('data-copy-text', typeof value === 'object' ? JSON.stringify(value) : String(value));
    copyBtn.innerHTML = COPY_ICON_SVG;
    copyWrapper.appendChild(copyBtn);

    h3.appendChild(copyWrapper);
  }

  section.appendChild(h3);

  const box = document.createElement('div');
  box.tabIndex = -1;

  if (isPosition && sectionObj && sectionObj.charPositions) {
    box.className = 'prompt-look inspector-position-block';

    // モード表示（四角い枠線なしのテキスト表示）
    const isAuto = sectionObj.positionMode === 'AIにおまかせ' || sectionObj.useCoords === false;
    const modeText = sectionObj.positionMode || (isAuto ? 'AIにおまかせ' : 'カスタム');
    const modeRow = document.createElement('div');
    modeRow.className = 'inspector-position-mode-row';
    const modeTag = document.createElement('span');
    modeTag.className = `inspector-position-mode-text ${isAuto ? 'inspector-position-mode--auto' : 'inspector-position-mode--custom'}`;
    modeTag.textContent = modeText;
    modeRow.appendChild(modeTag);
    box.appendChild(modeRow);

    // 「AIにおまかせ」の場合はその旨のみ表示し、画像や座標情報は表示しない
    if (!isAuto && sectionObj.charPositions && sectionObj.charPositions.length > 0) {
      const mapWrapper = document.createElement('div');
      mapWrapper.className = 'inspector-position-map-wrapper';

      const map = document.createElement('div');
      map.className = 'inspector-position-map';

      const imgWidth = sectionObj.width;
      const imgHeight = sectionObj.height;
      if (imgWidth && imgHeight) {
        map.style.aspectRatio = `${imgWidth} / ${imgHeight}`;
      }

      // 背景画像: 現在表示中のビューアー画像
      const currentImg = document.getElementById('viewer-img');
      const thumbUrl = (currentImg && currentImg.src) || (filePath && window.veloceAPI && window.veloceAPI.convertFileSrc(filePath)) || '';
      if (thumbUrl) {
        const bgImg = document.createElement('img');
        bgImg.className = 'inspector-position-bg-img';
        bgImg.src = thumbUrl;
        bgImg.onload = () => {
          if (bgImg.naturalWidth && bgImg.naturalHeight && (!sectionObj.width || !sectionObj.height)) {
            map.style.aspectRatio = `${bgImg.naturalWidth} / ${bgImg.naturalHeight}`;
          }
        };
        map.appendChild(bgImg);
      }

      const coordsContainer = document.createElement('div');
      coordsContainer.className = 'inspector-position-coords';

      sectionObj.charPositions.forEach((cp) => {
        const charNum = cp.index;
        const markerIndex = ((charNum - 1) % 8) + 1;
        const colorClass = `char-marker-${markerIndex}`;

        cp.centers.forEach((center) => {
          const marker = document.createElement('div');
          marker.className = `inspector-position-marker ${colorClass}`;
          marker.style.left = `${(center.x * 100).toFixed(2)}%`;
          marker.style.top = `${(center.y * 100).toFixed(2)}%`;
          marker.textContent = String(charNum);
          map.appendChild(marker);

          const coordItem = document.createElement('div');
          coordItem.className = 'inspector-coord-item';

          const badge = document.createElement('span');
          badge.className = `inspector-coord-badge ${colorClass}`;
          badge.textContent = String(charNum);

          const text = document.createElement('span');
          text.className = 'inspector-coord-text';
          const xPct = (center.x * 100).toFixed(1);
          const yPct = (center.y * 100).toFixed(1);
          text.textContent = `X: ${xPct}%, Y: ${yPct}% (${center.x.toFixed(3)}, ${center.y.toFixed(3)})`;

          coordItem.appendChild(badge);
          coordItem.appendChild(text);
          coordsContainer.appendChild(coordItem);
        });
      });

      mapWrapper.appendChild(map);
      box.appendChild(mapWrapper);
      box.appendChild(coordsContainer);
    }
  } else if (isRaw || (sectionObj && sectionObj.isText)) {
    box.className = (sectionObj && sectionObj.isText) ? 'prompt-look text-box' : 'prompt-look raw-box';
    box.textContent = String(value);
  } else if (isParam) {
    box.className = 'prompt-look param-box';
    box.textContent = String(value);
  } else {
    box.className = 'prompt-look';
    const tags = parsePromptTags(String(value));
    for (const t of tags) {
      const tag = document.createElement('span');
      tag.className = 'diff-tag common';
      tag.textContent = t;
      box.appendChild(tag);
    }
  }

  section.appendChild(box);
  return section;
}

/**
 * メタデータオーバーレイの表示/非表示をバウンス・ポップアニメーションとともに切り替えます。
 * @param {boolean} [forceState]
 */
export function toggleMetadataOverlay(forceState) {
  const newState = (typeof forceState === 'boolean') ? forceState : !viewerState.isMetadataVisible;
  viewerState.isMetadataVisible = newState;

  const overlay = createMetadataOverlay();
  const controls = document.getElementById('window-controls');

  if (viewerState.isMetadataVisible) {
    if (_metadataOverlayHideTimer) {
      clearTimeout(_metadataOverlayHideTimer);
      _metadataOverlayHideTimer = null;
    }
    document.body.classList.add('metadata-open');
    if (controls) controls.classList.add('metadata-open');

    overlay.classList.remove('prompt-hide');
    overlay.classList.add('show');
    // アニメーション再開のためのリフロー強制
    overlay.classList.remove('prompt-pop');
    void overlay.offsetWidth;
    overlay.classList.add('prompt-pop');

    updateMetadataOverlay();
  } else {
    document.body.classList.remove('metadata-open');
    if (controls) controls.classList.remove('metadata-open');

    const wasVisible = overlay.classList.contains('show');
    overlay.classList.remove('show');
    overlay.classList.remove('prompt-pop');

    if (wasVisible) {
      overlay.classList.remove('prompt-hide');
      void overlay.offsetWidth;
      overlay.classList.add('prompt-hide');

      if (_metadataOverlayHideTimer) clearTimeout(_metadataOverlayHideTimer);
      _metadataOverlayHideTimer = setTimeout(() => {
        overlay.classList.remove('prompt-hide');
        _metadataOverlayHideTimer = null;
      }, 220);
    } else {
      overlay.classList.remove('prompt-hide');
    }
  }
}

/**
 * 現在表示中の画像のメタデータを取得し、オーバーレイに描画します。
 */
export async function updateMetadataOverlay() {
  if (!viewerState.isMetadataVisible) return;
  const overlay = createMetadataOverlay();
  const contentEl = document.getElementById('viewer-metadata-content');
  if (!contentEl) return;

  const filePath = viewerState.currentImagePath;
  if (!filePath) {
    contentEl.innerHTML = '<div class="viewer-meta-empty">画像が選択されていません</div>';
    return;
  }

  const seq = ++currentMetadataSeq;
  contentEl.innerHTML = '<div class="viewer-meta-loading">読み込み中...</div>';

  try {
    let rawMeta = null;
    if (window.veloceAPI && window.veloceAPI.parseMetadata) {
      rawMeta = await window.veloceAPI.parseMetadata(filePath);
    }
    if (seq !== currentMetadataSeq) return; // シーケンス不一致の破棄

    const meta = rawMeta || {};
    const filename = filePath.split(/[/\\]/).pop();
    const mediaEl = viewerUI.elements.viewerImg;
    const natW = mediaEl ? (mediaEl.naturalWidth || mediaEl.videoWidth || 0) : 0;
    const natH = mediaEl ? (mediaEl.naturalHeight || mediaEl.videoHeight || 0) : 0;

    const file = {
      path: filePath,
      name: filename,
      width: (meta.width && meta.width > 0) ? meta.width : natW,
      height: (meta.height && meta.height > 0) ? meta.height : natH
    };

    const data = extractMetadataFields(file, meta);
    const sections = buildInspectorSections(data);

    // 有効な値を持つセクションを抽出
    const visibleSections = sections.filter(s => s && s.value !== null && s.value !== undefined && s.value !== '' && s.value !== '-');

    if (visibleSections.length === 0) {
      contentEl.innerHTML = '<div class="viewer-meta-empty">メタデータが見つかりません</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    // 1. ファイル名セクション（メイン画面と同一形式）
    fragment.appendChild(createInspectorSectionElement('ファイル名', filename, true));

    // 2. メタデータ各セクション
    for (const sec of visibleSections) {
      fragment.appendChild(createInspectorSectionElement(
        sec.title,
        sec.value,
        !!sec.isParam,
        !!sec.isRaw,
        sec.subLabel || null,
        !!sec.isPosition,
        sec,
        filePath
      ));
    }

    const spacer = document.createElement('div');
    spacer.className = 'inspector-bottom-spacer';
    fragment.appendChild(spacer);

    contentEl.replaceChildren(fragment);
  } catch (err) {
    console.error('Failed to update metadata overlay:', err);
    if (seq !== currentMetadataSeq) return;
    contentEl.innerHTML = '<div class="viewer-meta-empty">メタデータの読み込みに失敗しました</div>';
  }
}
