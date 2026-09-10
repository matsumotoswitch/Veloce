// ============================================================================
// Veloce - Main Application Controller (renderer.js)
// ============================================================================
// 本モジュールは、メインウィンドウの全体統括コントローラーとして、
// 以下のライフサイクル・イベント管理およびUIオーケストレーションを担う。
//
// 主な責務:
// 1. バックエンドIPC通信の調整 (ディレクトリ走査、メタデータ解析、スマートフォルダ検索等)
// 2. タブ・ナビゲーション履歴 (進む/戻る/タブ切り替え) とレイアウト状態の永続化
// 3. 仮想スクロールとDOMイベントのバインド (グリッド/リスト切り替え、インスペクター同期)
// 4. グローバルショートカットおよびコンテキストメニューのルーティング
// 5. アンドゥ・リドゥスタックおよびファイル操作 (リネーム、ゴミ箱移動、レーティング設定)
// ============================================================================

import { appState, SmartFolderStore } from './renderer-state.js';
import { UIManager, uiManager, formatSize, formatBytesHuman, formatDate, ICON_SVGS, COLORS, createFavoriteEditorUI } from './renderer-ui.js';
import { ThumbnailQueueManager, thumbnailWorkerPool, evictThumbnailCache, cleanupContext, resetThumbnailPreloader } from './renderer-thumbnails.js';
import { debounce, blockDevtoolsShortcuts, getStreamUrl } from './utils.js';
import { validateFilename } from './path-utils.js';
import { extractMetadataFields, highlightSearchTerms, buildInspectorSections, createSearchTermsRegex } from './metadata-format.js';
import { resolvePathDisplay } from './favorite-icons.js';
import {
  initTabHandlers,
  updateCurrentTabState as syncCurrentTabState,
  saveTabsState as persistTabsState,
  getTabNameForPath as resolveTabName
} from './renderer-tabs.js';

import {
  ContextMenuManager,
  showMenuWithAnimation,
  createMenuItem,
  createMenuSeparator
} from './renderer-context-menu.js';
import {
  parseLicenseMarkdown,
  showLicenseDialog,
  toggleHelpOverlay
} from './renderer-help.js';
import {
  getInspectorSection,
  getInspectorTag,
  resetInspectorPools,
  clearMetadataUI,
  renderMultipleSelectionSummary,
  initInspectorDelegation,
  renderMetadata
} from './renderer-inspector.js';
import {
  updateSmartFolderRowUI,
  showEditSmartFolderModal,
  showEditFavoriteModal,
  initModalHandlers,
  handleModalEscapeKey
} from './renderer-dialogs.js';
import {
  initDragTooltip,
  updateDragTooltip,
  hideDragTooltip,
  getPathsFromDragEventAsync,
  handleItemDragStart,
  initGlobalDndHandlers,
  initDirTreeDnd,
  initFavoritesDnd
} from './renderer-dnd.js';

export {
  showMenuWithAnimation,
  createMenuItem,
  createMenuSeparator,
  renderMultipleSelectionSummary,
  updateSmartFolderRowUI,
  showEditSmartFolderModal,
  showEditFavoriteModal,
  handleItemDragStart,
  getPathsFromDragEventAsync,
  updateDragTooltip
};

// 開発者ツールショートカット (F12, Ctrl+Shift+I 等) の無効化
blockDevtoolsShortcuts();

// レンダリング制御およびUI更新ディレイの定数定義
const CONFIG = {
  CHUNK_SIZE: 100,        // 一度にDOMに追加する要素数（描画負荷軽減）
  SEARCH_DELAY: 300,      // 検索入力時の反映デバウンス時間(ms)
  REFRESH_DELAY: 100,     // リフレッシュ処理の遅延時間(ms)
  GRID_GAP: 8,            // サムネイルグリッドの隙間(px)
  GRID_PADDING: 8         // サムネイルグリッドのパディング(px)
};

// ----------------------------------------------------
// UI State & Global DOM Elements
// ----------------------------------------------------

// タブ機能の状態初期化
appState.tabs = [];
appState.activeTabIndex = -1;

const resizingState = { left: false, right: false, center: false, leftTop: false, rightTop: false };

const contextMenuManager = new ContextMenuManager();
const contextMenu = contextMenuManager.menuElement;

// タブ一覧メニュー
const tabListMenu = document.createElement('div');
tabListMenu.id = 'tab-list-menu';
document.body.appendChild(tabListMenu);

// ============================================================================
// 2. Tauri API & Backend Communication
// ============================================================================

function updateNavButtons() {
  const backBtn = document.getElementById('nav-back-btn');
  const forwardBtn = document.getElementById('nav-forward-btn');
  const tab = appState.tabs[appState.activeTabIndex];
  if (!tab || !tab.history) {
    if (backBtn) backBtn.disabled = true;
    if (forwardBtn) forwardBtn.disabled = true;
    return;
  }
  if (backBtn) backBtn.disabled = tab.historyIndex <= 0;
  if (forwardBtn) forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
}

async function navigateHistory(offset) {
  const tab = appState.tabs[appState.activeTabIndex];
  if (!tab || !tab.history) return;

  const newIndex = tab.historyIndex + offset;
  if (newIndex >= 0 && newIndex < tab.history.length) {
    appState.isNavigatingHistory = true;
    tab.historyIndex = newIndex;
    const targetPath = tab.history[newIndex];

    tab.path = targetPath;
    tab.name = getTabNameForPath(targetPath);
    tab.scrollTop = 0;
    appState.currentDirectory = targetPath;
    localStorage.setItem('currentDirectory', appState.currentDirectory);
    uiManager.renderTabs();
    saveTabsState();

    await refreshFileList(true);
    await expandTreeToPath(targetPath);

    updateNavButtons();
    appState.isNavigatingHistory = false;
  }
}

async function refreshFileList(showToast = false) {
  if (!appState.currentDirectory) return;

  // 画面切り替え時に表示されたままのツールチップを強制消去
  uiManager.hideCustomTooltip();

  if (showToast) {
    uiManager.showToast('フォルダを読み込み中', 0, 'dir-load-progress', 'info');
  }

  // スクロール位置のキャッシュ: 現在と同じフォルダの再読み込み（F5など）時のみスクロール位置を維持し、
  // 別フォルダやスマートフォルダへの遷移時は 0（先頭）から即時描画する
  const activeTab = appState.tabs && appState.tabs[appState.activeTabIndex];
  const isReloadingCurrent = activeTab && activeTab.path === appState.currentDirectory && (activeTab.scrollTop !== 0);
  const gridContainer = uiManager.elements.thumbnailGrid;
  const listContainer = document.getElementById('center-top');
  appState.savedScrollTopGrid = (typeof appState.savedScrollTopGrid === 'number' && appState.savedScrollTopGrid > 0)
    ? appState.savedScrollTopGrid
    : (isReloadingCurrent && gridContainer ? gridContainer.scrollTop : (activeTab ? activeTab.scrollTop || 0 : 0));
  appState.savedScrollTopList = (typeof appState.savedScrollTopList === 'number' && appState.savedScrollTopList > 0)
    ? appState.savedScrollTopList
    : (isReloadingCurrent && listContainer ? listContainer.scrollTop : 0);
  if (!isReloadingCurrent && listContainer) {
    listContainer.scrollLeft = 0;
  }

  // UIとデータの初期化
  appState.totalCount = 0;
  appState.selection.clear();
  appState.selectedIndex = -1;
  cleanupContext();
  
  // フォルダ切り替え時にサムネイル読み込み中のトーストを強制的に消去
  appState.thumbnailTotalRequested = 0;
  appState.thumbnailCompleted = 0;
  const tToast = document.getElementById('toast-thumbnail-progress');
  if (tToast) {
    tToast.classList.remove('show');
    setTimeout(() => { if (tToast.parentElement) tToast.remove(); }, 300);
  }

  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.value = '';
  }
  appState.searchQuery = '';
  uiManager.renderAll();

  try {
    appState.pushHistory(appState.currentDirectory);
    updateNavButtons();
    // Rust側のバックグラウンド処理をキックする
    // ※結果は await せず、onDirectoryLoaded リスナー側で随時受け取る
    await window.veloceAPI.loadDirectory(appState.currentDirectory);
  } catch (error) {
    console.error('Failed to start loading directory:', error);
  }
}

async function refreshTree() {
  if (!window.veloceAPI.getDrives) return;
  const scrollTop = uiManager.elements.dirTree.scrollTop;
  const scrollLeft = uiManager.elements.dirTree.scrollLeft;

  const expandedPaths = Array.from(uiManager.elements.dirTree.querySelectorAll('.tree-children.expanded'))
    .map(ul => ul.previousElementSibling?.dataset?.path)
    .filter(Boolean);

  const tempContainer = document.createElement('div');
  const ul = document.createElement('ul');
  ul.className = 'tree-root';
  const drives = await window.veloceAPI.getDrives();
  for (const drive of drives) {
    ul.appendChild(createTreeNode({ name: drive, path: drive }, true));
  }
  tempContainer.appendChild(ul);

  expandedPaths.sort((a, b) => a.length - b.length);
  for (const p of expandedPaths) {
    await expandTreeToPath(p, true, tempContainer);
    const escapedPath = CSS.escape(p);
    const itemDiv = tempContainer.querySelector(`.tree-item[data-path="${escapedPath}"]`);
    if (itemDiv && itemDiv.expandNode) {
      await itemDiv.expandNode();
    }
  }

  if (appState.currentDirectory) {
    await expandTreeToPath(appState.currentDirectory, true, tempContainer);
  }

  uiManager.elements.dirTree.innerHTML = '';
  uiManager.elements.dirTree.appendChild(ul);
  uiManager.elements.dirTree.scrollTop = scrollTop;
  uiManager.elements.dirTree.scrollLeft = scrollLeft;
}

/**
 * フォルダツリー要素を安全にスクロール表示する
 * ネイティブの scrollIntoView() による祖先要素（body/window全体）の不正なスクロール暴走を防ぐため、
 * 親コンテナ（#directories-section）の scrollTop のみを直接計算して操作する
 * @param {HTMLElement} itemDiv - 表示対象のツリーアイテム要素
 * @param {'center'|'nearest'} [block='center'] - スクロール位置
 */
function scrollTreeItemIntoView(itemDiv, block = 'center') {
  if (!itemDiv) return;
  const container = itemDiv.closest('#directories-section') || itemDiv.closest('#dir-tree');
  if (!container) return;

  const itemRect = itemDiv.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  if (block === 'center') {
    const targetScrollTop = container.scrollTop + (itemRect.top - containerRect.top) - (containerRect.height / 2) + (itemRect.height / 2);
    container.scrollTop = Math.max(0, targetScrollTop);
  } else {
    if (itemRect.top < containerRect.top) {
      container.scrollTop = Math.max(0, container.scrollTop - (containerRect.top - itemRect.top));
    } else if (itemRect.bottom > containerRect.bottom) {
      container.scrollTop = container.scrollTop + (itemRect.bottom - containerRect.bottom);
    }
  }
}

/**
 * タブ要素を安全に横スクロール表示する
 * @param {HTMLElement} tabEl - 表示対象のタブ要素
 */
function scrollTabIntoView(tabEl) {
  if (!tabEl) return;
  const container = document.getElementById('tab-container');
  if (!container) return;

  const tabRect = tabEl.getBoundingClientRect();
  const contRect = container.getBoundingClientRect();

  if (tabRect.left < contRect.left) {
    container.scrollLeft = Math.max(0, container.scrollLeft - (contRect.left - tabRect.left));
  } else if (tabRect.right > contRect.right) {
    container.scrollLeft = container.scrollLeft + (tabRect.right - contRect.right);
  }
}

