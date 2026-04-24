// Ctrl+Shift+I の強制ブロック（キャプチャフェーズ）
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) {
    e.preventDefault();
    e.stopPropagation(); // 他の処理への伝播を完全に遮断
  }
}, true);

// --- グローバル状態管理 ---
let currentIndex = 0;
let totalImages = 0;
let currentImagePath = '';
let isZoomed = false; // 100%表示（ズーム）状態か
let currentRotation = 0; // 現在の回転角度
let currentScale = 1.0; // 現在のズーム倍率
let currentTranslateX = 0; // X方向の移動量
let currentTranslateY = 0; // Y方向の移動量
let isImageDragging = false; // 画像のパン（移動）ドラッグ中か
let imageDragStartX = 0;
let imageDragStartY = 0;
let isFitToWindow = false; // ウィンドウサイズに強制フィット（拡大処理あり）させるか
let isFullscreen = false; // フルスクリーン状態か
let isBorderVisible = true; // ウィンドウ枠を表示するか
let previousWindowSize = null; // ウィンドウフィット(Wキー)適用前のサイズ保存用
let isSharpened = false; // 画像にシャープネスフィルターを適用するか

let lastFocusTime = 0; // ウィンドウが最後にフォーカスを取得した時刻
let ignoreNextClick = false; // フォーカス目的のクリックを無視するためのフラグ
const preloadCache = new Map();

// --- ウィンドウコントロール用アイコン ---
const MAXIMIZE_ICON = `<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="none" stroke="#fff" stroke-width="1"/></svg>`;
const RESTORE_ICON = `<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="3" width="6" height="6" fill="none" stroke="#fff" stroke-width="1"/><polyline points="3,3 3,1 9,1 9,7 7,7" fill="none" stroke="#fff" stroke-width="1"/></svg>`;

window.addEventListener('focus', () => {
  lastFocusTime = Date.now();
});

// --- DOM要素 ---
const imgElement = document.getElementById('viewer-img');

/**
 * SVGシャープネスフィルターの初期化
 * 小数倍率で拡大した際にも滑らかさを保ちつつ輪郭を強調するためのフィルターを生成します。
 */
function initSharpnessFilter() {
  const svgNS = "http://www.w3.org/2000/svg";
  const svgElement = document.createElementNS(svgNS, "svg");
  svgElement.style.cssText = "position: absolute; width: 0; height: 0; pointer-events: none;";
  const filterElement = document.createElementNS(svgNS, "filter");
  filterElement.id = "sharpness-filter";
  const feConvolveMatrix = document.createElementNS(svgNS, "feConvolveMatrix");
  feConvolveMatrix.setAttribute("order", "3");
  feConvolveMatrix.setAttribute("preserveAlpha", "true");
  // 中央の重みを高くし、上下左右をマイナスにすることで輪郭を強調（アンシャープマスクの原理）
  feConvolveMatrix.setAttribute("kernelMatrix", "0 -1 0 -1 8 -1 0 -1 0");
  feConvolveMatrix.setAttribute("divisor", "4"); // (8 - 4 = 4) で全体の明るさ（輝度）を元の画像と同じに維持

  filterElement.appendChild(feConvolveMatrix);
  svgElement.appendChild(filterElement);
  document.body.appendChild(svgElement);
}
initSharpnessFilter();

// --- 初期スタイル設定 ---
// 全画面表示時などにブラウザのデフォルトマージンによる意図しない余白が発生するのを防ぐ。
// また、画像をビューポート全体にフィットさせるための基本スタイルを適用する。
document.documentElement.style.margin = '0';
document.documentElement.style.padding = '0';
document.documentElement.style.overflow = 'hidden';
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.width = '100vw';
document.body.style.height = '100vh';
document.body.style.backgroundColor = '#1e1e1e';
document.body.style.display = 'flex';
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';
document.body.style.boxSizing = 'border-box';
document.body.style.border = 'none'; // 画像サイズに影響を与えないためborderは外側に描画する

// --- ウィンドウ枠オーバーレイの作成 ---
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
borderOverlay.style.border = isBorderVisible ? '1px solid #3a7afe' : 'none';
borderOverlay.style.zIndex = '9998'; // コントロールボタンの下、画像の上に配置
document.body.appendChild(borderOverlay);

