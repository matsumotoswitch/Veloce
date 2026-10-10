import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UIManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Virtual Scroll Search & Filter Clamping', () => {
  let rafSpy;
  let getElementByIdSpy;

  beforeEach(() => {
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(cb, 0));
    getElementByIdSpy = vi.spyOn(document, 'getElementById').mockReturnValue(document.createElement('div'));
  });

  afterEach(() => {
    rafSpy.mockRestore();
    getElementByIdSpy.mockRestore();
  });

  it('updateVirtualGrid clamps scrollTop and renders items correctly when totalCount drops below current scroll position', async () => {
    // 100アイテム時の下部スクロール（例: scrollTop = 2000px）からフィルタにより3アイテムに減少したケース
    appState.totalCount = 3;
    appState.selection = new Set();
    appState.thumbnailUrls = new Map();
    appState.ratings = {};
    appState.initialChunk = null;
    appState.savedScrollTopGrid = 0;

    const mockItems = [
      { path: 'C:/img_0.png', name: 'img_0.png', mtime: 1000, hasThumbnailCache: true },
      { path: 'C:/img_1.png', name: 'img_1.png', mtime: 1000, hasThumbnailCache: true },
      { path: 'C:/img_2.png', name: 'img_2.png', mtime: 1000, hasThumbnailCache: true }
    ];

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((start, count) => {
        return Promise.resolve(mockItems.slice(start, start + count));
      })
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    
    // スクロール位置が下部（2000px）に残っている状態
    let currentScroll = 2000;
    Object.defineProperty(container, 'scrollTop', {
      get() { return currentScroll; },
      set(val) { currentScroll = val; },
      configurable: true
    });

    ui.elements.thumbnailGrid = container;
    ui.elements.thumbnailSizeSlider = { value: '120' };

    await ui.updateVirtualGrid(true);

    // 最大スクロール位置（3アイテムなら全高 < コンテナ高なので 0px）に安全にクランプされること
    expect(container.scrollTop).toBe(0);

    // 取得APIが正しく 0 番目から呼ばれ、負のインデックスや逆転がないこと
    expect(window.veloceAPI.getItems).toHaveBeenCalled();
    const calls = window.veloceAPI.getItems.mock.calls;
    const [startArg, countArg] = calls[0];
    expect(startArg).toBe(0);
    expect(countArg).toBeGreaterThanOrEqual(3);

    // DOM要素が正しく生成・表示されていること
    const content = container.querySelector('.virtual-content');
    expect(content).not.toBeNull();
    const visibleChildren = Array.from(content.children).filter(el => el.style.display !== 'none');
    expect(visibleChildren.length).toBe(3);
    expect(visibleChildren[0].dataset.filepath).toBe('C:/img_0.png');
  });

  it('updateVirtualList clamps scrollTop and renders table rows correctly when totalCount drops below current scroll position', async () => {
    // テーブルリスト表示で、スクロール位置が下部にある状態でアイテム数が減少したケース
    appState.totalCount = 2;
    appState.selection = new Set();
    appState.ratings = {};
    appState.initialChunk = null;
    appState.savedScrollTopList = 0;

    const mockItems = [
      { path: 'C:/file_0.png', name: 'file_0.png', size: 1024, mtime: 1000 },
      { path: 'C:/file_1.png', name: 'file_1.png', size: 2048, mtime: 1000 }
    ];

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((start, count) => {
        return Promise.resolve(mockItems.slice(start, start + count));
      })
    };

    const ui = new UIManager(appState);
    const container = document.createElement('div');
    container.id = 'center-top';
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    let currentScroll = 1500;
    Object.defineProperty(container, 'scrollTop', {
      get() { return currentScroll; },
      set(val) { currentScroll = val; },
      configurable: true
    });

    const tbody = document.createElement('tbody');
    tbody.id = 'file-list-body';
    ui.elements.fileListBody = tbody;

    // getElementById の差し替え
    getElementByIdSpy.mockImplementation((id) => {
      if (id === 'center-top') return container;
      if (id === 'file-list-body') return tbody;
      return document.createElement('div');
    });

    await ui.updateVirtualList(true);

    // 最大スクロール位置（2行 = 56px < 400px なので 0px）に安全にクランプされること
    expect(container.scrollTop).toBe(0);

    expect(window.veloceAPI.getItems).toHaveBeenCalled();
    const calls = window.veloceAPI.getItems.mock.calls;
    const [startArg, countArg] = calls[0];
    expect(startArg).toBe(0);
    expect(countArg).toBeGreaterThanOrEqual(2);

    // 上下スペーサー行 + 2つのアイテム行が正しく描画されること
    const rows = tbody.querySelectorAll('.list-item-row');
    expect(rows.length).toBe(2);
  });

  it('renderAll with resetScroll = true clears saved scroll tops and resets container scroll to 0', async () => {
    appState.totalCount = 10;
    appState.savedScrollTopGrid = 500;
    appState.savedScrollTopList = 300;

    const ui = new UIManager(appState);

    const gridContainer = document.createElement('div');
    gridContainer.id = 'center-bottom';
    let gridScroll = 500;
    Object.defineProperty(gridContainer, 'scrollTop', {
      get() { return gridScroll; },
      set(val) { gridScroll = val; },
      configurable: true
    });

    const listContainer = document.createElement('div');
    listContainer.id = 'center-top';
    let listScroll = 300;
    Object.defineProperty(listContainer, 'scrollTop', {
      get() { return listScroll; },
      set(val) { listScroll = val; },
      configurable: true
    });

    const tbody = document.createElement('tbody');
    tbody.id = 'file-list-body';

    ui.elements.thumbnailGrid = gridContainer;
    ui.elements.fileListBody = tbody;

    getElementByIdSpy.mockImplementation((id) => {
      if (id === 'center-bottom') return gridContainer;
      if (id === 'center-top') return listContainer;
      if (id === 'file-list-body') return tbody;
      return document.createElement('div');
    });

    window.veloceAPI = {
      getItems: vi.fn().mockResolvedValue([])
    };

    await ui.renderAll(true);

    expect(gridContainer.scrollTop).toBe(0);
    expect(listContainer.scrollTop).toBe(0);
    expect(appState.savedScrollTopGrid).toBe(0);
    expect(appState.savedScrollTopList).toBe(0);
  });
});
