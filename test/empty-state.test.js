import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { UIManager, uiManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Empty State Recovery UI (Phase 3)', () => {
  let gridContainer;
  let searchClearBtn;

  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="center-bottom" style="width: 800px; height: 600px;"></div>
      <button id="search-clear-btn" type="button"></button>
      <input type="range" id="thumbnail-size-slider" value="120" />
    `;

    gridContainer = document.getElementById('center-bottom');
    searchClearBtn = document.getElementById('search-clear-btn');

    uiManager.elements.thumbnailGrid = gridContainer;
    uiManager.elements.searchClearBtn = searchClearBtn;
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    appState.totalCount = 0;
    appState.searchQuery = '';
    appState.ratingFilterVal = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('検索クエリが存在し結果が0件の場合、クリアボタンとキーボード案内が描画されること', async () => {
    appState.totalCount = 0;
    appState.searchQuery = 'novelai';

    await uiManager.updateVirtualGrid(true);

    const emptyContainer = gridContainer.querySelector('.empty-state-container');
    expect(emptyContainer).not.toBeNull();
    expect(emptyContainer.style.display).toBe('flex');
    expect(emptyContainer.dataset.mode).toBe('search');

    const clearBtn = emptyContainer.querySelector('.empty-state-clear-btn');
    expect(clearBtn).not.toBeNull();
    expect(clearBtn.textContent).toBe('検索条件をクリア');

    const hint = emptyContainer.querySelector('.empty-state-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain('Escape');
  });

  it('レーティングフィルターが適用され結果が0件の場合も、クリアボタンが描画されること', async () => {
    appState.totalCount = 0;
    appState.searchQuery = '';
    appState.ratingFilterVal = 4; // 星4以上で絞り込み

    await uiManager.updateVirtualGrid(true);

    const emptyContainer = gridContainer.querySelector('.empty-state-container');
    expect(emptyContainer).not.toBeNull();
    expect(emptyContainer.dataset.mode).toBe('search');

    const clearBtn = emptyContainer.querySelector('.empty-state-clear-btn');
    expect(clearBtn).not.toBeNull();
  });

  it('通常のフォルダが空の場合（検索やフィルターなし）はクリアボタンが表示されないこと', async () => {
    appState.totalCount = 0;
    appState.searchQuery = '';
    appState.ratingFilterVal = 0;

    await uiManager.updateVirtualGrid(true);

    const emptyContainer = gridContainer.querySelector('.empty-state-container');
    expect(emptyContainer).not.toBeNull();
    expect(emptyContainer.style.display).toBe('flex');
    expect(emptyContainer.dataset.mode).toBe('folder');

    const clearBtn = emptyContainer.querySelector('.empty-state-clear-btn');
    expect(clearBtn).toBeNull();

    const text = emptyContainer.querySelector('.empty-state-text');
    expect(text.textContent).toBe('このフォルダには画像がありません');
  });

  it('クリアボタンをクリックした際、検索クリアボタン（searchClearBtn）のclickイベントが発火すること', async () => {
    appState.totalCount = 0;
    appState.searchQuery = 'cat';

    await uiManager.updateVirtualGrid(true);

    const clearSpy = vi.fn();
    searchClearBtn.addEventListener('click', clearSpy);

    const clearBtn = gridContainer.querySelector('.empty-state-clear-btn');
    expect(clearBtn).not.toBeNull();

    clearBtn.click();

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
