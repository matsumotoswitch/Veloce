import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { initTabHandlers } from '../src/renderer-tabs.js';
import { UIManager } from '../src/renderer-ui.js';
import { appState } from '../src/renderer-state.js';

describe('Tabs Functionality', () => {
  describe('Tab Scroll Position Retention', () => {
    let mockAppState;
    let uiManagerMock;
    let ctx;

    beforeEach(() => {
      mockAppState = {
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

      uiManagerMock = {
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
        appState: mockAppState,
        uiManager: uiManagerMock,
        expandTreeToPath: vi.fn().mockResolvedValue(true),
        clearMetadataUI: vi.fn(),
        updateNavButtons: vi.fn(),
        updateSortIndicators: vi.fn()
      };

      window.veloceAPI = {
        loadDirectory: vi.fn()
      };
      
      vi.mock('../src/path-utils.js', () => ({
        checkPathExists: vi.fn().mockResolvedValue(true)
      }));

      initTabHandlers(ctx);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should set appState.savedScrollTopGrid to the new tab scrollTop on tab click', async () => {
      await window.onTabClick(1);
      expect(mockAppState.activeTabIndex).toBe(1);
      expect(mockAppState.savedScrollTopGrid).toBe(250);
      expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:/folder2');
    });

    it('should fallback to 0 if new tab has no scrollTop', async () => {
      await window.onTabClick(2);
      expect(mockAppState.activeTabIndex).toBe(2);
      expect(mockAppState.savedScrollTopGrid).toBe(0);
    });

    it('should set appState.savedScrollTopGrid to the adjacent tab scrollTop on tab close', async () => {
      mockAppState.activeTabIndex = 1;
      vi.useFakeTimers();
      await window.onTabClose(1);
      vi.runAllTimers();
      expect(mockAppState.activeTabIndex).toBe(0);
      expect(mockAppState.savedScrollTopGrid).toBe(100);
      expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:/folder1');
      vi.useRealTimers();
    });
  });

  describe('Synchronous Scroll Position Restoration (Grid & List)', () => {
    let mockAppState;
    let uiManagerMock;
    let dom;

    beforeEach(async () => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="tab-container"></div><div id="thumbnail-grid"><div class="virtual-spacer"></div><div class="virtual-content"></div></div><table id="file-list-body"></table></body></html>', {
        url: 'http://localhost'
      });
      global.window = dom.window;
      global.document = dom.window.document;

      mockAppState = {
        totalCount: 100,
        savedScrollTopGrid: 5000,
        savedScrollTopList: 3000,
      };

      uiManagerMock = {
        elements: {
          thumbnailGrid: document.getElementById('thumbnail-grid'),
          fileListBody: document.getElementById('file-list-body')
        },
        async renderGrid() {
          const container = this.elements.thumbnailGrid;
          const spacer = container.querySelector('.virtual-spacer');
          const totalHeight = 10000;
          spacer.style.height = `${totalHeight}px`;

          if (mockAppState.savedScrollTopGrid) {
            container.scrollTop = mockAppState.savedScrollTopGrid;
            mockAppState.savedScrollTopGrid = 0;
          }
        },
        async updateVirtualList() {
          const container = document.getElementById('tab-container');
          const fragment = document.createDocumentFragment();
          const tr = document.createElement('tr');
          fragment.appendChild(tr);

          this.elements.fileListBody.innerHTML = '';
          this.elements.fileListBody.appendChild(fragment);

          if (mockAppState.savedScrollTopList !== undefined && mockAppState.savedScrollTopList !== 0) {
            container.scrollTop = mockAppState.savedScrollTopList;
            mockAppState.savedScrollTopList = 0;
          }
        }
      };
    });
    
    afterEach(() => {
      // delete global.window;
      // delete global.document;
    });

    it('should synchronously restore grid scroll position and clear the saved value', async () => {
      expect(uiManagerMock.elements.thumbnailGrid.scrollTop).toBe(0);
      expect(mockAppState.savedScrollTopGrid).toBe(5000);

      await uiManagerMock.renderGrid();

      expect(uiManagerMock.elements.thumbnailGrid.scrollTop).toBe(5000);
      expect(mockAppState.savedScrollTopGrid).toBe(0);
    });

    it('should synchronously restore list scroll position and clear the saved value', async () => {
      const tabContainer = document.getElementById('tab-container');
      expect(tabContainer.scrollTop).toBe(0);
      expect(mockAppState.savedScrollTopList).toBe(3000);

      await uiManagerMock.updateVirtualList();

      expect(tabContainer.scrollTop).toBe(3000);
      expect(mockAppState.savedScrollTopList).toBe(0);
    });
  });

  describe('Tab Drag and Drop', () => {
    let uiManager;
    let dom;

    beforeEach(() => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="tab-container"><button id="new-tab-btn"></button></div></body></html>', {
        url: 'http://localhost'
      });
      global.window = dom.window;
      global.document = dom.window.document;
      
      appState.tabs = [
        { id: 'tab1', path: 'C:/folder1', name: 'folder1' },
        { id: 'tab2', path: 'C:/folder2', name: 'folder2' },
        { id: 'tab3', path: 'C:/folder3', name: 'folder3' }
      ];
      appState.activeTabIndex = 0;
      
      // prevent async requestAnimationFrame from firing after teardown
      window.requestAnimationFrame = cb => cb();

      uiManager = new UIManager(appState);
      uiManager.renderTabs();
    });

    afterEach(() => {
      // delete global.window;
      // delete global.document;
    });

    it('should reorder tabs when dropped', () => {
      const tabs = document.querySelectorAll('.tab-item');
      expect(tabs.length).toBe(3);

      const tab0 = tabs[0];
      const tab1 = tabs[1];

      window.onTabMove = (fromIndex, toIndex, insertAfter) => {
        if (fromIndex === toIndex) return;
        const currentTabs = appState.tabs;
        const activeTab = currentTabs[appState.activeTabIndex];
        const [movedTab] = currentTabs.splice(fromIndex, 1);
        let adjustedToIndex = toIndex;
        if (fromIndex < toIndex) adjustedToIndex -= 1;
        if (insertAfter) adjustedToIndex += 1;
        currentTabs.splice(adjustedToIndex, 0, movedTab);
        appState.activeTabIndex = currentTabs.indexOf(activeTab);
        uiManager.renderTabs();
      };

      const dragStartEvent = new Event('dragstart');
      dragStartEvent.dataTransfer = {
        effectAllowed: 'none',
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue('0'),
        types: ['application/json-tab']
      };
      tab0.dispatchEvent(dragStartEvent);

      expect(dragStartEvent.dataTransfer.setData).toHaveBeenCalledWith('application/json-tab', '0');

      const dragOverEvent = new Event('dragover');
      dragOverEvent.dataTransfer = dragStartEvent.dataTransfer;
      tab1.getBoundingClientRect = () => ({ left: 100, width: 100 });
      dragOverEvent.clientX = 180;
      tab1.dispatchEvent(dragOverEvent);

      expect(tab1.classList.contains('drag-over-right')).toBe(true);

      const dropEvent = new Event('drop');
      dropEvent.dataTransfer = dragStartEvent.dataTransfer;
      dropEvent.clientX = 180;
      tab1.dispatchEvent(dropEvent);

      const newTabs = document.querySelectorAll('.tab-item');
      expect(newTabs[0].dataset.tabId).toBe('tab2');
      expect(newTabs[1].dataset.tabId).toBe('tab1');
      expect(appState.tabs[0].id).toBe('tab2');
      expect(appState.tabs[1].id).toBe('tab1');
      expect(appState.tabs[2].id).toBe('tab3');
    });
  });
});
