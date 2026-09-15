// ============================================================================
// Veloce - Bookmarks & Favorites Bar Controller (renderer-bookmarks.js)
// ============================================================================
// 本モジュールは、ブックマークバー（お気に入りフォルダ）の描画、
// 横スクロール溢れ検知（ResizeObserver / scrollWidth判定）、
// およびオーバーフローメニューの動的生成・表示切り替えを管理する。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, ICON_SVGS } from './renderer-ui.js';
import { createMenuItem } from './renderer-context-menu.js';

let bookmarkOverflowMenu = null;
let bookmarkResizeObserver = null;

/**
 * ブックマークバーのオーバーフロー（表示領域超過）を検出し、
 * あふれた項目がある場合は「...」ボタンを表示します。
 */
export function checkBookmarkOverflow() {
  const bar = document.getElementById('bookmark-bar');
  const list = document.getElementById('bookmark-list');
  const overflowBtn = document.getElementById('bookmark-overflow-btn');
  if (!bar || !list || !overflowBtn) return;

  if (list.scrollWidth > list.clientWidth) {
    overflowBtn.style.display = 'flex';
  } else {
    overflowBtn.style.display = 'none';
    if (bookmarkOverflowMenu && bookmarkOverflowMenu.parentNode) {
      bookmarkOverflowMenu.parentNode.removeChild(bookmarkOverflowMenu);
      bookmarkOverflowMenu = null;
    }
  }
}

/**
 * お気に入り一覧をブックマークバーに描画します。
 */
export function renderFavorites() {
  const container = document.getElementById('bookmark-list');
  if (!container) return;
  container.replaceChildren();

  if (appState.favorites.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'bookmark-empty-msg';
    emptyMsg.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
      <span>フォルダをここにドラッグしてお気に入りに追加</span>
    `;
    container.appendChild(emptyMsg);

    const btn = document.getElementById('bookmark-overflow-btn');
    if (btn) btn.style.display = 'none';
    return;
  }

  appState.favorites.forEach(fav => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'bookmark-item';
    itemDiv.dataset.path = fav.path;
    itemDiv.dataset.id = fav.id;
    itemDiv.dataset.isFavorite = 'true';
    itemDiv.draggable = true;

    const icon = document.createElement('span');
    icon.className = 'bookmark-icon';
    if (fav.icon && ICON_SVGS[fav.icon]) {
      icon.innerHTML = ICON_SVGS[fav.icon];
      icon.classList.add(`icon-color-${fav.color || 'default'}`);
    } else if (fav.icon && fav.icon.startsWith('FAV_')) {
      icon.innerHTML = UIManager.ICONS[fav.icon] || UIManager.ICONS['FAV_STAR'];
      icon.classList.add('bookmark-icon-fav');
    } else {
      icon.innerHTML = UIManager.ICONS.FAV_STAR;
    }

    const label = document.createElement('span');
    label.textContent = fav.name;

    itemDiv.appendChild(icon);
    itemDiv.appendChild(label);
    container.appendChild(itemDiv);
  });

  checkBookmarkOverflow();
}

/**
 * ブックマークバーの監視とオーバーフローメニューのイベントハンドラを初期化します。
 * @param {Object} options
 * @param {Function} options.onNavigate フォルダ選択時のコールバック (path, name) => Promise<void>
 */
export function initBookmarkEvents(options = {}) {
  const { onNavigate } = options;

  if (typeof ResizeObserver !== 'undefined') {
    if (!bookmarkResizeObserver) {
      bookmarkResizeObserver = new ResizeObserver(() => {
        checkBookmarkOverflow();
      });
      const bar = document.getElementById('bookmark-bar');
      const list = document.getElementById('bookmark-list');
      if (bar) bookmarkResizeObserver.observe(bar);
      if (list) bookmarkResizeObserver.observe(list);
    }
  }

  const overflowBtn = document.getElementById('bookmark-overflow-btn');
  if (overflowBtn) {
    overflowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (bookmarkOverflowMenu && bookmarkOverflowMenu.classList.contains('show')) {
        bookmarkOverflowMenu.classList.remove('show');
        overflowBtn.classList.remove('open');
        return;
      }

      const list = document.getElementById('bookmark-list');
      if (!list) return;
      const items = Array.from(list.children);
      const listRect = list.getBoundingClientRect();
      const hiddenItems = items.filter(item => {
        const itemRect = item.getBoundingClientRect();
        return itemRect.right > listRect.right;
      });

      if (hiddenItems.length === 0) return;

      bookmarkOverflowMenu = document.getElementById('bookmark-overflow-menu');
      if (!bookmarkOverflowMenu) {
        bookmarkOverflowMenu = document.createElement('div');
        bookmarkOverflowMenu.id = 'bookmark-overflow-menu';
        document.body.appendChild(bookmarkOverflowMenu);
      }
      bookmarkOverflowMenu.replaceChildren();

      hiddenItems.forEach(domItem => {
        const path = domItem.dataset.path;
        const fav = appState.favorites.find(f => f.path === path);
        if (!fav) return;

        let iconSvg = '';
        if (fav.icon && ICON_SVGS[fav.icon]) {
          iconSvg = ICON_SVGS[fav.icon];
        } else if (fav.icon && fav.icon.startsWith('FAV_')) {
          iconSvg = UIManager.ICONS[fav.icon] || UIManager.ICONS['FAV_STAR'];
        }

        const menuItem = createMenuItem(fav.name, iconSvg, async () => {
          bookmarkOverflowMenu.classList.remove('show');
          if (overflowBtn) overflowBtn.classList.remove('open');
          if (onNavigate) {
            await onNavigate(fav.path, fav.name);
          }
        });

        const iconSpan = menuItem.querySelector('svg, div');
        if (iconSpan && iconSpan.tagName.toLowerCase() === 'svg') {
          if (fav.icon && fav.icon.startsWith('FAV_')) {
            iconSpan.classList.add('bookmark-icon-fav');
          } else {
            iconSpan.classList.add(`icon-color-${fav.color || 'default'}`);
          }
        }

        bookmarkOverflowMenu.appendChild(menuItem);
      });

      const rect = e.currentTarget.getBoundingClientRect();
      bookmarkOverflowMenu.style.top = `${rect.bottom + 4}px`;
      bookmarkOverflowMenu.style.left = 'auto';
      bookmarkOverflowMenu.style.right = `${window.innerWidth - rect.right}px`;
      bookmarkOverflowMenu.classList.add('show');
      overflowBtn.classList.add('open');
    });
  }

  window.addEventListener('click', (e) => {
    if (bookmarkOverflowMenu && !e.target.closest('#bookmark-overflow-btn') && !e.target.closest('#bookmark-overflow-menu')) {
      bookmarkOverflowMenu.classList.remove('show');
      if (overflowBtn) overflowBtn.classList.remove('open');
    }
  });
}
