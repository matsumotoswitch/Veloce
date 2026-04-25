class ViewerState {
  constructor() {
    this.currentIndex = 0;
    this.totalImages = 0;
    this.currentImagePath = '';
    this.isZoomed = false;
    this.currentRotation = 0;
    this.currentScale = 1.0;
    this.currentTranslateX = 0;
    this.currentTranslateY = 0;
    this.isImageDragging = false;
    this.imageDragStartX = 0;
    this.imageDragStartY = 0;
    this.isFitToWindow = false;
    this.isFullscreen = false;
    this.isBorderVisible = true;
    this.previousWindowSize = null;
    this.isSharpened = false;
    this.lastFocusTime = 0;
    this.ignoreNextClick = false;
    this.preloadCache = new Map();
  }
}

// グローバルにインスタンスを公開
window.viewerState = new ViewerState();