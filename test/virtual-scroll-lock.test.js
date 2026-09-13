import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { UIManager } from '../src/renderer-ui.js';
import { appState } from '../src/renderer-state.js';

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
});
