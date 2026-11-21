// ============================================================================
// Veloce - Independent Image Viewer Controller (viewer.js)
// ============================================================================
// 本モジュールは、軽量・高速な独立画像ビューアーウィンドウの表示制御を担う。
//
// コア最適化アーキテクチャ:
// 1. Window Pool (ウィンドウの再利用):
//    ウィンドウ生成・破棄に伴うGCおよびWebView2初期化遅延を排除するため、
//    非表示状態で待機しているプールウィンドウを再利用し、'viewer-init-session' で初期化。
// 2. 二重バッファリング DOM Swap:
//    画像切り替え時の黒画面やチラつき（フリッカー）を防止するため、
//    次画像のデコード完了まで旧画像を表示し続け、完了と同時にO(1)でDOM置換。
// 3. 先行プリロード (Preload Pipeline):
//    前後画像のオフスクリーンImageオブジェクトをバックグラウンド生成し、
//    ページ送り時の遅延ゼロを実現。
// 4. SVGアンシャープマスクフィルター:
//    小数倍率ズーム時でもボケを抑制し、ディテールを保った鮮明なレンダリングを提供。
// ============================================================================

import { viewerState } from './viewer-state.js';
import {
  ViewerUI,
  viewerUI,
  showToast,
  readViewerSetting,
  writeViewerSetting,
  getSavedViewerVolume,
  getSavedViewerMuted,
  applyVolumeSettingsToMedia,
  PLAY_MODES,
  PLAY_MODE_ORDER,
  PLAY_MODE_INFO,
  getSavedViewerPlayMode,
  saveViewerPlayMode,
  applyPlayModeToMedia,
  setCurrentAudioElement,
  getCurrentAudioElement,
  isAudioPlaceholderMedia,
  getMediaWidth,
  getMediaHeight,
  shouldShowSeekBarForMedia,
  isPlayableMedia,
  getActivePlaybackMedia,
  isCurrentlyDisplayingAudio,
  isCurrentlyDisplayingAudioPlaceholder,
  updatePlayModeButtonUI,
  cycleViewerPlayMode,
  adjustActiveMediaVolumeByPercent,
  seekActiveMediaBySeconds,
  stopAndDiscardAudio,
  isVolumePopupOpen,
  setVolumePopupOpen,
  closeVolumePopup,
  isDefaultSeekBarEnabled,
  ensureVideoSeekBarContainer,
  setVideoSeekBarVisibility,
  toggleVideoSeekBar,
  setMediaEndedNextHandler,
  createMetadataOverlay,
  toggleMetadataOverlay,
  updateMetadataOverlay
} from './viewer-ui.js';
import { debounce, blockDevtoolsShortcuts, getStreamUrl, applyGlowEffect, isVideoFile, isAudioFile, getAudioCoverUrl, AUDIO_PLACEHOLDER_URL, formatDurationSeconds } from '../common/utils.js';
import { isSameOrSubdirectory, replaceDirectoryPrefix } from '../common/path-utils.js';

blockDevtoolsShortcuts();

/**
 * ビューアー全体のテーマを適用します。
 * 'light' の場合は <html> に data-theme="light" を付与し、
 * 'dark' または未指定の場合は属性を削除して規定のダークモードを維持します。
 * @param {'dark'|'light'} [theme='dark']
 */
export function applyViewerTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// 起動時に同期的にテーマ属性を確定させ、初回描画時のスタイル再計算を防止する
const initialViewerTheme = (typeof window !== 'undefined' && window.SettingsStore
  ? window.SettingsStore.getItem('theme')
  : (typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null)) === 'light' ? 'light' : 'dark';
applyViewerTheme(initialViewerTheme);

let viewerRatings = {};

export function getViewerRatings() {
  return viewerRatings;
}

export function setViewerRatings(ratings) {
  viewerRatings = ratings || {};
}

const CONFIG = {
  ZOOM_STEP: 1.1,         // マウスホイールでのズーム倍率
  MIN_ZOOM: 0.1,          // 最小ズーム倍率 (10%)
  MAX_ZOOM: 30.0,         // 最大ズーム倍率 (3000%)
  EDGE_THRESHOLD: 10,     // ウィンドウ端のリサイズ判定エリア(px)
  FOCUS_DELAY: 200,       // フォーカス時の誤クリック防止時間(ms)
  RESIZE_THROTTLE: 150    // リサイズイベントの間引き時間(ms)
};



window.addEventListener('focus', () => {
  // <video> / <audio> 要素の内部操作（再生・一時停止等）がウィンドウ focus を誘発するケースがある。
  // これを「フォーカス目的クリック」と誤判定して ignoreNextClick を立てないよう、
  // activeElement が VIDEO または AUDIO の場合は lastFocusTime を更新しない。
  if (document.activeElement && (document.activeElement.tagName === 'VIDEO' || document.activeElement.tagName === 'AUDIO')) return;
  viewerState.lastFocusTime = Date.now();
});

let currentViewerImg = document.getElementById('viewer-img');
let currentlyVisibleImg = currentViewerImg;
if (currentViewerImg) currentViewerImg.classList.add('mode-default');


/**
 * 音声ファイル（MP3）のカバー画像表示用 <img> 要素を生成する。
 * カバーが存在しない・読み込み失敗時は Lucide ベースのプレースホルダへ切り替える。
 * @param {string} filePath
 * @returns {HTMLImageElement}
 */
function createAudioCoverImageElement(filePath) {
  const img = document.createElement('img');
  img.decoding = 'async';
  img.dataset.audioPath = filePath;
  const coverUrl = getAudioCoverUrl(filePath);
  if (coverUrl) {
    img.addEventListener('error', () => {
      if (!img.classList.contains('audio-placeholder')) {
        img.classList.add('audio-placeholder');
        img.src = AUDIO_PLACEHOLDER_URL;
        if (img === currentlyVisibleImg) {
          img.addEventListener('load', () => {
            if (img === currentlyVisibleImg) {
              setZoomState(viewerState.isZoomed);
              viewerUI.updateImageRendering();
              resizeWindowToFitImage();
            }
          }, { once: true });
        }
      }
    }, { once: true });
    img.src = coverUrl;
  } else {
    img.classList.add('audio-placeholder');
    img.src = AUDIO_PLACEHOLDER_URL;
  }
  return img;
}

/**
 * プリロードキャッシュ内の全画像・動画リソースを確実に解放してキャッシュを消去
 */
function clearPreloadCache() {
  for (const cached of viewerState.preloadCache.values()) {
    if (cached && cached.img) {
      if (cached.img === currentlyVisibleImg || cached.img === currentViewerImg) {
        continue;
      }
      if (cached.img.tagName === 'VIDEO') {
        cached.img.pause();
        cached.img.removeAttribute('src');
        cached.img.load();
      }
      if (typeof cached.img.remove === 'function') cached.img.remove();
    }
  }
  viewerState.preloadCache.clear();
}



/**
 * 指定した画像要素にアルファチャンネルオーバーレイ（メタデータ領域ハイブリッド）を適用
 * @param {HTMLImageElement} imgEl - 対象の画像要素
 * @param {string} filePath - 画像ファイルパス
 * @param {boolean} [isAutoFollow=false] - 画像切り替え時の自動追従呼び出しフラグ
 */
export async function applyAlphaOverlay(imgEl, filePath, isAutoFollow = false) {
  if (!filePath || !window.veloceAPI || !window.veloceAPI.getAlphaOverlayImage) return;

  try {
    let result = viewerState.overlayCache.get(filePath);
    if (!result) {
      result = await window.veloceAPI.getAlphaOverlayImage(filePath);
      if (result) {
        viewerState.overlayCache.set(filePath, result);
      }
    }

    // 非同期通信完了時に表示中パスが変わっている、またはオーバーレイモードが解除されていたら適用を破棄
    if (viewerState.currentImagePath !== filePath || !viewerState.isAlphaOverlayMode) {
      return;
    }

    if (!result || !result.data_url) {
      if (!isAutoFollow) {
        if (viewerState.originalSrc && imgEl) {
          imgEl.src = viewerState.originalSrc;
          viewerState.originalSrc = null;
        }
        viewerState.isAlphaOverlayMode = false;
      }
      return;
    }

    // 元画像のsrcを退避（まだ未退避の場合のみ）
    if (!viewerState.originalSrc) {
      viewerState.originalSrc = imgEl.src;
    }

    imgEl.src = result.data_url;
    viewerState.isAlphaOverlayMode = true;
  } catch (err) {
    console.error('Failed to apply alpha overlay:', err);
    if (!isAutoFollow) {
      if (viewerState.originalSrc && imgEl) {
        imgEl.src = viewerState.originalSrc;
        viewerState.originalSrc = null;
      }
      viewerState.isAlphaOverlayMode = false;
    }
  }
}

/**
 * アルファチャンネルオーバーレイ（メタデータ領域ハイブリッド）のトグル切り替え
 * @param {HTMLImageElement} [customImgEl=null] - 任意の対象画像要素（未指定時は表示中要素を自動解決）
 */
export async function toggleAlphaOverlayMode(customImgEl = null) {
  if (isCurrentlyDisplayingAudio()) {
    return;
  }
  const imgEl = customImgEl || currentViewerImg || (viewerUI && viewerUI.elements && viewerUI.elements.viewerImg) || document.getElementById('viewer-img');
  if (!imgEl || imgEl.tagName !== 'IMG' || (imgEl.dataset && imgEl.dataset.audioPath)) {
    return;
  }

  const currentPath = viewerState.currentImagePath;
  if (!currentPath) return;

  viewerState.isAlphaOverlayMode = !viewerState.isAlphaOverlayMode;

  if (!viewerState.isAlphaOverlayMode) {
    if (viewerState.originalSrc) {
      imgEl.src = viewerState.originalSrc;
      viewerState.originalSrc = null;
    }
    return;
  }

  await applyAlphaOverlay(imgEl, currentPath, false);
}

/**
 * 現在表示中の画像・動画要素のリソースを即座に解放
 */
function cleanupCurrentImage() {
  closeVolumePopup();
  stopAndDiscardAudio();
  if (viewerState.isAlphaOverlayMode && viewerState.originalSrc && currentlyVisibleImg) {
    currentlyVisibleImg.src = viewerState.originalSrc;
  }
  viewerState.originalSrc = null;
  if (currentlyVisibleImg) {
    if (currentlyVisibleImg.tagName === 'VIDEO') {
      currentlyVisibleImg.pause();
      currentlyVisibleImg.removeAttribute('src');
      currentlyVisibleImg.load();
    }
    currentlyVisibleImg.remove();
    currentlyVisibleImg = null;
  }
}

/**
 * SVGシャープネスフィルターの初期化
 * 小数倍率で拡大した際にも滑らかさを保ちつつ輪郭を強調するためのフィルターを生成します。
 */
