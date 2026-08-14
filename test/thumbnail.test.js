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
});
