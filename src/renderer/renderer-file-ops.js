// ============================================================================
// Veloce - File Operations & Undo Controller (renderer-file-ops.js)
// ============================================================================
// 本モジュールは、ファイルおよびフォルダのリネーム、ゴミ箱への移動（削除）、
// サムネイルキャッシュの再構築、および元に戻す（Undo）操作の実行を管理する。
// ============================================================================

import { appState, fileOpsState } from './renderer-state.js';
import { uiManager } from './renderer-ui.js';
import { validateFilename, getParentDirectory, isSameOrSubdirectory, replaceDirectoryPrefix } from '../common/path-utils.js';
import { resetThumbnailPreloader } from './renderer-thumbnails.js';
import { setSetting } from '../common/settings-store.js';
import { saveTabsState, getTabNameForPath } from './renderer-tabs.js';
import { renderFavorites } from './renderer-bookmarks.js';

export { fileOpsState };

/**
 * Undoスタックに操作履歴を追加します。
 * @param {Object} action
 */
export function pushUndoAction(action) {
  fileOpsState.push(action);
}

/**
 * Undoスタックから直前の操作履歴を取得・削除します。
 * @returns {Object|undefined}
 */
export function popUndoAction() {
  return fileOpsState.pop();
}

/**
 * Undoスタックをクリアします。
 */
export function clearUndoStack() {
  fileOpsState.clear();
}

let fileOpsCallbacks = {
  refreshFileList: () => {},
  refreshTree: () => {},
  scheduleRefresh: () => {},
  clearMetadataUI: () => {},
  showNotification: (msg, type) => uiManager.showToast(msg, type === 'info' ? 1500 : 3000, null, type)
};

/**
 * ファイル操作で使用するライフサイクルコールバックを設定します。
 * @param {Object} callbacks
 */
export function initFileOps(callbacks = {}) {
  fileOpsCallbacks = { ...fileOpsCallbacks, ...callbacks };
}

/**
 * 単一ファイルのリネーム（またはUndo）時にフロントエンドの appState.ratings のキーを新パスへ移行する。
 * @param {string} oldPath
 * @param {string} newPath
 */
