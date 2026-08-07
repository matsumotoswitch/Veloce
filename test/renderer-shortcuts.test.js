import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { uiManager } from '../src/renderer-ui.js';

describe('Renderer Global Shortcuts & Focus Management', () => {
  let globalKeydownHandler;
  let selectImage;
  let getSelectionRemoveAllRangesSpy;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <div id="center-top"></div>
      <div id="center-bottom">
        <div class="thumbnail-item" data-index="0"></div>
        <div class="thumbnail-item" data-index="1"></div>
      </div>
      <div id="file-list-body"></div>
      <div id="file-list-top-spacer"></div>
      <div id="file-list-bottom-spacer"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
    `;

    // Populate uiManager.elements so renderer.js won't crash on load
    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    // Dynamic import to ensure DOM is ready
    const renderer = await import('../src/renderer.js');
    globalKeydownHandler = renderer.globalKeydownHandler;
    selectImage = renderer.selectImage;
  });

  beforeEach(() => {
    getSelectionRemoveAllRangesSpy = vi.fn();

    // reset appState
    appState.totalCount = 2;
    appState.selectedIndex = -1;
    appState.selection = new Set();
    appState.ratings = {};

    // Mock API (merge with setup.js mocks)
    window.veloceAPI = {
      getItems: vi.fn().mockResolvedValue([]),
      loadDirectory: vi.fn().mockResolvedValue({ files: [], current_dir: '' }),
      renameFile: vi.fn().mockResolvedValue({ success: true }),
      getFileByIndex: vi.fn().mockImplementation(async (idx) => {
        if (idx === 0) return { path: '/path/to/0.jpg', name: '0.jpg' };
        if (idx === 1) return { path: '/path/to/1.jpg', name: '1.jpg' };
        return null;
      }),
      copyImageToClipboard: vi.fn(),
      setRating: vi.fn(),
      arrangeViewers: vi.fn(),
      trashFile: vi.fn().mockResolvedValue(true),
      notifyFileRemoved: vi.fn(),
      notifyFileChanged: vi.fn()
    };

    uiManager.showToast = vi.fn();
    uiManager.updateSelectionUI = vi.fn();
    uiManager._domByPath = new Map([
      ['/path/to/0.jpg', document.querySelector('.thumbnail-item[data-index="0"]')],
      ['/path/to/1.jpg', document.querySelector('.thumbnail-item[data-index="1"]')]
    ]);

    // Mock notification and other globals
    window.showNotification = vi.fn();
    window.renameSelectedFile = vi.fn();
    window.renameSelectedFolder = vi.fn();
    window.deleteSelectedFiles = vi.fn();
    window.deleteSelectedFolder = vi.fn();
    window.onTabClick = vi.fn();
    window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue({});
    uiManager.showDiffModal = vi.fn();
    uiManager.hideCustomTooltip = vi.fn();
    uiManager.updateVirtualList = vi.fn();
    uiManager.updateVirtualGrid = vi.fn();

    // Mock CSS for JSDOM
    global.CSS = { escape: vi.fn(s => s) };

    // Mock removeAllRanges since jsdom doesn't fully implement it
    window.getSelection = vi.fn(() => ({
      removeAllRanges: getSelectionRemoveAllRangesSpy,
      toString: vi.fn(() => '')
    }));

    window.__TAURI__ = {
      path: {
        basename: vi.fn().mockResolvedValue('oldname.jpg')
      }
    };

    // Reset element functions if needed, though JSDOM handles focus natively
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.getElementById('search-input').blur();
  });

  describe('Focus Management', () => {
    it('should clear selection and blur input when selectImage is called', async () => {
      const input = document.getElementById('search-input');
      input.focus();

      await selectImage(0);

      expect(getSelectionRemoveAllRangesSpy).toHaveBeenCalled();
      // JSDOM blur changes activeElement back to body
      expect(document.activeElement).not.toBe(input);
      expect(appState.selectedIndex).toBe(0);
    });
  });

  describe('Ctrl+C - Copy Image', () => {
    it('should copy image to clipboard and apply flash effect', async () => {
      appState.selectedIndex = 1;
      appState.selection.add(1);

      const event = new window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
      await globalKeydownHandler(event);
      
      // Wait for promises in the handler
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(window.veloceAPI.getFileByIndex).toHaveBeenCalledWith(1);
      expect(window.veloceAPI.copyImageToClipboard).toHaveBeenCalledWith('/path/to/1.jpg');
    });

    it('should skip image copy if text is selected in the window', async () => {
      window.getSelection = vi.fn(() => ({
        toString: () => 'selected text'
      }));

      const event = new window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
      await globalKeydownHandler(event);

      expect(window.veloceAPI.copyImageToClipboard).not.toHaveBeenCalled();
    });

    it('should do nothing if focus is in an input field', async () => {
      const input = document.getElementById('search-input');
      input.focus();

      const event = new window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
      await globalKeydownHandler(event);

      expect(window.veloceAPI.getFileByIndex).not.toHaveBeenCalled();
      expect(window.veloceAPI.copyImageToClipboard).not.toHaveBeenCalled();
    });
  });

  describe('Other Global Shortcuts', () => {
    it('should focus search bar on Ctrl+F', async () => {
      const event = new window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      const focusSpy = vi.spyOn(uiManager.elements.searchBar, 'focus');
      const selectSpy = vi.spyOn(uiManager.elements.searchBar, 'select');
      
      await globalKeydownHandler(event);
      
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
      expect(selectSpy).toHaveBeenCalled();
    });

    it('should call renameSelectedFile on F2', async () => {
      appState.selectedIndex = 0;
      appState.selection.add(0);
      uiManager.showPrompt = vi.fn().mockResolvedValue('newname.jpg');
      
      const event = new window.KeyboardEvent('keydown', { key: 'F2', cancelable: true });
      
      await globalKeydownHandler(event);
      
      // wait for promises
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(uiManager.showPrompt).toHaveBeenCalled();
    });

    it('should call deleteSelectedFiles on Delete', async () => {
      appState.selectedIndex = 0;
      appState.selection.add(0);
      window.veloceAPI.getFilesByIndices = vi.fn().mockResolvedValue([{ path: '/path/to/0.jpg' }]);
      
      const event = new window.KeyboardEvent('keydown', { key: 'Delete', cancelable: true });
      
      await globalKeydownHandler(event);
      
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(window.veloceAPI.trashFile).toHaveBeenCalled();
    });

    it('should call performUndo on Ctrl+Z', async () => {
      appState.undoStack = [{ type: 'RENAME_FILE', oldPath: 'a', newPath: 'b' }];
      window.veloceAPI.renameFile = vi.fn().mockResolvedValue({ success: true });
      const event = new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
      
      await globalKeydownHandler(event);
      
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(window.veloceAPI.renameFile).toHaveBeenCalled();
    });

    it('should set rating on 0-5 keys', async () => {
      appState.selectedIndex = 0;
      appState.selection.add(0);

      const event = new window.KeyboardEvent('keydown', { key: '5', cancelable: true });
      await globalKeydownHandler(event);

      expect(window.veloceAPI.getFileByIndex).toHaveBeenCalledWith(0);
      expect(window.veloceAPI.setRating).toHaveBeenCalledWith('/path/to/0.jpg', 5);
    });

    it('should call hideCustomTooltip (via refreshFileList) on F5', async () => {
      appState.currentDirectory = '/some/dir';
      const event = new window.KeyboardEvent('keydown', { key: 'F5', cancelable: true });
      await globalKeydownHandler(event);
      expect(uiManager.hideCustomTooltip).toHaveBeenCalled();
    });

    it('should select all on Ctrl+A', async () => {
      appState.totalCount = 2;
      const event = new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: document.body });
      await globalKeydownHandler(event);
      expect(appState.selection.size).toBe(2);
      expect(appState.selectedIndex).toBe(1);
      expect(uiManager.updateSelectionUI).toHaveBeenCalled();
    });

    it('should call arrangeViewers on A', async () => {
      const event = new window.KeyboardEvent('keydown', { key: 'a', cancelable: true });
      await globalKeydownHandler(event);
      expect(window.veloceAPI.arrangeViewers).toHaveBeenCalled();
    });

    it('should show diff modal on D when 2 items are selected', async () => {
      appState.selection.add(0);
      appState.selection.add(1);
      const event = new window.KeyboardEvent('keydown', { key: 'd', cancelable: true });
      await globalKeydownHandler(event);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(uiManager.showDiffModal).toHaveBeenCalled();
    });

    it('should call navigateHistory on Alt+ArrowLeft/Right', async () => {
      appState.tabs = [{ history: ['/a', '/b', '/c'], historyIndex: 1 }];
      appState.activeTabIndex = 0;

      const eventLeft = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true });
      await globalKeydownHandler(eventLeft);
      // Let promises resolve
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('/a');

      // Reset historyIndex to 1 before testing ArrowRight
      appState.tabs[0].historyIndex = 1;

      const eventRight = new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, cancelable: true });
      await globalKeydownHandler(eventRight);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('/c');
    });

    it('should toggle help overlay on F1 or H', async () => {
      const eventF1 = new window.KeyboardEvent('keydown', { key: 'F1', cancelable: true });
      await globalKeydownHandler(eventF1);
      
      const overlay = document.getElementById('help-overlay');
      expect(overlay).not.toBeNull();
      
      // Cleanup
      if (overlay) overlay.remove();
    });

    it('should close overlays on Escape', async () => {
      const diffModal = document.createElement('div');
      diffModal.id = 'diff-modal';
      diffModal.classList.add('show');
      document.body.appendChild(diffModal);

      const event = new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      await globalKeydownHandler(event);
      
      expect(diffModal.classList.contains('show')).toBe(false);
      diffModal.remove();
    });

    it('should switch tabs on Ctrl+Tab', async () => {
      appState.tabs = [{}, {}]; // 2 tabs
      appState.activeTabIndex = 0;
      
      const event = new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, cancelable: true });
      await globalKeydownHandler(event);
      
      expect(window.onTabClick).toHaveBeenCalledWith(1);
    });
  });
});
