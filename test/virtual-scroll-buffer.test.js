import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { UIManager, uiManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Virtual Scroll Directional Adaptive Buffering (Phase 5)', () => {
  let gridContainer;
  let listContainer;
  let fileListBody;
  let testFiles;

  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="center-top" style="width: 800px; height: 300px; overflow-y: auto;">
        <table id="file-table">
          <tbody id="file-list-body"></tbody>
        </table>
      </div>
      <div id="center-bottom" style="width: 800px; height: 600px; overflow-y: auto;"></div>
      <button id="search-clear-btn" type="button"></button>
      <input type="range" id="thumbnail-size-slider" min="100" max="500" value="120" />
    `;

    gridContainer = document.getElementById('center-bottom');
    listContainer = document.getElementById('center-top');
    fileListBody = document.getElementById('file-list-body');

    uiManager.elements.thumbnailGrid = gridContainer;
    uiManager.elements.fileListBody = fileListBody;
    uiManager.elements.searchClearBtn = document.getElementById('search-clear-btn');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    // 1000アイテムのダミーデータ
    const totalFiles = 1000;
    testFiles = Array.from({ length: totalFiles }, (_, i) => ({
      path: `C:/images/img_${String(i).padStart(4, '0')}.png`,
      name: `img_${String(i).padStart(4, '0')}.png`,
      mtime: 1000 + i,
      size: 1024 * (i + 1),
      hasThumbnailCache: true
    }));

    appState.totalCount = totalFiles;
    appState.searchQuery = '';
    appState.ratingFilterVal = 0;

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => {
        return Promise.resolve(testFiles.slice(offset, offset + limit));
      })
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('グリッドビュー（updateVirtualGrid）の進行方向適応型バッファ', () => {
    it('初回描画時（初期下スクロール方向）は進行方向適応型（上4行 / 下12行）のバッファで算出されること', async () => {
      // clientWidth: 648 -> cols = 5, itemSize: 120, gap: 8 -> rowHeight = 128
      Object.defineProperty(gridContainer, 'clientWidth', { value: 648, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 384, configurable: true }); // visibleRowCount = 3
      Object.defineProperty(gridContainer, 'scrollTop', { value: 2568, writable: true, configurable: true }); // startRow = 20

      uiManager._lastScrollTop = undefined;

      await uiManager.updateVirtualGrid(true);

      // 初期状態（down進行方向デフォルト）: bufferBefore = 4, bufferAfter = 12
      // startRow = 20
      // safeStartRow = 20 - 4 = 16 -> startIndex = 16 * 5 = 80
      // visibleEndRow = 20 + 3 = 23 -> endRow = 23 + 12 = 35 -> endIndex = ((35 + 1) * 5) - 1 = 179
      expect(uiManager.lastGridStartIndex).toBe(80);
      expect(uiManager.lastGridEndIndex).toBe(179);
    });

    it('下スクロール時（down）は、上側バッファ4行・下側バッファ12行と進行方向が厚く配分されること', async () => {
      Object.defineProperty(gridContainer, 'clientWidth', { value: 648, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 384, configurable: true }); // visibleRowCount = 3

      // 前回位置: 1288px (startRow = 10)
      uiManager._lastScrollTop = 1288;
      // 今回位置: 2568px (startRow = 20) -> 下スクロール (scrollTop > _lastScrollTop)
      Object.defineProperty(gridContainer, 'scrollTop', { value: 2568, writable: true, configurable: true });

      await uiManager.updateVirtualGrid(true);

      expect(uiManager.scrollDirection).toBe('down');

      // 下スクロール時: bufferBefore = 4, bufferAfter = 12
      // startRow = 20
      // safeStartRow = 20 - 4 = 16 -> startIndex = 16 * 5 = 80
      // visibleEndRow = 20 + 3 = 23 -> endRow = 23 + 12 = 35 -> endIndex = ((35 + 1) * 5) - 1 = 179
      expect(uiManager.lastGridStartIndex).toBe(80);
      expect(uiManager.lastGridEndIndex).toBe(179);
    });

    it('上スクロール時（up）は、上側バッファ12行・下側バッファ4行と進行方向が厚く配分されること', async () => {
      Object.defineProperty(gridContainer, 'clientWidth', { value: 648, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 384, configurable: true }); // visibleRowCount = 3

      // 前回位置: 3848px (startRow = 30)
      uiManager._lastScrollTop = 3848;
      // 今回位置: 2568px (startRow = 20) -> 上スクロール (scrollTop < _lastScrollTop)
      Object.defineProperty(gridContainer, 'scrollTop', { value: 2568, writable: true, configurable: true });

      await uiManager.updateVirtualGrid(true);

      expect(uiManager.scrollDirection).toBe('up');

      // 上スクロール時: bufferBefore = 12, bufferAfter = 4
      // startRow = 20
      // safeStartRow = 20 - 12 = 8 -> startIndex = 8 * 5 = 40
      // visibleEndRow = 20 + 3 = 23 -> endRow = 23 + 4 = 27 -> endIndex = ((27 + 1) * 5) - 1 = 139
      expect(uiManager.lastGridStartIndex).toBe(40);
      expect(uiManager.lastGridEndIndex).toBe(139);
    });
  });

  describe('リストビュー（updateVirtualList）の進行方向適応型バッファ', () => {
    it('初回描画時（初期下スクロール方向）は進行方向適応型（上5行 / 下15行）のバッファで算出されること', async () => {
      Object.defineProperty(listContainer, 'clientHeight', { value: 280, configurable: true }); // rowHeight = 28 -> visible = 10行
      Object.defineProperty(listContainer, 'scrollTop', { value: 1400, writable: true, configurable: true }); // startRow = 50

      uiManager._lastListScrollTop = undefined;

      await uiManager.updateVirtualList(true);

      // 初期状態（down進行方向デフォルト）: listBufferBefore = 5, listBufferAfter = 15
      // startRow = 50
      // safeStartRow = 50 - 5 = 45
      // endRow = 50 + 10 + 15 = 75
      expect(uiManager.lastListStartIndex).toBe(45);
      expect(uiManager.lastListEndIndex).toBe(75);
    });

    it('下スクロール時（down）は、上側バッファ5行・下側バッファ15行と進行方向が厚く配分されること', async () => {
      Object.defineProperty(listContainer, 'clientHeight', { value: 280, configurable: true });

      // 前回位置: 700px (startRow = 25)
      uiManager._lastListScrollTop = 700;
      // 今回位置: 1400px (startRow = 50) -> 下スクロール
      Object.defineProperty(listContainer, 'scrollTop', { value: 1400, writable: true, configurable: true });

      await uiManager.updateVirtualList(true);

      expect(uiManager.listScrollDirection).toBe('down');

      // 下スクロール時: listBufferBefore = 5, listBufferAfter = 15
      // startRow = 50
      // safeStartRow = 50 - 5 = 45
      // endRow = 50 + 10 + 15 = 75
      expect(uiManager.lastListStartIndex).toBe(45);
      expect(uiManager.lastListEndIndex).toBe(75);
    });

    it('上スクロール時（up）は、上側バッファ15行・下側バッファ5行と進行方向が厚く配分されること', async () => {
      Object.defineProperty(listContainer, 'clientHeight', { value: 280, configurable: true });

      // 前回位置: 2100px (startRow = 75)
      uiManager._lastListScrollTop = 2100;
      // 今回位置: 1400px (startRow = 50) -> 上スクロール
      Object.defineProperty(listContainer, 'scrollTop', { value: 1400, writable: true, configurable: true });

      await uiManager.updateVirtualList(true);

      expect(uiManager.listScrollDirection).toBe('up');

      // 上スクロール時: listBufferBefore = 15, listBufferAfter = 5
      // startRow = 50
      // safeStartRow = 50 - 15 = 35
      // endRow = 50 + 10 + 5 = 65
      expect(uiManager.lastListStartIndex).toBe(35);
      expect(uiManager.lastListEndIndex).toBe(65);
    });
  });
});