// 初期状態は画面にフィットさせる
imgElement.style.maxWidth = '100%';
imgElement.style.maxHeight = '100%';

window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const indexParam = urlParams.get('index');
    if (indexParam !== null) {
      currentIndex = parseInt(indexParam, 10);
    }

    // ウィンドウが最大化されているかを非同期で確認しアイコンを更新する
    window.veloceAPI.isViewerMaximized().then(isMax => {
      if (isMax) {
        const maxBtn = document.getElementById('window-max-btn');
        if (maxBtn) maxBtn.innerHTML = RESTORE_ICON;
      }
    }).catch(() => {});
    
    loadImage();
});

/**
 * 画像の描画モード（シャープか滑らかか）を適用する。
 */
function updateImageRendering() {
  // pixelatedの代わりにSVGフィルターを使って、滑らかさを保ったまま輪郭を強調する
  imgElement.style.filter = isSharpened ? 'url(#sharpness-filter)' : 'none';
  imgElement.style.transform = `translate(${currentTranslateX}px, ${currentTranslateY}px) rotate(${currentRotation}deg) scale(${currentScale})`;
}

/**
 * 画像のズーム状態（100%表示か、画面フィットか）を設定する。
 * @param {boolean} zoomed - true: 100%表示, false: 画面にフィット
 */
function setZoomState(zoomed) {
  isZoomed = zoomed;
  if (isZoomed) {
    // 100%表示（ズーム）に切り替え
    imgElement.style.maxWidth = 'none';
    imgElement.style.maxHeight = 'none';
    imgElement.style.width = `${imgElement.naturalWidth}px`;
    imgElement.style.height = `${imgElement.naturalHeight}px`;
    imgElement.style.cursor = 'grab';
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
  return Math.abs(currentRotation) % 360 === 90 || Math.abs(currentRotation) % 360 === 270;
}

/**
 * 現在の回転角度を考慮した画像の本来のサイズを取得します。
 * @returns {{width: number, height: number}} 回転を考慮した幅と高さ
 */
function getNaturalDimensions() {
  const swapped = isRotationSwapped();
  return {
    width: swapped ? imgElement.naturalHeight : imgElement.naturalWidth,
    height: swapped ? imgElement.naturalWidth : imgElement.naturalHeight
  };
}

/**
 * ズーム状態とフィット状態を解除し、デフォルトの表示状態に戻します。
 */
function resetZoomAndFit() {
  isZoomed = false;
  isFitToWindow = false;
  currentScale = 1.0;
  currentTranslateX = 0;
  currentTranslateY = 0;
  updateImageRendering();
  applyFitState();
  updateFullscreenStyles();
}

/**
 * 非ズーム時の表示状態（強制フィット拡大 か デフォルトの縮小のみ か）を適用する。
 */
function applyFitState() {
  if (isZoomed) return;

  if (isFitToWindow) {
    // 回転時のアスペクト比崩れを防ぐため、回転角度に応じて縦横の100%基準を入れ替える
    const isSwapped = isRotationSwapped();
    imgElement.style.maxWidth = 'none';
    imgElement.style.maxHeight = 'none';
    imgElement.style.width = isSwapped ? '100vh' : '100vw';
    imgElement.style.height = isSwapped ? '100vw' : '100vh';
    imgElement.style.objectFit = 'contain';
  } else {
    // デフォルト（大きい画像のみ縮小、小さい画像はそのままのサイズ）
    imgElement.style.maxWidth = '100%';
    imgElement.style.maxHeight = '100%';
    imgElement.style.width = 'auto';
    imgElement.style.height = 'auto';
    imgElement.style.objectFit = 'contain';
  }
  
  imgElement.style.cursor = 'default';
  document.body.style.overflow = 'hidden';
  document.body.style.justifyContent = 'center';
  document.body.style.alignItems = 'center';
  imgElement.style.margin = '0';
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    // リサイズ中にIPC通信（await invoke）を行うとOSのメッセージループが詰まり
    // 例外0xc000041dでクラッシュするため、ブラウザのAPIを用いて判定する
    const isMax = window.innerWidth >= window.screen.availWidth - 10 && window.innerHeight >= window.screen.availHeight - 10;
    const maxBtn = document.getElementById('window-max-btn');
    if (maxBtn) {
      maxBtn.innerHTML = isMax ? RESTORE_ICON : MAXIMIZE_ICON;
    }

    const isFs = window.innerHeight === window.screen.height;
    if (isFs && !isFullscreen) {
      isFullscreen = true;
      const overlay = document.getElementById('border-overlay');
      if (overlay) overlay.style.border = 'none';
      const controls = document.getElementById('window-controls');
      if (controls) controls.style.display = 'none';
      setZoomState(true);
    } else if (!isFs && isFullscreen) {
      isFullscreen = false;
      const overlay = document.getElementById('border-overlay');
      if (overlay) overlay.style.border = isBorderVisible ? '1px solid #3a7afe' : 'none';
      const controls = document.getElementById('window-controls');
      if (controls) {
        controls.style.display = 'flex';
        controls.style.opacity = isBorderVisible ? '1' : '0';
      }
      setZoomState(false);
    }
    
    updateFullscreenStyles();
  }, 150); // ドラッグ中の高頻度なイベントを間引く
});

