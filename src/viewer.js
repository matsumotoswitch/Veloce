// ============================================================================
// Veloce - Viewer Controller (viewer.js)
// ============================================================================

// 開発者ツール（F12, Ctrl+Shift+I）の強制ブロック
window.addEventListener('keydown', (e) => {
  if (
    (e.ctrlKey && e.shiftKey && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) ||
    e.key === 'F12' || e.code === 'F12'
  ) {
    e.preventDefault();
    e.stopPropagation(); // 他の処理への伝播を完全に遮断
  }
}, true);

// ============================================================================
// 1. Setup & Window Initialization
// ============================================================================

import { viewerState } from './viewer-state.js';
import { ViewerUI, viewerUI } from './viewer-ui.js';
import { debounce } from './utils.js';

const CONFIG = {
  ZOOM_STEP: 1.1,         // マウスホイールでのズーム倍率
  MIN_ZOOM: 0.1,          // 最小ズーム倍率 (10%)
  MAX_ZOOM: 30.0,         // 最大ズーム倍率 (3000%)
  EDGE_THRESHOLD: 10,     // ウィンドウ端のリサイズ判定エリア(px)
  FOCUS_DELAY: 200,       // フォーカス時の誤クリック防止時間(ms)
  RESIZE_THROTTLE: 150    // リサイズイベントの間引き時間(ms)
};

window.addEventListener('focus', () => {
  viewerState.lastFocusTime = Date.now();
});

/**
 * SVGシャープネスフィルターの初期化
 * 小数倍率で拡大した際にも滑らかさを保ちつつ輪郭を強調するためのフィルターを生成します。
 */
function initUnsharpFilter() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svgElement = document.createElementNS(svgNS, "svg");
  svgElement.style.cssText = "position: absolute; width: 0; height: 0; pointer-events: none;";

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

// 画像をビューポート全体にフィットさせるための基本スタイルを適用する。;
document.documentElement.style.overflow = 'hidden';
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.width = '100%';
document.body.style.height = '100%';
document.body.style.backgroundColor = '#1e1e1e';
document.body.style.display = 'flex';
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';
document.body.style.boxSizing = 'border-box';
document.body.style.border = 'none'; // 画像サイズに影響を与えないためborderは外側に描画する

// inset box-shadow だと画像の下に隠れてしまうため、最前面にボーダー用の要素を配置する
const borderOverlay = document.createElement('div');
borderOverlay.id = 'border-overlay';
borderOverlay.style.position = 'fixed';
borderOverlay.style.top = '0';
borderOverlay.style.left = '0';
borderOverlay.style.width = '100vw';
borderOverlay.style.height = '100vh';
borderOverlay.style.pointerEvents = 'none'; // マウス操作（ドラッグ等）を透過して邪魔しない
borderOverlay.style.boxSizing = 'border-box';
borderOverlay.style.border = viewerState.isBorderVisible ? '1px solid #3a7afe' : 'none';
borderOverlay.style.zIndex = '9998'; // コントロールボタンの下、画像の上に配置
document.body.appendChild(borderOverlay);

// 初期状態は画面にフィットさせる
if (viewerUI.elements.viewerImg) {
  viewerUI.elements.viewerImg.style.maxWidth = '100%';
  viewerUI.elements.viewerImg.style.maxHeight = '100%';
}

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
    
    loadImage();

    const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || (window.__TAURI__ && window.__TAURI__.tauri && window.__TAURI__.tauri.listen) || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.listen);
    if (listen) {
      listen('viewers-arranged', () => {
        resetZoomAndFit();
      });
    }
});

// ============================================================================
// 2. Window & View Management
// ============================================================================

/**
 * 画像のズーム状態（100%表示か、画面フィットか）を設定する。
 * @param {boolean} zoomed - true: 100%表示, false: 画面にフィット
 */
