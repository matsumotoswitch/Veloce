import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('viewer initial data loading', () => {
  let localStorageMock;
  let originalWindow;

  beforeEach(() => {
    localStorageMock = (() => {
      let store = {};
      return {
        getItem(key) {
          return store[key] || null;
        },
        setItem(key, value) {
          store[key] = value.toString();
        },
        removeItem(key) {
          delete store[key];
        },
        clear() {
          store = {};
        }
      };
    })();

    originalWindow = global.window;
    
    global.window = {
      veloceAPI: {
        convertFileSrc: vi.fn((path) => `convert_src://${path}`),
        showWindow: vi.fn().mockResolvedValue(true)
      },
      __TAURI__: {
        event: {
          listen: vi.fn()
        }
      }
    };
    
    global.localStorage = localStorageMock;
    
    // DOM Mock
    global.document = {
      createElement: vi.fn((tag) => {
        if (tag === 'video') {
          return { readyState: 0, addEventListener: vi.fn() };
        }
        return { style: {}, classList: { add: vi.fn(), remove: vi.fn() } };
      }),
      title: ''
    };
  });

  afterEach(() => {
    global.window = originalWindow;
    delete global.localStorage;
    delete global.document;
    vi.restoreAllMocks();
  });

  it('should apply viewerInitialData correctly and clear it from localStorage', () => {
    // モックの初期データセット
    const testData = { path: 'C:/images/test.jpg', total: 100 };
    localStorage.setItem('viewerInitialData', JSON.stringify(testData));

    // viewerState, viewerUI などのモック
    const viewerState = { currentIndex: 0, paths: null, totalImages: 0, currentImagePath: null, isZoomed: false };
    const viewerUI = {
      elements: {
        viewerImg: { src: '', parentNode: { replaceChild: vi.fn() } }
      },
      updateImageRendering: vi.fn()
    };
    
    // Viewer側の関数をシミュレート
    function getStreamUrl(path, convertedPath) {
      return `stream://${convertedPath}`;
    }

    function applyViewerInitialData() {
      const initialDataJson = localStorage.getItem('viewerInitialData');
      if (initialDataJson) {
        try {
          const initialData = JSON.parse(initialDataJson);
          viewerState.currentImagePath = initialData.path;
          viewerState.totalImages = initialData.total;
          
          if (!viewerState.paths) viewerState.paths = new Array(initialData.total).fill(null);
          
          if (viewerState.paths && viewerState.currentIndex >= 0) {
            viewerState.paths[viewerState.currentIndex] = initialData.path;
          }
          const assetUrl = getStreamUrl(initialData.path, window.veloceAPI.convertFileSrc(initialData.path));
          if (viewerUI.elements.viewerImg) {
            if (initialData.path.toLowerCase().endsWith('.mp4')) {
              // mp4 logic omitted for simplicity
            } else {
              viewerUI.elements.viewerImg.src = assetUrl;
            }
          }
          document.title = `Veloce Viewer - ${viewerState.currentIndex + 1} / ${viewerState.totalImages}`;
        } catch (e) {}
        localStorage.removeItem('viewerInitialData');
      }
    }

    // 実行
    applyViewerInitialData();

    // 検証
    expect(viewerState.currentImagePath).toBe('C:/images/test.jpg');
    expect(viewerState.totalImages).toBe(100);
    expect(viewerState.paths).toHaveLength(100);
    expect(viewerState.paths[0]).toBe('C:/images/test.jpg');
    expect(viewerUI.elements.viewerImg.src).toBe('stream://convert_src://C:/images/test.jpg');
    expect(document.title).toBe('Veloce Viewer - 1 / 100');
    expect(localStorage.getItem('viewerInitialData')).toBeNull(); // 使用後に削除されること
  });

  it('should ignore viewerInitialData when index does not match', () => {
    // 別のウィンドウが書き込んだindex=5のデータ
    const staleData = { path: 'C:/images/stale.jpg', total: 100, index: 5 };
    localStorage.setItem('viewerInitialData', JSON.stringify(staleData));

    // 現在のウィンドウはindex=0を開こうとしている
    const viewerState = { currentIndex: 0, paths: null, totalImages: 0, currentImagePath: null };

    function applyViewerInitialData() {
      const initialDataJson = localStorage.getItem('viewerInitialData');
      if (initialDataJson) {
        try {
          const initialData = JSON.parse(initialDataJson);
          if (typeof initialData.index !== 'number' || initialData.index === viewerState.currentIndex) {
            viewerState.currentImagePath = initialData.path;
            viewerState.totalImages = initialData.total;
          }
        } catch (e) {}
        localStorage.removeItem('viewerInitialData');
      }
    }

    applyViewerInitialData();

    // インデックス不一致のためstaleデータは無視される
    expect(viewerState.currentImagePath).toBeNull();
    expect(viewerState.totalImages).toBe(0);
    expect(localStorage.getItem('viewerInitialData')).toBeNull();
  });

  it('should cleanly reset and apply structured viewer-init-session payload', () => {
    const viewerState = {
      currentIndex: 5,
      paths: ['old1.jpg', 'old2.jpg'],
      totalImages: 2,
      currentImagePath: 'old1.jpg',
      preloadCache: new Map([[5, { path: 'old1.jpg' }]])
    };

    const sessionPayload = {
      index: 2,
      path: 'C:/images/new2.jpg',
      total: 50
    };

    function handleViewerInitSession(payload) {
      let newIndex = 0;
      let targetPath = null;
      let total = 0;
      if (typeof payload === 'number') {
        newIndex = payload;
      } else if (payload && typeof payload === 'object') {
        newIndex = typeof payload.index === 'number' ? payload.index : 0;
        targetPath = payload.path || null;
        total = typeof payload.total === 'number' ? payload.total : 0;
      }
      viewerState.currentIndex = newIndex;
      viewerState.preloadCache.clear();
      viewerState.paths = total > 0 ? new Array(total).fill(null) : null;
      viewerState.currentImagePath = targetPath;
      viewerState.totalImages = total;
      if (viewerState.paths && targetPath && viewerState.currentIndex >= 0) {
        viewerState.paths[viewerState.currentIndex] = targetPath;
      }
    }

    handleViewerInitSession(sessionPayload);

    expect(viewerState.currentIndex).toBe(2);
    expect(viewerState.currentImagePath).toBe('C:/images/new2.jpg');
    expect(viewerState.totalImages).toBe(50);
    expect(viewerState.paths).toHaveLength(50);
    expect(viewerState.paths[2]).toBe('C:/images/new2.jpg');
    expect(viewerState.paths[0]).toBeNull();
    expect(viewerState.preloadCache.size).toBe(0);
  });
});