async function expandTreeToPath(targetPath, disableScroll = false, rootElement = document) {
  if (!targetPath || targetPath === 'PC') return;

  const searchRoot = rootElement === document ? document.getElementById('dir-tree') : rootElement;
  if (!searchRoot) return;

  if (targetPath.startsWith('smart://')) {
    const activeItem = searchRoot.querySelector('.tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    return;
  }

  const separator = '\\';
  const parts = targetPath.split(separator).filter(p => p !== '');
  let pathsToExpand = [];

  let current = parts[0] + separator;
  pathsToExpand.push(current);
  for (let i = 1; i < parts.length; i++) {
    current += parts[i];
    pathsToExpand.push(current);
    current += separator;
  }

  for (let i = 0; i < pathsToExpand.length; i++) {
    const p = pathsToExpand[i];
    const escapedPath = CSS.escape(p);
    const itemDiv = searchRoot.querySelector(`.tree-item[data-path="${escapedPath}"]`);

    if (itemDiv) {
      if (i === pathsToExpand.length - 1) {
        const activeItem = searchRoot.querySelector('.tree-item.selected');
        if (activeItem) activeItem.classList.remove('selected');
        itemDiv.classList.add('selected');
        if (!disableScroll) {
          scrollTreeItemIntoView(itemDiv, 'center');
        }
      } else {
        if (itemDiv.expandNode) await itemDiv.expandNode();
      }
    } else {
      break;
    }
  }
}

function updateMetadataToast() {
  const total = appState.metadataTargetCount;
  const current = appState.metadataCompleted;

  if (total === 0 || current >= total) {
    const t = document.getElementById('toast-metadata-load');
    if (t) {
      t.classList.remove('show');
      setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
    }
    return;
  }

  const msg = `ファイル情報を読み込み中 (${current}/${total})`;
  uiManager.showToast(msg, 0, 'metadata-load', 'info');
}


async function renameSelectedFolder() {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement.parentElement.classList.contains('tree-root');
  if (isRoot) {
    showNotification('ドライブ名を変更することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const oldName = selectedFolderEl.querySelector('.tree-label').textContent;

  const newName = await uiManager.showPrompt('新しいフォルダ名を入力してください:', oldName);
  if (newName !== null && newName !== oldName) {
    if (newName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
      return;
    }

    const result = await window.veloceAPI.renameFolder(oldPath, newName);
    if (result && result.success) {
      appState.undoStack.push({ type: 'RENAME_FOLDER', oldPath, newPath: result.path });
      showNotification(`フォルダ名を「${newName}」に変更しました`, 'success');
      if (appState.currentDirectory.startsWith(oldPath)) {
        appState.currentDirectory = appState.currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', appState.currentDirectory);
      }
      await refreshTree();
    } else {
      showNotification(`フォルダ名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

async function deleteSelectedFolder() {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement.parentElement.classList.contains('tree-root');
  if (isRoot) {
    showNotification('ドライブを削除することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const folderName = selectedFolderEl.querySelector('.tree-label').textContent;

  const isConfirmed = await uiManager.showConfirm(`本当にフォルダ「${folderName}」をゴミ箱に移動しますか？`);
  if (isConfirmed) {
    const result = await window.veloceAPI.trashFolder(oldPath);
    if (result && result.success) {
      showNotification(`フォルダ「${folderName}」をゴミ箱に移動しました`, 'warning');
      if (appState.currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        appState.currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', appState.currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      showNotification(`フォルダの削除に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

async function renameSelectedFile() {
  if (appState.selectedIndex > -1) {
    const file = await window.veloceAPI.getFileByIndex(appState.selectedIndex);
    if (!file) return;
    const oldPath = file.path;
    const newName = await uiManager.showPrompt('新しいファイル名を入力してください:', file.name, true);
    if (newName !== null && newName !== file.name) {
      if (newName.trim() === '') {
        uiManager.showToast('ファイル名を入力してください。', 3000, 'file-rename', 'warning');
        return;
      }
      if (/[\\/:*?"<>|]/.test(newName)) {
        uiManager.showToast('ファイル名に以下の文字は使用できません: \\ / : * ? " < > |', 3000, 'file-rename', 'warning');
        return;
      }

      const result = await window.veloceAPI.renameFile(oldPath, newName);
      if (result && result.success) {
        appState.undoStack.push({ type: 'RENAME_FILE', oldPath, newPath: result.path });
        uiManager.showToast(`ファイル名を「${newName}」に変更しました`, 3000, 'file-rename', 'success');

        const newExt = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';

        file.path = result.path;
        file.name = newName;
        file.ext = newExt;

        // Rust側に変更を通知
        await window.veloceAPI.notifyFileChanged(file);

        const oldUrl = appState.thumbnailUrls.get(oldPath);
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        appState.thumbnailUrls.delete(oldPath);
        resetThumbnailPreloader();
        scheduleRefresh();
      } else {
        uiManager.showToast(`ファイル名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 3000, 'file-rename', 'warning');
      }
    }
  }
}

async function rebuildSelectedCache() {
  try {
    if (appState.selection.size === 0) return;

    const pathsToRebuild = [];
    if (window.veloceAPI.getFilesByIndices) {
      const indices = Array.from(appState.selection);
      const files = await window.veloceAPI.getFilesByIndices(indices);
      for (const file of files) {
        pathsToRebuild.push(file.path);
        if (appState.thumbnailUrls.has(file.path)) {
          const oldUrl = appState.thumbnailUrls.get(file.path);
          if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
          appState.thumbnailUrls.delete(file.path);
        }
      }
    } else {
      for (const index of appState.selection) {
        const file = await window.veloceAPI.getFileByIndex(index);
        if (file) {
          pathsToRebuild.push(file.path);
          if (appState.thumbnailUrls.has(file.path)) {
            const oldUrl = appState.thumbnailUrls.get(file.path);
            if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
            appState.thumbnailUrls.delete(file.path);
          }
        }
      }
    }

    if (window.veloceAPI && window.veloceAPI.clearMetadataCache) {
      await window.veloceAPI.clearMetadataCache(pathsToRebuild);

      if (appState.thumbnailTotalRequested === 0) {
        appState.thumbnailCompleted = 0;
      }
      appState.thumbnailTotalRequested += pathsToRebuild.length;

      if (!appState.rebuiltPaths) appState.rebuiltPaths = new Set();
      pathsToRebuild.forEach(p => {
        appState.thumbnailCounted.delete(p);
        appState.rebuiltPaths.add(p);
      });

      if (window.thumbnailManager) window.thumbnailManager.unshiftPreload(pathsToRebuild);

      if (typeof window.updateThumbnailToast === 'function') window.updateThumbnailToast();
      if (typeof window.processNextTask === 'function') window.processNextTask();
    } else {
      uiManager.showToast("エラー: APIが見つかりません", 5000, 'error');
    }

    if (typeof uiManager.updateVirtualGrid === 'function') {
      uiManager.updateVirtualGrid(true);
    }
    if (typeof uiManager.updateVirtualList === 'function') {
      uiManager.updateVirtualList(true);
    }
  } catch (err) {
    uiManager.showToast("エラーが発生しました: " + err.toString(), 5000, 'error');
  }
}

async function deleteSelectedFiles() {
  if (appState.selection.size > 0) {
    const pathsToDelete = [];
    if (window.veloceAPI.getFilesByIndices) {
      const indices = Array.from(appState.selection);
      const files = await window.veloceAPI.getFilesByIndices(indices);
      for (const f of files) {
        pathsToDelete.push(f.path);
      }
    } else {
      for (const i of appState.selection) {
        const f = await window.veloceAPI.getFileByIndex(i);
        if (f) pathsToDelete.push(f.path);
      }
    }

    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();
    clearMetadataUI();

    let trashedCount = 0;
    const total = pathsToDelete.length;
    uiManager.showToast(`${total}件のアイテムをゴミ箱に移動中...`, 0, 'file-trash', 'warning');

    for (const path of pathsToDelete) {
      try {
        const success = await window.veloceAPI.trashFile(path);
        if (success) {
          trashedCount++;
          await window.veloceAPI.notifyFileRemoved(path);
        }
      } catch (err) {
        console.error('Failed to trash file:', err);
      }
    }

    if (trashedCount > 0) {
      uiManager.showToast(`${trashedCount}件のアイテムをゴミ箱に移動しました`, 3000, 'file-trash', 'warning');


      scheduleRefresh();
    } else {
      uiManager.showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

let bookmarkOverflowMenu = null;

function checkBookmarkOverflow() {
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

const bookmarkResizeObserver = new ResizeObserver(() => {
  checkBookmarkOverflow();
});

window.addEventListener('click', (e) => {
  if (bookmarkOverflowMenu && !e.target.closest('#bookmark-overflow-btn') && !e.target.closest('#bookmark-overflow-menu')) {
    bookmarkOverflowMenu.classList.remove('show');
  }
});



function renderFavorites() {
  const container = document.getElementById('bookmark-list');
  if (!container) return;
  container.innerHTML = '';

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
    if (fav.icon && ICON_SVGS[fav.icon]) {
      icon.innerHTML = ICON_SVGS[fav.icon];
      icon.classList.add(`icon-color-${fav.color || 'default'}`);
    } else if (fav.icon && fav.icon.startsWith('FAV_')) {
      icon.innerHTML = UIManager.ICONS[fav.icon] || UIManager.ICONS['FAV_STAR'];
      icon.style.color = 'var(--glow-gold)';
    } else {
      icon.innerHTML = UIManager.ICONS.FAV_STAR;
    }
    icon.style.display = 'flex';
    icon.style.alignItems = 'center';

    const label = document.createElement('span');
    label.textContent = fav.name;

    itemDiv.appendChild(icon);
    itemDiv.appendChild(label);
    container.appendChild(itemDiv);
  });

  if (typeof checkBookmarkOverflow === 'function') {
    checkBookmarkOverflow();
  }
}

// ============================================================================
// 3. Core Business Logic & Helpers
// ============================================================================

function showNotification(message, type = 'info', duration = null, id = null) {
  let finalDuration = duration;
  if (finalDuration === null) {
    finalDuration = (type === 'info') ? 1500 : 3000;
  }
  uiManager.showToast(message, finalDuration, id, type);
}




// (clearMetadataUI and renderMultipleSelectionSummary are modularized into renderer-inspector.js)

export function applyRatingUI(path, rating, isOptimistic = false) {
  if (rating === 0) {
    delete appState.ratings[path];
  } else {
    appState.ratings[path] = rating;
  }

  if (uiManager.elements.thumbnailGrid || uiManager.elements.fileListBody) {
    // 1. サムネイルグリッドの更新 (O(1) 高速同期 & 星ポップアニメーション)
    if (uiManager._domByPath) {
      const domItem = uiManager._domByPath.get(path);
      if (domItem) {
        domItem._cachedRating = rating;
        let badge = domItem.children[2];
        if (!badge || !badge.classList.contains('rating-badge')) {
          badge = domItem.querySelector('.rating-badge');
        }
        if (badge) {
          if (rating > 0) {
            if (badge._hideTimer) {
              clearTimeout(badge._hideTimer);
              badge._hideTimer = null;
            }
            badge.children[1].textContent = rating;
            badge.classList.remove('rating-hide');
            badge.classList.add('show');
            // すでにアニメーション中の場合は再起動によるカクつきを防ぐ
            if (isOptimistic || !badge.classList.contains('rating-pop')) {
              badge.classList.remove('rating-pop');
              void badge.offsetWidth;
              badge.classList.add('rating-pop');
            }
          } else {
            // レーティング解除時: 膨らんでから徐々に縮小・消滅するアニメーション
            if (badge.classList.contains('show')) {
              badge.classList.remove('rating-pop');
              badge.classList.remove('rating-hide');
              void badge.offsetWidth;
              badge.classList.add('rating-hide');
              if (badge._hideTimer) clearTimeout(badge._hideTimer);
              badge._hideTimer = setTimeout(() => {
                badge.classList.remove('show', 'rating-hide');
                badge._hideTimer = null;
              }, 280);
            } else {
              badge.classList.remove('show', 'rating-pop', 'rating-hide');
            }
          }
        }
      }
    }

    // 2. ファイルテーブル行の更新 (O(1) 高速同期)
    if (uiManager._listDomByPath) {
      const tr = uiManager._listDomByPath.get(path);
      if (tr) {
        const td = tr.children[7];
        if (td) {
          if (rating > 0) {
            const starSvg = '<svg class="rating-star-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            td.innerHTML = starSvg + rating;
          } else {
            td.textContent = '-';
          }
        }
      }
    }
  }

  if (appState.ratingFilterVal > 0 || appState.sortConfig.key === 'rating') {
    scheduleRefresh();
  }
  if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
    window.debouncedUpdateSmartFolderCounts();
  }
}

const scheduleRefresh = debounce(async () => {
  appState.preloadCursor = 0;
  await appState.setViewParams();
  uiManager.renderAll();
  uiManager.updateSelectionUI();
  if (appState.selectedIndex === -1) {
    clearMetadataUI();
  } else if (appState.selection.size > 1) {
    renderMultipleSelectionSummary();
  } else {
    window.veloceAPI.getFileByIndex(appState.selectedIndex).then(file => {
      if (file) renderMetadata(file);
    });
  }
}, CONFIG.REFRESH_DELAY);

function createTreeNode(folder, isRoot = false) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const itemDiv = document.createElement('div');
  itemDiv.className = 'tree-item folder';
  itemDiv.dataset.path = folder.path; // 展開用の目印としてパスを持たせる
  itemDiv.dataset.name = folder.name;
  itemDiv.dataset.isRoot = isRoot;
  itemDiv.style.display = 'flex';
  itemDiv.style.alignItems = 'center';
  itemDiv.draggable = !isRoot; // ドライブ以外はドラッグ可能に

  // 展開・折りたたみ用のトグルアイコン
  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'tree-toggle toggle-icon';
  toggleIcon.style.display = 'inline-flex';
  toggleIcon.style.alignItems = 'center';
  toggleIcon.innerHTML = UIManager.ICONS.CHEVRON_RIGHT;

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = isRoot ? UIManager.ICONS.DRIVE : UIManager.ICONS.FOLDER;
  icon.style.marginRight = '4px';
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  if (!isRoot) {
    icon.style.color = 'var(--accent-hover)';
  }

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = isRoot ? folder.path : folder.name;

  itemDiv.appendChild(toggleIcon);
  itemDiv.appendChild(icon);
  itemDiv.appendChild(label);
  li.appendChild(itemDiv);

  const childrenUl = document.createElement('ul');
  childrenUl.className = 'tree-children collapsed';
  childrenUl.style.display = 'none';
  li.appendChild(childrenUl);

  let isLoaded = false;

  // ノードを展開してサブフォルダを遅延読み込みする処理
  const expandNode = async () => {
    if (!isLoaded) {
      const subFolders = await window.veloceAPI.getFolders(folder.path);

      // もし開いたフォルダ自身にサブフォルダがない場合は、自身の展開アイコンを隠して終了する
      if (subFolders.length === 0) {
        toggleIcon.style.visibility = 'hidden';
        isLoaded = true;
        return;
      }

      subFolders.forEach(subFolder => {
        const childNode = createTreeNode(subFolder);
        childrenUl.appendChild(childNode);

        // 1つ下位のフォルダについて、更に下位フォルダ(孫)の有無を非同期で確認し、空ならアイコンを非表示にする
        window.veloceAPI.getFolders(subFolder.path).then(grandChildren => {
          if (grandChildren && grandChildren.length === 0) {
            const childToggle = childNode.querySelector('.tree-toggle');
            if (childToggle) childToggle.style.visibility = 'hidden';
          }
        }).catch(err => console.error('Failed to check subfolders:', err));
      });
      isLoaded = true;
    }

    // 中身のサブフォルダが存在する場合のみ、展開アニメーションとクラスの付与を行う
    if (childrenUl.children.length > 0) {
      childrenUl.style.display = 'block';
      childrenUl.classList.remove('collapsed');
      childrenUl.classList.add('expanded');
      toggleIcon.classList.add('expanded');
    }
  };

  // 外部から展開処理を呼び出せるように要素に紐付ける
  itemDiv.expandNode = expandNode;

  itemDiv.reloadFolder = async () => {
    isLoaded = false;
    childrenUl.innerHTML = '';
    const wasExpanded = childrenUl.classList.contains('expanded');

    // サブフォルダの有無を事前に確認する
    const subFolders = await window.veloceAPI.getFolders(folder.path);
    if (subFolders.length === 0) {
      toggleIcon.style.visibility = 'hidden';
      childrenUl.style.display = 'none';
      childrenUl.classList.remove('expanded');
      childrenUl.classList.add('collapsed');
      toggleIcon.classList.remove('expanded');
      isLoaded = true;
      return;
    }

    // サブフォルダがある場合はトグルアイコンを表示
    toggleIcon.style.visibility = 'visible';

    if (wasExpanded) {
      await expandNode();
    }
  };

  // ノードを折りたたむ処理
  const collapseNode = () => {
    childrenUl.style.display = 'none';
    childrenUl.classList.remove('expanded');
    childrenUl.classList.add('collapsed');
    toggleIcon.classList.remove('expanded');
  };
  itemDiv.collapseNode = collapseNode;

  return li;
}


const TABLE_HEADERS = {
  name: '名前',
  ext: '拡張子',
  width: '幅',
  height: '高さ',
  ratio: '比率',
  size: 'サイズ',
  mtime: '更新日時',
  rating: 'レーティング',
};

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const key = th.dataset.sort;
    if (TABLE_HEADERS[key]) {
      let arrow = th.querySelector('.sort-arrow');
      if (appState.sortConfig.key === key) {
        if (!arrow) {
          th.innerHTML = `${TABLE_HEADERS[key]}${UIManager.ICONS.SORT_ARROW || ''}`;
          arrow = th.querySelector('.sort-arrow');
        }
        if (arrow) {
          arrow.classList.toggle('asc', appState.sortConfig.asc);
          arrow.classList.toggle('desc', !appState.sortConfig.asc);
        }
      } else {
        if (arrow) arrow.remove();
        th.textContent = TABLE_HEADERS[key];
      }
    }
  });

  // ソートドロップダウンの表示も同期する
  updateSortSelectDropdown();
}

/**
 * #sort-select-container のラベルと選択状態を appState.sortConfig に同期する
 */
function updateSortSelectDropdown() {
  const container = document.getElementById('sort-select-container');
  const label = document.getElementById('sort-select-label');
  if (!container || !label) return;

  const { key, asc } = appState.sortConfig;
  const items = container.querySelectorAll('.custom-select-item');
  let matched = null;

  items.forEach(item => {
    const itemKey = item.dataset.sortKey;
    const itemAsc = item.dataset.sortAsc === 'true';
    const isMatch = itemKey === key && itemAsc === asc;
    item.classList.toggle('selected', isMatch);
    if (isMatch) matched = item;
  });

  if (matched) {
    label.textContent = matched.textContent;
  } else {
    // 完全一致がない場合はキー名だけ表示
    const keyLabel = TABLE_HEADERS[key] || key;
    label.textContent = keyLabel + (asc ? ' (昇順)' : ' (降順)');
  }
}

export async function selectImage(index, event = null) {
  window.getSelection().removeAllRanges();
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
    document.activeElement.blur();
  }
  if (event && event.ctrlKey) {
    // Ctrlキーで個別に選択/解除
    if (appState.selection.has(index)) {
      appState.selection.delete(index);
      if (appState.selectedIndex === index) {
        appState.selectedIndex = appState.selection.size > 0 ? Array.from(appState.selection).pop() : -1;
      }
    } else {
      appState.selection.add(index);
      appState.selectedIndex = index;
    }
  } else if (event && event.shiftKey && appState.selectedIndex !== -1) {
    // Shiftキーで範囲選択
    const start = Math.min(appState.selectedIndex, index);
    const end = Math.max(appState.selectedIndex, index);
    appState.selection.clear();
    for (let i = start; i <= end; i++) {
      appState.selection.add(i);
    }
    appState.selectedIndex = index;
  } else {
    // 通常のクリック（単一選択）
    appState.selection.clear();
    appState.selection.add(index);
    appState.selectedIndex = index;
  }

  if (appState.selectedIndex === -1) {
    uiManager.updateSelectionUI();
    clearMetadataUI();
    return;
  }

  uiManager.updateSelectionUI();

  // 選択した画像が画面内に表示されるように自動スクロール (仮想スクロール対応)
  const container = uiManager.elements.thumbnailGrid;
  if (container) {
    const itemSize = parseFloat(uiManager.elements.thumbnailSizeSlider?.value) || 120;
    const gap = 8;
    const padding = 8;
    const width = container.clientWidth - (padding * 2);
    const cols = Math.max(1, Math.floor((width + gap) / (itemSize + gap)));

    const row = Math.floor(index / cols);
    const targetY = row * (itemSize + gap);

    if (targetY < container.scrollTop) {
      container.scrollTop = targetY;
    } else if (targetY + itemSize + gap > container.scrollTop + container.clientHeight) {
      container.scrollTop = targetY + itemSize + gap - container.clientHeight + padding * 2;
    }
  }

  // リストビューのスクロール位置を調整 (仮想スクロール対応)
  const listContainer = document.getElementById('center-top');
  if (listContainer) {
    const rowHeight = 28;
    const theadHeight = 32;
    const targetY = theadHeight + (index * rowHeight);

    // ヘッダーが position: sticky; top: 0; であるため、表示領域の上端は scrollTop + theadHeight
    if (targetY < listContainer.scrollTop + theadHeight) {
      listContainer.scrollTop = targetY - theadHeight;
    } else if (targetY + rowHeight > listContainer.scrollTop + listContainer.clientHeight) {
      listContainer.scrollTop = targetY + rowHeight - listContainer.clientHeight;
    }
  }

  // インスペクターの更新 (IPC呼び出しをUI更新後に遅延させてキーボード移動の遅延をなくす)
  if (appState.selection.size > 1) {
    renderMultipleSelectionSummary();
  } else {
    const file = await window.veloceAPI.getFileByIndex(index);
    if (file) renderMetadata(file);
  }
}

async function openViewer(index, filePath = null) {
  if (index < 0 && !filePath) return;

  let targetFilePath = filePath;
  let file = null;

  if (targetFilePath) {
    file = await window.veloceAPI.getFileByIndex(index);
    if (!file || file.path !== targetFilePath) {
      file = { path: targetFilePath, width: 0, height: 0 };
    }
  } else {
    file = await window.veloceAPI.getFileByIndex(index);
    if (file) targetFilePath = file.path;
  }

  // IPC通信の遅延を回避するため、初期表示用のデータを LocalStorage に保存して直接渡す
  if (targetFilePath) {
    localStorage.setItem('viewerInitialData', JSON.stringify({
      path: targetFilePath,
      total: appState.totalCount,
      index: index
    }));

    // パス配列はRust側にあるため転送不要
    localStorage.removeItem('viewerPaths');
    localStorage.removeItem('viewerStartIndex');
  }

  window.veloceAPI.openViewer({
    currentIndex: index,
    filePath: targetFilePath,
    width: file ? file.width : 0,
    height: file ? file.height : 0,
    monitorWidth: window.screen.availWidth,
    monitorHeight: window.screen.availHeight
  });
}

// (Help & License overlays are modularized into renderer-help.js)

/**
 * 現在のタブの状態を同期します。
 */
function updateCurrentTabState() {
  syncCurrentTabState(appState, uiManager);
}

/**
 * タブの状態をローカルストレージに保存します。
 */
function saveTabsState() {
  persistTabsState(appState, uiManager);
}

/**
 * パスからタブの表示名を取得します。
 */
function getTabNameForPath(path) {
  if (path.startsWith('smart://')) {
    const id = path.replace('smart://', '');
    const sf = appState.smartFolders?.find(f => f.id === id);
    if (sf) return sf.name;
    return 'スマートフォルダ';
  }
  return resolveTabName(path, appState.favorites);
}

/**
 * 戻る・進むの履歴メニューを表示します。
 */
function showHistoryMenu(event, direction, btnElement) {
  const tab = appState.getActiveTab();
  if (!tab || !tab.history || tab.history.length === 0) return;

  let menu = document.getElementById('history-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'history-menu';
    document.body.appendChild(menu);
  }

  menu.innerHTML = ''; // 中身をリセット

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
    const fav = appState.favorites.find(f => f.path === item.path);
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

// ============================================================================
// 4. Event Handlers (User Interactions)
// ============================================================================

const menuNewFolder = createMenuItem('フォルダを新規作成', UIManager.ICONS.FOLDER_PLUS, async () => {
  if (!contextMenu.targetFolder) return;
  const folderName = await uiManager.showPrompt('新しいフォルダ名を入力してください:');
  if (folderName !== null) {
    const validation = validateFilename(folderName);
    if (!validation.valid) {
      showNotification(validation.message, 'warning');
      return;
    }

    const parentPath = contextMenu.targetFolder.path;
    const result = await window.veloceAPI.createFolder(parentPath, folderName);
    if (result && result.success) {
      showNotification(`フォルダ「${folderName}」を作成しました`, 'success');
      await refreshTree();

      await expandTreeToPath(parentPath, true);
      const escapedParentPath = CSS.escape(parentPath);
      const parentDiv = document.querySelector(`.tree-item[data-path="${escapedParentPath}"]`);
      if (parentDiv && parentDiv.expandNode) {
        await parentDiv.expandNode();
      }

      if (appState.currentDirectory) {
        const escapedCurrent = CSS.escape(appState.currentDirectory);
        const currentDiv = document.querySelector(`.tree-item[data-path="${escapedCurrent}"]`);
        if (currentDiv) {
          const activeItem = document.querySelector('.tree-item.selected');
          if (activeItem) activeItem.classList.remove('selected');
          currentDiv.classList.add('selected');
        }
      }
    } else {
      const errorMsg = result ? result.error : 'Unknown error';
      showNotification(`フォルダの作成に失敗しました: ${errorMsg}`, 'error');
    }
  }
});

// (Inspector DOM Pool and renderMetadata are modularized into renderer-inspector.js)


const menuRenameFolder = createMenuItem('フォルダ名を変更...', UIManager.ICONS.FOLDER_PEN, async () => {
  if (!contextMenu.targetFolder) return;
  const oldPath = contextMenu.targetFolder.path;
  const newName = await uiManager.showPrompt('新しいフォルダ名を入力してください:', contextMenu.targetFolder.name);
  if (newName !== null && newName !== contextMenu.targetFolder.name) {
    if (newName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
      return;
    }

    const result = await window.veloceAPI.renameFolder(oldPath, newName);
    if (result && result.success) {
      appState.undoStack.push({ type: 'RENAME_FOLDER', oldPath, newPath: result.path });
      showNotification(`フォルダ名を「${newName}」に変更しました`, 'success');
      if (appState.currentDirectory.startsWith(oldPath)) {
        appState.currentDirectory = appState.currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', appState.currentDirectory);
      }
      await refreshTree();
    } else {
      showNotification(`フォルダ名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
});

const menuDeleteFolder = createMenuItem('フォルダを削除', UIManager.ICONS.FOLDER_X, async () => {
  if (!contextMenu.targetFolder) return;
  const oldPath = contextMenu.targetFolder.path;
  const isConfirmed = await uiManager.showConfirm(`本当にフォルダ「${contextMenu.targetFolder.name}」をゴミ箱に移動しますか？`);
  if (isConfirmed) {
    const result = await window.veloceAPI.trashFolder(oldPath);
    if (result && result.success) {
      showNotification(`フォルダ「${contextMenu.targetFolder.name}」をゴミ箱に移動しました`, 'warning');
      if (appState.currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        appState.currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', appState.currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      const errorMsg = result ? result.error : 'Unknown error';
      showNotification(`フォルダの削除に失敗しました: ${errorMsg}`, 'error');
    }
  }
}, true, 'Delete');

const menuRenameFile = createMenuItem('ファイル名を変更...', UIManager.ICONS.FILE_PEN, renameSelectedFile, false, 'F2');
const menuDiffFiles = createMenuItem('2つの画像を比較...', UIManager.ICONS.DIFF, async () => {
  if (appState.selection.size === 2) {
    const indices = Array.from(appState.selection);
    const file1 = await window.veloceAPI.getFileByIndex(indices[0]);
    const file2 = await window.veloceAPI.getFileByIndex(indices[1]);

    uiManager.showToast('比較データを読み込み中', 0, 'diff-loading', 'info');
    Promise.all([
      window.veloceAPI.parseMetadata(file1.path),
      window.veloceAPI.parseMetadata(file2.path)
    ]).then(([meta1, meta2]) => {
      const t = document.getElementById('toast-diff-loading');
      if (t) {
        t.classList.remove('show');
        setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
      }
      uiManager.showDiffModal(file1, file2, meta1, meta2);
    });
  }
}, false, 'D');
const menuRebuildCache = createMenuItem('選択項目のキャッシュを再構築', UIManager.ICONS.REFRESH, rebuildSelectedCache);

const menuRebuildFolderCache = createMenuItem('フォルダ全体のキャッシュを再構築', UIManager.ICONS.REFRESH, async () => {
  try {
    if (!appState.currentDirectory) return;
    uiManager.showToast('フォルダ全体のキャッシュを再構築しています...', 0, 'rebuild-folder', 'info');

    const pathsToRebuild = [];
    const total = appState.totalCount;
    const batchSize = 1000;
    for (let i = 0; i < total; i += batchSize) {
      const size = Math.min(batchSize, total - i);
      const files = await window.veloceAPI.getItems(i, size);
      for (const file of files) {
        pathsToRebuild.push(file.path);
      }
    }

    if (window.veloceAPI && window.veloceAPI.clearMetadataCache) {
      await window.veloceAPI.clearMetadataCache(pathsToRebuild);
      cleanupContext();
      appState.thumbnailTotalRequested = 0;
      appState.thumbnailCompleted = 0;
      uiManager.showToast('キャッシュの再構築が完了しました', 3000, 'rebuild-folder', 'success');
      scheduleRefresh();
    }
  } catch (err) {
    uiManager.showToast(`再構築に失敗しました: ${err}`, 3000, 'rebuild-folder', 'error');
  }
});
const menuDeleteFile = createMenuItem('ファイルを削除', UIManager.ICONS.FILE_X, deleteSelectedFiles, true, 'Delete');

// --- コンテキストメニュー「並べ替え」の作成 ---
const menuSortRoot = document.createElement('div');
menuSortRoot.className = 'context-menu-item';
menuSortRoot.innerHTML = `
  ${UIManager.ICONS.SORT || '<div class="menu-icon-placeholder"></div>'}
  <span class="menu-label">並べ替え</span>
  <span></span>
  <span class="menu-arrow">${UIManager.ICONS.CHEVRON_RIGHT}</span>
`;

menuSortRoot.onmouseenter = () => {
  menuSortRoot.classList.add('open');
  // Reset position
  sortSubmenu.style.left = 'calc(100% + 2px)';
  sortSubmenu.style.right = 'auto';
  sortSubmenu.style.top = '-7px';
  sortSubmenu.style.bottom = 'auto';;

  // We need to temporarily force display block if not already to measure it
  // But CSS :hover handles display:block immediately.
  const rect = sortSubmenu.getBoundingClientRect();

  let originX = 'left';
  let originY = 'top';

  if (rect.right > window.innerWidth) {
    sortSubmenu.style.left = 'auto';
    sortSubmenu.style.right = 'calc(100% + 2px)';
    originX = 'right';
  }

  if (rect.bottom > window.innerHeight) {
    sortSubmenu.style.top = 'auto';
    sortSubmenu.style.bottom = '-7px';
    originY = 'bottom';
  }

  sortSubmenu.style.transformOrigin = `${originY} ${originX}`;

  sortSubmenu.animate([
    { opacity: 0, transform: 'scale(0.95)' },
    { opacity: 1, transform: 'scale(1)' }
  ], { duration: 80, easing: 'cubic-bezier(0, 0, 0.2, 1)', fill: 'forwards' });
};

menuSortRoot.onmouseleave = () => {
  menuSortRoot.classList.remove('open');
};

const sortSubmenu = document.createElement('div');
sortSubmenu.className = 'submenu';

const sortOptions = [
  { key: 'name', label: '名前' },
  { key: 'ext', label: '拡張子' },
  { key: 'width', label: '幅' },
  { key: 'height', label: '高さ' },
  { key: 'ratio', label: '比率' },
  { key: 'size', label: 'サイズ' },
  { key: 'mtime', label: '更新日時' },
  { key: 'rating', label: 'レーティング' }
];

const updateSortCheckmarks = () => {
  Array.from(sortSubmenu.children).forEach(child => {
    if (child.dataset.sortKey) {
      const check = child.querySelector('.menu-check');
      if (check) check.innerHTML = appState.sortConfig.key === child.dataset.sortKey ? UIManager.ICONS.CHECK : '';
    }
    if (child.dataset.sortOrder) {
      const check = child.querySelector('.menu-check');
      const isAsc = child.dataset.sortOrder === 'asc';
      if (check) check.innerHTML = appState.sortConfig.asc === isAsc ? UIManager.ICONS.CHECK : '';
    }
  });
};

const handleSortChange = (key, asc) => {
  if (key) appState.sortConfig.key = key;
  if (asc !== undefined) appState.sortConfig.asc = asc;
  localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
  updateSortIndicators();
  scheduleRefresh();
  contextMenu.classList.remove('show');
};

const createSubOption = (label, onClick, dataKey, dataVal) => {
  const opt = document.createElement('div');
  opt.className = 'context-menu-item';
  if (dataKey === 'sortKey') opt.dataset.sortKey = dataVal;
  if (dataKey === 'sortOrder') opt.dataset.sortOrder = dataVal;

  opt.innerHTML = `
    <span class="menu-check menu-check-box"></span>
    <span class="menu-label">${label}</span>
    <span></span>
    <div></div>
  `;

  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return opt;
};

sortOptions.forEach(opt => {
  sortSubmenu.appendChild(createSubOption(opt.label, () => handleSortChange(opt.key, undefined), 'sortKey', opt.key));
});

const menuSeparatorSortSub = createMenuSeparator();
sortSubmenu.appendChild(menuSeparatorSortSub);
sortSubmenu.appendChild(createSubOption('昇順', () => handleSortChange(undefined, true), 'sortOrder', 'asc'));
sortSubmenu.appendChild(createSubOption('降順', () => handleSortChange(undefined, false), 'sortOrder', 'desc'));

menuSortRoot.appendChild(sortSubmenu);

const menuSeparatorSort = createMenuSeparator();

const menuAddFavorite = createMenuItem('お気に入りに追加', UIManager.ICONS.STAR, async () => {
  if (!contextMenu.targetFolder) return;
  const path = contextMenu.targetFolder.path;
  const name = contextMenu.targetFolder.name;
  if (appState.favorites.find(f => f.path === path)) {
    showNotification(`「${name}」はすでにお気に入りにあります`, 'warning');
    return;
  }
  appState.favorites.push({ id: Date.now().toString(), name, path, icon: 'star', color: 'default' });
  localStorage.setItem('favorites', JSON.stringify(appState.favorites));
  renderFavorites();

  // 現在開いているタブの中で該当パスがあれば、お気に入りの名前に更新する
  let tabUpdated = false;
  appState.tabs.forEach(t => {
    if (t.path === path) {
      t.name = name;
      tabUpdated = true;
    }
  });
  if (tabUpdated) { saveTabsState(); uiManager.renderTabs(); }

  showNotification(`「${name}」をお気に入りに追加しました`, 'success');
});

const menuAddSmartFolder = createMenuItem('スマートフォルダを追加...', UIManager.ICONS.FOLDER_PLUS, () => {
  showEditSmartFolderModal({ name: '', icon: 'FAV_STAR', color: 'orange', conditions: [] }, true, {
    createSmartFolderNode,
    refreshFileList,
    updateSmartFolderCountsUI
  });
});

const menuEditSmartFolder = createMenuItem('スマートフォルダを編集...', UIManager.ICONS.EDIT, () => {
  if (!contextMenu.targetSmartFolderId) return;
  const sf = appState.smartFolders.find(f => f.id === contextMenu.targetSmartFolderId);
  if (sf) {
    showEditSmartFolderModal(sf, false, {
      createSmartFolderNode,
      refreshFileList,
      updateSmartFolderCountsUI
    });
  }
});

const menuDuplicateSmartFolder = createMenuItem('スマートフォルダを複製...', UIManager.ICONS.COPY || '', () => {
  if (!contextMenu.targetSmartFolderId) return;
  const sf = appState.smartFolders.find(f => f.id === contextMenu.targetSmartFolderId);
  if (sf) {
    const newName = `${sf.name || '無題のスマートフォルダ'} (1)`;
    const newSf = {
      name: newName,
      icon: sf.icon,
      color: sf.color,
      conditions: sf.conditions ? JSON.parse(JSON.stringify(sf.conditions)) : []
    };
    showEditSmartFolderModal(newSf, true, {
      createSmartFolderNode,
      refreshFileList,
      updateSmartFolderCountsUI
    });
  }
});


const menuDeleteSmartFolder = createMenuItem('スマートフォルダを削除', UIManager.ICONS.TRASH, async () => {
  if (!contextMenu.targetSmartFolderId) return;
  const id = contextMenu.targetSmartFolderId;
  const index = appState.smartFolders.findIndex(f => f.id === id);
  if (index !== -1) {
    appState.smartFolders = await SmartFolderStore.deleteFolder(id);

    const node = document.querySelector(`.smart-folder-item[data-id="${id}"]`);
    if (node) node.remove();
  }
}, true);

const menuPrecacheFolder = createMenuItem('これ以下のファイル情報をすべて取得', UIManager.ICONS.REFRESH, async () => {
  if (contextMenu.targetFolder && contextMenu.targetFolder.path) {
    const path = contextMenu.targetFolder.path;
    showNotification('キャッシュの作成を開始しました。処理中はアプリを閉じないでください。', 'info', null, 'precache');
    try {
      await window.__TAURI__.invoke('precache_directory_recursively', { targetPath: path });
      showNotification('キャッシュの作成が完了しました', 'success', null, 'precache');
    } catch (e) {
      showNotification(`エラーが発生しました: ${e}`, 'error', null, 'precache');
    }
  }
});

const menuEditFavorite = createMenuItem('お気に入りを編集...', UIManager.ICONS.EDIT, () => {
  if (!contextMenu.targetFavoriteId) return;
  const fav = appState.favorites.find(f => String(f.id) === String(contextMenu.targetFavoriteId));
  if (fav) {
    contextMenu.editingFavoriteId = fav.id;
    showEditFavoriteModal(fav, {
      renderFavorites,
      saveTabsState,
      renderTabs: () => uiManager.renderTabs()
    });
  }
});

const menuDeleteFavorite = createMenuItem('お気に入りを削除', UIManager.ICONS.TRASH, async () => {
  if (!contextMenu.targetFavoriteId) return;
  const favIndex = appState.favorites.findIndex(f => f.id === contextMenu.targetFavoriteId);
  if (favIndex > -1) {
    const fav = appState.favorites[favIndex];
    const isConfirmed = await uiManager.showConfirm(`「${fav.name}」をお気に入りから削除しますか？`);
    if (isConfirmed) {
      appState.favorites.splice(favIndex, 1);
      localStorage.setItem('favorites', JSON.stringify(appState.favorites));
      renderFavorites();

      // 現在開いているタブの中から該当パスを探してデフォルトのフォルダ名に戻す
      let tabUpdated = false;
      appState.tabs.forEach(t => {
        if (t.path === fav.path) {
          t.name = getTabNameForPath(t.path);
          tabUpdated = true;
        }
      });
      if (tabUpdated) { saveTabsState(); uiManager.renderTabs(); }

      showNotification(`お気に入りから削除しました`, 'success');
    }
  }
}, true);

const menuOpenInExplorer = createMenuItem('エクスプローラで開く', UIManager.ICONS.FOLDER_OPEN, async () => {
  let path = '';
  if (contextMenu.targetFavoritePath) path = contextMenu.targetFavoritePath;
  else if (contextMenu.targetFolder) path = contextMenu.targetFolder.path;

  if (path && window.veloceAPI.openInExplorer) {
    try {
      await window.veloceAPI.openInExplorer(path);
    } catch (e) {
      showNotification(`開けませんでした: ${e}`, 'error');
    }
  }
});

const menuOpenInNewTab = createMenuItem('新しいタブで開く', UIManager.ICONS.FILE_PLUS, async () => {
  let path = '';
  let name = '';
  if (contextMenu.targetFavoritePath) {
    path = contextMenu.targetFavoritePath;
    const fav = appState.favorites.find(f => f.id === contextMenu.targetFavoriteId);
    name = fav ? fav.name : (path.split('\\').pop() || path);
  } else if (contextMenu.targetFolder) {
    path = contextMenu.targetFolder.path;
    name = contextMenu.targetFolder.name;
  }

  if (path) {
    const newTab = {
      id: Date.now(),
      path: path,
      name: name,
      isNew: true,
      searchQuery: '',
      sortConfig: { key: 'name', asc: true },
      scrollTop: 0,
      history: [path],
      historyIndex: 0
    };
    appState.tabs.push(newTab);
    saveTabsState();

    await window.onTabClick(appState.tabs.length - 1);

    const container = document.getElementById('tab-container');
    if (container) {
      container.scrollLeft = container.scrollWidth;
    }
  }
});

const menuReloadFolder = createMenuItem('フォルダを再読み込み', UIManager.ICONS.RELOAD, async () => {
  if (contextMenu.targetFolderElement && contextMenu.targetFolderElement.reloadFolder) {
    await contextMenu.targetFolderElement.reloadFolder();

    // 現在アクティブなタブで開いているフォルダ（またはその親）なら、メインビューも再読込する
    const currentTab = appState.tabs[appState.activeTabIndex];
    if (currentTab && contextMenu.targetFolder && currentTab.path === contextMenu.targetFolder.path) {
      if (typeof refreshFileList === 'function') {
        await refreshFileList(true);
      } else if (window.veloceAPI && window.veloceAPI.loadDirectory) {
        if (window.veloceAPI.setViewParams) {
          await appState.setViewParams();
        }
        await window.veloceAPI.loadDirectory(currentTab.path);
      }
    }
  } else {
    // 中央ペインの背景などから呼ばれた場合は、現在のフォルダを再読み込みする
    if (typeof refreshFileList === 'function') {
      await refreshFileList(true);
    }
  }
}, false, 'F5');

// --- タブ用メニューの作成 ---
const menuTabClose = createMenuItem('閉じる', UIManager.ICONS.X, () => {
  if (contextMenu.targetTabIndex !== undefined) {
    window.onTabClose(contextMenu.targetTabIndex);
  }
});

const menuTabDuplicate = createMenuItem('タブを複製', UIManager.ICONS.COPY, async () => {
  if (contextMenu.targetTabIndex === undefined) return;

  const sourceIndex = contextMenu.targetTabIndex;
  const sourceTab = appState.tabs[sourceIndex];
  if (!sourceTab) return;

  // 複製時はUIの状態を最新にして引き継ぐ
  if (sourceIndex === appState.activeTabIndex) {
    updateCurrentTabState();
  }

  const newTab = {
    id: Date.now(),
    path: sourceTab.path,
    name: sourceTab.name,
    isNew: true,
    searchQuery: sourceTab.searchQuery || '',
    sortConfig: sourceTab.sortConfig ? JSON.parse(JSON.stringify(sourceTab.sortConfig)) : { key: 'name', asc: true },
    scrollTop: sourceTab.scrollTop || 0,
    history: [...(sourceTab.history || [sourceTab.path])],
    historyIndex: sourceTab.historyIndex !== undefined ? sourceTab.historyIndex : 0
  };

  const insertAtIndex = sourceIndex + 1;
  appState.tabs.splice(insertAtIndex, 0, newTab);

  appState.activeTabIndex = -1; // 切り替えを強制
  await window.onTabClick(insertAtIndex);
});

const menuTabCloseOthers = createMenuItem('他のタブをすべて閉じる', UIManager.ICONS.X_CIRCLE, async () => {
  if (contextMenu.targetTabIndex !== undefined) {
    const targetTab = appState.tabs[contextMenu.targetTabIndex];
    appState.tabs = [targetTab];
    appState.activeTabIndex = -1; // 再読み込みを強制するためリセット
    saveTabsState();
    uiManager.renderTabs();
    await window.onTabClick(0);
  }
});

const menuTabCloseRight = createMenuItem('右側のタブをすべて閉じる', UIManager.ICONS.ARROW_RIGHT_TO_LINE, async () => {
  if (contextMenu.targetTabIndex !== undefined) {
    const targetIndex = contextMenu.targetTabIndex;
    if (targetIndex >= appState.tabs.length - 1) return;

    appState.tabs.splice(targetIndex + 1);

    if (appState.activeTabIndex > targetIndex) {
      appState.activeTabIndex = -1; // 再読み込みを強制
      saveTabsState();
      uiManager.renderTabs();
      await window.onTabClick(targetIndex);
    } else {
      saveTabsState();
      uiManager.renderTabs();
    }
  }
});

const menuTabOpenExplorer = createMenuItem('エクスプローラで開く', UIManager.ICONS.FOLDER_OPEN, async () => {
  if (contextMenu.targetTabIndex !== undefined) {
    const tab = appState.tabs[contextMenu.targetTabIndex];
    if (tab && window.veloceAPI.openInExplorer) {
      try {
        await window.veloceAPI.openInExplorer(tab.path);
      } catch (e) {
        showNotification(`開けませんでした: ${e}`, 'error');
      }
    }
  }
});

const menuTabCopyPath = createMenuItem('パスをコピー', UIManager.ICONS.CLIPBOARD, async () => {
  if (contextMenu.targetTabIndex !== undefined) {
    const tab = appState.tabs[contextMenu.targetTabIndex];
    if (tab) {
      try {
        await navigator.clipboard.writeText(tab.path);
        showNotification('パスをコピーしました', 'success');
      } catch (e) {
        showNotification('コピーに失敗しました', 'error');
      }
    }
  }
});

const menuCopyPath = createMenuItem('パスをコピー', UIManager.ICONS.CLIPBOARD, async () => {
  let textToCopy = null;
  if (contextMenu.targetFolder && contextMenu.targetFolder.path) {
    textToCopy = contextMenu.targetFolder.path;
  }
  if (textToCopy && !textToCopy.startsWith('smart://')) {
    try {
      await navigator.clipboard.writeText(textToCopy);
      showNotification('パスをコピーしました', 'success');
    } catch (e) {
      showNotification('コピーに失敗しました', 'error');
    }
  }
});


const menuTabAddFavorite = createMenuItem('お気に入りに追加', UIManager.ICONS.STAR, () => {
  if (contextMenu.targetTabIndex !== undefined) {
    if (menuTabAddFavorite.disabled) return;
    const tab = appState.tabs[contextMenu.targetTabIndex];
    if (tab) {
      const path = tab.path;
      const name = tab.name;
      if (appState.favorites.find(f => f.path === path)) {
        return;
      }
      appState.favorites.push({ id: Date.now().toString(), name, path, icon: 'star', color: 'default' });
      localStorage.setItem('favorites', JSON.stringify(appState.favorites));
      renderFavorites();

      // タブの名前をお気に入りの名前に更新
      let tabUpdated = false;
      appState.tabs.forEach(t => {
        if (t.path === path) {
          t.name = name;
          tabUpdated = true;
        }
      });
      if (tabUpdated) { saveTabsState(); uiManager.renderTabs(); }

      showNotification(`「${name}」をお気に入りに追加しました`, 'success');
    }
  }
});

// ----------------------------------------------------
// 宣言的コンテキストメニューの定義・登録
// ----------------------------------------------------
contextMenuManager.register('inspector-header', [
  { id: 'open-in-new-tab', element: menuOpenInNewTab },
  { id: 'open-in-explorer', element: menuOpenInExplorer },
  { id: 'copy-path', element: menuCopyPath }
]);

contextMenuManager.register('tab', [
  { id: 'tab-open-explorer', element: menuTabOpenExplorer },
  { id: 'tab-copy-path', element: menuTabCopyPath },
  { type: 'separator' },
  { id: 'tab-duplicate', element: menuTabDuplicate },
  { id: 'tab-close', element: menuTabClose, enabled: (ctx) => ctx.tabsCount > 1 },
  { id: 'tab-close-others', element: menuTabCloseOthers, enabled: (ctx) => ctx.tabsCount > 1 },
  { id: 'tab-close-right', element: menuTabCloseRight, enabled: (ctx) => ctx.index < ctx.tabsCount - 1 },
  { type: 'separator' },
  { id: 'tab-add-favorite', element: menuTabAddFavorite, enabled: (ctx) => !ctx.isFavorite }
]);

contextMenuManager.register('folder-tree', [
  { id: 'open-in-new-tab', element: menuOpenInNewTab },
  { id: 'open-in-explorer', element: menuOpenInExplorer },
  { id: 'copy-path', element: menuCopyPath },
  { id: 'reload-folder', element: menuReloadFolder },
  { id: 'precache-folder', element: menuPrecacheFolder },
  { type: 'separator' },
  { id: 'new-folder', element: menuNewFolder },
  { type: 'separator' },
  { id: 'rename-folder', element: menuRenameFolder, visible: (ctx) => !ctx.isRoot },
  { id: 'delete-folder', element: menuDeleteFolder, visible: (ctx) => !ctx.isRoot },
  { type: 'separator' },
  { id: 'add-favorite', element: menuAddFavorite, visible: (ctx) => !ctx.isRoot }
]);

contextMenuManager.register('thumbnail-item', [
  { id: 'rename-file', element: menuRenameFile, visible: (ctx) => ctx.selectionSize === 1 },
  { id: 'diff-files', element: menuDiffFiles, visible: (ctx) => ctx.selectionSize === 2 },
  { id: 'delete-file', element: menuDeleteFile },
  { type: 'separator' },
  { id: 'rebuild-cache', element: menuRebuildCache },
  { type: 'separator' },
  { id: 'sort-root', element: menuSortRoot, visible: (ctx) => ctx.isGrid, beforeShow: () => updateSortCheckmarks() }
]);

contextMenuManager.register('grid-background', [
  { id: 'reload-folder', element: menuReloadFolder },
  { type: 'separator' },
  { id: 'rebuild-folder-cache', element: menuRebuildFolderCache },
  { type: 'separator' },
  { id: 'sort-root', element: menuSortRoot, beforeShow: () => updateSortCheckmarks() }
]);

contextMenuManager.register('favorite', [
  { id: 'open-in-new-tab', element: menuOpenInNewTab },
  { id: 'open-in-explorer', element: menuOpenInExplorer },
  { id: 'copy-path', element: menuCopyPath },
  { type: 'separator' },
  { id: 'edit-favorite', element: menuEditFavorite },
  { id: 'delete-favorite', element: menuDeleteFavorite }
]);

contextMenuManager.register('smart-folder', [
  { id: 'open-in-new-tab', element: menuOpenInNewTab },
  { type: 'separator' },
  { id: 'edit-smart-folder', element: menuEditSmartFolder },
  { id: 'duplicate-smart-folder', element: menuDuplicateSmartFolder },
  { id: 'delete-smart-folder', element: menuDeleteSmartFolder }
]);

contextMenuManager.register('smart-folder-background', [
  { id: 'add-smart-folder', element: menuAddSmartFolder }
]);

window.onTabContextMenu = (e, index) => {
  e.preventDefault();
  e.stopPropagation();

  const tab = appState.tabs[index];
  contextMenuManager.show('tab', {
    targetTabIndex: index,
    index,
    tab,
    tabsCount: appState.tabs.length,
    isFavorite: tab ? appState.favorites.some(f => f.path === tab.path) : false
  }, e.clientX, e.clientY);
};

const closeAllMenus = (e) => {
  let t = e ? e.target : null;
  // テキストノードがクリックされた場合は親要素を取得
  if (t && t.nodeType === Node.TEXT_NODE) t = t.parentNode;

  if (t && t.closest) {
    // メニュー自身をクリックした場合は閉じない
    if (t.closest('#context-menu') || t.closest('#tab-list-menu') || t.closest('#history-menu') || t.closest('#bookmark-overflow-menu')) return;
    // タブリスト展開ボタンは専用のトグル制御があるため無視
    if (t.closest('#titlebar-tab-list')) return;
    // 履歴ボタンでのクリック時は長押しによるメニュー維持を優先するため除外
    if (e && e.type === 'click' && (t.closest('#nav-back-btn') || t.closest('#nav-forward-btn'))) return;
  }

  // 現在の display 状態を問わず、強制的にすべて非表示にする
  if (typeof contextMenuManager !== 'undefined' && contextMenuManager) {
    contextMenuManager.hide();
  } else if (typeof contextMenu !== 'undefined' && contextMenu) {
    contextMenu.classList.remove('show');
  }
  if (typeof tabListMenu !== 'undefined' && tabListMenu) tabListMenu.classList.remove('show');
  const historyMenu = document.getElementById('history-menu');
  if (historyMenu) historyMenu.classList.remove('show');
  const overflowMenu = document.getElementById('bookmark-overflow-menu');
  if (overflowMenu) overflowMenu.classList.remove('show');

  const tabListBtn = document.getElementById('titlebar-tab-list');
  if (tabListBtn) tabListBtn.classList.remove('open');
  const overflowBtn = document.getElementById('bookmark-overflow-btn');
  if (overflowBtn) overflowBtn.classList.remove('open');
  document.querySelectorAll('.context-menu-item.open').forEach(el => el.classList.remove('open'));
};

// 全てのマウス・タッチ操作の「キャプチャフェーズ（最優先）」で強制実行する
window.addEventListener('pointerdown', closeAllMenus, true);
window.addEventListener('mousedown', closeAllMenus, true);
window.addEventListener('click', closeAllMenus, true);
window.addEventListener('contextmenu', closeAllMenus, true);


initDragTooltip();
initGlobalDndHandlers({
  refreshFileList
});

function handleItemClick(e, isGrid) {
  appState.activeCenterPane = isGrid ? 'grid' : 'table';
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  selectImage(parseInt(item.dataset.index, 10), e);
}

function handleItemDblClick(e, isGrid) {
  appState.activeCenterPane = isGrid ? 'grid' : 'table';
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || item.dataset.index === undefined) return;
  const idx = parseInt(item.dataset.index, 10);
  const filePath = item.dataset.filepath || null;
  if (!isNaN(idx)) {
    selectImage(idx, e);
    openViewer(idx, filePath);
  }
}


function handleItemContextMenu(e, isGrid) {
  appState.activeCenterPane = isGrid ? 'grid' : 'table';
  e.preventDefault();
  e.stopPropagation();

  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');

  if (!item || !item.dataset.index) {
    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();

    contextMenuManager.show('grid-background', { isGrid }, e.clientX, e.clientY);
    return;
  }

  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) selectImage(index);

  contextMenuManager.show('thumbnail-item', {
    selectionSize: appState.selection.size,
    isGrid
  }, e.clientX, e.clientY);
}

uiManager.elements.thumbnailGrid.addEventListener('click', (e) => handleItemClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dblclick', (e) => handleItemDblClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dragstart', (e) => handleItemDragStart(e, true));
uiManager.elements.thumbnailGrid.addEventListener('contextmenu', (e) => handleItemContextMenu(e, true));

// サムネイル上のファイル名の箇所に来たときだけカスタムツールチップを表示
let currentHoveredLabel = null;
uiManager.elements.thumbnailGrid.addEventListener('mouseover', (e) => {
  const label = e.target.closest('.thumbnail-label');
  if (!label) {
    if (currentHoveredLabel) {
      uiManager.hideCustomTooltip();
      currentHoveredLabel = null;
    }
    return;
  }
  if (label !== currentHoveredLabel) {
    currentHoveredLabel = label;
    const name = label.textContent;
    if (name) {
      uiManager.showCustomTooltip(name, e.clientX, e.clientY);
    } else {
      uiManager.hideCustomTooltip();
    }
  }
});
uiManager.elements.thumbnailGrid.addEventListener('mousemove', (e) => {
  const label = e.target.closest('.thumbnail-label');
  if (!label) {
    if (currentHoveredLabel) {
      uiManager.hideCustomTooltip();
      currentHoveredLabel = null;
    }
    return;
  }
  const name = label.textContent;
  if (name) {
    uiManager.showCustomTooltip(name, e.clientX, e.clientY);
  }
});
uiManager.elements.thumbnailGrid.addEventListener('mouseleave', () => {
  if (currentHoveredLabel) {
    uiManager.hideCustomTooltip();
    currentHoveredLabel = null;
  }
});
uiManager.elements.thumbnailGrid.addEventListener('mousedown', () => {
  if (currentHoveredLabel) {
    uiManager.hideCustomTooltip();
    currentHoveredLabel = null;
  }
});

uiManager.elements.fileListBody.addEventListener('click', (e) => handleItemClick(e, false));
uiManager.elements.fileListBody.addEventListener('dblclick', (e) => handleItemDblClick(e, false));
uiManager.elements.fileListBody.addEventListener('dragstart', (e) => handleItemDragStart(e, false));
uiManager.elements.fileListBody.addEventListener('contextmenu', (e) => handleItemContextMenu(e, false));

// ファイル一覧テーブルのカスタムツールチップ表示
let currentHoveredListRow = null;
uiManager.elements.fileListBody.addEventListener('mouseover', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) {
    if (currentHoveredListRow) {
      uiManager.hideCustomTooltip();
      currentHoveredListRow = null;
    }
    return;
  }
  const firstTd = tr.children[0];
  if (firstTd && (e.target === firstTd || firstTd.contains(e.target))) {
    const name = firstTd.textContent;
    if (name && name !== currentHoveredListRow) {
      currentHoveredListRow = name;
      uiManager.showCustomTooltip(name, e.clientX, e.clientY);
    }
  } else if (currentHoveredListRow) {
    uiManager.hideCustomTooltip();
    currentHoveredListRow = null;
  }
});
uiManager.elements.fileListBody.addEventListener('mousemove', (e) => {
  if (currentHoveredListRow) {
    uiManager.showCustomTooltip(currentHoveredListRow, e.clientX, e.clientY);
  }
});
uiManager.elements.fileListBody.addEventListener('mouseleave', () => {
  if (currentHoveredListRow) {
    uiManager.hideCustomTooltip();
    currentHoveredListRow = null;
  }
});
uiManager.elements.fileListBody.addEventListener('mousedown', () => {
  if (currentHoveredListRow) {
    uiManager.hideCustomTooltip();
    currentHoveredListRow = null;
  }
});

// ============================================================================
// Directory Tree Event Delegation
// ============================================================================
document.getElementById('left-pane')?.addEventListener('mousedown', () => {
  const dirSection = document.getElementById('directories-section');
  if (dirSection) dirSection.focus();
});
document.getElementById('center-top')?.addEventListener('mousedown', () => {
  appState.activeCenterPane = 'table';
});
document.getElementById('center-bottom')?.addEventListener('mousedown', () => {
  appState.activeCenterPane = 'grid';
});

uiManager.elements.dirTree.addEventListener('click', async (e) => {
  const toggleIcon = e.target.closest('.toggle-icon');
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;

  const childrenUl = itemDiv.nextElementSibling;
  const isExpanded = childrenUl && childrenUl.classList.contains('expanded');

  // トグルアイコンがクリックされた場合
  if (toggleIcon) {
    e.stopPropagation();
    if (isExpanded) {
      if (itemDiv.collapseNode) itemDiv.collapseNode();
    } else {
      if (itemDiv.expandNode) await itemDiv.expandNode();
    }
    return;
  }

  // フォルダ本体がクリックされた場合
  e.stopPropagation();
  appState.selection.clear();
  appState.selectedIndex = -1;
  uiManager.updateSelectionUI();

  const path = itemDiv.dataset.path;
  if (window.veloceAPI.loadDirectory) {
    if (window.veloceAPI.setViewParams) {
      await appState.setViewParams();
    }
    // アクティブなタブの内容を更新する
    const activeTab = appState.tabs[appState.activeTabIndex];
    if (activeTab) {
      activeTab.path = path;
      activeTab.name = getTabNameForPath(path);
      activeTab.scrollTop = 0;
      appState.currentDirectory = path;
      localStorage.setItem('currentDirectory', path);
      uiManager.renderTabs();
      saveTabsState();

      // 古い applyNewFileList ではなく、refreshFileList を呼んで非同期ロードを開始する
      refreshFileList(true);
      await expandTreeToPath(path);
    }
  }

  if (!isExpanded) {
    if (itemDiv.expandNode) await itemDiv.expandNode();
  }

  const activeItem = document.querySelector('#dir-tree .tree-item.selected');
  if (activeItem) activeItem.classList.remove('selected');
  itemDiv.classList.add('selected');
});

uiManager.elements.dirTree.addEventListener('contextmenu', (e) => {
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;

  e.preventDefault();
  e.stopPropagation();

  const activeItem = document.querySelector('#dir-tree .tree-item.selected');
  if (activeItem) activeItem.classList.remove('selected');
  itemDiv.classList.add('selected');

  const isRoot = itemDiv.dataset.isRoot === 'true';

  contextMenuManager.show('folder-tree', {
    targetFolder: {
      path: itemDiv.dataset.path,
      name: itemDiv.dataset.name
    },
    targetFolderElement: itemDiv,
    isRoot
  }, e.clientX, e.clientY);
});

initDirTreeDnd(uiManager.elements.dirTree, {
  refreshFileList,
  showNotification
});

function setupResizer(resizer, type, cursor) {
  if (!resizer) return;
  resizer.addEventListener('mousedown', () => {
    resizingState[type] = true;
    resizer.classList.add('resizing');
    document.body.style.cursor = cursor;
    document.body.classList.add('is-resizing'); // ドラッグ中フラグを追加
  });
  createResizerToggle(resizer, type);
}

function createResizerToggle(resizer, type) {
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
        // 閉じる前の高さを復元（なければデフォルト250px）
        const restoreHeight = localStorage.getItem('prevTopHeight') || '250px';
        root.style.setProperty('--top-height', restoreHeight);
        root.removeAttribute('data-center-collapsed');
        localStorage.setItem('topHeight', restoreHeight);
        btn.classList.remove('expanded');
      } else {
        // 閉じる直前の高さを prevTopHeight として退避させてから 0px にする
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

setupResizer(uiManager.elements.resizerLeft, 'left', 'col-resize');
setupResizer(uiManager.elements.resizerRight, 'right', 'col-resize');
setupResizer(uiManager.elements.resizerCenter, 'center', 'row-resize');
setupResizer(document.getElementById('resizer-left-pane'), 'leftTop', 'row-resize');
setupResizer(document.getElementById('resizer-right-pane'), 'rightTop', 'row-resize');

let resizerRafId = null;
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
      const rect = centerPane.getBoundingClientRect();
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
      const rect = leftPane.getBoundingClientRect();
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
      const rect = rightPane.getBoundingClientRect();
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
  document.body.classList.remove('is-resizing'); // ドラッグ中フラグを解除
});

function updateThumbnailSize() {
  const slider = uiManager.elements.thumbnailSizeSlider;
  const size = parseFloat(slider.value) || 120;
  document.body.style.setProperty('--thumbnail-size', `${size}px`);

  const tooltip = document.getElementById('thumbnail-slider-tooltip');
  if (tooltip && slider) {
    const min = parseFloat(slider.min) || 100;
    const max = parseFloat(slider.max) || 500;
    const percent = (size - min) / (max - min);
    const thumbWidth = 12;
    // thumb is offset by percent across the track width
    const offset = percent * (slider.offsetWidth - thumbWidth) + (thumbWidth / 2);
    tooltip.textContent = `${Math.round(size)}px`;
    tooltip.style.left = `${offset}px`;
  }
}

uiManager.elements.thumbnailSizeSlider.addEventListener('input', () => {
  updateThumbnailSize();
  if (typeof uiManager.updateVirtualGrid === 'function') uiManager.updateVirtualGrid(true);
});

uiManager.elements.thumbnailSizeSlider.addEventListener('change', (e) => {
  localStorage.setItem('thumbnailScale', e.target.value);
});

// リサイズイベント発生時にディレイなしで枠線の表示・非表示を切り替える
window.addEventListener('resize', () => {
  if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      const borderOverlay = document.getElementById('border-overlay');
      if (borderOverlay) {
        borderOverlay.style.display = isMax ? 'none' : 'block';
      }
      const maxBtn = document.getElementById('titlebar-maximize');
      if (maxBtn) {
        maxBtn.innerHTML = isMax ? UIManager.ICONS.WINDOW_RESTORE : UIManager.ICONS.WINDOW_MAXIMIZE;
      }
    });
  }
});

window.addEventListener('resize', debounce(() => {
  if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      localStorage.setItem('mainWinMaximized', isMax);
      if (!isMax) {
        localStorage.setItem('mainWinWidth', Math.max(800, window.outerWidth));
        localStorage.setItem('mainWinHeight', Math.max(600, window.outerHeight));
        localStorage.setItem('mainWinX', window.screenX);
        localStorage.setItem('mainWinY', window.screenY);
      }
    });
  }
  uiManager.updateTabScrollState();
}, 500));

window.addEventListener('beforeunload', () => {
  if (localStorage.getItem('mainWinMaximized') !== 'true') {
    localStorage.setItem('mainWinX', window.screenX);
    localStorage.setItem('mainWinY', window.screenY);
  }
  saveTabsState(); // アプリ終了時にも状態を保存する
});

document.querySelectorAll('th').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (appState.sortConfig.key === key) {
      appState.sortConfig.asc = !appState.sortConfig.asc;
    } else {
      appState.sortConfig.key = key;
      appState.sortConfig.asc = true;
    }
    localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
    updateSortIndicators();
    scheduleRefresh();
  });
});