function setZoomState(zoomed) {
  viewerState.isZoomed = zoomed;
  if (viewerState.isZoomed) {
    // 100%表示（ズーム）に切り替え
    viewerUI.elements.viewerImg.style.maxWidth = 'none';
    viewerUI.elements.viewerImg.style.maxHeight = 'none';
    viewerUI.elements.viewerImg.style.width = `${viewerUI.elements.viewerImg.naturalWidth}px`;
    viewerUI.elements.viewerImg.style.height = `${viewerUI.elements.viewerImg.naturalHeight}px`;
    viewerUI.setCursor('grab');
  } else {
    // 画面フィットまたはデフォルト表示に切り替え
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
    width: swapped ? viewerUI.elements.viewerImg.naturalHeight : viewerUI.elements.viewerImg.naturalWidth,
    height: swapped ? viewerUI.elements.viewerImg.naturalWidth : viewerUI.elements.viewerImg.naturalHeight
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

  const isSwapped = isRotationSwapped();
  if (viewerState.isFitToWindow) {
    viewerUI.elements.viewerImg.style.maxWidth = 'none';
    viewerUI.elements.viewerImg.style.maxHeight = 'none';
    viewerUI.elements.viewerImg.style.width = isSwapped ? '100vh' : '100vw';
    viewerUI.elements.viewerImg.style.height = isSwapped ? '100vw' : '100vh';
    viewerUI.elements.viewerImg.style.objectFit = 'contain';
  } else {
    // デフォルト（幅に合わせる）
    viewerUI.elements.viewerImg.style.maxWidth = '100%';
    viewerUI.elements.viewerImg.style.maxHeight = 'none';
    viewerUI.elements.viewerImg.style.minWidth = '0';
    viewerUI.elements.viewerImg.style.minHeight = '0';
    viewerUI.elements.viewerImg.style.width = '100%';
    viewerUI.elements.viewerImg.style.height = 'auto';
    viewerUI.elements.viewerImg.style.objectFit = 'contain';
  }
  
  viewerUI.setCursor('default');
  document.body.style.overflowX = 'hidden';
  document.body.style.overflowY = 'auto';
  document.documentElement.style.overflowX = 'hidden';
  document.documentElement.style.overflowY = 'auto';
  document.body.style.justifyContent = 'center';
  document.body.style.alignItems = 'flex-start';
  viewerUI.elements.viewerImg.style.margin = '0';

  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
  document.documentElement.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
}

window.addEventListener('resize', debounce(async () => {
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
      if (overlay) overlay.style.border = 'none';
      const controls = document.getElementById('window-controls');
      if (controls) controls.style.display = 'none';
    } else if (!isFs && viewerState.isFullscreen) {
      viewerState.isFullscreen = false;
      viewerUI.applyBorderVisibility();
    }
    
    updateFullscreenStyles();
}, CONFIG.RESIZE_THROTTLE)); // ドラッグ中の高頻度なイベントを間引く

/**
 * フルスクリーン（100%表示）時のスタイルを更新する。
 * スクロールバーの表示・非表示や、画像の配置を決定する。
 */
function updateFullscreenStyles() {
  if (!viewerState.isZoomed) {
    document.body.style.justifyContent = 'center';
    document.body.style.alignItems = 'flex-start';
    document.body.style.overflowX = 'hidden';
    document.body.style.overflowY = 'auto';
    viewerUI.elements.viewerImg.style.margin = '0';
    window.scrollTo(0, 0);
    return;
  }

  // ドラッグでスクロール操作を行うため、スクロールバーは常に非表示にします。
  document.body.style.overflow = 'hidden';

  // 回転による視覚的サイズとレイアウトサイズのズレを margin で補正する
  const isSwapped = isRotationSwapped();
  
  if (isSwapped) {
    const marginY = (viewerUI.elements.viewerImg.naturalWidth - viewerUI.elements.viewerImg.naturalHeight) / 2;
    const marginX = (viewerUI.elements.viewerImg.naturalHeight - viewerUI.elements.viewerImg.naturalWidth) / 2;
    viewerUI.elements.viewerImg.style.margin = `${marginY}px ${marginX}px`;
  } else {
    viewerUI.elements.viewerImg.style.margin = '0';
  }

  // 補正後のサイズ（レイアウト上のサイズ＝視覚的なサイズ）
  const { width: imgWidth, height: imgHeight } = getNaturalDimensions();

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const overflowX = imgWidth > winW;
  const overflowY = imgHeight > winH;

  if (!overflowX && !overflowY) {
    // 上下左右に余白が発生する場合
    document.body.style.justifyContent = 'center';
    document.body.style.alignItems = 'center';
  } else if (!overflowX && overflowY) {
    // 左右にのみ余白が発生する場合 -> 画像最上部が見えるように左右中央
    document.body.style.justifyContent = 'center';
    document.body.style.alignItems = 'flex-start';
  } else if (overflowX && !overflowY) {
    // 上下にのみ余白が発生する場合 -> 画像最左部が見えるように上下中央
    document.body.style.justifyContent = 'flex-start';
    document.body.style.alignItems = 'center';
  } else {
    // 余白がない場合（両方はみ出す場合）
    // Flexboxのcenterだとスクロールで端に行けなくなるためflex-startとし、スクロール位置で中央を表現する
    document.body.style.justifyContent = 'flex-start';
    document.body.style.alignItems = 'flex-start';
    document.body.scrollLeft = (imgWidth - winW) / 2;
    document.body.scrollTop = (imgHeight - winH) / 2;
  }
}

