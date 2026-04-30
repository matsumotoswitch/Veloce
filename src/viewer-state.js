/**
 * ビューア画面のデータと状態を管理するクラス
 */
class ViewerState {
  constructor() {
    this.currentIndex = 0;          // 現在表示中の画像のインデックス
    this.totalImages = 0;           // 全画像数
    this.currentImagePath = '';     // 現在表示中の画像のパス
    this.isZoomed = false;          // 100%表示（ズーム）状態かどうか
    this.currentRotation = 0;       // 現在の回転角度（度）
    this.currentScale = 1.0;        // 現在のズーム倍率
    this.currentTranslateX = 0;     // X方向の移動量
    this.currentTranslateY = 0;     // Y方向の移動量
    this.isImageDragging = false;   // 画像のパン（移動）ドラッグ中かどうか
    this.imageDragStartX = 0;       // パン操作の開始X座標
    this.imageDragStartY = 0;       // パン操作の開始Y座標
    this.isFitToWindow = false;     // ウィンドウサイズに強制フィット（拡大処理あり）させるかどうか
    this.isFullscreen = false;      // フルスクリーン状態かどうか
    this.isBorderVisible = true;    // ウィンドウ枠を表示するかどうか
    this.previousWindowSize = null; // ウィンドウフィット前のサイズ保存用
    this.isUnsharped = false;       // アンシャープマスクフィルターを適用するかどうか
    this.lastFocusTime = 0;         // ウィンドウが最後にフォーカスを取得した時刻
    this.ignoreNextClick = false;   // フォーカス目的のクリックを無視するためのフラグ
    this.preloadCache = new Map();  // 前後の画像のプリロードキャッシュ
  }
}

export const viewerState = new ViewerState();