/**
 * アプリケーション全体のグローバルキーボードショートカットハンドラー
 * 入力フォームフォーカス時の除外判定、モーダル/ダイアログのEscape優先制御、
 * タブ切り替え、ファイル操作、レーティング、およびグリッド内カーソル移動を統括ルーティングする
 * @param {KeyboardEvent} e - キーイベントオブジェクト
 */
export const globalKeydownHandler = async (e) => {
  // フォールバック用の合成イベント再帰を防止
  if (e._isAggressiveFallback) return;

  const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';

  // 1. ナビゲーション履歴の進む / 戻る (Alt + ArrowLeft / ArrowRight)
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateHistory(-1);
    return;
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    navigateHistory(1);
    return;
  }

  // 2. タブ切り替えショートカット (Ctrl + Tab / PageDown / PageUp)
  // 入力欄フォーカス時でもタブ切り替えを妨げないため、入力欄チェックの前に評価
  if (e.ctrlKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    if (appState.tabs.length > 1) {
      let nextIndex = appState.activeTabIndex;
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'PageDown') {
        nextIndex = (appState.activeTabIndex + 1) % appState.tabs.length;
      } else if ((e.key === 'Tab' && e.shiftKey) || e.key === 'PageUp') {
        nextIndex = (appState.activeTabIndex - 1 + appState.tabs.length) % appState.tabs.length;
      }

      if (nextIndex !== appState.activeTabIndex) {
        await window.onTabClick(nextIndex);
        const container = document.getElementById('tab-container');
        if (container) {
          const tabEls = container.querySelectorAll('.tab-item:not(.new-tab-btn)');
          if (tabEls[nextIndex]) {
            scrollTabIntoView(tabEls[nextIndex]);
          }
        }
      }
    }
    return;
  }

  // 3. テキスト入力欄フォーカス時は、Escape以外の一般ショートカットを無視
  if ((activeTagName === 'input' || activeTagName === 'textarea') && e.key !== 'Escape') {
    return;
  }

  // 4. ヘルプオーバーレイのトグル (F1 または H)
  if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
    e.preventDefault();
    toggleHelpOverlay();
    return;
  }

  // 5. レーティング設定 (0 〜 5)
  // 単一または複数選択されたアイテムに対してトグル/更新を適用
  if (['0', '1', '2', '3', '4', '5'].includes(e.key) && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    let targetIndices = [];
    if (appState.selection.size > 0) {
      targetIndices = Array.from(appState.selection);
    } else if (appState.selectedIndex !== -1) {
      targetIndices = [appState.selectedIndex];
    }

    if (targetIndices.length > 0) {
      e.preventDefault();
      const rating = parseInt(e.key, 10);

      // 並列でファイル情報を取得
      const files = (await Promise.all(
        targetIndices.map(idx => window.veloceAPI.getFileByIndex(idx))
      )).filter(Boolean);

      if (files.length > 0) {
        const allHaveSameRating = files.every(f => (appState.ratings[f.path] || 0) === rating);
        const newRating = allHaveSameRating ? 0 : rating;

        // 1. IPC待機を待たずにUI側で即座に星表示アニメーションを更新（楽観的UI更新）
        for (const file of files) {
          applyRatingUI(file.path, newRating, true);
        }

        // 2. バックエンドへ並列非同期で永続化保存
        if (window.veloceAPI.setRating) {
          await Promise.all(files.map(file => window.veloceAPI.setRating(file.path, newRating)));
        }
      }
      return;
    }
  }

  if (e.key === 'Escape' || e.keyCode === 27) {
    // 汎用ダイアログ（プロンプトや確認等）の強制クローズ処理
    const dialogOverlays = document.querySelectorAll('.dialog-overlay.show');
    if (dialogOverlays.length > 0) {
      e.preventDefault();
      dialogOverlays.forEach(overlay => {
        overlay.classList.remove('show');
        // 要素自体の削除は呼び出し元の cleanup に任せるが、静的モーダル以外は非表示化を保証する
        if (overlay.id !== 'edit-favorite-modal' && overlay.id !== 'edit-smart-folder-modal') {
          overlay.style.display = 'none';
        } else {
          overlay.style.display = '';
        }
        
        // Escapeキーのイベントをディスパッチして、元のハンドラ（Promiseの解決など）をトリガーする
        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        // このイベントは既に処理済みとするためのフラグ
        escEvent._isAggressiveFallback = true;
        
        // もし入力フィールドがあればそこに、なければオーバーレイ自身にイベントを送る
        const input = overlay.querySelector('input');
        if (input) {
          input.dispatchEvent(escEvent);
        } else {
          overlay.dispatchEvent(escEvent);
        }
      });
      return;
    }

    if (handleModalEscapeKey(e)) {
      return;
    }
    if (document.getElementById('help-overlay')) {
      e.preventDefault();
      toggleHelpOverlay(false);
      return;
    }
    const historyMenu = document.getElementById('history-menu');
    const overflowMenu = document.getElementById('bookmark-overflow-menu');
    if (contextMenu.classList.contains('show') || tabListMenu.classList.contains('show') || (historyMenu && historyMenu.classList.contains('show')) || (overflowMenu && overflowMenu.classList.contains('show'))) {
      e.preventDefault();
      contextMenu.classList.remove('show');
      tabListMenu.classList.remove('show');
      if (historyMenu) historyMenu.classList.remove('show');
      if (overflowMenu) overflowMenu.classList.remove('show');
      const overflowBtn = document.getElementById('bookmark-overflow-btn');
      if (overflowBtn) overflowBtn.classList.remove('open');
      const tabListBtn = document.getElementById('titlebar-tab-list');
      if (tabListBtn) tabListBtn.classList.remove('open');
      return;
    }
  }

  if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey) {
    e.preventDefault();
    if (window.veloceAPI.arrangeViewers) {
      window.veloceAPI.arrangeViewers();
    }
  }

  if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey) {
    e.preventDefault();
    if (appState.selection.size === 2) {
      const indices = Array.from(appState.selection);
      const file1 = await window.veloceAPI.getFileByIndex(indices[0]);
      const file2 = await window.veloceAPI.getFileByIndex(indices[1]);

      // 完全なメタデータを取得してからDiffモーダルを開く
      uiManager.showToast('比較データを読み込み中', 0, 'diff-loading', 'info');
      Promise.all([
        window.veloceAPI.parseMetadata(file1.path),
        window.veloceAPI.parseMetadata(file2.path)
      ]).then(([meta1, meta2]) => {
        const t = document.getElementById('toast-diff-loading');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
        uiManager.showDiffModal(file1, file2, meta1, meta2);
      });
    } else {
      uiManager.showToast('Diff機能を使用するには、Ctrlキーを押しながら画像を2つ選択してください。', 3000, null, 'warning');
    }
  }

  if (e.key === 'F5') {
    e.preventDefault();
    await refreshFileList();
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    performUndo();
  }

  if (e.key === 'F2') {
    e.preventDefault();
    if (appState.selection.size > 0) {
      renameSelectedFile();
    } else {
      const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
      if (selectedFolder) {
        renameSelectedFolder();
      }
    }
  }

  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (appState.selectedIndex > -1) {
      let targetPath = null;
      const selItem = document.querySelector('.thumbnail-item.selected, tr.selected');
      if (selItem && selItem.dataset && selItem.dataset.filepath) {
        targetPath = selItem.dataset.filepath;
      }
      openViewer(appState.selectedIndex, targetPath);
    }
  }

  if (e.key === 'Delete') {
    if (appState.selection.size > 0) {
      deleteSelectedFiles();
    } else {
      const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
      if (selectedFolder) {
        deleteSelectedFolder();
      }
    }
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    if (window.getSelection().toString()) {
      showNotification('テキストをクリップボードにコピーしました', 'success');
      return;
    }

    if (appState.selectedIndex > -1) {
      const idx = appState.selectedIndex;
      window.veloceAPI.getFileByIndex(idx).then(file => {
        if (file) {
          window.veloceAPI.copyImageToClipboard(file.path);
          showNotification('画像をクリップボードにコピーしました', 'success');

          // 対象要素（サムネイルまたはリスト行）の領域にシャッターフラッシュエフェクトを適用
          const applyFlash = (el) => {
            if (!el) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            // スクロールコンテナ等のクリッピング領域を取得して、可視範囲のみにフラッシュを制限する
            const container = el.closest('#center-top, #center-bottom');
            let top = rect.top;
            let left = rect.left;
            let width = rect.width;
            let height = rect.height;

            if (container) {
              const containerRect = container.getBoundingClientRect();
              top = Math.max(rect.top, containerRect.top);
              left = Math.max(rect.left, containerRect.left);
              const bottom = Math.min(rect.bottom, containerRect.bottom);
              const right = Math.min(rect.right, containerRect.right);
              width = right - left;
              height = bottom - top;
            }

            // 要素がコンテナの可視範囲外（完全に隠れている）場合はエフェクトを表示しない
            if (width <= 0 || height <= 0) return;

            const flash = document.createElement('div');
            flash.className = 'thumbnail-flash-effect';
            flash.style.top = top + 'px';
            flash.style.left = left + 'px';
            flash.style.width = width + 'px';
            flash.style.height = height + 'px';
            document.body.appendChild(flash);

            const animation = flash.animate([
              { opacity: 1 },
              { opacity: 0 }
            ], {
              duration: 600,
              easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
            });

            animation.onfinish = () => {
              if (flash.parentNode) flash.remove();
            };
          };

          // 現在の表示モードに応じた要素にエフェクトを適用
          if (file && uiManager._domByPath) {
            const domItem = uiManager._domByPath.get(file.path);
            if (domItem) applyFlash(domItem);
          }
        }
      });
    }
  }

  if (e.ctrlKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
    e.preventDefault();
    if (uiManager.elements.searchBar) {
      uiManager.elements.searchBar.focus();
      uiManager.elements.searchBar.select();
    }
    return;
  }

  if (e.ctrlKey && (e.key.toLowerCase() === 'a' || e.code === 'KeyA')) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    e.preventDefault();
    if (appState.totalCount === 0) return;

    appState.selection.clear();
    for (let i = 0; i < appState.totalCount; i++) {
      appState.selection.add(i);
    }
    appState.selectedIndex = appState.totalCount - 1;

    uiManager.updateSelectionUI();
    return;
  }

  // 6. カーソル移動・選択ナビゲーション (矢印キー, PageUp/Down, Home, End)
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
    // 左ペインのフォルダツリーがアクティブな場合はツリー内ナビゲーションへ委譲
    const isLeftPaneFocused = document.activeElement && document.activeElement.closest('#left-pane');
    if (isLeftPaneFocused) {
      e.preventDefault();
      handleTreeNavigation(e.key);
      return;
    }

    if (appState.totalCount === 0) return;

    e.preventDefault();

    let newIndex = appState.selectedIndex;

    if (newIndex === -1) {
      newIndex = 0;
    } else {
      const isTableFocused = (document.activeElement && document.activeElement.closest('#center-top')) ||
                             (appState.activeCenterPane === 'table');

      if (isTableFocused) {
        // ファイル一覧テーブルでのナビゲーション: 上下キー・左右キーで1行ずつ移動
        const listContainer = document.getElementById('center-top');
        const visibleRows = listContainer ? Math.max(1, Math.floor(listContainer.clientHeight / 28)) : 10;

        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          newIndex = Math.max(0, appState.selectedIndex - 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          newIndex = Math.min(appState.totalCount - 1, appState.selectedIndex + 1);
        } else if (e.key === 'PageUp') {
          newIndex = Math.max(0, appState.selectedIndex - visibleRows);
        } else if (e.key === 'PageDown') {
          newIndex = Math.min(appState.totalCount - 1, appState.selectedIndex + visibleRows);
        } else if (e.key === 'Home') {
          newIndex = 0;
        } else if (e.key === 'End') {
          newIndex = appState.totalCount - 1;
        }
      } else {
        // サムネイルグリッドでのナビゲーション: 列数に応じた2次元グリッド移動
        const containerWidth = uiManager.elements.thumbnailGrid.clientWidth;
        const itemSize = parseFloat(uiManager.elements.thumbnailSizeSlider.value) || 120;
        const gap = CONFIG.GRID_GAP;
        const padding = CONFIG.GRID_PADDING;
        const availableWidth = Math.max(1, containerWidth - padding * 2);
        const columns = Math.max(1, Math.floor((availableWidth + gap) / (itemSize + gap)));

        if (e.key === 'ArrowLeft') newIndex = Math.max(0, appState.selectedIndex - 1);
        else if (e.key === 'ArrowRight') newIndex = Math.min(appState.totalCount - 1, appState.selectedIndex + 1);
        else if (e.key === 'ArrowUp') newIndex = Math.max(0, appState.selectedIndex - columns);
        else if (e.key === 'ArrowDown') newIndex = Math.min(appState.totalCount - 1, appState.selectedIndex + columns);
        else if (e.key === 'PageUp') {
          const rows = Math.max(1, Math.floor(uiManager.elements.thumbnailGrid.clientHeight / (itemSize + gap)));
          newIndex = Math.max(0, appState.selectedIndex - (columns * rows));
        }
        else if (e.key === 'PageDown') {
          const rows = Math.max(1, Math.floor(uiManager.elements.thumbnailGrid.clientHeight / (itemSize + gap)));
          newIndex = Math.min(appState.totalCount - 1, appState.selectedIndex + (columns * rows));
        }
        else if (e.key === 'Home') newIndex = 0;
        else if (e.key === 'End') newIndex = appState.totalCount - 1;
      }
    }

    if (newIndex !== appState.selectedIndex) {
      if (e.shiftKey) {
        selectImage(newIndex, { shiftKey: true });
      } else {
        selectImage(newIndex);
      }
    }
  }
};
window.addEventListener('keydown', globalKeydownHandler);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (typeof closeAllMenus === 'function') closeAllMenus(e);
});