// ============================================================================
// 3. Image Navigation & Loading
// ============================================================================

/*現在のインデックス (`currentIndex`) に基づいて画像を表示し、ウィンドウタイトルを更新する。
 * 表示後、前後の画像をバックグラウンドでプリロードする。
 */
async function loadImage() {
  viewerState.currentScale = 1.0;
  viewerState.currentTranslateX = 0;
  viewerState.currentTranslateY = 0;
  // RustのStateから現在表示すべき画像のパスと全体枚数を取得
  const result = await window.veloceAPI.getViewerImage(viewerState.currentIndex);
  if (result) {
    viewerState.currentImagePath = result.path;
    viewerState.totalImages = result.total;
    viewerState.previousWindowSize = null; // トグル状態をリセット

    if (viewerState.preloadCache.has(viewerState.currentIndex)) {
      const cachedData = viewerState.preloadCache.get(viewerState.currentIndex);
      viewerState.currentImagePath = cachedData.path; // パスを更新
      if (viewerUI.elements.viewerImg) {
        viewerUI.elements.viewerImg.src = cachedData.img.src;
      }
    } else {
      const assetUrl = window.veloceAPI.convertFileSrc(viewerState.currentImagePath);
      if (viewerUI.elements.viewerImg) {
        viewerUI.elements.viewerImg.src = assetUrl;
      }
    }
    preloadAdjacentImages();

    document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
    viewerUI.elements.viewerImg.onload = () => {
      setZoomState(viewerState.isZoomed);
      viewerUI.updateImageRendering();

      // 回転を考慮した本来のサイズを取得
      const { width: natW, height: natH } = getNaturalDimensions();

      // GCAが実装してくれた natW と natH（回転考慮済みサイズ）をそのまま使用
      const neededWindowWidth = natW;
      const neededWindowHeight = natH;

      // モニター限界サイズ（全画面化バグ回避のため高さのみ-1）
      const maxWindowWidth = window.screen.width;
      const maxWindowHeight = window.screen.height - 1;

      // 縮小率の計算
      const ratioX = maxWindowWidth / neededWindowWidth;
      const ratioY = maxWindowHeight / neededWindowHeight;
      const scale = Math.min(ratioX, ratioY, 1.0);

      // 最終的なウィンドウサイズを決定
      const targetWidth = Math.floor(neededWindowWidth * scale);
      const targetHeight = Math.floor(neededWindowHeight * scale);

      // リサイズの実行と枠の再適用
      if (!viewerState.isFullscreen && !document.fullscreenElement) {
        if (window.veloceAPI && window.veloceAPI.setWindowSize) {
          window.veloceAPI.setWindowSize(targetWidth, targetHeight).then(() => {
            if (window.veloceAPI.toggleWindowDecorations) {
              window.veloceAPI.toggleWindowDecorations(viewerState.isBorderVisible);
            }
          });
        }
      }
    };
  }
}

