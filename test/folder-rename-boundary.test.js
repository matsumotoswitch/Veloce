import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isSameOrSubdirectory, replaceDirectoryPrefix } from '../src/common/path-utils.js';
import { appState, fileOpsState } from '../src/renderer/renderer-state.js';
import { renameSelectedFolder } from '../src/renderer/renderer-file-ops.js';
import { uiManager } from '../src/renderer/renderer-ui.js';

describe('Folder Rename Boundary Safety', () => {
  describe('isSameOrSubdirectory', () => {
    it('returns true when target path equals base path', () => {
      expect(isSameOrSubdirectory('C:\\album', 'C:\\album')).toBe(true);
      expect(isSameOrSubdirectory('C:\\album\\', 'C:\\album')).toBe(true);
      expect(isSameOrSubdirectory('c:\\album', 'C:\\ALBUM')).toBe(true);
    });

    it('returns true when target path is a subdirectory of base path', () => {
      expect(isSameOrSubdirectory('C:\\album\\sub', 'C:\\album')).toBe(true);
      expect(isSameOrSubdirectory('C:\\album\\sub\\nested', 'C:\\album')).toBe(true);
      expect(isSameOrSubdirectory('C:/album/sub', 'C:\\album')).toBe(true);
    });

    it('returns false when target path shares prefix but is a sibling directory (e.g. album2 vs album)', () => {
      expect(isSameOrSubdirectory('C:\\album2', 'C:\\album')).toBe(false);
      expect(isSameOrSubdirectory('C:\\album2\\sub', 'C:\\album')).toBe(false);
      expect(isSameOrSubdirectory('C:\\album_old', 'C:\\album')).toBe(false);
    });

    it('returns false for completely different directories or invalid input', () => {
      expect(isSameOrSubdirectory('D:\\album', 'C:\\album')).toBe(false);
      expect(isSameOrSubdirectory('', 'C:\\album')).toBe(false);
      expect(isSameOrSubdirectory(null, 'C:\\album')).toBe(false);
    });
  });

  describe('replaceDirectoryPrefix', () => {
    it('replaces exact match directory prefix', () => {
      const res = replaceDirectoryPrefix('C:\\album', 'C:\\album', 'C:\\album_new');
      expect(res).toBe('C:\\album_new');
    });

    it('replaces descendant subdirectory prefix preserving remainder path', () => {
      const res = replaceDirectoryPrefix('C:\\album\\sub\\item.jpg', 'C:\\album', 'C:\\album_new');
      expect(res).toBe('C:\\album_new\\sub\\item.jpg');
    });

    it('does NOT modify sibling directory with similar prefix (boundary safety)', () => {
      const res1 = replaceDirectoryPrefix('C:\\album2', 'C:\\album', 'C:\\album_new');
      expect(res1).toBe('C:\\album2');

      const res2 = replaceDirectoryPrefix('C:\\album2\\sub', 'C:\\album', 'C:\\album_new');
      expect(res2).toBe('C:\\album2\\sub');
    });

    it('handles forward slash variations correctly', () => {
      const res = replaceDirectoryPrefix('C:/album/sub', 'C:/album', 'C:\\album_new');
      expect(res).toBe('C:\\album_new\\sub');
    });
  });

  describe('renameSelectedFolder with boundary safety', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="dir-tree">
          <div class="tree-item selected" data-path="C:\\album">
            <span class="tree-label">album</span>
          </div>
        </div>
      `;
      window.veloceAPI = {
        renameFolder: vi.fn().mockResolvedValue({ success: true, path: 'C:\\album_renamed' }),
      };
      vi.spyOn(uiManager, 'showPrompt').mockResolvedValue('album_renamed');
    });

    it('does not alter appState.currentDirectory when viewing album2 during album rename', async () => {
      appState.currentDirectory = 'C:\\album2';
      const callbacks = {
        showNotification: vi.fn(),
        refreshTree: vi.fn(),
        refreshFileList: vi.fn(),
      };

      await renameSelectedFolder(callbacks);

      expect(appState.currentDirectory).toBe('C:\\album2');
      expect(callbacks.refreshFileList).not.toHaveBeenCalled();
      expect(callbacks.refreshTree).toHaveBeenCalled();
    });

    it('updates appState.currentDirectory and refreshes file list when viewing descendant of renamed folder', async () => {
      appState.currentDirectory = 'C:\\album\\vacation';
      const callbacks = {
        showNotification: vi.fn(),
        refreshTree: vi.fn(),
        refreshFileList: vi.fn(),
      };

      await renameSelectedFolder(callbacks);

      expect(appState.currentDirectory).toBe('C:\\album_renamed\\vacation');
      expect(callbacks.refreshFileList).toHaveBeenCalled();
      expect(callbacks.refreshTree).toHaveBeenCalled();
    });
  });
});