function initUnsharpFilter() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svgElement = document.createElementNS(svgNS, "svg");
  svgElement.setAttribute("class", "unsharp-svg");

  const unsharpFilter = document.createElementNS(svgNS, "filter");
  unsharpFilter.id = "unsharp-filter";

  const feConvolveUnsharp = document.createElementNS(svgNS, "feConvolveMatrix");
  // stdDev=0.8 のガウスぼかしを 0.8 倍して引き算し、中心を 1.8 倍する数学的近似行列
  feConvolveUnsharp.setAttribute("order", "5 5");
  feConvolveUnsharp.setAttribute("kernelMatrix", 
    " 0     -0.008 -0.018 -0.008  0 " +
    "-0.008 -0.078 -0.170 -0.078 -0.008 " +
    "-0.018 -0.170  2.128 -0.170 -0.018 " +
    "-0.008 -0.078 -0.170 -0.078 -0.008 " +
    " 0     -0.008 -0.018 -0.008  0"
  );
  feConvolveUnsharp.setAttribute("preserveAlpha", "true");

  unsharpFilter.appendChild(feConvolveUnsharp);
  svgElement.appendChild(unsharpFilter);

  document.body.appendChild(svgElement);
}
initUnsharpFilter();

/**
 * viewer-init-session イベントのペイロードを viewerState へ反映する。
 * 前後チャンク（chunk / chunkStart）が同梱されている場合は該当範囲を初期化し、
 * 隣接パス解決のための get_viewer_image IPC 往復を省略する。
 * チャンクを含まない旧形式ペイロードや数値ペイロードにも対応する。
 * @param {number|{index?: number, path?: string|null, total?: number, chunkStart?: number, chunk?: string[]}} payload
 */
export function applyViewerInitSessionPayload(payload) {
  let newIndex = 0;
  let targetPath = null;
  let total = 0;
  let chunkStart = null;
  let chunk = null;

  if (typeof payload === 'number') {
    newIndex = payload;
  } else if (payload && typeof payload === 'object') {
    newIndex = typeof payload.index === 'number' ? payload.index : 0;
    targetPath = payload.path || null;
    total = typeof payload.total === 'number' ? payload.total : 0;
    if (Array.isArray(payload.chunk) && typeof payload.chunkStart === 'number') {
      chunkStart = payload.chunkStart;
      chunk = payload.chunk;
    }
  }

  viewerState.currentIndex = newIndex;
  viewerState.isAlphaOverlayMode = false;
  viewerState.originalSrc = null;
  viewerState.overlayCache.clear();
  viewerState.lastDirection = 1;
  viewerState.paths = total > 0 ? new Array(total).fill(null) : null;
  viewerState.currentImagePath = targetPath;
  viewerState.totalImages = total;

  if (viewerState.paths && chunk && chunkStart !== null) {
    for (let i = 0; i < chunk.length; i++) {
      const pos = chunkStart + i;
      if (pos >= 0 && pos < viewerState.paths.length) {
        viewerState.paths[pos] = chunk[i];
      }
    }
  }
  if (viewerState.paths && targetPath && viewerState.currentIndex >= 0 && viewerState.currentIndex < viewerState.paths.length) {
    viewerState.paths[viewerState.currentIndex] = targetPath;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
    function applyViewerInitialData() {
      // IPC通信のラグを隠蔽するため、LocalStorageから初期データを取得して即座に描画を開始する
      const initialDataJson = localStorage.getItem('viewerInitialData');
      if (initialDataJson) {
        try {
          const initialData = JSON.parse(initialDataJson);
          // indexが一致している場合のみ適用（別ウィンドウのstaleデータを防止）
          if (typeof initialData.index !== 'number' || initialData.index === viewerState.currentIndex) {
            viewerState.currentImagePath = initialData.path;
            viewerState.totalImages = initialData.total;
            if (typeof initialData.index === 'number') {
              viewerState.currentIndex = initialData.index;
            }
            
            if (!viewerState.paths || viewerState.paths.length !== initialData.total) {
              viewerState.paths = new Array(initialData.total).fill(null);
            }
            // paths に格納しておくことで loadImage() → getImagePath() の冗長 IPC 往復を排除する (#6)
            if (viewerState.paths && viewerState.currentIndex >= 0) {
              viewerState.paths[viewerState.currentIndex] = initialData.path;
            }
            document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
          }
        } catch (e) {}
        localStorage.removeItem('viewerInitialData');
      }
    }

    const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen)
      || (window.__TAURI__ && window.__TAURI__.tauri && window.__TAURI__.tauri.listen)
      || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.listen);
    let serverInfoPromise = Promise.resolve();
    let hasInitSessionReceived = false;

    // プール再利用時のイベント取りこぼしを防ぐため、他の await より前に
    // viewer-init-session および viewer-load-image リスナーを最優先で登録する
    if (listen) {
      await Promise.all([
        listen('viewer-init-session', async (event) => {
          hasInitSessionReceived = true;
          await serverInfoPromise;

          // プールされたウィンドウが再利用されるため、以前の状態を完全にリセットする
          const sessionTheme = (typeof window !== 'undefined' && window.SettingsStore
            ? window.SettingsStore.getItem('theme')
            : (typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null)) === 'light' ? 'light' : 'dark';
          applyViewerTheme(sessionTheme);
          cleanupCurrentImage();
          clearPreloadCache();
          applyViewerInitSessionPayload(event.payload);
          applyViewerInitialData();

          // リセット後、loadImageが確実に新しい画像をロード
          await loadImage();
        }),
        listen('viewer-load-image', async (event) => {
          await serverInfoPromise;
          const newIndex = event.payload;
          viewerState.currentIndex = parseInt(newIndex, 10);

          // Single Window Mode (DOM Pool): clear cache and load new image
          clearPreloadCache();
          await loadImage();
        }),
      ]);
    }

    // リスナー登録完了を Rust 側へ通知（viewer_pool_0 の場合のみプール準備完了フラグが有効化される）
    if (window.veloceAPI && window.veloceAPI.notifyViewerPoolReady) {
      Promise.resolve(window.veloceAPI.notifyViewerPoolReady()).catch(() => {});
    }

    // ローカルメディアサーバーのポート番号・セッショントークンを並列取得する
    serverInfoPromise = (async () => {
      try {
        if (window.veloceAPI) {
          const portPromise = window.veloceAPI.getVideoServerPort
            ? Promise.resolve(window.veloceAPI.getVideoServerPort())
            : Promise.resolve(undefined);
          const tokenPromise = window.veloceAPI.getVideoServerToken
            ? Promise.resolve(window.veloceAPI.getVideoServerToken())
            : Promise.resolve(undefined);
          const [port, token] = await Promise.all([portPromise, tokenPromise]);
          if (port !== undefined) {
            window.videoServerPort = port;
          }
          if (token !== undefined) {
            window.videoServerToken = token;
          }
        }
      } catch (e) {
        console.warn("Failed to get video server port", e);
      }
    })();
    await serverInfoPromise;

    const urlParams = new URLSearchParams(window.location.search);
    const indexParam = urlParams.get('index');
    if (indexParam !== null) {
      viewerState.currentIndex = parseInt(indexParam, 10);
    }

    // ウィンドウが最大化されているかを非同期で確認しアイコンを更新する
    if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
      window.veloceAPI.isViewerMaximized().then(isMax => {
        if (isMax) {
          const maxBtn = document.getElementById('window-max-btn');
          if (maxBtn) maxBtn.innerHTML = ViewerUI.ICONS.RESTORE;
        }
      }).catch(() => {});
    }

    if (window.veloceAPI && window.veloceAPI.getAllRatings) {
      window.veloceAPI.getAllRatings().then(ratings => {
        viewerRatings = ratings || {};
        if (typeof updateRatingDisplay === 'function') updateRatingDisplay();
      }).catch(() => {});
    }

    const pathsJson = localStorage.getItem('viewerPaths');
    let initialTotal = 0;
    if (pathsJson) {
      try {
        const parsedPaths = JSON.parse(pathsJson);
        const startIndexStr = localStorage.getItem('viewerStartIndex');
        if (startIndexStr) {
          const startIndex = parseInt(startIndexStr, 10);
          const initialData = JSON.parse(localStorage.getItem('viewerInitialData') || '{}');
          initialTotal = initialData.total || parsedPaths.length;
          const fullPaths = new Array(initialTotal).fill(null);
          for (let i = 0; i < parsedPaths.length; i++) fullPaths[startIndex + i] = parsedPaths[i];
          viewerState.paths = fullPaths;
        } else {
          viewerState.paths = parsedPaths;
        }
      } catch (e) {}
      localStorage.removeItem('viewerPaths');
      localStorage.removeItem('viewerStartIndex');
    }

    // 画像のロードイベントを初期化時に1度だけ設定
    if (viewerUI.elements.viewerImg) {
      viewerUI.elements.viewerImg.decoding = 'async'; // メインスレッドをブロックさせないため非同期でデコードする
      viewerUI.elements.viewerImg.onload = async () => {
        setZoomState(viewerState.isZoomed);
        viewerUI.updateImageRendering();
        resizeWindowToFitImage();
        if (!isViewerWindowShown && window.veloceAPI && window.veloceAPI.showWindow) {
          isViewerWindowShown = true;
          await window.veloceAPI.showWindow();
        }
      };
    }

    if (!hasInitSessionReceived) {
      applyViewerInitialData();
      loadImage();
    }

    if (listen) {
      listen('rating-changed', (event) => {
        const { path, rating } = event.payload || {};
        if (!path) return;
        if (rating === 0 || viewerRatings[path] === rating) {
          delete viewerRatings[path];
        } else {
          viewerRatings[path] = rating;
        }
        if (viewerState.currentImagePath === path) {
          if (typeof updateRatingDisplay === 'function') updateRatingDisplay();
        }
      });
      listen('ratings-batch-changed', (event) => {
        const entries = event.payload;
        if (!Array.isArray(entries)) return;
        let shouldUpdate = false;
        for (const item of entries) {
          const { path, rating } = item || {};
          if (!path) continue;
          if (rating === 0 || viewerRatings[path] === rating) {
            delete viewerRatings[path];
          } else {
            viewerRatings[path] = rating;
          }
          if (viewerState.currentImagePath === path) {
            shouldUpdate = true;
          }
        }
        if (shouldUpdate && typeof updateRatingDisplay === 'function') {
          updateRatingDisplay();
        }
      });
      listen('viewers-arranged', () => {
        viewerState.isImmersiveArranged = true;
        resetZoomAndFit();
      });
      listen('close-viewer', () => {
        viewerState.paths = [];
        viewerState.currentImagePath = null;
        viewerState.totalImages = 0;
        cleanupCurrentImage();
        clearPreloadCache();
      });

      listen('viewer-file-renamed', (event) => {
        const payload = event.payload || {};
        const oldPath = payload.old_path || payload.oldPath;
        const newPath = payload.new_path || payload.newPath;
        handleViewerFileRenamed(oldPath, newPath);
      });

      listen('viewer-folder-renamed', (event) => {
        const payload = event.payload || {};
        const oldPath = payload.old_path || payload.oldPath;
        const newPath = payload.new_path || payload.newPath;
        handleViewerFolderRenamed(oldPath, newPath);
      });

      listen('viewer-list-updated', (event) => {
        const newPaths = event.payload || []; // 更新されたファイルパスのリスト
        viewerState.paths = newPaths;
        const newIndex = newPaths.indexOf(viewerState.currentImagePath);
        
        // ソートやフィルタで順序が変わったため、古いインデックスのキャッシュをすべて破棄
        clearPreloadCache();

        if (newIndex !== -1) {
          // 現在表示中の画像が新しいリスト内にも存在する場合、インデックスと総数を更新
          viewerState.currentIndex = newIndex;
          viewerState.totalImages = newPaths.length;
          document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
          preloadAdjacentImages(); // 新しいリスト順で前後の画像をプリロードし直す
        } else if (newPaths.length > 0) {
          // フィルタリング等で画像が消滅したが、他の画像は残っている場合
          viewerState.currentIndex = Math.min(viewerState.currentIndex, newPaths.length - 1);
          loadImage();
        } else {
          // リストが空になった場合（すべての画像が除外・削除された等）はビューアを閉じる
          if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
        }
      });
    }

    // --- ファイル名の表示設定の初期化と監視 ---
    const updateFilenameVisibility = () => {
      const show = (typeof window !== 'undefined' && window.SettingsStore
        ? window.SettingsStore.getItem('showViewerFilename')
        : localStorage.getItem('showViewerFilename')) !== 'false';
      
      const filenameEl = document.getElementById('window-filename-display');
      if (filenameEl) {
        filenameEl.style.display = show ? 'flex' : 'none';
      }

      const controlsEl = document.getElementById('window-controls');
      if (controlsEl) {
        controlsEl.classList.add('has-gradient');
      }
    };
    updateFilenameVisibility();

    // --- シークバーの規定表示設定の監視 ---
    const updateSeekBarDefaultVisibility = () => {
      const activeMedia = getActivePlaybackMedia();
      if (isPlayableMedia(activeMedia) && typeof setVideoSeekBarVisibility === 'function') {
        setVideoSeekBarVisibility(shouldShowSeekBarForMedia(activeMedia));
      }
    };

    window.addEventListener('storage', (e) => {
      if (e.key === 'showViewerFilename') updateFilenameVisibility();
      if (e.key === 'showViewerSeekBar') updateSeekBarDefaultVisibility();
      if (e.key === VIEWER_VOLUME_KEY || e.key === VIEWER_MUTED_KEY) {
        const activeMedia = getActivePlaybackMedia();
        if (isPlayableMedia(activeMedia)) {
          applyVolumeSettingsToMedia(activeMedia, activeMedia.tagName === 'VIDEO');
        }
        if (videoSeekBarContainer && typeof videoSeekBarContainer.updateVolumeControls === 'function') {
          videoSeekBarContainer.updateVolumeControls();
        }
      }
      if (e.key === 'theme') applyViewerTheme(e.newValue === 'light' ? 'light' : 'dark');
    });
});

