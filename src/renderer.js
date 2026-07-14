// ============================================================================
// Veloce - Main Controller (renderer.js)
// ============================================================================

import { appState, SmartFolderStore } from './renderer-state.js';
import { UIManager, uiManager, formatSize, formatDate, ICON_SVGS, COLORS, createFavoriteEditorUI } from './renderer-ui.js';
import { debounce, blockDevtoolsShortcuts, getStreamUrl } from './utils.js';
import { validateFilename } from './path-utils.js';
import { extractMetadataFields, highlightSearchTerms, buildInspectorSections } from './metadata-format.js';
import { resolvePathDisplay } from './favorite-icons.js';
import {
  initTabHandlers,
  updateCurrentTabState as syncCurrentTabState,
  saveTabsState as persistTabsState,
  getTabNameForPath as resolveTabName
} from './renderer-tabs.js';

blockDevtoolsShortcuts();

const CONFIG = {
  CHUNK_SIZE: 100,        // 一度にDOMに追加する要素数（レンダリング負荷軽減）
  SEARCH_DELAY: 300,      // 検索入力時の反映遅延時間(ms)
  REFRESH_DELAY: 100,     // リフレッシュ処理の遅延時間(ms)
  GRID_GAP: 8,            // サムネイルグリッドの隙間(px)
  GRID_PADDING: 8         // サムネイルグリッドのパディング(px)
};

// --- タブ機能用 ---
appState.tabs = [];
appState.activeTabIndex = -1;


// サムネイル生成の並列数（v1.7.0と同等の8に戻す）
const THUMBNAIL_BATCH_SIZE = 4;
const emptyDragImage = new Image();
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const resizingState = { left: false, right: false, center: false, leftTop: false, rightTop: false };
let draggedFavoriteId = null; // お気に入りのドラッグ状態を管理

const contextMenu = document.createElement('div');
contextMenu.id = 'context-menu';

// タブ一覧メニュー
const tabListMenu = document.createElement('div');
tabListMenu.id = 'tab-list-menu';
document.body.appendChild(tabListMenu);

/**
 * メニューを特定の位置にアニメーション付きで表示します。
 */
function showMenuWithAnimation(menuElement, startX, startY, isDropdown = false) {
  menuElement.style.display = 'block';
  const rect = menuElement.getBoundingClientRect();
  let x = startX;
  let y = startY;
  let originX = 'left';
  let originY = 'top';

  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - (isDropdown ? 5 : 0);
    originX = 'right';
  }
  if (y + rect.height > window.innerHeight) {
    y = window.innerHeight - rect.height;
    originY = 'bottom';
  }

  menuElement.style.transformOrigin = `${originY} ${originX}`;
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;

  menuElement.animate([
    { opacity: 0, transform: 'scale(0.95)' },
    { opacity: 1, transform: 'scale(1)' }
  ], { duration: 80, easing: 'cubic-bezier(0, 0, 0.2, 1)', fill: 'forwards' });
}

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

  // UIとデータの初期化
  appState.totalCount = 0;
  appState.selection.clear();
  appState.selectedIndex = -1;
  appState.thumbnailUrls.clear();
  if (window.thumbnailManager) window.thumbnailManager.clear();
  
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