async function handleTreeNavigation(key) {
  const getVisibleTreeItems = (root) => {
    let items = [];
    const walk = (ul) => {
      for (const li of ul.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const item = li.firstElementChild; // .tree-item is the first child
        if (item && item.classList.contains('tree-item')) items.push(item);
        const childrenUl = li.children[1]; // .tree-children is the second child
        if (childrenUl && childrenUl.classList.contains('tree-children') && childrenUl.classList.contains('expanded')) {
          walk(childrenUl);
        }
      }
    };
    for (const ul of root.children) {
       if (ul.tagName.toLowerCase() === 'ul') walk(ul);
    }
    return items;
  };

  const rootEl = document.getElementById('dir-tree');
  if (!rootEl) return;
  const visibleItems = getVisibleTreeItems(rootEl);
  if (visibleItems.length === 0) return;

  const currentSelected = document.querySelector('#dir-tree .tree-item.selected');
  let currentIndex = currentSelected ? visibleItems.indexOf(currentSelected) : -1;

  if (currentIndex === -1) {
    const currentItem = document.querySelector(`#dir-tree .tree-item[data-path="${CSS.escape(appState.currentDirectory)}"]`);
    if (currentItem) currentIndex = visibleItems.indexOf(currentItem);
    if (currentIndex === -1) currentIndex = 0;
  }

  const currentItem = visibleItems[currentIndex];
  const childrenUl = currentItem.nextElementSibling;
  const isExpanded = childrenUl && childrenUl.classList.contains('expanded');
  const toggleIcon = currentItem.querySelector('.tree-toggle');
  const hasChildren = toggleIcon && toggleIcon.style.visibility !== 'hidden';

  const selectItem = async (item, autoExpand = false) => {
    if (item) {
      scrollTreeItemIntoView(item, 'nearest');
    }

    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();

    const path = item.dataset.path;
    if (window.veloceAPI.loadDirectory) {
      if (window.veloceAPI.setViewParams) {
        await appState.setViewParams();
      }
      const activeTab = appState.tabs[appState.activeTabIndex];
      if (activeTab && activeTab.path !== path) {
        activeTab.path = path;
        activeTab.name = typeof getTabNameForPath === 'function' ? getTabNameForPath(path) : path.split(/[\\/]/).pop();
        activeTab.scrollTop = 0;
        appState.currentDirectory = path;
        localStorage.setItem('currentDirectory', path);
        uiManager.renderTabs();
        if (typeof saveTabsState === 'function') saveTabsState();
        refreshFileList(true);
      }
    }

    if (autoExpand && !isExpanded) {
      if (item.expandNode) await item.expandNode();
    }

    const activeItem = document.querySelector('#dir-tree .tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    item.classList.add('selected');
  };

  if (key === 'ArrowUp') {
    if (currentIndex > 0) await selectItem(visibleItems[currentIndex - 1]);
  } else if (key === 'ArrowDown') {
    if (currentIndex < visibleItems.length - 1) await selectItem(visibleItems[currentIndex + 1]);
  } else if (key === 'ArrowLeft') {
    if (isExpanded) {
      if (currentItem.collapseNode) currentItem.collapseNode();
    } else {
      const parentUl = currentItem.closest('ul.tree-children');
      if (parentUl && parentUl.previousElementSibling && parentUl.previousElementSibling.classList.contains('tree-item')) {
        await selectItem(parentUl.previousElementSibling);
      }
    }
  } else if (key === 'ArrowRight') {
    if (isExpanded) {
      if (currentIndex < visibleItems.length - 1) await selectItem(visibleItems[currentIndex + 1]);
    } else {
      if (hasChildren && currentItem.expandNode) await currentItem.expandNode();
    }
  }
}

// ============================================================================
// 5. Application Initialization
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  // ウィンドウ全体の不正なスクロールを絶対防止するガード
  const resetWindowScroll = () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    if (document.documentElement.scrollTop !== 0 || document.documentElement.scrollLeft !== 0) {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
    if (document.body.scrollTop !== 0 || document.body.scrollLeft !== 0) {
      document.body.scrollTop = 0;
      document.body.scrollLeft = 0;
    }
  };
  resetWindowScroll();
  window.addEventListener('scroll', resetWindowScroll, { passive: false });

  try {
    if (window.veloceAPI && window.veloceAPI.getVideoServerPort) {
      window.videoServerPort = await window.veloceAPI.getVideoServerPort();
    }
  } catch (e) {
    console.warn("Failed to get video server port", e);
  }
  window.__TAURI__.event.listen('precache-progress', (event) => {
    const [current, total] = event.payload;
    showNotification(`${current} / ${total} 件のキャッシュを作成中...`, 'info', 1000, 'precache');
  });

  initTabHandlers({
    appState,
    uiManager,
    expandTreeToPath,
    clearMetadataUI,
    updateNavButtons,
    updateSortIndicators
  });

  const bar = document.getElementById('bookmark-list');
  if (bar) bookmarkResizeObserver.observe(bar);

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
      bookmarkOverflowMenu.innerHTML = '';

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

          if (window.veloceAPI.loadDirectory) {
            if (window.veloceAPI.setViewParams) {
              await appState.setViewParams();
            }
            const activeTab = appState.tabs[appState.activeTabIndex];
            if (activeTab) {
              activeTab.path = fav.path;
              activeTab.name = fav.name;
              activeTab.scrollTop = 0;
              appState.currentDirectory = fav.path;
              localStorage.setItem('currentDirectory', appState.currentDirectory);
              if (window.uiManager) window.uiManager.renderTabs();

              if (typeof saveTabsState === 'function') saveTabsState();
              if (typeof refreshFileList === 'function') refreshFileList(true);
              if (typeof expandTreeToPath === 'function') await expandTreeToPath(fav.path);
            }
          }
        });

        const iconSpan = menuItem.querySelector('svg, div');
        if (iconSpan && iconSpan.tagName.toLowerCase() === 'svg') {
          if (fav.icon && fav.icon.startsWith('FAV_')) {
            iconSpan.style.color = 'var(--glow-gold)';
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

  renderFavorites();

  const setupNavButtonEvents = (btnId, direction, tooltipText) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    let pressTimer;
    let isLongPressed = false;

    btn.removeAttribute('title');
    btn.addEventListener('mouseenter', (e) => {
      if (!btn.disabled) uiManager.showCustomTooltip(tooltipText, e.clientX, e.clientY);
    });
    btn.addEventListener('mousemove', (e) => {
      if (!btn.disabled) uiManager.showCustomTooltip(tooltipText, e.clientX, e.clientY);
    });
    btn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
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
  };

  setupNavButtonEvents('nav-back-btn', -1, '戻る');
  setupNavButtonEvents('nav-forward-btn', 1, '進む');

  const reloadBtn = document.getElementById('nav-reload-btn');
  if (reloadBtn) {
    reloadBtn.innerHTML = UIManager.ICONS.RELOAD;
    reloadBtn.removeAttribute('title');
    reloadBtn.addEventListener('mouseenter', (e) => {
      uiManager.showCustomTooltip('再読み込み', e.clientX, e.clientY);
    });
    reloadBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip('再読み込み', e.clientX, e.clientY);
    });
    reloadBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    reloadBtn.addEventListener('click', async () => {
      uiManager.hideCustomTooltip();
      reloadBtn.classList.remove('refreshing');
      void reloadBtn.offsetWidth;
      reloadBtn.classList.add('refreshing');
      setTimeout(() => reloadBtn.classList.remove('refreshing'), 600);
      await refreshFileList(true);
    });
  }

  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) navigateHistory(-1);
    if (e.button === 4) navigateHistory(1);
  });

  if (window.veloceAPI.onMetadataBatchUpdated) {
    window.veloceAPI.onMetadataBatchUpdated((payload) => {
      appState.metadataTargetCount = payload.total;
      appState.metadataCompleted = payload.processed;
      updateMetadataToast();
      if (payload.processed >= payload.total) {
        if (['width', 'height', 'ratio'].includes(appState.sortConfig.key) || appState.searchQuery.trim() !== '') {
          scheduleRefresh();
        } else {
          if (typeof uiManager.updateVirtualList === 'function') {
            uiManager.updateVirtualList(true);
          }
          if (appState.selection.size > 0) {
            const idx = Array.from(appState.selection)[0];
            window.veloceAPI.getFileByIndex(idx).then(file => {
              if (file) renderMetadata(file);
            });
          }
        }
      }
    });
  }

  if (window.veloceAPI.onSmartFolderPurged) {
    window.veloceAPI.onSmartFolderPurged(() => {
      if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
        window.debouncedUpdateSmartFolderCounts();
      }
    });
  }

  if (window.veloceAPI.onDirectoryLoaded) {
    window.veloceAPI.onDirectoryLoaded(async (payload) => {
      if (payload.path !== appState.currentDirectory) return;
      appState.totalCount = payload.totalCount;
      if (payload.initialChunk) {
        appState.initialChunk = payload.initialChunk;
      }
      if (payload.path.startsWith("smart://")) {
        appState.thumbnailTotalRequested = 0;
      } else {
        appState.thumbnailTotalRequested = appState.totalCount;
      }
      appState.thumbnailCompleted = 0;
      appState.thumbnailCounted.clear();
      
      // ソート順変更時などにもキューと現在実行中のタスクをリセットし、
      // 画面に新たに表示されたアイテムが即座に生成枠を獲得できるようにする
      if (window.thumbnailManager) window.thumbnailManager.clear();
      
      // ディレクトリ読み込み完了時はRust側ですでにソート・フィルタが適用され
      // initialChunk (最大100件) が同梱されているため、100msのdebounce待機や
      // 冗長な setViewParams（全件再ソート）を行わず、即座に画面へ同期的描画を開始する
      appState.preloadCursor = 0;
      uiManager.renderAll();
      uiManager.updateSelectionUI();
      if (appState.selectedIndex === -1) {
        clearMetadataUI();
      } else if (appState.selection.size > 1) {
        renderMultipleSelectionSummary();
      } else {
        window.veloceAPI.getFileByIndex(appState.selectedIndex).then(file => {
          if (file) renderMetadata(file);
        });
      }
      
      setTimeout(() => {
        const t = document.getElementById('toast-dir-load-progress');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
      }, 100);
    });
  }

  const minBtn = document.getElementById('titlebar-minimize');
  const maxBtn = document.getElementById('titlebar-maximize');
  const closeBtn = document.getElementById('titlebar-close');
  const tabListBtn = document.getElementById('titlebar-tab-list');
  const tabContainer = document.getElementById('tab-container');
  const newTabBtn = document.getElementById('new-tab-btn');

  const titlebar = document.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-item') || e.target.closest('.titlebar-button') || e.target.closest('#new-tab-btn')) return;
      if (e.button === 0) {
        if (e.detail === 2) { // 2回連続クリックされた場合（ダブルクリック）
          if (window.veloceAPI && window.veloceAPI.maximizeViewer) window.veloceAPI.maximizeViewer();
        } else if (e.detail === 1) { // 1回目のクリックの場合（ドラッグ開始）
          if (window.veloceAPI && window.veloceAPI.startViewerDragging) window.veloceAPI.startViewerDragging();
        }
      }
    });
  }

  if (tabContainer) {
    tabContainer.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        tabContainer.scrollLeft += e.deltaY;
      }
    });
    tabContainer.addEventListener('scroll', () => {
      uiManager.updateTabScrollState();
    });

    // --- イベント委譲(Event Delegation)によるタブ追加ボタンの制御 ---
    // renderTabsによってボタンが再生成されてもイベントが失われないように、親要素でイベントを捕捉する
    tabContainer.addEventListener('click', (e) => {
      if (e.target.closest('#new-tab-btn')) {
        uiManager.hideCustomTooltip();
        if (window.onNewTabClick) window.onNewTabClick();
      }
    });

    tabContainer.addEventListener('mouseover', (e) => {
      if (e.target.closest('#new-tab-btn')) {
        uiManager.showCustomTooltip('新しいタブを開く', e.clientX, e.clientY);
      }
    });

    tabContainer.addEventListener('mouseout', (e) => {
      if (e.target.closest('#new-tab-btn')) {
        uiManager.hideCustomTooltip();
      }
    });
  }

  const updateTabListMenu = () => {
    tabListMenu.innerHTML = '';
    appState.tabs.forEach((tab, index) => {
      const option = document.createElement('div');
      // 右クリックメニューと同じベースクラスを適用し、CSS側にデザインを委ねる
      option.className = 'context-menu-item tab-list-item';

      // 現在アクティブなタブのみ、専用のハイライトスタイルを個別に適用する
      if (index === appState.activeTabIndex) {
        option.classList.add('active');
      }

      let itemData = null;
      if (appState.favorites) {
        itemData = appState.favorites.find(f => f.path === tab.path);
      }
      if (!itemData && tab.path && tab.path.startsWith('smart://')) {
        const id = tab.path.replace('smart://', '');
        if (appState.smartFolders) {
          itemData = appState.smartFolders.find(f => f.id === id);
        }
      }

      let iconHtml = '';
      let iconClass = '';
      if (itemData) {
        iconClass = `icon-color-${itemData.color || 'default'}`;

        if (itemData.icon && typeof ICON_SVGS !== 'undefined' && ICON_SVGS[itemData.icon]) {
          iconHtml = ICON_SVGS[itemData.icon];
        } else if (itemData.icon && itemData.icon.startsWith('FAV_')) {
          iconHtml = UIManager.ICONS[itemData.icon] || UIManager.ICONS.FAV_STAR;
        } else {
          iconHtml = UIManager.ICONS.FAV_STAR;
        }
      } else {
        iconHtml = UIManager.ICONS.FOLDER;
        iconClass = 'icon-color-cyan';
      }

      const iconSpan = document.createElement('span');
      iconSpan.className = `tab-list-icon ${iconClass}`;
      iconSpan.innerHTML = iconHtml;

      const svg = iconSpan.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
      }

      const textContainer = document.createElement('div');
      textContainer.className = 'tab-menu-item-text';

      const nameLabel = document.createElement('span');
      nameLabel.className = 'tab-menu-item-name';
      nameLabel.textContent = tab.name;

      const pathLabel = document.createElement('span');
      pathLabel.className = 'path-label';
      pathLabel.textContent = tab.path;
      pathLabel.title = tab.path;

      textContainer.appendChild(nameLabel);
      textContainer.appendChild(pathLabel);

      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close-btn';
      closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="7" height="7"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" stroke-width="1.5"/></svg>`;

      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (window.onTabClose) {
          await window.onTabClose(index);
          if (tabListMenu.classList.contains('show')) updateTabListMenu();
        }
      });

      option.appendChild(iconSpan);
      option.appendChild(textContainer);
      option.appendChild(closeBtn);

      // ホバー時の背景色・文字色の変化はCSS（context-menu-item:hover）に任せ、アイコンの色変化は行わない（常にお気に入り/フォルダ固有の色を保つ）

      option.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      option.addEventListener('auxclick', async (e) => {
        if (e.button === 1) { // 中クリック
          e.stopPropagation();
          if (window.onTabClose) {
            await window.onTabClose(index);
            if (tabListMenu.classList.contains('show')) updateTabListMenu();
          }
        }
      });

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        tabListMenu.classList.remove('show');
        await window.onTabClick(index);

        const container = document.getElementById('tab-container');
        if (container) {
          const tabEls = container.querySelectorAll('.tab-item:not(.new-tab-btn)');
          if (tabEls[index]) {
            scrollTabIntoView(tabEls[index]);
          }
        }
      });
      tabListMenu.appendChild(option);
    });
  };

  if (tabListBtn) {
    tabListBtn.addEventListener('mouseenter', (e) => {
      uiManager.showCustomTooltip('タブ一覧', e.clientX, e.clientY);
    });
    tabListBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip('タブ一覧', e.clientX, e.clientY);
    });
    tabListBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });

    tabListBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      uiManager.hideCustomTooltip();
      if (tabListMenu.classList.contains('show')) {
        tabListMenu.classList.remove('show');
        tabListBtn.classList.remove('open');
        return;
      }

      updateTabListMenu();

      const rect = tabListBtn.getBoundingClientRect();
      tabListBtn.classList.add('open');
      showMenuWithAnimation(tabListMenu, rect.left, rect.bottom, true);
    });
  }

  if (minBtn) {
    minBtn.innerHTML = UIManager.ICONS.WINDOW_MINIMIZE;
    minBtn.addEventListener('click', () => window.veloceAPI.minimizeViewer());
  }
  if (maxBtn) {
    maxBtn.innerHTML = UIManager.ICONS.WINDOW_MAXIMIZE;
    maxBtn.addEventListener('click', () => window.veloceAPI.maximizeViewer());
  }
  if (closeBtn) {
    closeBtn.innerHTML = UIManager.ICONS.WINDOW_CLOSE;
    closeBtn.addEventListener('click', () => window.veloceAPI.closeWindow());
  }

  const savedWinW = localStorage.getItem('mainWinWidth');
  const savedWinH = localStorage.getItem('mainWinHeight');
  const savedWinX = localStorage.getItem('mainWinX');
  const savedWinY = localStorage.getItem('mainWinY');
  const savedWinMax = localStorage.getItem('mainWinMaximized');

  if (savedWinW && savedWinH && window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
    const w = Math.max(800, parseInt(savedWinW, 10));
    const h = Math.max(600, parseInt(savedWinH, 10));
    window.veloceAPI.resizeViewerWindow(w, h);
  }
  if (savedWinX && savedWinY && window.veloceAPI && window.veloceAPI.moveViewerWindow) {
    let x = parseInt(savedWinX, 10);
    let y = parseInt(savedWinY, 10);

    const checkAndMove = async () => {
      try {
        if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.availableMonitors) {
          const monitors = await window.__TAURI__.window.availableMonitors();
          const isVisible = monitors.some(m => {
            const scale = m.scaleFactor || 1;
            const mx = m.position.x / scale;
            const my = m.position.y / scale;
            const mw = m.size.width / scale;
            const mh = m.size.height / scale;
            // タイトルバー付近がモニター内にあるか判定
            return x >= mx - 100 && x < mx + mw - 100 && y >= my - 50 && y < my + mh - 50;
          });

          if (!isVisible && monitors.length > 0) {
            const primary = monitors[0];
            const scale = primary.scaleFactor || 1;
            x = Math.round(primary.position.x / scale) + 100;
            y = Math.round(primary.position.y / scale) + 100;
          }
        }
      } catch (err) {
        console.warn("Failed to check monitors:", err);
      }
      window.veloceAPI.moveViewerWindow(x, y);
    };
    checkAndMove();
  }
  if (savedWinMax === 'true' && window.veloceAPI && window.veloceAPI.isViewerMaximized && window.veloceAPI.maximizeViewer) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      if (!isMax) window.veloceAPI.maximizeViewer();
    });
  }

  const savedLeftWidth = localStorage.getItem('leftWidth');
  if (savedLeftWidth) appState.layout.leftWidth = parseInt(savedLeftWidth, 10);

  const savedRightWidth = localStorage.getItem('rightWidth');
  if (savedRightWidth) appState.layout.rightWidth = parseInt(savedRightWidth, 10);

  const savedLeftVisible = localStorage.getItem('leftVisible');
  if (savedLeftVisible !== null) appState.layout.leftVisible = savedLeftVisible === 'true';

  const savedRightVisible = localStorage.getItem('rightVisible');
  if (savedRightVisible !== null) appState.layout.rightVisible = savedRightVisible === 'true';

  uiManager.applyLayout();

  if (!appState.layout.leftVisible && uiManager.elements.resizerLeft) {
    const btn = uiManager.elements.resizerLeft.querySelector('.resizer-toggle');
    if (btn) btn.classList.add('expanded');
  }
  if (!appState.layout.rightVisible && uiManager.elements.resizerRight) {
    const btn = uiManager.elements.resizerRight.querySelector('.resizer-toggle');
    if (btn) btn.classList.add('expanded');
  }

  const savedTopHeight = localStorage.getItem('topHeight');
  if (savedTopHeight) {
    document.documentElement.style.setProperty('--top-height', savedTopHeight);
    if (savedTopHeight === '0px') {
      document.documentElement.setAttribute('data-center-collapsed', 'true');
      if (uiManager.elements.resizerCenter) {
        const btn = uiManager.elements.resizerCenter.querySelector('.resizer-toggle');
        if (btn) btn.classList.add('expanded');
      }
    } else {
      document.documentElement.removeAttribute('data-center-collapsed');
    }
  }

  const savedLeftTopHeight = localStorage.getItem('leftTopHeight');
  if (savedLeftTopHeight) {
    document.documentElement.style.setProperty('--left-top-height', savedLeftTopHeight);
    if (savedLeftTopHeight === '0px') {
      document.documentElement.setAttribute('data-left-top-collapsed', 'true');
      const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
      if (btn) btn.classList.add('expanded');
    } else {
      document.documentElement.removeAttribute('data-left-top-collapsed');
    }
  }

  const savedRightTopHeight = localStorage.getItem('rightTopHeight');
  if (savedRightTopHeight) {
    if (savedRightTopHeight === '0px') {
      const btn = document.getElementById('resizer-right-pane')?.querySelector('.resizer-toggle');
      if (btn) btn.classList.add('expanded');
    }
  }

  const savedThumbScale = localStorage.getItem('thumbnailScale');
  if (savedThumbScale !== null && parseFloat(savedThumbScale) >= 100) {
    uiManager.elements.thumbnailSizeSlider.value = savedThumbScale;
  } else {
    uiManager.elements.thumbnailSizeSlider.value = 120;
  }
  updateThumbnailSize();

  const updateFilterIndicator = () => {
    if (!uiManager.elements.searchClearBtn) return;
    const hasSearch = !!(uiManager.elements.searchBar && uiManager.elements.searchBar.value.trim() !== '');
    const hasRatingFilter = appState.ratingFilterVal !== 0;
    if (hasSearch || hasRatingFilter) {
      uiManager.elements.searchClearBtn.classList.add('active');
    } else {
      uiManager.elements.searchClearBtn.classList.remove('active');
    }
  };

  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.addEventListener('input', (e) => {
      updateFilterIndicator();
    });
    uiManager.elements.searchBar.addEventListener('input', debounce((e) => {
      appState.searchQuery = e.target.value;
      scheduleRefresh();
    }, CONFIG.SEARCH_DELAY));
    uiManager.elements.searchBar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        if (uiManager.elements.searchClearBtn) {
          uiManager.elements.searchClearBtn.click();
        }
        uiManager.elements.searchBar.blur();
      }
    });
  }

  if (uiManager.elements.searchClearBtn) {
    uiManager.elements.searchClearBtn.innerHTML = UIManager.ICONS.ERASER;
    uiManager.elements.searchClearBtn.removeAttribute('title');
    uiManager.elements.searchClearBtn.addEventListener('mouseenter', (e) => {
      uiManager.showCustomTooltip('検索をクリア', e.clientX, e.clientY);
    });
    uiManager.elements.searchClearBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip('検索をクリア', e.clientX, e.clientY);
    });
    uiManager.elements.searchClearBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    uiManager.elements.searchClearBtn.addEventListener('click', () => {
      let changed = false;
      if (uiManager.elements.searchBar && uiManager.elements.searchBar.value !== '') {
        uiManager.elements.searchBar.value = '';
        appState.searchQuery = '';
        changed = true;
      }

      const resetCustomSelectUI = (containerId, val) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        const items = container.querySelectorAll('.custom-select-item');
        const targetItem = Array.from(items).find(i => i.dataset.value == val);
        if (targetItem) {
          items.forEach(i => i.classList.remove('selected'));
          targetItem.classList.add('selected');
          const label = container.querySelector('.custom-select-label');
          if (label) label.textContent = targetItem.textContent;
        }
      };

      if (appState.ratingFilterVal !== 0 || appState.ratingFilterOp !== 'gte') {
        appState.ratingFilterVal = 0;
        appState.ratingFilterOp = 'gte';
        resetCustomSelectUI('custom-rating-val-container', 0);
        resetCustomSelectUI('custom-rating-op-container', 'gte');
        changed = true;
      }

      updateFilterIndicator();

      if (changed) {
        scheduleRefresh();
      } else if (uiManager.elements.searchBar) {
        // Fallback for visual clear even if already empty
        uiManager.elements.searchBar.value = '';
        appState.searchQuery = '';
        scheduleRefresh();
      }

      uiManager.applyGlowEffect(uiManager.elements.searchClearBtn);
      uiManager.hideCustomTooltip();
    });
  }

  if (uiManager.elements.openCacheBtn) {
    uiManager.elements.openCacheBtn.innerHTML = UIManager.ICONS.FOLDER_OPEN;
    uiManager.elements.openCacheBtn.removeAttribute('title');
    let openCacheText = 'キャッシュフォルダを開く';
    uiManager.elements.openCacheBtn.addEventListener('mouseenter', async (e) => {
      uiManager.showCustomTooltip(openCacheText, e.clientX, e.clientY);
      if (window.veloceAPI.getCacheInfo) {
        const info = await window.veloceAPI.getCacheInfo();
        openCacheText = `キャッシュフォルダを開く\nパス: ${info.path}`;
        if (uiManager.isTooltipVisible) {
          uiManager.showCustomTooltip(openCacheText, uiManager.lastMouseX, uiManager.lastMouseY);
        }
      }
    });
    uiManager.elements.openCacheBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip(openCacheText, e.clientX, e.clientY);
    });
    uiManager.elements.openCacheBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    uiManager.elements.openCacheBtn.addEventListener('click', () => {
      uiManager.applyGlowEffect(uiManager.elements.openCacheBtn);
      window.veloceAPI.openCacheFolder();
      uiManager.hideCustomTooltip();
    });
  }

  if (uiManager.elements.clearCacheBtn) {
    uiManager.elements.clearCacheBtn.innerHTML = UIManager.ICONS.FLAME;
    uiManager.elements.clearCacheBtn.removeAttribute('title');
    let clearCacheText = 'キャッシュを削除';
    uiManager.elements.clearCacheBtn.addEventListener('mouseenter', async (e) => {
      uiManager.showCustomTooltip(clearCacheText, e.clientX, e.clientY);
      if (window.veloceAPI.getCacheInfo) {
        const info = await window.veloceAPI.getCacheInfo();
        const sizeMB = (info.totalSizeBytes / (1024 * 1024)).toFixed(2);
        clearCacheText = `キャッシュを削除\n保存数: ${info.fileCount.toLocaleString()}ファイル\n合計サイズ: ${sizeMB} MB`;
        if (uiManager.isTooltipVisible) {
          uiManager.showCustomTooltip(clearCacheText, uiManager.lastMouseX, uiManager.lastMouseY);
        }
      }
    });
    uiManager.elements.clearCacheBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip(clearCacheText, e.clientX, e.clientY);
    });
    uiManager.elements.clearCacheBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    uiManager.elements.clearCacheBtn.addEventListener('click', async () => {
      uiManager.applyGlowEffect(uiManager.elements.clearCacheBtn);
      uiManager.hideCustomTooltip();
      const isConfirmed = await uiManager.showConfirm('すべてのキャッシュを削除しますか？\nこの操作は元に戻せません。');
      if (isConfirmed) {
        uiManager.showToast('キャッシュを削除しています', 0, 'cache-clear', 'info');
        try {
          await window.veloceAPI.clearCache();
          cleanupContext();
          resetThumbnailPreloader();
          await refreshFileList();
          uiManager.showToast('すべてのキャッシュを削除しました。', 3000, 'cache-clear', 'success');
        } catch (err) {
          console.error("Failed to clear cache:", err);
          uiManager.showToast('キャッシュの削除に失敗しました。', 3000, 'cache-clear', 'error');
        }
      }
    });
  }

  if (uiManager.elements.auditCacheBtn) {
    uiManager.elements.auditCacheBtn.innerHTML = UIManager.ICONS.DATABASE_ZAP;
    uiManager.elements.auditCacheBtn.removeAttribute('title');
    let auditCacheText = 'キャッシュの精査と修復';
    uiManager.elements.auditCacheBtn.addEventListener('mouseenter', async (e) => {
      uiManager.showCustomTooltip(auditCacheText, e.clientX, e.clientY);
    });
    uiManager.elements.auditCacheBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip(auditCacheText, e.clientX, e.clientY);
    });
    uiManager.elements.auditCacheBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    uiManager.elements.auditCacheBtn.addEventListener('click', async () => {
      uiManager.applyGlowEffect(uiManager.elements.auditCacheBtn);
      uiManager.hideCustomTooltip();
      const isConfirmed = await uiManager.showConfirm('キャッシュの精査と修復を実行しますか？\n\n・存在しないファイルのキャッシュ削除\n・欠損メタデータやサムネイルの再生成\n\n上記が行われます。件数によっては\n非常に時間がかかる場合があります。');
      if (isConfirmed) {
        let unlisten = null;
        try {
          unlisten = await window.__TAURI__.event.listen('audit-progress', (event) => {
            const p = event.payload;
            uiManager.showToast(`キャッシュ精査中... ${p.current} / ${p.total}\n削除: ${p.deleted} | 修復: ${p.fixed}`, 0, 'cache-audit', 'info');
          });
          uiManager.showToast('キャッシュの精査を開始しました...', 0, 'cache-audit', 'info');
          
          const invoke = window.__TAURI__.invoke || (window.__TAURI__.tauri && window.__TAURI__.tauri.invoke) || (window.__TAURI__.core && window.__TAURI__.core.invoke);
          await invoke('audit_cache');
          
          uiManager.showToast('キャッシュの精査と修復が完了しました！', 3000, 'cache-audit', 'success');
        } catch (err) {
          console.error("Failed to audit cache:", err);
          uiManager.showToast('キャッシュの精査中にエラーが発生しました。', 3000, 'cache-audit', 'error');
        } finally {
          if (unlisten) unlisten();
        }
      }
    });
  }

  // --- ツールバー：ファイル名表示設定の初期化 ---
  const chkThumbnailName = document.getElementById('show-thumbnail-name-chk');
  const chkViewerName = document.getElementById('show-viewer-name-chk');

  if (chkThumbnailName) {
    const showThumbnailName = localStorage.getItem('showThumbnailNames') === 'true';
    chkThumbnailName.checked = showThumbnailName;
    if (showThumbnailName) {
      document.body.classList.add('show-thumbnail-names');
    }
    chkThumbnailName.addEventListener('change', (e) => {
      localStorage.setItem('showThumbnailNames', e.target.checked);
      if (e.target.checked) {
        document.body.classList.add('show-thumbnail-names');
      } else {
        document.body.classList.remove('show-thumbnail-names');
      }
    });
  }

  if (chkViewerName) {
    const showViewerName = localStorage.getItem('showViewerFilename') !== 'false'; // Default to true
    chkViewerName.checked = showViewerName;
    chkViewerName.addEventListener('change', (e) => {
      localStorage.setItem('showViewerFilename', e.target.checked);
    });
  }

  // D&Dの受け入れ範囲を広げるため、リストではなくセクション全体を取得
  const favListElement = document.getElementById('bookmark-list');
  if (favListElement) {
    initFavoritesDnd(favListElement, {
      renderFavorites,
      showNotification
    });

    favListElement.addEventListener('click', async (e) => {
      const itemDiv = e.target.closest('.bookmark-item');
      if (!itemDiv) return;

      const path = itemDiv.dataset.path;
      appState.selection.clear();
      appState.selectedIndex = -1;
      uiManager.updateSelectionUI();

      if (window.veloceAPI.loadDirectory) {
        if (window.veloceAPI.setViewParams) {
          await appState.setViewParams();
        }
        const activeTab = appState.tabs[appState.activeTabIndex];
        if (activeTab) {
          activeTab.path = path;
          activeTab.name = getTabNameForPath(path);
          activeTab.scrollTop = 0;
          appState.currentDirectory = path;
          localStorage.setItem('currentDirectory', appState.currentDirectory);
          uiManager.renderTabs();
          saveTabsState();

          refreshFileList(true);
          await expandTreeToPath(path);
        }
      }
    });

    favListElement.addEventListener('contextmenu', (e) => {
      const itemDiv = e.target.closest('.bookmark-item');
      if (!itemDiv) return;
      e.preventDefault();
      e.stopPropagation();

      contextMenuManager.show('favorite', {
        targetFavoriteId: itemDiv.dataset.id,
        targetFavoritePath: itemDiv.dataset.path
      }, e.clientX, e.clientY);
    });
  }

  initModalHandlers();

  const savedSort = localStorage.getItem('currentSort');
  if (savedSort) {
    try {
      appState.sortConfig = JSON.parse(savedSort);
    } catch (e) {
      console.error('Failed to parse saved sort:', e);
    }
  }

  updateSortIndicators();

  await refreshTree();
  initSmartFolders();
  if (window.veloceAPI && window.veloceAPI.updateSmartFolders) {
    window.veloceAPI.updateSmartFolders(SmartFolderStore.load()).catch(err => console.error("Failed to sync smart folders on init:", err));
  }

  // --- 初期タブの生成と読み込み ---
  const savedTabsState = localStorage.getItem('tabsState');
  if (savedTabsState) {
    try {
      const state = JSON.parse(savedTabsState);
      if (state.tabs && Array.isArray(state.tabs) && state.tabs.length > 0) {
        appState.tabs = state.tabs.map(t => ({
          ...t,
          history: t.history || [t.path],
          historyIndex: t.historyIndex !== undefined ? t.historyIndex : 0
        }));
        appState.activeTabIndex = (state.activeTabIndex >= 0 && state.activeTabIndex < state.tabs.length) ? state.activeTabIndex : 0;
      }
    } catch (e) {
      console.warn('Failed to parse tabs state:', e);
    }
  }

  if (appState.tabs.length === 0) {
    const savedDirectory = localStorage.getItem('currentDirectory') || 'PC';
    const initialTab = {
      id: Date.now(),
      path: savedDirectory,
      name: getTabNameForPath(savedDirectory),
      searchQuery: '',
      sortConfig: appState.sortConfig ? JSON.parse(JSON.stringify(appState.sortConfig)) : { key: 'name', asc: true },
      scrollTop: 0,
      history: [savedDirectory],
      historyIndex: 0
    };
    appState.tabs.push(initialTab);
    appState.activeTabIndex = 0;
  }

  uiManager.renderTabs();

  const currentTab = appState.tabs[appState.activeTabIndex];

  appState.searchQuery = currentTab.searchQuery || '';
  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.value = appState.searchQuery;
  }

  if (window.veloceAPI.getAllRatings) {
    const oldRatingsJson = localStorage.getItem('ratings');
    if (oldRatingsJson) {
      try {
        const oldRatings = JSON.parse(oldRatingsJson);
        if (Object.keys(oldRatings).length > 0 && window.veloceAPI.migrateRatings) {
          await window.veloceAPI.migrateRatings(oldRatings);
        }
      } catch (e) {
        console.error('Failed to migrate ratings:', e);
      }
      localStorage.removeItem('ratings');
    }

    const dbRatings = await window.veloceAPI.getAllRatings();
    appState.ratings = dbRatings || {};
  }

  const setupCustomSelect = (containerId, valueKey) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const label = container.querySelector('.custom-select-label');
    const items = container.querySelectorAll('.custom-select-item');

    const initialVal = appState[valueKey];
    const initialItem = Array.from(items).find(i => i.dataset.value == initialVal);
    if (initialItem && label) {
      label.textContent = initialItem.textContent;
      items.forEach(i => i.classList.remove('selected'));
      initialItem.classList.add('selected');
    }

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.custom-select.open').forEach(el => {
        if (el !== container) el.classList.remove('open');
      });
      container.classList.toggle('open');
    });

    items.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = item.dataset.value;
        const parsedVal = valueKey === 'ratingFilterVal' ? parseInt(val, 10) : val;

        if (appState[valueKey] !== parsedVal) {
          appState[valueKey] = parsedVal;
          if (label) label.textContent = item.textContent;
          items.forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          updateFilterIndicator();
          scheduleRefresh();
        }
        container.classList.remove('open');
      });
    });
  };

  setupCustomSelect('custom-rating-val-container', 'ratingFilterVal');
  setupCustomSelect('custom-rating-op-container', 'ratingFilterOp');

  // ----------------------------------------------------------------------------
  // ソートドロップダウン (#sort-select-container) の初期化
  // ----------------------------------------------------------------------------
  (function setupSortSelect() {
    const container = document.getElementById('sort-select-container');
    if (!container) return;

    // 開閉トグル
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = container.classList.contains('open');

      document.querySelectorAll('.custom-select.open').forEach(el => {
        if (el !== container) {
          el.classList.remove('open');
          el.classList.remove('open-up');
        }
      });

      if (!isOpen) {
        container.classList.add('open');
        const rect = container.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 260 && rect.top > 260) {
          container.classList.add('open-up');
        } else {
          container.classList.remove('open-up');
        }
      } else {
        container.classList.remove('open');
        container.classList.remove('open-up');
      }
    });

    // 各アイテムのクリック
    container.querySelectorAll('.custom-select-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = item.dataset.sortKey;
        const asc = item.dataset.sortAsc === 'true';
        appState.sortConfig.key = key;
        appState.sortConfig.asc = asc;
        localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
        updateSortIndicators();
        scheduleRefresh();
        container.classList.remove('open');
      });
    });

    // 初期表示を現在のソートに同期
    updateSortSelectDropdown();
  })();

  // ----------------------------------------------------------------------------
  // GLOBAL TAG LISTENER & CSS INJECTION (covers diff-tag)
  // ----------------------------------------------------------------------------
  const globalTagStyle = document.createElement('style');
  globalTagStyle.textContent = `
    .prompt-tag, .diff-tag {
      cursor: pointer !important;
      display: inline-block !important;
      transition: all 0.2s !important;
    }
    .prompt-tag:hover, .diff-tag:hover {
      opacity: 0.7 !important;
      transform: scale(1.05) !important;
      background-color: rgba(255, 255, 255, 0.1) !important;
    }
  `;
  document.head.appendChild(globalTagStyle);

  let _lastCopiedTags = "";
  document.body.addEventListener('click', async (e) => {
    const tagEl = e.target.closest('.diff-tag');
    if (tagEl) {
      try {
        const text = tagEl.textContent;
        if (text) {
          let textToCopy = text;
          let isAppended = false;
          // Ctrl+Click の場合は内部キャッシュをもとにカンマ区切りで追記する
          // (navigator.clipboard.readText は権限プロンプトが出るため使用しない)
          if (e.ctrlKey && _lastCopiedTags) {
            isAppended = true;
            const currentTags = _lastCopiedTags.split(',').map(t => t.trim()).filter(t => t);
            if (!currentTags.includes(text)) {
              textToCopy = _lastCopiedTags + ', ' + text;
            } else {
              textToCopy = _lastCopiedTags; // 既に含まれている場合はそのまま
            }
          }
          _lastCopiedTags = textToCopy;
          
          await navigator.clipboard.writeText(textToCopy);
          const displayTxt = textToCopy.length > 20 ? textToCopy.substring(0, 20) + '...' : textToCopy;
          const prefix = isAppended ? '追加コピーしました: ' : 'コピーしました: ';
          if (typeof uiManager !== 'undefined' && uiManager) {
            uiManager.showToast(prefix + displayTxt, 3000, null, 'success');
            uiManager.applyGlowEffect(tagEl);
          } else if (typeof showNotification === 'function') {
            showNotification(prefix + displayTxt, 'success');
          }
        }
      } catch(err) {
        if (typeof uiManager !== 'undefined' && uiManager) uiManager.showToast('Error: ' + err, 3000, null, 'error');
      }
    }
  }, true);

  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(el => {
      el.classList.remove('open');
    });
  });
  if (currentTab.sortConfig) {
    appState.sortConfig = JSON.parse(JSON.stringify(currentTab.sortConfig));
    updateSortIndicators();
  }

  if (window.veloceAPI.loadDirectory) {
    appState.currentDirectory = currentTab.path;
    localStorage.setItem('currentDirectory', appState.currentDirectory);
    appState.totalCount = 0;
    uiManager.renderAll(true);
    clearMetadataUI();
    uiManager.showToast('フォルダを読み込み中', 0, 'dir-load-progress', 'info');

    updateNavButtons();

    // 起動時のディレクトリ読み込み前にソート条件をバックエンドへ同期させ、initialChunkが正しくソートされるようにする
    if (window.veloceAPI.setViewParams) {
      await appState.setViewParams();
    }
    window.veloceAPI.loadDirectory(currentTab.path);

    await expandTreeToPath(appState.currentDirectory);
    saveTabsState();
  }

  if (window.veloceAPI.onRatingChanged) {
    window.veloceAPI.onRatingChanged((payload) => {
      const { path, rating } = payload;
      applyRatingUI(path, rating, false);
    });
  }

  if (window.veloceAPI.onFileChanged) {
    window.veloceAPI.onFileChanged(async (newFile) => {
      const oldUrl = appState.thumbnailUrls.get(newFile.path);
      if (oldUrl && oldUrl.startsWith('blob:')) {
        URL.revokeObjectURL(oldUrl);
      }
      appState.thumbnailUrls.delete(newFile.path);

      if (window.thumbnailManager) window.thumbnailManager.remove(newFile.path);

      if (window.uiManager && window.uiManager._domByPath) {
        const wrapper = window.uiManager._domByPath.get(newFile.path);
        if (wrapper) {
          wrapper.dataset.filepath = ''; // 意図的に空にして updateVirtualGrid での再描画を強制する
          window.uiManager._domByPath.delete(newFile.path);
        }
      }

      const newTotal = await window.veloceAPI.notifyFileChanged(newFile);
      if (typeof newTotal === 'number') appState.totalCount = newTotal;
      if (newFile.width > 0 && newFile.height > 0 && window.uiManager && typeof window.uiManager.updateFileDimensions === 'function') {
        window.uiManager.updateFileDimensions(newFile.path, newFile.width, newFile.height);
      }
      scheduleRefresh();
      if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
        window.debouncedUpdateSmartFolderCounts();
      }
    });
  }

  if (window.veloceAPI.onFileRemoved) {
    window.veloceAPI.onFileRemoved(async (path) => {
      const newTotal = await window.veloceAPI.notifyFileRemoved(path);
      if (typeof newTotal === 'number') appState.totalCount = newTotal;
      scheduleRefresh();
      if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
        window.debouncedUpdateSmartFolderCounts();
      }
    });
  }

  if (window.veloceAPI.onDirectoryChanged) {
    const handleDirChange = debounce(async () => {
      await refreshTree();

      if (appState.currentDirectory) {
        refreshFileList(false);
        await expandTreeToPath(appState.currentDirectory);
      }
    }, 500);

    window.veloceAPI.onDirectoryChanged(() => {
      handleDirChange();
    });
  }

  if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      const borderOverlay = document.getElementById('border-overlay');
      if (borderOverlay) borderOverlay.style.display = isMax ? 'none' : 'block';
      const maxBtn = document.getElementById('titlebar-maximize');
      if (maxBtn) maxBtn.innerHTML = isMax ? UIManager.ICONS.WINDOW_RESTORE : UIManager.ICONS.WINDOW_MAXIMIZE;
    }).catch(() => { });
  }
});