/**
 * フルスクリーン（100%表示）時のスタイルを更新する。
 * スクロールバーの表示・非表示や、画像の配置を決定する。
 */
function updateFullscreenStyles() {
  if (!isZoomed) {
    document.body.style.justifyContent = 'center';
    document.body.style.alignItems = 'center';
    imgElement.style.margin = '0';
    return;
  }

  // ドラッグでスクロール操作を行うため、スクロールバーは常に非表示にします。
  document.body.style.overflow = 'hidden';

  // 回転による視覚的サイズとレイアウトサイズのズレを margin で補正する
  const isSwapped = isRotationSwapped();
  
  if (isSwapped) {
    const marginY = (imgElement.naturalWidth - imgElement.naturalHeight) / 2;
    const marginX = (imgElement.naturalHeight - imgElement.naturalWidth) / 2;
    imgElement.style.margin = `${marginY}px ${marginX}px`;
  } else {
    imgElement.style.margin = '0';
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

// --- 画像ナビゲーション ---
/**
 * 現在のインデックス (`currentIndex`) に基づいて画像を表示し、ウィンドウタイトルを更新する。
 * 表示後、前後の画像をバックグラウンドでプリロードする。
 */
async function loadImage() {
  currentScale = 1.0;
  currentTranslateX = 0;
  currentTranslateY = 0;
  // RustのStateから現在表示すべき画像のパスと全体枚数を取得
  const result = await window.veloceAPI.getViewerImage(currentIndex);
  if (result) {
    currentImagePath = result.path;
    totalImages = result.total;
    previousWindowSize = null; // トグル状態をリセット

    if (preloadCache.has(currentIndex)) {
      const cachedData = preloadCache.get(currentIndex);
      currentImagePath = cachedData.path; // パスを更新
      imgElement.src = cachedData.img.src;
    } else {
      imgElement.src = window.veloceAPI.convertFileSrc(currentImagePath);
    }
    preloadAdjacentImages();

    document.title = `Veloce Viewer - ${currentIndex + 1} / ${totalImages}`;
    imgElement.onload = () => {
      setZoomState(isZoomed);
      updateImageRendering();

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
      if (!isFullscreen && !document.fullscreenElement) {
        if (window.veloceAPI && window.veloceAPI.setWindowSize) {
          window.veloceAPI.setWindowSize(targetWidth, targetHeight).then(() => {
            if (window.veloceAPI.toggleWindowDecorations) {
              window.veloceAPI.toggleWindowDecorations(isBorderVisible);
            }
          });
        }
      }
    };
  }
}

async function preloadAdjacentImages() {
  const indicesToPreload = [currentIndex + 1, currentIndex - 1];
  for (const idx of indicesToPreload) {
    if (idx >= 0 && idx < totalImages && !preloadCache.has(idx)) {
      const result = await window.veloceAPI.getViewerImage(idx);
      if (result) {
        const url = window.veloceAPI.convertFileSrc(result.path);
        const img = new Image();
        img.src = url; // ブラウザのメモリキャッシュに読み込ませる
        preloadCache.set(idx, { 
          img: img, 
          path: result.path 
        });
      }
    }
  }
  // 不要になった古いキャッシュ（現在地から離れたもの）を削除してメモリを節約
  for (const cachedIdx of preloadCache.keys()) {
    if (Math.abs(cachedIdx - currentIndex) > 2) {
      preloadCache.delete(cachedIdx);
    }
  }
}

/**
 * 前の画像を表示する。
 */
function showPrev() {
  currentIndex = (currentIndex > 0) ? currentIndex - 1 : totalImages - 1;
  loadImage();
}

/**
 * 次の画像を表示する。
 */
function showNext() {
  currentIndex = (currentIndex < totalImages - 1) ? currentIndex + 1 : 0;
  loadImage();
}

// --- マウス操作ハンドリング ---
// ドラッグ、クリック、ダブルクリックを判別するための状態変数
let isDragging = false;
let hasMoved = false; // ドラッグ中に実際にマウスが移動したか
let startX = 0, startY = 0; // ドラッグ開始時の座標
let scrollLeftStart = 0, scrollTopStart = 0; // ドラッグ開始時のスクロール位置
let windowX = 0, windowY = 0; // ウィンドウ移動用の座標

// --- ウィンドウコントロールボタンの作成 ---
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
  controlsContainer.style.opacity = isBorderVisible ? '1' : '0';
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
  maxBtn.innerHTML = MAXIMIZE_ICON;
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

window.addEventListener('mousedown', (e) => {
  // ウィンドウがフォーカスを取得した直後のクリック（フォーカス目的のクリック）を画像送りとして扱わない
  if (Date.now() - lastFocusTime < 200) {
    ignoreNextClick = true;
  } else {
    ignoreNextClick = false;
  }

  if (e.button === 0) { // 左クリック
    isDragging = true;
    hasMoved = false;
    if (isZoomed) {
      startX = e.pageX;
      startY = e.pageY;
      scrollLeftStart = document.body.scrollLeft;
      scrollTopStart = document.body.scrollTop;
      imgElement.style.cursor = 'grabbing';
    } else {
      // OSのネイティブリサイズと競合しないよう、縁は移動の対象外
      const EDGE = 10;
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
      const movedX = isZoomed ? e.pageX : e.screenX;
      const movedY = isZoomed ? e.pageY : e.screenY;
      if (Math.abs(movedX - startX) > 5 || Math.abs(movedY - startY) > 5) {
        hasMoved = true;
      }
    }
    if (hasMoved) {
      if (dragRafId) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        if (isZoomed) {
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
    if (isZoomed) {
      imgElement.style.cursor = 'grab';
    }
    isDragging = false;
    if (!hasMoved && !ignoreNextClick && !isImageDragging) {
      showPrev();
    }
  }
});

// --- 画像のパン（移動）機能 ---

// Ctrlキーを押した時だけ「手のひら」カーソルにして、ドラッグ可能であることを示す
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control') imgElement.style.cursor = 'grab';
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control' && !isImageDragging) imgElement.style.cursor = 'default';
});

// ドラッグ開始（Ctrlを押している時のみ）
imgElement.addEventListener('mousedown', (e) => {
  if (e.ctrlKey && e.button === 0) {
    e.preventDefault(); // Macの右クリック化やOSの標準ドラッグを防止
    e.stopPropagation(); // 既存のウィンドウドラッグ処理との競合を防止
    isImageDragging = true;
    imageDragStartX = e.clientX;
    imageDragStartY = e.clientY;
    imgElement.style.cursor = 'grabbing'; // 掴んでいるカーソル
  }
});

// ドラッグ中（移動量の計算と適用）
window.addEventListener('mousemove', (e) => {
  if (isImageDragging) {
    currentTranslateX += e.clientX - imageDragStartX;
    currentTranslateY += e.clientY - imageDragStartY;
    imageDragStartX = e.clientX;
    imageDragStartY = e.clientY;
    updateImageRendering();
  }
});

// ドラッグ終了
window.addEventListener('mouseup', (e) => {
  if (isImageDragging && e.button === 0) {
    isImageDragging = false;
    imgElement.style.cursor = e.ctrlKey ? 'grab' : 'default';
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault(); 
  if (ignoreNextClick) return; // フォーカス目的の右クリックを無視
  showNext(); // 右クリックで次の画像へ
});

// --- マウスホイールによる画像送り・ズーム ---
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault(); // ブラウザ標準のズームを無効化

    // ホイールの回転方向に応じてスケールを増減（約10%ずつなめらかに変化）
    if (e.deltaY < 0) {
      currentScale *= 1.1; // 上スクロールで拡大
    } else {
      currentScale /= 1.1; // 下スクロールで縮小
    }

    // 倍率の限界値を設定（10% ～ 3000%）
    currentScale = Math.max(0.1, Math.min(currentScale, 30.0));

    // 画像に適用
    if (typeof updateImageRendering === 'function') {
      updateImageRendering();
    }
  } else {
    if (e.deltaY > 0) {
      showNext(); // 下スクロールで次へ
    } else if (e.deltaY < 0) {
      showPrev(); // 上スクロールで前へ
    }
  }
}, { passive: false });