// ============================================================================
// 2. Window & View Management
// ============================================================================

const VIEWER_ALIGN_CLASSES = [
  'viewer-body--align-center',
  'viewer-body--align-top',
  'viewer-body--align-left',
  'viewer-body--align-top-left'
];

function setViewerBodyAlignment(alignment) {
  document.body.classList.remove(...VIEWER_ALIGN_CLASSES);
  document.body.classList.add(`viewer-body--align-${alignment}`);
}

function clearViewerImgLayoutClasses(img) {
  img.classList.remove('is-zoomed', 'is-swapped', 'mode-immersive', 'mode-fit-window', 'mode-default');
  img.style.width = '';
  img.style.height = '';
  img.style.margin = '';
  img.style.transform = ''; // オーバースキャン補正をクリア
}

/**
 * 画像のズーム状態（100%表示か、画面フィットか）を設定する。
 * @param {boolean} zoomed - true: 100%表示, false: 画面にフィット
 */
function setZoomState(zoomed) {
  viewerState.isZoomed = zoomed;
  const img = viewerUI.elements.viewerImg;
  if (viewerState.isZoomed) {
    clearViewerImgLayoutClasses(img);
    img.classList.add('is-zoomed');
    img.style.width = `${getMediaWidth(img)}px`;
    img.style.height = `${getMediaHeight(img)}px`;
    viewerUI.setCursor('grab');
  } else {
    applyFitState();
  }
  updateFullscreenStyles();
}

/**
 * 現在の回転角度から、縦横が入れ替わっているかどうかを判定します。
 * @returns {boolean} 縦横が入れ替わっている場合は true
 */
function isRotationSwapped() {
  return Math.abs(viewerState.currentRotation) % 360 === 90 || Math.abs(viewerState.currentRotation) % 360 === 270;
}

/**
 * 現在の回転角度を考慮した画像の本来のサイズを取得します。
 * @returns {{width: number, height: number}} 回転を考慮した幅と高さ
 */
function getNaturalDimensions() {
  const swapped = isRotationSwapped();
  return {
    width: swapped ? getMediaHeight(viewerUI.elements.viewerImg) : getMediaWidth(viewerUI.elements.viewerImg),
    height: swapped ? getMediaWidth(viewerUI.elements.viewerImg) : getMediaHeight(viewerUI.elements.viewerImg)
  };
}

/**
 * ズーム状態とフィット状態を解除し、デフォルトの表示状態に戻します。
 */
function resetZoomAndFit() {
  viewerState.isZoomed = false;
  viewerState.isFitToWindow = false;
  viewerState.currentScale = 1.0;
  viewerState.currentTranslateX = 0;
  viewerState.currentTranslateY = 0;
  viewerUI.updateImageRendering();
  applyFitState();
  updateFullscreenStyles();
}

/**
 * 非ズーム時の表示状態（強制フィット拡大 か デフォルトの縮小のみ か）を適用する。
 */
function applyFitState() {
  if (viewerState.isZoomed) return;

  const img = viewerUI.elements.viewerImg;
  const isSwapped = isRotationSwapped();

  clearViewerImgLayoutClasses(img);
  img.classList.toggle('is-swapped', isSwapped);

  if (viewerState.isImmersiveArranged) {
    img.classList.add('mode-immersive');
  } else if (viewerState.isFitToWindow) {
    img.classList.add('mode-fit-window');
  } else {
    img.classList.add('mode-default');
  }

  viewerUI.setCursor('default');
  setViewerBodyAlignment('center');

  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
  document.documentElement.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
}

const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(debounce(async () => {
    // リサイズ中にIPC通信（await invoke）を行うとOSのメッセージループが詰まり
    // 例外0xc000041dでクラッシュするため、ブラウザのAPIを用いて判定する
    const isMax = window.innerWidth >= (window.screen ? window.screen.availWidth - 10 : 0) && window.innerHeight >= (window.screen ? window.screen.availHeight - 10 : 0);
    const maxBtn = document.getElementById('window-max-btn');
    if (maxBtn) {
      maxBtn.innerHTML = isMax ? ViewerUI.ICONS.RESTORE : ViewerUI.ICONS.MAXIMIZE;
    }

    const isFs = window.screen && window.innerHeight === window.screen.height;
    if (isFs && !viewerState.isFullscreen) {
      viewerState.isFullscreen = true;
      const overlay = document.getElementById('border-overlay');
      if (overlay) overlay.classList.add('border-hidden');
      const controls = document.getElementById('window-controls');
      if (controls) controls.classList.add('fs-hidden');
    } else if (!isFs && viewerState.isFullscreen) {
      viewerState.isFullscreen = false;
      viewerUI.applyBorderVisibility();
    }
    
    updateFullscreenStyles();
}, CONFIG.RESIZE_THROTTLE)) : null;

if (resizeObserver && typeof resizeObserver.observe === 'function' && typeof document !== 'undefined' && document.body) {
  resizeObserver.observe(document.body);
}

/**
 * フルスクリーン（100%表示）時のスタイルを更新する。
 * スクロールバーの表示・非表示や、画像の配置を決定する。
 */
function updateFullscreenStyles() {
  const img = viewerUI.elements.viewerImg;
  if (!viewerState.isZoomed) {
    setViewerBodyAlignment('center');
    img.style.margin = '0';
    window.scrollTo(0, 0);
    if (window.updateScaleDisplay) window.updateScaleDisplay();
    return;
  }

  const isSwapped = isRotationSwapped();

  if (isSwapped) {
    const marginY = (getMediaWidth(img) - getMediaHeight(img)) / 2;
    const marginX = (getMediaHeight(img) - getMediaWidth(img)) / 2;
    img.style.margin = `${marginY}px ${marginX}px`;
  } else {
    img.style.margin = '0';
  }

  const { width: imgWidth, height: imgHeight } = getNaturalDimensions();

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const overflowX = imgWidth > winW;
  const overflowY = imgHeight > winH;

  if (!overflowX && !overflowY) {
    setViewerBodyAlignment('center');
  } else if (!overflowX && overflowY) {
    setViewerBodyAlignment('top');
  } else if (overflowX && !overflowY) {
    setViewerBodyAlignment('left');
  } else {
    setViewerBodyAlignment('top-left');
    document.body.scrollLeft = (imgWidth - winW) / 2;
    document.body.scrollTop = (imgHeight - winH) / 2;
  }
  if (window.updateScaleDisplay) window.updateScaleDisplay();
}

// リサイズ後のフォーカス要求をデバウンスして、連続切り替え時の競合を防ぐ
const debouncedFocusWindow = debounce(() => {
  window.focus();
}, 200);

let _resizePending = false;

/**
 * 回転を考慮した画像本来のサイズに合わせてウィンドウをリサイズします。
 */