async function preloadAdjacentImages() {
  const indicesToPreload = [viewerState.currentIndex + 1, viewerState.currentIndex - 1];
  for (const idx of indicesToPreload) {
    if (idx >= 0 && idx < viewerState.totalImages && !viewerState.preloadCache.has(idx)) {
      const result = await window.veloceAPI.getViewerImage(idx);
      if (result) {
        const url = window.veloceAPI.convertFileSrc(result.path);
        const img = new Image();
        img.src = url; // ブラウザのメモリキャッシュに読み込ませる
        viewerState.preloadCache.set(idx, { 
          img: img, 
          path: result.path 
        });
      }
    }
  }
  // 不要になった古いキャッシュ（現在地から離れたもの）を削除してメモリを節約
  for (const cachedIdx of viewerState.preloadCache.keys()) {
    if (Math.abs(cachedIdx - viewerState.currentIndex) > 2) {
      viewerState.preloadCache.delete(cachedIdx);
    }
  }
}

/**
 * 前の画像を表示する。
 */
function showPrev() {
  viewerState.currentIndex = (viewerState.currentIndex > 0) ? viewerState.currentIndex - 1 : viewerState.totalImages - 1;
  loadImage();
}

/**
 * 次の画像を表示する。
 */
function showNext() {
  viewerState.currentIndex = (viewerState.currentIndex < viewerState.totalImages - 1) ? viewerState.currentIndex + 1 : 0;
  loadImage();
}

// ============================================================================
// 4. UI Controls
// ============================================================================

// ドラッグ、クリック、ダブルクリックを判別するための状態変数
let isDragging = false;
let hasMoved = false; // ドラッグ中に実際にマウスが移動したか
let startX = 0, startY = 0; // ドラッグ開始時の座標
let scrollLeftStart = 0, scrollTopStart = 0; // ドラッグ開始時のスクロール位置
let windowX = 0, windowY = 0; // ウィンドウ移動用の座標

// OS標準のタイトルバーのホバーバグを回避するため、HTMLで自前のコントロールを右上に描画する
function createWindowControls() {
  const controlsContainer = document.createElement('div');
  controlsContainer.id = 'window-controls';
  controlsContainer.style.position = 'fixed';
  controlsContainer.style.top = '1px'; // 青い枠線(1px)の内側に配置
  controlsContainer.style.right = '1px';
  controlsContainer.style.display = 'flex';
  controlsContainer.style.zIndex = '9999'; // 画像より手前になるよう最前面に配置
  controlsContainer.style.visibility = 'visible'; // 確実に表示されるように設定
  controlsContainer.style.transition = 'opacity 0.2s';
  controlsContainer.style.opacity = viewerState.isBorderVisible ? '1' : '0';
  // ドラッグ操作や画像の切り替え操作と干渉しないようにする
  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(evt => {
    controlsContainer.addEventListener(evt, (e) => e.stopPropagation());
  });

  const buttonStyle = `
    width: 46px;
    height: 30px;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: default;
    transition: background-color 0.1s;
  `;

  // 最小化ボタン
  const minBtn = document.createElement('div');
  minBtn.style.cssText = buttonStyle;
  minBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  minBtn.innerHTML = `<svg viewBox="0 0 10 1" width="10" height="1"><rect width="10" height="1" fill="#fff"/></svg>`;
  minBtn.onmouseenter = () => minBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  minBtn.onmouseleave = () => minBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  minBtn.onclick = () => window.veloceAPI.minimizeViewer();

  // 最大化/元に戻すボタン
  const maxBtn = document.createElement('div');
  maxBtn.id = 'window-max-btn';
  maxBtn.style.cssText = buttonStyle;
  maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  maxBtn.innerHTML = ViewerUI.ICONS.MAXIMIZE;
  maxBtn.onmouseenter = () => maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  maxBtn.onmouseleave = () => maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  maxBtn.onclick = () => window.veloceAPI.maximizeViewer();

  // 閉じるボタン
  const closeBtn = document.createElement('div');
  closeBtn.style.cssText = buttonStyle;
  closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.2)';
  closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0,0 L10,10 M10,0 L0,10" stroke="#fff" stroke-width="1"/></svg>`;
  closeBtn.onmouseenter = () => closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.5)'; // Windowsの閉じるボタンの赤色（半透明）
  closeBtn.onmouseleave = () => closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.2)';
  closeBtn.onclick = () => {
    if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
  };

  controlsContainer.appendChild(minBtn);
  controlsContainer.appendChild(maxBtn);
  controlsContainer.appendChild(closeBtn);
  document.body.appendChild(controlsContainer);
}