let smartFoldersDelegated = false;

function createSmartFolderNode(f) {
  const template = document.getElementById('smart-folder-template');
  const clone = template.content.cloneNode(true);
  const item = clone.querySelector('.smart-folder-item');
  item.dataset.id = f.id;

  const iconSpan = clone.querySelector('.smart-folder-icon');
  if (f.icon && ICON_SVGS && ICON_SVGS[f.icon]) {
    iconSpan.innerHTML = ICON_SVGS[f.icon];
    iconSpan.className = `smart-folder-icon icon-color-${f.color || 'default'}`;
  } else if (f.icon && f.icon.startsWith('FAV_')) {
    iconSpan.innerHTML = UIManager.ICONS[f.icon] || UIManager.ICONS['FAV_STAR'];
    iconSpan.className = `smart-folder-icon color-${f.color || 'default'}`;
  } else {
    iconSpan.className = 'smart-folder-icon';
    iconSpan.innerHTML = f.icon || UIManager.ICONS.FAV_STAR;
  }

  const nameSpan = clone.querySelector('.folder-name');
  nameSpan.textContent = f.name;

  return item;
}

/**
 * スマートフォルダの件数を取得してUIに反映する非同期関数
 */
window.debouncedUpdateSmartFolderCounts = debounce(updateSmartFolderCountsUI, 500);