function resizeWindowToFitImage() {
  if (viewerState.isFullscreen || document.fullscreenElement || viewerState.isImmersiveArranged) return;

  const { width: natW, height: natH } = getNaturalDimensions();
  const maxWindowWidth = window.screen.width;
  const maxWindowHeight = window.screen.height - 1;

  let scale = Math.min(maxWindowWidth / natW, maxWindowHeight / natH, 1.0);
  
  // ズーム状態が維持されている場合は、そのスケールを反映させる
  if (viewerState.isZoomed) {
    scale = viewerState.currentScale;
  }

  let targetWidth = Math.floor(natW * scale);
  let targetHeight = Math.floor(natH * scale);

  // モニターサイズを超えないように制限
  targetWidth = Math.min(targetWidth, maxWindowWidth);
  targetHeight = Math.min(targetHeight, maxWindowHeight);

  if (window.updateScaleDisplay) setTimeout(window.updateScaleDisplay, 50);

  // 現在のウィンドウサイズと同じ場合は無駄なリサイズ要求をスキップする
  if (Math.abs(window.innerWidth - targetWidth) < 2 && Math.abs(window.innerHeight - targetHeight) < 2) {
    return;
  }

  if (_resizePending) return;

  if (window.veloceAPI && window.veloceAPI.setWindowSize) {
    _resizePending = true;
    window.veloceAPI.setWindowSize(targetWidth, targetHeight).then(() => {
      _resizePending = false;
      debouncedFocusWindow(); // 連続呼び出しによるフォーカス外れを防ぐためデバウンス処理を行う

      // ウィンドウの非クライアント領域（影・ボーダー）による数px誤差を
      // transform: scale() で補正し、画像端の黒い隙間をなくす。
      // ズーム中は補正しない（ユーザー操作の scale と競合するため）。
      if (!viewerState.isZoomed) {
        const img = viewerUI.elements.viewerImg;
        if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
          const actualW = window.innerWidth;
          const actualH = window.innerHeight;
          // ウィンドウに対して画像が占める割合を計算
          const imgAspect = targetWidth / targetHeight;
          const winAspect = actualW / actualH;
          // 短辺方向の誤差比率を補正倍率として使う（オーバースキャン）
          var compensate;
          if (imgAspect >= winAspect) {
            // 高さが制約軸: actualH と targetHeight の比
            compensate = (actualH > 0 && targetHeight > 0) ? actualH / targetHeight : 1.0;
          } else {
            // 幅が制約軸: actualW と targetWidth の比
            compensate = (actualW > 0 && targetWidth > 0) ? actualW / targetWidth : 1.0;
          }
          // 誤差が0.5px以上の場合のみ適用（不要な再描画を回避）
          if (Math.abs(compensate - 1.0) > 0.0005 && compensate > 0.9 && compensate < 1.1) {
            viewerState.compensateScale = compensate;
          } else {
            viewerState.compensateScale = 1.0;
          }
          viewerUI.updateImageRendering();
        }
      }
    }).catch(() => {
      _resizePending = false;
    });
  }
}

// ============================================================================
// 3. Image Navigation & Loading
// ============================================================================

/**
 * インデックスから画像のパスを取得します。ローカルに無い場合はIPCでフォールバックします。
 */
async function getImagePath(index) {
  if (viewerState.paths && viewerState.paths[index]) {
    return viewerState.paths[index];
  }
  const result = await window.veloceAPI.getViewerImage(index);
  if (result) {
    if (!viewerState.paths || viewerState.paths.length !== result.total) {
      viewerState.paths = new Array(result.total).fill(null);
    }
    if (result.chunk && typeof result.chunkStart === 'number') {
      for (let i = 0; i < result.chunk.length; i++) {
        viewerState.paths[result.chunkStart + i] = result.chunk[i];
      }
    }
    viewerState.paths[index] = result.path;
    return result.path;
  }
  return null;
}

let isViewerWindowShown = false; // 初回表示フラグ
let imageLoadSequence = 0;       // 非同期ロード競合防止用

/**
 * DOM Swap方式：新しい画像を背面に用意しておき、表示する瞬間に要素を切り替えることでラグを無くします。
 */