async function expandTreeToPath(targetPath, disableScroll = false, rootElement = document) {
  if (!targetPath || targetPath === 'PC') return;

  const searchRoot = rootElement === document ? document.getElementById('dir-tree') : rootElement;
  if (!searchRoot) return;

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
          itemDiv.scrollIntoView({ block: 'center', behavior: 'instant' });
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

async function loadAllMetadataInBackground() {
  if (!window.veloceAPI.getFullMetadataBatch) return;
  // まだメタデータが読み込まれていないファイルのみを対象にする
  const FETCH_BATCH = 200;
  const allFiles = [];
  for (let offset = 0; offset < appState.totalCount; offset += FETCH_BATCH) {
    const items = await window.veloceAPI.getItems(offset, FETCH_BATCH);
    allFiles.push(...items);
  }
  const targets = allFiles.filter(f => !f.metaLoaded);

  // プログレス表示用の分母と分子は、「キャッシュがなく、実際に抽出が必要なファイル数」をベースにする
  const noCacheFiles = allFiles.filter(f => !f.hasMetadataCache);
  const noCacheTargets = targets.filter(f => !f.hasMetadataCache);
  appState.metadataTargetCount = noCacheFiles.length;
  appState.metadataCompleted = noCacheFiles.length - noCacheTargets.length;

  // 対象がゼロなら通知を出さずに終了
  if (targets.length === 0) {
    updateMetadataToast();
    return;
  }

  const batchId = ++appState.currentMetaBatchId;
  const BATCH_SIZE = 5;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    // フォルダ切り替えなどでリセットされた場合は中断
    if (appState.currentMetaBatchId !== batchId) return;

    const batch = targets.slice(i, i + BATCH_SIZE);
    const paths = batch.map(f => f.path);

    try {
      const results = await window.veloceAPI.getFullMetadataBatch(paths);
      if (appState.currentMetaBatchId !== batchId) return;

      await window.veloceAPI.updateMetadataInState(results);
      const newCompletions = results.filter(m => {
        const t = batch.find(f => f.path === m.path);
        return t && !t.hasMetadataCache;
      });
      appState.metadataCompleted += newCompletions.length;

      updateMetadataToast();

      // メインスレッドをブロックしないよう少し休止
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.error('Failed to load metadata batch:', error);
    }
  }

  if (appState.currentMetaBatchId === batchId) {
    if (['width', 'height', 'ratio'].includes(appState.sortConfig.key)) {
      scheduleRefresh();
    } else if (appState.searchQuery.trim() !== '') {
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

      pathsToRebuild.forEach(p => {
        appState.thumbnailCounted.delete(p);
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
    bookmarkOverflowMenu.style.display = 'none';
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
      icon.textContent = fav.icon || '⭐';
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

// アイコン付きメニュー項目の生成ヘルパー
function createMenuItem(label, iconSvg, onClick, isDanger = false, shortcut = '') {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  if (isDanger) item.classList.add('danger');

  item.innerHTML = `
    ${iconSvg || '<div style="width:16px;height:16px;"></div>'}
    <span style="text-align: left; white-space: nowrap;">${label}</span>
    <span style="text-align: right; opacity: 0.6; font-size: 0.9em;">${shortcut}</span>
    <div></div>
  `;

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    contextMenu.style.display = 'none';
    if (onClick) onClick();
  });
  return item;
}

// メニューセパレーターの作成
const createMenuSeparator = () => {
  const separator = document.createElement('div');
  separator.className = 'menu-separator';
  return separator;
};

const menuSeparator1 = createMenuSeparator();
const menuSeparator2 = createMenuSeparator();
const menuSeparator3 = createMenuSeparator();
const menuSeparator4 = createMenuSeparator();
const menuSeparatorCache = createMenuSeparator();

function resetThumbnailPreloader() {
  if (window.thumbnailManager) window.thumbnailManager.resetPreload();
  appState.preloadCursor = 0;
}

window.markThumbnailCompleted = function markThumbnailCompleted(filePath) {
  if (filePath && !appState.thumbnailCounted.has(filePath)) {
    appState.thumbnailCounted.add(filePath);
    appState.thumbnailCompleted++;
    window.updateThumbnailToast();
  }
};

window.updateThumbnailToast = function updateThumbnailToast() {
  if (appState.thumbnailTotalRequested === 0) return;

  const now = Date.now();
  const THROTTLE_DELAY = 50; // 50msに1回まで更新を許可

  // 最後の更新から十分な時間が経過したか、または最後の1件の時のみUIを更新
  if (now - appState.lastThumbnailToastTime > THROTTLE_DELAY || appState.thumbnailCompleted >= appState.thumbnailTotalRequested) {
    appState.lastThumbnailToastTime = now;

    if (appState.thumbnailCompleted < appState.thumbnailTotalRequested) {
      uiManager.showToast(`サムネイル読込中 (${appState.thumbnailCompleted}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress', 'info');
    } else {
      uiManager.showToast(`サムネイル読込完了 (${appState.thumbnailTotalRequested}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress');
      clearTimeout(appState.thumbnailToastTimeout);
      appState.thumbnailToastTimeout = setTimeout(() => {
        const t = document.getElementById('toast-thumbnail-progress');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
        appState.thumbnailTotalRequested = 0;
        appState.thumbnailCompleted = 0;
        appState.lastThumbnailToastTime = 0;
      }, 1000);
    }
  }
}

// 個別タスクのタイムアウト付きサムネイル取得
function fetchThumbnailWithTimeout(filePath, timeoutMs = 10000) {
  return Promise.race([
    window.veloceAPI.getThumbnail(filePath),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Thumbnail timeout')), timeoutMs))
  ]);
}

class ThumbnailQueueManager {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.activeTasks = new Set();
    this.priorityQueue = [];
    this.preloadQueue = [];
    this.isProcessing = false;
  }

  enqueuePriority(filePath) {
    if (!this.activeTasks.has(filePath) && !appState.thumbnailUrls.has(filePath)) {
      const idx = this.priorityQueue.findIndex(req => req.filePath === filePath);
      if (idx > -1) this.priorityQueue.splice(idx, 1);
      this.priorityQueue.push({ filePath });
      this.processNext();
    }
  }

  resetPreload() {
    this.preloadQueue = [];
  }

  clear() {
    this.priorityQueue = [];
    this.preloadQueue = [];
    this.activeTasks.clear();
  }

  unshiftPreload(paths) {
    const toAdd = paths.filter(p => !this.activeTasks.has(p) && !appState.thumbnailUrls.has(p));
    this.preloadQueue.unshift(...toAdd);
    this.processNext();
  }

  remove(filePath) {
    this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
    this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);
  }

  async processNext() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // updateVirtualGrid() で同期した appState.visiblePathSet を参照する（querySelectorAll O(N) を排除）
      const visiblePaths = appState.visiblePathSet || new Set();

      while (this.activeTasks.size < this.concurrency) {
        let targetFile = null;

        // 1. Priority Queue
        if (this.priorityQueue.length > 0) {
          appState.isPreloadRunning = false;
          let targetIndex = this.priorityQueue.findIndex(req => visiblePaths.has(req.filePath));
          if (targetIndex === -1) targetIndex = 0;

          const req = this.priorityQueue.splice(targetIndex, 1)[0];
          
          if (appState.thumbnailUrls.has(req.filePath)) {
            if (typeof window.markThumbnailCompleted === 'function') window.markThumbnailCompleted(req.filePath);
            continue;
          }
          targetFile = req.filePath;
        }
        // 2. Preload Fetching
        else if (this.preloadQueue.length === 0 && appState.preloadCursor < appState.totalCount) {
          appState.isPreloadRunning = true;
          if (!appState.isFetchingPreload) {
            appState.isFetchingPreload = true;
            window.veloceAPI.getItems(appState.preloadCursor, 50).then(items => {
              if (items && items.length > 0) {
                appState.preloadCursor += items.length;
                this.preloadQueue.push(...items.map(f => f.path));
              } else {
                appState.preloadCursor += 50;
              }
            }).catch(err => {
              console.warn("Preload getItems failed:", err);
              appState.preloadCursor += 50;
            }).finally(() => {
              appState.isFetchingPreload = false;
              this.processNext();
            });
          }
          break; // wait for fetch
        }
        // 3. Preload Queue
        else if (this.preloadQueue.length > 0) {
          appState.isPreloadRunning = true;
          let found = false;
          while (this.preloadQueue.length > 0) {
            const p = this.preloadQueue.shift();
            if (appState.thumbnailUrls.has(p)) {
              if (typeof window.markThumbnailCompleted === 'function') window.markThumbnailCompleted(p);
            } else if (!this.activeTasks.has(p)) {
              targetFile = p;
              found = true;
              break;
            }
          }
          if (!found) {
            if (appState.preloadCursor >= appState.totalCount) {
              appState.isPreloadRunning = false;
            }
            continue;
          }
        }

        if (!targetFile) break;

        this.activeTasks.add(targetFile);
        // 個別タスクを非同期で起動（完了次第 updateDOM → processNext を呼ぶ）
        this.runTask(targetFile);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async runTask(filePath) {
    const start = performance.now();
    try {
      // 1. Rust にキャッシュを問い合わせ (DBのみ検索なので超高速)
      let url = await window.veloceAPI.getThumbnail(filePath);
      let fetchTime = performance.now();
      
      // 2. キャッシュがない場合、WebView2 (ブラウザ) の高速エンジンでサムネイル生成
      if (!url) {
        const base64Url = await this.generateThumbnailInBrowser(filePath);
        
        appState.thumbnailUrls.set(filePath, base64Url);
        this.updateDOM(filePath, base64Url);

        // バックグラウンドでRustに保存後、巨大なBase64メモリを解放して軽量URLに差し替える
        window.veloceAPI.saveThumbnail(filePath, base64Url).then(() => {
          let mtime = 0;
          if (appState.filtered_files) {
            const f = appState.filtered_files.find(item => item.path === filePath);
            if (f) mtime = f.mtime;
          }
          const lightUrl = `https://veloce.localhost/thumbnail/?path=${encodeURIComponent(filePath)}&mtime=${mtime}`;
          // 生成時のBase64URLのままであれば（他の処理で上書きされていなければ）差し替える
          if (appState.thumbnailUrls.get(filePath) === base64Url) {
            appState.thumbnailUrls.set(filePath, lightUrl);
            this.updateDOM(filePath, lightUrl);
          }
        }).catch(err => console.warn('Cache save error:', err));
        
        return; // ここで早期リターン
      }

      appState.thumbnailUrls.set(filePath, url);
      this.updateDOM(filePath, url);
    } catch (err) {
      console.warn(`[Thumbnail] ${filePath.split('\\').pop()} error:`, err);
      let fallbackUrl;
      if (filePath.toLowerCase().endsWith('.mp4')) {
        fallbackUrl = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23aaa"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>`;
      } else {
        fallbackUrl = getStreamUrl(filePath, window.veloceAPI.convertFileSrc(filePath));
      }
      appState.thumbnailUrls.set(filePath, fallbackUrl);
      this.updateDOM(filePath, fallbackUrl);
    } finally {
      this.activeTasks.delete(filePath);
      this.processNext();
    }
  }

  generateThumbnailInBrowser(filePath) {
    return new Promise(async (resolve, reject) => {
      try {
        const assetUrl = getStreamUrl(filePath, window.veloceAPI.convertFileSrc(filePath));
        let sourceElement, width, height;

        if (filePath.toLowerCase().endsWith('.mp4')) {
          if (window.veloceAPI.getVideoThumbnail) {
            try {
              const nativeB64 = await window.veloceAPI.getVideoThumbnail(filePath);
              if (nativeB64) {
                return resolve(nativeB64);
              }
            } catch (err) {
              console.warn(`[Thumbnail] Native extraction failed for ${filePath}, falling back...`, err);
            }
          }

          const tryExtractFrame = async (videoSrc, needsCrossOrigin) => {
            const video = document.createElement('video');
            if (needsCrossOrigin) video.crossOrigin = 'anonymous';
            video.src = videoSrc;
            video.muted = true;
            video.preload = 'metadata';
            video.style.visibility = 'hidden';
            video.style.position = 'absolute';
            video.style.width = '1px';
            video.style.height = '1px';
            document.body.appendChild(video);
            
            await new Promise((res, rej) => {
              video.onloadedmetadata = () => {
                const targetTime = video.duration ? Math.min(1.0, video.duration / 2) : 0.001;
                video.currentTime = targetTime;
              };
              video.onseeked = () => {
                width = video.videoWidth;
                height = video.videoHeight;
                sourceElement = video;
                if (video.parentNode) video.parentNode.removeChild(video);
                res();
              };
              video.onerror = (e) => {
                if (video.parentNode) video.parentNode.removeChild(video);
                rej(new Error("Video load failed"));
              };
            });
            video.load();
          };

          try {
            await tryExtractFrame(assetUrl, true);
          } catch (firstErr) {
            console.warn(`[Thumbnail] Fast path failed for ${filePath}, trying Blob workaround...`);
            if (sourceElement && sourceElement.parentNode) sourceElement.parentNode.removeChild(sourceElement);
            sourceElement = null;

            try {
              // Win8.1 CORS fallback: Check file size. If < 100MB, fetch entire file.
              let fileSize = 0;
              if (window.appState && window.appState.filteredFiles) {
                const f = window.appState.filteredFiles.find(x => x.path === filePath);
                if (f) fileSize = f.size || 0;
              }

              const MAX_SIZE = 100 * 1024 * 1024; // 100MB
              if (fileSize > MAX_SIZE) {
                throw new Error(`File too large for Blob fallback: ${fileSize} bytes`);
              }

              const response = await fetch(assetUrl);
              if (!response.ok) throw new Error("Fetch failed");
              const blob = await response.blob();
              const blobUrl = URL.createObjectURL(blob);
              
              try {
                await tryExtractFrame(blobUrl, false);
              } finally {
                URL.revokeObjectURL(blobUrl);
              }
            } catch (fallbackErr) {
              console.warn(`[Thumbnail] Blob workaround failed for ${filePath}:`, fallbackErr);
              throw fallbackErr;
            }
          }
        } else {
          const response = await fetch(assetUrl);
          if (!response.ok) throw new Error("Fetch failed");
          const blob = await response.blob();
          sourceElement = await createImageBitmap(blob);
          width = sourceElement.width;
          height = sourceElement.height;
        }

        const canvas = document.createElement('canvas');
        
        if (width > 384 || height > 384) {
          const ratio = Math.min(384 / width, 384 / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        // 最低1pxを保証
        width = Math.max(1, width);
        height = Math.max(1, height);
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        
        // Veloceの背景色(#1e1e1e)で塗りつぶして透明PNG/WebP対策
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(sourceElement, 0, 0, width, height);
        
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        if (sourceElement.close) {
          sourceElement.close(); // Free memory immediately for ImageBitmap
        } else if (sourceElement.tagName === 'VIDEO') {
          sourceElement.pause();      // 再生/デコードを確実に停止
          sourceElement.src = '';     // ストリームの切断
          sourceElement.load();       // ビデオ要素のリセットを強制
          sourceElement.remove();     // DOMのクリーンアップ
        }
        resolve(dataUrl);
      } catch (err) {
        reject(err);
      }
    });
  }

  updateDOM(filePath, url) {
    // uiManager._domByPath (Map) から O(1) で要素を取得する
    const uiMgr = window.uiManager || uiManager;
    const wrapper = (uiMgr && uiMgr._domByPath) ? uiMgr._domByPath.get(filePath) : null;
    if (wrapper) {
      const img = wrapper.querySelector('.thumbnail-img');
      if (img) {
        img.src = url;
        if (img.complete) {
          img.classList.remove('loading');
        } else {
          img.onload = function () { this.classList.remove('loading'); };
          img.onerror = function () {
            this.classList.remove('loading');
            const fallback = window.veloceAPI.convertFileSrc(filePath);
            if (this.src !== fallback && !this.src.startsWith('asset://')) {
              if (window.appState && window.appState.thumbnailUrls) {
                window.appState.thumbnailUrls.set(filePath, fallback);
              }
              this.src = fallback;
            }
          };
        }
      }
      return;
    }
    // _domByPath に存在しない場合（スクロールで仮想化された範囲外）はスキップ
    // スクロール後に updateVirtualGrid が再レンダリングする際に thumbnailUrls から引かれる
  }
}

window.thumbnailManager = new ThumbnailQueueManager(THUMBNAIL_BATCH_SIZE);
window.processNextTask = () => window.thumbnailManager.processNext();

function clearMetadataUI() {
  const staticTable = document.getElementById('static-file-info-table');
  const emptyInfoMsg = document.getElementById('file-info-empty');
  if (staticTable && emptyInfoMsg) {
    staticTable.style.display = 'none';
    emptyInfoMsg.style.display = 'flex';
  } else {
    const infoContainer = document.getElementById('file-info-content');
    if (infoContainer) {
      infoContainer.innerHTML = '<div class="empty-state-msg"><svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><div>画像を選択してください</div></div>';
    }
  }

  const emptyInspectorMsg = document.getElementById('inspector-empty');
  if (emptyInspectorMsg) {
    emptyInspectorMsg.style.display = 'flex';
    emptyInspectorMsg.className = 'empty-state-msg';
    emptyInspectorMsg.innerHTML = '<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg><div>画像を選択すると詳細が表示されます</div>';
  } else {
    const container = document.getElementById('inspector-content');
    if (container) {
      container.innerHTML = '<div class="empty-state-msg"><svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg><div>画像を選択すると詳細が表示されます</div></div>';
    }
  }

  if (typeof resetInspectorPools === 'function') {
    resetInspectorPools();
  }

  const headerPath = document.getElementById('inspector-header-path');
  if (headerPath) {
    headerPath.style.display = 'none';
  }
}

const scheduleRefresh = debounce(async () => {
  appState.preloadCursor = 0;
  await appState.setViewParams();
  uiManager.renderAll();
  loadAllMetadataInBackground();
  uiManager.updateSelectionUI();
  if (appState.selectedIndex === -1) {
    clearMetadataUI();
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
    icon.style.color = '#4da8da';
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

async function getPathsFromDragEventAsync(e) {
  if (appState.dragState.paths && appState.dragState.paths.length > 0) {
    return [...appState.dragState.paths];
  }

  const indicesStr = e.dataTransfer.getData('application/json-indices');
  if (indicesStr) {
    try {
      const indices = JSON.parse(indicesStr);
      if (indices && indices.length > 0 && window.veloceAPI.getFilesByIndices) {
        const files = await window.veloceAPI.getFilesByIndices(indices);
        if (files) return files.map(f => f.path);
      }
    } catch (err) { }
  }

  const paths = [];
  const folderDataStr = e.dataTransfer.getData('application/json-folder');
  if (folderDataStr) {
    try {
      const folderData = JSON.parse(folderDataStr);
      if (folderData && folderData.path) return [folderData.path];
    } catch (err) { }
  }

  const jsonData = e.dataTransfer.getData('application/json');
  if (jsonData) {
    try {
      const parsed = JSON.parse(jsonData);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) { }
  }

  const sourcePath = e.dataTransfer.getData('text/plain');
  if (sourcePath) {
    let cleanPath = decodeURIComponent(sourcePath).trim();
    cleanPath = cleanPath.replace(/^file:(?:\/|\\)*/i, '');
    if (!cleanPath.match(/^[A-Za-z]:/)) cleanPath = '/' + cleanPath;
    paths.push(cleanPath);
  }
  return paths;
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
      if (appState.sortConfig.key === key) {
        th.innerHTML = TABLE_HEADERS[key] + (appState.sortConfig.asc ? UIManager.ICONS.SORT_ASC : UIManager.ICONS.SORT_DESC);
      } else {
        th.textContent = TABLE_HEADERS[key];
      }
    }
  });
}

async function selectImage(index, event = null) {
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

  const file = await window.veloceAPI.getFileByIndex(index);

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
    const theadHeight = document.querySelector('#file-table thead')?.getBoundingClientRect().height || 28;
    const targetY = theadHeight + (index * rowHeight);

    // ヘッダーが position: sticky; top: 0; であるため、表示領域の上端は scrollTop + theadHeight
    if (targetY < listContainer.scrollTop + theadHeight) {
      listContainer.scrollTop = targetY - theadHeight;
    } else if (targetY + rowHeight > listContainer.scrollTop + listContainer.clientHeight) {
      listContainer.scrollTop = targetY + rowHeight - listContainer.clientHeight;
    }
  }


  // インスペクターの更新
  if (file) renderMetadata(file);
}

async function openViewer(index) {
  const file = await window.veloceAPI.getFileByIndex(index);

  // IPC通信の遅延を回避するため、初期表示用のデータを LocalStorage に保存して直接渡す
  if (file) {
    localStorage.setItem('viewerInitialData', JSON.stringify({
      path: file.path,
      total: appState.totalCount
    }));

    // パス配列はRust側にあるため転送不要
    localStorage.removeItem('viewerPaths');
    localStorage.removeItem('viewerStartIndex');
  }

  window.veloceAPI.openViewer({
    currentIndex: index,
    width: file ? file.width : 0,
    height: file ? file.height : 0,
    monitorWidth: window.screen.availWidth,
    monitorHeight: window.screen.availHeight
  });
}

function parseLicenseMarkdown(text) {
  if (!text) return '';

  let html = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = html.split('\n');
  let processedLines = [];
  let bqBuffer = [];

  for (let line of lines) {
    const bqMatch = line.match(/^\s*&gt;\s?(.*)$/);
    if (bqMatch) {
      bqBuffer.push(bqMatch[1]);
    } else {
      if (bqBuffer.length > 0) {
        processedLines.push(`<blockquote class="md-blockquote">${bqBuffer.join('<br>')}</blockquote>`);
        bqBuffer = [];
      }
      processedLines.push(line);
    }
  }
  if (bqBuffer.length > 0) {
    processedLines.push(`<blockquote class="md-blockquote">${bqBuffer.join('<br>')}</blockquote>`);
  }
  html = processedLines.join('\n');

  html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/gm, '<strong>$1</strong>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\s+(.*)$/gm, '<li class="md-list-item">$1</li>');
  html = html.replace(/(?:<li class="md-list-item">.*?<\/li>\n?)+/g, match => {
    return `<ul class="md-list">${match.replace(/\n/g, '')}</ul>`;
  });

  const tags = 'h1|h2|h3|ul|li|blockquote|hr';
  html = html.replace(new RegExp(`\\n+(<\\/?(?:${tags})[^>]*>)`, 'gi'), '$1');
  html = html.replace(new RegExp(`(<\\/?(?:${tags})[^>]*>)\\n+`, 'gi'), '$1');

  // URL文字列をリンクに変換（すでに href="..." 等になっているものは除外）
  html = html.replace(/(?<!href=["'])(https?:\/\/[^\s&<"'>\)]+)/g, '<a href="$1">$1</a>');

  html = html.replace(/\n/g, '<br>');

  return html;
}

async function showLicenseDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'license-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  overlay.style.zIndex = '10000';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';

  const content = document.createElement('div');
  content.style.backgroundColor = 'var(--panel-bg)';
  content.style.padding = '24px';
  content.style.borderRadius = 'var(--radius-lg)';
  content.style.border = '1px solid #0d1315';
  content.style.width = '85%';
  content.style.maxWidth = '850px';
  content.style.height = '80%';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.boxShadow = 'var(--modal-shadow)';
  content.style.cursor = 'default';

  let licenseText = "ライセンス情報を読み込み中";
  try {
    if (window.__TAURI__ && window.__TAURI__.invoke) {
      licenseText = await window.__TAURI__.invoke('get_license_text');
    } else if (window.veloceAPI && window.veloceAPI.getLicenseText) {
      licenseText = await window.veloceAPI.getLicenseText();
    }
  } catch (e) {
    console.error("Failed to load licenses:", e);
    licenseText = "ライセンス情報の読み込みに失敗しました。";
  }

  const combinedText = licenseText;

  const parsedText = parseLicenseMarkdown(combinedText);

  content.innerHTML = `
    <h2 style="margin: 0 0 20px 0; color: var(--glow-gold); font-size: 1.2em;">ライセンス情報</h2>
    <div id="license-text" style="flex: 1; overflow-y: auto; background-color: rgba(0, 0, 0, 0.2); padding: 0px 20px 20px 20px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color); font-family: sans-serif; white-space: normal; font-size: 14px; line-height: 1.6;">${parsedText}</div>
  `;

  // リンクのクリック処理（アプリ内遷移を防ぎ、OS標準のブラウザで開く）
  content.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = a.href;
      if (window.__TAURI__ && window.__TAURI__.shell && window.__TAURI__.shell.open) {
        await window.__TAURI__.shell.open(url);
      } else {
        window.open(url, '_blank');
      }
    });
  });

  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', keydownHandler, true);
  };

  const keydownHandler = (e) => {
    // Escキー、またはF1/Hキーでライセンス画面を閉じる
    if (e.key === 'Escape' || e.key === 'F1' || e.key.toLowerCase() === 'h') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();

      // F1/Hキーの場合は背後のヘルプ画面も一緒に閉じる
      if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
        const helpOverlay = document.getElementById('help-overlay');
        if (helpOverlay) {
          helpOverlay.remove();
        }
      }
    }
  };

  document.addEventListener('keydown', keydownHandler, true);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });

  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

