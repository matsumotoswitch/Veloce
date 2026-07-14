// ============================================================================
// Veloce - Viewer Controller (viewer.js)
// ============================================================================

import { viewerState } from './viewer-state.js';
import { ViewerUI, viewerUI } from './viewer-ui.js';
import { debounce, blockDevtoolsShortcuts } from './utils.js';

blockDevtoolsShortcuts();

let viewerRatings = {};

const CONFIG = {
  ZOOM_STEP: 1.1,         // マウスホイールでのズーム倍率
  MIN_ZOOM: 0.1,          // 最小ズーム倍率 (10%)
  MAX_ZOOM: 30.0,         // 最大ズーム倍率 (3000%)
  EDGE_THRESHOLD: 10,     // ウィンドウ端のリサイズ判定エリア(px)
  FOCUS_DELAY: 200,       // フォーカス時の誤クリック防止時間(ms)
  RESIZE_THROTTLE: 150    // リサイズイベントの間引き時間(ms)
};

function getMediaWidth(media) {
  return media.tagName === 'VIDEO' ? (media.videoWidth || 1) : (media.naturalWidth || 1);
}

function getMediaHeight(media) {
  return media.tagName === 'VIDEO' ? (media.videoHeight || 1) : (media.naturalHeight || 1);
}

window.addEventListener('focus', () => {
  viewerState.lastFocusTime = Date.now();
});

let currentViewerImg = document.getElementById('viewer-img');
if (currentViewerImg) currentViewerImg.classList.add('mode-default');

/**
 * SVGシャープネスフィルターの初期化
 * 小数倍率で拡大した際にも滑らかさを保ちつつ輪郭を強調するためのフィルターを生成します。
 */
function initUnsharpFilter() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svgElement = document.createElementNS(svgNS, "svg");
  svgElement.setAttribute("class", "unsharp-svg");
  svgElement.style.position = 'absolute';
  svgElement.style.width = '0';
  svgElement.style.height = '0';
  svgElement.style.pointerEvents = 'none';

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