function swapImageElement(newImg, sequenceId) {
  if (currentViewerImg === newImg) {
    if (newImg && newImg.tagName === 'VIDEO') {
      applyPlayModeToMedia(newImg, 'video');
      applyVolumeSettingsToMedia(newImg, true);
    }
    if (!isViewerWindowShown && window.veloceAPI && window.veloceAPI.showWindow) {
      window.veloceAPI.showWindow();
      isViewerWindowShown = true;
    }
    updatePlayModeButtonUI();
    if (sequenceId === imageLoadSequence) {
      preloadAdjacentImages(sequenceId);
    }
    return;
  }
  
  newImg.classList.add('viewer-img-pending');
  newImg.style.display = 'none'; // Initially hide it to prevent pushing the visible image
  viewerUI.elements.viewerImg = newImg;
  
  const borderOverlay = document.getElementById('border-overlay');
  if (borderOverlay && borderOverlay.parentNode) {
    borderOverlay.parentNode.insertBefore(newImg, borderOverlay);
  } else {
    document.body.appendChild(newImg);
  }

  if (!isViewerWindowShown && window.veloceAPI && window.veloceAPI.showWindow) {
    window.veloceAPI.showWindow();
    isViewerWindowShown = true;
  }

  currentViewerImg = newImg;

  // Clean up any stray elements that are NOT currentlyVisibleImg and not newImg
  const strayImgs = document.querySelectorAll('.viewer-img-pending, #viewer-img');
  strayImgs.forEach(img => {
    if (img !== currentlyVisibleImg && img !== newImg) {
      if (img.tagName === 'VIDEO') {
        img.pause();
      }
      img.remove();
    }
  });

  // ファイル移動・切り替え時は直前の音声再生を即座に停止・破棄する
  stopAndDiscardAudio();

  let visibleApplied = false;
  const makeVisible = () => {
    if (visibleApplied || sequenceId !== imageLoadSequence) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    visibleApplied = true;
    
    // Clean up the currently visible image since the new one is ready
    if (currentlyVisibleImg && currentlyVisibleImg !== newImg) {
      if (currentlyVisibleImg.tagName === 'VIDEO') {
        // 表示から外れた動画は一時停止してバックグラウンド再生・音声出力を停止する。
        // ※ preloadCache に保持されている動画要素の src を removeAttribute してしまうと、
        //   再訪時に空の video 要素が再利用されて再生できなくなるため、src の消去は行わない。
        //   メモリ解放は preloadCache から完全に破棄されるタイミング（diff > 3 または clearPreloadCache）で行う。
        currentlyVisibleImg.pause();
      }
      currentlyVisibleImg.remove();
    }
    currentlyVisibleImg = newImg;
    newImg.id = 'viewer-img';
    newImg.classList.remove('viewer-img-pending');
    newImg.style.display = '';
    // DOM置換直後にスタイルの適用とバウンディングボックスの同期計算を確定させ、次行のリサイズ処理へ渡す
    void newImg.offsetHeight;

    setZoomState(viewerState.isZoomed);
    viewerUI.updateImageRendering();
    resizeWindowToFitImage();

    if (newImg.dataset && newImg.dataset.audioPath) {
      stopAndDiscardAudio();
      const audioPath = newImg.dataset.audioPath;
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      applyPlayModeToMedia(audioEl, 'audio');
      audioEl.tabIndex = -1;
      applyVolumeSettingsToMedia(audioEl, false);
      const baseSrc = (window.veloceAPI && window.veloceAPI.convertFileSrc) ? window.veloceAPI.convertFileSrc(audioPath) : '';
      audioEl.src = getStreamUrl(audioPath, baseSrc);
      setCurrentAudioElement(audioEl);
      document.body.appendChild(audioEl);
      if (typeof audioEl.play === 'function') {
        audioEl.play().catch(e => console.warn('Audio play failed:', e));
      }
      if (typeof setVideoSeekBarVisibility === 'function') {
        setVideoSeekBarVisibility(shouldShowSeekBarForMedia(audioEl));
      }
    }

    // 表示用要素のデコード・表示確定後に隣接プリロードを開始し、初回描画との帯域競合を避ける
    if (sequenceId === imageLoadSequence) {
      preloadAdjacentImages(sequenceId);
    }
  };

  if (newImg.tagName === 'VIDEO') {
    applyPlayModeToMedia(newImg, 'video');
    applyVolumeSettingsToMedia(newImg, true);
    // 再訪時やループ遷移時、動画を確実に先頭から再生する
    try {
      newImg.currentTime = 0;
    } catch (e) {
      /* ignore if not yet seekable */
    }
    if (newImg.readyState >= 1) {
      makeVisible();
      newImg.play().catch(e => console.warn('Video play failed:', e));
    } else {
      newImg.addEventListener('loadedmetadata', () => {
        makeVisible();
        try {
          newImg.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
        newImg.play().catch(e => console.warn('Video play failed:', e));
      }, { once: true });
      newImg.addEventListener('error', () => {
        makeVisible();
      }, { once: true });
    }
  } else {
    const decodePromise = (typeof newImg.decode === 'function') ? newImg.decode() : null;
    if (decodePromise && typeof decodePromise.then === 'function') {
      decodePromise.then(() => {
        makeVisible();
      }).catch((e) => {
        makeVisible();
      });
    } else {
      makeVisible();
    }
  }

  const isAudioTarget = Boolean(newImg.dataset && newImg.dataset.audioPath);
  if (newImg.tagName === 'VIDEO') {
    if (typeof setVideoSeekBarVisibility === 'function') {
      setVideoSeekBarVisibility(shouldShowSeekBarForMedia(newImg));
    }
  } else if (!isAudioTarget) {
    if (typeof setVideoSeekBarVisibility === 'function') {
      setVideoSeekBarVisibility(false);
    } else if (typeof videoSeekBarContainer !== 'undefined' && videoSeekBarContainer) {
      videoSeekBarContainer.style.display = 'none';
    }
  }
  updatePlayModeButtonUI();
}

async function loadImage() {
  closeVolumePopup();

  const currentSeq = ++imageLoadSequence;

  const path = await getImagePath(viewerState.currentIndex);
  if (path) {
    // 非同期でパスを取得している間に別のロードが開始されていたら破棄
    if (currentSeq !== imageLoadSequence) return;

    viewerState.currentImagePath = path;
    if (viewerState.paths && viewerState.paths.length > 0) {
      viewerState.totalImages = viewerState.paths.length;
    }

    let targetImg;
    const isVideo = isVideoFile(viewerState.currentImagePath);
    const isAudio = isAudioFile(viewerState.currentImagePath);
    if (viewerState.preloadCache.has(viewerState.currentIndex)) {
      const cachedData = viewerState.preloadCache.get(viewerState.currentIndex);
      if (cachedData.path === viewerState.currentImagePath) {
        // タグ種別（VIDEO / Audio用IMG / 通常IMG）の整合性確認、および動画要素の破損検出時は安全に破棄
        const hasAudioTag = Boolean(cachedData.img && cachedData.img.dataset && cachedData.img.dataset.audioPath);
        const isTagMismatched = cachedData.img && (
          isVideo ? cachedData.img.tagName !== 'VIDEO'
            : (isAudio ? (cachedData.img.tagName !== 'IMG' || !hasAudioTag)
              : (cachedData.img.tagName === 'VIDEO' || hasAudioTag))
        );
        const isCorruptedVideo = cachedData.img && cachedData.img.tagName === 'VIDEO' && (!cachedData.img.src || cachedData.img.src === '');
        if (isTagMismatched || isCorruptedVideo) {
          viewerState.preloadCache.delete(viewerState.currentIndex);
        } else {
          targetImg = cachedData.img;
        }
      }
    }

    const targetSrc = getStreamUrl(viewerState.currentImagePath, window.veloceAPI.convertFileSrc(viewerState.currentImagePath));
    if (!targetImg && !isAudio && currentViewerImg && currentViewerImg.src === targetSrc) {
      const hasAudioTag = Boolean(currentViewerImg.dataset && currentViewerImg.dataset.audioPath);
      const isTagMismatched = isVideo ? currentViewerImg.tagName !== 'VIDEO' : (currentViewerImg.tagName === 'VIDEO' || hasAudioTag);
      if (!isTagMismatched) {
        targetImg = currentViewerImg;
      }
    }

    if (!targetImg) {
      if (isVideo) {
        targetImg = document.createElement('video');
        targetImg.autoplay = true;
        applyPlayModeToMedia(targetImg, 'video');
        applyVolumeSettingsToMedia(targetImg, true);
        // フォーカスを受け取らないようにし、window.focus 誘発による ignoreNextClick 誤爆を防ぐ
        targetImg.tabIndex = -1;
        targetImg.src = targetSrc;
      } else if (isAudio) {
        targetImg = createAudioCoverImageElement(viewerState.currentImagePath);
      } else {
        targetImg = document.createElement('img');
        targetImg.decoding = 'async';
        targetImg.src = targetSrc;
      }
      viewerState.preloadCache.set(viewerState.currentIndex, { img: targetImg, path: viewerState.currentImagePath });
    }

    swapImageElement(targetImg, currentSeq);
    if (typeof updateRatingDisplay === 'function') updateRatingDisplay();

    if (viewerState.isAlphaOverlayMode && targetImg.tagName === 'IMG') {
      applyAlphaOverlay(targetImg, path, true);
    }

    document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
    const filenameEl = document.getElementById('window-filename-display');
    if (filenameEl && path) {
      filenameEl.textContent = path.split(/[/\\]/).pop();
    }
    if (viewerState.isMetadataVisible) {
      updateMetadataOverlay();
    }
  }
}

/**
 * 進行方向ベクトルに応じたスマートプリロードのオフセット配列を取得する。
 * 連続送り時の描画待ちを排除するため、進行方向に多くの先読み枠を優先配分し、
 * かつ逆方向も最低1枚は即座に戻れるよう枠を確保する。
 * @param {number} [direction=1] - 進行方向 (1: 次へ/前進, -1: 前へ/後退)
 * @returns {number[]} プリロード対象の相対オフセット配列
 */
export function getPreloadDeltas(direction = 1) {
  if (direction === 1) {
    return [1, 2, 3, -1];
  } else if (direction === -1) {
    return [-1, -2, -3, 1];
  }
  return [1, -1, 2, -2];
}
if (typeof window !== 'undefined') {
  window.getPreloadDeltas = getPreloadDeltas;
}

async function preloadAdjacentImages(expectedSeq = null) {
  if (expectedSeq !== null && expectedSeq !== imageLoadSequence) return;
  const total = viewerState.totalImages;
  if (total <= 1) return;

  // 進行方向ベクトルに応じたスマートプリロード（方向予測配分）
  const deltas = getPreloadDeltas(viewerState.lastDirection);
  const indicesToPreload = [];
  for (const delta of deltas) {
    const targetIdx = ((viewerState.currentIndex + delta) % total + total) % total;
    if (!indicesToPreload.includes(targetIdx)) {
      indicesToPreload.push(targetIdx);
    }
  }

  await Promise.all(indicesToPreload.map(async (idx) => {
    if (expectedSeq !== null && expectedSeq !== imageLoadSequence) return;
    if (typeof window === 'undefined' || typeof document === 'undefined' || !window.veloceAPI || !window.veloceAPI.convertFileSrc) return;
    if (!viewerState.preloadCache.has(idx)) {
      const path = await getImagePath(idx);
      if (expectedSeq !== null && expectedSeq !== imageLoadSequence) return;
      if (typeof window === 'undefined' || typeof document === 'undefined' || !window.veloceAPI || !window.veloceAPI.convertFileSrc) return;
      if (path && !viewerState.preloadCache.has(idx)) {
        const url = getStreamUrl(path, window.veloceAPI.convertFileSrc(path));
        let img;
        if (isVideoFile(path)) {
          img = document.createElement('video');
          applyPlayModeToMedia(img, 'video');
          applyVolumeSettingsToMedia(img, true);
          // 先読み用要素ではメタデータのみ取得し、表示前のバックグラウンド再生およびストリーム競合を防止する
          img.autoplay = false;
          img.preload = 'metadata';
          // フォーカスを受け取らないようにし、window.focus 誘発による ignoreNextClick 誤爆を防ぐ
          img.tabIndex = -1;
          img.src = url;
        } else if (isAudioFile(path)) {
          img = createAudioCoverImageElement(path);
        } else {
          img = document.createElement('img');
          img.decoding = 'async';
          img.src = url;
        }
        viewerState.preloadCache.set(idx, { img: img, path: path });

        if (img.tagName === 'IMG' && typeof img.decode === 'function') {
          img.decode().catch(e => { /* ignore */ });
        }
      }
    }
  }));

  if (expectedSeq !== null && expectedSeq !== imageLoadSequence) return;

  // 不要になった古いキャッシュ（現在地から離れたもの）を削除してメモリを節約
  for (const cachedIdx of viewerState.preloadCache.keys()) {
    let diff = Math.abs(cachedIdx - viewerState.currentIndex);
    if (diff > total / 2) {
      diff = total - diff;
    }
    if (diff > 3) {
      const cached = viewerState.preloadCache.get(cachedIdx);
      if (cached && cached.img) {
        // 現在表示中の画像、またはロード進行中の画像は破棄から保護する（高速スクロール時の非同期レース防止）
        if (cached.img === currentlyVisibleImg || cached.img === currentViewerImg) {
          continue;
        }
        if (cached.img.tagName === 'VIDEO') {
          cached.img.pause();
          cached.img.removeAttribute('src');
          cached.img.load();
        }
        if (typeof cached.img.remove === 'function') cached.img.remove();
      }
      viewerState.preloadCache.delete(cachedIdx);
    }
  }
}

/**
 * 次の画像を表示する (Next)
 */
export function showNext() {
  if (viewerState.totalImages > 0) {
    viewerState.lastDirection = 1;
    const isLooping = viewerState.totalImages > 1 && viewerState.currentIndex === viewerState.totalImages - 1;
    viewerState.currentIndex = (viewerState.currentIndex < viewerState.totalImages - 1) ? viewerState.currentIndex + 1 : 0;
    if (isLooping && viewerUI && typeof viewerUI.triggerLoopFeedback === 'function') {
      viewerUI.triggerLoopFeedback('start');
    }
    loadImage();
  }
}

/**
 * 前の画像を表示する (Prev)
 */
export function showPrev() {
  if (viewerState.totalImages > 0) {
    viewerState.lastDirection = -1;
    const isLooping = viewerState.totalImages > 1 && viewerState.currentIndex === 0;
    viewerState.currentIndex = (viewerState.currentIndex > 0) ? viewerState.currentIndex - 1 : viewerState.totalImages - 1;
    if (isLooping && viewerUI && typeof viewerUI.triggerLoopFeedback === 'function') {
      viewerUI.triggerLoopFeedback('end');
    }
    loadImage();
  }
}

function clampTranslate() {
  if (!viewerUI.elements.viewerImg) return;

  if (viewerState.isImmersiveArranged) {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const { width: natW, height: natH } = getNaturalDimensions();
    
    if (natW > 0 && natH > 0) {
      const scale = Math.max(winW / natW, winH / natH);
      const coverW = natW * scale;
      const coverH = natH * scale;
      
      const maxTx = Math.max(0, (coverW - winW) / 2);
      const maxTy = Math.max(0, (coverH - winH) / 2);
      
      viewerState.currentTranslateX = Math.max(-maxTx, Math.min(viewerState.currentTranslateX, maxTx));
      viewerState.currentTranslateY = Math.max(-maxTy, Math.min(viewerState.currentTranslateY, maxTy));
    }
    return;
  }

  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const { width: natW, height: natH } = getNaturalDimensions();
  const comp = viewerState.compensateScale || 1.0;
  
  const scaledW = natW * viewerState.currentScale * comp;
  const scaledH = natH * viewerState.currentScale * comp;

  const baseLeft = (winW - scaledW) / 2;
  const baseTop = (winH - scaledH) / 2;
  const baseRight = baseLeft + scaledW;
  const baseBottom = baseTop + scaledH;
  
  const rect = { width: scaledW, height: scaledH };

  // X軸の制約：縮小時は画面内に収まる範囲で自由に移動、拡大時ははみ出さない範囲で移動
  if (rect.width <= winW) {
    viewerState.currentTranslateX = Math.max(-baseLeft, Math.min(viewerState.currentTranslateX, winW - baseRight));
  } else {
    viewerState.currentTranslateX = Math.max(winW - baseRight, Math.min(viewerState.currentTranslateX, -baseLeft));
  }

  // Y軸の制約：縮小時は画面内に収まる範囲で自由に移動、拡大時ははみ出さない範囲で移動
  if (rect.height <= winH) {
    viewerState.currentTranslateY = Math.max(-baseTop, Math.min(viewerState.currentTranslateY, winH - baseBottom));
  } else {
    viewerState.currentTranslateY = Math.max(winH - baseBottom, Math.min(viewerState.currentTranslateY, -baseTop));
  }
}

// ============================================================================
// 4. UI Controls
// ============================================================================

// ドラッグ、クリック、ダブルクリックを判別するための状態変数
let isDragging = false;
let hasMoved = false; // ドラッグ中に実際にマウスが移動したか
let startX = 0, startY = 0; // ドラッグ開始時の座標
let windowX = 0, windowY = 0; // ウィンドウ移動用の座標

// Windows 8.1 / 10 のボーダーレスウィンドウにおいて、ネイティブタイトルバー制御のホバー判定不整合を防ぎ統一した外観を提供するためカスタムコントロールを構築
function createWindowControls() {
  const controlsContainer = document.createElement('div');
  controlsContainer.id = 'window-controls';
  if (!viewerState.isBorderVisible) controlsContainer.classList.add('controls-hidden');
  ['click', 'dblclick'].forEach(evt => {
    controlsContainer.addEventListener(evt, (e) => e.stopPropagation());
  });

  // 最小化ボタン
  const minBtn = document.createElement('div');
  minBtn.id = 'window-min-btn';
  minBtn.className = 'window-ctrl-btn window-ctrl-btn--min';
  minBtn.innerHTML = ViewerUI.ICONS.MINIMIZE;
  minBtn.onclick = () => window.veloceAPI.minimizeViewer();

  // 最大化/元に戻すボタン
  const maxBtn = document.createElement('div');
  maxBtn.id = 'window-max-btn';
  maxBtn.className = 'window-ctrl-btn window-ctrl-btn--max';
  maxBtn.innerHTML = ViewerUI.ICONS.MAXIMIZE;
  maxBtn.onclick = () => window.veloceAPI.maximizeViewer();

  // 閉じるボタン
  const closeBtn = document.createElement('div');
  closeBtn.id = 'window-close-btn';
  closeBtn.className = 'window-ctrl-btn window-ctrl-btn--close';
  closeBtn.innerHTML = ViewerUI.ICONS.CLOSE;
  closeBtn.onclick = () => {
    if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
  };

  [minBtn, maxBtn, closeBtn].forEach(btn => {
    ['mousedown', 'mouseup'].forEach(evt => {
      btn.addEventListener(evt, (e) => e.stopPropagation());
    });
  });

  const filenameDisplay = document.createElement('div');
  filenameDisplay.id = 'window-filename-display';
  filenameDisplay.className = 'window-filename';

  controlsContainer.appendChild(filenameDisplay);
  const infoContainer = document.createElement('div');
  infoContainer.id = 'window-info-container';
  infoContainer.className = 'window-info-container';
  infoContainer.style.display = 'none';

  const ratingDisplay = document.createElement('div');
  ratingDisplay.id = 'viewer-rating-display';
  ratingDisplay.className = 'viewer-rating-display';
  ratingDisplay.style.display = 'none';

  const scaleDisplay = document.createElement('div');
  scaleDisplay.id = 'window-scale-display';
  scaleDisplay.className = 'window-scale-display';
  scaleDisplay.style.display = 'none';

  infoContainer.appendChild(ratingDisplay);
  infoContainer.appendChild(scaleDisplay);
  controlsContainer.appendChild(infoContainer);

  controlsContainer.appendChild(minBtn);
  controlsContainer.appendChild(maxBtn);
  controlsContainer.appendChild(closeBtn);
  document.body.appendChild(controlsContainer);
}

createWindowControls();
viewerUI.applyBorderVisibility();

// ============================================================================
// 5. Event Handlers (Mouse & Keyboard)
// ============================================================================

window.addEventListener('mousedown', (e) => {
  // ウィンドウがフォーカスを取得した直後のクリック（フォーカス目的のクリック）を画像送りとして扱わない
  if (Date.now() - viewerState.lastFocusTime < CONFIG.FOCUS_DELAY) {
    viewerState.ignoreNextClick = true;
  } else {
    viewerState.ignoreNextClick = false;
  }

  if (e.button === 0) { // 左クリック
    // 画像上でのCtrl+左ドラッグはパン操作とする
    if (e.ctrlKey && e.target && (e.target.id === 'viewer-img' || e.target.closest('#viewer-img') || e.target.id === 'border-overlay')) {
      e.preventDefault(); // デフォルトのドラッグを防止
      viewerState.isImageDragging = true;
      viewerState.imageDragStartX = e.clientX;
      viewerState.imageDragStartY = e.clientY;
      viewerUI.setCursor('grabbing');
      hasMoved = false;
    } else {
      // それ以外の左ドラッグはウィンドウ移動
      const EDGE = CONFIG.EDGE_THRESHOLD;
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE ||
          e.clientY < EDGE || e.clientY > window.innerHeight - EDGE) {
        isDragging = false;
        return;
      }
      isDragging = true;
      hasMoved = false;
      startX = e.screenX;
      startY = e.screenY;
      windowX = e.clientX;
      windowY = e.clientY;
    }
  }
});

