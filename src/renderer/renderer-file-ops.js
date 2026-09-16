// ============================================================================
// Veloce - File Operations & Undo Controller (renderer-file-ops.js)
// ============================================================================
// 本モジュールは、ファイルおよびフォルダのリネーム、ゴミ箱への移動（削除）、
// サムネイルキャッシュの再構築、および元に戻す（Undo）操作の実行を管理する。
// ============================================================================

import { appState } from './renderer-state.js';
import { uiManager } from './renderer-ui.js';
import { validateFilename } from '../common/path-utils.js';
import { resetThumbnailPreloader } from './renderer-thumbnails.js';

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
      appState.undoStack.push({ type: 'RENAME_FOLDER', oldPath, newPath: result.path });
      callbacks.showNotification?.(`フォルダ名を「${newName}」に変更しました`, 'success');
      if (appState.currentDirectory.startsWith(oldPath)) {
        appState.currentDirectory = appState.currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', appState.currentDirectory);
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
      if (appState.currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        appState.currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', appState.currentDirectory);
        if (callbacks.refreshFileList) await callbacks.refreshFileList();
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
      if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
    } else {
      uiManager.showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

/**
 * 履歴（Undoスタック）から直前の操作を取り消します。
 * @param {Object} [callbacks=fileOpsCallbacks]
 */
export async function performUndo(callbacks = fileOpsCallbacks) {
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
        uiManager.showToast('フォルダ名の変更を元に戻しました', 3000, 'undo', 'success');
        if (appState.currentDirectory.startsWith(action.newPath)) {
          appState.currentDirectory = appState.currentDirectory.replace(action.newPath, action.oldPath);
          localStorage.setItem('currentDirectory', appState.currentDirectory);
        }
        if (callbacks.refreshTree) await callbacks.refreshTree();
      }
    } else if (action.type === 'RENAME_FILE') {
      const oldName = await path.basename(action.oldPath);
      const result = await window.veloceAPI.renameFile(action.newPath, oldName);
      if (result.success) {
        uiManager.showToast('ファイル名の変更を元に戻しました', 3000, 'undo', 'success');
        const oldUrl = appState.thumbnailUrls.get(action.newPath);
        if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        appState.thumbnailUrls.delete(action.newPath);
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      }
    } else if (action.type === 'MOVE_FILE') {
      const originalDir = await path.dirname(action.sourcePath);
      const result = await window.veloceAPI.moveOrCopyFile(action.targetPath, originalDir, 'move');
      if (result.success) {
        uiManager.showToast('ファイルの移動を元に戻しました', 3000, 'undo', 'success');
        if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
      }
    } else if (action.type === 'COPY_FILE') {
      await fs.removeFile(action.targetPath);
      if (window.veloceAPI.notifyFileRemoved) {
        await window.veloceAPI.notifyFileRemoved(action.targetPath);
      }
      uiManager.showToast('ファイルのコピーを元に戻しました', 3000, 'undo', 'success');
      if (callbacks.scheduleRefresh) callbacks.scheduleRefresh();
    }
  } catch (err) {
    console.error('Undo failed:', err);
    uiManager.showToast('元に戻す操作に失敗しました', 3000, 'undo', 'warning');
  }
}
