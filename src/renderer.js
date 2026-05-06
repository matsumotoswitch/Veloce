// ============================================================================
// Veloce - Main Controller (renderer.js)
// ============================================================================

// 開発者ツール（F12, Ctrl+Shift+I）の強制ブロック
window.addEventListener('keydown', (e) => {
  if (
    (e.ctrlKey && e.shiftKey && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) ||
    e.key === 'F12' || e.code === 'F12'
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ============================================================================
// 1. Constants & Global Variables
// ============================================================================
import { appState } from './renderer-state.js';
import { UIManager, uiManager, formatSize, formatDate } from './renderer-ui.js';
import { debounce } from './utils.js';

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

const logicalCores = navigator.hardwareConcurrency || 8;
const MAX_CONCURRENT_THUMBNAILS = logicalCores * 2;

const emptyDragImage = new Image();
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const resizingState = { left: false, right: false, center: false, leftTop: false, rightTop: false };
let draggedFavoriteId = null; // お気に入りのドラッグ状態を管理

const contextMenu = document.createElement('div');
contextMenu.id = 'context-menu';
contextMenu.style.position = 'fixed';
contextMenu.style.display = 'none';
contextMenu.style.backgroundColor = 'var(--modal-bg)';
contextMenu.style.border = '1px solid var(--modal-border)';
contextMenu.style.borderRadius = '4px';
contextMenu.style.padding = '4px 0';
contextMenu.style.zIndex = '10001';
contextMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
contextMenu.style.minWidth = '150px';
contextMenu.style.fontSize = '13px';

// タブ一覧メニュー
const tabListMenu = document.createElement('div');
tabListMenu.id = 'tab-list-menu';
tabListMenu.style.position = 'fixed';
tabListMenu.style.display = 'none';
tabListMenu.style.backgroundColor = 'var(--modal-bg)';
tabListMenu.style.border = '1px solid var(--modal-border)';
tabListMenu.style.borderRadius = '4px';
tabListMenu.style.padding = '4px 0';
tabListMenu.style.zIndex = '10001';
tabListMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
tabListMenu.style.minWidth = '200px';
tabListMenu.style.maxWidth = '400px';
tabListMenu.style.maxHeight = '70vh';
tabListMenu.style.overflowY = 'auto';
tabListMenu.style.fontSize = '13px';
document.body.appendChild(tabListMenu);

// ============================================================================
// 2. Tauri API & Backend Communication
// ============================================================================

function applyNewFileList(files, resetScroll = false) {
  appState.files = files || [];
  resetThumbnailPreloader();
  appState.applyFiltersAndSort();
  uiManager.renderAll(resetScroll);
  loadAllMetadataInBackground();
  
  uiManager.updateSelectionUI();
  if (appState.selectedIndex > -1) {
    renderMetadata(appState.filteredFiles[appState.selectedIndex]);
  } else {
    clearMetadataUI();
  }
}

async function refreshFileList(resetScroll = false) {
  if (!appState.currentDirectory || !window.veloceAPI.loadDirectory) return;
  const result = await window.veloceAPI.loadDirectory(appState.currentDirectory);
  if (!result) return;

  applyNewFileList(result.imageFiles, resetScroll);
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
  for(let i = 1; i < parts.length; i++) {
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
                  itemDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
          } else {
              if (itemDiv.expandNode) await itemDiv.expandNode();
          }
      } else {
          break;
      }
  }
}

async function loadAllMetadataInBackground() {
  if (!window.veloceAPI.getFullMetadataBatch) return;
  const filesToLoad = appState.files.filter(f => !f.metaLoaded);
  if (filesToLoad.length === 0) return;

  const batchId = ++appState.currentMetaBatchId;
  const pathsToLoad = filesToLoad.map(f => f.path);
  // サムネイル生成を阻害しないように、メタデータ取得のチャンクサイズを小さく設定する
  const CHUNK_SIZE = Math.min(25, Math.max(10, Math.floor(CONFIG.CHUNK_SIZE / 4)));

  const processNextChunk = (chunkIndex) => {
    if (appState.currentMetaBatchId !== batchId) return;

    if (chunkIndex >= pathsToLoad.length) {
      uiManager.showToast(`情報の読み込み完了 (${pathsToLoad.length}/${pathsToLoad.length})`, 1000, 'meta-progress');
      if (['width', 'height'].includes(appState.sortConfig.key)) {
        scheduleRefresh();
      }
      return;
    }

    setTimeout(async () => {
      if (appState.currentMetaBatchId !== batchId) return;
      
      try {
        const chunkPaths = pathsToLoad.slice(chunkIndex, chunkIndex + CHUNK_SIZE);
        uiManager.showToast(`情報の読み込み中... (${Math.min(chunkIndex + CHUNK_SIZE, pathsToLoad.length)}/${pathsToLoad.length})`, 0, 'meta-progress', 'info');
        
        const metadataList = await window.veloceAPI.getFullMetadataBatch(chunkPaths);
        if (appState.currentMetaBatchId !== batchId) return;

        const pathToIndex = new Map();
        appState.files.forEach((f, i) => pathToIndex.set(f.path, i));

        metadataList.forEach(meta => {
          const fileIndex = pathToIndex.get(meta.path);
          if (fileIndex !== undefined && fileIndex > -1) {
            const file = appState.files[fileIndex];
            file.width = meta.width;
            file.height = meta.height;
            file.prompt = meta.prompt || '';
            file.negativePrompt = meta.negativePrompt || '';
            file.source = meta.source || '';
            if (meta.params && Array.isArray(meta.params.characterPrompts)) {
                file.charPrompts = meta.params.characterPrompts;
            }
            file.metaLoaded = true;

            const tableIndex = appState.filteredFiles.findIndex(f => f.path === meta.path);
            if (tableIndex !== -1 && uiManager.elements.fileListBody.children[tableIndex]) {
              const row = uiManager.elements.fileListBody.children[tableIndex];
              row.children[2].textContent = meta.width ? meta.width.toLocaleString() : '-';
              row.children[3].textContent = meta.height ? meta.height.toLocaleString() : '-';
            }
          }
        });

        if (appState.searchQuery.trim() !== '') {
            scheduleRefresh();
        }
      } catch (error) {
        console.error('Failed to load metadata in background:', error);
      }
      processNextChunk(chunkIndex + CHUNK_SIZE);
    }, 10); // アイドル状態を待たずにUIスレッドへ短く処理を譲りながら確実に実行する
  };
  processNextChunk(0);
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
  if (appState.selectedIndex > -1 && appState.filteredFiles[appState.selectedIndex]) {
    const file = appState.filteredFiles[appState.selectedIndex];
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
        uiManager.showToast(`ファイル名を「${newName}」に変更しました`, 3000, 'file-rename', 'success');
        
        const newExt = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';
        const currentIdx = appState.files.findIndex(f => f.path === oldPath);
        if (currentIdx > -1) {
          appState.files[currentIdx].path = result.path;
          appState.files[currentIdx].name = newName;
          appState.files[currentIdx].ext = newExt;
        }
        file.path = result.path;
        file.name = newName;
        file.ext = newExt;

        appState.thumbnailUrls.delete(oldPath);
        resetThumbnailPreloader();
        scheduleRefresh();
      } else {
        uiManager.showToast(`ファイル名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 3000, 'file-rename', 'warning');
      }
    }
  }
}

async function deleteSelectedFiles() {
  if (appState.selection.size > 0) {
    const pathsToDelete = [];
    for (const i of appState.selection) {
      if (appState.filteredFiles[i]) pathsToDelete.push(appState.filteredFiles[i].path);
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
        if (success) trashedCount++;
      } catch (err) {
        console.error('Failed to trash file:', err);
      }
    }

    if (trashedCount > 0) {
      uiManager.showToast(`${trashedCount}件のアイテムをゴミ箱に移動しました`, 3000, 'file-trash', 'warning');
    } else {
      uiManager.showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

function renderFavorites() {
  const container = document.getElementById('favorites-list');
  if (!container) return;
  container.innerHTML = '';

  if (appState.favorites.length === 0) {
    const li = document.createElement('li');
    li.style.padding = '20px 10px';
    li.style.color = 'var(--text-color)';
    li.style.opacity = '0.5';
    li.style.fontSize = '12px';
    li.style.textAlign = 'center';
    li.style.lineHeight = '1.6';
    li.style.pointerEvents = 'none'; // ドラッグ操作の邪魔にならないようにする
    li.innerHTML = 'フォルダをここにドラッグして<br>お気に入りに追加できます';
    container.appendChild(li);
    return;
  }
  
  appState.favorites.forEach(fav => {
    const li = document.createElement('li');
    li.className = 'tree-node';
    
    const itemDiv = document.createElement('div');
    itemDiv.className = 'tree-item favorite-item';
    itemDiv.dataset.path = fav.path;
    itemDiv.dataset.id = fav.id;
    itemDiv.dataset.isFavorite = 'true';
    itemDiv.style.display = 'flex';
    itemDiv.style.alignItems = 'center';
    itemDiv.draggable = true; // ドラッグ可能にする
    
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    if (fav.icon && fav.icon.startsWith('FAV_')) {
      icon.innerHTML = UIManager.ICONS[fav.icon] || UIManager.ICONS['FAV_STAR'];
      icon.style.color = 'var(--glow-gold)'; // お気に入りのデフォルト色
    } else {
      icon.textContent = fav.icon || '⭐';
    }
    icon.style.marginRight = '6px';
    icon.style.marginLeft = '16px'; 
    icon.style.fontSize = '14px';
    icon.style.display = 'inline-flex';
    icon.style.alignItems = 'center';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = fav.name;

    itemDiv.appendChild(icon);
    itemDiv.appendChild(label);
    li.appendChild(itemDiv);
    container.appendChild(li);
  });
}

// ============================================================================
// 3. Core Business Logic & Helpers
// ============================================================================

function showNotification(message, type = 'info') {
  uiManager.showToast(message, 3000, null, type);
}

const createMenuOption = (text, onClick) => {
  const option = document.createElement('div');
  option.textContent = text;
  option.style.padding = '6px 16px';
  option.style.cursor = 'pointer';
  option.style.color = 'var(--text-color)';
  option.onmouseenter = () => {
    option.style.backgroundColor = 'var(--accent-color)';
    option.style.color = '#fff';
  };
  option.onmouseleave = () => {
    option.style.backgroundColor = 'transparent';
    option.style.color = 'var(--text-color)';
  };
  option.addEventListener('click', (e) => {
    e.stopPropagation();
    contextMenu.style.display = 'none';
    onClick();
  });
  return option;
};

// メニューセパレーターの作成
const createMenuSeparator = () => {
  const separator = document.createElement('div');
  separator.className = 'menu-separator';
  separator.style.height = '1px';
  separator.style.backgroundColor = 'var(--modal-border)';
  separator.style.margin = '4px 16px';
  return separator;
};

const menuSeparatorFav = createMenuSeparator();

function resetThumbnailPreloader() {
  appState.thumbnailRequestQueue = [];
  appState.pendingThumbnails.clear();
  appState.preloadCursor = 0;
}

function updateThumbnailToast() {
  if (appState.thumbnailTotalRequested === 0) return;

  const now = Date.now();
  const THROTTLE_DELAY = 50; // 50msに1回まで更新を許可

  // 最後の更新から十分な時間が経過したか、または最後の1件の時のみUIを更新
  if (now - appState.lastThumbnailToastTime > THROTTLE_DELAY || appState.thumbnailCompleted === appState.thumbnailTotalRequested) {
    appState.lastThumbnailToastTime = now;

    if (appState.thumbnailCompleted < appState.thumbnailTotalRequested) {
      uiManager.showToast(`サムネイル作成中 (${appState.thumbnailCompleted}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress', 'info');
    } else {
      uiManager.showToast(`サムネイル作成完了 (${appState.thumbnailTotalRequested}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress');
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

function fetchThumbnailWithTimeout(filePath, timeoutMs = 10000) {
  return Promise.race([
    window.veloceAPI.getThumbnail(filePath),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Thumbnail timeout')), timeoutMs))
  ]);
}

window.processNextTask = function processNextTask() {
  // 同時実行数の上限チェック（枠が空くまで待機）
  if (appState.activeThumbnailTasks >= MAX_CONCURRENT_THUMBNAILS) return;

  // 【優先処理】画面内に見えている画像
  if (appState.thumbnailRequestQueue.length > 0) {
    appState.isPreloadRunning = false;

    let targetIndex = appState.thumbnailRequestQueue.findIndex(req => req.img.dataset.isVisible === 'true');
    if (targetIndex === -1) targetIndex = 0;

    const req = appState.thumbnailRequestQueue.splice(targetIndex, 1)[0];
    const { filePath, requestRenderId, img } = req;

    if (appState.currentRenderId !== requestRenderId) {
      appState.pendingThumbnails.delete(filePath);
      setTimeout(window.processNextTask, 0);
      return;
    }

    appState.activeThumbnailTasks++;
    fetchThumbnailWithTimeout(filePath).then(url => {
      appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
      appState.pendingThumbnails.delete(filePath);

      if (appState.currentRenderId === requestRenderId) {
        const finalUrl = url || window.veloceAPI.convertFileSrc(filePath);
        appState.thumbnailUrls.set(filePath, finalUrl);
        if (img.dataset.isVisible === 'true') {
          img.src = finalUrl;
        }

        const fileObj = appState.files.find(f => f.path === filePath);
        if (fileObj && !fileObj.hasThumbnailCache) {
          fileObj.hasThumbnailCache = true;
          appState.thumbnailCompleted++;
          updateThumbnailToast();
        }
      }
      setTimeout(window.processNextTask, 0); 
    }).catch(() => {
      appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
      appState.pendingThumbnails.delete(filePath);
      
      // エラー時もフォールバックを登録して無限ループを防ぐ
      if (appState.currentRenderId === requestRenderId) {
        const fallbackUrl = window.veloceAPI.convertFileSrc(filePath);
        appState.thumbnailUrls.set(filePath, fallbackUrl);
        if (img.dataset.isVisible === 'true') {
          img.src = fallbackUrl;
        }

        const fileObj = appState.files.find(f => f.path === filePath);
        if (fileObj && !fileObj.hasThumbnailCache) {
          fileObj.hasThumbnailCache = true;
          appState.thumbnailCompleted++;
          updateThumbnailToast();
        }
      }
      setTimeout(window.processNextTask, 0); 
    });

    // 空いている枠の数だけ、一気にタスクを補充する
    const availableSlots = MAX_CONCURRENT_THUMBNAILS - appState.activeThumbnailTasks;
    for (let i = 0; i < availableSlots; i++) {
      setTimeout(window.processNextTask, 0);
    }
    return;
  }

  // 【バックグラウンド処理】優先キューが空の場合、画面外の画像を順次作成
  appState.isPreloadRunning = true;
  let targetFile = null;

  while (appState.preloadCursor < appState.filteredFiles.length) {
    const p = appState.filteredFiles[appState.preloadCursor].path;
    if (!appState.thumbnailUrls.has(p) && !appState.pendingThumbnails.has(p)) {
      targetFile = p;
      break;
    }
    appState.preloadCursor++;
  }

  if (!targetFile) {
    appState.isPreloadRunning = false;
    return; // 全ての画像の処理が完了
  }

  appState.pendingThumbnails.add(targetFile);
  appState.activeThumbnailTasks++;

  fetchThumbnailWithTimeout(targetFile).then(url => {
    appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
    appState.pendingThumbnails.delete(targetFile);
    
    const finalUrl = url || window.veloceAPI.convertFileSrc(targetFile);
    appState.thumbnailUrls.set(targetFile, finalUrl);

    const fileObj = appState.files.find(f => f.path === targetFile);
    if (fileObj && !fileObj.hasThumbnailCache) {
        fileObj.hasThumbnailCache = true; 
        appState.thumbnailCompleted++;
        updateThumbnailToast();
    }

    const escapedPath = CSS.escape(targetFile);
    const img = document.querySelector(`.thumbnail-item[data-filepath="${escapedPath}"]`);
    if (img && img.dataset.isVisible === 'true' && !img.hasAttribute('src')) {
      img.src = finalUrl;
    }

    setTimeout(window.processNextTask, 0);
  }).catch(() => {
    appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
    appState.pendingThumbnails.delete(targetFile);

    // エラー時もフォールバックを登録して無限ループを防ぎ、Cursorを進める
    const fallbackUrl = window.veloceAPI.convertFileSrc(targetFile);
    appState.thumbnailUrls.set(targetFile, fallbackUrl);

    const fileObj = appState.files.find(f => f.path === targetFile);
    if (fileObj && !fileObj.hasThumbnailCache) {
        fileObj.hasThumbnailCache = true;
        appState.thumbnailCompleted++;
        updateThumbnailToast();
    }

    const escapedPath = CSS.escape(targetFile);
    const img = document.querySelector(`.thumbnail-item[data-filepath="${escapedPath}"]`);
    if (img && img.dataset.isVisible === 'true' && !img.hasAttribute('src')) {
      img.src = fallbackUrl;
    }

    setTimeout(window.processNextTask, 0);
  });

  // 空いている枠の数だけ、一気にタスクを補充する
  const availableSlots = MAX_CONCURRENT_THUMBNAILS - appState.activeThumbnailTasks;
  for (let i = 0; i < availableSlots; i++) {
    setTimeout(window.processNextTask, 0);
  }
};

function initializeThumbnailObserver() {
    const options = {
        root: document.getElementById('center-bottom'), // 正しいスクロールコンテナを指定
        rootMargin: '400px 0px 400px 0px', // 少し広めに範囲を取る
    };
    appState.thumbnailObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const img = entry.target;
            const filePath = img.dataset.filepath;
            if (entry.isIntersecting) {
                img.dataset.isVisible = 'true';
                if (filePath && !img.hasAttribute('src')) {
                    if (appState.thumbnailUrls.has(filePath)) {
                        // すでにキャッシュがあればそれを使う
                        img.src = appState.thumbnailUrls.get(filePath);
                    } else if (!appState.pendingThumbnails.has(filePath)) {
                        // プレースホルダーを入れて二重リクエストを防止
                        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        
                        const requestRenderId = appState.currentRenderId;
                        appState.pendingThumbnails.add(filePath);
                        appState.thumbnailRequestQueue.push({ filePath, requestRenderId, img });
                        
                        window.processNextTask();
                    }
                }
            } else {
                img.dataset.isVisible = 'false';
            }
        }
    }, options);
}

function clearMetadataUI() {
  const container = document.getElementById('inspector-content');
  if (container) {
    container.innerHTML = '<div style="color: var(--text-color); opacity: 0.5; text-align: center; margin-top: 50px;">画像を選択すると詳細が表示されます</div>';
  }
  const infoContainer = document.getElementById('file-info-content');
  if (infoContainer) {
    infoContainer.innerHTML = '<div style="color: var(--text-color); opacity: 0.5; text-align: center; margin-top: 20px;">画像を選択してください</div>';
  }
}

const scheduleRefresh = debounce(() => {
  appState.preloadCursor = 0;
  appState.applyFiltersAndSort();
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

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = isRoot ? UIManager.ICONS.DRIVE : UIManager.ICONS.FOLDER;
  icon.style.marginRight = '4px';
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';

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

function getPathsFromDragEvent(e) {
  if (appState.dragState.paths && appState.dragState.paths.length > 0) {
    return [...appState.dragState.paths];
  }
  
  const paths = [];
  const jsonData = e.dataTransfer.getData('application/json');
  if (jsonData) {
    try { 
      const parsed = JSON.parse(jsonData); 
      if (Array.isArray(parsed)) return parsed;
    } catch(err) {}
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
  size: 'サイズ',
  mtime: '更新日時',
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

  const file = appState.filteredFiles[index];
  
  uiManager.updateSelectionUI();

  // 選択した画像やリスト行が画面内に表示されるように自動スクロール
  const items = uiManager.elements.thumbnailGrid.children;
  if (items[index]) {
    if (items[index].scrollIntoViewIfNeeded) {
      items[index].scrollIntoViewIfNeeded(false);
    } else {
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }
  const rows = uiManager.elements.fileListBody.children;
  if (rows[index]) {
    const thead = document.querySelector('#file-table thead');
    if (thead) {
      rows[index].style.scrollMarginTop = `${thead.getBoundingClientRect().height}px`;
    }
    
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  const requestId = ++appState.currentMetaRequestId;

  // インスペクターの更新
  renderMetadata(file);
}

function openViewer(index) {
  const file = appState.filteredFiles[index];

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
  content.style.backgroundColor = 'var(--modal-bg)';
  content.style.padding = '20px';
  content.style.borderRadius = '8px';
  content.style.border = '1px solid var(--modal-border)';
  content.style.width = '85%';
  content.style.maxWidth = '850px';
  content.style.height = '80%';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.boxShadow = '0 4px 20px rgba(0,0,0,0.8)';
  content.style.cursor = 'default';
  
  let licenseText = "ライセンス情報を読み込み中...";
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
    <h2 style="margin-top: 0; color: var(--glow-gold);">ライセンス情報</h2>
    <div style="background-color: rgba(224, 82, 99, 0.15); border: 1px solid var(--danger-red); border-radius: 4px; padding: 12px; margin-bottom: 15px; color: #f08a96; font-weight: bold; font-size: 14px;">
      ※本ソフトウェアは商用利用不可です。無保証・無サポートで提供されており、すべて自己責任でのご利用となります。
    </div>
    <div id="license-text" style="flex: 1; overflow-y: auto; background-color: rgba(0, 0, 0, 0.2); padding: 0px 20px 20px 20px; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color); font-family: sans-serif; white-space: normal; font-size: 14px; line-height: 1.6;">${parsedText}</div>
  `;
  
  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', keydownHandler, true);
  };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
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
  content.style.backgroundColor = 'rgba(19, 27, 30, 0.85)';
  content.style.padding = '30px';
  content.style.borderRadius = '10px';
  content.style.border = '1px solid var(--modal-border)';
  content.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
  content.style.cursor = 'default';
  
  content.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
      <h2 style="margin: 0; color: var(--glow-gold);">ヘルプ・ショートカット一覧</h2>
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
    <div style="display: flex; gap: 40px; font-size: inherit;">
      <div>
        <h3 style="color: var(--text-color); border-bottom: 1px solid var(--border-color); padding-bottom: 5px; margin-top: 0;">メイン画面</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr><td style="padding: 6px 15px; font-weight: bold;">F1 / H</td><td style="padding: 6px 15px;">ヘルプの表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + Tab / PageDown</td><td style="padding: 6px 15px;">次のタブへ</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + Shift + Tab / PageUp</td><td style="padding: 6px 15px;">前のタブへ</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">矢印キー</td><td style="padding: 6px 15px;">画像の選択を移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F5</td><td style="padding: 6px 15px;">最新の情報に更新</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl / Shift + クリック</td><td style="padding: 6px 15px;">画像の複数選択</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + A</td><td style="padding: 6px 15px;">すべての画像を選択</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + F</td><td style="padding: 6px 15px;">検索バーに入力</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">A</td><td style="padding: 6px 15px;">開いているビューワーを横一列に並べる</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">D</td><td style="padding: 6px 15px;">選択した2枚の画像のプロンプトを比較 (Diff)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F2</td><td style="padding: 6px 15px;">選択中のファイル / フォルダの名前を変更</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">選択中のファイル / フォルダをゴミ箱に移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">選択中の画像をコピー</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">ダブルクリック</td><td style="padding: 6px 15px;">サムネイルからビューワーを開く</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ヘルプを閉じる</td></tr>
        </table>
      </div>
      <div>
        <h3 style="color: var(--text-color); border-bottom: 1px solid var(--border-color); padding-bottom: 5px; margin-top: 0;">ビューワー画面</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr><td style="padding: 6px 15px; font-weight: bold;">マウスホイール</td><td style="padding: 6px 15px;">前 / 次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">左 / 右クリック</td><td style="padding: 6px 15px;">次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">← / →</td><td style="padding: 6px 15px;">前 / 次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">↑ / ↓</td><td style="padding: 6px 15px;">90度回転</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">0</td><td style="padding: 6px 15px;">100%表示（大きい画像はフィット）</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">1</td><td style="padding: 6px 15px;">完全な100%表示（画面外にはみ出す）</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Enter</td><td style="padding: 6px 15px;">ズーム解除 / 強制フィット切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F11</td><td style="padding: 6px 15px;">フルスクリーン切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">W</td><td style="padding: 6px 15px;">ウィンドウを画像にフィット</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">B</td><td style="padding: 6px 15px;">ウィンドウ枠の表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">U</td><td style="padding: 6px 15px;">画像のシャープ / 滑らか表示切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">左ドラッグ</td><td style="padding: 6px 15px;">ウィンドウの移動（ズーム時は画像移動）</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + 左ドラッグ</td><td style="padding: 6px 15px;">画像内を自由に移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">画像をゴミ箱に移動して次へ</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">画像をクリップボードにコピー</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ビューワーを閉じる</td></tr>
        </table>
      </div>
    </div>
  `;
  
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'license-link') {
      showLicenseDialog();
      return;
    }
    toggleHelpOverlay(false);
  });
  
  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

/**
 * タブコンテナのレイアウトはCSSで制御されるように変更されました。
 */
function updateTabLayout() {
}

/**
 * 現在のタブの状態を同期します。
 */
function updateCurrentTabState() {
  if (appState.activeTabIndex >= 0 && appState.tabs[appState.activeTabIndex]) {
    const currentTab = appState.tabs[appState.activeTabIndex];
    if (typeof appState.searchQuery !== 'undefined') currentTab.searchQuery = appState.searchQuery;
    if (appState.sortConfig) currentTab.sortConfig = JSON.parse(JSON.stringify(appState.sortConfig));
    if (uiManager.elements.thumbnailGrid) {
      currentTab.scrollTop = uiManager.elements.thumbnailGrid.scrollTop || 0;
    }
  }
}

/**
 * タブの状態をローカルストレージに保存します。
 */
function saveTabsState() {
  updateCurrentTabState();
  const state = {
    tabs: appState.tabs.map(t => ({ 
      id: t.id, path: t.path, name: t.name,
      searchQuery: t.searchQuery || '',
      sortConfig: t.sortConfig || { key: 'name', asc: true },
      scrollTop: t.scrollTop || 0
    })),
    activeTabIndex: appState.activeTabIndex
  };
  localStorage.setItem('tabsState', JSON.stringify(state));
}

/**
 * パスからタブの表示名を取得します。お気に入りに登録されている場合はその名前を優先します。
 */
function getTabNameForPath(path) {
  if (!path) return '';
  if (path === 'PC') return 'PC';
  const fav = appState.favorites.find(f => f.path === path);
  if (fav) return fav.name;
  return path.split('\\').pop() || path;
}

// --- タブ操作 ---
window.onTabClick = async (index) => {
  if (index === appState.activeTabIndex) return;
  updateCurrentTabState();
  
  appState.activeTabIndex = index;
  uiManager.renderTabs();
  
  const tab = appState.tabs[index];
  
  appState.searchQuery = tab.searchQuery || '';
  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.value = appState.searchQuery;
  }
  
  if (tab.sortConfig) {
    appState.sortConfig = JSON.parse(JSON.stringify(tab.sortConfig));
    localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
    updateSortIndicators();
  }

  if (window.veloceAPI.loadDirectory) {
    const result = await window.veloceAPI.loadDirectory(tab.path);
    if (result && result.imageFiles) {
      appState.currentDirectory = result.path;
      tab.path = result.path;
      tab.name = getTabNameForPath(result.path);
      localStorage.setItem('currentDirectory', appState.currentDirectory);
      applyNewFileList(result.imageFiles, false); // スクロールを0にリセットしない
      
      setTimeout(() => {
        if (uiManager.elements.thumbnailGrid && tab.scrollTop !== undefined) {
          uiManager.elements.thumbnailGrid.scrollTop = tab.scrollTop;
        }
      }, 100);

      await expandTreeToPath(appState.currentDirectory);
      uiManager.renderTabs();
      saveTabsState();
    }
  }
};

window.onNewTabClick = async () => {
  let newPath = 'PC';
  try {
    if (window.__TAURI__ && window.__TAURI__.path && window.__TAURI__.path.pictureDir) {
      newPath = await window.__TAURI__.path.pictureDir();
    }
  } catch (e) {
    console.warn("Failed to get picture dir:", e);
  }

  const newTab = {
    id: Date.now(),
    path: newPath,
    name: getTabNameForPath(newPath),
    isNew: true,
    searchQuery: '',
    sortConfig: { key: 'name', asc: true },
    scrollTop: 0
  };
  appState.tabs.push(newTab);
  saveTabsState();
  
  // 追加した新しいタブを選択して内容を読み込む
  await window.onTabClick(appState.tabs.length - 1);

  // タブが増えた際に、新しく追加された右端へスクロールする
  const container = document.getElementById('tab-container');
  if (container) {
    container.scrollLeft = container.scrollWidth;
  }
};

window.onTabClose = async (index) => {
  if (appState.tabs.length <= 1) return; // 最後のタブは閉じない

  const tabToRemove = appState.tabs[index];
  if (!tabToRemove || tabToRemove.isClosing) return;
  tabToRemove.isClosing = true;

  const container = document.getElementById('tab-container');
  let delay = 0;
  let targetTabEl = null;

  if (container) {
    targetTabEl = container.querySelector(`.tab-item[data-index="${index}"]`);
    if (targetTabEl) {
      targetTabEl.style.width = `${targetTabEl.offsetWidth}px`;
      targetTabEl.style.minWidth = '0px';
      void targetTabEl.offsetWidth; // リフローを強制して現在幅を確定
      targetTabEl.classList.add('tab-fade-out');
      targetTabEl.removeAttribute('data-index'); // 他の処理が誤作動しないようインデックスを外す
      delay = 200; // アニメーションの完了を待つ
    }
  }

  // アニメーションを待たずにデータは即座に削除・同期する
  appState.tabs.splice(index, 1);
  saveTabsState();

  let shouldSwitch = false;
  let nextIndex = appState.activeTabIndex;

  if (appState.activeTabIndex === index) {
    nextIndex = index - 1;
    if (nextIndex < 0) nextIndex = 0;
    shouldSwitch = true;
    appState.activeTabIndex = -1; // 強制的に切り替えイベントを発生させる
  } else if (appState.activeTabIndex > index) {
    appState.activeTabIndex -= 1;
  }

  if (shouldSwitch) {
    await window.onTabClick(nextIndex);
  } else {
    uiManager.renderTabs();
  }

  // アニメーション完了後にDOMからクリーンアップ
  if (delay > 0) {
    setTimeout(() => {
      if (targetTabEl && targetTabEl.parentElement) targetTabEl.remove();
    }, delay);
  } else {
    if (targetTabEl && targetTabEl.parentElement) targetTabEl.remove();
  }
};

window.onTabMove = (fromIndex, toIndex, insertAfter) => {
  if (fromIndex === toIndex) return;

  const tabs = appState.tabs;
  const activeTab = tabs[appState.activeTabIndex]; // アクティブなタブを見失わないように保持
  
  const [movedTab] = tabs.splice(fromIndex, 1);
  
  let adjustedToIndex = toIndex;
  if (fromIndex < toIndex) {
    adjustedToIndex -= 1; // 自身が抜けた分、インデックスを1つ左に詰める
  }
  if (insertAfter) {
    adjustedToIndex += 1;
  }
  
  tabs.splice(adjustedToIndex, 0, movedTab);
  appState.activeTabIndex = tabs.indexOf(activeTab); // 再計算されたインデックスに戻す
  
  uiManager.renderTabs();
  saveTabsState();
};

// ============================================================================
// 4. Event Handlers (User Interactions)
// ============================================================================

const menuNewFolder = createMenuOption('フォルダ新規作成', async () => {
  if (!contextMenu.targetFolder) return;
  const folderName = await uiManager.showPrompt('新しいフォルダ名を入力してください:');
  if (folderName !== null) {
    if (folderName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(folderName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
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
      alert('フォルダの作成に失敗しました:\n' + (result ? result.error : 'Unknown error'));
    }
  }
});

/**
 * 指定されたファイルのメタデータをインスペクターに描画します。
 * Diff画面と同一のデザイン、項目順、コピー機能を提供します。
 */
async function renderMetadata(file) {
  const container = document.getElementById('inspector-content');
  const infoContainer = document.getElementById('file-info-content');
  if (!file || !container) return;

  try {
    // データの取得と安全なフォールバック
    const rawMeta = await window.veloceAPI.parseMetadata(file.path);
    const meta = rawMeta || {};
    const p = meta.params || {};

    // Diff画面と共通のデータ抽出ロジック
    const extractData = () => {
      const data = {
        source: meta.source || file.source || null,
        prompt: meta.prompt || file.prompt || '',
        negativePrompt: meta.negativePrompt || file.negativePrompt || '',
        chars: [],
        params: {}
      };
      if (Array.isArray(p.characterPrompts)) {
        data.chars = p.characterPrompts.map(cp => ({ prompt: cp.prompt || '', uc: cp.uc || '' }));
      } else if (Array.isArray(file.charPrompts)) {
        data.chars = file.charPrompts.map(cp => ({
          prompt: (cp && typeof cp === 'object' && cp.prompt) ? cp.prompt : String(cp),
          uc: (cp && typeof cp === 'object' && cp.uc) ? cp.uc : ''
        }));
      }
      
      const formatNumber = (num) => {
        if (num === null || num === undefined) return null;
        const n = Number(num);
        return !isNaN(n) ? n.toLocaleString() : num;
      };

      const w = p.width || meta.width;
      const h = p.height || meta.height;
      const res = (w && h) ? `${formatNumber(w)}x${formatNumber(h)}` : null;

      let sampler = p.sampler || file.sampler || null;
      if (sampler && p.sm && !sampler.includes('karras')) sampler += " (karras)";
      data.params = {
        resolution: res, seed: p.seed ?? file.seed ?? null,
        steps: formatNumber(p.steps ?? file.steps ?? null), sampler: sampler,
        scale: p.scale ?? file.scale ?? null, cfg_rescale: p.cfg_rescale ?? file.cfg_rescale ?? null,
        uncond_scale: p.uncond_scale ?? file.uncond_scale ?? null,
        rawParameters: p.rawParameters ?? file.rawParameters ?? null
      };
      return data;
    };

    if (infoContainer) {
      const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
      const getAspectRatio = (w, h) => {
        if (!w || !h) return '';
        const d = gcd(w, h);
        const rw = w / d;
        const rh = h / d;
        if (rw > 100 || rh > 100) {
          return `${(w / h).toFixed(2)}:1`;
        }
        return `${rw}:${rh}`;
      };

      let cleanExt = file.ext || '';
      if (cleanExt.startsWith('.')) cleanExt = cleanExt.substring(1);
      const fullName = cleanExt && !file.name.toLowerCase().endsWith('.' + cleanExt.toLowerCase()) ? `${file.name}.${cleanExt}` : file.name;
      const sizeStr = file.size ? `${formatSize(file.size)} bytes` : '-';
      const resStr = (file.width && file.height) ? `${Number(file.width).toLocaleString()} x ${Number(file.height).toLocaleString()}` : '-';
      const ratioStr = (file.width && file.height) ? ` (${getAspectRatio(file.width, file.height)})` : '';
      const mtimeStr = file.mtime ? formatDate(file.mtime) : '-';
      
      let ctimeValue = file.ctime;
      if (!ctimeValue && meta) {
        const metaDate = meta.timestamp || meta.date || meta.CreationTime || meta['Creation Time'];
        if (metaDate) {
          const parsed = Date.parse(metaDate);
          if (!isNaN(parsed)) ctimeValue = parsed;
        }
      }
      const ctimeStr = ctimeValue ? formatDate(ctimeValue) : '-';
      
      const renderInfoSection = (title, text) => {
        return `
          <div class="inspector-section" style="margin-bottom: 15px;">
            <h3 style="font-size: 0.9em; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; color: var(--text-color); transition: color 0.2s;">
              <span>${title}</span>
            </h3>
            <div class="prompt-look param-box" style="height: auto; min-height: 34px;">
              <span class="diff-tag common" style="border: none; background: transparent; padding: 0; word-break: break-all; white-space: normal;">${text}</span>
            </div>
          </div>
        `;
      };

      infoContainer.innerHTML = `
        ${renderInfoSection('ファイル名', fullName)}
        ${renderInfoSection('ファイルサイズ', sizeStr)}
        ${renderInfoSection('解像度とアスペクト比', `${resStr}${ratioStr}`)}
        ${renderInfoSection('作成日時', ctimeStr)}
        ${renderInfoSection('更新日時', mtimeStr)}
      `;
    }

    const d = extractData();

    // --- 【最強版】検索キーワードの確実な取得 ---
    let searchStr = '';
    if (uiManager.elements.searchBar && uiManager.elements.searchBar.value) {
      searchStr = uiManager.elements.searchBar.value;
    } else if (typeof appState !== 'undefined' && appState.searchQuery) {
      searchStr = appState.searchQuery;
    }
    
    const terms = searchStr.trim() !== '' 
      ? searchStr.toLowerCase().split(',').map(t => t.trim()).filter(t => t) 
      : [];

    // ヘルパー: セクション描画
    const renderSection = (title, text, isParam = false) => {
      if (!text || text === '-') return '';
      const tags = String(text).split(',').map(t => t.trim()).filter(t => t);
      const boxClass = isParam ? "prompt-look param-box" : "prompt-look";
      
      const tagsHtml = tags.map(t => {
        const isMatch = terms.some(term => t.toLowerCase().includes(term));
        const matchStyle = isMatch 
          ? 'border: 1px solid #ffcc00; background-color: rgba(255, 204, 0, 0.25); color: #ffcc00; font-weight: bold; box-shadow: 0 0 8px rgba(255,204,0,0.3);' 
          : '';
          
        const displayHtml = typeof highlightText === 'function' ? highlightText(t, terms) : t;
        return `<span class="diff-tag common" style="${matchStyle}">${displayHtml}</span>`;
      }).join('');

      return `
        <div class="inspector-section" style="margin-bottom: 15px;">
          <h3 style="font-size: 0.9em; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; color: var(--text-color); transition: color 0.2s;">
            <span>${title}</span>${UIManager.createCopyButtonHTML(text)}
          </h3>
          <div class="${boxClass}">
            ${tagsHtml}
          </div>
        </div>
      `;
    };

    let html = '';
    html += renderSection('モデル / バージョン', d.source, true);
    html += renderSection('プロンプト', d.prompt);
    html += renderSection('除外したい要素', d.negativePrompt);
    d.chars.forEach((c, i) => {
      html += renderSection(`キャラクター ${i + 1} プロンプト`, c.prompt);
      html += renderSection(`キャラクター ${i + 1} 除外したい要素`, c.uc);
    });
    html += renderSection('画像サイズ', d.params.resolution, true);
    html += renderSection('シード値', d.params.seed, true);
    html += renderSection('ステップ', d.params.steps, true);
    html += renderSection('サンプラー', d.params.sampler, true);
    html += renderSection('プロンプトガイダンス', d.params.scale, true);
    html += renderSection('プロンプトガイダンスの再調整', d.params.cfg_rescale, true);
    html += renderSection('除外したい要素の強さ', d.params.uncond_scale, true);
    html += renderSection('生成パラメータ (Raw)', d.params.rawParameters);

    // プロンプトが何もない場合（または抽出に失敗した場合）
    if (html === '') {
      const rawMetaStr = JSON.stringify(meta, null, 2);
      if (rawMetaStr !== '{}' && rawMetaStr !== 'null') {
        const escapedMeta = rawMetaStr.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html = `
          <div style="padding: 10px; color: var(--text-color);">
            <h3 style="font-size: 1em; margin-bottom: 10px;">未対応のメタデータ形式</h3>
            <p style="font-size: 0.85em; margin-bottom: 10px; line-height: 1.4;">データは読み込めていますが、NovelAIなどの特殊な格納形式になっています。以下の生データを確認してください：</p>
            <div class="prompt-look" style="white-space: pre-wrap; font-family: Consolas, monospace; font-size: 0.85em; word-break: break-all; max-height: 400px; overflow-y: auto;">${escapedMeta}</div>
          </div>
        `;
      } else {
        html = '<div style="color: var(--text-color); opacity: 0.5; text-align: center; margin-top: 50px;">メタデータが含まれていないか、読み取れませんでした。</div>';
      }
    }

    container.innerHTML = html;

    // コピーイベントの登録 (ファイル情報ペインとインスペクターの両方)
    const newCopyBtns = [];
    if (container) newCopyBtns.push(...container.querySelectorAll('.diff-copy-btn'));
    if (infoContainer) newCopyBtns.push(...infoContainer.querySelectorAll('.diff-copy-btn'));

    newCopyBtns.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget;
        const text = target.getAttribute('data-copy-text');
        if (text) {
          await navigator.clipboard.writeText(text);
          if (window.uiManager) window.uiManager.showToast("クリップボードにコピーしました", 3000, null, 'success');
          else showNotification("クリップボードにコピーしました", 'success'); // 古い関数へのフォールバック
          uiManager.applyGlowEffect(target);
        }
      });
    });

    // --- 【追加】ドラッグ選択コピー時のカンマ自動挿入ロジック ---
    const newPromptLooks = [];
    if (container) newPromptLooks.push(...container.querySelectorAll('.prompt-look'));
    if (infoContainer) newPromptLooks.push(...infoContainer.querySelectorAll('.prompt-look'));

    newPromptLooks.forEach(lookDiv => {
      lookDiv.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (selection.isCollapsed) return;

        const clone = selection.getRangeAt(0).cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(clone);

        const tags = tempDiv.querySelectorAll('.diff-tag');
        tags.forEach(tag => {
          tag.textContent = tag.textContent + ", ";
        });

        let copiedText = tempDiv.textContent;
        copiedText = copiedText.replace(/,\s*$/, '').trim();

        e.clipboardData.setData('text/plain', copiedText);
        e.preventDefault();
      });
    });
    // --- ここまで ---
  } catch (error) {
    container.innerHTML = `<div style="color:var(--danger-red); padding:10px; font-size:0.9em; border:1px solid var(--danger-red);">描画エラー: ${error.message}</div>`;
  }
}

const menuRenameFolder = createMenuOption('フォルダ名変更', async () => {
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

const menuDeleteFolder = createMenuOption('フォルダ削除', async () => {
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
      alert('フォルダの削除に失敗しました:\n' + (result ? result.error : 'Unknown error'));
    }
  }
});

const menuRenameFile = createMenuOption('ファイル名変更', renameSelectedFile);
const menuDeleteFile = createMenuOption('ファイル削除', deleteSelectedFiles);

const menuAddFavorite = createMenuOption('お気に入りに追加', async () => {
  if (!contextMenu.targetFolder) return;
  const path = contextMenu.targetFolder.path;
  const name = contextMenu.targetFolder.name;
  if (appState.favorites.find(f => f.path === path)) {
    showNotification(`「${name}」はすでにお気に入りにあります`, 'warning');
    return;
  }
  appState.favorites.push({ id: Date.now().toString(), name, path, icon: 'FAV_STAR' });
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

const FAV_ICONS_LIST = ['FAV_STAR', 'FAV_HEART', 'FAV_BOOKMARK', 'FAV_FLAG', 'FAV_TAG', 'FAV_FOLDER'];
let selectedFavIcon = 'FAV_STAR';

function renderFavIconSelector(currentIcon) {
  const container = document.getElementById('fav-icon-selector');
  if (!container) return;
  container.innerHTML = '';
  
  // 過去の絵文字データなどがある場合は星をデフォルト選択として扱う
  selectedFavIcon = (currentIcon && currentIcon.startsWith('FAV_')) ? currentIcon : 'FAV_STAR';

  FAV_ICONS_LIST.forEach(key => {
    const item = document.createElement('div');
    item.className = `icon-selector-item ${key === selectedFavIcon ? 'selected' : ''}`;
    item.innerHTML = UIManager.ICONS[key];
    item.addEventListener('click', () => {
      selectedFavIcon = key;
      Array.from(container.children).forEach(child => child.classList.remove('selected'));
      item.classList.add('selected');
    });
    container.appendChild(item);
  });
}

const menuEditFavorite = createMenuOption('お気に入りを編集...', () => {
  if (!contextMenu.targetFavoriteId) return;
  const fav = appState.favorites.find(f => f.id === contextMenu.targetFavoriteId);
  if (fav) {
    renderFavIconSelector(fav.icon);
    document.getElementById('fav-name-input').value = fav.name;
    document.getElementById('fav-path-input').value = fav.path;
    contextMenu.editingFavoriteId = fav.id;
    document.getElementById('edit-favorite-modal').style.display = 'flex';
  }
});

const menuDeleteFavorite = createMenuOption('お気に入りを削除', async () => {
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
});

const menuOpenInExplorer = createMenuOption('エクスプローラで開く', async () => {
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

const menuOpenInNewTab = createMenuOption('新しいタブで開く', async () => {
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
      scrollTop: 0
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

// --- タブ用メニューの作成 ---
const menuTabClose = createMenuOption('閉じる', () => {
  if (contextMenu.targetTabIndex !== undefined) {
    window.onTabClose(contextMenu.targetTabIndex);
  }
});

const menuTabDuplicate = createMenuOption('タブを複製', async () => {
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
    scrollTop: sourceTab.scrollTop || 0
  };

  const insertAtIndex = sourceIndex + 1;
  appState.tabs.splice(insertAtIndex, 0, newTab);

  appState.activeTabIndex = -1; // 切り替えを強制
  await window.onTabClick(insertAtIndex);
});

const menuTabCloseOthers = createMenuOption('他のタブをすべて閉じる', async () => {
  if (contextMenu.targetTabIndex !== undefined) {
    const targetTab = appState.tabs[contextMenu.targetTabIndex];
    appState.tabs = [targetTab];
    appState.activeTabIndex = -1; // 再読み込みを強制するためリセット
    saveTabsState();
    uiManager.renderTabs();
    await window.onTabClick(0);
  }
});

const menuTabCloseRight = createMenuOption('右側のタブをすべて閉じる', async () => {
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

const menuSeparatorTab1 = createMenuSeparator();

const menuTabOpenExplorer = createMenuOption('エクスプローラで開く', async () => {
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

const menuTabCopyPath = createMenuOption('パスをコピー', async () => {
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

const menuSeparatorTab2 = createMenuSeparator();

const menuTabAddFavorite = createMenuOption('お気に入りに追加', () => {
  if (contextMenu.targetTabIndex !== undefined) {
    if (menuTabAddFavorite.disabled) return;
    const tab = appState.tabs[contextMenu.targetTabIndex];
    if (tab) {
      const path = tab.path;
      const name = tab.name;
      if (appState.favorites.find(f => f.path === path)) {
        return;
      }
      appState.favorites.push({ id: Date.now().toString(), name, path, icon: 'FAV_STAR' });
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

contextMenu.appendChild(menuNewFolder);
contextMenu.appendChild(menuRenameFolder);
contextMenu.appendChild(menuDeleteFolder);
contextMenu.appendChild(menuRenameFile);
contextMenu.appendChild(menuDeleteFile);
contextMenu.appendChild(menuAddFavorite);
contextMenu.appendChild(menuEditFavorite);
contextMenu.appendChild(menuDeleteFavorite);
contextMenu.appendChild(menuSeparatorFav);
contextMenu.appendChild(menuOpenInExplorer);
contextMenu.appendChild(menuOpenInNewTab);
contextMenu.appendChild(menuTabClose);
contextMenu.appendChild(menuTabDuplicate);
contextMenu.appendChild(menuTabCloseOthers);
contextMenu.appendChild(menuTabCloseRight);
contextMenu.appendChild(menuSeparatorTab1);
contextMenu.appendChild(menuTabOpenExplorer);
contextMenu.appendChild(menuTabCopyPath);
contextMenu.appendChild(menuSeparatorTab2);
contextMenu.appendChild(menuTabAddFavorite);
document.body.appendChild(contextMenu);

window.onTabContextMenu = (e, index) => {
  e.preventDefault();
  e.stopPropagation();

  contextMenu.targetTabIndex = index;
  const tab = appState.tabs[index];

  // メニューを一度すべて非表示にする
  Array.from(contextMenu.children).forEach(child => child.style.display = 'none');

  menuTabClose.style.display = 'block';
  menuTabDuplicate.style.display = 'block';
  menuTabCloseOthers.style.display = 'block';
  menuTabCloseRight.style.display = 'block';
  menuSeparatorTab1.style.display = 'block';
  menuTabOpenExplorer.style.display = 'block';
  menuTabCopyPath.style.display = 'block';
  menuSeparatorTab2.style.display = 'block';
  menuTabAddFavorite.style.display = 'block';

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

  contextMenu.style.display = 'block';
  const rect = contextMenu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
};

const closeAllMenus = (e) => {
  if (e && (e.type === 'mousedown' || e.type === 'click' || e.type === 'contextmenu')) {
    if (e.target instanceof Element && (e.target.closest('#context-menu') || e.target.closest('#tab-list-menu'))) return;
  }
  if (contextMenu.style.display === 'block') contextMenu.style.display = 'none';
  if (tabListMenu.style.display === 'block') tabListMenu.style.display = 'none';
};

window.addEventListener('click', closeAllMenus);
window.addEventListener('mousedown', closeAllMenus);

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
document.body.appendChild(dragTooltip);

document.addEventListener('dragend', async () => {
  dragTooltip.classList.remove('show');
  appState.dragState.paths = [];
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
  const paths = Array.from(appState.selection).map(idx => appState.filteredFiles[idx].path);
  e.dataTransfer.setData('application/json', JSON.stringify(paths));
  e.dataTransfer.setData('text/plain', paths[0]);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setDragImage(emptyDragImage, 0, 0);
  appState.dragState.paths = paths;
  appState.dragState.isAppDragging = true;
}

function handleItemContextMenu(e, isGrid) {
  e.preventDefault();
  e.stopPropagation();

  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) selectImage(index);

  menuNewFolder.style.display = 'none';
  menuRenameFolder.style.display = 'none';
  menuDeleteFolder.style.display = 'none';
  menuRenameFile.style.display = appState.selection.size === 1 ? 'block' : 'none'; 
  menuDeleteFile.style.display = 'block';
  menuAddFavorite.style.display = 'none';
  menuEditFavorite.style.display = 'none';
  menuDeleteFavorite.style.display = 'none';
  menuSeparatorFav.style.display = 'none';
  menuOpenInExplorer.style.display = 'none';
  menuOpenInNewTab.style.display = 'none';

  menuTabClose.style.display = 'none';
  menuTabDuplicate.style.display = 'none';
  menuTabCloseOthers.style.display = 'none';
  menuTabCloseRight.style.display = 'none';
  menuSeparatorTab1.style.display = 'none';
  menuTabOpenExplorer.style.display = 'none';
  menuTabCopyPath.style.display = 'none';
  menuSeparatorTab2.style.display = 'none';
  menuTabAddFavorite.style.display = 'none';

  contextMenu.style.display = 'block';
  const rect = contextMenu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;
  
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

uiManager.elements.thumbnailGrid.addEventListener('click', (e) => handleItemClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dblclick', (e) => handleItemDblClick(e, true));
uiManager.elements.thumbnailGrid.addEventListener('dragstart', (e) => handleItemDragStart(e, true));
uiManager.elements.thumbnailGrid.addEventListener('contextmenu', (e) => handleItemContextMenu(e, true));

uiManager.elements.fileListBody.addEventListener('click', (e) => handleItemClick(e, false));
uiManager.elements.fileListBody.addEventListener('dragstart', (e) => handleItemDragStart(e, false));
uiManager.elements.fileListBody.addEventListener('contextmenu', (e) => handleItemContextMenu(e, false));

// ============================================================================
// Directory Tree Event Delegation
// ============================================================================
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
      const result = await window.veloceAPI.loadDirectory(path);
      if (result) {
        // タブの状態を更新
        activeTab.path = result.path;
        activeTab.name = getTabNameForPath(result.path);
        activeTab.scrollTop = 0; // 別フォルダ移動時はスクロールリセット
        
        // グローバルな状態も更新して既存の関数との互換性を保つ
        appState.currentDirectory = result.path;
        localStorage.setItem('currentDirectory', appState.currentDirectory);

        applyNewFileList(result.imageFiles, true);
        uiManager.renderTabs(); // タブ名の変更をUIに反映
        saveTabsState();
      }
    }
  }

  const wasSelected = itemDiv.classList.contains('selected');
  const icon = e.target.closest('.tree-icon');

  if (icon || wasSelected) {
    if (isExpanded) {
      if (itemDiv.collapseNode) itemDiv.collapseNode();
    } else {
      if (itemDiv.expandNode) await itemDiv.expandNode();
    }
  } else {
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
  contextMenu.isRoot = isRoot;

  menuNewFolder.style.display = 'block';
  menuRenameFolder.style.display = isRoot ? 'none' : 'block';
  menuDeleteFolder.style.display = isRoot ? 'none' : 'block';
  menuRenameFile.style.display = 'none';
  menuDeleteFile.style.display = 'none';
  menuAddFavorite.style.display = isRoot ? 'none' : 'block';
  menuEditFavorite.style.display = 'none';
  menuDeleteFavorite.style.display = 'none';
  menuSeparatorFav.style.display = 'none';
  menuOpenInExplorer.style.display = 'none';
  menuOpenInNewTab.style.display = 'block';

  menuTabClose.style.display = 'none';
  menuTabDuplicate.style.display = 'none';
  menuTabCloseOthers.style.display = 'none';
  menuTabCloseRight.style.display = 'none';
  menuSeparatorTab1.style.display = 'none';
  menuTabOpenExplorer.style.display = 'none';
  menuTabCopyPath.style.display = 'none';
  menuSeparatorTab2.style.display = 'none';
  menuTabAddFavorite.style.display = 'none';

  contextMenu.style.display = 'block';
  const rect = contextMenu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
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
  e.dataTransfer.effectAllowed = 'copy';
});

uiManager.elements.dirTree.addEventListener('dragenter', (e) => {
  if (draggedFavoriteId || Array.from(e.dataTransfer.types).includes('application/json-folder')) return; // お気に入り関連のドラッグ中は無視
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();
  itemDiv.style.backgroundColor = 'rgba(37, 126, 140, 0.3)';
});

uiManager.elements.dirTree.addEventListener('dragover', (e) => {
  if (draggedFavoriteId || Array.from(e.dataTransfer.types).includes('application/json-folder')) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();

  let actionStr = 'コピー';
  if (appState.dragState.paths.length > 0) {
    const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
    actionStr = getRoot(appState.dragState.paths[0]) === getRoot(itemDiv.dataset.path) ? '移動' : 'コピー';
  }
  e.dataTransfer.dropEffect = actionStr === '移動' ? 'move' : 'copy';

  const isRoot = itemDiv.dataset.isRoot === 'true';
  const folderName = isRoot ? itemDiv.dataset.path : itemDiv.dataset.name;
  const countStr = appState.dragState.paths.length > 1 ? `${appState.dragState.paths.length}個のファイルを ` : '';
  dragTooltip.textContent = `${countStr}「${folderName}」へ${actionStr}`;
  dragTooltip.style.left = (e.clientX + 15) + 'px';
  dragTooltip.style.top = (e.clientY + 15) + 'px';
  dragTooltip.classList.add('show');
});

uiManager.elements.dirTree.addEventListener('dragleave', (e) => {
  if (draggedFavoriteId || Array.from(e.dataTransfer.types).includes('application/json-folder')) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  if (!itemDiv.contains(e.relatedTarget)) {
    itemDiv.style.backgroundColor = '';
    dragTooltip.classList.remove('show');
  }
});

uiManager.elements.dirTree.addEventListener('drop', (e) => {
  if (draggedFavoriteId || Array.from(e.dataTransfer.types).includes('application/json-folder')) return;
  const itemDiv = e.target.closest('.tree-item');
  if (!itemDiv) return;
  e.preventDefault();
  itemDiv.style.backgroundColor = '';
  dragTooltip.classList.remove('show');

  const paths = getPathsFromDragEvent(e);
  if (paths.length > 0 && window.veloceAPI.moveOrCopyFile) {
    let actionStr = 'コピー';
    if (paths.length > 0) {
      const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
      actionStr = getRoot(paths[0]) === getRoot(itemDiv.dataset.path) ? '移動' : 'コピー';
    }

    uiManager.showToast(`${paths.length}件のファイルを${actionStr}中...`, 0, 'file-move', 'info');

    setTimeout(async () => {
      let successCount = 0;
      for (const p of paths) {
        const result = await window.veloceAPI.moveOrCopyFile(p, itemDiv.dataset.path);
        if (result && result.success) {
          successCount++;
        }
      }
      if (successCount > 0) {
        uiManager.showToast(`${successCount}件のファイルを${actionStr}しました`, 3000, 'file-move');
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
  btn.style.cssText = `
    position: absolute; display: flex; justify-content: center; align-items: center; opacity: 0.6;
    background-color: var(--border-color); border: 1px solid var(--modal-border); border-radius: 2px; cursor: pointer; color: var(--text-color);
    z-index: 1000; top: 50%; left: 50%; transform: translate(-50%, -50%);
  `;
  
  const isVertical = type === 'center' || type === 'leftTop' || type === 'rightTop';
  btn.style.width = isVertical ? '30px' : '14px';
  btn.style.height = isVertical ? '14px' : '30px';
  
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
        localStorage.setItem('topHeight', restoreHeight);
        btn.innerHTML = openIcon;
      } else {
        // 閉じる直前の高さを prevTopHeight として退避させてから 0px にする
        localStorage.setItem('prevTopHeight', root.style.getPropertyValue('--top-height') || '250px');
        root.style.setProperty('--top-height', '0px');
        localStorage.setItem('topHeight', '0px');
        btn.innerHTML = closeIcon;
      }
    } else if (type === 'leftTop') {
      const root = document.documentElement;
      const isCollapsed = root.style.getPropertyValue('--left-top-height') === '0px';
      if (isCollapsed) {
        const restoreHeight = localStorage.getItem('prevLeftTopHeight') || '150px';
        root.style.setProperty('--left-top-height', restoreHeight);
        localStorage.setItem('leftTopHeight', restoreHeight);
        appState.layout.leftTopVisible = true;
        btn.innerHTML = openIcon;
      } else {
        localStorage.setItem('prevLeftTopHeight', root.style.getPropertyValue('--left-top-height') || '150px');
        root.style.setProperty('--left-top-height', '0px');
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
          localStorage.setItem('topHeight', '0px');
          const btn = uiManager.elements.resizerCenter?.querySelector('.resizer-toggle');
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
        }
      } else {
        newHeight = Math.max(50, Math.min(newHeight, rect.height - 50));
        const root = document.documentElement;
        root.style.setProperty('--top-height', `${newHeight}px`);
        
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
          localStorage.setItem('leftTopHeight', '0px');
          const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
          if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
        }
      } else {
        newHeight = Math.max(30, Math.min(newHeight, rect.height - 30));
        const root = document.documentElement;
        root.style.setProperty('--left-top-height', `${newHeight}px`);
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
  const size = parseFloat(uiManager.elements.thumbnailSizeSlider.value) || 120;
  document.body.style.setProperty('--thumbnail-size', `${size}px`);
}

uiManager.elements.thumbnailSizeSlider.addEventListener('input', updateThumbnailSize);

uiManager.elements.thumbnailSizeSlider.addEventListener('change', (e) => {
  localStorage.setItem('thumbnailScale', e.target.value);
});

window.addEventListener('resize', debounce(() => {
  if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      localStorage.setItem('mainWinMaximized', isMax);
      updateTabLayout(); // ウィンドウサイズ変更時にタブレイアウトも更新
      if (!isMax) {
        localStorage.setItem('mainWinWidth', window.outerWidth);
        localStorage.setItem('mainWinHeight', window.outerHeight);
        localStorage.setItem('mainWinX', window.screenX);
        localStorage.setItem('mainWinY', window.screenY);
      }
    });
  }
  updateTabLayout();
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
	appState.applyFiltersAndSort();
	uiManager.renderAll(true);
  });
});

window.addEventListener('keydown', async (e) => {
  const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';

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
            tabEls[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
    if (document.getElementById('help-overlay')) {
      e.preventDefault();
      toggleHelpOverlay(false);
      return;
    }
    if (contextMenu.style.display === 'block' || tabListMenu.style.display === 'block') {
      e.preventDefault();
      contextMenu.style.display = 'none';
      tabListMenu.style.display = 'none';
      return;
    }
  }

  if (e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    if (window.veloceAPI.arrangeViewers) {
      window.veloceAPI.arrangeViewers().then(() => {
        if (window.veloceAPI.focusWindow) window.veloceAPI.focusWindow();
      });
    }
  }

  if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    if (appState.selection.size === 2) {
      const indices = Array.from(appState.selection);
      const file1 = appState.filteredFiles[indices[0]];
      const file2 = appState.filteredFiles[indices[1]];
      
      // 完全なメタデータを取得してからDiffモーダルを開く
      uiManager.showToast('比較データを読み込み中...', 0, 'diff-loading', 'info');
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

    if (appState.selectedIndex > -1 && appState.filteredFiles[appState.selectedIndex]) {
      window.veloceAPI.copyImageToClipboard(appState.filteredFiles[appState.selectedIndex].path);
      showNotification('画像をクリップボードにコピーしました', 'success');

      const applyFlash = (el) => {
        uiManager.applyGlowEffect(el);
      };

      applyFlash(uiManager.elements.thumbnailGrid.querySelector(`.thumbnail-item[data-index="${appState.selectedIndex}"]`));
      applyFlash(uiManager.elements.fileListBody.querySelector(`tr[data-index="${appState.selectedIndex}"]`));
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
    if (appState.filteredFiles.length === 0) return;

    appState.selection.clear();
    for (let i = 0; i < appState.filteredFiles.length; i++) {
      appState.selection.add(i);
    }
    appState.selectedIndex = appState.filteredFiles.length - 1; 

    uiManager.updateSelectionUI();
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    if (appState.filteredFiles.length === 0) return;
    
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
      else if (e.key === 'ArrowRight') newIndex = Math.min(appState.filteredFiles.length - 1, appState.selectedIndex + 1);
      else if (e.key === 'ArrowUp') newIndex = Math.max(0, appState.selectedIndex - columns);
      else if (e.key === 'ArrowDown') newIndex = Math.min(appState.filteredFiles.length - 1, appState.selectedIndex + columns);
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

// ============================================================================
// 5. Application Initialization
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  renderFavorites();

  const minBtn = document.getElementById('titlebar-minimize');
  const maxBtn = document.getElementById('titlebar-maximize');
  const closeBtn = document.getElementById('titlebar-close');
  const tabListBtn = document.getElementById('titlebar-tab-list');
  const tabContainer = document.getElementById('tab-container');
  const newTabBtn = document.getElementById('new-tab-btn');

  const titlebar = document.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-item') || e.target.closest('.titlebar-button')) return;
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
  }

  if (newTabBtn) {
    newTabBtn.addEventListener('mouseenter', (e) => {
      uiManager.showCustomTooltip('新しいタブを開く', e.clientX, e.clientY);
    });
    newTabBtn.addEventListener('mousemove', (e) => {
      uiManager.showCustomTooltip('新しいタブを開く', e.clientX, e.clientY);
    });
    newTabBtn.addEventListener('mouseleave', () => {
      uiManager.hideCustomTooltip();
    });
    newTabBtn.addEventListener('click', () => { 
      uiManager.hideCustomTooltip();
      if (window.onNewTabClick) window.onNewTabClick(); 
    });
  }

  const updateTabListMenu = () => {
    tabListMenu.innerHTML = '';
    appState.tabs.forEach((tab, index) => {
      const option = document.createElement('div');
        option.style.padding = '8px 16px';
        option.style.cursor = 'pointer';
        option.style.color = index === appState.activeTabIndex ? 'var(--accent-color)' : 'var(--text-color)';
        option.style.display = 'flex';
        option.style.alignItems = 'center';
        option.style.gap = '8px';
        option.style.overflow = 'hidden';

        const fav = appState.favorites.find(f => f.path === tab.path);
        let iconHtml = '';
        let iconColor = '';
        if (fav) {
          const iconKey = fav.icon && fav.icon.startsWith('FAV_') ? fav.icon : 'FAV_STAR';
          iconHtml = UIManager.ICONS[iconKey] || UIManager.ICONS.FAV_STAR;
          iconColor = index === appState.activeTabIndex ? 'var(--accent-color)' : 'var(--glow-gold)';
        } else {
          iconHtml = UIManager.ICONS.FOLDER;
        }
        
        const iconSpan = document.createElement('span');
        iconSpan.style.display = 'flex';
        iconSpan.style.alignItems = 'center';
        iconSpan.style.flexShrink = '0';
        iconSpan.style.width = '16px';
        iconSpan.innerHTML = iconHtml;
        if (iconColor) iconSpan.style.color = iconColor;
        
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
        nameLabel.style.fontSize = '13px';

        const pathLabel = document.createElement('span');
        pathLabel.textContent = tab.path;
        pathLabel.title = tab.path;
        pathLabel.style.whiteSpace = 'nowrap';
        pathLabel.style.overflow = 'hidden';
        pathLabel.style.textOverflow = 'ellipsis';
        pathLabel.style.fontSize = '11px';
        pathLabel.style.opacity = '0.6';
        pathLabel.style.marginTop = '2px';

        textContainer.appendChild(nameLabel);
        textContainer.appendChild(pathLabel);

        const checkSpan = document.createElement('span');
        checkSpan.style.display = 'flex';
        checkSpan.style.alignItems = 'center';
        checkSpan.style.flexShrink = '0';
        checkSpan.style.width = '14px';
        if (index === appState.activeTabIndex) {
           checkSpan.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        }

        const closeBtn = document.createElement('span');
        closeBtn.style.display = 'flex';
        closeBtn.style.alignItems = 'center';
        closeBtn.style.justifyContent = 'center';
        closeBtn.style.width = '20px';
        closeBtn.style.height = '20px';
        closeBtn.style.borderRadius = '50%';
        closeBtn.style.flexShrink = '0';
        closeBtn.style.opacity = '0';
        closeBtn.style.transition = 'all 0.1s ease';
        closeBtn.innerHTML = `<svg viewBox="0 0 10 10" width="8" height="8"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" stroke-width="1.5"/></svg>`;

        closeBtn.onmouseenter = () => {
          closeBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
        };
        closeBtn.onmouseleave = () => {
          closeBtn.style.backgroundColor = 'transparent';
        };

        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (window.onTabClose) {
            await window.onTabClose(index);
            if (tabListMenu.style.display === 'block') updateTabListMenu();
          }
        });

        option.appendChild(checkSpan);
        option.appendChild(iconSpan);
        option.appendChild(textContainer);
        option.appendChild(closeBtn);

        option.onmouseenter = () => {
          option.style.backgroundColor = 'var(--accent-color)';
          option.style.color = '#fff';
          if (iconColor) iconSpan.style.color = '#fff';
          closeBtn.style.opacity = '1';
        };
        option.onmouseleave = () => {
          option.style.backgroundColor = 'transparent';
          option.style.color = index === appState.activeTabIndex ? 'var(--accent-color)' : 'var(--text-color)';
          if (iconColor) iconSpan.style.color = index === appState.activeTabIndex ? 'var(--accent-color)' : 'var(--glow-gold)';
          closeBtn.style.opacity = '0';
        };
        
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
                tabEls[index].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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

      tabListMenu.style.display = 'block';
      const rect = tabListBtn.getBoundingClientRect();
      let x = rect.left;
      let y = rect.bottom;
      
      tabListMenu.style.left = `${x}px`;
      tabListMenu.style.top = `${y}px`;
      
      requestAnimationFrame(() => {
          const menuRect = tabListMenu.getBoundingClientRect();
          if (menuRect.right > window.innerWidth) {
              tabListMenu.style.left = `${window.innerWidth - menuRect.width - 5}px`;
          }
      });
    });
  }

  if (minBtn) {
    minBtn.addEventListener('click', () => window.veloceAPI.minimizeViewer());
  }
  if (maxBtn) {
    maxBtn.addEventListener('click', () => window.veloceAPI.maximizeViewer());
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.veloceAPI.closeWindow());
  }

  const savedWinW = localStorage.getItem('mainWinWidth');
  const savedWinH = localStorage.getItem('mainWinHeight');
  const savedWinX = localStorage.getItem('mainWinX');
  const savedWinY = localStorage.getItem('mainWinY');
  const savedWinMax = localStorage.getItem('mainWinMaximized');

  if (savedWinW && savedWinH && window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
    window.veloceAPI.resizeViewerWindow(parseInt(savedWinW, 10), parseInt(savedWinH, 10));
  }
  if (savedWinX && savedWinY && window.veloceAPI && window.veloceAPI.moveViewerWindow) {
    window.veloceAPI.moveViewerWindow(parseInt(savedWinX, 10), parseInt(savedWinY, 10));
  }
  if (savedWinMax === 'true' && window.veloceAPI && window.veloceAPI.isViewerMaximized && window.veloceAPI.maximizeViewer) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      if (!isMax) window.veloceAPI.maximizeViewer();
    });
  }

  initializeThumbnailObserver();

  const savedLeftWidth = localStorage.getItem('leftWidth');
  if (savedLeftWidth) appState.layout.leftWidth = parseInt(savedLeftWidth, 10);
  
  const savedRightWidth = localStorage.getItem('rightWidth');
  if (savedRightWidth) appState.layout.rightWidth = parseInt(savedRightWidth, 10);

  const savedLeftVisible = localStorage.getItem('leftVisible');
  if (savedLeftVisible !== null) appState.layout.leftVisible = savedLeftVisible === 'true';

  const savedRightVisible = localStorage.getItem('rightVisible');
  if (savedRightVisible !== null) appState.layout.rightVisible = savedRightVisible === 'true';

  uiManager.applyLayout();
  updateTabLayout();

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
    if (savedTopHeight === '0px' && uiManager.elements.resizerCenter) {
      const btn = uiManager.elements.resizerCenter.querySelector('.resizer-toggle');
      if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
    }
  }

  const savedLeftTopHeight = localStorage.getItem('leftTopHeight');
  if (savedLeftTopHeight) {
    if (savedLeftTopHeight === '0px') {
      const btn = document.getElementById('resizer-left-pane')?.querySelector('.resizer-toggle');
      if (btn) btn.innerHTML = UIManager.ICONS.CHEVRON_DOWN;
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
      if (uiManager.elements.searchBar) {
        uiManager.elements.searchBar.value = '';
        appState.searchQuery = '';
        scheduleRefresh();
        uiManager.applyGlowEffect(uiManager.elements.searchClearBtn);
        uiManager.hideCustomTooltip();
      }
    });
  }

  if (uiManager.elements.openCacheBtn) {
    uiManager.elements.openCacheBtn.removeAttribute('title');
    let openCacheText = 'サムネイルフォルダを開きます';
    uiManager.elements.openCacheBtn.addEventListener('mouseenter', async (e) => {
      uiManager.showCustomTooltip(openCacheText, e.clientX, e.clientY);
      if (window.veloceAPI.getThumbnailCacheInfo) {
        const info = await window.veloceAPI.getThumbnailCacheInfo();
        openCacheText = `サムネイルフォルダを開きます\nパス: ${info.path}`;
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
      window.veloceAPI.openThumbnailCache();
      uiManager.hideCustomTooltip();
    });
  }

  if (uiManager.elements.clearCacheBtn) {
    uiManager.elements.clearCacheBtn.removeAttribute('title');
    let clearCacheText = 'サムネイル画像を削除します';
    uiManager.elements.clearCacheBtn.addEventListener('mouseenter', async (e) => {
      uiManager.showCustomTooltip(clearCacheText, e.clientX, e.clientY);
      if (window.veloceAPI.getThumbnailCacheInfo) {
        const info = await window.veloceAPI.getThumbnailCacheInfo();
        const sizeMB = (info.totalSizeBytes / (1024 * 1024)).toFixed(2);
        clearCacheText = `サムネイル画像を削除します\n保存数: ${info.fileCount}枚\n合計サイズ: ${sizeMB} MB`;
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
      const isConfirmed = await uiManager.showConfirm('すべてのサムネイルキャッシュを削除しますか？\nこの操作は元に戻せません。');
      if (isConfirmed) {
        uiManager.showToast('サムネイルキャッシュを削除しています...', 0, 'cache-clear', 'info');
        try {
          await window.veloceAPI.clearThumbnailCache();
          appState.thumbnailUrls.clear(); 
          resetThumbnailPreloader(); 
          await refreshFileList(); 
          uiManager.showToast('サムネイルキャッシュを削除しました。', 3000, 'cache-clear', 'success');
        } catch (err) {
          console.error("Failed to clear thumbnail cache:", err);
          uiManager.showToast('キャッシュの削除に失敗しました。', 3000, 'cache-clear', 'error');
        }
      }
    });
  }

  const favListElement = document.getElementById('favorites-list');
  if (favListElement) {
    // --- お気に入りのドラッグ＆ドロップ並び替え処理 ---
    favListElement.addEventListener('dragstart', (e) => {
      const itemDiv = e.target.closest('.favorite-item');
      if (!itemDiv) return;
      draggedFavoriteId = itemDiv.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      // ドラッグ中の元アイテムを半透明にする
      setTimeout(() => { itemDiv.style.opacity = '0.5'; }, 0);
    });

    favListElement.addEventListener('dragend', (e) => {
      const itemDiv = e.target.closest('.favorite-item');
      if (itemDiv) itemDiv.style.opacity = '1';
      draggedFavoriteId = null;
      // 全てのドロップインジケータ（線）をクリア
      favListElement.querySelectorAll('.favorite-item').forEach(item => {
        item.style.boxShadow = '';
      });
    });

    favListElement.addEventListener('dragover', (e) => {
      const isFolderDrop = Array.from(e.dataTransfer.types).includes('application/json-folder');
      if (!draggedFavoriteId && !isFolderDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isFolderDrop ? 'copy' : 'move';

      const itemDiv = e.target.closest('.favorite-item');
      if (!itemDiv || (draggedFavoriteId && itemDiv.dataset.id === draggedFavoriteId)) {
        favListElement.querySelectorAll('.favorite-item').forEach(item => item.style.boxShadow = '');
        return;
      }

      // マウス位置がターゲットの半分より上か下かで線の位置を変える
      const rect = itemDiv.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      favListElement.querySelectorAll('.favorite-item').forEach(item => {
        if (item !== itemDiv) item.style.boxShadow = '';
      });

      if (e.clientY < midY) {
        itemDiv.style.boxShadow = '0 -2px 0 var(--glow-gold)'; // 上に線
      } else {
        itemDiv.style.boxShadow = '0 2px 0 var(--glow-gold)';  // 下に線
      }
    });

    favListElement.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && favListElement.contains(e.relatedTarget)) return;
      favListElement.querySelectorAll('.favorite-item').forEach(item => {
        item.style.boxShadow = '';
      });
    });

    favListElement.addEventListener('drop', (e) => {
      const isFolderDrop = Array.from(e.dataTransfer.types).includes('application/json-folder');
      if (!draggedFavoriteId && !isFolderDrop) return;
      e.preventDefault();

      favListElement.querySelectorAll('.favorite-item').forEach(item => item.style.boxShadow = '');

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
            const itemDiv = e.target.closest('.favorite-item');
            if (itemDiv) {
              const targetId = itemDiv.dataset.id;
              const rect = itemDiv.getBoundingClientRect();
              const midY = rect.top + rect.height / 2;
              const insertAfter = e.clientY >= midY;
              const newIndex = appState.favorites.findIndex(f => f.id === targetId);
              if (newIndex > -1) {
                insertIndex = insertAfter ? newIndex + 1 : newIndex;
              }
            }

            const newFav = { id: Date.now().toString(), name: folder.name, path: folder.path, icon: 'FAV_STAR' };
            appState.favorites.splice(insertIndex, 0, newFav);
            localStorage.setItem('favorites', JSON.stringify(appState.favorites));
            renderFavorites();
            showNotification(`「${folder.name}」をお気に入りに追加しました`, 'success');
          } catch (err) {}
        }
        return;
      }

      const itemDiv = e.target.closest('.favorite-item');
      if (!itemDiv || itemDiv.dataset.id === draggedFavoriteId) return;

      const targetId = itemDiv.dataset.id;
      const rect = itemDiv.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertAfter = e.clientY >= midY;

      const fromIndex = appState.favorites.findIndex(f => f.id === draggedFavoriteId);
      const toIndex = appState.favorites.findIndex(f => f.id === targetId);

      if (fromIndex > -1 && toIndex > -1) {
        const [movedItem] = appState.favorites.splice(fromIndex, 1);
        let newIndex = appState.favorites.findIndex(f => f.id === targetId);
        if (insertAfter) newIndex += 1;
        
        // 並び替えた状態を保存して再描画
        appState.favorites.splice(newIndex, 0, movedItem);
        localStorage.setItem('favorites', JSON.stringify(appState.favorites));
        renderFavorites();
      }
    });

    favListElement.addEventListener('click', async (e) => {
      const itemDiv = e.target.closest('.tree-item');
      if (!itemDiv) return;
      
      const path = itemDiv.dataset.path;
      appState.selection.clear();
      appState.selectedIndex = -1;
      uiManager.updateSelectionUI();

      if (window.veloceAPI.loadDirectory) {
        const activeTab = appState.tabs[appState.activeTabIndex];
        if (activeTab) {
          const result = await window.veloceAPI.loadDirectory(path);
          if (result) {
            activeTab.path = result.path;
            activeTab.name = getTabNameForPath(result.path);
            activeTab.scrollTop = 0; // 別フォルダ移動時はスクロールリセット
            appState.currentDirectory = result.path;
            localStorage.setItem('currentDirectory', appState.currentDirectory);
            applyNewFileList(result.imageFiles, true);
            await expandTreeToPath(appState.currentDirectory);
            uiManager.renderTabs();
            saveTabsState();
          } else {
            uiManager.showToast('ディレクトリが存在しません', 3000, null, 'warning');
          }
        }
      }
    });

    favListElement.addEventListener('contextmenu', (e) => {
      const itemDiv = e.target.closest('.tree-item');
      if (!itemDiv) return;
      e.preventDefault();
      e.stopPropagation();

      contextMenu.targetFavoriteId = itemDiv.dataset.id;
      contextMenu.targetFavoritePath = itemDiv.dataset.path;
      contextMenu.targetFolder = null; 

      menuNewFolder.style.display = 'none';
      menuRenameFolder.style.display = 'none';
      menuDeleteFolder.style.display = 'none';
      menuRenameFile.style.display = 'none';
      menuDeleteFile.style.display = 'none';
      menuAddFavorite.style.display = 'none';
      
      menuEditFavorite.style.display = 'block';
      menuDeleteFavorite.style.display = 'block';
      menuSeparatorFav.style.display = 'block';
      menuOpenInExplorer.style.display = 'block';
      menuOpenInNewTab.style.display = 'block';

      menuTabClose.style.display = 'none';
      menuTabDuplicate.style.display = 'none';
      menuTabCloseOthers.style.display = 'none';
      menuTabCloseRight.style.display = 'none';
      menuSeparatorTab1.style.display = 'none';
      menuTabOpenExplorer.style.display = 'none';
      menuTabCopyPath.style.display = 'none';
      menuSeparatorTab2.style.display = 'none';
      menuTabAddFavorite.style.display = 'none';

      contextMenu.style.display = 'block';
      const rect = contextMenu.getBoundingClientRect();
      let x = e.clientX;
      let y = e.clientY;
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;

      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
    });
  }

  document.getElementById('fav-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('edit-favorite-modal').style.display = 'none';
  });

  document.getElementById('fav-save-btn')?.addEventListener('click', () => {
    if (contextMenu.editingFavoriteId) {
      const fav = appState.favorites.find(f => f.id === contextMenu.editingFavoriteId);
      if (fav) {
        fav.icon = selectedFavIcon;
        fav.name = document.getElementById('fav-name-input').value;
        fav.path = document.getElementById('fav-path-input').value;
        localStorage.setItem('favorites', JSON.stringify(appState.favorites));
        renderFavorites();

        // 変更されたお気に入りの名前をタブにも反映
        let tabUpdated = false;
        appState.tabs.forEach(t => {
          if (t.path === fav.path) {
            t.name = fav.name;
            tabUpdated = true;
          }
        });
        if (tabUpdated) { saveTabsState(); uiManager.renderTabs(); }
      }
    }
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

  // --- 初期タブの生成と読み込み ---
  const savedTabsState = localStorage.getItem('tabsState');
  if (savedTabsState) {
    try {
      const state = JSON.parse(savedTabsState);
      if (state.tabs && Array.isArray(state.tabs) && state.tabs.length > 0) {
        appState.tabs = state.tabs;
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
      scrollTop: 0
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
  if (currentTab.sortConfig) {
    appState.sortConfig = JSON.parse(JSON.stringify(currentTab.sortConfig));
    updateSortIndicators();
  }

  if (window.veloceAPI.loadDirectory) {
    const result = await window.veloceAPI.loadDirectory(currentTab.path);
    if (result && result.imageFiles) {
      appState.currentDirectory = result.path;
      currentTab.path = result.path; // 正確なパスに更新
      currentTab.name = getTabNameForPath(result.path);
      localStorage.setItem('currentDirectory', appState.currentDirectory); 
      applyNewFileList(result.imageFiles, false); // スクロールリセットしない
      
      setTimeout(() => {
        if (uiManager.elements.thumbnailGrid && currentTab.scrollTop !== undefined) {
          uiManager.elements.thumbnailGrid.scrollTop = currentTab.scrollTop;
        }
      }, 100);

      await expandTreeToPath(appState.currentDirectory);
      uiManager.renderTabs(); // パス解決後の名前で再描画
      saveTabsState();
    }
  }

  if (window.veloceAPI.onFileChanged) {
    window.veloceAPI.onFileChanged((newFile) => {
      const index = appState.files.findIndex(f => f.path === newFile.path);
      if (index > -1) {
        const oldFile = appState.files[index];
        if (oldFile.size !== newFile.size || oldFile.mtime !== newFile.mtime) {
          appState.thumbnailUrls.delete(newFile.path);
          
          // --- 追加: エラー状態やリクエスト待ち状態をリセット ---
          appState.pendingThumbnails.delete(newFile.path);
          const qIdx = appState.thumbnailRequestQueue.findIndex(req => req.filePath === newFile.path);
          if (qIdx > -1) appState.thumbnailRequestQueue.splice(qIdx, 1);

          // --- 修正: metaLoaded: false を追加してメタデータを確実に再取得させる ---
          appState.files[index] = { ...oldFile, size: newFile.size, mtime: newFile.mtime, width: 0, height: 0, metaLoaded: false };
          
          // --- 修正: 描画の遅延を待たずに、データ状態とRustのインデックスを即時同期 ---
          appState.applyFiltersAndSort(); 
          scheduleRefresh();
        }
      } else {
        appState.files.push(newFile);
        
        // --- 修正: 描画の遅延を待たずに、データ状態とRustのインデックスを即時同期 ---
        appState.applyFiltersAndSort();
        scheduleRefresh();
      }
    });
  }

  if (window.veloceAPI.onFileRemoved) {
    window.veloceAPI.onFileRemoved((path) => {
      const index = appState.files.findIndex(f => f.path === path);
      if (index > -1) {
        appState.files.splice(index, 1);
        
        // --- 修正: 描画の遅延を待たずに、データ状態とRustのインデックスを即時同期 ---
        appState.applyFiltersAndSort();
        scheduleRefresh();
      }
    });
  }

  if (window.veloceAPI.onDirectoryChanged) {
    const handleDirChange = debounce(async () => {
      await refreshTree();
      
      if (appState.currentDirectory) {
        // 現在のディレクトリが存在するか確認
        const result = await window.veloceAPI.loadDirectory(appState.currentDirectory);
        if (!result || !result.imageFiles) {
          // 削除・リネームされて存在しない場合は親フォルダへ自動遷移
          const separator = appState.currentDirectory.includes('\\') ? '\\' : '/';
          const parts = appState.currentDirectory.split(separator).filter(Boolean);
          parts.pop(); // 一つ上の階層へ
          let parentDir = parts.join(separator);
          if (parentDir.length === 2 && parentDir.endsWith(':')) parentDir += separator; // ドライブ直下へのフォールバック
          
          if (parentDir) {
            const parentResult = await window.veloceAPI.loadDirectory(parentDir);
            if (parentResult && parentResult.imageFiles) {
              appState.currentDirectory = parentResult.path;
              localStorage.setItem('currentDirectory', appState.currentDirectory);
              applyNewFileList(parentResult.imageFiles, true);
              // 親フォルダまでツリーを展開して選択状態にする
              await refreshTree();
              await expandTreeToPath(appState.currentDirectory);
            }
          }
        } else {
          // --- 修正: 結果をUIに反映し、Rust側のソート順を同期する処理を追加 ---
          applyNewFileList(result.imageFiles, false);
          
          // 現在のディレクトリが存在する場合は、その場所までツリーを再度展開して表示を更新する
          await expandTreeToPath(appState.currentDirectory);
        }
      }
    }, 500);

    window.veloceAPI.onDirectoryChanged(() => {
      handleDirChange();
    });
  }
});
