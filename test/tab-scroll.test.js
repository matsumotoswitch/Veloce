import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initTabHandlers, saveTabsState } from '../src/renderer-tabs.js';
import * as rendererTabs from '../src/renderer-tabs.js';

describe('Tab Scroll Position Retention', () => {
  let appState;
  let uiManager;
  let ctx;

  beforeEach(() => {
    appState = {
      tabs: [
        { id: 'tab1', path: 'C:/folder1', name: 'folder1', scrollTop: 100 },
        { id: 'tab2', path: 'C:/folder2', name: 'folder2', scrollTop: 250 },
        { id: 'tab3', path: 'C:/folder3', name: 'folder3', scrollTop: 0 }
      ],
      activeTabIndex: 0,
      currentDirectory: 'C:/folder1',
      searchQuery: '',
      sortConfig: null,
      selection: new Set(),
      savedScrollTopGrid: 0
    };

    uiManager = {
      elements: {
        thumbnailGrid: { scrollTop: 100 },
        searchBar: { value: '' }
      },
      renderTabs: vi.fn(),
      renderAll: vi.fn(),
      showToast: vi.fn(),
      showMissingFolderDialog: vi.fn().mockResolvedValue('close')
    };

    ctx = {
      appState,
      uiManager,
      expandTreeToPath: vi.fn().mockResolvedValue(true),
      clearMetadataUI: vi.fn(),
      updateNavButtons: vi.fn(),
      updateSortIndicators: vi.fn()
    };

    // Mock dependencies inside renderer-tabs.js
    window.veloceAPI = {
      loadDirectory: vi.fn()
    };
    
    // Mock checkPathExists from path-utils
    vi.mock('../src/path-utils.js', () => ({
      checkPathExists: vi.fn().mockResolvedValue(true)
    }));

    initTabHandlers(ctx);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should set appState.savedScrollTopGrid to the new tab scrollTop on tab click', async () => {
    // Current tab is tab 0 (scrollTop 100). Click tab 1 (scrollTop 250)
    await window.onTabClick(1);

    expect(appState.activeTabIndex).toBe(1);
    expect(appState.savedScrollTopGrid).toBe(250);
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:/folder2');
  });

  it('should fallback to 0 if new tab has no scrollTop', async () => {
    // Current tab is tab 0. Click tab 2 (scrollTop 0)
    await window.onTabClick(2);

    expect(appState.activeTabIndex).toBe(2);
    expect(appState.savedScrollTopGrid).toBe(0);
  });

  it('should set appState.savedScrollTopGrid to the adjacent tab scrollTop on tab close', async () => {
    // Current tab is tab 1. Close tab 1. Should switch to tab 0 (scrollTop 100).
    appState.activeTabIndex = 1;

    // mock setTimeout for onTabClose animation
    vi.useFakeTimers();

    await window.onTabClose(1);
    
    // Fast-forward setTimeout
    vi.runAllTimers();

    expect(appState.activeTabIndex).toBe(0); // Switches to previous tab
    expect(appState.savedScrollTopGrid).toBe(100);
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:/folder1');
    
    vi.useRealTimers();
  });
});
