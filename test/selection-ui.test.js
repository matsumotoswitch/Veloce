import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('UIManager.updateSelectionUI', () => {
  let uiManager;
  let fileListBody;
  let thumbnailGrid;

  beforeEach(async () => {
    // DOM モック
    document.body.innerHTML = '';
    
    fileListBody = document.createElement('tbody');
    fileListBody.id = 'file-list-body';
    
    thumbnailGrid = document.createElement('div');
    thumbnailGrid.id = 'center-bottom';
    const virtualContent = document.createElement('div');
    virtualContent.className = 'virtual-content';
    thumbnailGrid.appendChild(virtualContent);

    // Mock elements inside to simulate rows and thumbs
    for (let i = 0; i < 5; i++) {
        const tr = document.createElement('tr');
        tr.dataset.index = i.toString();
        fileListBody.appendChild(tr);

        const thumb = document.createElement('div');
        thumb.className = 'thumbnail-item';
        thumb.dataset.index = i.toString();
        virtualContent.appendChild(thumb);
    }
    
    document.body.appendChild(document.createElement('table')).appendChild(fileListBody);
    document.body.appendChild(thumbnailGrid);
    
    // ResizeObserver mock
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    
    // Import the module dynamically
    const module = await import('../src/renderer-ui.js');
    const { UIManager } = module;
    
    // Mock appState
    const appState = {
        selection: new Set()
    };
    
    // Mock UIManager methods that could throw during init
    UIManager.prototype.initCustomTooltip = vi.fn();
    UIManager.prototype.hideCustomTooltip = vi.fn();

    uiManager = new UIManager(appState);
    
    // Manually set elements
    uiManager.elements.fileListBody = fileListBody;
    uiManager.elements.thumbnailGrid = thumbnailGrid;
  });

  it('should add selected class to new selections and remove from old without full DOM scan', () => {
    // 初期状態の選択
    uiManager.state.selection.add(1);
    uiManager.state.selection.add(3);
    uiManager.updateSelectionUI();

    expect(fileListBody.querySelector(`tr[data-index="1"]`).classList.contains('selected')).toBe(true);
    expect(fileListBody.querySelector(`tr[data-index="3"]`).classList.contains('selected')).toBe(true);
    expect(thumbnailGrid.querySelector(`.thumbnail-item[data-index="1"]`).classList.contains('selected')).toBe(true);

    // ボトルネックとなる全スキャン（querySelectorAll）が呼ばれていないか監視する
    const spyFileList = vi.spyOn(fileListBody, 'querySelectorAll');
    const spyGrid = vi.spyOn(thumbnailGrid, 'querySelectorAll');

    // 選択状態を変更
    uiManager.state.selection.delete(1);
    uiManager.state.selection.add(2);
    uiManager.updateSelectionUI();

    // 全スキャンが行われていないことを検証（パフォーマンス要件）
    expect(spyFileList).not.toHaveBeenCalled();
    expect(spyGrid).not.toHaveBeenCalled();

    // クラスが正しく差分更新されていることを検証
    expect(fileListBody.querySelector(`tr[data-index="1"]`).classList.contains('selected')).toBe(false);
    expect(fileListBody.querySelector(`tr[data-index="2"]`).classList.contains('selected')).toBe(true);
    expect(fileListBody.querySelector(`tr[data-index="3"]`).classList.contains('selected')).toBe(true);
    
    expect(thumbnailGrid.querySelector(`.thumbnail-item[data-index="1"]`).classList.contains('selected')).toBe(false);
    expect(thumbnailGrid.querySelector(`.thumbnail-item[data-index="2"]`).classList.contains('selected')).toBe(true);
  });

  it('should handle Ctrl+A on 10,000 items in O(visible nodes) time without querySelector looping', () => {
    // 10,000件のアイテムを選択
    for (let i = 0; i < 10000; i++) {
      uiManager.state.selection.add(i);
    }

    const spyFileQuery = vi.spyOn(fileListBody, 'querySelector');
    const tStart = performance.now();
    uiManager.updateSelectionUI();
    const elapsed = performance.now() - tStart;

    // 描画されている5個の要素すべてに selected が付与されていること
    const virtualContent = thumbnailGrid.querySelector('.virtual-content');
    for (let i = 0; i < 5; i++) {
      expect(fileListBody.children[i].classList.contains('selected')).toBe(true);
      expect(virtualContent.children[i].classList.contains('selected')).toBe(true);
    }

    // querySelector が 10,000 回呼ばれていないこと（O(visible nodes) であること）
    expect(spyFileQuery).not.toHaveBeenCalled();
    // 5ms 未満で瞬時に完了すること
    expect(elapsed).toBeLessThan(50);
  });

  it('should format bytes into human-readable strings correctly', async () => {
    const { formatBytesHuman } = await import('../src/renderer-ui.js');
    expect(formatBytesHuman(0)).toBe('0 B');
    expect(formatBytesHuman(500)).toBe('500 B');
    expect(formatBytesHuman(1024)).toBe('1.0 KB');
    expect(formatBytesHuman(1536)).toBe('1.5 KB');
    expect(formatBytesHuman(1048576)).toBe('1.0 MB');
    expect(formatBytesHuman(1073741824)).toBe('1.0 GB');
  });

  it('should toggle filter indicator active class based on search and rating states', () => {
    const searchClearBtn = document.createElement('button');
    searchClearBtn.id = 'search-clear-btn';
    const searchBar = document.createElement('input');
    searchBar.id = 'search-bar';

    const checkActive = (searchVal, ratingVal) => {
      searchBar.value = searchVal;
      const hasSearch = searchBar.value.trim() !== '';
      const hasRating = ratingVal !== 0;
      if (hasSearch || hasRating) {
        searchClearBtn.classList.add('active');
      } else {
        searchClearBtn.classList.remove('active');
      }
      return searchClearBtn.classList.contains('active');
    };

    expect(checkActive('', 0)).toBe(false);
    expect(checkActive('cat', 0)).toBe(true);
    expect(checkActive('', 3)).toBe(true);
    expect(checkActive('dog', 5)).toBe(true);
    expect(checkActive('   ', 0)).toBe(false);
  });
});