async function updateSmartFolderCountsUI() {
  if (!window.veloceAPI.getSmartFolderCounts) return;
  try {
    const rules = appState.smartFolders || [];
    const counts = await window.veloceAPI.getSmartFolderCounts(rules);
    const list = document.getElementById('smart-folders-list');
    if (!list) return;
    const items = list.querySelectorAll('.smart-folder-item');
    items.forEach(item => {
      const id = item.dataset.id;
      const countSpan = item.querySelector('.smart-folder-count');
      if (id && countSpan) {
        if (counts[id] !== undefined) {
          countSpan.textContent = Number(counts[id]).toLocaleString();
          countSpan.classList.add('show');
        } else {
          countSpan.classList.remove('show');
        }
      }
    });
  } catch (e) {
    console.error('Failed to update smart folder counts:', e);
  }
}

/**
 * スマートフォルダのUI初期化とイベント設定を行います
 */
function initSmartFolders() {
  const container = document.getElementById('smart-folders-list');
  if (!container) return;

  const fragment = document.createDocumentFragment();
  const folders = appState.smartFolders || [];

  folders.forEach(f => {
    fragment.appendChild(createSmartFolderNode(f));
  });

  // 1回のReflowでDOMツリーを更新
  container.replaceChildren(fragment);
  updateSmartFolderCountsUI();

  // イベント委譲 (Event Delegation) は1回だけ設定
  if (!smartFoldersDelegated) {
    smartFoldersDelegated = true;

    container.addEventListener('click', async (e) => {
      const item = e.target.closest('.smart-folder-item');
      if (!item) return;

      // 選択状態の更新（スマートフォルダはタブと状態が合わなくなるため選択状態を付与しない）
      document.querySelectorAll('.smart-folder-item').forEach(el => el.classList.remove('selected'));

      // ツリー側の選択状態を解除
      document.querySelectorAll('#dir-tree .tree-item.selected').forEach(el => el.classList.remove('selected'));

      const fId = item.dataset.id;
      const f = appState.smartFolders.find(x => x.id === fId);
      if (!f) return;

      const path = `smart://${f.id}`;
      appState.selection.clear();
      appState.selectedIndex = -1;
      uiManager.updateSelectionUI();

      if (window.veloceAPI.loadDirectory) {
        const activeTab = appState.tabs[appState.activeTabIndex];
        if (activeTab) {
          activeTab.path = path;
          activeTab.name = getTabNameForPath(path, appState.favorites);
          activeTab.scrollTop = 0;
          appState.currentDirectory = path;
          localStorage.setItem('currentDirectory', appState.currentDirectory);
          uiManager.renderTabs();
          saveTabsState(appState, uiManager);

          refreshFileList(true);
        }
      }
    });

    const section = document.getElementById('smart-folders-section');
    if (section) {
      section.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.smart-folder-item');
        if (item) {
          // アイテム上での右クリック
          e.preventDefault();
          e.stopPropagation();

          const fId = item.dataset.id;
          const f = appState.smartFolders.find(x => x.id === fId);
          if (!f) return;

          contextMenuManager.show('smart-folder', {
            targetSmartFolderId: f.id,
            targetFolder: { path: `smart://${f.id}`, name: f.name }
          }, e.clientX, e.clientY);
        } else {
          // セクション余白での右クリック
          e.preventDefault();
          e.stopPropagation();

          contextMenuManager.show('smart-folder-background', {}, e.clientX, e.clientY);
        }
      });
    }
  }
}

