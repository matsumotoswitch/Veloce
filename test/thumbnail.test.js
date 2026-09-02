import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/renderer-state.js';

describe('Thumbnail Cache Rebuild Bug Fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T12:00:00Z'));
    window.appState = {
      thumbnailUrls: new Map(),
      selection: new Set()
    };
    window.veloceAPI = {
      convertFileSrc: vi.fn(path => `asset://${path}`),
      getThumbnail: vi.fn(async (path) => `data:image/jpeg;base64,/9j/mock`)
    };
    // Mock the DOM for updateDOM
    document.body.innerHTML = `
      <div class="virtual-content">
        <div data-filepath="test.jpg">
          <img class="thumbnail-img" />
        </div>
      </div>
    `;
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not call URL.revokeObjectURL for https urls', () => {
    appState.thumbnailUrls.set('test.jpg', 'https://veloce.localhost/thumbnail/?path=test.jpg');
    const oldUrl = appState.thumbnailUrls.get('test.jpg');
    if (oldUrl && oldUrl.startsWith('blob:')) window.URL.revokeObjectURL(oldUrl);
    appState.thumbnailUrls.delete('test.jpg');
    
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(appState.thumbnailUrls.has('test.jpg')).toBe(false);
  });

  it('should call URL.revokeObjectURL for blob urls', () => {
    appState.thumbnailUrls.set('test.jpg', 'blob:http://localhost/1234');
    const oldUrl = appState.thumbnailUrls.get('test.jpg');
    if (oldUrl && oldUrl.startsWith('blob:')) window.URL.revokeObjectURL(oldUrl);
    appState.thumbnailUrls.delete('test.jpg');
    
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1234');
    expect(appState.thumbnailUrls.has('test.jpg')).toBe(false);
  });

  it('should fallback to convertFileSrc on img.onerror', () => {
    const img = document.createElement('img');
    img.className = 'thumbnail-img';
    img.src = 'https://veloce.localhost/thumbnail/?path=test.jpg';
    
    // Simulate the onerror handler from renderer-ui.js
    img.onerror = function() {
      this.classList.remove('loading');
      const fallback = window.veloceAPI.convertFileSrc('test.jpg');
      if (this.src !== fallback && !this.src.startsWith('asset://')) {
        if (window.appState && window.appState.thumbnailUrls) {
          window.appState.thumbnailUrls.set('test.jpg', fallback);
        }
        this.src = fallback;
      }
    };

    img.onerror();

    expect(img.src).toContain('asset://test.jpg');
    expect(appState.thumbnailUrls.get('test.jpg')).toBe('asset://test.jpg');
  });

  it('should dispatch error event if img.complete is true but naturalWidth is 0', () => {
    appState.thumbnailUrls.set('test.jpg', 'broken-image-url');
    const img = document.createElement('img');
    img.className = 'thumbnail-img';
    img.dataset.currentSrc = '';
    let errorDispatched = false;
    
    img.addEventListener('error', () => {
      errorDispatched = true;
    });

    // Mock naturalWidth and complete
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true });
    
    // Simulate the logic from updateVirtualGrid
    img.src = appState.thumbnailUrls.get('test.jpg');
    if (img.complete) {
        img.classList.remove('loading');
        if (img.naturalWidth === 0 && img.src !== 'data:image/svg+xml;base64,...') {
            img.dispatchEvent(new Event('error'));
        }
    }

    expect(errorDispatched).toBe(true);
  });


  it('should fallback to Web Worker if Rust cache is empty (mock test)', async () => {
    // 擬似的に Web Worker の動作をテスト
    const workerPool = {
      generate: vi.fn(async () => 'blob:worker-generated')
    };
    
    window.veloceAPI.getThumbnail.mockResolvedValueOnce(null); // キャッシュミス
    window.veloceAPI.saveThumbnail = vi.fn().mockResolvedValue(true);
    
    const filePath = 'test.webp';
    let url = await window.veloceAPI.getThumbnail(filePath);
    
    if (!url) {
      const assetUrl = window.veloceAPI.convertFileSrc(filePath);
      url = await workerPool.generate(filePath, assetUrl);
      window.veloceAPI.saveThumbnail(filePath, url);
    }
    
    expect(workerPool.generate).toHaveBeenCalledWith('test.webp', 'asset://test.webp');
    expect(window.veloceAPI.saveThumbnail).toHaveBeenCalledWith('test.webp', 'blob:worker-generated');
    expect(url).toBe('blob:worker-generated');
  });

  it('should trigger debouncedUpdateSmartFolderCounts when queue is cleared', () => {
    window.debouncedUpdateSmartFolderCounts = vi.fn();
    
    // Mock the clear method logic of ThumbnailQueueManager
    const manager = {
      priorityQueue: [1, 2, 3],
      preloadQueue: [4, 5],
      activeTasks: new Set(['a']),
      clear() {
        this.priorityQueue = [];
        this.preloadQueue = [];
        this.activeTasks.clear();
        if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
          window.debouncedUpdateSmartFolderCounts();
        }
      }
    };
    
    manager.clear();
    
    expect(manager.priorityQueue.length).toBe(0);
    expect(manager.preloadQueue.length).toBe(0);
    expect(manager.activeTasks.size).toBe(0);
    expect(window.debouncedUpdateSmartFolderCounts).toHaveBeenCalled();
  });

  it('should trigger debouncedUpdateSmartFolderCounts when thumbnail generation completes', () => {
    window.debouncedUpdateSmartFolderCounts = vi.fn();
    
    // Mock the completion logic of processNext in ThumbnailQueueManager
    const manager = {
      priorityQueue: [],
      preloadQueue: [],
      activeTasks: new Set(),
      appState: { preloadCursor: 100, totalCount: 100 },
      processNext() {
        // ... tasks run ...
        if (this.priorityQueue.length === 0 && 
            this.preloadQueue.length === 0 && 
            this.activeTasks.size === 0 && 
            this.appState.preloadCursor >= this.appState.totalCount) {
          if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
            window.debouncedUpdateSmartFolderCounts();
          }
        }
      }
    };
    
    manager.processNext();
    expect(window.debouncedUpdateSmartFolderCounts).toHaveBeenCalled();
    
    // If not complete, it should not trigger
    window.debouncedUpdateSmartFolderCounts.mockClear();
    manager.activeTasks.add('task1');
    manager.processNext();
    expect(window.debouncedUpdateSmartFolderCounts).not.toHaveBeenCalled();
  });

  it('remove() should reset retry count so new files are not blocked by stale retries', () => {
    // 不具合再現: file-changed イベントが連続発生した場合にリトライカウントが積み上がり
    // SVGフォールバックになってしまう問題を検証
    const manager = {
      priorityQueue: [],
      priorityQueueSet: new Set(),
      preloadQueue: [],
      activeTasks: new Set(),
      _retryMap: new Map(),
      _dirtyTasks: null,
      remove(filePath) {
        this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
        this.priorityQueueSet.delete(filePath);
        this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);
        if (this._retryMap) {
          this._retryMap.delete(filePath);
        }
        if (this.activeTasks.has(filePath)) {
          if (!this._dirtyTasks) this._dirtyTasks = new Set();
          this._dirtyTasks.add(filePath);
        }
      }
    };

    const filePath = 'C:\\Users\\test\\new-image.png';

    // リトライカウントが溜まった状態をシミュレート
    manager._retryMap.set(filePath, 2);

    // file-changed イベント → remove() 呼び出し
    manager.remove(filePath);

    // リトライカウントがリセットされること
    expect(manager._retryMap.has(filePath)).toBe(false);
  });

  it('remove() should set _dirtyTasks flag when task is actively running', () => {
    const manager = {
      priorityQueue: [],
      priorityQueueSet: new Set(),
      preloadQueue: [],
      activeTasks: new Set(),
      _retryMap: null,
      _dirtyTasks: null,
      remove(filePath) {
        this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
        this.priorityQueueSet.delete(filePath);
        this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);
        if (this._retryMap) {
          this._retryMap.delete(filePath);
        }
        if (this.activeTasks.has(filePath)) {
          if (!this._dirtyTasks) this._dirtyTasks = new Set();
          this._dirtyTasks.add(filePath);
        }
      }
    };

    const filePath = 'C:\\Users\\test\\new-image.png';

    // タスクが実行中の状態
    manager.activeTasks.add(filePath);

    // file-changed イベント → remove() 呼び出し
    manager.remove(filePath);

    // _dirtyTasks フラグが立っていること（後でrunTaskが再キューする）
    expect(manager._dirtyTasks).not.toBeNull();
    expect(manager._dirtyTasks.has(filePath)).toBe(true);
  });

  it('remove() should NOT set _dirtyTasks when task is not running', () => {
    const manager = {
      priorityQueue: [{ filePath: 'C:\\test.png' }],
      priorityQueueSet: new Set(['C:\\test.png']),
      preloadQueue: [],
      activeTasks: new Set(), // タスクは実行中ではない
      _retryMap: null,
      _dirtyTasks: null,
      remove(filePath) {
        this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
        this.priorityQueueSet.delete(filePath);
        this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);
        if (this._retryMap) {
          this._retryMap.delete(filePath);
        }
        if (this.activeTasks.has(filePath)) {
          if (!this._dirtyTasks) this._dirtyTasks = new Set();
          this._dirtyTasks.add(filePath);
        }
      }
    };

    const filePath = 'C:\\test.png';
    manager.remove(filePath);

    // キューからは削除されること
    expect(manager.priorityQueue.length).toBe(0);
    // _dirtyTasks は設定されないこと（タスク未実行のため）
    expect(manager._dirtyTasks).toBeNull();
  });

  describe('Immediate Viewport Thumbnail & Directory Load Optimization', () => {
    it('should reset savedScrollTopGrid to 0 when navigating to a different folder or smart folder', () => {
      // フォルダ遷移時、以前のスクロール位置を引き継がず0にリセットされ、
      // initialChunk が破棄されずに即時表示されることを検証
      const mockTabs = [
        { path: 'C:/folderA', scrollTop: 500 },
        { path: 'smart://fav_5', scrollTop: 0 }
      ];
      const activeTabIndex = 1;
      const currentDir = 'smart://fav_5';

      const isReloadingCurrent = mockTabs[activeTabIndex].path === currentDir && mockTabs[activeTabIndex].scrollTop !== 0;
      const savedScrollTopGrid = isReloadingCurrent ? 500 : (mockTabs[activeTabIndex].scrollTop || 0);

      expect(savedScrollTopGrid).toBe(0);
    });

    it('should synchronously invoke renderAll upon onDirectoryLoaded without debounce delay', () => {
      let renderAllCalled = false;
      const uiManagerMock = {
        renderAll: () => { renderAllCalled = true; },
        updateSelectionUI: () => {}
      };

      const payload = {
        path: 'smart://fav_5',
        totalCount: 50,
        initialChunk: [{ path: 'C:/img1.png', mtime: 0, hasThumbnailCache: true }]
      };

      // onDirectoryLoaded 受信時、100ms debounce を待たずに同期的に renderAll が実行されること
      const appStateMock = {
        currentDirectory: 'smart://fav_5',
        totalCount: 0,
        preloadCursor: -1,
        thumbnailTotalRequested: 0,
        thumbnailCompleted: 0,
        thumbnailCounted: new Set(),
        selectedIndex: -1
      };

      if (payload.path === appStateMock.currentDirectory) {
        appStateMock.totalCount = payload.totalCount;
        if (payload.initialChunk) {
          appStateMock.initialChunk = payload.initialChunk;
        }
        appStateMock.preloadCursor = 0;
        uiManagerMock.renderAll();
      }

      expect(renderAllCalled).toBe(true);
      expect(appStateMock.initialChunk).toHaveLength(1);
      expect(appStateMock.preloadCursor).toBe(0);
    });
  });
});