let dragRafId = null;
window.addEventListener('mousemove', (e) => {
  if (viewerState.isImageDragging) {
    if (!hasMoved) {
      if (Math.abs(e.clientX - viewerState.imageDragStartX) > 5 || Math.abs(e.clientY - viewerState.imageDragStartY) > 5) {
        hasMoved = true;
      }
    }
    
    if (hasMoved) {
      viewerState.currentTranslateX += e.clientX - viewerState.imageDragStartX;
      viewerState.currentTranslateY += e.clientY - viewerState.imageDragStartY;
      viewerState.imageDragStartX = e.clientX;
      viewerState.imageDragStartY = e.clientY;

      // 一旦DOMに仮反映してから境界をチェックし、最終結果を適用する
      clampTranslate();
      viewerUI.updateImageRendering();
    }
  } else if (isDragging) {
    if (!hasMoved) {
      if (Math.abs(e.screenX - startX) > 5 || Math.abs(e.screenY - startY) > 5) {
        hasMoved = true;
      }
    }
    if (hasMoved) {
      if (dragRafId) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        window.veloceAPI.moveViewerWindow(e.screenX - windowX, e.screenY - windowY);
      });
    }
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { // 左クリックのリリース
    if (viewerState.isImageDragging) {
      viewerState.isImageDragging = false;
      viewerUI.setCursor(e.ctrlKey ? 'grab' : 'default');
      // ドラッグせずに離した場合はクリックとして扱う（次の画像へ）※Ctrl押下時はスキップ
      if (!hasMoved && !viewerState.ignoreNextClick && !e.ctrlKey) {
        showPrev();
      }
    } else if (isDragging) {
      isDragging = false;
      if (!hasMoved && !viewerState.ignoreNextClick) {
        showPrev();
      }
    }
  }
});

// Ctrlキーを押した時だけ「手のひら」カーソルにして、ドラッグ可能であることを示す
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control') viewerUI.setCursor('grab');
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control' && !viewerState.isImageDragging) {
    viewerUI.setCursor('default');
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault(); 
  if (viewerState.ignoreNextClick) return; // フォーカス目的の右クリックを無視
  showNext(); // 右クリックで次の画像へ
});

export function handleWheel(e) {
  if (e.ctrlKey) {
    if (typeof e.preventDefault === 'function') e.preventDefault(); // ブラウザ標準のズームを無効化し、親ウィンドウへのイベント伝播を防ぐ
    viewerState.isImmersiveArranged = false; // 手動ズームで解除

    // ズーム状態への移行：初めてズームするときは現在の見た目のスケールを計算して引き継ぎ、二重拡大を防ぐ
    if (!viewerState.isZoomed) {
      const { width: natW, height: natH } = getNaturalDimensions();
      viewerState.currentScale = viewerState.isFitToWindow 
        ? Math.min(window.innerWidth / natW, window.innerHeight / natH)
        : Math.min(1.0, window.innerWidth / natW, window.innerHeight / natH);
      setZoomState(true);
    }

    // ホイールの回転方向に応じてスケールを増減
    if (e.deltaY < 0) {
      viewerState.currentScale *= CONFIG.ZOOM_STEP; // 上スクロールで拡大
    } else {
      viewerState.currentScale /= CONFIG.ZOOM_STEP; // 下スクロールで縮小
    }

    // 倍率の限界値を設定
    viewerState.currentScale = Math.max(CONFIG.MIN_ZOOM, Math.min(viewerState.currentScale, CONFIG.MAX_ZOOM));

    // ウィンドウサイズを画像のズームに合わせて即座に追従させる
    if (!viewerState.isFullscreen && !document.fullscreenElement) {
      const { width: natW, height: natH } = getNaturalDimensions();
      let targetWidth = Math.round(natW * viewerState.currentScale);
      let targetHeight = Math.round(natH * viewerState.currentScale);

      const monitorW = window.screen.availWidth;
      const monitorH = window.screen.availHeight;

      // モニターサイズを超えないように制限
      targetWidth = Math.min(targetWidth, monitorW);
      targetHeight = Math.min(targetHeight, monitorH);

      if (window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
        if (window._resizeRafId) cancelAnimationFrame(window._resizeRafId);
        window._resizeRafId = requestAnimationFrame(() => {
          window.veloceAPI.resizeViewerWindow(targetWidth, targetHeight);
        });
      }
    }

    // 一旦スケールを適用し、縮小時にはみ出しを補正して再適用
    clampTranslate();
    viewerUI.updateImageRendering();
    updateFullscreenStyles(); // マージンの再計算
    debouncedFocusWindow();   // フォーカスの維持
  } else {
    if (typeof e.preventDefault === 'function') e.preventDefault(); // 親ウィンドウのスクロールを防止
    
    // 一定時間ホイール操作がない場合は移動量の端数をリセットする
    clearTimeout(window._wheelResetTimeout);
    window._wheelResetTimeout = setTimeout(() => {
      window._wheelDeltaAccumulator = 0;
    }, 150);
    
    // トラックパッドの連続イベントやマウスの「カチッ」を吸収するため、移動量を累積する
    window._wheelDeltaAccumulator = (window._wheelDeltaAccumulator || 0) + e.deltaY;
    const WHEEL_THRESHOLD = 80; // この値（移動量）ごとに1枚送る
    
    let steps = 0;
    if (window._wheelDeltaAccumulator >= WHEEL_THRESHOLD) {
      steps = Math.floor(window._wheelDeltaAccumulator / WHEEL_THRESHOLD);
      window._wheelDeltaAccumulator %= WHEEL_THRESHOLD;
    } else if (window._wheelDeltaAccumulator <= -WHEEL_THRESHOLD) {
      steps = Math.ceil(window._wheelDeltaAccumulator / WHEEL_THRESHOLD); // マイナスの値
      window._wheelDeltaAccumulator %= WHEEL_THRESHOLD;
    }

    if (steps !== 0 && viewerState.totalImages > 0) {
      if (steps > 0) {
        for (let s = 0; s < steps; s++) {
          const isLooping = viewerState.totalImages > 1 && viewerState.currentIndex === viewerState.totalImages - 1;
          viewerState.currentIndex = (viewerState.currentIndex < viewerState.totalImages - 1) ? viewerState.currentIndex + 1 : 0;
          if (isLooping && viewerUI && typeof viewerUI.triggerLoopFeedback === 'function') {
            viewerUI.triggerLoopFeedback('start');
          }
        }
        viewerState.lastDirection = 1;
        loadImage();
      } else if (steps < 0) {
        for (let s = 0; s < Math.abs(steps); s++) {
          const isLooping = viewerState.totalImages > 1 && viewerState.currentIndex === 0;
          viewerState.currentIndex = (viewerState.currentIndex > 0) ? viewerState.currentIndex - 1 : viewerState.totalImages - 1;
          if (isLooping && viewerUI && typeof viewerUI.triggerLoopFeedback === 'function') {
            viewerUI.triggerLoopFeedback('end');
          }
        }
        viewerState.lastDirection = -1;
        loadImage();
      }
    }
  }
}

window.addEventListener('wheel', handleWheel, { passive: false });

/**
 * ファイル削除後にビューアー内のパス一覧から該当パスを除去し、次の画像へ進める（またはウィンドウを閉じる）。
 * viewer-list-updated イベントが届いて既に画像が切り替わっている場合は二重処理を防止する。
 * @param {string} deletedPath - 削除された画像パス
 */
export async function advanceAfterPathDeleted(deletedPath) {
  const idx = viewerState.paths.indexOf(deletedPath);
  if (idx !== -1) {
    viewerState.paths.splice(idx, 1);
  }
  // currentImagePath がまだ deletedPath を指している場合（viewer-list-updated が未到達の場合）のみ次へ遷移
  if (viewerState.currentImagePath === deletedPath) {
    viewerState.totalImages = viewerState.paths.length;
    if (viewerState.paths.length > 0) {
      if (viewerState.currentIndex >= viewerState.paths.length) {
        viewerState.currentIndex = viewerState.paths.length - 1;
      }
      await loadImage();
    } else {
      if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
    }
  }
}

/**
 * ファイルリネーム通知（viewer-file-renamed）を受け取り、
 * 現在表示中の画像パスが一致する場合に内部状態（paths, currentImagePath）および
 * タイトルバー・ファイル名表示を追随させる。
 * 表示中の画像自体の再読み込み（loadImage）は行わない。
 *
 * @param {string} oldPath - 変更前の画像パス
 * @param {string} newPath - 変更後の画像パス
 * @returns {boolean} 追随が行われた場合は true、対象外（不一致等）の場合は false
 */
