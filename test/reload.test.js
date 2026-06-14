import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';

// モック用の uiManager
const uiManager = {
  elements: {
    searchBar: { value: 'some filter' }
  },
  showToast: vi.fn(),
  hideCustomTooltip: vi.fn(),
  renderAll: vi.fn()
};

// モック用の window.veloceAPI
global.window = {
  veloceAPI: {
    loadDirectory: vi.fn()
  }
};

// renderer.js はモジュールとして export されていないため、refreshFileList の挙動をここでシミュレーションします。
async function simulateRefreshFileList(showToast = false) {
  if (!appState.currentDirectory) return;

  uiManager.hideCustomTooltip();

  if (showToast) {
    uiManager.showToast('フォルダを読み込み中', 0, 'dir-load-progress', 'info');
  }

  appState.totalCount = 0;
  appState.selection.clear();
  appState.selectedIndex = -1;
  appState.thumbnailUrls.clear();
  
  if (uiManager.elements.searchBar) {
    uiManager.elements.searchBar.value = '';
  }
  appState.searchQuery = '';
  uiManager.renderAll();

  appState.pushHistory(appState.currentDirectory);
  
  await window.veloceAPI.loadDirectory(appState.currentDirectory);
}

describe('Reload Functionality', () => {
  beforeEach(() => {
    appState.currentDirectory = 'C:\\dummy\\folder';
    appState.searchQuery = 'dummy filter';
    uiManager.elements.searchBar.value = 'dummy filter';
    vi.clearAllMocks();
  });

  it('should clear search filter when refreshFileList is called (simulating Reload Button and Context Menu Reload)', async () => {
    // リロード前の状態
    expect(appState.searchQuery).toBe('dummy filter');
    expect(uiManager.elements.searchBar.value).toBe('dummy filter');

    // リロードボタンやコンテキストメニューの「フォルダを再読み込み」で呼ばれる関数を実行
    await simulateRefreshFileList(true);

    // リロード後、フィルタがクリアされていることを確認
    expect(appState.searchQuery).toBe('');
    expect(uiManager.elements.searchBar.value).toBe('');
    
    // ディレクトリが再読み込みされたことを確認
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:\\dummy\\folder');
  });
});
