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

    // Mock elements inside to simulate rows and thumbs
    for (let i = 0; i < 5; i++) {
        const tr = document.createElement('tr');
        tr.dataset.index = i.toString();
        fileListBody.appendChild(tr);

        const thumb = document.createElement('div');
        thumb.className = 'thumbnail-item';
        thumb.dataset.index = i.toString();
        thumbnailGrid.appendChild(thumb);
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
});