export function handleViewerFileRenamed(oldPath, newPath) {
  if (!oldPath || !newPath) return false;

  // 大文字小文字やスラッシュの差異を許容した比較
  const normOld = oldPath.replace(/\//g, '\\').toLowerCase();
  const currentNorm = (viewerState.currentImagePath || '').replace(/\//g, '\\').toLowerCase();

  // 現在表示中のパスと一致しない場合は何もしない
  if (currentNorm !== normOld) {
    return false;
  }

  // viewerState.paths 内の該当要素を新パスへ差し替え
  if (Array.isArray(viewerState.paths)) {
    const idx = viewerState.paths.findIndex(p => (p || '').replace(/\//g, '\\').toLowerCase() === normOld);
    if (idx !== -1) {
      viewerState.paths[idx] = newPath;
    }
  }

  // currentImagePath を新パスへ更新
  viewerState.currentImagePath = newPath;

  // ビューアー内レーティングマップのキーを新パスへ移行
  if (typeof viewerRatings === 'object' && viewerRatings !== null) {
    const candidates = [oldPath, oldPath.replace(/\//g, '\\'), oldPath.replace(/\\/g, '/')];
    let ratingVal;
    for (const key of candidates) {
      if (viewerRatings[key] !== undefined) {
        ratingVal = viewerRatings[key];
        delete viewerRatings[key];
      }
    }
    if (ratingVal !== undefined) {
      viewerRatings[newPath] = ratingVal;
    }
  }

  // overlayCache の該当エントリを新パスへ付け替え
  if (viewerState.overlayCache instanceof Map) {
    const overlayUpdates = [];
    for (const [k, v] of viewerState.overlayCache.entries()) {
      if (typeof k === 'string' && k.replace(/\//g, '\\').toLowerCase() === normOld) {
        overlayUpdates.push([k, v]);
      }
    }
    for (const [oldKey, val] of overlayUpdates) {
      viewerState.overlayCache.delete(oldKey);
      viewerState.overlayCache.set(newPath, val);
    }
  }

  const domViewerImg = (typeof document !== 'undefined') ? document.getElementById('viewer-img') : null;
  const isVisibleMedia = (el) => Boolean(el && (el === currentlyVisibleImg || el === currentViewerImg || el === domViewerImg));

  // preloadCache の該当エントリのうち、表示中要素を含まないものは削除（次回先読みで再生成）
  if (viewerState.preloadCache instanceof Map) {
    for (const [idx, entry] of Array.from(viewerState.preloadCache.entries())) {
      if (entry && typeof entry.path === 'string' && entry.path.replace(/\//g, '\\').toLowerCase() === normOld) {
        if (isVisibleMedia(entry.img)) {
          entry.path = newPath;
        } else {
          if (entry.img && entry.img.tagName === 'VIDEO' && typeof entry.img.pause === 'function') {
            entry.img.pause();
          }
          viewerState.preloadCache.delete(idx);
        }
      }
    }
  }

  // 表示中要素の dataset.audioPath を新パスへ更新（再生中の audio 要素の src は変更しない）
  for (const el of [currentlyVisibleImg, currentViewerImg, domViewerImg]) {
    if (el && el.dataset && typeof el.dataset.audioPath === 'string'
      && el.dataset.audioPath.replace(/\//g, '\\').toLowerCase() === normOld) {
      el.dataset.audioPath = newPath;
    }
  }

  // タイトルバーおよびファイル名表示要素の更新（画像自体は切り替えない）
  if (typeof viewerState.currentIndex === 'number' && typeof viewerState.totalImages === 'number') {
    document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
  }
  const filenameEl = document.getElementById('window-filename-display');
  if (filenameEl) {
    filenameEl.textContent = newPath.split(/[/\\]/).pop();
  }

  // メタデータオーバーレイが開いていれば更新
  if (viewerState.isMetadataVisible && typeof updateMetadataOverlay === 'function') {
    updateMetadataOverlay();
  }

  return true;
}

/**
 * フォルダリネーム通知（viewer-folder-renamed）を受け取り、
 * 旧フォルダ配下にある画像パス（paths, currentImagePath）、レーティングキー、
 * および所属フォルダ情報を新フォルダプレフィックスへ追随させる。
 * 表示中の画像自体の再読み込み（loadImage）は行わない。
 *
 * @param {string} oldFolderPath - 変更前のフォルダパス
 * @param {string} newFolderPath - 変更後のフォルダパス
 * @returns {boolean} 追随が行われた場合は true、対象外（配下にない等）の場合は false
 */
export function handleViewerFolderRenamed(oldFolderPath, newFolderPath) {
  if (!oldFolderPath || !newFolderPath) return false;

  let anyUpdated = false;

  // 1. viewerState.paths の各要素のうち、旧フォルダ配下にあるものを境界意識でプレフィックス置換
  if (Array.isArray(viewerState.paths)) {
    for (let i = 0; i < viewerState.paths.length; i++) {
      const p = viewerState.paths[i];
      if (typeof p === 'string' && isSameOrSubdirectory(p, oldFolderPath)) {
        viewerState.paths[i] = replaceDirectoryPrefix(p, oldFolderPath, newFolderPath);
        anyUpdated = true;
      }
    }
  }

  // 2. 表示中の画像が旧フォルダ配下なら currentImagePath も付け替える（画像自体の切り替えは行わない）
  if (viewerState.currentImagePath && isSameOrSubdirectory(viewerState.currentImagePath, oldFolderPath)) {
    viewerState.currentImagePath = replaceDirectoryPrefix(viewerState.currentImagePath, oldFolderPath, newFolderPath);
    anyUpdated = true;

    // タイトルバーおよびファイル名表示要素の更新
    if (typeof viewerState.currentIndex === 'number' && typeof viewerState.totalImages === 'number') {
      document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
    }
    const filenameEl = document.getElementById('window-filename-display');
    if (filenameEl) {
      filenameEl.textContent = viewerState.currentImagePath.split(/[/\\]/).pop();
    }

    // メタデータオーバーレイが開いていれば更新
    if (viewerState.isMetadataVisible && typeof updateMetadataOverlay === 'function') {
      updateMetadataOverlay();
    }
  }

  // 3. ビューアー側レーティングマップ（viewerRatings）のキーも配下分を同様に付け替える
  if (typeof viewerRatings === 'object' && viewerRatings !== null) {
    const keys = Object.keys(viewerRatings);
    const updates = [];
    for (const key of keys) {
      if (isSameOrSubdirectory(key, oldFolderPath)) {
        const newKey = replaceDirectoryPrefix(key, oldFolderPath, newFolderPath);
        if (newKey !== key) {
          updates.push([key, newKey, viewerRatings[key]]);
        }
      }
    }
    for (const [oldKey, newKey, val] of updates) {
      delete viewerRatings[oldKey];
      viewerRatings[newKey] = val;
      anyUpdated = true;
    }
  }

  // 4. ビューアーが保持しているフォルダ情報（リストの所属フォルダ）が旧フォルダ配下なら付け替える
  if (viewerState.folder && isSameOrSubdirectory(viewerState.folder, oldFolderPath)) {
    viewerState.folder = replaceDirectoryPrefix(viewerState.folder, oldFolderPath, newFolderPath);
    anyUpdated = true;
  }
  if (viewerState.currentDirectory && isSameOrSubdirectory(viewerState.currentDirectory, oldFolderPath)) {
    viewerState.currentDirectory = replaceDirectoryPrefix(viewerState.currentDirectory, oldFolderPath, newFolderPath);
    anyUpdated = true;
  }

  // 5. overlayCache の配下エントリを新フォルダプレフィックスへ付け替え
  if (viewerState.overlayCache instanceof Map) {
    const overlayUpdates = [];
    for (const [k, v] of viewerState.overlayCache.entries()) {
      if (typeof k === 'string' && isSameOrSubdirectory(k, oldFolderPath)) {
        const newKey = replaceDirectoryPrefix(k, oldFolderPath, newFolderPath);
        if (newKey !== k) {
          overlayUpdates.push([k, newKey, v]);
        }
      }
    }
    for (const [oldKey, newKey, val] of overlayUpdates) {
      viewerState.overlayCache.delete(oldKey);
      viewerState.overlayCache.set(newKey, val);
      anyUpdated = true;
    }
  }

  const domViewerImg = (typeof document !== 'undefined') ? document.getElementById('viewer-img') : null;
  const isVisibleMedia = (el) => Boolean(el && (el === currentlyVisibleImg || el === currentViewerImg || el === domViewerImg));

  // 6. preloadCache の配下エントリのうち、表示中要素を含まないものは削除（次回先読みで再生成）
  if (viewerState.preloadCache instanceof Map) {
    for (const [idx, entry] of Array.from(viewerState.preloadCache.entries())) {
      if (entry && typeof entry.path === 'string' && isSameOrSubdirectory(entry.path, oldFolderPath)) {
        if (isVisibleMedia(entry.img)) {
          entry.path = replaceDirectoryPrefix(entry.path, oldFolderPath, newFolderPath);
        } else {
          if (entry.img && entry.img.tagName === 'VIDEO' && typeof entry.img.pause === 'function') {
            entry.img.pause();
          }
          viewerState.preloadCache.delete(idx);
        }
        anyUpdated = true;
      }
    }
  }

  // 7. 表示中要素の dataset.audioPath が旧フォルダ配下なら新パスへ更新（再生中の audio 要素の src は変更しない）
  for (const el of [currentlyVisibleImg, currentViewerImg, domViewerImg]) {
    if (el && el.dataset && typeof el.dataset.audioPath === 'string'
      && isSameOrSubdirectory(el.dataset.audioPath, oldFolderPath)) {
      el.dataset.audioPath = replaceDirectoryPrefix(el.dataset.audioPath, oldFolderPath, newFolderPath);
      anyUpdated = true;
    }
  }

  return anyUpdated;
}

if (typeof window !== 'undefined') {
  window.handleViewerFileRenamed = handleViewerFileRenamed;
  window.handleViewerFolderRenamed = handleViewerFolderRenamed;
  window.getViewerRatings = getViewerRatings;
  window.setViewerRatings = setViewerRatings;
}

window.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+I で開発者ツールをトグル表示
  if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    return;
  }

  const isPlainKey = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  const isShiftOnly = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;

  switch (e.key) {
    case 'ArrowLeft':
      if (isShiftOnly) {
        if (isPlayableMedia(getActivePlaybackMedia())) {
          e.preventDefault();
          seekActiveMediaBySeconds(-5);
        }
        break;
      }
      if (!isPlainKey) break;
      showPrev();
      break;
    case 'ArrowRight':
      if (isShiftOnly) {
        if (isPlayableMedia(getActivePlaybackMedia())) {
          e.preventDefault();
          seekActiveMediaBySeconds(5);
        }
        break;
      }
      if (!isPlainKey) break;
      showNext();
      break;
    case 'ArrowUp':
      if (isShiftOnly) {
        if (isPlayableMedia(getActivePlaybackMedia())) {
          e.preventDefault();
          adjustActiveMediaVolumeByPercent(5);
        }
        break;
      }
      if (!isPlainKey || isCurrentlyDisplayingAudioPlaceholder()) return;
      viewerState.currentRotation += 90;
      applyFitState();
      updateFullscreenStyles();
      // 回転後のバウンディングボックスを同期確定させ、後続のウィンドウリサイズ計算へ反映
      void viewerUI.elements.viewerImg.offsetHeight;
      viewerUI.updateImageRendering();
      resizeWindowToFitImage();
      break;
    case 'ArrowDown':
      if (isShiftOnly) {
        if (isPlayableMedia(getActivePlaybackMedia())) {
          e.preventDefault();
          adjustActiveMediaVolumeByPercent(-5);
        }
        break;
      }
      if (!isPlainKey || isCurrentlyDisplayingAudioPlaceholder()) return;
      viewerState.currentRotation -= 90;
      applyFitState();
      updateFullscreenStyles();
      // 回転後のバウンディングボックスを同期確定させ、後続のウィンドウリサイズ計算へ反映
      void viewerUI.elements.viewerImg.offsetHeight;
      viewerUI.updateImageRendering();
      resizeWindowToFitImage();
      break;
    case 'f':
    case 'F': {
      e.preventDefault();
      viewerState.isImmersiveArranged = false;
      const { width: natW, height: natH } = getNaturalDimensions();

      const monitorW = window.screen.availWidth;
      const monitorH = window.screen.availHeight;

      let targetW = natW;
      let targetH = natH;

      // モニターより大きい場合は画面に収まるように縮小
      if (targetW > monitorW || targetH > monitorH) {
        const scale = Math.min(monitorW / targetW, monitorH / targetH);
        targetW = Math.floor(targetW * scale);
        targetH = Math.floor(targetH * scale);
      }

      if (window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
        window.veloceAPI.resizeViewerWindow(targetW, targetH);
      }

      resetZoomAndFit();
      break;
    }
    case ' ': {
      e.preventDefault();
      viewerState.isImmersiveArranged = false;
      const { width: natW, height: natH } = getNaturalDimensions();

      if (window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
        window.veloceAPI.resizeViewerWindow(natW, natH);
      }

      resetZoomAndFit();
      break;
    }
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5': {
      e.preventDefault();
      let rating = parseInt(e.key.replace('Numpad', ''), 10);
      const filePath = viewerState.currentImagePath;
      if (filePath && window.veloceAPI.setRating) {
        const currentRating = viewerRatings[filePath] || 0;
        if (currentRating === rating) {
          rating = 0;
        }

        window.veloceAPI.setRating(filePath, rating);
      }
      break;
    }
    case 'Escape':
      if (isVolumePopupOpen()) {
        e.preventDefault();
        closeVolumePopup();
        return;
      }
      if (window.veloceAPI && window.veloceAPI.closeWindow) {
        window.veloceAPI.closeWindow();
      }
      break;
    case 'F11':
      e.preventDefault(); // ブラウザ標準のフルスクリーン動作を防ぐ
      window.veloceAPI.toggleViewerFullscreen();
      break;
    case 'a':
    case 'A':
      if (isCurrentlyDisplayingAudio()) return;
      e.preventDefault();
      toggleAlphaOverlayMode();
      break;
    case 'l':
    case 'L':
      if (window.veloceAPI.arrangeViewers) {
        window.veloceAPI.arrangeViewers();
      }
      break;
    case 's':
    case 'S':
      toggleVideoSeekBar();
      break;
    case 'b':
    case 'B':
      viewerState.isBorderVisible = !viewerState.isBorderVisible;
      viewerUI.applyBorderVisibility();
      break;
    case 'i':
    case 'I':
      e.preventDefault();
      toggleMetadataOverlay();
      break;
    case 'u':
    case 'U':
      if (isCurrentlyDisplayingAudio()) return;
      viewerState.isUnsharped = !viewerState.isUnsharped;
      viewerUI.updateImageRendering();
      break;
    case 'h':
    case 'H':
      if (isCurrentlyDisplayingAudioPlaceholder()) return;
      viewerState.flipX *= -1;
      viewerUI.updateImageRendering();
      break;
    case 'v':
    case 'V':
      if (isCurrentlyDisplayingAudioPlaceholder()) return;
      viewerState.flipY *= -1;
      viewerUI.updateImageRendering();
      break;
  }
  
  if (e.key === 'Delete') {
    if (viewerState.currentImagePath) {
      const deletedPath = viewerState.currentImagePath;
      const success = await window.veloceAPI.trashFile(deletedPath);
      if (success) {
        if (window.veloceAPI.notifyFileRemoved) {
          await window.veloceAPI.notifyFileRemoved(deletedPath);
        }
        await advanceAfterPathDeleted(deletedPath);
      }
    }
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      showToast('テキストをクリップボードにコピーしました', 2000, 'success');
      return;
    }

    if (viewerState.currentImagePath) {
      window.veloceAPI.copyImageToClipboard(viewerState.currentImagePath);
      // 画像のコピーとシャッターフラッシュエフェクトの適用
      let flash = document.getElementById('viewer-flash-effect');
      if (!flash) {
        flash = document.createElement('div');
        flash.id = 'viewer-flash-effect';
        document.body.appendChild(flash);
      }
      
      flash.style.transition = 'none';
      flash.style.opacity = '0.35';
      
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          flash.style.transition = '';
          flash.style.opacity = '0';
        });
      });

      // コピー完了を通知するトーストの表示
      showToast('画像をクリップボードにコピーしました', 3000, 'success');
	}
  }
});

