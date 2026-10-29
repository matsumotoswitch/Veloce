import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { UIManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('UIManager._runWithUpdateLock', () => {
  let rafSpy;
  let getElementByIdSpy;

  beforeEach(() => {
    // requestAnimationFrame を setTimeout でモック化
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(cb, 0));
    // UIManager はコンストラクタで document.getElementById などを呼ぶためモック化
    getElementByIdSpy = vi.spyOn(document, 'getElementById').mockReturnValue(document.createElement('div'));
  });

  afterEach(() => {
    rafSpy.mockRestore();
    getElementByIdSpy.mockRestore();
  });

  it('非同期処理が重複して呼ばれた場合、同時実行を防ぎ、かつキューイングして後で1度だけ再実行する', async () => {
    const dummyAppState = { ratings: {} };
    const ui = new UIManager(dummyAppState);

    let executionCount = 0;
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const taskFn = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      executionCount++;
      
      // 非同期タスクのシミュレーション（10ms待機）
      await new Promise(resolve => setTimeout(resolve, 10));
      
      concurrentCount--;
    };

    // 同時に3回呼び出す（マウスホイールの2ノッチ以上の連続スクロールをシミュレート）
    ui._runWithUpdateLock('testLock', taskFn);
    ui._runWithUpdateLock('testLock', taskFn);
    ui._runWithUpdateLock('testLock', taskFn);

    // 全ての非同期タスクがキューイングも含めて終わるまで十分に待機する
    await new Promise(resolve => setTimeout(resolve, 100));

    // 同時実行は必ず1つのみ（排他制御が働いている）
    expect(maxConcurrent).toBe(1); 
    
    // 3回の呼び出しでも、実行中のものはブロックされ、最後の「再実行フラグ」により1度だけ追加実行される。
    // よって、実際の実行回数は「最初の1回」＋「キューイングされた1回」＝ 2回となる。
    expect(executionCount).toBe(2); 
  });
});