function toggleHelpOverlay(forceShow) {
  const licenseOverlay = document.getElementById('license-overlay');
  if (licenseOverlay) {
    licenseOverlay.remove();
  }

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
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';
  overlay.style.color = '#fff';
  overlay.style.cursor = 'pointer';

  const content = document.createElement('div');
  content.className = 'help-modal-content';
  content.style.cursor = 'default';

  content.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-shrink: 0;">
      <h2 style="margin: 0; color: var(--glow-gold); font-size: 1.2em; border-bottom: none;">ヘルプ・ショートカット一覧</h2>
      <span id="license-link" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; border: 1px solid var(--modal-border); border-radius: 20px; color: var(--text-color); font-size: 0.85em; cursor: pointer; transition: all 0.2s ease; background-color: rgba(0, 0, 0, 0.2);"
        onmouseover="this.style.backgroundColor='rgba(37, 126, 140, 0.15)'; this.style.borderColor='var(--accent-color)'; this.style.color='#fff';"
        onmouseout="this.style.backgroundColor='rgba(0, 0, 0, 0.2)'; this.style.borderColor='var(--modal-border)'; this.style.color='var(--text-color)';">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="8" r="7"></circle>
          <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>
        </svg>
        ライセンス ＆ クレジット
      </span>
    </div>

    <div class="help-tabs">
      <div class="help-tab active" data-target="help-main">メイン画面</div>
      <div class="help-tab" data-target="help-viewer">ビューワー画面</div>
    </div>

    <div id="help-main" class="help-tab-content active">
      <h3 class="help-group-title">ナビゲーション・選択</h3>
      <table class="help-table">
        <tr><td><kbd>矢印キー</kbd></td><td>画像の選択を移動（Shift 併用で範囲選択）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>A</kbd></td><td>現在のフォルダ内のすべての画像を選択</td></tr>
        <tr><td><kbd>Ctrl</kbd> / <kbd>Shift</kbd> + クリック</td><td>画像の複数選択</td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd></td><td>フォルダ移動履歴の「戻る」 / 「進む」</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Tab</kbd> / <kbd>PageDown</kbd></td><td>次のタブへ切り替え</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> / <kbd>PageUp</kbd></td><td>前のタブへ切り替え</td></tr>
      </table>

      <h3 class="help-group-title">ファイル操作</h3>
      <table class="help-table">
        <tr><td><kbd>ダブルクリック</kbd> / <kbd>Enter</kbd></td><td>選択したサムネイルから独立ビューアーを開く</td></tr>
        <tr><td><kbd>F2</kbd></td><td>選択中のファイル/フォルダの名前を変更</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>選択中のファイル/フォルダを安全にゴミ箱へ移動</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>C</kbd></td><td>選択中の画像をクリップボードにコピー</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td><td>直前のファイル/フォルダ名の変更を元に戻す</td></tr>
        <tr><td><kbd>0</kbd> 〜 <kbd>5</kbd></td><td>選択中の画像にレーティング（星の数）を設定 / 解除</td></tr>
      </table>

      <h3 class="help-group-title">ツール・表示</h3>
      <table class="help-table">
        <tr><td><kbd>F5</kbd></td><td>最新の情報に更新（再読み込み）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>F</kbd></td><td>検索キーワード入力欄にフォーカス</td></tr>
        <tr><td><kbd>A</kbd></td><td>開いているビューアーウィンドウを横一列に整列</td></tr>
        <tr><td><kbd>D</kbd></td><td>選択した2枚の画像の情報を比較 (Diffモーダル)</td></tr>
        <tr><td><kbd>F1</kbd> / <kbd>H</kbd></td><td>ヘルプの表示 / 非表示</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>各種モーダル・ヘルプ・メニューを閉じる</td></tr>
      </table>
    </div>

    <div id="help-viewer" class="help-tab-content">
      <h3 class="help-group-title">画像切り替え</h3>
      <table class="help-table">
        <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>前の画像 / 次の画像を表示</td></tr>
        <tr><td>左クリック / 右クリック</td><td>前の画像 / 次の画像を表示</td></tr>
        <tr><td>マウスホイール</td><td>上スクロールで前 / 下スクロールで次を表示</td></tr>
      </table>

      <h3 class="help-group-title">ズーム・移動</h3>
      <table class="help-table">
        <tr><td><kbd>Ctrl</kbd> + ホイール</td><td>画像のズームイン / ズームアウト</td></tr>
        <tr><td>左ドラッグ</td><td>ウィンドウの移動 / スクロール（ズーム時）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + 左ドラッグ</td><td>ズームイン時、画像内を自由にパン移動</td></tr>
        <tr><td><kbd>F</kbd></td><td>100%表示（モニターより大きい画像はリサイズ）</td></tr>
        <tr><td><kbd>Space</kbd></td><td>完全な100%等倍ウィンドウ表示（画面外許可）</td></tr>
      </table>

      <h3 class="help-group-title">変形・フィルター</h3>
      <table class="help-table">
        <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>右に90度回転 / 左に90度回転</td></tr>
        <tr><td><kbd>H</kbd></td><td>画像を左右反転（水平反転）</td></tr>
        <tr><td><kbd>V</kbd></td><td>画像を上下反転（垂直反転）</td></tr>
        <tr><td><kbd>U</kbd></td><td>シャープ表示 / 滑らか表示の切り替え</td></tr>
      </table>

      <h3 class="help-group-title">ウィンドウ・操作</h3>
      <table class="help-table">
        <tr><td><kbd>F11</kbd></td><td>フルスクリーン表示切り替え</td></tr>
        <tr><td><kbd>A</kbd></td><td>すべてのビューアーを横一列に整列</td></tr>
        <tr><td><kbd>B</kbd></td><td>ウィンドウ枠（ボーダー）・UIの表示切替</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>画像をゴミ箱に移動し、次の画像を表示</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>C</kbd></td><td>表示中の画像をクリップボードにコピー</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>ビューワーウィンドウを閉じる</td></tr>
      </table>
    </div>
  `;

  const tabs = content.querySelectorAll('.help-tab');
  const tabContents = content.querySelectorAll('.help-tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.target;
      content.querySelector('#' + targetId).classList.add('active');
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('#license-link')) {
      showLicenseDialog();
      return;
    }
    if (!e.target.closest('.help-modal-content')) {
      toggleHelpOverlay(false);
    }
  });

  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

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
    menu.style.position = 'fixed';
    menu.style.zIndex = '10001';
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
    const { displayName, iconHtml, iconColor } = resolvePathDisplay(fav, item.path);

    menuItem.innerHTML = `
      <span class="menu-icon" style="color: ${iconColor}; display: inline-flex; align-items: center;">${iconHtml}</span>
      <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayName}</span>
    `;
    menuItem.title = item.path; // ホバーでフルパス表示

    // 履歴クリック時の移動処理
    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      const offset = item.index - tab.historyIndex; // 目的のインデックスまでの差分を計算
      navigateHistory(offset);
      menu.style.display = 'none';
    });

    menu.appendChild(menuItem);
  });

  // メニューの位置をボタンの下に設定
  const btnRect = btnElement.getBoundingClientRect();
  menu.style.left = `${btnRect.left}px`;
  menu.style.top = `${btnRect.bottom + 4}px`;
  menu.style.display = 'block';
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

/**
 * 指定されたファイルのメタデータをインスペクターに描画します。
 * Diff画面と同一のデザイン、項目順、コピー機能を提供します。
 */
// --- DOM Pool for Inspector ---
const inspectorSectionPool = [];
const inspectorTagPool = [];
let inspectorSectionIndex = 0;
let inspectorTagIndex = 0;
let _inspectorDelegationInit = false;

function getInspectorSection() {
  if (inspectorSectionIndex < inspectorSectionPool.length) {
    const el = inspectorSectionPool[inspectorSectionIndex++];
    el.root.style.display = 'block';
    return el;
  }
  const section = document.createElement('div');
  section.className = 'inspector-section';
  section.style.marginBottom = '15px';

  const h3 = document.createElement('h3');
  h3.style.fontSize = 'var(--font-size-xs)';
  h3.style.fontWeight = 'normal';
  h3.style.marginTop = '0';
  h3.style.marginBottom = '4px';
  h3.style.display = 'flex';
  h3.style.justifyContent = 'space-between';
  h3.style.alignItems = 'center';
  h3.style.color = 'var(--text-color)';
  h3.style.transition = 'color 0.2s';
  h3.style.userSelect = 'none';

  const titleWrapper = document.createElement('span');
  titleWrapper.style.display = 'flex';
  titleWrapper.style.alignItems = 'center';
  titleWrapper.style.gap = '8px';

  const titleSpan = document.createElement('span');
  const subLabelSpan = document.createElement('span');

  titleWrapper.appendChild(titleSpan);
  titleWrapper.appendChild(subLabelSpan);

  const copyWrapper = document.createElement('div');

  h3.appendChild(titleWrapper);
  h3.appendChild(copyWrapper);

  const box = document.createElement('div');
  box.tabIndex = -1;

  section.appendChild(h3);
  section.appendChild(box);

  const elObj = {
    root: section,
    title: titleSpan,
    subLabel: subLabelSpan,
    copyWrapper: copyWrapper,
    box: box
  };

  inspectorSectionPool.push(elObj);
  inspectorSectionIndex++;
  return elObj;
}

function getInspectorTag() {
  if (inspectorTagIndex < inspectorTagPool.length) {
    const el = inspectorTagPool[inspectorTagIndex++];
    el.style.display = 'inline';
    return el;
  }
  const span = document.createElement('span');
  span.className = 'diff-tag common';
  inspectorTagPool.push(span);
  inspectorTagIndex++;
  return span;
}

function resetInspectorPools() {
  for (let i = 0; i < inspectorSectionIndex; i++) {
    inspectorSectionPool[i].root.style.display = 'none';
    inspectorSectionPool[i].box.replaceChildren();
  }
  inspectorSectionIndex = 0;
  inspectorTagIndex = 0;
}

async function renderMetadata(file) {
  const container = document.getElementById('inspector-content');
  const emptyInspectorMsg = document.getElementById('inspector-empty');
  if (!file || !container) return;

  try {
    const rawMeta = await window.veloceAPI.parseMetadata(file.path);
    const meta = rawMeta || {};


    const d = extractMetadataFields(file, meta);

    let searchStr = '';
    if (uiManager.elements.searchBar?.value) {
      searchStr = uiManager.elements.searchBar.value;
    } else if (typeof appState !== 'undefined' && appState.searchQuery) {
      searchStr = appState.searchQuery;
    }
    const terms = searchStr.trim() !== ''
      ? searchStr.toLowerCase().split(/[,\n\r]+/).map(t => t.trim()).filter(Boolean)
      : [];

    resetInspectorPools();
    if (emptyInspectorMsg) emptyInspectorMsg.style.display = 'none';

    let badge = container.querySelector('.inspector-location-badge');
    if (badge) badge.remove();

    const headerPath = document.getElementById('inspector-header-path');
    if (headerPath) {
      if (file.path) {
        const filePathStr = String(file.path);
        const lastSlash = Math.max(filePathStr.lastIndexOf('\\'), filePathStr.lastIndexOf('/'));
        const dirPath = lastSlash !== -1 ? filePathStr.substring(0, lastSlash) : filePathStr;
        const escapedPath = dirPath.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        headerPath.innerHTML = `<bdi dir="ltr" style="opacity: 0.9;">${escapedPath}</bdi>`;
        headerPath.setAttribute('data-path', file.path);
        headerPath.removeAttribute('title');
        headerPath.style.display = 'block';
      } else {
        headerPath.style.display = 'none';
      }
    }

    let hasContent = false;
    const sections = buildInspectorSections(d);

    for (const section of sections) {
      if (!section.value || section.value === '-') continue;
      hasContent = true;

      const secEl = getInspectorSection();
      secEl.title.textContent = section.title;

      let copyHtml = UIManager.createCopyButtonHTML(section.value);
      secEl.copyWrapper.innerHTML = copyHtml;

      let sectionHasMatch = false;

      if (section.isRaw) {
        secEl.box.className = 'prompt-look';
        secEl.box.style.whiteSpace = 'pre-wrap';
        secEl.box.style.fontFamily = 'Consolas, monospace';
        secEl.box.style.fontSize = 'var(--font-size-xs)';
        secEl.box.style.wordBreak = 'break-all';
        secEl.box.style.maxHeight = '400px';
        secEl.box.style.overflowY = 'auto';
        const rawText = String(section.value);
        if (terms.length > 0) {
          sectionHasMatch = terms.some(term => rawText.toLowerCase().includes(term));
          if (sectionHasMatch) {
            secEl.box.innerHTML = highlightSearchTerms(rawText, terms);
          } else {
            secEl.box.textContent = rawText;
          }
        } else {
          secEl.box.textContent = rawText;
        }
      } else {
        secEl.box.className = section.isParam ? 'prompt-look param-box' : 'prompt-look';
        secEl.box.style.cssText = '';

        const tags = section.isParam ? [String(section.value)] : String(section.value).split(/[,\n\r]+/).map(t => t.trim()).filter(t => t);
        for (const t of tags) {
          const tagEl = getInspectorTag();
          if (terms.length > 0) {
            const isMatch = terms.some(term => t.toLowerCase().includes(term));
            if (isMatch) {
              sectionHasMatch = true;
              tagEl.style.border = '1px solid #ffcc00';
              tagEl.style.backgroundColor = 'rgba(255, 204, 0, 0.25)';
              tagEl.style.color = '#ffcc00';
              tagEl.style.boxShadow = '0 0 8px rgba(255,204,0,0.3)';
            } else {
              tagEl.style.cssText = '';
            }
            tagEl.innerHTML = highlightSearchTerms(t, terms);
          } else {
            tagEl.style.cssText = '';
            tagEl.textContent = t;
          }
          secEl.box.appendChild(tagEl);
        }
      }

      if (sectionHasMatch) {
        secEl.title.style.color = 'var(--glow-gold)';
      } else {
        secEl.title.style.color = '';
      }

      if (section.subLabel && section.subLabel !== 'Text to Image') {
        const labels = section.subLabel.split(' + ');
        secEl.subLabel.innerHTML = '';
        secEl.subLabel.style.display = 'flex';
        secEl.subLabel.style.gap = '4px';
        secEl.subLabel.style.alignItems = 'center';
        secEl.subLabel.style.flexWrap = 'wrap';

        labels.forEach(lbl => {
          let color = 'var(--text-color)';
          let opacity = '1';
          if (lbl.includes('Inpainting')) {
            color = '#4a9eff';
          } else if (lbl.includes('Vibe Transfer')) {
            color = '#d27aff';
          } else if (lbl.includes('Character Reference')) {
            color = '#ff9a4a';
          } else if (lbl.includes('Image to Image') || lbl.includes('Img2Img')) {
            color = '#4ade80';
          }
          const span = document.createElement('span');
          span.style.fontSize = 'var(--font-size-xs)';
          span.style.color = color;
          span.style.opacity = opacity;
          span.style.fontWeight = 'normal';
          span.textContent = `[${lbl}]`;
          secEl.subLabel.appendChild(span);
        });
      } else {
        secEl.subLabel.innerHTML = '';
        secEl.subLabel.style.display = '';
      }

      if (secEl.root.parentNode !== container) {
        container.appendChild(secEl.root);
      }
    }

    if (!hasContent) {
      const rawMetaStr = JSON.stringify(meta, null, 2);
      if (rawMetaStr !== '{}' && rawMetaStr !== 'null') {
        const secEl = getInspectorSection();
        secEl.title.textContent = '未対応のメタデータ形式';
        secEl.copyWrapper.innerHTML = '';
        secEl.subLabel.textContent = '';
        secEl.box.className = 'prompt-look';
        secEl.box.style.whiteSpace = 'pre-wrap';
        secEl.box.style.fontFamily = 'Consolas, monospace';
        secEl.box.style.fontSize = 'var(--font-size-xs)';
        secEl.box.style.wordBreak = 'break-all';
        secEl.box.style.maxHeight = '400px';
        secEl.box.style.overflowY = 'auto';
        secEl.box.textContent = rawMetaStr;
        if (secEl.root.parentNode !== container) container.appendChild(secEl.root);
      } else {
        if (emptyInspectorMsg) {
          emptyInspectorMsg.className = 'empty-state-msg';
          emptyInspectorMsg.innerHTML = '<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg><div>メタデータが含まれていないか、読み取れませんでした。</div>';
          emptyInspectorMsg.style.display = 'flex';
        }
      }
    }

    if (!_inspectorDelegationInit) {
      _inspectorDelegationInit = true;
      const delegationRoot = document.getElementById('right-pane') || container;
      delegationRoot.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.diff-copy-btn');
        if (copyBtn) {
          const text = copyBtn.getAttribute('data-copy-text');
          if (text) {
            await navigator.clipboard.writeText(text);
            if (window.uiManager) window.uiManager.showToast("クリップボードにコピーしました", 3000, null, 'success');
            else showNotification("クリップボードにコピーしました", 'success');
            uiManager.applyGlowEffect(copyBtn);
            uiManager.hideCustomTooltip();
          }
        }
      });
      delegationRoot.addEventListener('mousemove', (e) => {
        const copyBtn = e.target.closest('.diff-copy-btn');
        if (copyBtn) {
          uiManager.showCustomTooltip('コピー', e.clientX, e.clientY);
        } else {
          uiManager.hideCustomTooltip();
        }
      });
      delegationRoot.addEventListener('mouseleave', () => {
        uiManager.hideCustomTooltip();
      }, true);

      delegationRoot.addEventListener('contextmenu', (e) => {
        const openBtn = e.target.closest('.open-folder-btn');
        if (openBtn) {
          e.preventDefault();
          e.stopPropagation();

          const filePathStr = openBtn.getAttribute('data-path');
          if (!filePathStr) return;

          const lastSlash = Math.max(filePathStr.lastIndexOf('\\'), filePathStr.lastIndexOf('/'));
          const dirPath = lastSlash !== -1 ? filePathStr.substring(0, lastSlash) : filePathStr;
          const folderName = dirPath.split(/[\\/]/).pop() || dirPath;

          contextMenu.targetFavoriteId = null;
          contextMenu.targetFavoritePath = null;
          contextMenu.targetSmartFolderId = null;
          contextMenu.targetFolderElement = null;
          contextMenu.targetFolder = { path: dirPath, name: folderName };
          contextMenu.isRoot = false;

          Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

          menuOpenInNewTab.style.display = '';
          menuOpenInExplorer.style.display = '';
          menuCopyPath.style.display = '';

          showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
        }
      });

      delegationRoot.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (selection.isCollapsed) return;
        const promptLook = e.target.closest('.prompt-look');
        if (!promptLook) return;

        const clone = selection.getRangeAt(0).cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(clone);
        const tags = tempDiv.querySelectorAll('.diff-tag');
        tags.forEach(tag => { tag.textContent = tag.textContent + ", "; });
        let copiedText = tempDiv.textContent.replace(/,\s*$/, '').trim();
        e.clipboardData.setData('text/plain', copiedText);
        e.preventDefault();
      });
    }
  } catch (error) {
    if (container) {
      container.innerHTML = `<div style="color:var(--danger-red); padding:10px; font-size:0.9em; border:1px solid var(--danger-red);">描画エラー: ${error.message}</div>`;
    }
  }
}


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
      appState.thumbnailUrls.forEach(url => {
        if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
      appState.thumbnailUrls.clear();
      appState.thumbnailTotalRequested = 0;
      appState.thumbnailCompleted = 0;
      uiManager.showToast('キャッシュの再構築が完了しました', 3000, 'rebuild-folder', 'success');
      await refreshFileList(true);
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
  ${UIManager.ICONS.SORT || '<div style="width:16px;height:16px;"></div>'}
  <span style="text-align: left; white-space: nowrap;">並べ替え</span>
  <span></span>
  <span style="display: inline-flex; align-items: center; justify-content: flex-end; opacity: 0.7;">${UIManager.ICONS.CHEVRON_RIGHT}</span>
`;

