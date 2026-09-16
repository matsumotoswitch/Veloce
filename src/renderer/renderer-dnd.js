// ============================================================================
// Veloce - Drag and Drop Management Module (renderer-dnd.js)
// ============================================================================
// 本モジュールは、ファイル・サムネイルおよびディレクトリツリー、お気に入りバーの
// ドラッグ＆ドロップ（DnD）操作を一括管理する。
//
// 主な責務:
// 1. ドラッグツールチップ（件数、移動/コピー先フォルダ表示）の生成および追従制御
// 2. ドラッグイベント（DataTransfer）からのパス解決（内部選択、外部ドロップ、JSON等）
// 3. サムネイル・リストアイテムのドラッグ開始ハンドリング
// 4. フォルダツリーへのドラッグオーバー／ドロップによるファイル移動・コピー実行とアンドゥ連携
// 5. お気に入りバーへのフォルダドロップ（追加）およびドラッグ並び替え
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';

let dragTooltip = null;
let dragTooltipText = null;
let emptyDragImage = null;
let draggedFavoriteId = null;

/**
 * 透明なドラッグプレビュー画像とドラッグツールチップDOMを初期化する。
 */
export function initDragTooltip() {
  if (emptyDragImage) return;

  emptyDragImage = new Image();
  emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  dragTooltip = document.createElement('div');
  dragTooltip.id = 'drag-tooltip';
  dragTooltip.className = 'custom-tooltip';
  dragTooltip.style.pointerEvents = 'none'; // マウスイベントを吸収してドロップを妨害しない

  const dragTooltipInner = document.createElement('span');
  dragTooltipInner.className = 'drag-tooltip-inner';
  const dragTooltipIcon = document.createElement('span');
  dragTooltipIcon.className = 'drag-tooltip-icon';
  dragTooltipIcon.innerHTML = UIManager.ICONS.COPY;

  dragTooltipText = document.createElement('span');
  dragTooltipInner.appendChild(dragTooltipIcon);
  dragTooltipInner.appendChild(dragTooltipText);
  dragTooltip.appendChild(dragTooltipInner);
  document.body.appendChild(dragTooltip);
}

/**
 * ドラッグツールチップのテキストと座標を更新する。
 * Reflowを抑制するため、テキストが変化した場合のみ textContent への書き込みを行う。
 *
 * @param {string} text - 表示テキスト
 * @param {number} x - マウスX座標
 * @param {number} y - マウスY座標
 */
export function updateDragTooltip(text, x, y) {
  if (!dragTooltip) initDragTooltip();
  if (dragTooltipText.textContent !== text) {
    dragTooltipText.textContent = text;
  }
  dragTooltip.style.left = (x + 15) + 'px';
  dragTooltip.style.top = (y + 15) + 'px';
  if (!dragTooltip.classList.contains('show')) {
    dragTooltip.classList.add('show');
  }
}

/**
 * ドラッグツールチップを非表示にする。
 */
export function hideDragTooltip() {
  if (dragTooltip) {
    dragTooltip.classList.remove('show');
  }
}

/**
 * ドラッグイベントの DataTransfer からファイルパス一覧を非同期に解決・取得する。
 *
 * @param {DragEvent} e - ドラッグイベントオブジェクト
 * @returns {Promise<string[]>} 抽出されたパスの配列
 */