describe('Virtual Scroll Reflow Optimization', () => {
  it('updateVirtualGrid should not trigger offsetHeight during steady scroll without DOM structure changes', async () => {
    appState.totalCount = 100;
    appState.selection = new Set();
    appState.thumbnailUrls = new Map();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = null;
    appState.savedScrollTopGrid = 0;

    window.veloceAPI = {
      getItems: vi.fn().mockResolvedValue(
        Array.from({ length: 60 }, (_, i) => ({
          path: `C:/img_${i}.png`,
          name: `img_${i}.png`,
          mtime: 1000,
          hasThumbnailCache: true
        }))
      )
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'grid-view';
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    ui.elements.thumbnailGrid = container;
    ui.elements.thumbnailSizeSlider = { value: '180' };

    let offsetHeightAccessCount = 0;
    const originalDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get() {
        offsetHeightAccessCount++;
        return 600;
      },
      configurable: true
    });

    try {
      // 1回目の描画（初期構築: domStructureChanged = true となり offsetHeight が呼ばれる）
      await ui.updateVirtualGrid(false);
      expect(offsetHeightAccessCount).toBeGreaterThanOrEqual(1);

      // 2回目の描画（同じ要素数・同じdisplay状態での安定スクロール）
      container.scrollTop = 50;
      const countBefore = offsetHeightAccessCount;

      await ui.updateVirtualGrid(false);

      // 通常のスクロール中（DOM増減や表示切替なし）では offsetHeight へのアクセスがスキップされること
      expect(offsetHeightAccessCount).toBe(countBefore);
    } finally {
      if (originalDesc) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalDesc);
      }
    }
  });

  it('updateVirtualList should only access tbody.offsetHeight when savedScrollTopList is pending', async () => {
    appState.totalCount = 50;
    appState.selection = new Set();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = null;
    appState.savedScrollTopList = 0;

    window.veloceAPI = {
      getItems: vi.fn().mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({
          path: `C:/file_${i}.png`,
          name: `file_${i}.png`,
          ext: '.png',
          size: 1024,
          mtime: 1000
        }))
      )
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-top';
    Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);

    ui.elements.fileListBody = tbody;

    const originalGetElementById = document.getElementById;
    document.getElementById = (id) => {
      if (id === 'center-top') return container;
      return originalGetElementById.call(document, id);
    };

    let tbodyOffsetHeightCount = 0;
    const originalDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(tbody, 'offsetHeight', {
      get() {
        tbodyOffsetHeightCount++;
        return 500;
      },
      configurable: true
    });

    try {
      // 1回目描画
      await ui.updateVirtualList(true);

      // savedScrollTopList = 0 の通常スクロール時: offsetHeight にアクセスしないこと
      tbodyOffsetHeightCount = 0;
      appState.savedScrollTopList = 0;
      container.scrollTop = 100;
      await ui.updateVirtualList(false);
      expect(tbodyOffsetHeightCount).toBe(0);

      // savedScrollTopList = 250 の位置復元時: offsetHeight にアクセスして同期レイアウトを確定すること
      appState.savedScrollTopList = 250;
      await ui.updateVirtualList(false);
      expect(tbodyOffsetHeightCount).toBe(1);
      expect(container.scrollTop).toBe(250);
      expect(appState.savedScrollTopList).toBe(0);
    } finally {
      document.getElementById = originalGetElementById;
      if (originalDesc) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalDesc);
      }
    }
  });

  it('updateVirtualList should synchronize appState.visiblePathSet with visible items in list mode', async () => {
    appState.totalCount = 30;
    appState.selection = new Set();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = null;
    appState.savedScrollTopList = 0;
    appState.visiblePathSet = new Set();

    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `C:/files/list_file_${i}.png`,
      name: `list_file_${i}.png`,
      ext: '.png',
      size: 2048,
      mtime: 2000
    }));

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => Promise.resolve(files.slice(offset, offset + limit)))
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-top';
    Object.defineProperty(container, 'clientHeight', { value: 280, configurable: true }); // ~10 rows visible
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);

    ui.elements.fileListBody = tbody;

    const originalGetElementById = document.getElementById;
    document.getElementById = (id) => {
      if (id === 'center-top') return container;
      return originalGetElementById.call(document, id);
    };

    try {
      const initialSetInstance = appState.visiblePathSet;
      await ui.updateVirtualList(true);

      expect(appState.visiblePathSet).toBeInstanceOf(Set);
      expect(appState.visiblePathSet.size).toBeGreaterThan(0);
      expect(appState.visiblePathSet.has('C:/files/list_file_0.png')).toBe(true);

      // 既存の Set インスタンスが再利用され、オブジェクト再生成（GC圧）が発生しないこと
      expect(appState.visiblePathSet).toBe(initialSetInstance);

      // スクロール位置が更新されて再描画された際も同一インスタンス参照が維持されること
      container.scrollTop = 56;
      await ui.updateVirtualList();
      expect(appState.visiblePathSet).toBe(initialSetInstance);

      // totalCount が 0 になったとき、同一インスタンスがクリアされること
      appState.totalCount = 0;
      await ui.updateVirtualList(true);
      expect(appState.visiblePathSet).toBe(initialSetInstance);
      expect(appState.visiblePathSet.size).toBe(0);
    } finally {
      document.getElementById = originalGetElementById;
    }
  });

  it('updateVirtualGrid should reuse the same appState.visiblePathSet instance across scroll cycles', async () => {
    appState.totalCount = 30;
    appState.selection = new Set();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = null;
    const initialSetInstance = new Set();
    appState.visiblePathSet = initialSetInstance;

    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `C:/files/grid_file_${i}.png`,
      name: `grid_file_${i}.png`,
      ext: '.png',
      size: 2048,
      mtime: 2000
    }));

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => Promise.resolve(files.slice(offset, offset + limit)))
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    const content = document.createElement('div');
    content.className = 'virtual-content';
    const spacer = document.createElement('div');
    spacer.className = 'virtual-spacer';
    container.appendChild(content);
    container.appendChild(spacer);

    ui.elements.thumbnailGrid = container;

    const originalGetElementById = document.getElementById;
    document.getElementById = (id) => {
      if (id === 'center-bottom') return container;
      return originalGetElementById.call(document, id);
    };

    try {
      ui.updateVirtualGrid(true);

      // 初期同期後、同一インスタンスが維持されていること
      expect(appState.visiblePathSet).toBe(initialSetInstance);

      // totalCount が 0 の場合も同一インスタンスが clear されること
      appState.totalCount = 0;
      ui.updateVirtualGrid(true);
      expect(appState.visiblePathSet).toBe(initialSetInstance);
      expect(appState.visiblePathSet.size).toBe(0);
    } finally {
      document.getElementById = originalGetElementById;
    }
  });
});

