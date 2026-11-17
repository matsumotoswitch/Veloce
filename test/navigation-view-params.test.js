import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import { initTabHandlers } from '../src/renderer/renderer-tabs.js';
import { initFolderTree, handleTreeNavigation } from '../src/renderer/renderer-folder-tree.js';

describe('Navigation ViewParams Optimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="dir-tree"></div>
      <div id="file-table"><tbody></tbody></div>
      <div id="grid-container"></div>
      <div id="tab-bar"></div>
    `;

    window.veloceAPI = {
      loadDirectory: vi.fn().mockResolvedValue(undefined),
      setViewParams: vi.fn().mockResolvedValue(10),
      getFolders: vi.fn().mockResolvedValue([])
    };

    uiManager.renderTabs = vi.fn();
    uiManager.renderAll = vi.fn();
    uiManager.updateSelectionUI = vi.fn();
    uiManager.showToast = vi.fn();
    uiManager.elements = {
      dirTree: document.getElementById('dir-tree'),
      thumbnailGrid: document.getElementById('grid-container')
    };

    appState.tabs = [
      { path: 'C:\\dir1', name: 'dir1', scrollTop: 0, sortConfig: { key: 'name', asc: true } },
      { path: 'C:\\dir2', name: 'dir2', scrollTop: 0, sortConfig: { key: 'size', asc: false } }
    ];
    appState.activeTabIndex = 0;
    appState.currentDirectory = 'C:\\dir1';
    appState.sortConfig = { key: 'name', asc: true };
    appState.searchQuery = '';
    appState.ratingFilterVal = 0;
    appState.ratingFilterOp = 'gte';

    initTabHandlers({
      appState,
      uiManager,
      expandTreeToPath: vi.fn(),
      clearMetadataUI: vi.fn(),
      updateNavButtons: vi.fn(),
      updateSortIndicators: vi.fn()
    });
  });

  it('タブ切り替え (onTabClick) では loadDirectory 直前の setViewParams が skipSort = true で1回だけ呼ばれること', async () => {
    await window.onTabClick(1);

    expect(window.veloceAPI.setViewParams).toHaveBeenCalledTimes(1);
    expect(window.veloceAPI.setViewParams).toHaveBeenCalledWith('size', false, '', 0, 'gte', true);
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:\\dir2');
  });

  it('通常操作 (appState.setViewParams) はデフォルトで skipSort = false (再ソートあり) で呼ばれること', async () => {
    await appState.setViewParams();

    expect(window.veloceAPI.setViewParams).toHaveBeenCalledTimes(1);
    expect(window.veloceAPI.setViewParams).toHaveBeenCalledWith('name', true, '', 0, 'gte', false);
  });

  it('ツリーキー移動等の selectItem では事前 setViewParams を呼ばず、refreshFileList 側の1回に集約されること', async () => {
    global.CSS = window.CSS || { escape: (s) => s.replace(/([\\:])/g, '\\$1') };
    const refreshFileListMock = vi.fn();
    const treeContainer = document.getElementById('dir-tree');
    treeContainer.innerHTML = `
      <ul>
        <li><div class="tree-item selected" data-path="C:\\dir1"><span class="tree-label">dir1</span></div></li>
        <li><div class="tree-item" data-path="C:\\dir2"><span class="tree-label">dir2</span></div></li>
      </ul>
    `;

    initFolderTree({
      getTabNameForPath: () => 'dir2',
      refreshFileList: refreshFileListMock,
      saveTabsState: vi.fn(),
      expandTreeToPath: vi.fn()
    });

    await handleTreeNavigation('ArrowDown');

    // ツリーキーナビゲーションによって直接 setViewParams は呼ばれず、refreshFileList の呼び出しのみが行われること
    expect(window.veloceAPI.setViewParams).not.toHaveBeenCalled();
    expect(refreshFileListMock).toHaveBeenCalledWith(true);
  });
});