/**
 * アイコンクリック時の共通発光エフェクトを適用する
 * @param {HTMLElement} el 対象の要素
 */
function applyIconGlowEffect(el) {
  if (!el) return;
  el.style.transition = 'none';
  el.style.color = '#fff';
  el.style.filter = 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 6px #ebc06d) drop-shadow(0 0 10px #ebc06d)';
  setTimeout(() => {
    el.style.transition = 'color 0.4s ease-out, filter 0.4s ease-out';
    el.style.color = '';
    el.style.filter = 'none';
    setTimeout(() => { el.style.transition = ''; }, 400);
  }, 100);
}

// --- キーボードショートカット ---
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
      currentRotation += 90;
      updateImageRendering();
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'ArrowDown':
      currentRotation -= 90;
      updateImageRendering();
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
      isZoomed = false; // 100%ズームを解除
      isFitToWindow = !isFitToWindow; // 強制フィット状態をトグル
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'F11':
      e.preventDefault(); // ブラウザ標準のフルスクリーン動作を防ぐ
      window.veloceAPI.toggleViewerFullscreen();
      break;
    case 'w':
    case 'W':
      if (!isFullscreen) {
        if (previousWindowSize) { // 既にフィットしている場合は元のサイズに戻す
          window.veloceAPI.resizeViewerWindow(previousWindowSize.width, previousWindowSize.height);
          previousWindowSize = null;
        } else { // 現在のサイズを保存し、画像サイズに合わせてリサイズする
          previousWindowSize = { width: window.innerWidth, height: window.innerHeight };
          const { width: natW, height: natH } = getNaturalDimensions();
          
          let targetW = natW;
          let targetH = natH;

          // ズームされていない（縮小表示等されている）場合は、現在の表示サイズを計算して合わせる
          if (!isZoomed) {
            const scale = isFitToWindow 
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
      isBorderVisible = !isBorderVisible;
      if (!isFullscreen) {
        const overlay = document.getElementById('border-overlay');
        if (overlay) overlay.style.border = isBorderVisible ? '1px solid #3a7afe' : 'none';
        const controls = document.getElementById('window-controls');
        if (controls) controls.style.opacity = isBorderVisible ? '1' : '0';
      }
      break;
    case 's':
    case 'S':
      isSharpened = !isSharpened;
      updateImageRendering();
      break;
  }
  
  if (e.key === 'Delete') {
	if (currentImagePath) {
	  const success = await window.veloceAPI.trashFile(currentImagePath);
	  if (success) {
        // 削除成功時、ビューアーを閉じずに次の画像（最後なら前の画像）へ移動する
        if (currentIndex < totalImages - 1) {
          totalImages--; // 全体枚数を減らす
          loadImage(); // currentIndexを維持したままロード＝次の画像になる
        } else if (currentIndex > 0) {
          totalImages--;
          currentIndex--; // 最後の画像だった場合は1つ前に戻る
          loadImage();
        } else {
          // 画像が1枚もなくなった場合はウィンドウを閉じる
          if (window.veloceAPI && window.veloceAPI.closeWindow) window.veloceAPI.closeWindow();
        }
	  }
	}
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
	if (currentImagePath) {
	  window.veloceAPI.copyImageToClipboard(currentImagePath);
      // 共通の光るエフェクトを適用
      applyIconGlowEffect(imgElement);
	}
  }
});