export function syncFileRatingOnRename(oldPath, newPath) {
  if (!oldPath || !newPath || !appState || !appState.ratings) return;
  const candidates = [oldPath, oldPath.replace(/\//g, '\\'), oldPath.replace(/\\/g, '/')];
  let ratingVal;
  for (const key of candidates) {
    if (appState.ratings[key] !== undefined) {
      ratingVal = appState.ratings[key];
      delete appState.ratings[key];
    }
  }
  if (ratingVal !== undefined) {
    appState.ratings[newPath] = ratingVal;
  }
}

/**
 * フォルダのリネーム（またはUndo）時にフロントエンドの appState.ratings 内の配下パスを一括置換する。
 * @param {string} oldFolderPath
 * @param {string} newFolderPath
 */
export function syncFolderRatingsOnRename(oldFolderPath, newFolderPath) {
  if (!oldFolderPath || !newFolderPath || !appState || !appState.ratings) return;
  const keys = Object.keys(appState.ratings);
  const updates = [];
  for (const key of keys) {
    if (isSameOrSubdirectory(key, oldFolderPath)) {
      const newKey = replaceDirectoryPrefix(key, oldFolderPath, newFolderPath);
      if (newKey !== key) {
        updates.push([key, newKey, appState.ratings[key]]);
      }
    }
  }
  for (const [oldKey, newKey, val] of updates) {
    delete appState.ratings[oldKey];
    appState.ratings[newKey] = val;
  }
}

/**
 * フォルダのリネーム（通常操作およびUndo）時に、appState.currentDirectory、
 * 全タブ（path, name, history[] の各要素）、およびお気に入り（favorites）の配下パスを
 * 境界意識置換（isSameOrSubdirectory + replaceDirectoryPrefix）で一括追随させ、
 * 設定永続化とタブ・お気に入りUIの再描画まで同期する。
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {{ currentDirChanged: boolean, tabsChanged: boolean, favoritesChanged: boolean }}
 */
export function syncFolderRenameInRendererState(oldPath, newPath) {
  const result = {
    currentDirChanged: false,
    tabsChanged: false,
    favoritesChanged: false
  };
  if (!oldPath || !newPath || !appState) return result;

  const oldBaseName = oldPath.split(/[/\\]/).filter(Boolean).pop() || '';
  const newBaseName = newPath.split(/[/\\]/).filter(Boolean).pop() || '';

  // 1. favorites の配下パス追随
  if (Array.isArray(appState.favorites)) {
    for (const fav of appState.favorites) {
      if (fav && fav.path && isSameOrSubdirectory(fav.path, oldPath)) {
        const nextFavPath = replaceDirectoryPrefix(fav.path, oldPath, newPath);
        if (nextFavPath !== fav.path) {
          const wasExactFolder = isSameOrSubdirectory(oldPath, fav.path);
          fav.path = nextFavPath;
          if (wasExactFolder && fav.name === oldBaseName && newBaseName) {
            fav.name = newBaseName;
          }
          result.favoritesChanged = true;
        }
      }
    }
    if (result.favoritesChanged) {
      setSetting('favorites', JSON.stringify(appState.favorites));
      if (typeof renderFavorites === 'function') {
        renderFavorites();
      }
    }
  }

  // 2. 全タブ（アクティブ・非アクティブ）の path / name / history 追随
  if (Array.isArray(appState.tabs)) {
    const favs = Array.isArray(appState.favorites) ? appState.favorites : [];
    for (const tab of appState.tabs) {
      if (!tab) continue;
      if (tab.path && isSameOrSubdirectory(tab.path, oldPath)) {
        tab.path = replaceDirectoryPrefix(tab.path, oldPath, newPath);
        tab.name = getTabNameForPath(tab.path, favs);
        result.tabsChanged = true;
      } else if (result.favoritesChanged && tab.path) {
        const updatedName = getTabNameForPath(tab.path, favs);
        if (updatedName && updatedName !== tab.name) {
          tab.name = updatedName;
          result.tabsChanged = true;
        }
      }
      if (Array.isArray(tab.history)) {
        for (let i = 0; i < tab.history.length; i++) {
          if (tab.history[i] && isSameOrSubdirectory(tab.history[i], oldPath)) {
            tab.history[i] = replaceDirectoryPrefix(tab.history[i], oldPath, newPath);
            result.tabsChanged = true;
          }
        }
      }
    }
  }

  // 3. currentDirectory の追随
  if (appState.currentDirectory && isSameOrSubdirectory(appState.currentDirectory, oldPath)) {
    appState.currentDirectory = replaceDirectoryPrefix(appState.currentDirectory, oldPath, newPath);
    setSetting('currentDirectory', appState.currentDirectory);
    result.currentDirChanged = true;
  }

  // 4. タブ描画と状態の保存
  if (result.tabsChanged || result.currentDirChanged || result.favoritesChanged) {
    if (uiManager && typeof uiManager.renderTabs === 'function') {
      uiManager.renderTabs();
    }
    if (Array.isArray(appState.tabs)) {
      saveTabsState(appState, uiManager);
    }
  }

  return result;
}

/**
 * フォルダ削除時に getParentDirectory(deletedFolderPath) を用いて親フォルダを算出し、
 * 削除フォルダ自身またはその配下を指している currentDirectory および各タブを親フォルダへ遷移させる。
 * @param {string} deletedFolderPath
 * @returns {{ parentDir: string|null, currentDirChanged: boolean, tabsChanged: boolean }}
 */
export function syncFolderDeleteInRendererState(deletedFolderPath) {
  const parentDir = getParentDirectory(deletedFolderPath);
  const result = {
    parentDir,
    currentDirChanged: false,
    tabsChanged: false
  };
  if (!deletedFolderPath || !parentDir || !appState) return result;

  if (Array.isArray(appState.tabs)) {
    const favs = Array.isArray(appState.favorites) ? appState.favorites : [];
    for (const tab of appState.tabs) {
      if (!tab) continue;
      if (tab.path && isSameOrSubdirectory(tab.path, deletedFolderPath)) {
        tab.path = parentDir;
        tab.name = getTabNameForPath(parentDir, favs);
        result.tabsChanged = true;
      }
      if (Array.isArray(tab.history)) {
        for (let i = 0; i < tab.history.length; i++) {
          if (tab.history[i] && isSameOrSubdirectory(tab.history[i], deletedFolderPath)) {
            tab.history[i] = parentDir;
            result.tabsChanged = true;
          }
        }
      }
    }
  }

  if (appState.currentDirectory && isSameOrSubdirectory(appState.currentDirectory, deletedFolderPath)) {
    appState.currentDirectory = parentDir;
    setSetting('currentDirectory', appState.currentDirectory);
    result.currentDirChanged = true;
  }

  if (result.tabsChanged || result.currentDirChanged) {
    if (uiManager && typeof uiManager.renderTabs === 'function') {
      uiManager.renderTabs();
    }
    if (Array.isArray(appState.tabs)) {
      saveTabsState(appState, uiManager);
    }
  }

  return result;
}

/**
 * 選択中のフォルダの名前を変更します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function renameSelectedFolder(callbacks = fileOpsCallbacks) {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement?.parentElement?.classList.contains('tree-root');
  if (isRoot) {
    callbacks.showNotification?.('ドライブ名を変更することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const oldName = selectedFolderEl.querySelector('.tree-label')?.textContent;

  const newName = await uiManager.showPrompt('新しいフォルダ名を入力してください:', oldName);
  if (newName !== null && newName !== oldName) {
    const valResult = validateFilename(newName, 'フォルダ名');
    if (!valResult.valid) {
      callbacks.showNotification?.(valResult.message, 'warning');
      return;
    }

    const result = await window.veloceAPI.renameFolder(oldPath, newName);
    if (result && result.success) {
      fileOpsState.push({ type: 'RENAME_FOLDER', oldPath, newPath: result.path });
      syncFolderRatingsOnRename(oldPath, result.path);
      callbacks.showNotification?.(`フォルダ名を「${newName}」に変更しました`, 'success');
      const { currentDirChanged } = syncFolderRenameInRendererState(oldPath, result.path);
      if (currentDirChanged && callbacks.refreshFileList) {
        await callbacks.refreshFileList();
      }
      if (callbacks.refreshTree) await callbacks.refreshTree();
    } else {
      callbacks.showNotification?.(`フォルダ名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

/**
 * 選択中のフォルダをゴミ箱に移動します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function deleteSelectedFolder(callbacks = fileOpsCallbacks) {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement?.parentElement?.classList.contains('tree-root');
  if (isRoot) {
    callbacks.showNotification?.('ドライブを削除することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const folderName = selectedFolderEl.querySelector('.tree-label')?.textContent;

  const isConfirmed = await uiManager.showConfirm(`本当にフォルダ「${folderName}」をゴミ箱に移動しますか？`);
  if (isConfirmed) {
    const result = await window.veloceAPI.trashFolder(oldPath);
    if (result && result.success) {
      callbacks.showNotification?.(`フォルダ「${folderName}」をゴミ箱に移動しました`, 'warning');
      const { currentDirChanged } = syncFolderDeleteInRendererState(oldPath);
      if (currentDirChanged && callbacks.refreshFileList) {
        await callbacks.refreshFileList();
      }
      if (callbacks.refreshTree) await callbacks.refreshTree();
    } else {
      callbacks.showNotification?.(`フォルダの削除に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

/**
 * 選択中のファイルの名前を変更します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function renameSelectedFile(callbacks = fileOpsCallbacks) {
  if (appState.selectedIndex > -1) {
    const file = await window.veloceAPI.getFileByIndex(appState.selectedIndex);
    if (!file) return;
    const oldPath = file.path;
    const newName = await uiManager.showPrompt('新しいファイル名を入力してください:', file.name, true);
    if (newName !== null && newName !== file.name) {
      const valResult = validateFilename(newName, 'ファイル名');
      if (!valResult.valid) {
        uiManager.showToast(valResult.message, 3000, 'file-rename', 'warning');
        return;
      }

      const result = await window.veloceAPI.renameFile(oldPath, newName);
      if (result && result.success) {
        fileOpsState.push({ type: 'RENAME_FILE', oldPath, newPath: result.path, oldName: file.name });
        syncFileRatingOnRename(oldPath, result.path);
        uiManager.showToast(`ファイル名を「${newName}」に変更しました`, 3000, 'file-rename', 'success');

        const newExt = newName.includes('.') ? ('.' + newName.split('.').pop().toLowerCase()) : '';

        file.path = result.path;
        file.name = newName;
        file.ext = newExt;
        file.hashKey = '';

        // Rust側に変更を通知
        await window.veloceAPI.notifyFileChanged(file);

        const pathsToClean = [oldPath, result.path].filter(Boolean);
        for (const p of pathsToClean) {
          const oldUrl = appState.thumbnailUrls.get(p);
          if (oldUrl && oldUrl.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(oldUrl);
          appState.thumbnailUrls.delete(p);
        }
        resetThumbnailPreloader();
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      } else {
        uiManager.showToast(`ファイル名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 3000, 'file-rename', 'warning');
      }
    }
  }
}

/**
 * 選択中の項目のサムネイルおよびメタデータキャッシュを再構築します。
 */
export async function rebuildSelectedCache() {
  try {
    if (appState.selection.size === 0) return;

    const pathsToRebuild = [];
    if (window.veloceAPI.getFilesByIndices) {
      const indices = Array.from(appState.selection);
      const files = await window.veloceAPI.getFilesByIndices(indices);
      for (const file of files) {
        pathsToRebuild.push(file.path);
        file.hasThumbnailCache = false;
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
          file.hasThumbnailCache = false;
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

      const tm = window.thumbnailManager;
      const uiMgr = window.uiManager || uiManager;
      const PLACEHOLDER_GIF_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

      if (!appState.rebuiltPaths) appState.rebuiltPaths = new Set();
      pathsToRebuild.forEach(p => {
        appState.thumbnailCounted.delete(p);
        appState.rebuiltPaths.add(p);
        if (tm && typeof tm.remove === 'function') {
          tm.remove(p);
        }
        if (uiMgr && uiMgr._domByPath) {
          const wrapper = uiMgr._domByPath.get(p);
          if (wrapper) {
            wrapper.classList.add('loading');
            const img = wrapper.children ? wrapper.children[0] : null;
            if (img) {
              img.dataset.currentSrc = '';
              img.classList.add('loading');
              img.src = PLACEHOLDER_GIF_URL;
            }
          }
        }
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

/**
 * 選択中のファイルをゴミ箱に移動します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function deleteSelectedFiles(callbacks = fileOpsCallbacks) {
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
    if (callbacks.clearMetadataUI) callbacks.clearMetadataUI();

    const total = pathsToDelete.length;
    uiManager.showToast(`${total}件のアイテムをゴミ箱に移動中...`, 0, 'file-trash', 'warning');

    let succeededPaths = [];
    try {
      if (typeof window.veloceAPI.trashFilesBatch === 'function') {
        succeededPaths = await window.veloceAPI.trashFilesBatch(pathsToDelete);
      } else {
        // フォールバック（未対応環境/レガシーモック用）
        for (const path of pathsToDelete) {
          try {
            const success = await window.veloceAPI.trashFile(path);
            if (success) succeededPaths.push(path);
          } catch (err) {
            console.error('Failed to trash file:', err);
          }
        }
      }
    } catch (err) {
      console.error('Failed to trash files batch:', err);
    }

    const trashedCount = Array.isArray(succeededPaths) ? succeededPaths.length : 0;

    if (trashedCount > 0) {
      try {
        if (typeof window.veloceAPI.notifyFilesBatch === 'function') {
          await window.veloceAPI.notifyFilesBatch([], succeededPaths);
        } else {
          for (const path of succeededPaths) {
            await window.veloceAPI.notifyFileRemoved(path);
          }
        }
      } catch (notifyErr) {
        console.error('Failed to notify files batch removal:', notifyErr);
      }
      uiManager.showToast(`${trashedCount}件のアイテムをゴミ箱に移動しました`, 3000, 'file-trash', 'warning');
      if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
    } else {
      uiManager.showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

/**
 * 履歴（Undoスタック）から直前の操作を取り消します。
 * 操作失敗時に履歴が失われないよう、スタック末尾を peek して実行し、成功時のみ pop します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function performUndo(callbacks = fileOpsCallbacks) {
  if (fileOpsState.undoStack.length === 0) {
    uiManager.showToast('元に戻す操作はありません', 2000, 'undo', 'info');
    return;
  }

  const action = fileOpsState.undoStack[fileOpsState.undoStack.length - 1];
  let undoSucceeded = false;
  try {
    const { fs, path } = window.__TAURI__;

    if (action.type === 'RENAME_FOLDER') {
      const oldName = await path.basename(action.oldPath);
      const result = await window.veloceAPI.renameFolder(action.newPath, oldName);
      if (result && result.success) {
        undoSucceeded = true;
        const restoredFolderPath = result.path || action.oldPath;
        syncFolderRatingsOnRename(action.newPath, restoredFolderPath);
        uiManager.showToast('フォルダ名の変更を元に戻しました', 3000, 'undo', 'success');
        const { currentDirChanged } = syncFolderRenameInRendererState(action.newPath, restoredFolderPath);
        if (currentDirChanged && callbacks.refreshFileList) {
          await callbacks.refreshFileList();
        }
        if (callbacks.refreshTree) await callbacks.refreshTree();
      } else {
        uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
      }
    } else if (action.type === 'RENAME_FILE') {
      const oldName = action.oldName || (path ? await path.basename(action.oldPath) : action.oldPath.split(/[/\\]/).pop());
      const result = await window.veloceAPI.renameFile(action.newPath, oldName);
      if (result && result.success) {
        undoSucceeded = true;
        syncFileRatingOnRename(action.newPath, result.path || action.oldPath);
        uiManager.showToast('ファイル名の変更を元に戻しました', 3000, 'undo', 'success');
        const pathsToClean = [action.newPath, action.oldPath, result.path].filter(Boolean);
        for (const p of pathsToClean) {
          const oldUrl = appState.thumbnailUrls.get(p);
          if (oldUrl && oldUrl.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(oldUrl);
          appState.thumbnailUrls.delete(p);
        }
        resetThumbnailPreloader();
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      } else {
        uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
      }
    } else if (action.type === 'MOVE_FILE') {
      const originalDir = await path.dirname(action.sourcePath);
      if (window.veloceAPI.checkConflicts) {
        const conflicts = await window.veloceAPI.checkConflicts([action.targetPath], originalDir);
        if (Array.isArray(conflicts) && conflicts.length > 0) {
          uiManager.showToast('移動元に同名ファイルが存在するため元に戻せません', 3000, 'undo', 'warning');
          return;
        }
      }
      const result = await window.veloceAPI.moveOrCopyFile(action.targetPath, originalDir, 'move');
      if (result && result.success) {
        undoSucceeded = true;
        if (appState && appState.ratings && appState.ratings[action.targetPath] !== undefined) {
          const restoredPath = result.targetPath || action.sourcePath;
          appState.ratings[restoredPath] = appState.ratings[action.targetPath];
          delete appState.ratings[action.targetPath];
        }
        uiManager.showToast('ファイルの移動を元に戻しました', 3000, 'undo', 'success');
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      } else {
        uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
      }
    } else if (action.type === 'COPY_FILE') {
      let trashed = false;
      if (window.veloceAPI && typeof window.veloceAPI.trashFile === 'function') {
        trashed = await window.veloceAPI.trashFile(action.targetPath);
      } else {
        await fs.removeFile(action.targetPath);
        trashed = true;
      }
      if (trashed) {
        undoSucceeded = true;
        if (window.veloceAPI.notifyFileRemoved) {
          await window.veloceAPI.notifyFileRemoved(action.targetPath);
        }
        uiManager.showToast('ファイルのコピーを元に戻しました', 3000, 'undo', 'success');
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      } else {
        uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
      }
    }

    if (undoSucceeded) {
      fileOpsState.pop();
    }
  } catch (err) {
    console.error('Undo failed:', err);
    uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
  }
}
