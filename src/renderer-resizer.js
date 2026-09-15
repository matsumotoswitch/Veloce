// ============================================================================
// Veloce - Window Pane Resizer Controller (renderer-resizer.js)
// ============================================================================
// 本モジュールは、各ペイン境界のリサイズバー（左右・上下）のドラッグ操作、
// 折りたたみトグルスイッチの生成・クリック制御、およびリサイズイベントの
// アニメーションフレーム同期（requestAnimationFrame）を管理する。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';

export const resizingState = {
  left: false,
  right: false,
  center: false,
  leftTop: false,
  rightTop: false
};

let resizerRafId = null;

/**
 * リサイズバースイッチ要素を生成してアタッチします。
 * @param {HTMLElement} resizer
 * @param {string} type
 */
export function createResizerToggle(resizer, type) {
  const isHorizontal = type === 'center' || type === 'leftTop' || type === 'rightTop';
  const btn = document.createElement('div');
  btn.className = `resizer-toggle ${isHorizontal ? 'resizer-toggle-horizontal' : 'resizer-toggle-vertical'}`;

  let openIcon;
  if (type === 'left') openIcon = UIManager.ICONS.CHEVRON_LEFT;
  else if (type === 'right') openIcon = UIManager.ICONS.CHEVRON_RIGHT;
  else openIcon = UIManager.ICONS.CHEVRON_UP;

  btn.innerHTML = openIcon;
  let isVisible = true;
  if (type === 'left') isVisible = appState.layout.leftVisible;
  else if (type === 'right') isVisible = appState.layout.rightVisible;
  else if (type === 'leftTop') isVisible = appState.layout.leftTopVisible;
  else if (type === 'center') isVisible = !document.documentElement.getAttribute('data-center-collapsed');

  if (!isVisible) {
    btn.classList.add('expanded');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (type === 'left') {
      appState.layout.leftVisible = !appState.layout.leftVisible;
      if (appState.layout.leftVisible) btn.classList.remove('expanded'); else btn.classList.add('expanded');
      localStorage.setItem('leftVisible', appState.layout.leftVisible);
      uiManager.applyLayout();
    } else if (type === 'right') {
      appState.layout.rightVisible = !appState.layout.rightVisible;
      if (appState.layout.rightVisible) btn.classList.remove('expanded'); else btn.classList.add('expanded');
      localStorage.setItem('rightVisible', appState.layout.rightVisible);
      uiManager.applyLayout();
    } else if (type === 'center') {
      const root = document.documentElement;
      const isCollapsed = root.style.getPropertyValue('--top-height') === '0px';
      if (isCollapsed) {
        const restoreHeight = localStorage.getItem('prevTopHeight') || '250px';
        root.style.setProperty('--top-height', restoreHeight);
        root.removeAttribute('data-center-collapsed');
        localStorage.setItem('topHeight', restoreHeight);
        btn.classList.remove('expanded');
      } else {
        localStorage.setItem('prevTopHeight', root.style.getPropertyValue('--top-height') || '250px');
        root.style.setProperty('--top-height', '0px');
        root.setAttribute('data-center-collapsed', 'true');
        localStorage.setItem('topHeight', '0px');
        btn.classList.add('expanded');
      }
    } else if (type === 'leftTop') {
      const root = document.documentElement;
      const isCollapsed = root.style.getPropertyValue('--left-top-height') === '0px';
      if (isCollapsed) {
        const restoreHeight = localStorage.getItem('prevLeftTopHeight') || '150px';
        root.style.setProperty('--left-top-height', restoreHeight);
        root.removeAttribute('data-left-top-collapsed');
        localStorage.setItem('leftTopHeight', restoreHeight);
        appState.layout.leftTopVisible = true;
        btn.classList.remove('expanded');
      } else {
        localStorage.setItem('prevLeftTopHeight', root.style.getPropertyValue('--left-top-height') || '150px');
        root.style.setProperty('--left-top-height', '0px');
        root.setAttribute('data-left-top-collapsed', 'true');
        localStorage.setItem('leftTopHeight', '0px');
        appState.layout.leftTopVisible = false;
        btn.classList.add('expanded');
      }
    } else if (type === 'rightTop') {
      const root = document.documentElement;
      const isCollapsed = root.style.getPropertyValue('--right-top-height') === '0px';
      if (isCollapsed) {
        const restoreHeight = localStorage.getItem('prevRightTopHeight') || '200px';
        root.style.setProperty('--right-top-height', restoreHeight);
        localStorage.setItem('rightTopHeight', restoreHeight);
        appState.layout.rightTopVisible = true;
        btn.classList.remove('expanded');
      } else {
        localStorage.setItem('prevRightTopHeight', root.style.getPropertyValue('--right-top-height') || '200px');
        root.style.setProperty('--right-top-height', '0px');
        localStorage.setItem('rightTopHeight', '0px');
        appState.layout.rightTopVisible = false;
        btn.classList.add('expanded');
      }
    }
  });

  btn.addEventListener('mousedown', (e) => e.stopPropagation());

  resizer.appendChild(btn);
}

