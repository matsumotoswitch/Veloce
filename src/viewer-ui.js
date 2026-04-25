class ViewerUI {
  static ICONS = {
    MAXIMIZE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="none" stroke="#fff" stroke-width="1"/></svg>`,
    RESTORE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="3" width="6" height="6" fill="none" stroke="#fff" stroke-width="1"/><polyline points="3,3 3,1 9,1 9,7 7,7" fill="none" stroke="#fff" stroke-width="1"/></svg>`
  };

  constructor(state) {
    this.state = state;
    this.viewerImg = document.getElementById('viewer-img');
  }

  updateImageRendering() {
    if (!this.viewerImg) return;
    this.viewerImg.style.filter = this.state.isSharpened ? 'url(#sharpness-filter)' : 'none';
    this.viewerImg.style.transform = `translate(${this.state.currentTranslateX}px, ${this.state.currentTranslateY}px) rotate(${this.state.currentRotation}deg) scale(${this.state.currentScale})`;
  }

  applyBorderVisibility() {
    if (this.state.isFullscreen) return;
    const overlay = document.getElementById('border-overlay');
    if (overlay) overlay.style.border = this.state.isBorderVisible ? '1px solid #3a7afe' : 'none';
    const controls = document.getElementById('window-controls');
    if (controls) {
      controls.style.display = 'flex';
      controls.style.opacity = this.state.isBorderVisible ? '1' : '0';
    }
  }
  
  setCursor(type) {
    if (this.viewerImg) this.viewerImg.style.cursor = type;
  }
}

// インスタンス化
window.viewerUI = new ViewerUI(window.viewerState);