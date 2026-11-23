import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  initFileOps,
  renameSelectedFolder,
  deleteSelectedFolder,
  renameSelectedFile,
  rebuildSelectedCache,
  deleteSelectedFiles,
  performUndo,
  syncFolderRenameInRendererState,
  syncFolderDeleteInRendererState
} from '../src/renderer/renderer-file-ops.js';

describe('Renderer File Operations (renderer-file-ops.js)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.undoStack = [];
    appState.selection = new Set();
    appState.selectedIndex = -1;
    appState.currentDirectory = 'C:\\test\\dir';
    appState.thumbnailUrls = new Map();

    window.veloceAPI = {
      renameFolder: vi.fn().mockResolvedValue({ success: true, path: 'C:\\test\\dir_new' }),
      trashFolder: vi.fn().mockResolvedValue({ success: true }),
      renameFile: vi.fn().mockResolvedValue({ success: true, path: 'C:\\test\\dir\\new.png' }),
      trashFile: vi.fn().mockResolvedValue(true),
      trashFilesBatch: vi.fn().mockImplementation(async (paths) => [...paths]),
      getFileByIndex: vi.fn().mockImplementation(async (idx) => ({
        path: `C:\\test\\dir\\file${idx}.png`,
        name: `file${idx}.png`
      })),
      getFilesByIndices: vi.fn().mockImplementation(async (indices) =>
        indices.map(i => ({ path: `C:\\test\\dir\\file${i}.png`, name: `file${i}.png` }))
      ),
      notifyFileChanged: vi.fn().mockResolvedValue(undefined),
      notifyFileRemoved: vi.fn().mockResolvedValue(undefined),
      notifyFilesBatch: vi.fn().mockResolvedValue(undefined),
      clearMetadataCache: vi.fn().mockResolvedValue(undefined),
      moveOrCopyFile: vi.fn().mockResolvedValue({ success: true }),
      getFileIndexByPath: vi.fn().mockResolvedValue(0)
    };

    window.__TAURI__ = {
      path: {
        basename: vi.fn(async (p) => p.split('\\').pop()),
        dirname: vi.fn(async (p) => p.substring(0, p.lastIndexOf('\\')))
      },
      fs: {
        removeFile: vi.fn().mockResolvedValue(undefined)
      }
    };

    uiManager.showToast = vi.fn();
    uiManager.showPrompt = vi.fn();
    uiManager.showConfirm = vi.fn();
    uiManager.updateSelectionUI = vi.fn();

    document.body.innerHTML = `
      <div id="dir-tree">
        <ul>
          <li>
            <div class="tree-item selected" data-path="C:\\test\\sub">
              <span class="tree-label">sub</span>
            </div>
          </li>
        </ul>
      </div>
    `;
  });

  describe('renameSelectedFolder', () => {
    it('should validate empty or invalid folder names and show notification', async () => {
      const showNotification = vi.fn();
      uiManager.showPrompt.mockResolvedValueOnce('   ');

      await renameSelectedFolder({ showNotification });
      expect(showNotification).toHaveBeenCalledWith('フォルダ名を入力してください。', 'warning');
      expect(window.veloceAPI.renameFolder).not.toHaveBeenCalled();

      uiManager.showPrompt.mockResolvedValueOnce('invalid/name');
      await renameSelectedFolder({ showNotification });
      expect(showNotification).toHaveBeenCalledWith(
        expect.stringContaining('フォルダ名に以下の文字は使用できません'),
        'warning'
      );
      expect(window.veloceAPI.renameFolder).not.toHaveBeenCalled();
    });

    it('should rename folder and push to undoStack when name is valid', async () => {
      const showNotification = vi.fn();
      const refreshTree = vi.fn();
      uiManager.showPrompt.mockResolvedValueOnce('sub_renamed');

      await renameSelectedFolder({ showNotification, refreshTree });
      expect(window.veloceAPI.renameFolder).toHaveBeenCalledWith('C:\\test\\sub', 'sub_renamed');
      expect(appState.undoStack.length).toBe(1);
      expect(appState.undoStack[0].type).toBe('RENAME_FOLDER');
      expect(refreshTree).toHaveBeenCalled();
    });
  });

  describe('deleteSelectedFolder', () => {
    it('should trash folder when confirmed by user', async () => {
      const showNotification = vi.fn();
      const refreshTree = vi.fn();
      uiManager.showConfirm.mockResolvedValueOnce(true);

      await deleteSelectedFolder({ showNotification, refreshTree });
      expect(window.veloceAPI.trashFolder).toHaveBeenCalledWith('C:\\test\\sub');
      expect(refreshTree).toHaveBeenCalled();
    });

    it('should not trash folder if user cancels prompt', async () => {
      uiManager.showConfirm.mockResolvedValueOnce(false);
      await deleteSelectedFolder({});
      expect(window.veloceAPI.trashFolder).not.toHaveBeenCalled();
    });
  });

  describe('renameSelectedFile', () => {
    it('should rename selected file, clear thumbnail cache, clean up DOM pool, and track new index without notifyFileChanged', async () => {
      appState.selectedIndex = 0;
      appState.selection.add(0);
      appState.thumbnailUrls.set('C:\\test\\dir\\file0.png', 'blob:http://localhost/old-blob');
      
      const mockWrapper = document.createElement('div');
      mockWrapper.dataset.filepath = 'C:\\test\\dir\\file0.png';
      const mockImg = document.createElement('img');
      mockImg.dataset.currentSrc = 'C:\\test\\dir\\file0.png';
      mockWrapper.appendChild(mockImg);
      
      uiManager._domByPath = new Map([
        ['C:\\test\\dir\\file0.png', mockWrapper]
      ]);

      window.veloceAPI.getFileIndexByPath = vi.fn().mockResolvedValue(2);
      uiManager.showPrompt.mockResolvedValueOnce('renamed.png');
      const scheduleRefresh = vi.fn();

      await renameSelectedFile({ scheduleRefresh });

      // 1. rename_file IPC が正しく呼ばれ、Undo スタックに積まれること
      expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('C:\\test\\dir\\file0.png', 'renamed.png');
      expect(appState.undoStack.length).toBe(1);
      expect(appState.undoStack[0].type).toBe('RENAME_FILE');

      // 2. 不要かつ有害な notifyFileChanged は呼ばれないこと（Source of Truth は Rust 側 rename_file 内で同期済み）
      expect(window.veloceAPI.notifyFileChanged).not.toHaveBeenCalled();

      // 3. 古いサムネイル URL キャッシュが削除されていること
      expect(appState.thumbnailUrls.has('C:\\test\\dir\\file0.png')).toBe(false);

      // 4. DOM プールから旧パスの参照が削除され、DOM 要素のプロパティがリセットされて再描画可能になっていること
      expect(uiManager._domByPath.has('C:\\test\\dir\\file0.png')).toBe(false);
      expect(mockWrapper.dataset.filepath).toBe('');
      expect(mockImg.dataset.currentSrc).toBe('');

      // 5. getFileIndexByPath によりソート移動後の新インデックスに選択状態が追随すること
      expect(window.veloceAPI.getFileIndexByPath).toHaveBeenCalledWith('C:\\test\\dir\\new.png');
      expect(appState.selectedIndex).toBe(2);
      expect(appState.selection.has(2)).toBe(true);

      // 6. 再描画がスケジュールされること
      expect(scheduleRefresh).toHaveBeenCalled();
    });
  });

  describe('deleteSelectedFiles', () => {
    it('should delete all selected files via trashFilesBatch and notifyFilesBatch once', async () => {
      appState.selection.add(0);
      appState.selection.add(1);
      const scheduleRefresh = vi.fn();
      const clearMetadataUI = vi.fn();

      await deleteSelectedFiles({ scheduleRefresh, clearMetadataUI });
      expect(window.veloceAPI.trashFilesBatch).toHaveBeenCalledTimes(1);
      expect(window.veloceAPI.trashFilesBatch).toHaveBeenCalledWith([
        'C:\\test\\dir\\file0.png',
        'C:\\test\\dir\\file1.png'
      ]);
      expect(window.veloceAPI.notifyFilesBatch).toHaveBeenCalledTimes(1);
      expect(window.veloceAPI.notifyFilesBatch).toHaveBeenCalledWith([], [
        'C:\\test\\dir\\file0.png',
        'C:\\test\\dir\\file1.png'
      ]);
      expect(window.veloceAPI.trashFile).not.toHaveBeenCalled();
      expect(window.veloceAPI.notifyFileRemoved).not.toHaveBeenCalled();
      expect(appState.selection.size).toBe(0);
      expect(clearMetadataUI).toHaveBeenCalled();
      expect(scheduleRefresh).toHaveBeenCalled();
      expect(uiManager.showToast).toHaveBeenCalledWith('2件のアイテムをゴミ箱に移動しました', 3000, 'file-trash', 'warning');
    });

    it('should notify only succeeded paths if partial failure occurs', async () => {
      appState.selection.add(0);
      appState.selection.add(1);
      // file0.png のみ成功
      window.veloceAPI.trashFilesBatch.mockResolvedValueOnce(['C:\\test\\dir\\file0.png']);
      const scheduleRefresh = vi.fn();

      await deleteSelectedFiles({ scheduleRefresh });
      expect(window.veloceAPI.trashFilesBatch).toHaveBeenCalledTimes(1);
      expect(window.veloceAPI.notifyFilesBatch).toHaveBeenCalledWith([], ['C:\\test\\dir\\file0.png']);
      expect(uiManager.showToast).toHaveBeenCalledWith('1件のアイテムをゴミ箱に移動しました', 3000, 'file-trash', 'warning');
      expect(scheduleRefresh).toHaveBeenCalled();
    });

    it('should fallback to single trashFile and notifyFileRemoved when batch API is not available', async () => {
      appState.selection.add(0);
      appState.selection.add(1);
      delete window.veloceAPI.trashFilesBatch;
      delete window.veloceAPI.notifyFilesBatch;
      const scheduleRefresh = vi.fn();

      await deleteSelectedFiles({ scheduleRefresh });
      expect(window.veloceAPI.trashFile).toHaveBeenCalledTimes(2);
      expect(window.veloceAPI.notifyFileRemoved).toHaveBeenCalledTimes(2);
      expect(scheduleRefresh).toHaveBeenCalled();
      expect(uiManager.showToast).toHaveBeenCalledWith('2件のアイテムをゴミ箱に移動しました', 3000, 'file-trash', 'warning');
    });

    it('should show failure toast and avoid refresh when all files fail', async () => {
      appState.selection.add(0);
      window.veloceAPI.trashFilesBatch.mockResolvedValueOnce([]);
      const scheduleRefresh = vi.fn();

      await deleteSelectedFiles({ scheduleRefresh });
      expect(window.veloceAPI.notifyFilesBatch).not.toHaveBeenCalled();
      expect(scheduleRefresh).not.toHaveBeenCalled();
      expect(uiManager.showToast).toHaveBeenCalledWith('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    });
  });

  describe('performUndo', () => {
    it('should show toast when undoStack is empty', async () => {
      appState.undoStack = [];
      await performUndo();
      expect(uiManager.showToast).toHaveBeenCalledWith('元に戻す操作はありません', 2000, 'undo', 'info');
    });

    it('should undo RENAME_FILE', async () => {
      appState.undoStack.push({
        type: 'RENAME_FILE',
        oldPath: 'C:\\test\\dir\\old.png',
        newPath: 'C:\\test\\dir\\new.png'
      });
      const scheduleRefresh = vi.fn();

      await performUndo({ scheduleRefresh });
      expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('C:\\test\\dir\\new.png', 'old.png');
      expect(scheduleRefresh).toHaveBeenCalled();
    });

    it('should undo RENAME_FOLDER', async () => {
      appState.undoStack.push({
        type: 'RENAME_FOLDER',
        oldPath: 'C:\\test\\old_folder',
        newPath: 'C:\\test\\new_folder'
      });
      const refreshTree = vi.fn();

      await performUndo({ refreshTree });
      expect(window.veloceAPI.renameFolder).toHaveBeenCalledWith('C:\\test\\new_folder', 'old_folder');
      expect(refreshTree).toHaveBeenCalled();
    });

    it('should undo MOVE_FILE', async () => {
      appState.undoStack.push({
        type: 'MOVE_FILE',
        sourcePath: 'C:\\source\\file.png',
        targetPath: 'C:\\target\\file.png'
      });
      const scheduleRefresh = vi.fn();

      await performUndo({ scheduleRefresh });
      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledWith('C:\\target\\file.png', 'C:\\source', 'move');
      expect(scheduleRefresh).toHaveBeenCalled();
    });

    it('should undo COPY_FILE via trashFile', async () => {
      appState.undoStack.push({
        type: 'COPY_FILE',
        targetPath: 'C:\\target\\copy.png'
      });
      const scheduleRefresh = vi.fn();

      await performUndo({ scheduleRefresh });
      expect(window.veloceAPI.trashFile).toHaveBeenCalledWith('C:\\target\\copy.png');
      expect(window.__TAURI__.fs.removeFile).not.toHaveBeenCalled();
      expect(scheduleRefresh).toHaveBeenCalled();
    });

    it('should update all open tabs, tab histories, and favorites on folder rename and undo without touching sibling folders', async () => {
      uiManager.renderTabs = vi.fn();
      appState.currentDirectory = 'C:\\test\\sub\\nested';
      appState.favorites = [
        { id: 'fav1', name: 'sub', path: 'C:\\test\\sub' },
        { id: 'fav2', name: 'child', path: 'C:\\test\\sub\\child' },
        { id: 'fav_sib', name: 'sub2', path: 'C:\\test\\sub2\\child' }
      ];
      appState.tabs = [
        {
          id: 1,
          path: 'C:\\test\\sub\\nested',
          name: 'nested',
          history: ['C:\\test', 'C:\\test\\sub', 'C:\\test\\sub\\nested'],
          historyIndex: 2
        },
        {
          id: 2,
          path: 'C:\\test\\sub',
          name: 'sub',
          history: ['C:\\test\\sub', 'C:\\test\\sub2\\other'],
          historyIndex: 0
        },
        {
          id: 3,
          path: 'C:\\test\\sub2',
          name: 'sub2',
          history: ['C:\\test\\sub2'],
          historyIndex: 0
        }
      ];
      appState.activeTabIndex = 0;

      window.veloceAPI.renameFolder.mockResolvedValueOnce({
        success: true,
        path: 'C:\\test\\sub_renamed'
      });
      uiManager.showPrompt.mockResolvedValueOnce('sub_renamed');
      const refreshFileList = vi.fn();
      const refreshTree = vi.fn();

      // 1. 通常フォルダリネーム
      await renameSelectedFolder({ refreshFileList, refreshTree });

      expect(appState.currentDirectory).toBe('C:\\test\\sub_renamed\\nested');
      expect(appState.tabs[0].path).toBe('C:\\test\\sub_renamed\\nested');
      expect(appState.tabs[0].history).toEqual([
        'C:\\test',
        'C:\\test\\sub_renamed',
        'C:\\test\\sub_renamed\\nested'
      ]);
      expect(appState.tabs[1].path).toBe('C:\\test\\sub_renamed');
      expect(appState.tabs[1].name).toBe('sub_renamed');
      expect(appState.tabs[1].history).toEqual([
        'C:\\test\\sub_renamed',
        'C:\\test\\sub2\\other'
      ]);
      // 兄弟フォルダ sub2 のタブは変更されないこと
      expect(appState.tabs[2].path).toBe('C:\\test\\sub2');
      expect(appState.tabs[2].history).toEqual(['C:\\test\\sub2']);

      expect(appState.favorites[0].path).toBe('C:\\test\\sub_renamed');
      expect(appState.favorites[0].name).toBe('sub_renamed');
      expect(appState.favorites[1].path).toBe('C:\\test\\sub_renamed\\child');
      expect(appState.favorites[2].path).toBe('C:\\test\\sub2\\child');
      expect(refreshFileList).toHaveBeenCalledTimes(1);

      // 2. Undo (Ctrl+Z) で元に戻した際にも全タブ・履歴・お気に入りが旧パスへ復帰すること
      window.veloceAPI.renameFolder.mockResolvedValueOnce({
        success: true,
        path: 'C:\\test\\sub'
      });
      await performUndo({ refreshFileList, refreshTree });

      expect(appState.currentDirectory).toBe('C:\\test\\sub\\nested');
      expect(appState.tabs[0].path).toBe('C:\\test\\sub\\nested');
      expect(appState.tabs[0].history).toEqual([
        'C:\\test',
        'C:\\test\\sub',
        'C:\\test\\sub\\nested'
      ]);
      expect(appState.tabs[1].path).toBe('C:\\test\\sub');
      expect(appState.tabs[1].name).toBe('sub');
      expect(appState.favorites[0].path).toBe('C:\\test\\sub');
      expect(appState.favorites[1].path).toBe('C:\\test\\sub\\child');
      expect(appState.favorites[2].path).toBe('C:\\test\\sub2\\child');
    });

    it('should resolve parent directory accurately when deleting a folder with forward/mixed slashes', async () => {
      uiManager.renderTabs = vi.fn();
      document.body.innerHTML = `
        <div id="dir-tree">
          <ul>
            <li>
              <div class="tree-item selected" data-path="C:/test/mixed\\target_dir">
                <span class="tree-label">target_dir</span>
              </div>
            </li>
          </ul>
        </div>
      `;
      appState.currentDirectory = 'C:\\test\\mixed\\target_dir\\deep';
      appState.tabs = [
        {
          id: 1,
          path: 'C:\\test\\mixed\\target_dir\\deep',
          name: 'deep',
          history: ['C:\\test\\mixed\\target_dir\\deep'],
          historyIndex: 0
        },
        {
          id: 2,
          path: 'C:/test/mixed/target_dir',
          name: 'target_dir',
          history: ['C:/test/mixed/target_dir'],
          historyIndex: 0
        }
      ];

      uiManager.showConfirm.mockResolvedValueOnce(true);
      const refreshFileList = vi.fn();
      const refreshTree = vi.fn();

      await deleteSelectedFolder({ refreshFileList, refreshTree });

      expect(appState.currentDirectory).toBe('C:\\test\\mixed');
      expect(appState.tabs[0].path).toBe('C:\\test\\mixed');
      expect(appState.tabs[1].path).toBe('C:\\test\\mixed');
      expect(refreshFileList).toHaveBeenCalledTimes(1);
    });
  });
});
