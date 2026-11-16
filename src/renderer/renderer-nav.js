// ============================================================================
// Veloce - Navigation & History Controller (renderer-nav.js)
// ============================================================================
// 本モジュールは、パンくず・親階層への移動（上へ）、戻る/進む履歴スタック操作、
// ナビゲーションボタン状態制御、および履歴コンテキストメニューを担当する。
// ============================================================================

import { appState } from './renderer-state.js';
import { uiManager } from './renderer-ui.js';
import { getParentDirectory } from '../common/path-utils.js';
import { setSetting } from '../common/settings-store.js';
import { resolvePathDisplay } from './favorite-icons.js';

let navCallbacks = {
  refreshFileList: async () => {},
  expandTreeToPath: async () => {},
  saveTabsState: () => {},
  getTabNameForPath: (p) => p
};

/**
 * ナビゲーションに必要な外部コールバック群を登録する
 * @param {Object} callbacks
 */
export function initNav(callbacks = {}) {
  navCallbacks = { ...navCallbacks, ...callbacks };
}

/**
 * ツールバーのナビゲーションボタン（進む/戻る/上へ）の有効・無効状態を更新する
 */
export function updateNavButtons() {
  const backBtn = document.getElementById('nav-back-btn');
  const forwardBtn = document.getElementById('nav-forward-btn');
  const upBtn = document.getElementById('nav-up-btn');
  const tab = appState.tabs && appState.tabs[appState.activeTabIndex];
  const currentDir = appState.currentDirectory || (tab && tab.path) || '';
  if (upBtn) {
    upBtn.disabled = !getParentDirectory(currentDir);
  }
  if (!tab || !tab.history) {
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
    return;
  }
  if (backBtn) backBtn.disabled = tab.historyIndex <= 0;
  if (forwardBtn) forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
}

/**
 * 現在表示中のフォルダから1階層上の親フォルダへ移動する。
 * ルートディレクトリ・PC・スマートフォルダ等の親が存在しない状態では何もしない。
 */
export async function navigateUp() {
  const activeTab = appState.tabs && appState.tabs[appState.activeTabIndex];
  const currentDir = appState.currentDirectory || (activeTab && activeTab.path) || '';
  const parentPath = getParentDirectory(currentDir);
  if (!parentPath) return;

  appState.selection.clear();
  appState.selectedIndex = -1;
  uiManager.updateSelectionUI();

  if (activeTab) {
    activeTab.path = parentPath;
    activeTab.name = navCallbacks.getTabNameForPath(parentPath);
    activeTab.scrollTop = 0;
  }
  appState.savedScrollTopGrid = 0;
  appState.savedScrollTopList = 0;
  appState.currentDirectory = parentPath;
  setSetting('currentDirectory', parentPath);
  uiManager.renderTabs();
  navCallbacks.saveTabsState();

  await navCallbacks.refreshFileList(true);
  await navCallbacks.expandTreeToPath(parentPath);
  updateNavButtons();
}

/**
 * 指定オフセット分、履歴スタックを移動する
 * @param {number} offset - 移動量（-1 で戻る、+1 で進む）
 */
export async function navigateHistory(offset) {
  const tab = appState.tabs && appState.tabs[appState.activeTabIndex];
  if (!tab || !tab.history) return;

  const newIndex = tab.historyIndex + offset;
  if (newIndex >= 0 && newIndex < tab.history.length) {
    appState.isNavigatingHistory = true;
    tab.historyIndex = newIndex;
    const targetPath = tab.history[newIndex];

    tab.path = targetPath;
    tab.name = navCallbacks.getTabNameForPath(targetPath);
    tab.scrollTop = 0;
    appState.currentDirectory = targetPath;
    setSetting('currentDirectory', appState.currentDirectory);
    uiManager.renderTabs();
    navCallbacks.saveTabsState();

    await navCallbacks.refreshFileList(true);
    await navCallbacks.expandTreeToPath(targetPath);

    updateNavButtons();
    appState.isNavigatingHistory = false;
  }
}