/**
 * リサイザー要素のマウスダウン操作とトグルスイッチを初期化します。
 * @param {HTMLElement} resizer
 * @param {string} type
 * @param {string} cursor
 */
export function setupResizer(resizer, type, cursor) {
  if (!resizer) return;
  resizer.addEventListener('mousedown', () => {
    resizingState[type] = true;
    resizer.classList.add('resizing');
    document.body.style.cursor = cursor;
    document.body.classList.add('is-resizing');
  });
  createResizerToggle(resizer, type);
}

/**
 * グローバルなリサイズ追従イベント（mousemove, mouseup）を登録します。
 */
export function initResizerGlobalEvents() {
  window.addEventListener('mousemove', (e) => {
    if (!resizingState.left && !resizingState.right && !resizingState.center && !resizingState.leftTop && !resizingState.rightTop) return;

    if (resizerRafId) cancelAnimationFrame(resizerRafId);
    resizerRafId = requestAnimationFrame(() => {
      if (resizingState.left) {
        let newWidth = e.clientX;
        if (newWidth < 50) {
          if (appState.layout.leftVisible) {
            appState.layout.leftVisible = false;
            localStorage.setItem('leftVisible', 'false');
            const btn = uiManager.elements.resizerLeft?.querySelector('.resizer-toggle');
            if (btn) btn.classList.add('expanded');
            uiManager.applyLayout();
          }
        } else {
          newWidth = Math.max(100, Math.min(newWidth, window.innerWidth - 400));
          appState.layout.leftWidth = newWidth;
          if (!appState.layout.leftVisible) {
            appState.layout.leftVisible = true;
            localStorage.setItem('leftVisible', 'true');
            const btn = uiManager.elements.resizerLeft?.querySelector('.resizer-toggle');
            if (btn) btn.classList.remove('expanded');
          }
          uiManager.applyLayout();
        }
      } else if (resizingState.right) {
        let newWidth = window.innerWidth - e.clientX;
        if (newWidth < 50) {
          if (appState.layout.rightVisible) {
            appState.layout.rightVisible = false;
            localStorage.setItem('rightVisible', 'false');
            const btn = uiManager.elements.resizerRight?.querySelector('.resizer-toggle');
            if (btn) btn.classList.add('expanded');
            uiManager.applyLayout();
          }
        } else {
          newWidth = Math.max(150, Math.min(newWidth, window.innerWidth - 400));
          appState.layout.rightWidth = newWidth;
          if (!appState.layout.rightVisible) {
            appState.layout.rightVisible = true;
            localStorage.setItem('rightVisible', 'true');
            const btn = uiManager.elements.resizerRight?.querySelector('.resizer-toggle');
            if (btn) btn.classList.remove('expanded');
          }
          uiManager.applyLayout();
        }
      } else if (resizingState.center) {
        const centerPane = document.getElementById('center-pane');
        const rect = centerPane ? centerPane.getBoundingClientRect() : { top: 0, height: window.innerHeight };
        let newHeight = e.clientY - rect.top;

        if (newHeight < 50) {
          const root = document.documentElement;
          if (root.style.getPropertyValue('--top-height') !== '0px') {
            localStorage.setItem('prevTopHeight', root.style.getPropertyValue('--top-height') || '250px');
            root.style.setProperty('--top-height', '0px');
            root.setAttribute('data-center-collapsed', 'true');
            localStorage.setItem('topHeight', '0px');
            const btn = uiManager.elements.resizerCenter?.querySelector('.resizer-toggle');
            if (btn) btn.classList.add('expanded');
          }
        } else {
          newHeight = Math.max(50, Math.min(newHeight, rect.height - 50));
          const root = document.documentElement;
          root.style.setProperty('--top-height', `${newHeight}px`);
          root.removeAttribute('data-center-collapsed');

          const btn = uiManager.elements.resizerCenter?.querySelector('.resizer-toggle');
          if (btn && btn.classList.contains('expanded')) {
            btn.classList.remove('expanded');
          }
        }
      } else if (resizingState.leftTop) {
        const leftPane = document.getElementById('left-pane');
        const rect = leftPane ? leftPane.getBoundingClientRect() : { top: 0, height: window.innerHeight };
        let newHeight = e.clientY - rect.top;

        if (newHeight < 30) {
          const root = document.documentElement;
          if (root.style.getPropertyValue('--left-top-height') !== '0px') {
            localStorage.setItem('prevLeftTopHeight', root.style.getPropertyValue('--left-top-height') || '150px');
            root.style.setProperty('--left-top-height', '0px');
            root.setAttribute('data-left-top-collapsed', 'true');
            localStorage.setItem('leftTopHeight', '0px');
            const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
            if (btn) btn.classList.add('expanded');
          }
        } else {
          newHeight = Math.max(30, Math.min(newHeight, rect.height - 30));
          const root = document.documentElement;
          root.style.setProperty('--left-top-height', `${newHeight}px`);
          root.removeAttribute('data-left-top-collapsed');
          appState.layout.leftTopHeight = newHeight;

          const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
          if (btn && btn.classList.contains('expanded')) {
            btn.classList.remove('expanded');
          }
        }
      } else if (resizingState.rightTop) {
        const rightPane = document.getElementById('right-pane');
        const rect = rightPane ? rightPane.getBoundingClientRect() : { top: 0, height: window.innerHeight };
        let newHeight = e.clientY - rect.top;

        if (newHeight < 30) {
          const root = document.documentElement;
          if (root.style.getPropertyValue('--right-top-height') !== '0px') {
            localStorage.setItem('prevRightTopHeight', root.style.getPropertyValue('--right-top-height') || '200px');
            root.style.setProperty('--right-top-height', '0px');
            localStorage.setItem('rightTopHeight', '0px');
            const btn = document.getElementById('resizer-right-pane')?.querySelector('.resizer-toggle');
            if (btn) btn.classList.add('expanded');
          }
        } else {
          newHeight = Math.max(30, Math.min(newHeight, rect.height - 30));
          const root = document.documentElement;
          root.style.setProperty('--right-top-height', `${newHeight}px`);
          appState.layout.rightTopHeight = newHeight;

          const btn = document.getElementById('resizer-right-pane')?.querySelector('.resizer-toggle');
          if (btn && btn.classList.contains('expanded')) {
            btn.classList.remove('expanded');
          }
        }
      }
    });
  });

  window.addEventListener('mouseup', () => {
    if (resizingState.left) {
      localStorage.setItem('leftWidth', appState.layout.leftWidth);
      resizingState.left = false;
      if (uiManager.elements.resizerLeft) uiManager.elements.resizerLeft.classList.remove('resizing');
    }
    if (resizingState.right) {
      localStorage.setItem('rightWidth', appState.layout.rightWidth);
      resizingState.right = false;
      if (uiManager.elements.resizerRight) uiManager.elements.resizerRight.classList.remove('resizing');
    }
    if (resizingState.center) {
      localStorage.setItem('topHeight', document.documentElement.style.getPropertyValue('--top-height'));
      resizingState.center = false;
      if (uiManager.elements.resizerCenter) uiManager.elements.resizerCenter.classList.remove('resizing');
    }
    if (resizingState.leftTop) {
      localStorage.setItem('leftTopHeight', document.documentElement.style.getPropertyValue('--left-top-height'));
      resizingState.leftTop = false;
      const el = document.getElementById('resizer-left-pane');
      if (el) el.classList.remove('resizing');
    }
    if (resizingState.rightTop) {
      localStorage.setItem('rightTopHeight', document.documentElement.style.getPropertyValue('--right-top-height'));
      resizingState.rightTop = false;
      const el = document.getElementById('resizer-right-pane');
      if (el) el.classList.remove('resizing');
    }
    document.body.style.cursor = 'default';
    document.body.classList.remove('is-resizing');
  });
}

/**
 * すべてのペイン境界リサイザーの初期設定を行います。
 */
export function initResizers() {
  setupResizer(uiManager.elements.resizerLeft, 'left', 'col-resize');
  setupResizer(uiManager.elements.resizerRight, 'right', 'col-resize');
  setupResizer(uiManager.elements.resizerCenter, 'center', 'row-resize');
  setupResizer(document.getElementById('resizer-left-pane'), 'leftTop', 'row-resize');
  setupResizer(document.getElementById('resizer-right-pane'), 'rightTop', 'row-resize');
  initResizerGlobalEvents();
}