export async function getPathsFromDragEventAsync(e) {
  if (appState.dragState.paths && appState.dragState.paths.length > 0) {
    return [...appState.dragState.paths];
  }

  const indicesStr = e.dataTransfer.getData('application/json-indices');
  if (indicesStr) {
    try {
      const indices = JSON.parse(indicesStr);
      if (indices && indices.length > 0 && window.veloceAPI && window.veloceAPI.getFilesByIndices) {
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

/**
 * サムネイルまたはリスト行のドラッグ開始（dragstart）を処理する。
 *
 * @param {DragEvent} e - dragstartイベント
 * @param {boolean} isGrid - グリッド表示かリスト表示か
 * @param {Object} callbacks - コールバック群 ({ updateSelectionUI })
 */
export function handleItemDragStart(e, isGrid, callbacks = {}) {
  const { updateSelectionUI = null } = callbacks;
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) {
    appState.selection.clear();
    appState.selection.add(index);
    appState.selectedIndex = index;
    if (updateSelectionUI) {
      updateSelectionUI();
    } else if (uiManager && uiManager.updateSelectionUI) {
      uiManager.updateSelectionUI();
    }
  }

  const selectedIndices = Array.from(appState.selection);
  e.dataTransfer.setData('application/json-indices', JSON.stringify(selectedIndices));
  if (item.dataset.filepath) {
    e.dataTransfer.setData('text/plain', item.dataset.filepath);
  }
  e.dataTransfer.effectAllowed = 'copyMove';

  if (!emptyDragImage) initDragTooltip();
  e.dataTransfer.setDragImage(emptyDragImage, 0, 0);

  const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
  appState.dragState.paths = [];
  appState.dragState.indices = selectedIndices;
  appState.dragState.isAppDragging = true;
  appState.dragState.cachedRoot = getRoot(item.dataset.filepath || '');

  const count = selectedIndices.length;
  const text = count > 1 ? `${count} 個のアイテム` : '1 個のアイテム';
  updateDragTooltip(text, e.clientX, e.clientY);
}

/**
 * ウィンドウ全体のドラッグオーバーおよびドラッグ終了（dragend）イベントを初期化する。
 *
 * @param {Object} callbacks - コールバック群 ({ refreshFileList })
 */
export function initGlobalDndHandlers(callbacks = {}) {
  const { refreshFileList = null } = callbacks;

  document.addEventListener('dragover', (e) => {
    if (appState.dragState && appState.dragState.isAppDragging) {
      const count = (appState.dragState.indices && appState.dragState.indices.length > 0)
        ? appState.dragState.indices.length
        : (appState.dragState.paths ? appState.dragState.paths.length : 0);
      let text = count > 1 ? `${count} 個のアイテム` : '1 個のアイテム';

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

      updateDragTooltip(text, e.clientX, e.clientY);
    }
  });

  document.addEventListener('dragend', async () => {
    hideDragTooltip();
    appState.dragState.paths = [];
    appState.dragState.indices = [];
    appState.dragState.cachedRoot = null;
    appState.dragState.isAppDragging = false;

    if (appState.dragState.pendingRefresh) {
      appState.dragState.pendingRefresh = false;
      if (refreshFileList) {
        await refreshFileList();
      }
    }
  });
}

/**
 * フォルダツリー要素へのドラッグ＆ドロップイベントリスナーを登録する。
 *
 * @param {HTMLElement} dirTreeElement - ディレクトリツリーコンテナ
 * @param {Object} callbacks - コールバック群 ({ refreshFileList, showNotification })
 */
export function initDirTreeDnd(dirTreeElement, callbacks = {}) {
  if (!dirTreeElement) return;
  const { refreshFileList = null, showNotification = null } = callbacks;

  dirTreeElement.addEventListener('dragstart', (e) => {
    const itemDiv = e.target.closest('.tree-item');
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

  dirTreeElement.addEventListener('dragenter', (e) => {
    if (draggedFavoriteId) return;
    const itemDiv = e.target.closest('.tree-item');
    if (!itemDiv) return;
    e.preventDefault();
    itemDiv.classList.add('drop-target');
  });

  dirTreeElement.addEventListener('dragover', (e) => {
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

  dirTreeElement.addEventListener('dragleave', (e) => {
    if (draggedFavoriteId) return;
    const itemDiv = e.target.closest('.tree-item');
    if (!itemDiv) return;
    if (!itemDiv.contains(e.relatedTarget)) {
      itemDiv.classList.remove('drop-target');
    }
  });

  dirTreeElement.addEventListener('drop', async (e) => {
    if (draggedFavoriteId) return;
    const itemDiv = e.target.closest('.tree-item');
    if (!itemDiv) return;
    e.preventDefault();
    itemDiv.classList.remove('drop-target');
    hideDragTooltip();

    const paths = await getPathsFromDragEventAsync(e);
    if (paths.length > 0 && window.veloceAPI && window.veloceAPI.moveOrCopyFile) {
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

        if (window.veloceAPI.checkConflicts && uiManager.showConflictDialog) {
          try {
            const conflicts = await window.veloceAPI.checkConflicts(paths, itemDiv.dataset.path);
            if (conflicts && conflicts.length > 0) {
              const choice = await uiManager.showConflictDialog(conflicts.length, actionStr);
              if (choice === 'cancel') {
                if (uiManager.showToast) uiManager.showToast('操作をキャンセルしました', 3000, 'file-move');
                return;
              } else if (choice === 'skip') {
                targetPaths = paths.filter(p => !conflicts.includes(p));
                skipCount = conflicts.length;
                if (targetPaths.length === 0) {
                  if (uiManager.showToast) uiManager.showToast(`${skipCount}件の重複をスキップしました`, 3000, 'file-move');
                  return;
                }
              }
            }
          } catch (err) {
            console.error('Failed to check conflicts:', err);
          }
        }

        if (uiManager.showToast) {
          uiManager.showToast(`${targetPaths.length}件のファイルを${actionStr}中`, 0, 'file-move', 'info');
        }

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
          if (uiManager.showToast) uiManager.showToast(msg, 3000, 'file-move');
          if (appState.dragState.isAppDragging) {
            appState.dragState.pendingRefresh = true;
          } else if (refreshFileList) {
            await refreshFileList();
          }
        } else {
          if (uiManager.showToast) uiManager.showToast(`ファイルの${actionStr}に失敗しました`, 3000, 'file-move');
        }
      }, 10);
    }
  });
}

/**
 * お気に入りバー要素へのドラッグ＆ドロップイベントリスナーを登録する。
 *
 * @param {HTMLElement} favListElement - お気に入り一覧コンテナ
 * @param {Object} callbacks - コールバック群 ({ renderFavorites, showNotification })
 */
export function initFavoritesDnd(favListElement, callbacks = {}) {
  if (!favListElement) return;
  const { renderFavorites = null, showNotification = null } = callbacks;

  favListElement.addEventListener('dragstart', (e) => {
    const itemDiv = e.target.closest('.bookmark-item');
    if (!itemDiv) {
      e.preventDefault();
      return;
    }
    draggedFavoriteId = itemDiv.dataset.id;
    e.dataTransfer.effectAllowed = 'move';

    const dragGhost = itemDiv.cloneNode(true);
    dragGhost.className = `${itemDiv.className} bookmark-drag-ghost`;
    document.body.appendChild(dragGhost);

    e.dataTransfer.setDragImage(dragGhost, 15, 15);

    setTimeout(() => {
      if (dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
    }, 0);

    setTimeout(() => { itemDiv.classList.add('is-dragging'); }, 0);
  });

  favListElement.addEventListener('dragend', (e) => {
    const itemDiv = e.target.closest('.bookmark-item');
    if (itemDiv) itemDiv.classList.remove('is-dragging');
    draggedFavoriteId = null;
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
      const items = favListElement.querySelectorAll('.bookmark-item');
      if (items.length > 0) {
        const lastItem = items[items.length - 1];
        if (lastItem.dataset.id !== draggedFavoriteId) {
          lastItem.classList.add('drop-target-right');
        }
      }
      return;
    }

    const rect = itemDiv.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;

    if (e.clientX < midX) {
      itemDiv.classList.add('drop-target-left');
    } else {
      itemDiv.classList.add('drop-target-right');
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
            if (showNotification) {
              showNotification(`「${folder.name}」はすでにお気に入りにあります`, 'warning');
            }
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
          if (renderFavorites) renderFavorites();
          if (showNotification) {
            showNotification(`「${folder.name}」をお気に入りに追加しました`, 'success');
          }
        } catch (err) { }
      }
      return;
    }

    const itemDiv = e.target.closest('.bookmark-item');
    if (itemDiv && itemDiv.dataset.id === draggedFavoriteId) return;

    const fromIndex = appState.favorites.findIndex(f => f.id === draggedFavoriteId);
    if (fromIndex > -1) {
      const [movedItem] = appState.favorites.splice(fromIndex, 1);
      let newIndex = appState.favorites.length;

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

      appState.favorites.splice(newIndex, 0, movedItem);
      localStorage.setItem('favorites', JSON.stringify(appState.favorites));
      if (renderFavorites) renderFavorites();
    }
  });
}