describe('Sliding-Window Item Cache & Thumbnail Pipeline Optimizations', () => {
  it('resolves items synchronously from _itemWindowCache across multiple row scrolls without redundant getItems IPC calls', async () => {
    const totalCount = 300;
    const files = Array.from({ length: totalCount }, (_, i) => ({
      path: `C:/files/win_file_${i}.png`,
      name: `win_file_${i}.png`,
      ext: '.png',
      size: 2048,
      mtime: 2000,
      hasThumbnailCache: true
    }));

    appState.totalCount = totalCount;
    appState.selection = new Set();
    appState.thumbnailUrls = new Map();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = null;
    appState.savedScrollTopGrid = 0;

    const getItemsMock = vi.fn().mockImplementation((offset, limit) => {
      return Promise.resolve(files.slice(offset, offset + limit));
    });
    window.veloceAPI = { getItems: getItemsMock };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    ui.elements.thumbnailGrid = container;
    ui.elements.thumbnailSizeSlider = { value: '120' };

    // 初回描画: キャッシュミスのため 1 回だけ getItems が呼ばれ、ウィンドウキャッシュが構築される
    await ui.updateVirtualGrid(true);
    expect(getItemsMock).toHaveBeenCalledTimes(1);

    // 連続スクロール（行が変化する複数の scrollTop 遷移）: 全てキャッシュ範囲内のため getItems は追加呼び出しされない
    container.scrollTop = 256;
    await ui.updateVirtualGrid(false);
    container.scrollTop = 512;
    await ui.updateVirtualGrid(false);
    container.scrollTop = 1024;
    await ui.updateVirtualGrid(false);

    expect(getItemsMock).toHaveBeenCalledTimes(1);

    // invalidateItemWindowCache 呼び出し後は次回描画で再取得されること
    ui.invalidateItemWindowCache();
    await ui.updateVirtualGrid(true);
    expect(getItemsMock).toHaveBeenCalledTimes(2);
  });

  it('seeds _itemWindowCache from appState.initialChunk in renderAll and updates dimensions in cache', async () => {
    const chunkFiles = Array.from({ length: 150 }, (_, i) => ({
      path: `C:/files/seed_${i}.png`,
      name: `seed_${i}.png`,
      ext: '.png',
      width: 0,
      height: 0,
      size: 1024,
      mtime: 1000,
      hasThumbnailCache: true
    }));

    appState.totalCount = 150;
    appState.selection = new Set();
    appState.thumbnailUrls = new Map();
    appState.ratings = {};
    appState.dragState = { isAppDragging: false };
    appState.initialChunk = chunkFiles;

    const getItemsMock = vi.fn().mockResolvedValue([]);
    window.veloceAPI = { getItems: getItemsMock };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

    const listContainer = document.createElement('div');
    listContainer.id = 'center-top';
    Object.defineProperty(listContainer, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(listContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

    const tbody = document.createElement('tbody');
    tbody.id = 'file-list-body';
    listContainer.appendChild(tbody);
    document.body.appendChild(listContainer);

    ui.elements.thumbnailGrid = container;
    ui.elements.fileListBody = tbody;
    ui.elements.thumbnailSizeSlider = { value: '120' };

    try {
      await ui.renderAll(true);

      // initialChunk は renderAll 完了後に null クリアされるが、_itemWindowCache には保持される
      expect(appState.initialChunk).toBeNull();
      expect(getItemsMock).not.toHaveBeenCalled();

      // 後続のスクロールでも initialChunk 由来のウィンドウキャッシュから同期解決され IPC が発生しないこと
      container.scrollTop = 1280;
      await ui.updateVirtualGrid(false);
      expect(getItemsMock).not.toHaveBeenCalled();

      // updateFileDimensions がウィンドウキャッシュ内のアイテム寸法も更新すること
      ui.updateFileDimensions('C:/files/seed_10.png', 1024, 1536);
      const cachedItem = ui._itemWindowCache.items.find(f => f.path === 'C:/files/seed_10.png');
      expect(cachedItem.width).toBe(1024);
      expect(cachedItem.height).toBe(1536);
    } finally {
      listContainer.remove();
    }
  });

  it('excludes invisible img.thumbnail-img.loading from CSS shimmer animation and uses a thread pool in server.rs', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const thumbCss = fs.readFileSync(path.resolve(__dirname, '../src/renderer/css/thumbnail.css'), 'utf-8');
    expect(thumbCss).not.toMatch(/\.thumbnail-item\.loading,\s*img\.thumbnail-img\.loading/);
    expect(thumbCss).toMatch(/\.thumbnail-item\.loading\s*\{[\s\S]*?animation:\s*shimmer/);

    const serverRs = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/server.rs'), 'utf-8');
    expect(serverRs).toContain('rayon::ThreadPoolBuilder::new()');
    expect(serverRs).toContain('http_pool.spawn');
    expect(serverRs).toContain('&thumb=1&hash=');
  });
});


