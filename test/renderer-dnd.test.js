import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initDragTooltip,
  updateDragTooltip,
  hideDragTooltip,
  getPathsFromDragEventAsync,
  handleItemDragStart,
  initGlobalDndHandlers,
  initDirTreeDnd,
  initFavoritesDnd
} from '../src/renderer/renderer-dnd.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('renderer-dnd.js - Drag and Drop Management', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="dir-tree">
        <div class="tree-item" data-path="C:/Photos" data-name="Photos" data-is-root="false">Photos</div>
        <div class="tree-item" data-path="C:/" data-name="C:" data-is-root="true">C:</div>
      </div>
      <div id="favorites-list">
        <div class="bookmark-item" data-id="fav_1" data-path="C:/Fav1">Fav 1</div>
        <div class="bookmark-item" data-id="fav_2" data-path="C:/Fav2">Fav 2</div>
      </div>
      <div id="grid-container">
        <div class="thumbnail-item" data-index="0" data-filepath="C:/Photos/img1.png"></div>
        <div class="thumbnail-item" data-index="1" data-filepath="C:/Photos/img2.png"></div>
      </div>
    `;

    appState.selection = new Set();
    appState.selectedIndex = -1;
    appState.favorites = [
      { id: 'fav_1', name: 'Fav 1', path: 'C:/Fav1' },
      { id: 'fav_2', name: 'Fav 2', path: 'C:/Fav2' }
    ];
    appState.dragState = {
      isAppDragging: false,
      paths: [],
      indices: [],
      cachedRoot: null,
      pendingRefresh: false
    };

    window.veloceAPI = {
      getFilesByIndices: vi.fn(),
      moveOrCopyFile: vi.fn(),
      checkConflicts: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Drag Tooltip', () => {
    it('initializes and updates drag tooltip DOM with coordinates', () => {
      initDragTooltip();
      const tooltip = document.getElementById('drag-tooltip');
      expect(tooltip).not.toBeNull();
      expect(tooltip.style.pointerEvents).toBe('none');

      updateDragTooltip('3 個のアイテム', 100, 200);
      expect(tooltip.classList.contains('show')).toBe(true);
      expect(tooltip.textContent).toContain('3 個のアイテム');
      expect(tooltip.style.left).toBe('115px');
      expect(tooltip.style.top).toBe('215px');

      hideDragTooltip();
      expect(tooltip.classList.contains('show')).toBe(false);
    });
  });

  describe('getPathsFromDragEventAsync', () => {
    it('returns appState.dragState.paths if available', async () => {
      appState.dragState.paths = ['C:/test/a.png', 'C:/test/b.png'];
      const mockEvent = { dataTransfer: { getData: vi.fn() } };

      const paths = await getPathsFromDragEventAsync(mockEvent);
      expect(paths).toEqual(['C:/test/a.png', 'C:/test/b.png']);
      expect(mockEvent.dataTransfer.getData).not.toHaveBeenCalled();
    });

    it('extracts folder path from application/json-folder', async () => {
      const folderData = JSON.stringify({ path: 'C:/Images', name: 'Images' });
      const mockEvent = {
        dataTransfer: {
          getData: vi.fn((type) => (type === 'application/json-folder' ? folderData : ''))
        }
      };

      const paths = await getPathsFromDragEventAsync(mockEvent);
      expect(paths).toEqual(['C:/Images']);
    });

    it('extracts paths from JSON array', async () => {
      const jsonData = JSON.stringify(['C:/img1.png', 'C:/img2.png']);
      const mockEvent = {
        dataTransfer: {
          getData: vi.fn((type) => (type === 'application/json' ? jsonData : ''))
        }
      };

      const paths = await getPathsFromDragEventAsync(mockEvent);
      expect(paths).toEqual(['C:/img1.png', 'C:/img2.png']);
    });

    it('extracts and cleans file URL from text/plain', async () => {
      const mockEvent = {
        dataTransfer: {
          getData: vi.fn((type) => (type === 'text/plain' ? 'file:///C:/Photos/my%20image.png' : ''))
        }
      };

      const paths = await getPathsFromDragEventAsync(mockEvent);
      expect(paths).toEqual(['C:/Photos/my image.png']);
    });
  });

  describe('handleItemDragStart', () => {
    it('selects item if not currently selected and sets drag dataTransfer', () => {
      const item = document.querySelector('.thumbnail-item[data-index="0"]');
      const setDataMock = vi.fn();
      const setDragImageMock = vi.fn();

      const mockEvent = {
        target: item,
        clientX: 50,
        clientY: 50,
        dataTransfer: {
          setData: setDataMock,
          setDragImage: setDragImageMock,
          effectAllowed: ''
        }
      };

      handleItemDragStart(mockEvent, true);

      expect(appState.selection.has(0)).toBe(true);
      expect(appState.selectedIndex).toBe(0);
      expect(appState.dragState.isAppDragging).toBe(true);
      expect(setDataMock).toHaveBeenCalledWith('application/json-indices', '[0]');
      expect(setDataMock).toHaveBeenCalledWith('text/plain', 'C:/Photos/img1.png');
    });
  });

  describe('initDirTreeDnd', () => {
    it('adds and removes drop-target class on dragenter and dragleave', () => {
      const dirTree = document.getElementById('dir-tree');
      initDirTreeDnd(dirTree);

      const item = dirTree.querySelector('.tree-item');
      item.dispatchEvent(new Event('dragenter', { bubbles: true }));
      expect(item.classList.contains('drop-target')).toBe(true);

      item.dispatchEvent(new Event('dragleave', { bubbles: true }));
      expect(item.classList.contains('drop-target')).toBe(false);
    });

    it('moves file and transfers rating to targetPath in appState.ratings', async () => {
      const dirTree = document.getElementById('dir-tree');
      initDirTreeDnd(dirTree);

      appState.ratings = { 'C:/Photos/img1.png': 5 };
      appState.dragState.paths = ['C:/Photos/img1.png'];
      appState.dragState.isAppDragging = true;

      window.veloceAPI.moveOrCopyFile.mockResolvedValue({
        success: true,
        action: 'move',
        targetPath: 'C:/Dest/img1.png'
      });

      const item = dirTree.querySelector('.tree-item[data-path="C:/Photos"]');
      const dropEvent = new Event('drop', { bubbles: true });
      dropEvent.dataTransfer = {
        types: ['text/plain'],
        getData: vi.fn(() => 'C:/Photos/img1.png')
      };
      item.dispatchEvent(dropEvent);

      // drop ハンドラー内の非同期 getPathsFromDragEventAsync と setTimeout を待機
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledWith('C:/Photos/img1.png', 'C:/Photos', 'auto');
      expect(appState.ratings['C:/Dest/img1.png']).toBe(5);
      expect(appState.ratings['C:/Photos/img1.png']).toBeUndefined();
      // drop 完了時のフェイルセーフにより dragend なしでも isAppDragging が false に戻ること
      expect(appState.dragState.isAppDragging).toBe(false);
    });

    it('batches syncFilesMoveBatch once for multiple moved files and skips it for copy', async () => {
      const dirTree = document.getElementById('dir-tree');
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      initDirTreeDnd(dirTree, { refreshFileList: refreshSpy });

      window.veloceAPI.syncFilesMoveBatch = vi.fn().mockResolvedValue(undefined);
      window.veloceAPI.moveOrCopyFile.mockImplementation(async (srcPath, destDir, intent) => {
        const name = srcPath.split('/').pop();
        return {
          success: true,
          action: intent === 'copy' ? 'copy' : 'move',
          targetPath: `${destDir}/${name}`,
          syncDeferred: intent !== 'copy'
        };
      });

      const movePaths = ['C:/Src/a.png', 'C:/Src/b.png', 'C:/Src/c.png'];
      appState.dragState.paths = [...movePaths];
      appState.dragState.isAppDragging = true;

      const item = dirTree.querySelector('.tree-item[data-path="C:/Photos"]');
      const moveDropEvent = new Event('drop', { bubbles: true });
      moveDropEvent.dataTransfer = {
        types: ['application/json'],
        getData: vi.fn(() => JSON.stringify(movePaths))
      };
      item.dispatchEvent(moveDropEvent);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledTimes(3);
      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenNthCalledWith(1, 'C:/Src/a.png', 'C:/Photos', 'auto', { deferSync: true });
      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenNthCalledWith(2, 'C:/Src/b.png', 'C:/Photos', 'auto', { deferSync: true });
      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenNthCalledWith(3, 'C:/Src/c.png', 'C:/Photos', 'auto', { deferSync: true });
      expect(window.veloceAPI.syncFilesMoveBatch).toHaveBeenCalledTimes(1);
      expect(window.veloceAPI.syncFilesMoveBatch).toHaveBeenCalledWith([
        { oldPath: 'C:/Src/a.png', newPath: 'C:/Photos/a.png' },
        { oldPath: 'C:/Src/b.png', newPath: 'C:/Photos/b.png' },
        { oldPath: 'C:/Src/c.png', newPath: 'C:/Photos/c.png' }
      ]);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(appState.dragState.isAppDragging).toBe(false);

      // コピー操作（ctrlKey: true）では syncFilesMoveBatch が呼ばれないこと
      window.veloceAPI.syncFilesMoveBatch.mockClear();
      window.veloceAPI.moveOrCopyFile.mockClear();
      appState.dragState.paths = ['C:/Src/d.png', 'C:/Src/e.png'];
      appState.dragState.isAppDragging = true;

      const copyDropEvent = new Event('drop', { bubbles: true });
      copyDropEvent.ctrlKey = true;
      copyDropEvent.dataTransfer = {
        types: ['application/json'],
        getData: vi.fn(() => JSON.stringify(['C:/Src/d.png', 'C:/Src/e.png']))
      };
      item.dispatchEvent(copyDropEvent);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledTimes(2);
      expect(window.veloceAPI.syncFilesMoveBatch).not.toHaveBeenCalled();
      expect(appState.dragState.isAppDragging).toBe(false);
    });
  });

  describe('initGlobalDndHandlers - isAppDragging failsafe reset', () => {
    it('resets isAppDragging on window blur and remains idempotent with subsequent dragend', async () => {
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      initGlobalDndHandlers({ refreshFileList: refreshSpy });
      initDragTooltip();
      updateDragTooltip('2 個のアイテム', 10, 20);

      appState.dragState.isAppDragging = true;
      appState.dragState.paths = ['C:/Photos/img1.png', 'C:/Photos/img2.png'];
      appState.dragState.indices = [0, 1];
      appState.dragState.cachedRoot = 'c:';
      appState.dragState.pendingRefresh = true;

      window.dispatchEvent(new Event('blur'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(appState.dragState.isAppDragging).toBe(false);
      expect(appState.dragState.paths).toEqual([]);
      expect(appState.dragState.indices).toEqual([]);
      expect(appState.dragState.cachedRoot).toBeNull();
      expect(document.getElementById('drag-tooltip').classList.contains('show')).toBe(false);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // 後続で dragend が遅れて到着しても冪等に動作し、refreshFileList が二重実行されないこと
      document.dispatchEvent(new Event('dragend', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('resets isAppDragging on Escape keydown while dragging and ignores Escape when idle', async () => {
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      initGlobalDndHandlers({ refreshFileList: refreshSpy });

      // アイドル時の Escape では何もしないこと
      appState.dragState.isAppDragging = false;
      appState.dragState.pendingRefresh = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(refreshSpy).not.toHaveBeenCalled();

      // ドラッグ中の Escape で状態がリセットされること
      appState.dragState.isAppDragging = true;
      appState.dragState.paths = ['C:/Photos/img1.png'];
      appState.dragState.indices = [0];
      appState.dragState.cachedRoot = 'c:';
      appState.dragState.pendingRefresh = true;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(appState.dragState.isAppDragging).toBe(false);
      expect(appState.dragState.paths).toEqual([]);
      expect(appState.dragState.indices).toEqual([]);
      expect(appState.dragState.cachedRoot).toBeNull();
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('initFavoritesDnd', () => {
    it('reorders favorites when dropping an existing favorite item', () => {
      const favList = document.getElementById('favorites-list');
      const renderFavoritesSpy = vi.fn();
      initFavoritesDnd(favList, { renderFavorites: renderFavoritesSpy });

      const item1 = favList.querySelector('.bookmark-item[data-id="fav_1"]');
      const item2 = favList.querySelector('.bookmark-item[data-id="fav_2"]');

      // Start drag fav_1
      const dragStartEvent = new Event('dragstart', { bubbles: true });
      dragStartEvent.dataTransfer = {
        effectAllowed: '',
        setDragImage: vi.fn()
      };
      item1.dispatchEvent(dragStartEvent);

      // Drop on fav_2
      const dropEvent = new Event('drop', { bubbles: true });
      dropEvent.dataTransfer = {
        types: ['text/plain'],
        getData: vi.fn()
      };
      dropEvent.clientX = 500; // insertAfter
      item2.getBoundingClientRect = () => ({ left: 400, width: 100 });
      item2.dispatchEvent(dropEvent);

      expect(appState.favorites[0].id).toBe('fav_2');
      expect(appState.favorites[1].id).toBe('fav_1');
      expect(renderFavoritesSpy).toHaveBeenCalled();
    });
  });
});