window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const indexParam = urlParams.get('index');
    if (indexParam !== null) {
      viewerState.currentIndex = parseInt(indexParam, 10);
    }

    // ウィンドウが最大化されているかを非同期で確認しアイコンを更新する
    window.veloceAPI.isViewerMaximized().then(isMax => {
      if (isMax) {
        const maxBtn = document.getElementById('window-max-btn');
        if (maxBtn) maxBtn.innerHTML = ViewerUI.ICONS.RESTORE;
      }
    }).catch(() => {});

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
      viewerUI.elements.viewerImg.onload = () => {
        setZoomState(viewerState.isZoomed);
        viewerUI.updateImageRendering();
        resizeWindowToFitImage();
      };
    }

    // IPC通信のラグを隠蔽するため、LocalStorageから初期データを取得して即座に描画を開始する
    const initialDataJson = localStorage.getItem('viewerInitialData');
    if (initialDataJson) {
      try {
        const initialData = JSON.parse(initialDataJson);
        viewerState.currentImagePath = initialData.path;
        viewerState.totalImages = initialData.total;
        
        if (!initialTotal) viewerState.paths = new Array(initialData.total).fill(null); // フォールバック時の初期化
        // paths に格納しておくことで loadImage() → getImagePath() の冗長 IPC 往復を排除する (#6)
        if (viewerState.paths && viewerState.currentIndex >= 0) {
          viewerState.paths[viewerState.currentIndex] = initialData.path;
        }
        const assetUrl = initialData.path.toLowerCase().endsWith('.mp4') 
          ? `https://stream.localhost/?path=${encodeURIComponent(initialData.path)}` 
          : window.veloceAPI.convertFileSrc(initialData.path);
        if (viewerUI.elements.viewerImg) {
          if (initialData.path.toLowerCase().endsWith('.mp4')) {
            const video = document.createElement('video');
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.id = 'viewer-img';
            video.src = assetUrl;
            
            viewerUI.elements.viewerImg.parentNode.replaceChild(video, viewerUI.elements.viewerImg);
            viewerUI.elements.viewerImg = video;
            currentViewerImg = video;

            const onMeta = () => {
              setZoomState(viewerState.isZoomed);
              viewerUI.updateImageRendering();
              resizeWindowToFitImage();
            };
            if (video.readyState >= 1) { // HAVE_METADATA
              onMeta();
            } else {
              video.addEventListener('loadedmetadata', onMeta, { once: true });
            }
          } else {
            viewerUI.elements.viewerImg.src = assetUrl;
          }
        }
        document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
      } catch (e) {}
      localStorage.removeItem('viewerInitialData');
    }
    
    loadImage();

    const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || (window.__TAURI__ && window.__TAURI__.tauri && window.__TAURI__.tauri.listen) || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.listen);
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
      listen('viewers-arranged', () => {
        viewerState.isImmersiveArranged = true;
        resetZoomAndFit();
      });
      listen('viewer-list-updated', (event) => {
        const newPaths = event.payload || []; // 更新されたファイルパスのリスト
        viewerState.paths = newPaths;
        const newIndex = newPaths.indexOf(viewerState.currentImagePath);
        
        // ソートやフィルタで順序が変わったため、古いインデックスのキャッシュをすべて破棄
        viewerState.preloadCache.clear();

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
      const show = localStorage.getItem('showViewerFilename') !== 'false';
      
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
    window.addEventListener('storage', (e) => {
      if (e.key === 'showViewerFilename') updateFilenameVisibility();
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

const resizeObserver = new ResizeObserver(debounce(async () => {
    // リサイズ中にIPC通信（await invoke）を行うとOSのメッセージループが詰まり
    // 例外0xc000041dでクラッシュするため、ブラウザのAPIを用いて判定する
    const isMax = window.innerWidth >= window.screen.availWidth - 10 && window.innerHeight >= window.screen.availHeight - 10;
    const maxBtn = document.getElementById('window-max-btn');
    if (maxBtn) {
      maxBtn.innerHTML = isMax ? ViewerUI.ICONS.RESTORE : ViewerUI.ICONS.MAXIMIZE;
    }

    const isFs = window.innerHeight === window.screen.height;
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
}, CONFIG.RESIZE_THROTTLE));
resizeObserver.observe(document.body);

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

  if (window.veloceAPI && window.veloceAPI.setWindowSize) {
    window.veloceAPI.setWindowSize(targetWidth, targetHeight).then(() => {
      debouncedFocusWindow(); // 連続呼び出しによるフォーカス外れを防ぐためデバウンス処理を行う
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
    if (viewerState.paths) viewerState.paths[index] = result.path;
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
    if (!isViewerWindowShown && window.veloceAPI && window.veloceAPI.showWindow) {
      window.veloceAPI.showWindow();
      isViewerWindowShown = true;
    }
    return;
  }
  
  newImg.id = 'viewer-img';
  viewerUI.elements.viewerImg = newImg;
  
  const borderOverlay = document.getElementById('border-overlay');
  if (borderOverlay && borderOverlay.parentNode) {
    document.body.insertBefore(newImg, borderOverlay);
  } else {
    document.body.appendChild(newImg);
  }

  if (currentViewerImg && currentViewerImg.parentNode) {
    currentViewerImg.remove();
  }
  
  currentViewerImg = newImg;

  const onImageReady = async () => {
    // 古い画像ロード要求の完了イベントであればスキップする
    if (sequenceId !== imageLoadSequence) return;

    setZoomState(viewerState.isZoomed);
    viewerUI.updateImageRendering();
    resizeWindowToFitImage();

    try {
      // Rust側へウィンドウの表示命令を出す（毎回呼ぶとちらつくため初回のみ）
      if (!isViewerWindowShown && window.veloceAPI && window.veloceAPI.showWindow) {
        await window.veloceAPI.showWindow();
        isViewerWindowShown = true;
      }
    } catch (e) {}
  };

  if (newImg.tagName === 'VIDEO') {
    if (newImg.readyState >= 1) { // HAVE_METADATA
      onImageReady();
    } else {
      newImg.addEventListener('loadedmetadata', onImageReady, { once: true });
      newImg.addEventListener('error', onImageReady, { once: true });
    }
  } else {
    if (newImg.complete) {
      onImageReady();
    } else {
      newImg.addEventListener('load', onImageReady, { once: true });
      newImg.addEventListener('error', onImageReady, { once: true });
    }
  }
}

async function loadImage() {

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
    if (viewerState.preloadCache.has(viewerState.currentIndex)) {
      const cachedData = viewerState.preloadCache.get(viewerState.currentIndex);
      if (cachedData.path === viewerState.currentImagePath) {
        targetImg = cachedData.img;
      }
    }

    const targetSrc = viewerState.currentImagePath.toLowerCase().endsWith('.mp4')
      ? `https://stream.localhost/?path=${encodeURIComponent(viewerState.currentImagePath)}`
      : window.veloceAPI.convertFileSrc(viewerState.currentImagePath);
    if (!targetImg && currentViewerImg && currentViewerImg.src === targetSrc) {
      targetImg = currentViewerImg;
    }

    if (!targetImg) {
      if (targetSrc.toLowerCase().endsWith('.mp4')) {
        targetImg = document.createElement('video');
        targetImg.autoplay = true;
        targetImg.loop = true;
        targetImg.muted = true;
      } else {
        targetImg = document.createElement('img');
        targetImg.decoding = 'async';
      }
      targetImg.src = targetSrc;
    }

    try {
      if (targetImg.tagName === 'IMG') {
        await targetImg.decode();
      } else if (targetImg.tagName === 'VIDEO' && targetImg.readyState === 0) {
        await new Promise(res => {
          targetImg.addEventListener('loadedmetadata', res, { once: true });
          targetImg.addEventListener('error', res, { once: true });
        });
      }
    } catch (err) {
      console.warn("Background decode failed:", err);
    }

    if (currentSeq !== imageLoadSequence) return;

    swapImageElement(targetImg, currentSeq);
    preloadAdjacentImages();
    if (typeof updateRatingDisplay === 'function') updateRatingDisplay();

    document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
    const filenameEl = document.getElementById('window-filename-display');
    if (filenameEl && path) {
      filenameEl.textContent = path.split(/[/\\]/).pop();
    }
  }
}

async function preloadAdjacentImages() {
  // ±2 までプリロード（±1 では大きい画像で次画像待ちが発生するため） (#7)
  const indicesToPreload = [
    viewerState.currentIndex + 1,
    viewerState.currentIndex - 1,
    viewerState.currentIndex + 2,
    viewerState.currentIndex - 2,
  ];
  for (const idx of indicesToPreload) {
    if (idx >= 0 && idx < viewerState.totalImages && !viewerState.preloadCache.has(idx)) {
      const path = await getImagePath(idx);
      if (path) {
        const url = path.toLowerCase().endsWith('.mp4')
          ? `https://stream.localhost/?path=${encodeURIComponent(path)}`
          : window.veloceAPI.convertFileSrc(path);
        let img;
        if (path.toLowerCase().endsWith('.mp4')) {
          img = document.createElement('video');
          img.autoplay = true;
          img.loop = true;
          img.muted = true;
        } else {
          img = document.createElement('img');
          img.decoding = 'async';
        }
        img.src = url;
        viewerState.preloadCache.set(idx, { img: img, path: path });
      }
    }
  }
  // 不要になった古いキャッシュ（現在地から離れたもの）を削除してメモリを節約
  for (const cachedIdx of viewerState.preloadCache.keys()) {
    if (Math.abs(cachedIdx - viewerState.currentIndex) > 3) {
      viewerState.preloadCache.delete(cachedIdx);
    }
  }
}

/**
 * 次の画像を表示する (Next)
 */
function showNext() {
  viewerState.currentIndex = (viewerState.currentIndex < viewerState.totalImages - 1) ? viewerState.currentIndex + 1 : 0;
  loadImage();
}

/**
 * 前の画像を表示する (Prev)
 */
function showPrev() {
  viewerState.currentIndex = (viewerState.currentIndex > 0) ? viewerState.currentIndex - 1 : viewerState.totalImages - 1;
  loadImage();
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

  const img = viewerUI.elements.viewerImg;
  const rect = img.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const baseLeft = rect.left - viewerState.currentTranslateX;
  const baseTop = rect.top - viewerState.currentTranslateY;
  const baseRight = rect.right - viewerState.currentTranslateX;
  const baseBottom = rect.bottom - viewerState.currentTranslateY;

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

// OS標準のタイトルバーのホバーバグを回避するため、HTMLで自前のコントロールを右上に描画する
function createWindowControls() {
  const controlsContainer = document.createElement('div');
  controlsContainer.id = 'window-controls';
  if (!viewerState.isBorderVisible) controlsContainer.classList.add('controls-hidden');
  ['click', 'dblclick'].forEach(evt => {
    controlsContainer.addEventListener(evt, (e) => e.stopPropagation());
  });

  // 最小化ボタン
  const minBtn = document.createElement('div');
  minBtn.className = 'window-ctrl-btn window-ctrl-btn--min';
  minBtn.innerHTML = `<svg viewBox="0 0 10 1" width="10" height="1"><rect width="10" height="1" fill="#fff"/></svg>`;
  minBtn.onclick = () => window.veloceAPI.minimizeViewer();

  // 最大化/元に戻すボタン
  const maxBtn = document.createElement('div');
  maxBtn.id = 'window-max-btn';
  maxBtn.className = 'window-ctrl-btn window-ctrl-btn--max';
  maxBtn.innerHTML = ViewerUI.ICONS.MAXIMIZE;
  maxBtn.onclick = () => window.veloceAPI.maximizeViewer();

  // 閉じるボタン
  const closeBtn = document.createElement('div');
  closeBtn.className = 'window-ctrl-btn window-ctrl-btn--close';
  closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0,0 L10,10 M10,0 L0,10" stroke="#fff" stroke-width="1"/></svg>`;
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
  infoContainer.style.display = 'none';
  infoContainer.style.alignItems = 'center';
  infoContainer.style.justifyContent = 'center';
  infoContainer.style.height = '30px';
  infoContainer.style.padding = '0 12px';

  const ratingDisplay = document.createElement('div');
  ratingDisplay.id = 'viewer-rating-display';
  ratingDisplay.style.display = 'none';
  ratingDisplay.style.alignItems = 'center';
  ratingDisplay.style.marginRight = '8px';
  ratingDisplay.style.color = 'rgba(255, 255, 255, 0.9)';
  ratingDisplay.style.fontSize = 'var(--font-size-xs)';
  ratingDisplay.style.fontWeight = '600';
  ratingDisplay.style.fontVariantNumeric = 'tabular-nums';
  ratingDisplay.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)';

  const scaleDisplay = document.createElement('div');
  scaleDisplay.id = 'window-scale-display';
  scaleDisplay.className = 'window-scale-display';
  scaleDisplay.style.display = 'none';
  // padding をリセット（親で持つため）
  scaleDisplay.style.padding = '0';

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
      viewerUI.updateImageRendering();
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

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault(); // ブラウザ標準のズームを無効化し、親ウィンドウへのイベント伝播を防ぐ
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
    viewerUI.updateImageRendering();
    clampTranslate();
    viewerUI.updateImageRendering();
    updateFullscreenStyles(); // マージンの再計算
    debouncedFocusWindow();   // フォーカスの維持
  } else {
    e.preventDefault(); // 親ウィンドウのスクロールを防止
    
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

    if (steps !== 0) {
      viewerState.currentIndex = (viewerState.currentIndex + steps % viewerState.totalImages + viewerState.totalImages) % viewerState.totalImages;
      loadImage();
    }
  }
}, { passive: false });

window.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+I で開発者ツールをトグル表示
  if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      showPrev();
      break;
    case 'ArrowRight':
      showNext();
      break;
    case 'ArrowUp':
      viewerState.currentRotation += 90;
      viewerUI.updateImageRendering();
      resizeWindowToFitImage();
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'ArrowDown':
      viewerState.currentRotation -= 90;
      viewerUI.updateImageRendering();
      resizeWindowToFitImage();
      applyFitState();
      updateFullscreenStyles();
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
        if (rating === 0) {
          showToast('レーティングを解除しました');
        } else {
          const starSvg = '<svg viewBox="0 0 24 24" width="16" height="16" style="fill: var(--glow-gold, #ffd700); display: inline-block; vertical-align: text-bottom; margin-right: 2px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
          showToast(starSvg + rating);
        }
      }
      break;
    }
    case 'Escape':
      if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
      break;
    case 'F11':
      e.preventDefault(); // ブラウザ標準のフルスクリーン動作を防ぐ
      window.veloceAPI.toggleViewerFullscreen();
      break;
    case 'a':
    case 'A':
      if (window.veloceAPI.arrangeViewers) {
        window.veloceAPI.arrangeViewers();
      }
      break;
    case 'b':
    case 'B':
      viewerState.isBorderVisible = !viewerState.isBorderVisible;
      viewerUI.applyBorderVisibility();
      break;
    case 'u':
    case 'U':
      viewerState.isUnsharped = !viewerState.isUnsharped;
      viewerUI.updateImageRendering();
      break;
    case 'h':
    case 'H':
      viewerState.flipX *= -1;
      viewerUI.updateImageRendering();
      break;
    case 'v':
    case 'V':
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
          // メイン画面に通知し、そこからbroadcastされる `viewer-list-updated` イベントで画像の切り替えを処理する
          await window.veloceAPI.notifyFileRemoved(deletedPath);
        } else {
          // APIがない場合のフォールバック
          viewerState.paths.splice(viewerState.currentIndex, 1);
          viewerState.totalImages = viewerState.paths.length;
          if (viewerState.paths.length > 0) {
            if (viewerState.currentIndex >= viewerState.paths.length) {
              viewerState.currentIndex = viewerState.paths.length - 1;
            }
            loadImage(); 
          } else {
            if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
          }
        }
      }
    }
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    if (viewerState.currentImagePath) {
      window.veloceAPI.copyImageToClipboard(viewerState.currentImagePath);
      // 画像のコピーとシャッターフラッシュエフェクトの適用
      let flash = document.getElementById('viewer-flash-effect');
      if (!flash) {
        flash = document.createElement('div');
        flash.id = 'viewer-flash-effect';
        flash.style.position = 'fixed';
        flash.style.top = '0';
        flash.style.left = '0';
        flash.style.width = '100vw';
        flash.style.height = '100vh';
        flash.style.pointerEvents = 'none';
        flash.style.zIndex = '9998';
        flash.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
        flash.style.transition = 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
        document.body.appendChild(flash);
      }
      
      flash.style.transition = 'none';
      flash.style.opacity = '0.35';
      
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          flash.style.transition = 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
          flash.style.opacity = '0';
        });
      });

      // コピー完了を通知するトーストの表示
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
      
      let toast = document.createElement('div');
      toast.className = 'toast-message success';
      toast.textContent = '画像をクリップボードにコピーしました';
      container.appendChild(toast);
      
      requestAnimationFrame(() => {
        toast.classList.add('show');
      });
      
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          if (toast.parentElement) toast.remove();
        }, 300);
      }, 3000);
	}
  }
});

// --- 拡大縮小率の表示更新 ---
function updateScaleDisplay() {
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
    const starSvg = '<svg viewBox="0 0 24 24" width="14" height="14" style="fill: var(--glow-gold, #ffd700); display: inline-block; vertical-align: text-bottom; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.8));"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    display.innerHTML = starSvg + '<span style="margin-left: 2px;">' + rating + '</span>';
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
    // CSS の代わり
    if (!controls.classList.contains('has-gradient')) {
      infoContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
      infoContainer.style.borderBottomLeftRadius = 'var(--radius-sm)';
    }
  } else {
    infoContainer.style.display = 'none';
    controls.classList.remove('showing-scale');
    infoContainer.style.backgroundColor = '';
  }
}

window.updateScaleDisplay = updateScaleDisplay;