createWindowControls();

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
    isDragging = true;
    hasMoved = false;
    if (viewerState.isZoomed) {
      startX = e.pageX;
      startY = e.pageY;
      scrollLeftStart = document.body.scrollLeft;
      scrollTopStart = document.body.scrollTop;
      viewerUI.setCursor('grabbing');
    } else {
      // OSのネイティブリサイズと競合しないよう、縁は移動の対象外
      const EDGE = CONFIG.EDGE_THRESHOLD;
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE ||
          e.clientY < EDGE || e.clientY > window.innerHeight - EDGE) {
        isDragging = false;
        return;
      }
      startX = e.screenX;
      startY = e.screenY;
      windowX = e.clientX;
      windowY = e.clientY;
    }
  }
});

let dragRafId = null;
window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    if (!hasMoved) {
      const movedX = viewerState.isZoomed ? e.pageX : e.screenX;
      const movedY = viewerState.isZoomed ? e.pageY : e.screenY;
      if (Math.abs(movedX - startX) > 5 || Math.abs(movedY - startY) > 5) {
        hasMoved = true;
      }
    }
    if (hasMoved) {
      if (dragRafId) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        if (viewerState.isZoomed) {
          document.body.scrollLeft = scrollLeftStart - (e.pageX - startX);
          document.body.scrollTop = scrollTopStart - (e.pageY - startY);
        } else {
          window.veloceAPI.moveViewerWindow(e.screenX - windowX, e.screenY - windowY);
        }
      });
    }
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { // 左クリックのリリース
    if (viewerState.isZoomed) {
      viewerUI.setCursor('grab');
    }
    isDragging = false;
    if (!hasMoved && !viewerState.ignoreNextClick && !viewerState.isImageDragging) {
      showPrev();
    }
  }
});

// Ctrlキーを押した時だけ「手のひら」カーソルにして、ドラッグ可能であることを示す
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control') viewerUI.setCursor('grab');
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control' && !viewerState.isImageDragging) viewerUI.setCursor('default');
});
// ドラッグ開始（Ctrlを押している時のみ）
viewerUI.elements.viewerImg.addEventListener('mousedown', (e) => {
  if (e.ctrlKey && e.button === 0) {
    e.preventDefault(); // Macの右クリック化やOSの標準ドラッグを防止
    e.stopPropagation(); // 既存のウィンドウドラッグ処理との競合を防止
    viewerState.isImageDragging = true;
    viewerState.imageDragStartX = e.clientX;
    viewerState.imageDragStartY = e.clientY;
    viewerUI.setCursor('grabbing'); // 掴んでいるカーソル
  }
});

// ドラッグ中（移動量の計算と適用）
window.addEventListener('mousemove', (e) => {
  if (viewerState.isImageDragging) {
    viewerState.currentTranslateX += e.clientX - viewerState.imageDragStartX;
    viewerState.currentTranslateY += e.clientY - viewerState.imageDragStartY;
    viewerState.imageDragStartX = e.clientX;
    viewerState.imageDragStartY = e.clientY;
    viewerUI.updateImageRendering();
  }
});