/**
 * 履歴（Undoスタック）から直前の操作を取り消す
 */
async function performUndo() {
  if (appState.undoStack.length === 0) {
    uiManager.showToast('元に戻す操作はありません', 2000, 'undo', 'info');
    return;
  }

  const action = appState.undoStack.pop();
  try {
    const { fs, path } = window.__TAURI__;

    if (action.type === 'RENAME_FOLDER') {
      const oldName = await path.basename(action.oldPath);
      const result = await window.veloceAPI.renameFolder(action.newPath, oldName);
      if (result.success) {
        uiManager.showToast(`フォルダ名の変更を元に戻しました`, 3000, 'undo', 'success');
        if (appState.currentDirectory.startsWith(action.newPath)) {
          appState.currentDirectory = appState.currentDirectory.replace(action.newPath, action.oldPath);
          localStorage.setItem('currentDirectory', appState.currentDirectory);
        }
        await refreshTree();
      }
    } else if (action.type === 'RENAME_FILE') {
      const oldName = await path.basename(action.oldPath);
      const result = await window.veloceAPI.renameFile(action.newPath, oldName);
      if (result.success) {
        uiManager.showToast(`ファイル名の変更を元に戻しました`, 3000, 'undo', 'success');
        const oldUrl = appState.thumbnailUrls.get(action.newPath);
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        appState.thumbnailUrls.delete(action.newPath);
        scheduleRefresh();
      }
    } else if (action.type === 'MOVE_FILE') {
      const originalDir = await path.dirname(action.sourcePath);
      const result = await window.veloceAPI.moveOrCopyFile(action.targetPath, originalDir, 'move');
      if (result.success) {
        uiManager.showToast(`ファイルの移動を元に戻しました`, 3000, 'undo', 'success');
        scheduleRefresh();
      }
    } else if (action.type === 'COPY_FILE') {
      await fs.removeFile(action.targetPath);
      if (window.veloceAPI.notifyFileRemoved) {
        await window.veloceAPI.notifyFileRemoved(action.targetPath);
      }
      uiManager.showToast(`ファイルのコピーを元に戻しました`, 3000, 'undo', 'success');
      scheduleRefresh();
    }
  } catch (err) {
    console.error('Undo failed:', err);
    uiManager.showToast(`元に戻す操作に失敗しました`, 3000, 'undo', 'warning');
  }
}