// --- 拡大縮小率の表示更新 ---
function updateScaleDisplay() {
  if (typeof document === 'undefined') return;
  const scaleDisplay = document.getElementById('window-scale-display');
  const controls = document.getElementById('window-controls');
  if (!scaleDisplay || !controls) return;

  let currentScale = 1.0;
  if (viewerState.isZoomed) {
    currentScale = viewerState.currentScale;
  } else {
    const { width: natW, height: natH } = getNaturalDimensions();
    if (natW > 0 && natH > 0) {
      if (viewerState.isFitToWindow) {
        currentScale = Math.min(window.innerWidth / natW, window.innerHeight / natH);
      } else {
        currentScale = Math.min(1.0, window.innerWidth / natW, window.innerHeight / natH);
      }
    }
  }

  const percent = Math.round(currentScale * 100);
  if (percent !== 100) {
    scaleDisplay.textContent = `${percent}%`;
    scaleDisplay.style.display = 'flex';
  } else {
    scaleDisplay.style.display = 'none';
  }
  if (typeof updateInfoContainerVisibility === 'function') updateInfoContainerVisibility();
};

// --- レーティングの表示更新 ---
function updateRatingDisplay() {
  const display = document.getElementById('viewer-rating-display');
  if (!display) return;

  const filePath = viewerState.currentImagePath;
  if (!filePath) {
    display.style.display = 'none';
    if (typeof updateInfoContainerVisibility === 'function') updateInfoContainerVisibility();
    return;
  }

  const rating = viewerRatings[filePath] || 0;
  if (rating > 0) {
    const starSvg = '<svg class="rating-star-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    display.innerHTML = starSvg + '<span>' + rating + '</span>';
    display.style.display = 'flex';
  } else {
    display.style.display = 'none';
  }
  if (typeof updateInfoContainerVisibility === 'function') updateInfoContainerVisibility();
}

function updateInfoContainerVisibility() {
  const infoContainer = document.getElementById('window-info-container');
  const scaleDisplay = document.getElementById('window-scale-display');
  const ratingDisplay = document.getElementById('viewer-rating-display');
  const controls = document.getElementById('window-controls');
  if (!infoContainer || !controls) return;

  const hasScale = scaleDisplay && scaleDisplay.style.display !== 'none';
  const hasRating = ratingDisplay && ratingDisplay.style.display !== 'none';

  if (hasScale || hasRating) {
    infoContainer.style.display = 'flex';
    controls.classList.add('showing-scale');
  } else {
    infoContainer.style.display = 'none';
    controls.classList.remove('showing-scale');
  }
}

window.updateScaleDisplay = updateScaleDisplay;

// 自動送りモード時のコールバックを登録
setMediaEndedNextHandler(() => {
  // リストの最後のファイルでは進まない（ラップしない）
  if (viewerState.currentIndex < viewerState.totalImages - 1) {
    showNext();
  }
});

export {
  loadImage,
  getMediaWidth,
  getMediaHeight,
  swapImageElement,
  showToast,
  getSavedViewerVolume,
  getSavedViewerMuted,
  applyVolumeSettingsToMedia,
  PLAY_MODES,
  PLAY_MODE_ORDER,
  PLAY_MODE_INFO,
  getSavedViewerPlayMode,
  saveViewerPlayMode,
  applyPlayModeToMedia,
  getActivePlaybackMedia,
  updatePlayModeButtonUI,
  cycleViewerPlayMode,
  stopAndDiscardAudio,
  isDefaultSeekBarEnabled,
  ensureVideoSeekBarContainer,
  setVideoSeekBarVisibility,
  toggleVideoSeekBar,
  createMetadataOverlay,
  toggleMetadataOverlay,
  updateMetadataOverlay
};

if (typeof window !== 'undefined') {
  window.loadImage = loadImage;
  window.isDefaultSeekBarEnabled = isDefaultSeekBarEnabled;
  window.ensureVideoSeekBarContainer = ensureVideoSeekBarContainer;
  window.setVideoSeekBarVisibility = setVideoSeekBarVisibility;
  window.toggleVideoSeekBar = toggleVideoSeekBar;
  window.getActivePlaybackMedia = getActivePlaybackMedia;
  window.stopAndDiscardAudio = stopAndDiscardAudio;
  window.getSavedViewerVolume = getSavedViewerVolume;
  window.getSavedViewerMuted = getSavedViewerMuted;
  window.applyVolumeSettingsToMedia = applyVolumeSettingsToMedia;
  window.showNext = showNext;
  window.showPrev = showPrev;
  window.handleWheel = handleWheel;
  window.PLAY_MODES = PLAY_MODES;
  window.getSavedViewerPlayMode = getSavedViewerPlayMode;
  window.saveViewerPlayMode = saveViewerPlayMode;
  window.applyPlayModeToMedia = applyPlayModeToMedia;
  window.cycleViewerPlayMode = cycleViewerPlayMode;
  window.updatePlayModeButtonUI = updatePlayModeButtonUI;
  window.advanceAfterPathDeleted = advanceAfterPathDeleted;
}

window.addEventListener('beforeunload', () => {
  if (typeof dragRafId !== 'undefined' && dragRafId) {
    cancelAnimationFrame(dragRafId);
    dragRafId = null;
  }
  if (typeof window._resizeRafId !== 'undefined' && window._resizeRafId) {
    cancelAnimationFrame(window._resizeRafId);
    window._resizeRafId = null;
  }
});