/**
 * 戻る・進むの履歴メニューを表示します。
 * @param {MouseEvent} event
 * @param {number} direction - -1（戻る）または 1（進む）
 * @param {HTMLElement} btnElement
 */
export function showHistoryMenu(event, direction, btnElement) {
  const tab = (typeof appState.getActiveTab === 'function')
    ? appState.getActiveTab()
    : (appState.tabs && appState.tabs[appState.activeTabIndex]);
  if (!tab || !tab.history || tab.history.length === 0) return;

  let menu = document.getElementById('history-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'history-menu';
    document.body.appendChild(menu);
  }

  menu.replaceChildren(); // 中身をリセット

  const currentIndex = tab.historyIndex;
  let historyItems = [];

  // 履歴をリスト化（戻る時は新しい順、進む時は古い順が見やすい）
  if (direction === -1) {
    for (let i = currentIndex - 1; i >= 0; i--) {
      historyItems.push({ index: i, path: tab.history[i] });
    }
  } else {
    for (let i = currentIndex + 1; i < tab.history.length; i++) {
      historyItems.push({ index: i, path: tab.history[i] });
    }
  }

  if (historyItems.length === 0) return;

  historyItems.forEach(item => {
    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';

    // お気に入りに登録されているかチェック
    const fav = appState.favorites?.find(f => f.path === item.path);
    const { displayName, iconHtml, iconClass } = resolvePathDisplay(fav, item.path);

    menuItem.innerHTML = `
      <span class="menu-icon ${iconClass} menu-item-icon">${iconHtml}</span>
      <span class="menu-item-text">${displayName}</span>
    `;
    menuItem.title = item.path; // ホバーでフルパス表示

    // 履歴クリック時の移動処理
    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      const offset = item.index - tab.historyIndex; // 目的のインデックスまでの差分を計算
      navigateHistory(offset);
      menu.classList.remove('show');
    });

    menu.appendChild(menuItem);
  });

  // メニューの位置をボタンの下に設定
  const btnRect = btnElement.getBoundingClientRect();
  menu.style.left = `${btnRect.left}px`;
  menu.style.top = `${btnRect.bottom + 4}px`;
  menu.classList.add('show');
}

/**
 * 戻る・進むボタンのクリック／長押し／右クリックメニュー等のイベントを設定する
 * @param {string} btnId - ボタン要素ID
 * @param {number} direction - -1（戻る）または 1（進む）
 * @param {string} tooltipText - ツールチップ表示テキスト
 */
export function setupNavButtonEvents(btnId, direction, tooltipText) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  let pressTimer;
  let isLongPressed = false;

  uiManager.bindTooltip(btn, tooltipText, {
    isDisabled: () => btn.disabled
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!btn.disabled) showHistoryMenu(e, direction, btn);
  });

  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || btn.disabled) return;
    isLongPressed = false;
    pressTimer = setTimeout(() => {
      isLongPressed = true;
      showHistoryMenu(e, direction, btn);
    }, 300);
  });

  btn.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || btn.disabled) return;
    clearTimeout(pressTimer);
  });

  btn.addEventListener('mouseleave', () => {
    clearTimeout(pressTimer);
  });

  btn.addEventListener('click', (e) => {
    if (btn.disabled) return;
    uiManager.hideCustomTooltip();
    if (isLongPressed) {
      // 長押し完了後のクリックイベントをここで完全に握りつぶし、メニュー非表示を回避する
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      isLongPressed = false; // フラグをリセット
    } else {
      // 短いクリックの場合は通常の移動
      navigateHistory(direction);
    }
  });
}

/**
 * 「上のフォルダへ」ボタン (#nav-up-btn) のツールチップおよびクリックハンドラを初期化する。
 * @param {HTMLButtonElement|null} upBtn
 */
export function initNavUpButton(upBtn) {
  if (!upBtn) return;
  uiManager.bindTooltip(upBtn, '上のフォルダへ', {
    isDisabled: () => upBtn.disabled
  });
  upBtn.addEventListener('click', async () => {
    if (upBtn.disabled) return;
    uiManager.hideCustomTooltip();
    await navigateUp();
  });
}

