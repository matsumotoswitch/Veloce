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
} from '../src/renderer-dnd.js';
import { appState } from '../src/renderer-state.js';

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
