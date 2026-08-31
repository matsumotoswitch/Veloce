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
});
