import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { uiManager } from '../src/renderer-ui.js';
import {
  initFileOps,
  renameSelectedFolder,
  deleteSelectedFolder,
  renameSelectedFile,
  rebuildSelectedCache,
  deleteSelectedFiles,
  performUndo
} from '../src/renderer-file-ops.js';

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
      getFileByIndex: vi.fn().mockImplementation(async (idx) => ({
        path: `C:\\test\\dir\\file${idx}.png`,
        name: `file${idx}.png`
      })),
      getFilesByIndices: vi.fn().mockImplementation(async (indices) =>
        indices.map(i => ({ path: `C:\\test\\dir\\file${i}.png`, name: `file${i}.png` }))
      ),
      notifyFileChanged: vi.fn().mockResolvedValue(undefined),
      notifyFileRemoved: vi.fn().mockResolvedValue(undefined),
      clearMetadataCache: vi.fn().mockResolvedValue(undefined),
      moveOrCopyFile: vi.fn().mockResolvedValue({ success: true })
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
    it('should validate and rename selected file', async () => {
      appState.selectedIndex = 0;
      uiManager.showPrompt.mockResolvedValueOnce('renamed.png');
      const scheduleRefresh = vi.fn();

      await renameSelectedFile({ scheduleRefresh });
      expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('C:\\test\\dir\\file0.png', 'renamed.png');
      expect(appState.undoStack.length).toBe(1);
      expect(appState.undoStack[0].type).toBe('RENAME_FILE');
      expect(scheduleRefresh).toHaveBeenCalled();
    });
  });

  describe('deleteSelectedFiles', () => {
    it('should delete all selected files and clear selection', async () => {
      appState.selection.add(0);
      appState.selection.add(1);
      const scheduleRefresh = vi.fn();
      const clearMetadataUI = vi.fn();

      await deleteSelectedFiles({ scheduleRefresh, clearMetadataUI });
      expect(window.veloceAPI.trashFile).toHaveBeenCalledTimes(2);
      expect(appState.selection.size).toBe(0);
      expect(clearMetadataUI).toHaveBeenCalled();
      expect(scheduleRefresh).toHaveBeenCalled();
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

    it('should undo COPY_FILE', async () => {
      appState.undoStack.push({
        type: 'COPY_FILE',
        targetPath: 'C:\\target\\copy.png'
      });
      const scheduleRefresh = vi.fn();

      await performUndo({ scheduleRefresh });
      expect(window.__TAURI__.fs.removeFile).toHaveBeenCalledWith('C:\\target\\copy.png');
      expect(scheduleRefresh).toHaveBeenCalled();
    });
  });
});
