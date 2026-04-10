// --- グローバル状態管理 ---
let currentIndex = 0;
let totalImages = 0;
let currentImagePath = '';
let isZoomed = false; // 100%表示（ズーム）状態か
let currentRotation = 0; // 現在の回転角度
let isFitToWindow = false; // ウィンドウサイズに強制フィット（拡大処理あり）させるか
let isFullscreen = false; // フルスクリーン状態か
let isBorderVisible = true; // ウィンドウ枠を表示するか
let previousWindowSize = null; // Wキーでフィットさせる前のウィンドウサイズ
let isSharpened = false; // 画像にシャープネスフィルターを適用するか

let lastFocusTime = 0; // ウィンドウが最後にフォーカスを取得した時刻
let ignoreNextClick = false; // フォーカス目的のクリックを無視するためのフラグ

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
document.body.style.border = 'none'; // 画像サイズに影響を与えないようにborderは使用しない

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
    window.veloxAPI.isViewerMaximized().then(isMax => {
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
 * 非ズーム時の表示状態（強制フィット拡大 か デフォルトの縮小のみ か）を適用する。
 */
function applyFitState() {
  if (isZoomed) return;

  if (isFitToWindow) {
    // 回転時のアスペクト比崩れを防ぐため、回転角度に応じて縦横の100%基準を入れ替える
    const absRot = Math.abs(currentRotation) % 360;
    const isSwapped = absRot === 90 || absRot === 270;
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
  const absRot = Math.abs(currentRotation) % 360;
  const isSwapped = absRot === 90 || absRot === 270;
  
  if (isSwapped) {
    const marginY = (imgElement.naturalWidth - imgElement.naturalHeight) / 2;
    const marginX = (imgElement.naturalHeight - imgElement.naturalWidth) / 2;
    imgElement.style.margin = `${marginY}px ${marginX}px`;
  } else {
    imgElement.style.margin = '0';
  }

  // 補正後のサイズ（レイアウト上のサイズ＝視覚的なサイズ）
  const imgWidth = isSwapped ? imgElement.naturalHeight : imgElement.naturalWidth;
  const imgHeight = isSwapped ? imgElement.naturalWidth : imgElement.naturalHeight;

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
 * 現在のインデックス（`currentIndex`）に基づいて画像を表示する。
 * ウィンドウのタイトルも更新する。
 */
async function loadImage() {
  // RustのStateから現在表示すべき画像のパスと全体枚数を取得
  const result = await window.veloxAPI.getViewerImage(currentIndex);
  if (result) {
    currentImagePath = result.path;
    totalImages = result.total;
    previousWindowSize = null; // トグル状態をリセット
    imgElement.src = window.veloxAPI.convertFileSrc(currentImagePath);
    document.title = `Velox Viewer - ${currentIndex + 1} / ${totalImages}`;
    imgElement.onload = () => {
      setZoomState(isZoomed);
    };
  }
}

/**
 * 前の画像を表示する。
 */
function showPrev() {
  if (currentIndex > 0) {
	currentIndex--;
	loadImage();
  }
}

/**
 * 次の画像を表示する。
 */
function showNext() {
  if (currentIndex < totalImages - 1) {
	currentIndex++;
	loadImage();
  }
}

// --- マウス操作ハンドリング ---
// ドラッグ、クリック、ダブルクリックを判別するための状態変数
let isDragging = false;
let hasMoved = false; // ドラッグ中に実際にマウスが移動したか
let startX = 0, startY = 0; // ドラッグ開始時の座標
let scrollLeftStart = 0, scrollTopStart = 0; // ドラッグ開始時のスクロール位置
let windowX = 0, windowY = 0; // ウィンドウ移動用の座標
let clickTimeout = null; // シングルクリックとダブルクリックを区別するためのタイマー
let lastClickTime = 0; // 最後にクリックされた時刻
const STRICT_DBLCLICK_DELAY = 200; // 厳格なダブルクリック判定時間 (ms)

// --- ウィンドウコントロールボタンの作成 ---
// OS標準のタイトルバーのホバーバグを回避するため、HTMLで自前のコントロールを右上に描画する
function createWindowControls() {
  const controlsContainer = document.createElement('div');
  controlsContainer.id = 'window-controls';
  controlsContainer.style.position = 'fixed';
  controlsContainer.style.top = '1px'; // 青い枠線(1px)の内側に配置
  controlsContainer.style.right = '1px';
  controlsContainer.style.display = 'flex';
  controlsContainer.style.zIndex = '10000';
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
  minBtn.onclick = () => window.veloxAPI.minimizeViewer();

  // 最大化/元に戻すボタン
  const maxBtn = document.createElement('div');
  maxBtn.id = 'window-max-btn';
  maxBtn.style.cssText = buttonStyle;
  maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  maxBtn.innerHTML = MAXIMIZE_ICON;
  maxBtn.onmouseenter = () => maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  maxBtn.onmouseleave = () => maxBtn.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  maxBtn.onclick = () => window.veloxAPI.maximizeViewer();

  // 閉じるボタン
  const closeBtn = document.createElement('div');
  closeBtn.style.cssText = buttonStyle;
  closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.2)';
  closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0,0 L10,10 M10,0 L0,10" stroke="#fff" stroke-width="1"/></svg>`;
  closeBtn.onmouseenter = () => closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.5)'; // Windowsの閉じるボタンの赤色（半透明）
  closeBtn.onmouseleave = () => closeBtn.style.backgroundColor = 'rgba(232, 17, 35, 0.2)';
  closeBtn.onclick = () => {
    if (window.veloxAPI && window.veloxAPI.closeWindow) window.veloxAPI.closeWindow();
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
      if (isZoomed) {
        document.body.scrollLeft = scrollLeftStart - (e.pageX - startX);
        document.body.scrollTop = scrollTopStart - (e.pageY - startY);
      } else {
        window.veloxAPI.moveViewerWindow(e.screenX - windowX, e.screenY - windowY);
      }
    }
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { // 左クリックのリリース
    if (isZoomed) {
      imgElement.style.cursor = 'grab';
    }
    isDragging = false;
    if (!hasMoved && !ignoreNextClick) {
      const now = Date.now();
      if (now - lastClickTime < STRICT_DBLCLICK_DELAY) {
        // 指定時間以内ならダブルクリックとして判定（フルスクリーン切り替え）
        clearTimeout(clickTimeout);
        window.veloxAPI.toggleViewerFullscreen();
        lastClickTime = 0; // 連続発火を防ぐためリセット
      } else {
        // シングルクリック判定（2回目のクリックが来るのを指定時間だけ待機して、前の画像に戻る）
        lastClickTime = now;
        clickTimeout = setTimeout(() => {
          showPrev();
        }, STRICT_DBLCLICK_DELAY);
      }
    }
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault(); 
  if (ignoreNextClick) return; // フォーカス目的の右クリックを無視
  showNext(); // 右クリックで次の画像へ
});

/**
 * ヘルプ（ショートカット一覧）をオーバーレイ表示/非表示する
 */
function toggleHelpOverlay(forceShow) {
  let overlay = document.getElementById('help-overlay');
  
  if (overlay) {
    overlay.remove();
    return;
  }
  
  if (forceShow === false) return;

  overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  overlay.style.backdropFilter = 'blur(10px)';
  overlay.style.webkitBackdropFilter = 'blur(10px)';
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';
  overlay.style.color = '#fff';
  overlay.style.cursor = 'pointer';
  
  const content = document.createElement('div');
  content.style.backgroundColor = 'rgba(30, 30, 30, 0.8)';
  content.style.padding = '30px';
  content.style.borderRadius = '10px';
  content.style.border = '1px solid #555';
  content.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
  content.style.cursor = 'default';
  
  content.innerHTML = `
    <h2 style="margin-top: 0; text-align: center; color: #ebc06d;">ヘルプ・ショートカット一覧</h2>
    <div style="display: flex; gap: 40px; font-size: 1em;">
      <div>
        <h3 style="color: #ccc; border-bottom: 1px solid #555; padding-bottom: 5px; margin-top: 0;">メイン画面</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr><td style="padding: 6px 15px; font-weight: bold;">F1 / H</td><td style="padding: 6px 15px;">ヘルプの表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">矢印キー</td><td style="padding: 6px 15px;">画像の選択を移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F5</td><td style="padding: 6px 15px;">最新の情報に更新</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">選択中の画像をゴミ箱に移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">選択中の画像をコピー</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">ダブルクリック</td><td style="padding: 6px 15px;">サムネイルからビューワーを開く</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ヘルプを閉じる</td></tr>
        </table>
      </div>
      <div>
        <h3 style="color: #ccc; border-bottom: 1px solid #555; padding-bottom: 5px; margin-top: 0;">ビューワー画面</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr><td style="padding: 6px 15px; font-weight: bold;">F1 / H</td><td style="padding: 6px 15px;">ヘルプの表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">← / →</td><td style="padding: 6px 15px;">前 / 次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">↑ / ↓</td><td style="padding: 6px 15px;">右 / 左に90度回転</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Enter</td><td style="padding: 6px 15px;">ズーム解除 / 強制フィット切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F11</td><td style="padding: 6px 15px;">フルスクリーン切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">W</td><td style="padding: 6px 15px;">ウィンドウを画像にフィット (トグル)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">B</td><td style="padding: 6px 15px;">ウィンドウ枠の表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">S</td><td style="padding: 6px 15px;">画像のシャープ / 滑らか表示切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">画像をゴミ箱に移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">画像をクリップボードにコピー</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ビューワーを閉じる (ヘルプ表示時は閉じる)</td></tr>
        </table>
      </div>
    </div>
  `;
  
  overlay.addEventListener('click', () => toggleHelpOverlay(false));
  
  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

// --- キーボードショートカット ---
window.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+I で開発者ツールをトグル表示
  if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    if (window.veloxAPI.toggleDevtools) window.veloxAPI.toggleDevtools();
    return;
  }

  // F1またはHでヘルプ表示のトグル
  if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
    e.preventDefault();
    toggleHelpOverlay();
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
      imgElement.style.transform = `rotate(${currentRotation}deg)`;
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'ArrowDown':
      currentRotation -= 90;
      imgElement.style.transform = `rotate(${currentRotation}deg)`;
      applyFitState();
      updateFullscreenStyles();
      break;
    case 'Escape':
      if (document.getElementById('help-overlay')) {
        toggleHelpOverlay(false);
      } else {
        if (window.veloxAPI && window.veloxAPI.closeWindow) window.veloxAPI.closeWindow();
      }
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
      window.veloxAPI.toggleViewerFullscreen();
      break;
    case 'w':
    case 'W':
      if (!isFullscreen) {
        if (previousWindowSize) { // 既にフィットしている場合は元のサイズに戻す
          window.veloxAPI.resizeViewerWindow(previousWindowSize.width, previousWindowSize.height);
          previousWindowSize = null;
        } else { // 現在のサイズを保存し、画像サイズに合わせてリサイズする
          previousWindowSize = { width: window.innerWidth, height: window.innerHeight };
          const absRot = Math.abs(currentRotation) % 360;
          const isSwapped = absRot === 90 || absRot === 270;
          const natW = isSwapped ? imgElement.naturalHeight : imgElement.naturalWidth;
          const natH = isSwapped ? imgElement.naturalWidth : imgElement.naturalHeight;
          
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

          window.veloxAPI.resizeViewerWindow(targetW, targetH);
        }
      }
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
	  const success = await window.veloxAPI.trashFile(currentImagePath);
	  if (success) {
		if (window.veloxAPI && window.veloxAPI.closeWindow) window.veloxAPI.closeWindow();
	  }
	}
  }

  if (e.ctrlKey && e.key === 'c') {
	if (currentImagePath) {
	  window.veloxAPI.copyImageToClipboard(currentImagePath);
	}
  }
});
