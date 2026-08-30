import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UIManager } from '../src/renderer-ui.js';
import { appState } from '../src/renderer-state.js';

// appState をモックする
vi.mock('../src/renderer-state.js', () => {
  return {
    appState: {
      totalCount: 5,
      imagePaths: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
      selection: new Set(),
      searchQuery: '',
      thumbnailUrls: new Map(),
      dragState: {},
      ratings: {}
    }
  };
});

describe('DOM Pool in updateVirtualGrid', () => {
  let uiManager;
  let container;
  let rafSpy;

  beforeEach(() => {
    // リセット
    appState.totalCount = 5;
    appState.imagePaths = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'];
    appState.selection.clear();
    appState.ratings = {};
    window.veloceAPI = {
      getItems: vi.fn().mockResolvedValue([
        { path: '1.jpg', name: '1.jpg' },
        { path: '2.jpg', name: '2.jpg' },
        { path: '3.jpg', name: '3.jpg' }
      ])
    };

    container = document.createElement('div');
    container.id = 'center-bottom';
    // クライアントサイズをモックして cols=1, rows=5 となるようにする
    Object.defineProperty(container, 'clientWidth', { value: 120, writable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true });
    
    document.body.appendChild(container);

    uiManager = new UIManager(appState);
    uiManager.elements.thumbnailGrid = container;
    uiManager.elements.thumbnailSizeSlider = { value: '120' };

    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => setTimeout(cb, 0));
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('プールに戻される要素の dataset.index がクリアされること', async () => {
    // 初回描画 (5つの要素が必要な状態をシミュレート)
    appState.totalCount = 5;
    uiManager.updateVirtualGrid(true);
    await new Promise(r => setTimeout(r, 50));
    
    const content = container.querySelector('.virtual-content');
    expect(content).not.toBeNull();
    expect(content.children.length).toBeGreaterThan(0);
    
    // 子要素にダミーの dataset.index を設定しておく
    for (let i = 0; i < content.children.length; i++) {
      content.children[i].dataset.index = String(i);
    }
    
    // 描画範囲を狭める（全アイテム数を減らす等して要素をプールに戻す）
    appState.totalCount = 1;
    // 戻り値を絞る
    window.veloceAPI.getItems.mockResolvedValue([{ path: '1.jpg', name: '1.jpg' }]);
    
    uiManager.updateVirtualGrid(true);
    await new Promise(r => setTimeout(r, 50));
    
    // 要素数は減らずに維持される（プール）
    expect(content.children.length).toBeGreaterThan(1);
    
    // 表示されている先頭要素はindexがセットされている
    expect(content.children[0].dataset.index).toBe('0');
    
    // 2番目以降の要素（プールに戻された要素）は display:none になり、indexがクリアされていること
    expect(content.children[1].style.display).toBe('none');
    expect(content.children[1].dataset.index).toBe('');
  });
});