menuSortRoot.onmouseenter = () => {
  // Reset position
  sortSubmenu.style.left = 'calc(100% + 2px)';
  sortSubmenu.style.right = 'auto';
  sortSubmenu.style.top = '-7px';
  sortSubmenu.style.bottom = 'auto';

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
  contextMenu.style.display = 'none';
};

const createSubOption = (label, onClick, dataKey, dataVal) => {
  const opt = document.createElement('div');
  opt.className = 'context-menu-item';
  if (dataKey === 'sortKey') opt.dataset.sortKey = dataVal;
  if (dataKey === 'sortOrder') opt.dataset.sortOrder = dataVal;

  opt.innerHTML = `
    <span class="menu-check" style="display:inline-flex;justify-content:center;align-items:center;width:16px;height:16px;"></span>
    <span style="text-align: left; white-space: nowrap;">${label}</span>
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

let sfModalDelegated = false;

function updateSmartFolderRowUI(row, type, initialCond = null) {
  const operatorSelect = row.querySelector('.cond-operator');
  const valueContainer = row.querySelector('.cond-value-container');

  const opVal = initialCond ? initialCond.operator : null;
  const valVal = initialCond ? initialCond.value : '';

  function makeOptions(ops) {
    return ops.map(o => `<option value="${o.value}" ${o.value === opVal ? 'selected' : ''}>${o.label}</option>`).join('');
  }

  if (type === 'prompt' || type === 'negative_prompt') {
    operatorSelect.innerHTML = makeOptions([
      { value: 'contains', label: 'を含む' },
      { value: 'not_contains', label: 'を含まない' }
    ]);
    valueContainer.innerHTML = `<input type="text" class="cond-value-input dialog-input" style="flex:1" placeholder="キーワード">`;
    valueContainer.querySelector('input').value = valVal;
  } else if (type === 'source') {
    operatorSelect.innerHTML = makeOptions([
      { value: '==', label: 'と一致' },
      { value: '!=', label: 'と一致しない' }
    ]);
    valueContainer.innerHTML = `<input type="text" class="cond-value-input dialog-input" style="flex:1" placeholder="生成元">`;
    valueContainer.querySelector('input').value = valVal;
  } else if (type === 'width' || type === 'height') {
    operatorSelect.innerHTML = makeOptions([
      { value: '<=', label: '以下' },
      { value: '==', label: 'ちょうど' },
      { value: '>=', label: '以上' }
    ]);
    valueContainer.innerHTML = `<input type="number" class="cond-value-input dialog-input" style="flex:1" min="0">`;
    valueContainer.querySelector('input').value = valVal || 0;
  } else if (type === 'rating') {
    operatorSelect.innerHTML = makeOptions([
      { value: '>=', label: '以上' },
      { value: '<=', label: '以下' },
      { value: '==', label: 'と一致' }
    ]);
    valueContainer.innerHTML = `<input type="number" class="cond-value-input dialog-input" style="flex:1" min="0" max="5">`;
    valueContainer.querySelector('input').value = valVal || 0;
  } else if (type === 'aspect_ratio') {
    operatorSelect.innerHTML = makeOptions([
      { value: 'portrait', label: '縦長' },
      { value: 'landscape', label: '横長' },
      { value: 'square', label: '正方形' }
    ]);
    valueContainer.innerHTML = `<div style="flex:1"></div><input type="hidden" class="cond-value-input" value="">`;
  } else if (type === 'path') {
    operatorSelect.innerHTML = makeOptions([
      { value: 'in_folder', label: '直下のみ' },
      { value: 'under_folder', label: 'サブフォルダ含む' }
    ]);
    valueContainer.innerHTML = `
      <input type="text" class="cond-value-input dialog-input" style="flex:1">
      <button type="button" class="btn-browse-path dialog-btn" style="padding: 8px 12px;">参照...</button>
    `;
    valueContainer.querySelector('input').value = valVal;
  }
}

function showEditSmartFolderModal(sf, isNew = false) {
  const modal = document.getElementById('edit-smart-folder-modal');
  const container = document.getElementById('smart-icon-selector');
  const getIconData = createFavoriteEditorUI(container, sf.icon || 'FAV_STAR', sf.color || 'orange');

  const nameInput = document.getElementById('smart-name-input');
  nameInput.value = sf.name || '';

  const conditionsList = document.getElementById('smart-conditions-list');

  const template = document.getElementById('sf-condition-template');
  const fragment = document.createDocumentFragment();
  const conds = Array.isArray(sf.conditions) ? sf.conditions : [];

  conds.forEach(cond => {
    const clone = template.content.cloneNode(true);
    const row = clone.querySelector('.sf-condition-row');
    const typeSel = row.querySelector('.cond-type');
    typeSel.value = cond.type;
    updateSmartFolderRowUI(row, cond.type, cond);
    fragment.appendChild(clone);
  });
  conditionsList.replaceChildren(fragment);

  if (!sfModalDelegated) {
    sfModalDelegated = true;

    modal.addEventListener('click', async (e) => {
      if (e.target.closest('.btn-remove-cond')) {
        const row = e.target.closest('.sf-condition-row');
        if (row) row.remove();
      }

      if (e.target.closest('#smart-add-condition-btn')) {
        const clone = template.content.cloneNode(true);
        const row = clone.querySelector('.sf-condition-row');
        const list = document.getElementById('smart-conditions-list');
        list.appendChild(clone);
        const newRow = list.lastElementChild;
        newRow.querySelector('.cond-type').value = 'rating';
        updateSmartFolderRowUI(newRow, 'rating', { operator: '>=', value: '4' });
      }

      if (e.target.closest('.btn-browse-path')) {
        const row = e.target.closest('.sf-condition-row');
        const input = row.querySelector('.cond-value-input');
        if (window.veloceAPI && window.veloceAPI.openFolderDialog) {
          const folder = await window.veloceAPI.openFolderDialog();
          if (folder) input.value = folder;
        }
      }
    });

    modal.addEventListener('change', (e) => {
      if (e.target.classList.contains('cond-type')) {
        const row = e.target.closest('.sf-condition-row');
        updateSmartFolderRowUI(row, e.target.value);
      }
    });
  }

  const saveBtn = document.getElementById('smart-save-btn');
  const cancelBtn = document.getElementById('smart-cancel-btn');

  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  newCancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    modal.style.display = 'none';
  });

  newSaveBtn.addEventListener('click', async () => {
    const rules = [];
    const rows = conditionsList.querySelectorAll('.sf-condition-row');
    for (const row of rows) {
      const type = row.querySelector('.cond-type').value;
      const operator = row.querySelector('.cond-operator').value;
      const valInput = row.querySelector('.cond-value-input');
      const value = valInput ? valInput.value.trim() : '';

      if (value === '' && type !== 'aspect_ratio' && type !== 'rating') {
        continue;
      }

      rules.push({ type, operator, value });
    }

    const data = getIconData();
    sf.icon = data.icon;
    sf.color = data.color;
    sf.name = nameInput.value || '無題のスマートフォルダ';
    sf.conditions = rules;
    sf.matchType = 'all';

    if (isNew) {
      sf.id = 'smart_' + Date.now();
    }
    // 2. データの保存とRustへの同期（バックグラウンドで完了する）
    appState.smartFolders = await SmartFolderStore.upsertFolder(sf);

    // 3. UIの差分更新
    if (isNew) {
      const listContainer = document.getElementById('smart-folders-list');
      if (listContainer) listContainer.appendChild(createSmartFolderNode(sf));
    } else {
      const oldNode = document.querySelector(`.smart-folder-item[data-id="${sf.id}"]`);
      if (oldNode) {
        const newNode = createSmartFolderNode(sf);
        if (oldNode.classList.contains('selected')) {
          newNode.classList.add('selected');
        }
        oldNode.replaceWith(newNode);
      }
    }

    // 4. ダイアログを閉じる
    modal.style.display = 'none';

    if (appState.currentDirectory === 'smart://' + sf.id) {
      refreshFileList(true);
    }

    // 作成・更新後に件数を再計算して表示
    updateSmartFolderCountsUI();
  });

  modal.style.display = 'flex';
}

const menuAddSmartFolder = createMenuItem('スマートフォルダを追加...', UIManager.ICONS.FOLDER_PLUS, () => {
  showEditSmartFolderModal({ name: '', icon: 'FAV_STAR', color: 'orange', conditions: [] }, true);
});

const menuEditSmartFolder = createMenuItem('スマートフォルダを編集...', UIManager.ICONS.EDIT, () => {
  if (!contextMenu.targetSmartFolderId) return;
  const sf = appState.smartFolders.find(f => f.id === contextMenu.targetSmartFolderId);
  if (sf) {
    showEditSmartFolderModal(sf, false);
  }
});

const menuDuplicateSmartFolder = createMenuItem('スマートフォルダを複製...', UIManager.ICONS.COPY || '📋', () => {
  if (!contextMenu.targetSmartFolderId) return;
  const sf = appState.smartFolders.find(f => f.id === contextMenu.targetSmartFolderId);
  if (sf) {
    const newName = `${sf.name} (1)`;
    const newSf = {
      name: newName,
      icon: sf.icon,
      color: sf.color,
      conditions: JSON.parse(JSON.stringify(sf.conditions))
    };
    showEditSmartFolderModal(newSf, true);
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
  const fav = appState.favorites.find(f => f.id === contextMenu.targetFavoriteId);
  if (fav) {
    const container = document.getElementById('fav-icon-selector');

    const getFavData = createFavoriteEditorUI(container, fav.icon, fav.color || 'default');

    const saveBtn = document.getElementById('fav-save-btn');
    const cancelBtn = document.getElementById('fav-cancel-btn');

    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.style.display = ''; // 古い非表示設定が残っていれば解除

    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.style.display = ''; // 古い非表示設定が残っていれば解除

    newCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('edit-favorite-modal').style.display = 'none';
    });

    newSaveBtn.addEventListener('click', () => {
      const data = getFavData();
      fav.icon = data.icon;
      fav.color = data.color;
      fav.name = document.getElementById('fav-name-input').value;
      fav.path = document.getElementById('fav-path-input').value;
      localStorage.setItem('favorites', JSON.stringify(appState.favorites));
      renderFavorites();

      let tabUpdated = false;
      appState.tabs.forEach(t => {
        if (t.path === fav.path) {
          t.name = fav.name;
          tabUpdated = true;
        }
      });
      if (tabUpdated) { saveTabsState(); uiManager.renderTabs(); }

      document.getElementById('edit-favorite-modal').style.display = 'none';
    });

    const nameInput = document.getElementById('fav-name-input');
    nameInput.value = fav.name;
    document.getElementById('fav-path-input').value = fav.path;
    contextMenu.editingFavoriteId = fav.id;
    document.getElementById('edit-favorite-modal').style.display = 'flex';
    nameInput.focus();
    nameInput.select();
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

// 1. 開く・パス操作 (OS連携・頻出)
contextMenu.appendChild(menuOpenInNewTab);
contextMenu.appendChild(menuOpenInExplorer);
contextMenu.appendChild(menuTabOpenExplorer);
contextMenu.appendChild(menuTabCopyPath);
contextMenu.appendChild(menuCopyPath);
contextMenu.appendChild(menuReloadFolder);
contextMenu.appendChild(menuPrecacheFolder);
contextMenu.appendChild(menuSeparator1);

// 2. タブ操作 (タブ管理)
contextMenu.appendChild(menuTabDuplicate);
contextMenu.appendChild(menuTabClose);
contextMenu.appendChild(menuTabCloseOthers);
contextMenu.appendChild(menuTabCloseRight);
contextMenu.appendChild(menuSeparator2);

// 3. 新規作成
contextMenu.appendChild(menuNewFolder);
contextMenu.appendChild(menuSeparator3);

// 4. 編集・変更系 (安全)
contextMenu.appendChild(menuRenameFolder);
contextMenu.appendChild(menuRenameFile);
contextMenu.appendChild(menuDiffFiles);
contextMenu.appendChild(menuEditFavorite);
contextMenu.appendChild(menuAddSmartFolder);
contextMenu.appendChild(menuEditSmartFolder);
contextMenu.appendChild(menuDuplicateSmartFolder);

// 5. 削除系
contextMenu.appendChild(menuDeleteFolder);
contextMenu.appendChild(menuDeleteFile);
contextMenu.appendChild(menuDeleteFavorite);
contextMenu.appendChild(menuDeleteSmartFolder);

// 6. キャッシュ操作系
contextMenu.appendChild(menuSeparatorCache);
contextMenu.appendChild(menuRebuildCache);
contextMenu.appendChild(menuRebuildFolderCache);

// 並べ替え (ファイル操作メニュー時に表示)
contextMenu.appendChild(menuSeparatorSort);
contextMenu.appendChild(menuSortRoot);

contextMenu.appendChild(menuSeparator4);

// 6. お気に入り管理
contextMenu.appendChild(menuAddFavorite);
contextMenu.appendChild(menuTabAddFavorite);
document.body.appendChild(contextMenu);

window.onTabContextMenu = (e, index) => {
  e.preventDefault();
  e.stopPropagation();

  contextMenu.targetTabIndex = index;
  const tab = appState.tabs[index];

  // メニューを一度すべて非表示にする
  Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

  menuTabOpenExplorer.style.display = '';
  menuTabCopyPath.style.display = '';
  menuSeparator1.style.display = '';
  menuTabDuplicate.style.display = '';
  menuTabClose.style.display = '';
  menuTabCloseOthers.style.display = '';
  menuTabCloseRight.style.display = '';
  menuSeparator2.style.display = '';
  menuTabAddFavorite.style.display = '';

  // 「お気に入りに追加」の状態制御
  const isFavorite = appState.favorites.some(f => f.path === tab.path);
  if (isFavorite) {
    menuTabAddFavorite.style.opacity = '0.5';
    menuTabAddFavorite.style.pointerEvents = 'none';
    menuTabAddFavorite.disabled = true;
  } else {
    menuTabAddFavorite.style.opacity = '1';
    menuTabAddFavorite.style.pointerEvents = 'auto';
    menuTabAddFavorite.disabled = false;
  }

  // タブが1つしかない場合は閉じる系を無効化する
  if (appState.tabs.length <= 1) {
    menuTabClose.style.opacity = '0.5';
    menuTabClose.style.pointerEvents = 'none';
    menuTabCloseOthers.style.opacity = '0.5';
    menuTabCloseOthers.style.pointerEvents = 'none';
  } else {
    menuTabClose.style.opacity = '1';
    menuTabClose.style.pointerEvents = 'auto';
    menuTabCloseOthers.style.opacity = '1';
    menuTabCloseOthers.style.pointerEvents = 'auto';
  }

  if (index >= appState.tabs.length - 1) {
    menuTabCloseRight.style.opacity = '0.5';
    menuTabCloseRight.style.pointerEvents = 'none';
  } else {
    menuTabCloseRight.style.opacity = '1';
    menuTabCloseRight.style.pointerEvents = 'auto';
  }

  showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
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
  if (typeof contextMenu !== 'undefined' && contextMenu) contextMenu.style.display = 'none';
  if (typeof tabListMenu !== 'undefined' && tabListMenu) tabListMenu.style.display = 'none';
  const historyMenu = document.getElementById('history-menu');
  if (historyMenu) historyMenu.style.display = 'none';
  const overflowMenu = document.getElementById('bookmark-overflow-menu');
  if (overflowMenu) overflowMenu.style.display = 'none';
};

// 全てのマウス・タッチ操作の「キャプチャフェーズ（最優先）」で強制実行する
window.addEventListener('pointerdown', closeAllMenus, true);
window.addEventListener('mousedown', closeAllMenus, true);
window.addEventListener('click', closeAllMenus, true);
window.addEventListener('contextmenu', closeAllMenus, true);

// 各種モーダルの安全な閉じる処理
window.addEventListener('click', (e) => {
  const diffModal = document.getElementById('diff-modal');
  if (diffModal && e.target === diffModal) {
    diffModal.style.display = 'none';
  }
  const favModal = document.getElementById('edit-favorite-modal');
  if (favModal && e.target === favModal) {
    favModal.style.display = 'none';
  }
});

const dragTooltip = document.createElement('div');
dragTooltip.id = 'drag-tooltip';
dragTooltip.className = 'custom-tooltip';
dragTooltip.style.pointerEvents = 'none'; // マウスイベントを吸収してドロップを妨害しないようにする
document.body.appendChild(dragTooltip);

document.addEventListener('dragover', (e) => {
  if (appState.dragState && appState.dragState.isAppDragging) {
    const count = (appState.dragState.indices && appState.dragState.indices.length > 0) ? appState.dragState.indices.length : (appState.dragState.paths ? appState.dragState.paths.length : 0);
    let text = count > 1 ? `${count} 個のアイテム` : `1 個のアイテム`;

    const itemDiv = e.target.closest('#dir-tree .tree-item');
    if (itemDiv && itemDiv.dataset.path) {
      let actionStr = 'コピー';
      if (count > 0) {
        if (e.ctrlKey) {
          actionStr = 'コピー';
        } else if (e.shiftKey) {
          actionStr = '移動';
        } else {
          const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
          const cachedRoot = appState.dragState.cachedRoot || (appState.dragState.paths && appState.dragState.paths.length > 0 ? getRoot(appState.dragState.paths[0]) : null);
          actionStr = cachedRoot === getRoot(itemDiv.dataset.path) ? '移動' : 'コピー';
        }
      }
      const isRoot = itemDiv.dataset.isRoot === 'true';
      const folderName = isRoot ? itemDiv.dataset.path : itemDiv.dataset.name;

      text = count > 1 ? `${count}個のアイテムを「${folderName}」へ${actionStr}` : `「${folderName}」へ${actionStr}`;
    }

    dragTooltip.innerHTML = `<span style="display: inline-flex; align-items: center; gap: 6px;"><span style="color: var(--accent-color); width: 14px; height: 14px;">${UIManager.ICONS.COPY}</span>${text}</span>`;
    dragTooltip.style.left = (e.clientX + 15) + 'px';
    dragTooltip.style.top = (e.clientY + 15) + 'px';
    dragTooltip.classList.add('show');
  }
});

document.addEventListener('dragend', async () => {
  dragTooltip.classList.remove('show');
  appState.dragState.paths = [];
  appState.dragState.indices = [];
  appState.dragState.cachedRoot = null;
  appState.dragState.isAppDragging = false;

  if (appState.dragState.pendingRefresh) {
    appState.dragState.pendingRefresh = false;
    await refreshFileList();
  }
});

function handleItemClick(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  selectImage(parseInt(item.dataset.index, 10), e);
}

function handleItemDblClick(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  openViewer(parseInt(item.dataset.index, 10));
}

function handleItemDragStart(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) selectImage(index);

  const selectedIndices = Array.from(appState.selection);
  e.dataTransfer.setData('application/json-indices', JSON.stringify(selectedIndices));
  if (item.dataset.filepath) {
    e.dataTransfer.setData('text/plain', item.dataset.filepath);
  }
  e.dataTransfer.effectAllowed = 'copyMove';

  e.dataTransfer.setDragImage(emptyDragImage, 0, 0);

  const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
  appState.dragState.paths = []; // dropped paths will be fetched async
  appState.dragState.indices = selectedIndices;
  appState.dragState.isAppDragging = true;
  appState.dragState.cachedRoot = getRoot(item.dataset.filepath || '');

  const count = selectedIndices.length;
  const text = count > 1 ? `${count} 個のアイテム` : `1 個のアイテム`;
  dragTooltip.innerHTML = `<span style="display: inline-flex; align-items: center; gap: 6px;"><span style="color: var(--accent-color); width: 14px; height: 14px;">${UIManager.ICONS.COPY}</span>${text}</span>`;
  dragTooltip.style.left = (e.clientX + 15) + 'px';
  dragTooltip.style.top = (e.clientY + 15) + 'px';
  dragTooltip.classList.add('show');
}

function handleItemContextMenu(e, isGrid) {
  e.preventDefault();
  e.stopPropagation();

  // 他のペインでのコンテキストメニューの対象が残っていると誤動作するためクリアする
  contextMenu.targetFolderElement = null;
  contextMenu.targetFolder = null;
  contextMenu.targetFavoriteId = null;
  contextMenu.targetFavoritePath = null;

  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');

  if (!item || !item.dataset.index) {
    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();

    Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

    menuReloadFolder.style.display = '';
    menuSeparatorCache.style.display = '';
    menuRebuildFolderCache.style.display = '';
    menuSeparatorSort.style.display = '';
    updateSortCheckmarks();
    menuSortRoot.style.display = '';

    showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
    return;
  }

  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) selectImage(index);

  Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

  menuRenameFile.style.display = appState.selection.size === 1 ? '' : 'none';
  menuDiffFiles.style.display = appState.selection.size === 2 ? '' : 'none';
  menuDeleteFile.style.display = '';
  menuSeparatorCache.style.display = '';
  menuRebuildCache.style.display = '';

  if (isGrid) {
    menuSeparatorSort.style.display = '';
    updateSortCheckmarks();
    menuSortRoot.style.display = '';
  }

  showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
}

uiManager.elements.thumbnailGrid.addEventListener('click', (e) => handleItemClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dblclick', (e) => handleItemDblClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dragstart', (e) => handleItemDragStart(e, true));
uiManager.elements.thumbnailGrid.addEventListener('contextmenu', (e) => handleItemContextMenu(e, true));

uiManager.elements.fileListBody.addEventListener('click', (e) => handleItemClick(e, false));
uiManager.elements.fileListBody.addEventListener('dblclick', (e) => handleItemDblClick(e, false));
uiManager.elements.fileListBody.addEventListener('dragstart', (e) => handleItemDragStart(e, false));
uiManager.elements.fileListBody.addEventListener('contextmenu', (e) => handleItemContextMenu(e, false));

// ============================================================================
// Directory Tree Event Delegation
// ============================================================================
document.getElementById('left-pane')?.addEventListener('mousedown', () => {
  const dirSection = document.getElementById('directories-section');
  if (dirSection) dirSection.focus();
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
  contextMenu.targetFolder = {
    path: itemDiv.dataset.path,
    name: itemDiv.dataset.name
  };
  contextMenu.targetFolderElement = itemDiv;
  contextMenu.isRoot = isRoot;

  Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

  menuOpenInNewTab.style.display = '';
  menuOpenInExplorer.style.display = '';
  menuCopyPath.style.display = '';
  menuReloadFolder.style.display = '';
  menuPrecacheFolder.style.display = '';
  menuSeparator1.style.display = '';
  menuNewFolder.style.display = '';

  if (!isRoot) {
    menuSeparator3.style.display = '';
    menuRenameFolder.style.display = '';
    menuDeleteFolder.style.display = '';
    menuSeparator4.style.display = '';
    menuAddFavorite.style.display = '';
  }

  showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
});

uiManager.elements.dirTree.addEventListener('dragstart', (e) => {
  const itemDiv = e.target.closest('.tree-item');
  // ルート要素はドラッグ不可
  if (!itemDiv || itemDiv.dataset.isRoot === 'true') {
    e.preventDefault();
    return;
  }

  const folderData = {
    path: itemDiv.dataset.path,
    name: itemDiv.dataset.name,
    isRoot: false
  };
  e.dataTransfer.setData('application/json-folder', JSON.stringify(folderData));
  e.dataTransfer.effectAllowed = 'copyMove';

  const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
  appState.dragState.paths = [itemDiv.dataset.path];
  appState.dragState.cachedRoot = getRoot(itemDiv.dataset.path);
  appState.dragState.isAppDragging = true;
});

uiManager.elements.dirTree.addEventListener('dragenter', (e) => {
  if (draggedFavoriteId) return; // お気に入り関連のドラッグ中は無視
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();
  itemDiv.style.backgroundColor = 'rgba(37, 126, 140, 0.3)';
});

uiManager.elements.dirTree.addEventListener('dragover', (e) => {
  if (draggedFavoriteId) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();

  let actionStr = 'コピー';
  const hasItems = (appState.dragState.indices && appState.dragState.indices.length > 0) || (appState.dragState.paths && appState.dragState.paths.length > 0);
  if (hasItems) {
    if (e.ctrlKey) {
      actionStr = 'コピー';
    } else if (e.shiftKey) {
      actionStr = '移動';
    } else {
      const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
      const cachedRoot = appState.dragState.cachedRoot || (appState.dragState.paths && appState.dragState.paths.length > 0 ? getRoot(appState.dragState.paths[0]) : null);
      actionStr = cachedRoot === getRoot(itemDiv.dataset.path) ? '移動' : 'コピー';
    }
  }
  e.dataTransfer.dropEffect = actionStr === '移動' ? 'move' : 'copy';
});

uiManager.elements.dirTree.addEventListener('dragleave', (e) => {
  if (draggedFavoriteId) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  if (!itemDiv.contains(e.relatedTarget)) {
    itemDiv.style.backgroundColor = '';
  }
});

uiManager.elements.dirTree.addEventListener('drop', async (e) => {
  if (draggedFavoriteId) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();
  itemDiv.style.backgroundColor = '';
  dragTooltip.classList.remove('show');

  const paths = await getPathsFromDragEventAsync(e);
  if (paths.length > 0 && window.veloceAPI.moveOrCopyFile) {
    let actionStr = 'コピー';
    let intent = 'auto';
    if (paths.length > 0) {
      if (e.ctrlKey) {
        actionStr = 'コピー';
        intent = 'copy';
      } else if (e.shiftKey) {
        actionStr = '移動';
        intent = 'move';
      } else {
        const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
        actionStr = getRoot(paths[0]) === getRoot(itemDiv.dataset.path) ? '移動' : 'コピー';
      }
    }

    setTimeout(async () => {
      let targetPaths = paths;
      let skipCount = 0;

      if (window.veloceAPI.checkConflicts) {
        try {
          const conflicts = await window.veloceAPI.checkConflicts(paths, itemDiv.dataset.path);
          if (conflicts && conflicts.length > 0) {
            const choice = await uiManager.showConflictDialog(conflicts.length, actionStr);
            if (choice === 'cancel') {
              uiManager.showToast('操作をキャンセルしました', 3000, 'file-move');
              return;
            } else if (choice === 'skip') {
              // 重複ファイルを除外して処理を継続する
              targetPaths = paths.filter(p => !conflicts.includes(p));
              skipCount = conflicts.length;
              if (targetPaths.length === 0) {
                uiManager.showToast(`${skipCount}件の重複をスキップしました`, 3000, 'file-move');
                return;
              }
            }
          }
        } catch (err) {
          console.error('Failed to check conflicts:', err);
        }
      }

      uiManager.showToast(`${targetPaths.length}件のファイルを${actionStr}中`, 0, 'file-move', 'info');

      let successCount = 0;
      for (const p of targetPaths) {
        const result = await window.veloceAPI.moveOrCopyFile(p, itemDiv.dataset.path, intent);
        if (result && result.success) {
          successCount++;
          if (result.action === 'move') {
            appState.undoStack.push({ type: 'MOVE_FILE', sourcePath: p, targetPath: result.targetPath });
          } else if (result.action === 'copy') {
            appState.undoStack.push({ type: 'COPY_FILE', sourcePath: p, targetPath: result.targetPath });
          }
        }
      }
      if (successCount > 0) {
        let msg = `${successCount}件のファイルを${actionStr}しました`;
        if (skipCount > 0) msg += `（${skipCount}件スキップ）`;
        uiManager.showToast(msg, 3000, 'file-move');
        if (appState.dragState.isAppDragging) {
          appState.dragState.pendingRefresh = true;
        } else {
          await refreshFileList();
        }
      } else {
        uiManager.showToast(`ファイルの${actionStr}に失敗しました`, 3000, 'file-move');
      }
    }, 10);
  }
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
  resizer.style.position = 'relative';

  const btn = document.createElement('div');
  btn.className = 'resizer-toggle';
  const isHorizontal = type === 'center' || type === 'leftTop' || type === 'rightTop';
  let topPos = '50%';
  let leftPos = '50%';

  btn.style.cssText = `
    position: absolute; display: flex; justify-content: center; align-items: center; opacity: 1;
    background-color: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer; color: var(--text-color);
    z-index: 1000; top: ${topPos}; left: ${leftPos}; transform: translate(-50%, -50%);
  `;

  btn.style.width = isHorizontal ? '30px' : '14px';
  btn.style.height = isHorizontal ? '14px' : '30px';

  let openIcon, closeIcon;
  if (type === 'left') { openIcon = UIManager.ICONS.CHEVRON_LEFT; closeIcon = UIManager.ICONS.CHEVRON_RIGHT; }
  else if (type === 'right') { openIcon = UIManager.ICONS.CHEVRON_RIGHT; closeIcon = UIManager.ICONS.CHEVRON_LEFT; }
  else { openIcon = UIManager.ICONS.CHEVRON_UP; closeIcon = UIManager.ICONS.CHEVRON_DOWN; }

  if (type === 'left') btn.innerHTML = appState.layout.leftVisible ? openIcon : closeIcon;
  else if (type === 'right') btn.innerHTML = appState.layout.rightVisible ? openIcon : closeIcon;
  else if (type === 'leftTop') btn.innerHTML = appState.layout.leftTopVisible ? openIcon : closeIcon;
  else btn.innerHTML = openIcon;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (type === 'left') {
      appState.layout.leftVisible = !appState.layout.leftVisible;
      btn.innerHTML = appState.layout.leftVisible ? openIcon : closeIcon;
      localStorage.setItem('leftVisible', appState.layout.leftVisible);
      uiManager.applyLayout();
    } else if (type === 'right') {
      appState.layout.rightVisible = !appState.layout.rightVisible;
      btn.innerHTML = appState.layout.rightVisible ? openIcon : closeIcon;
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
        btn.innerHTML = openIcon;
      } else {
        // 閉じる直前の高さを prevTopHeight として退避させてから 0px にする
        localStorage.setItem('prevTopHeight', root.style.getPropertyValue('--top-height') || '250px');
        root.style.setProperty('--top-height', '0px');
        root.setAttribute('data-center-collapsed', 'true');
        localStorage.setItem('topHeight', '0px');
        btn.innerHTML = closeIcon;
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
        btn.innerHTML = openIcon;
      } else {
        localStorage.setItem('prevLeftTopHeight', root.style.getPropertyValue('--left-top-height') || '150px');
        root.style.setProperty('--left-top-height', '0px');
        root.setAttribute('data-left-top-collapsed', 'true');
        localStorage.setItem('leftTopHeight', '0px');
        appState.layout.leftTopVisible = false;
        btn.innerHTML = closeIcon;
      }
    } else if (type === 'rightTop') {
      const root = document.documentElement;
      const isCollapsed = root.style.getPropertyValue('--right-top-height') === '0px';
      if (isCollapsed) {
        const restoreHeight = localStorage.getItem('prevRightTopHeight') || '200px';
        root.style.setProperty('--right-top-height', restoreHeight);
        localStorage.setItem('rightTopHeight', restoreHeight);
        appState.layout.rightTopVisible = true;
        btn.innerHTML = openIcon;
      } else {
        localStorage.setItem('prevRightTopHeight', root.style.getPropertyValue('--right-top-height') || '200px');
        root.style.setProperty('--right-top-height', '0px');
        localStorage.setItem('rightTopHeight', '0px');
        appState.layout.rightTopVisible = false;
        btn.innerHTML = closeIcon;
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
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_RIGHT;
          uiManager.applyLayout();
        }
      } else {
        newWidth = Math.max(100, Math.min(newWidth, window.innerWidth - 400));
        appState.layout.leftWidth = newWidth;
        if (!appState.layout.leftVisible) {
          appState.layout.leftVisible = true;
          localStorage.setItem('leftVisible', 'true');
          const btn = uiManager.elements.resizerLeft?.querySelector('.resizer-toggle');
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_LEFT;
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
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_LEFT;
          uiManager.applyLayout();
        }
      } else {
        newWidth = Math.max(150, Math.min(newWidth, window.innerWidth - 400));
        appState.layout.rightWidth = newWidth;
        if (!appState.layout.rightVisible) {
          appState.layout.rightVisible = true;
          localStorage.setItem('rightVisible', 'true');
          const btn = uiManager.elements.resizerRight?.querySelector('.resizer-toggle');
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_RIGHT;
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
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
        }
      } else {
        newHeight = Math.max(50, Math.min(newHeight, rect.height - 50));
        const root = document.documentElement;
        root.style.setProperty('--top-height', `${newHeight}px`);
        root.removeAttribute('data-center-collapsed');

        const btn = uiManager.elements.resizerCenter?.querySelector('.resizer-toggle');
        if (btn && btn.innerHTML !== UIManager.ICONS.CHEVRON_UP) {
          btn.innerHTML = UIManager.ICONS.CHEVRON_UP;
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
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
        }
      } else {
        newHeight = Math.max(30, Math.min(newHeight, rect.height - 30));
        const root = document.documentElement;
        root.style.setProperty('--left-top-height', `${newHeight}px`);
        root.removeAttribute('data-left-top-collapsed');
        appState.layout.leftTopHeight = newHeight;

        const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
        if (btn && btn.innerHTML !== UIManager.ICONS.CHEVRON_UP) {
          btn.innerHTML = UIManager.ICONS.CHEVRON_UP;
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
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
        }
      } else {
        newHeight = Math.max(30, Math.min(newHeight, rect.height - 30));
        const root = document.documentElement;
        root.style.setProperty('--right-top-height', `${newHeight}px`);
        appState.layout.rightTopHeight = newHeight;

        const btn = document.getElementById('resizer-right-pane')?.querySelector('.resizer-toggle');
        if (btn && btn.innerHTML !== UIManager.ICONS.CHEVRON_UP) {
          btn.innerHTML = UIManager.ICONS.CHEVRON_UP;
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

window.addEventListener('keydown', async (e) => {
  const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';

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

  // タブ切り替えショートカット（入力欄フォーカス時でも有効にするため、入力欄チェックの前に配置）
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
            tabEls[nextIndex].scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
          }
        }
      }
    }
    return;
  }

  if ((activeTagName === 'input' || activeTagName === 'textarea') && e.key !== 'Escape') {
    return;
  }

  if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
    e.preventDefault();
    toggleHelpOverlay();
    return;
  }

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

      const files = [];
      for (const idx of targetIndices) {
        const file = await window.veloceAPI.getFileByIndex(idx);
        if (file) files.push(file);
      }

      if (files.length > 0) {
        const allHaveSameRating = files.every(f => (appState.ratings[f.path] || 0) === rating);
        const newRating = allHaveSameRating ? 0 : rating;

        for (const file of files) {
          if (window.veloceAPI.setRating) {
            await window.veloceAPI.setRating(file.path, newRating);
          }
        }
      }
      return;
    }
  }

  if (e.key === 'Escape') {
    const diffModal = document.getElementById('diff-modal');
    if (diffModal && diffModal.style.display === 'flex') {
      e.preventDefault();
      diffModal.style.display = 'none';
      return;
    }
    const favModal = document.getElementById('edit-favorite-modal');
    if (favModal && favModal.style.display === 'flex') {
      e.preventDefault();
      favModal.style.display = 'none';
      return;
    }
    const sfModal = document.getElementById('edit-smart-folder-modal');
    if (sfModal && sfModal.style.display === 'flex') {
      e.preventDefault();
      sfModal.style.display = 'none';
      return;
    }
    if (document.getElementById('help-overlay')) {
      e.preventDefault();
      toggleHelpOverlay(false);
      return;
    }
    const historyMenu = document.getElementById('history-menu');
    if (contextMenu.style.display === 'block' || tabListMenu.style.display === 'block' || (historyMenu && historyMenu.style.display === 'block')) {
      e.preventDefault();
      contextMenu.style.display = 'none';
      tabListMenu.style.display = 'none';
      if (historyMenu) historyMenu.style.display = 'none';
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
            flash.style.position = 'fixed';
            flash.style.top = top + 'px';
            flash.style.left = left + 'px';
            flash.style.width = width + 'px';
            flash.style.height = height + 'px';
            flash.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
            flash.style.pointerEvents = 'none';
            flash.style.zIndex = '10005';
            flash.style.borderRadius = window.getComputedStyle(el).borderRadius || '0px';
            flash.style.transition = 'opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
            document.body.appendChild(flash);

            flash.style.opacity = '0.5';

            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                flash.style.opacity = '0';
              });
            });

            setTimeout(() => {
              if (flash.parentNode) flash.remove();
            }, 600);
          };

          // 現在の表示モードに応じた要素にエフェクトを適用
          applyFlash(uiManager.elements.thumbnailGrid.querySelector(`.thumbnail-item[data-index="${idx}"]`));
          applyFlash(uiManager.elements.fileListBody.querySelector(`tr[data-index="${idx}"]`));
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

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
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
    }

    if (newIndex !== appState.selectedIndex) {
      if (e.shiftKey) {
        selectImage(newIndex, { shiftKey: true });
      } else {
        selectImage(newIndex);
      }
    }
  }
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (typeof closeAllMenus === 'function') closeAllMenus(e);
});

// ツリービューのキーボード操作ハンドラ
async function handleTreeNavigation(key) {
  const visibleItems = Array.from(document.querySelectorAll('#dir-tree .tree-item')).filter(el => el.offsetParent !== null);
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
      item.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }

    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();

    const path = item.dataset.path;
    if (window.veloceAPI.loadDirectory) {
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
      if (bookmarkOverflowMenu && bookmarkOverflowMenu.style.display !== 'none') {
        bookmarkOverflowMenu.style.display = 'none';
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
      bookmarkOverflowMenu.style.display = 'block';
      bookmarkOverflowMenu.style.zIndex = '10001';

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
          bookmarkOverflowMenu.style.display = 'none';

          if (window.veloceAPI.loadDirectory) {
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
      bookmarkOverflowMenu.style.transform = 'scale(0.95)';
      bookmarkOverflowMenu.style.opacity = '0';

      // animation
      requestAnimationFrame(() => {
        bookmarkOverflowMenu.style.transition = 'opacity 0.15s ease, transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1)';
        bookmarkOverflowMenu.style.opacity = '1';
        bookmarkOverflowMenu.style.transform = 'scale(1)';
      });
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
      await refreshFileList(true);
    });
  }

  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) navigateHistory(-1);
    if (e.button === 4) navigateHistory(1);
  });

  if (window.veloceAPI.onDirectoryLoaded) {
    window.veloceAPI.onDirectoryLoaded(async (payload) => {
      if (payload.path !== appState.currentDirectory) return;
      appState.totalCount = payload.totalCount;
      if (payload.path.startsWith("smart://")) {
        appState.thumbnailTotalRequested = 0;
      } else {
        appState.thumbnailTotalRequested = appState.totalCount;
      }
      appState.thumbnailCompleted = 0;
      appState.thumbnailCounted.clear();
      await scheduleRefresh();
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
      let iconColor = '';
      if (itemData) {
        const c = COLORS.find(c => c.id === (itemData.color || 'default'));
        iconColor = c ? c.hex : 'var(--glow-gold)';

        if (itemData.icon && typeof ICON_SVGS !== 'undefined' && ICON_SVGS[itemData.icon]) {
          iconHtml = ICON_SVGS[itemData.icon];
        } else if (itemData.icon && itemData.icon.startsWith('FAV_')) {
          iconHtml = UIManager.ICONS[itemData.icon] || UIManager.ICONS.FAV_STAR;
        } else {
          iconHtml = UIManager.ICONS.FAV_STAR;
        }
      } else {
        iconHtml = UIManager.ICONS.FOLDER;
        iconColor = '#4da8da';
      }

      const iconSpan = document.createElement('span');
      iconSpan.className = 'tab-list-icon';
      iconSpan.style.display = 'flex';
      iconSpan.style.alignItems = 'center';
      iconSpan.style.justifyContent = 'center';
      iconSpan.style.flexShrink = '0';
      iconSpan.style.width = '16px';
      iconSpan.innerHTML = iconHtml;
      if (iconColor) iconSpan.style.color = iconColor;

      const svg = iconSpan.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
      }

      const textContainer = document.createElement('div');
      textContainer.style.display = 'flex';
      textContainer.style.flexDirection = 'column';
      textContainer.style.overflow = 'hidden';
      textContainer.style.flex = '1';

      const nameLabel = document.createElement('span');
      nameLabel.textContent = tab.name;
      nameLabel.style.fontWeight = index === appState.activeTabIndex ? 'bold' : 'normal';
      nameLabel.style.whiteSpace = 'nowrap';
      nameLabel.style.overflow = 'hidden';
      nameLabel.style.textOverflow = 'ellipsis';
      nameLabel.style.fontSize = 'var(--font-size-sm)';

      const pathLabel = document.createElement('span');
      pathLabel.className = 'path-label';
      pathLabel.textContent = tab.path;
      pathLabel.title = tab.path;
      pathLabel.style.whiteSpace = 'nowrap';
      pathLabel.style.overflow = 'hidden';
      pathLabel.style.textOverflow = 'ellipsis';
      pathLabel.style.fontSize = '11px';
      pathLabel.style.marginTop = '2px';

      textContainer.appendChild(nameLabel);
      textContainer.appendChild(pathLabel);

      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close-btn';
      closeBtn.style.display = 'flex';
      closeBtn.style.alignItems = 'center';
      closeBtn.style.justifyContent = 'center';
      closeBtn.style.width = '16px';
      closeBtn.style.height = '16px';
      closeBtn.style.flexShrink = '0';
      closeBtn.style.borderRadius = 'var(--radius-xs)';
      closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="7" height="7"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" stroke-width="1.5"/></svg>`;

      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (window.onTabClose) {
          await window.onTabClose(index);
          if (tabListMenu.style.display === 'block') updateTabListMenu();
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
            if (tabListMenu.style.display === 'block') updateTabListMenu();
          }
        }
      });

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        tabListMenu.style.display = 'none';
        await window.onTabClick(index);

        const container = document.getElementById('tab-container');
        if (container) {
          const tabEls = container.querySelectorAll('.tab-item:not(.new-tab-btn)');
          if (tabEls[index]) {
            tabEls[index].scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
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
      if (tabListMenu.style.display === 'block') {
        tabListMenu.style.display = 'none';
        return;
      }

      updateTabListMenu();

      const rect = tabListBtn.getBoundingClientRect();
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
    if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_RIGHT;
  }
  if (!appState.layout.rightVisible && uiManager.elements.resizerRight) {
    const btn = uiManager.elements.resizerRight.querySelector('.resizer-toggle');
    if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_LEFT;
  }

  const savedTopHeight = localStorage.getItem('topHeight');
  if (savedTopHeight) {
    document.documentElement.style.setProperty('--top-height', savedTopHeight);
    if (savedTopHeight === '0px') {
      document.documentElement.setAttribute('data-center-collapsed', 'true');
      if (uiManager.elements.resizerCenter) {
        const btn = uiManager.elements.resizerCenter.querySelector('.resizer-toggle');
        if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
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
      if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
    } else {
      document.documentElement.removeAttribute('data-left-top-collapsed');
    }
  }

  const savedRightTopHeight = localStorage.getItem('rightTopHeight');
  if (savedRightTopHeight) {
    if (savedRightTopHeight === '0px') {
      const btn = document.getElementById('resizer-right-pane')?.querySelector('.resizer-toggle');
      if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
    }
  }

  const savedThumbScale = localStorage.getItem('thumbnailScale');
  if (savedThumbScale !== null && parseFloat(savedThumbScale) >= 100) {
    uiManager.elements.thumbnailSizeSlider.value = savedThumbScale;
  } else {
    uiManager.elements.thumbnailSizeSlider.value = 120;
  }
  updateThumbnailSize();

  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.addEventListener('input', debounce((e) => {
      appState.searchQuery = e.target.value;
      scheduleRefresh();
    }, CONFIG.SEARCH_DELAY));
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
          appState.thumbnailUrls.clear();
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
    // --- お気に入りのドラッグ＆ドロップ並び替え処理 ---
    favListElement.addEventListener('dragstart', (e) => {
      const itemDiv = e.target.closest('.bookmark-item');
      if (!itemDiv) {
        e.preventDefault();
        return;
      }
      draggedFavoriteId = itemDiv.dataset.id;
      e.dataTransfer.effectAllowed = 'move';

      // アイテムのみを掴んでいるように見せるためのカスタムドラッグイメージ
      const dragGhost = itemDiv.cloneNode(true);
      dragGhost.style.position = 'absolute';
      dragGhost.style.top = '-1000px';
      dragGhost.style.left = '-1000px';
      dragGhost.style.width = 'max-content'; // コンテンツ幅に合わせる
      dragGhost.style.padding = '4px 12px';
      dragGhost.style.backgroundColor = 'var(--panel-bg, #1a2024)';
      dragGhost.style.border = '1px solid var(--accent-color, #257e8c)';
      dragGhost.style.color = 'var(--text-color, #ffffff)';
      dragGhost.style.borderRadius = 'var(--radius-xs)';
      dragGhost.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
      document.body.appendChild(dragGhost);

      e.dataTransfer.setDragImage(dragGhost, 15, 15);

      setTimeout(() => {
        if (dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
      }, 0);

      // ドラッグ中の元アイテムを半透明にする
      setTimeout(() => { itemDiv.style.opacity = '0.5'; }, 0);
    });

    favListElement.addEventListener('dragend', (e) => {
      const itemDiv = e.target.closest('.bookmark-item');
      if (itemDiv) itemDiv.style.opacity = '1';
      draggedFavoriteId = null;
      // 全てのドロップインジケータ（線）をクリア
      favListElement.querySelectorAll('.bookmark-item').forEach(item => {
        item.classList.remove('drop-target-left', 'drop-target-right');
      });
    });

    favListElement.addEventListener('dragover', (e) => {
      const isFolderDrop = Array.from(e.dataTransfer.types).includes('application/json-folder');
      if (!draggedFavoriteId && !isFolderDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isFolderDrop ? 'copy' : 'move';

      const itemDiv = e.target.closest('.bookmark-item');

      favListElement.querySelectorAll('.bookmark-item').forEach(item => {
        item.classList.remove('drop-target-left', 'drop-target-right');
      });

      if (!itemDiv || (draggedFavoriteId && itemDiv.dataset.id === draggedFavoriteId)) {
        // 余白にドラッグしている場合、一番最後のアイテムの下にインジケータを表示する
        const items = favListElement.querySelectorAll('.bookmark-item');
        if (items.length > 0) {
          const lastItem = items[items.length - 1];
          if (lastItem.dataset.id !== draggedFavoriteId) {
            lastItem.classList.add('drop-target-right');
          }
        }
        return;
      }

      // マウス位置がターゲットの半分より左か右かで線の位置を変える
      const rect = itemDiv.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      if (e.clientX < midX) {
        itemDiv.classList.add('drop-target-left'); // 左に線
      } else {
        itemDiv.classList.add('drop-target-right');  // 右に線
      }
    });

    favListElement.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && favListElement.contains(e.relatedTarget)) return;
      favListElement.querySelectorAll('.bookmark-item').forEach(item => {
        item.classList.remove('drop-target-left', 'drop-target-right');
      });
    });

    favListElement.addEventListener('drop', (e) => {
      const isFolderDrop = Array.from(e.dataTransfer.types).includes('application/json-folder');
      if (!draggedFavoriteId && !isFolderDrop) return;
      e.preventDefault();

      favListElement.querySelectorAll('.bookmark-item').forEach(item => {
        item.classList.remove('drop-target-left', 'drop-target-right');
      });

      if (isFolderDrop) {
        const jsonData = e.dataTransfer.getData('application/json-folder');
        if (jsonData) {
          try {
            const folder = JSON.parse(jsonData);
            if (appState.favorites.find(f => f.path === folder.path)) {
              showNotification(`「${folder.name}」はすでにお気に入りにあります`, 'warning');
              return;
            }

            let insertIndex = appState.favorites.length;
            const itemDiv = e.target.closest('.bookmark-item');
            if (itemDiv) {
              const targetId = itemDiv.dataset.id;
              const rect = itemDiv.getBoundingClientRect();
              const midX = rect.left + rect.width / 2;
              const insertAfter = e.clientX >= midX;
              const newIndex = appState.favorites.findIndex(f => f.id === targetId);
              if (newIndex > -1) {
                insertIndex = insertAfter ? newIndex + 1 : newIndex;
              }
            }

            const newFav = { id: Date.now().toString(), name: folder.name, path: folder.path, icon: 'star', color: 'default' };
            appState.favorites.splice(insertIndex, 0, newFav);
            localStorage.setItem('favorites', JSON.stringify(appState.favorites));
            renderFavorites();
            showNotification(`「${folder.name}」をお気に入りに追加しました`, 'success');
          } catch (err) { }
        }
        return;
      }

      const itemDiv = e.target.closest('.bookmark-item');
      if (itemDiv && itemDiv.dataset.id === draggedFavoriteId) return;

      const fromIndex = appState.favorites.findIndex(f => f.id === draggedFavoriteId);
      if (fromIndex > -1) {
        const [movedItem] = appState.favorites.splice(fromIndex, 1);
        let newIndex = appState.favorites.length; // デフォルトは末尾

        if (itemDiv) {
          const targetId = itemDiv.dataset.id;
          newIndex = appState.favorites.findIndex(f => f.id === targetId);
          if (newIndex > -1) {
            const rect = itemDiv.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            const insertAfter = e.clientX >= midX;
            if (insertAfter) newIndex += 1;
          } else {
            newIndex = appState.favorites.length;
          }
        }

        // 並び替えた状態を保存して再描画
        appState.favorites.splice(newIndex, 0, movedItem);
        localStorage.setItem('favorites', JSON.stringify(appState.favorites));
        renderFavorites();
      }
    });

    favListElement.addEventListener('click', async (e) => {
      const itemDiv = e.target.closest('.bookmark-item');
      if (!itemDiv) return;

      const path = itemDiv.dataset.path;
      appState.selection.clear();
      appState.selectedIndex = -1;
      uiManager.updateSelectionUI();

      if (window.veloceAPI.loadDirectory) {
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

      contextMenu.targetFavoriteId = itemDiv.dataset.id;
      contextMenu.targetFavoritePath = itemDiv.dataset.path;
      contextMenu.targetFolder = null;

      Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

      menuOpenInNewTab.style.display = '';
      menuOpenInExplorer.style.display = '';
      menuCopyPath.style.display = '';
      menuSeparator1.style.display = '';
      menuEditFavorite.style.display = '';
      menuDeleteFavorite.style.display = '';

      showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
    });
  }

  document.getElementById('fav-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('edit-favorite-modal').style.display = 'none';
  });

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
          scheduleRefresh();
        }
        container.classList.remove('open');
      });
    });
  };

  setupCustomSelect('custom-rating-val-container', 'ratingFilterVal');
  setupCustomSelect('custom-rating-op-container', 'ratingFilterOp');

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

    window.veloceAPI.loadDirectory(currentTab.path);

    await expandTreeToPath(appState.currentDirectory);
    saveTabsState();
  }

  if (window.veloceAPI.onRatingChanged) {
    window.veloceAPI.onRatingChanged((payload) => {
      const { path, rating } = payload;
      if (rating === 0) {
        delete appState.ratings[path];
      } else {
        appState.ratings[path] = rating;
      }

      if (uiManager.elements.thumbnailGrid) {
        // Use double backslashes in querySelector attribute selector for file paths
        const safePath = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const thumb = uiManager.elements.thumbnailGrid.querySelector(`.thumbnail-item[data-filepath="${safePath}"]`);
        if (thumb) {
          let badge = thumb.querySelector('.rating-badge');
          if (badge) {
            if (rating > 0) {
              badge.querySelector('.rating-value').textContent = rating;
              badge.style.display = 'flex';
            } else {
              badge.style.display = 'none';
            }
          }
        }
      }

      if (uiManager.elements.fileListBody) {
        const safePath = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const tr = uiManager.elements.fileListBody.querySelector(`tr[data-filepath="${safePath}"]`);
        if (tr) {
          const td = tr.querySelectorAll('td')[7];
          if (td) {
            if (rating > 0) {
              const starSvg = '<svg viewBox="0 0 24 24" width="14" height="14" style="fill: var(--glow-gold, #ffd700); display: inline-block; vertical-align: text-bottom; margin-right: 1px;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
              td.innerHTML = starSvg + rating;
            } else {
              td.innerHTML = '-';
            }
          }
        }
      }

      if (appState.ratingFilterVal > 0 || appState.sortConfig.key === 'rating') {
        scheduleRefresh();
      }
      updateSmartFolderCountsUI();
    });
  }

  if (window.veloceAPI.onFileChanged) {
    window.veloceAPI.onFileChanged(async (newFile) => {
      appState.thumbnailUrls.delete(newFile.path);

      if (window.thumbnailManager) window.thumbnailManager.remove(newFile.path);

      await window.veloceAPI.notifyFileChanged(newFile);
      scheduleRefresh();
    });
  }

  if (window.veloceAPI.onFileRemoved) {
    window.veloceAPI.onFileRemoved(async (path) => {
      await window.veloceAPI.notifyFileRemoved(path);
      scheduleRefresh();
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
    iconSpan.innerHTML = f.icon || '⭐';
  }

  const nameSpan = clone.querySelector('.folder-name');
  nameSpan.textContent = f.name;

  return item;
}

/**
 * スマートフォルダの件数を取得してUIに反映する非同期関数
 */
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
          countSpan.style.display = 'block';
        } else {
          countSpan.style.display = 'none';
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
      document.querySelectorAll('.tree-node-content').forEach(el => el.classList.remove('selected'));

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

          contextMenu.targetFavoriteId = null;
          contextMenu.targetFavoritePath = null;
          contextMenu.targetFolder = { path: `smart://${f.id}`, name: f.name };
          contextMenu.targetSmartFolderId = f.id;

          Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

          menuOpenInNewTab.style.display = '';
          menuSeparator1.style.display = '';
          menuEditSmartFolder.style.display = '';
            menuDuplicateSmartFolder.style.display = '';
          menuDeleteSmartFolder.style.display = '';

          showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
        } else {
          // セクション余白での右クリック
          e.preventDefault();
          e.stopPropagation();

          contextMenu.targetFavoriteId = null;
          contextMenu.targetFavoritePath = null;
          contextMenu.targetFolder = null;
          contextMenu.targetSmartFolderId = null;

          Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

          menuAddSmartFolder.style.display = '';

          showMenuWithAnimation(contextMenu, e.clientX, e.clientY);
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

