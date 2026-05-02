import { viewerState } from './viewer-state.js';

/**
 * ビューア画面のUIとDOM操作を管理するクラス
 */
class ViewerUI {
  static ICONS = {
    MAXIMIZE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="none" stroke="#fff" stroke-width="1"/></svg>`,
    RESTORE: `<svg viewBox="0 0 10 10" width="10" height="10"><rect x="1" y="3" width="6" height="6" fill="none" stroke="#fff" stroke-width="1"/><polyline points="3,3 3,1 9,1 9,7 7,7" fill="none" stroke="#fff" stroke-width="1"/></svg>`
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
    this.elements.viewerImg.style.transform = `translate(${this.state.currentTranslateX}px, ${this.state.currentTranslateY}px) rotate(${this.state.currentRotation}deg) scale(${this.state.currentScale})`;
  }

  /**
   * フルスクリーン状態などを考慮して、ウィンドウ枠（ボーダー）とコントロールボタンの表示状態を更新します。
   */
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
    if (!el) return;
    el.style.transition = 'none';
    el.classList.add('glow');
    setTimeout(() => {
      el.style.transition = 'color 0.6s ease-out, filter 0.6s ease-out, stroke 0.6s ease-out';
      el.classList.remove('glow');
      setTimeout(() => { el.style.transition = ''; }, 600);
    }, 200);
  }
}

export { ViewerUI };
export const viewerUI = new ViewerUI(viewerState);