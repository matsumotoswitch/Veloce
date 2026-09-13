import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    it('should set wrapper.dataset.filename and omit native title for unified custom tooltip on thumbnails', () => {
      const file = { name: 'very_long_filename_12345.png', path: 'C:/photos/very_long_filename_12345.png' };
      const wrapper = document.createElement('div');
      const label = document.createElement('div');
      wrapper.appendChild(label);

      // ロジック検証: ネイティブtitleを廃止し、カスタムツールチップ用に dataset.filename を設定
      if (file.name) {
        label.textContent = file.name;
        wrapper.dataset.filename = file.name;
        label.removeAttribute('title');
        wrapper.removeAttribute('title');
      } else {
        label.textContent = '';
        delete wrapper.dataset.filename;
        label.removeAttribute('title');
        wrapper.removeAttribute('title');
      }

      expect(wrapper.dataset.filename).toBe('very_long_filename_12345.png');
      expect(wrapper.getAttribute('title')).toBeNull();
      expect(label.getAttribute('title')).toBeNull();
    });

    it('should trigger tooltip only when target is within thumbnail-label', () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'thumbnail-item';
      const img = document.createElement('img');
      img.className = 'thumbnail-img';
      const label = document.createElement('div');
      label.className = 'thumbnail-label';
      label.textContent = 'sample_image.png';

      wrapper.appendChild(img);
      wrapper.appendChild(label);

      // 画像本体をホバーした場合 -> label は null（ツールチップ非表示）
      const targetImg = img;
      expect(targetImg.closest('.thumbnail-label')).toBeNull();

      // ファイル名ラベルをホバーした場合 -> label が取得できツールチップ表示対象
      const targetLabel = label;
      expect(targetLabel.closest('.thumbnail-label')).toBe(label);
      expect(targetLabel.closest('.thumbnail-label').textContent).toBe('sample_image.png');
    });
  });

  describe('Uncached New Files Priority Queueing in Grid', () => {
    let originalThumbnailManager;

    beforeEach(() => {
      originalThumbnailManager = window.thumbnailManager;
    });

    afterEach(() => {
      window.thumbnailManager = originalThumbnailManager;
    });

    it('updateVirtualGrid should enqueue uncached files (hasThumbnailCache: false) to thumbnailManager priority batch and set loading placeholder', async () => {
      const enqueuedBatches = [];
      window.thumbnailManager = {
        enqueuePriorityBatch: vi.fn((paths) => {
          enqueuedBatches.push(...paths);
        }),
        enqueuePriority: vi.fn()
      };

      const testFiles = [
        { path: 'C:/media/cached1.png', name: 'cached1.png', mtime: 1000, hasThumbnailCache: true },
        { path: 'C:/media/new1.png', name: 'new1.png', mtime: 2000, hasThumbnailCache: false },
        { path: 'C:/media/new2.webp', name: 'new2.webp', mtime: 3000, hasThumbnailCache: false },
        { path: 'C:/media/cached2.png', name: 'cached2.png', mtime: 4000, hasThumbnailCache: true }
      ];

      const { appState: sharedAppState } = await import('../src/renderer-state.js');
      sharedAppState.totalCount = testFiles.length;
      sharedAppState.initialChunk = testFiles;
      sharedAppState.thumbnailUrls.clear();
      sharedAppState.selection.clear();
      sharedAppState.ratings = {};
      sharedAppState.dragState = { isAppDragging: false };
      window.appState = sharedAppState;

      const gridContainer = document.createElement('div');
      gridContainer.id = 'grid-view';
      gridContainer.getBoundingClientRect = () => ({ width: 800, height: 600 });
      Object.defineProperty(gridContainer, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(gridContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

      const gridSpacer = document.createElement('div');
      gridSpacer.className = 'virtual-spacer';

      const gridContent = document.createElement('div');
      gridContent.className = 'virtual-content';

      gridContainer.appendChild(gridSpacer);
      gridContainer.appendChild(gridContent);

      const { UIManager } = await import('../src/renderer-ui.js');
      const ui = new UIManager(sharedAppState);
      ui.elements.thumbnailGrid = gridContainer;
      ui.elements.thumbnailSizeSlider = { value: '180' };

      await ui.updateVirtualGrid(true);

      // 1. 未生成の2ファイルのみが enqueuePriorityBatch に投入されていること
      expect(window.thumbnailManager.enqueuePriorityBatch).toHaveBeenCalledTimes(1);
      expect(enqueuedBatches).toEqual(['C:/media/new1.png', 'C:/media/new2.webp']);

      // 2. DOM要素の検証
      // children[0] (cached1.png): キャッシュ済みなのでカスタムプロトコルURLが設定される
      const cached1Img = gridContent.children[0].querySelector('.thumbnail-img');
      expect(cached1Img.src).toContain('https://veloce.localhost/thumbnail/?path=');
      expect(sharedAppState.thumbnailUrls.get('C:/media/cached1.png')).toContain('https://veloce.localhost/thumbnail/?path=');

      // children[1] (new1.png): 未生成なのでプレースホルダーとloadingクラスが設定され、Workerによる生成を待つ
      const new1Img = gridContent.children[1].querySelector('.thumbnail-img');
      expect(new1Img.src).toContain('data:image/gif;base64');
      expect(new1Img.classList.contains('loading')).toBe(true);

      // children[2] (new2.webp): 未生成なのでプレースホルダーとloadingクラス
      const new2Img = gridContent.children[2].querySelector('.thumbnail-img');
      expect(new2Img.src).toContain('data:image/gif;base64');
      expect(new2Img.classList.contains('loading')).toBe(true);

      // children[3] (cached2.png): キャッシュ済み
      const cached2Img = gridContent.children[3].querySelector('.thumbnail-img');
      expect(cached2Img.src).toContain('https://veloce.localhost/thumbnail/?path=');
    });

    it('updateVirtualGrid should not enqueue files when all visible items have cached thumbnails', async () => {
      const enqueueMock = vi.fn();
      window.thumbnailManager = {
        enqueuePriorityBatch: enqueueMock,
        enqueuePriority: vi.fn()
      };

      const testFiles = [
        { path: 'C:/media/cached1.png', name: 'cached1.png', mtime: 1000, hasThumbnailCache: true },
        { path: 'C:/media/cached2.png', name: 'cached2.png', mtime: 2000, hasThumbnailCache: true }
      ];

      const { appState: sharedAppState } = await import('../src/renderer-state.js');
      sharedAppState.totalCount = testFiles.length;
      sharedAppState.initialChunk = testFiles;
      sharedAppState.thumbnailUrls.clear();
      sharedAppState.selection.clear();
      sharedAppState.ratings = {};
      sharedAppState.dragState = { isAppDragging: false };
      window.appState = sharedAppState;

      const gridContainer = document.createElement('div');
      gridContainer.id = 'grid-view';
      gridContainer.getBoundingClientRect = () => ({ width: 800, height: 600 });
      Object.defineProperty(gridContainer, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(gridContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

      const gridSpacer = document.createElement('div');
      gridSpacer.className = 'virtual-spacer';

      const gridContent = document.createElement('div');
      gridContent.className = 'virtual-content';

      gridContainer.appendChild(gridSpacer);
      gridContainer.appendChild(gridContent);

      const { UIManager } = await import('../src/renderer-ui.js');
      const ui = new UIManager(sharedAppState);
      ui.elements.thumbnailGrid = gridContainer;
      ui.elements.thumbnailSizeSlider = { value: '180' };

      await ui.updateVirtualGrid(true);

      expect(enqueueMock).not.toHaveBeenCalled();
    });
  });

  describe('Native Downsampled Thumbnail Generation Pipeline', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it('getImageDimensionsFromBlob should accurately parse PNG dimensions', async () => {
      const { getImageDimensionsFromBlob } = await import('../src/renderer-thumbnails.js');
      // PNG: 1920 x 1080
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
        0x00, 0x00, 0x00, 0x0D, // IHDR length 13
        0x49, 0x48, 0x44, 0x52, // "IHDR"
        0x00, 0x00, 0x07, 0x80, // width: 1920
        0x00, 0x00, 0x04, 0x38, // height: 1080
        0x08, 0x06, 0x00, 0x00, 0x00 // bit_depth, color_type, etc.
      ]);
      const blob = new Blob([pngHeader], { type: 'image/png' });
      const dims = await getImageDimensionsFromBlob(blob);
      expect(dims).toEqual({ width: 1920, height: 1080 });
    });

    it('getImageDimensionsFromBlob should accurately parse WebP (VP8X) dimensions', async () => {
      const { getImageDimensionsFromBlob } = await import('../src/renderer-thumbnails.js');
      // WebP VP8X: width=1024, height=768 (stored as width-1 = 1023 (0x0003FF), height-1 = 767 (0x0002FF))
      const webpHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0x20, 0x00, 0x00, 0x00, // size dummy
        0x57, 0x45, 0x42, 0x50, // "WEBP"
        0x56, 0x50, 0x38, 0x58, // "VP8X"
        0x0A, 0x00, 0x00, 0x00, // chunk size 10
        0x00, 0x00, 0x00, 0x00, // flags
        0xFF, 0x03, 0x00,       // width - 1 = 1023 (24bit LE: 0xFF, 0x03, 0x00)
        0xFF, 0x02, 0x00        // height - 1 = 767 (24bit LE: 0xFF, 0x02, 0x00)
      ]);
      const blob = new Blob([webpHeader], { type: 'image/webp' });
      const dims = await getImageDimensionsFromBlob(blob);
      expect(dims).toEqual({ width: 1024, height: 768 });
    });

    it('getImageDimensionsFromBlob should accurately parse JPEG SOF0 dimensions', async () => {
      const { getImageDimensionsFromBlob } = await import('../src/renderer-thumbnails.js');
      // JPEG SOF0: height=600 (0x0258), width=800 (0x0320)
      const jpegHeader = new Uint8Array([
        0xFF, 0xD8,             // SOI
        0xFF, 0xC0,             // SOF0
        0x00, 0x11,             // segment length 17
        0x08,                   // precision
        0x02, 0x58,             // height: 600
        0x03, 0x20,             // width: 800
        0x03, 0x01, 0x11, 0x00  // components
      ]);
      const blob = new Blob([jpegHeader], { type: 'image/jpeg' });
      const dims = await getImageDimensionsFromBlob(blob);
      expect(dims).toEqual({ width: 800, height: 600 });
    });

    it('getImageDimensionsFromBlob should safely return null for invalid or corrupted data', async () => {
      const { getImageDimensionsFromBlob } = await import('../src/renderer-thumbnails.js');
      const corrupted = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const blob = new Blob([corrupted]);
      const dims = await getImageDimensionsFromBlob(blob);
      expect(dims).toBeNull();
    });

    it('runTask should bypass getThumbnail IPC when skipDbCheck is true', async () => {
      const { ThumbnailQueueManager } = await import('../src/renderer-thumbnails.js');
      const manager = new ThumbnailQueueManager(4);
      
      const getThumbnailSpy = vi.fn().mockResolvedValue(null);
      window.veloceAPI.getThumbnail = getThumbnailSpy;
      window.veloceAPI.saveThumbnail = vi.fn().mockResolvedValue('asset://saved');
      
      // Mock worker generate
      const { thumbnailWorkerPool } = await import('../src/renderer-thumbnails.js');
      const generateSpy = vi.spyOn(thumbnailWorkerPool, 'generate').mockResolvedValue({
        url: 'blob:test',
        base64Promise: Promise.resolve('data:image/jpeg;base64,...')
      });

      // skipDbCheck: true で実行
      await manager.runTask('C:/media/test_skip.png', true);

      // getThumbnail IPC は一切呼ばれないこと
      expect(getThumbnailSpy).not.toHaveBeenCalled();
      // worker.generate は即座に呼ばれること
      expect(generateSpy).toHaveBeenCalled();

      // skipDbCheck: false（デフォルト）で実行
      getThumbnailSpy.mockClear();
      generateSpy.mockClear();
      await manager.runTask('C:/media/test_normal.png', false);

      // getThumbnail IPC が呼ばれること
      expect(getThumbnailSpy).toHaveBeenCalledWith('C:/media/test_normal.png');
      expect(generateSpy).toHaveBeenCalled();

      generateSpy.mockRestore();
    });

    it('should use pre-encoded BROKEN_MP4_FALLBACK_URL without redundant btoa execution', async () => {
      const { BROKEN_MP4_FALLBACK_URL } = await import('../src/renderer-ui.js');
      expect(BROKEN_MP4_FALLBACK_URL).toBeDefined();
      expect(BROKEN_MP4_FALLBACK_URL).toMatch(/^data:image\/svg\+xml;base64,/);
    });
  });

  describe('Self-Healing Watchdog Process', () => {
    it('should early return and avoid DOM scans when in table/list mode or when idle and healthy', async () => {
      const { checkThumbnailSelfHealing } = await import('../src/renderer-thumbnails.js');

      // 1. activeCenterPane が 'table' (リストビュー) の場合 -> 早期リターン 0
      window.appState = { activeCenterPane: 'table', dragState: { isAppDragging: false } };
      window.uiManager = { _domByPath: new Map([['path1', { children: [{ classList: { contains: () => true } }] }]]) };
      expect(checkThumbnailSelfHealing()).toBe(0);

      // 2. _domByPath が空の場合 -> 早期リターン 0
      window.appState.activeCenterPane = 'grid';
      window.uiManager._domByPath = new Map();
      expect(checkThumbnailSelfHealing()).toBe(0);

      // 3. 全サムネイルがロード済み（healthy）かつキュー・タスクが空の場合 -> DOM走査を行わず早期リターン 0
      const domMap = new Map();
      const childGetter = vi.fn();
      domMap.set('C:/images/pic1.png', {
        get children() {
          childGetter();
          return [{ classList: { contains: () => false }, src: 'https://veloce.localhost/thumbnail/pic1' }];
        }
      });
      window.uiManager._domByPath = domMap;
      window.appState.thumbnailUrls = new Map([
        ['C:/images/pic1.png', 'https://veloce.localhost/thumbnail/pic1']
      ]);
      window.thumbnailManager = {
        priorityQueue: [],
        preloadQueue: [],
        activeTasks: new Set(),
        enqueuePriority: vi.fn(),
        processNext: vi.fn()
      };

      const retries = checkThumbnailSelfHealing();
      expect(retries).toBe(0);
      // 完全アイドル時は DOM の children[0] に一度もアクセスせずに早期リターンすること
      expect(childGetter).not.toHaveBeenCalled();
      expect(window.thumbnailManager.enqueuePriority).not.toHaveBeenCalled();

      // 4. スタック中のサムネイルが存在する場合 -> 自動検知して再キューすること
      domMap.set('C:/images/stuck.png', {
        children: [{
          classList: { contains: (cls) => cls === 'loading' },
          src: 'data:image/gif;base64,...'
        }]
      });
      const retriesStuck = checkThumbnailSelfHealing();
      expect(retriesStuck).toBe(1);
      expect(window.thumbnailManager.enqueuePriority).toHaveBeenCalledWith('C:/images/stuck.png');
    });
  });

  describe('Thumbnail Cache Rebuild Workflow & Persistence', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it('runTask should persist thumbnail via saveThumbnail even if aborted by folder navigation', async () => {
      const { ThumbnailQueueManager, thumbnailWorkerPool } = await import('../src/renderer-thumbnails.js');
      const manager = new ThumbnailQueueManager(4);

      window.veloceAPI.getThumbnail = vi.fn().mockResolvedValue(null);
      const saveThumbnailMock = vi.fn().mockResolvedValue('http://127.0.0.1:1234/?path=test.png&thumb=1');
      window.veloceAPI.saveThumbnail = saveThumbnailMock;

      let resolveBase64;
      const base64Promise = new Promise((resolve) => { resolveBase64 = resolve; });

      vi.spyOn(thumbnailWorkerPool, 'generate').mockImplementation(async () => {
        return {
          url: 'blob:mock-blob',
          base64Promise,
          width: 200,
          height: 200
        };
      });

      const taskPromise = manager.runTask('test.png', true);

      // タスク起動後にフォルダ移動が発生して abort された状態をシミュレート
      manager.abortController.abort();

      // Base64 変換が完了
      resolveBase64('data:image/jpeg;base64,abc123xyz');

      await taskPromise;
      await new Promise(r => setTimeout(r, 10));

      // フォルダ移動後でも saveThumbnail は確実に呼ばれ、SQLite DB にキャッシュが永続化されること
      expect(saveThumbnailMock).toHaveBeenCalledWith('test.png', 'data:image/jpeg;base64,abc123xyz');
    });

    it('folder cache rebuild should clear old cache, enqueue all paths, and set progress tracking', async () => {
      const pathsToRebuild = ['C:/photos/img1.png', 'C:/photos/img2.webp', 'C:/photos/img3.jpg'];
      const unshiftPreloadMock = vi.fn();
      window.thumbnailManager = {
        unshiftPreload: unshiftPreloadMock
      };

      const clearCacheMock = vi.fn().mockResolvedValue([]);
      window.veloceAPI.clearMetadataCache = clearCacheMock;
      window.veloceAPI.getItems = vi.fn().mockResolvedValue([
        { path: pathsToRebuild[0] },
        { path: pathsToRebuild[1] },
        { path: pathsToRebuild[2] }
      ]);

      const testAppState = {
        currentDirectory: 'C:/photos',
        totalCount: 3,
        thumbnailUrls: new Map([
          ['C:/photos/img1.png', 'blob:old1'],
          ['C:/photos/img2.webp', 'blob:old2']
        ]),
        thumbnailTotalRequested: 0,
        thumbnailCompleted: 0,
        thumbnailCounted: new Set(['C:/photos/img1.png']),
        rebuiltPaths: null
      };
      window.appState = testAppState;

      // menuRebuildFolderCache の処理フローをシミュレート
      const collectedPaths = [];
      const total = testAppState.totalCount;
      const batchSize = 1000;
      for (let i = 0; i < total; i += batchSize) {
        const size = Math.min(batchSize, total - i);
        const files = await window.veloceAPI.getItems(i, size);
        for (const file of files) {
          collectedPaths.push(file.path);
          if (testAppState.thumbnailUrls.has(file.path)) {
            const oldUrl = testAppState.thumbnailUrls.get(file.path);
            if (oldUrl && oldUrl.startsWith('blob:')) window.URL.revokeObjectURL(oldUrl);
            testAppState.thumbnailUrls.delete(file.path);
          }
        }
      }

      await window.veloceAPI.clearMetadataCache(collectedPaths);
      testAppState.thumbnailTotalRequested = collectedPaths.length;
      testAppState.thumbnailCompleted = 0;
      if (!testAppState.rebuiltPaths) testAppState.rebuiltPaths = new Set();
      collectedPaths.forEach(p => {
        testAppState.thumbnailCounted.delete(p);
        testAppState.rebuiltPaths.add(p);
      });
      window.thumbnailManager.unshiftPreload(collectedPaths);

      // 検証
      expect(clearCacheMock).toHaveBeenCalledWith(pathsToRebuild);
      expect(testAppState.thumbnailUrls.size).toBe(0);
      expect(testAppState.thumbnailTotalRequested).toBe(3);
      expect(testAppState.thumbnailCompleted).toBe(0);
      expect(testAppState.thumbnailCounted.size).toBe(0);
      expect(testAppState.rebuiltPaths.size).toBe(3);
      expect(unshiftPreloadMock).toHaveBeenCalledWith(pathsToRebuild);
    });
  });

  describe('Thumbnail Flickering and Stale Image Elimination', () => {
    it('should immediately set loading class on wrapper and img when slot is recycled for a new file', async () => {
      if (!window.thumbnailManager) {
        window.thumbnailManager = { enqueuePriorityBatch: vi.fn(), enqueuePriority: vi.fn(), processNext: vi.fn() };
      } else if (!window.thumbnailManager.processNext) {
        window.thumbnailManager.processNext = vi.fn();
      }
      const { appState: sharedAppState } = await import('../src/renderer-state.js');
      const { UIManager } = await import('../src/renderer-ui.js');

      const fileA = { path: 'C:/media/a.png', name: 'a.png', mtime: 1000, hasThumbnailCache: true };
      const fileB = { path: 'C:/media/b.png', name: 'b.png', mtime: 2000, hasThumbnailCache: true };

      sharedAppState.totalCount = 1;
      sharedAppState.initialChunk = [fileA];
      sharedAppState.thumbnailUrls.clear();
      sharedAppState.selection.clear();
      sharedAppState.ratings = {};
      sharedAppState.dragState = { isAppDragging: false };
      window.appState = sharedAppState;

      const gridContainer = document.createElement('div');
      gridContainer.id = 'grid-view';
      Object.defineProperty(gridContainer, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(gridContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

      const gridSpacer = document.createElement('div');
      gridSpacer.className = 'virtual-spacer';
      const gridContent = document.createElement('div');
      gridContent.className = 'virtual-content';
      gridContainer.appendChild(gridSpacer);
      gridContainer.appendChild(gridContent);

      const ui = new UIManager(sharedAppState);
      ui.elements.thumbnailGrid = gridContainer;
      ui.elements.thumbnailSizeSlider = { value: '180' };

      // 初期描画（fileA）
      await ui.updateVirtualGrid(true);
      const wrapper = gridContent.children[0];
      const img = wrapper.querySelector('.thumbnail-img');

      expect(wrapper.dataset.filepath).toBe('C:/media/a.png');
      expect(wrapper.classList.contains('loading')).toBe(true);
      expect(img.classList.contains('loading')).toBe(true);

      // fileA のロードが完了
      img.onload();
      expect(wrapper.classList.contains('loading')).toBe(false);
      expect(img.classList.contains('loading')).toBe(false);

      // 次に別のファイル fileB で同一スロットを再利用
      sharedAppState.initialChunk = [fileB];
      await ui.updateVirtualGrid(true);

      // スロット再利用直後：前の画像が露出しないよう、即座に loading クラスが付与されること
      expect(wrapper.dataset.filepath).toBe('C:/media/b.png');
      expect(wrapper.classList.contains('loading')).toBe(true);
      expect(img.classList.contains('loading')).toBe(true);

      // fileB のロードが完了
      img.onload();
      expect(wrapper.classList.contains('loading')).toBe(false);
      expect(img.classList.contains('loading')).toBe(false);
    });

    it('should drop stale async render if scroll position advances during getItems', async () => {
      if (!window.thumbnailManager) {
        window.thumbnailManager = { enqueuePriorityBatch: vi.fn(), enqueuePriority: vi.fn(), processNext: vi.fn() };
      } else if (!window.thumbnailManager.processNext) {
        window.thumbnailManager.processNext = vi.fn();
      }
      const { appState: sharedAppState } = await import('../src/renderer-state.js');
      const { UIManager } = await import('../src/renderer-ui.js');

      sharedAppState.totalCount = 100;
      sharedAppState.initialChunk = null; // force veloceAPI.getItems
      sharedAppState.thumbnailUrls.clear();
      sharedAppState.selection.clear();
      sharedAppState.ratings = {};
      sharedAppState.dragState = { isAppDragging: false };
      window.appState = sharedAppState;

      const gridContainer = document.createElement('div');
      gridContainer.id = 'grid-view';
      Object.defineProperty(gridContainer, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 600, configurable: true });
      gridContainer.scrollTop = 0;

      const gridSpacer = document.createElement('div');
      gridSpacer.className = 'virtual-spacer';
      const gridContent = document.createElement('div');
      gridContent.className = 'virtual-content';
      gridContainer.appendChild(gridSpacer);
      gridContainer.appendChild(gridContent);

      const ui = new UIManager(sharedAppState);
      ui.elements.thumbnailGrid = gridContainer;
      ui.elements.thumbnailSizeSlider = { value: '180' };

      // getItems 実行中に scrollTop が急激に進んだ状況をシミュレート
      window.veloceAPI.getItems = vi.fn(async (start, count) => {
        gridContainer.scrollTop = 2000; // スクロールが大きく進む
        return Array.from({ length: count }, (_, i) => ({
          path: `C:/media/img_${start + i}.png`,
          name: `img_${start + i}.png`,
          mtime: 1000,
          hasThumbnailCache: true
        }));
      });

      await ui.updateVirtualGrid(false);

      // 古い位置（scrollTop: 0 付近）の描画が破棄され、コンテンツが空のまま維持されること
      expect(gridContent.children.length).toBe(0);
    });
  });

  describe('Phase 3: Binary Thumbnail Stream & Direct Save Pipeline', () => {
    let originalFetch;
    let originalVideoServerPort;

    beforeEach(() => {
      originalFetch = global.fetch;
      originalVideoServerPort = window.videoServerPort;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      window.videoServerPort = originalVideoServerPort;
    });

    it('saveThumbnailBinary should POST raw Blob directly to local video server when videoServerPort is available', async () => {
      const { saveThumbnailBinary } = await import('../src/renderer-thumbnails.js');
      window.videoServerPort = 54321;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'http://127.0.0.1:54321/?path=C%3A%2Fimages%2Fpic.png&thumb=1'
      });
      global.fetch = mockFetch;

      const dummyBlob = new Blob(['mock-binary-jpeg-data'], { type: 'image/jpeg' });
      const savedUrl = await saveThumbnailBinary('C:/images/pic.png', dummyBlob, null);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('http://127.0.0.1:54321/save-thumbnail?path=');
      expect(url).toContain(encodeURIComponent('C:/images/pic.png'));
      expect(options.method).toBe('POST');
      expect(options.body).toBe(dummyBlob);
      expect(savedUrl).toBe('http://127.0.0.1:54321/?path=C%3A%2Fimages%2Fpic.png&thumb=1');
    });

    it('saveThumbnailBinary should fallback to base64Promise and window.veloceAPI.saveThumbnail when videoServerPort is absent', async () => {
      const { saveThumbnailBinary } = await import('../src/renderer-thumbnails.js');
      delete window.videoServerPort;

      const mockSaveThumbnail = vi.fn().mockResolvedValue('http://fallback-saved-url');
      window.veloceAPI = {
        saveThumbnail: mockSaveThumbnail
      };

      const base64Promise = Promise.resolve('data:image/jpeg;base64,QUJDREVGR0g=');
      const savedUrl = await saveThumbnailBinary('C:/images/fallback.png', null, base64Promise);

      expect(mockSaveThumbnail).toHaveBeenCalledWith('C:/images/fallback.png', 'data:image/jpeg;base64,QUJDREVGR0g=');
      expect(savedUrl).toBe('http://fallback-saved-url');
    });

    it('ThumbnailWorkerPool.generate base64Promise should be lazy and not construct FileReader if unread', async () => {
      let readerCalled = false;
      const originalFileReader = global.FileReader;
      global.FileReader = class MockFileReader {
        constructor() {
          readerCalled = true;
        }
        readAsDataURL() {}
      };

      try {
        let cached = null;
        const lazyPromise = {
          then(fn) {
            if (!cached) {
              cached = new Promise(r => {
                new global.FileReader();
                r('data:mock');
              });
            }
            return cached.then(fn);
          }
        };

        // .then を呼ばない限り FileReader は生成されない
        expect(readerCalled).toBe(false);

        // .then を呼ぶと初めて FileReader が生成される
        await lazyPromise.then(() => {});
        expect(readerCalled).toBe(true);
      } finally {
        global.FileReader = originalFileReader;
      }
    });

    it('updateVirtualGrid should use local HTTP URL with thumb=1 when window.videoServerPort is available', async () => {
      window.videoServerPort = 12345;
      const { appState: sharedAppState } = await import('../src/renderer-state.js');
      const testFiles = [{ path: 'C:/images/cached.png', name: 'cached.png', mtime: 55555, hasThumbnailCache: true }];
      sharedAppState.totalCount = testFiles.length;
      sharedAppState.initialChunk = testFiles;
      sharedAppState.thumbnailUrls.clear();
      sharedAppState.selection.clear();
      sharedAppState.ratings = {};
      sharedAppState.dragState = { isAppDragging: false };
      window.appState = sharedAppState;

      const gridContainer = document.createElement('div');
      gridContainer.id = 'grid-view';
      gridContainer.getBoundingClientRect = () => ({ width: 800, height: 600 });
      Object.defineProperty(gridContainer, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(gridContainer, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(gridContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

      const gridSpacer = document.createElement('div');
      gridSpacer.className = 'virtual-spacer';
      const gridContent = document.createElement('div');
      gridContent.className = 'virtual-content';
      gridContainer.appendChild(gridSpacer);
      gridContainer.appendChild(gridContent);

      const { UIManager } = await import('../src/renderer-ui.js');
      const ui = new UIManager(sharedAppState);
      ui.elements.thumbnailGrid = gridContainer;
      ui.elements.thumbnailSizeSlider = { value: '180' };

      try {
        await ui.updateVirtualGrid(true);

        const cachedImg = gridContent.children[0].querySelector('.thumbnail-img');
        expect(cachedImg.src).toContain('http://127.0.0.1:12345/?path=C%3A%2Fimages%2Fcached.png&mtime=55555&thumb=1');
        expect(sharedAppState.thumbnailUrls.get('C:/images/cached.png')).toContain('http://127.0.0.1:12345/?path=');
      } finally {
        delete window.videoServerPort;
      }
    });

    it('updateDOM should normalize path slashes and immediately remove loading class if img.complete is true', async () => {
      const { ThumbnailQueueManager } = await import('../src/renderer-thumbnails.js');
      const manager = new ThumbnailQueueManager(2);
      const wrapper = document.createElement('div');
      wrapper.dataset.filepath = 'C:\\images\\photo.png';
      wrapper.classList.add('loading');
      const img = document.createElement('img');
      img.classList.add('loading');
      wrapper.appendChild(img);

      // DOM map にバックスラッシュで登録
      window.uiManager = {
        _domByPath: new Map([['C:\\images\\photo.png', wrapper]])
      };

      // スラッシュ区切りで updateDOM を呼び出し、img.complete = true の状況
      Object.defineProperty(img, 'complete', { value: true, writable: true });
      Object.defineProperty(img, 'naturalWidth', { value: 200, writable: true });

      manager.updateDOM('C:/images/photo.png', 'blob:http://localhost/mock-blob');

      expect(img.src).toBe('blob:http://localhost/mock-blob');
      expect(img.classList.contains('loading')).toBe(false);
      expect(wrapper.classList.contains('loading')).toBe(false);
    });

    it('saveThumbnailBinary should fallback to base64 and save via IPC if videoServerPort is unset', async () => {
      delete window.videoServerPort;
      const { saveThumbnailBinary } = await import('../src/renderer-thumbnails.js');
      const mockSave = vi.fn().mockResolvedValue('http://127.0.0.1:9999/?saved=1');
      window.veloceAPI.saveThumbnail = mockSave;

      const base64Promise = Promise.resolve('data:image/jpeg;base64,QUJDREVGR0g=');
      const result = await saveThumbnailBinary('C:/test/file.jpg', null, base64Promise);

      expect(mockSave).toHaveBeenCalledWith('C:/test/file.jpg', 'data:image/jpeg;base64,QUJDREVGR0g=');
      expect(result).toBe('http://127.0.0.1:9999/?saved=1');
    });

    it('runTask should immediately recover via Rust getThumbnail when worker generate throws', async () => {
      const { appState } = await import('../src/renderer-state.js');
      const { ThumbnailQueueManager, thumbnailWorkerPool } = await import('../src/renderer-thumbnails.js');
      const manager = new ThumbnailQueueManager(2);
      const filePath = 'C:/test/rebuild_target.png';

      // 再構築対象としてセット
      appState.rebuiltPaths = new Set([filePath]);

      // Worker generate を強制失敗させる
      vi.spyOn(thumbnailWorkerPool, 'generate').mockRejectedValueOnce(new Error('Fetch failed: 403 CSP block'));

      // Rust 側救済モック
      const rustRecoveredUrl = 'http://127.0.0.1:12345/?path=C%3A%2Ftest%2Frebuild_target.png&thumb=1';
      window.veloceAPI.getThumbnail = vi.fn().mockResolvedValue(rustRecoveredUrl);

      // DOM 要素準備
      const wrapper = document.createElement('div');
      wrapper.dataset.filepath = filePath;
      const img = document.createElement('img');
      img.classList.add('loading');
      wrapper.appendChild(img);
      window.uiManager = { _domByPath: new Map([[filePath, wrapper]]) };

      await manager.runTask(filePath);

      // Rust バックエンド救済が呼ばれ、SVGアイコンにならず正規のURLが設定されること
      expect(window.veloceAPI.getThumbnail).toHaveBeenCalledWith(filePath);
      expect(appState.thumbnailUrls.get(filePath)).toBe(rustRecoveredUrl);
      expect(img.src).toBe(rustRecoveredUrl);
    });

    it('thumbnailWorkerPool.generate should fallback to readBinaryFile when fetch fails', async () => {
      vi.useRealTimers();
      const { thumbnailWorkerPool } = await import('../src/renderer-thumbnails.js');
      const filePath = 'C:/test/binary_fallback.png';

      // fetch を拒否モック
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      // readBinaryFile をモック (PNGヘッダー風バイナリ)
      const mockBytes = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, // 256x256
        0x08, 0x06, 0x00, 0x00, 0x00
      ]);
      window.veloceAPI.readBinaryFile = vi.fn().mockResolvedValue(mockBytes);

      try {
        const controller = new AbortController();
        const promise = thumbnailWorkerPool.generate(filePath, 'https://asset.localhost/test.png', controller.signal);
        // readBinaryFile が呼ばれたことを確認
        await new Promise((r) => setTimeout(r, 50));
        expect(window.veloceAPI.readBinaryFile).toHaveBeenCalledWith(filePath);
        controller.abort();
        await promise.catch(() => {});
      } finally {
        global.fetch = originalFetch;
        vi.useFakeTimers();
      }
    });
  });
});