// ドラッグ終了
window.addEventListener('mouseup', (e) => {
  if (viewerState.isImageDragging && e.button === 0) {
    viewerState.isImageDragging = false;
    viewerUI.setCursor(e.ctrlKey ? 'grab' : 'default');
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault(); 
  if (viewerState.ignoreNextClick) return; // フォーカス目的の右クリックを無視
  showNext(); // 右クリックで次の画像へ
});

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault(); // ブラウザ標準のズームを無効化

    // ホイールの回転方向に応じてスケールを増減（約10%ずつなめらかに変化）
    if (e.deltaY < 0) {
      viewerState.currentScale *= 1.1; // 上スクロールで拡大
      viewerState.currentScale *= CONFIG.ZOOM_STEP; // 上スクロールで拡大
    } else {
      viewerState.currentScale /= 1.1; // 下スクロールで縮小
      viewerState.currentScale /= CONFIG.ZOOM_STEP; // 下スクロールで縮小
    }

    // 倍率の限界値を設定（10% ～ 3000%）
    viewerState.currentScale = Math.max(0.1, Math.min(viewerState.currentScale, 30.0));
    viewerState.currentScale = Math.max(CONFIG.MIN_ZOOM, Math.min(viewerState.currentScale, CONFIG.MAX_ZOOM));

    // 画像に適用
    if (typeof viewerUI.updateImageRendering === 'function') {
      viewerUI.updateImageRendering();
    }
  } else {
    if (e.deltaY > 0) {
      showNext(); // 下スクロールで次へ
    } else if (e.deltaY < 0) {
      showPrev(); // 上スクロールで前へ
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

    case 'ArrowRight':
      showNext();
      break;
    case 'ArrowUp':
      viewerState.currentRotation += 90;
      viewerUI.updateImageRendering();
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'ArrowDown':
      viewerState.currentRotation -= 90;
      viewerUI.updateImageRendering();
      applyFitState();
      updateFullscreenStyles();
      break;
    case '0': {
      e.preventDefault();
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
    case '1': {
      e.preventDefault();
      const { width: natW, height: natH } = getNaturalDimensions();

      if (window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
        window.veloceAPI.resizeViewerWindow(natW, natH);
      }

      resetZoomAndFit();
      break;
    }
    case 'Escape':
      if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
      break;
    case 'Enter':
      e.preventDefault();
      viewerState.isZoomed = false; // 100%ズームを解除
      viewerState.isFitToWindow = !viewerState.isFitToWindow; // 強制フィット状態をトグル
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'F11':
      e.preventDefault(); // ブラウザ標準のフルスクリーン動作を防ぐ
      window.veloceAPI.toggleViewerFullscreen();
      break;
    case 'w':
    case 'W':
      if (!viewerState.isFullscreen) {
        if (viewerState.previousWindowSize) { // 既にフィットしている場合は元のサイズに戻す
          window.veloceAPI.resizeViewerWindow(viewerState.previousWindowSize.width, viewerState.previousWindowSize.height);
          viewerState.previousWindowSize = null;
        } else { // 現在のサイズを保存し、画像サイズに合わせてリサイズする
          viewerState.previousWindowSize = { width: window.innerWidth, height: window.innerHeight };
          const { width: natW, height: natH } = getNaturalDimensions();
          
          let targetW = natW;
          let targetH = natH;

          // ズームされていない（縮小表示等されている）場合は、現在の表示サイズを計算して合わせる
          if (!viewerState.isZoomed) {
            const scale = viewerState.isFitToWindow 
              ? Math.min(window.innerWidth / natW, window.innerHeight / natH)
              : Math.min(1, window.innerWidth / natW, window.innerHeight / natH);
            targetW = Math.round(natW * scale);
            targetH = Math.round(natH * scale);
          }

          window.veloceAPI.resizeViewerWindow(targetW, targetH);
        }
      }
      break;
    case 'a':
    case 'A':
      if (window.veloceAPI.arrangeViewers) window.veloceAPI.arrangeViewers();
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
  }
  
  if (e.key === 'Delete') {
	if (viewerState.currentImagePath) {
	  const success = await window.veloceAPI.trashFile(viewerState.currentImagePath);
	  if (success) {
        // 削除成功時、ビューアーを閉じずに次の画像（最後なら前の画像）へ移動する
        if (viewerState.currentIndex < viewerState.totalImages - 1) {
          viewerState.totalImages--; // 全体枚数を減らす
          loadImage(); // currentIndexを維持したままロード＝次の画像になる
        } else if (viewerState.currentIndex > 0) {
          viewerState.totalImages--;
          viewerState.currentIndex--; // 最後の画像だった場合は1つ前に戻る
          loadImage();
        } else {
          // 画像が1枚もなくなった場合はウィンドウを閉じる
          if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
        }
	  }
	}
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
	if (viewerState.currentImagePath) {
	  window.veloceAPI.copyImageToClipboard(viewerState.currentImagePath);
      // 共通の光るエフェクトを適用
      if (viewerUI.elements.viewerImg) {
        viewerUI.applyGlowEffect(viewerUI.elements.viewerImg);
      }
	}
  }
});
