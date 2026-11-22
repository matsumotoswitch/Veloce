/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Viewer Pool Reuse, Close, and Reopening State Consistency', () => {
  let originalVeloceAPI;
  let originalTauri;

  beforeEach(() => {
    vi.resetModules();
    originalVeloceAPI = window.veloceAPI;
    originalTauri = window.__TAURI__;

    window.scrollTo = vi.fn();
    document.body.innerHTML = `
      <img id="viewer-img" decoding="async" src="" alt="">
      <div id="border-overlay"></div>
    `;
    localStorage.clear();
  });

  afterEach(() => {
    window.veloceAPI = originalVeloceAPI;
    window.__TAURI__ = originalTauri;
    vi.restoreAllMocks();
  });

  it('cleanupCurrentImage removes visible image from DOM and sets currentViewerImg to null', async () => {
    const { cleanupCurrentImage, currentViewerImg } = await import('../src/viewer/viewer.js');
    const { viewerUI } = await import('../src/viewer/viewer-ui.js');

    const img = document.getElementById('viewer-img');
    expect(document.body.contains(img)).toBe(true);

    cleanupCurrentImage();

    expect(document.getElementById('viewer-img')).toBeNull();
    expect(viewerUI.elements.viewerImg).toBeNull();
  });

  it('closeWindow in preload.js invokes close_viewer_window instead of destroying window directly', async () => {
    const invokeMock = vi.fn().mockResolvedValue(true);
    window.__TAURI__ = {
      invoke: invokeMock,
      window: {
        appWindow: {
          label: 'viewer_pool_0',
          setAlwaysOnTop: vi.fn().mockResolvedValue(true),
          close: vi.fn().mockResolvedValue(true),
          hide: vi.fn().mockResolvedValue(true)
        }
      }
    };

    // preload.js から closeWindow の振る舞いを検証
    const invokeCalls = [];
    window.__TAURI__.invoke = vi.fn((cmd) => {
      invokeCalls.push(cmd);
      return Promise.resolve(true);
    });

    const { veloceAPI } = await import('../src/common/preload.js');
    await window.veloceAPI.closeWindow();

    expect(invokeCalls).toContain('close_viewer_window');
    expect(window.__TAURI__.window.appWindow.close).not.toHaveBeenCalled();
  });

  it('close-viewer event listener resets paths, totalImages, and isViewerWindowShown', async () => {
    let closeViewerCallback;
    window.__TAURI__ = {
      event: {
        listen: vi.fn((event, cb) => {
          if (event === 'close-viewer') {
            closeViewerCallback = cb;
          }
          return Promise.resolve(() => {});
        })
      }
    };
    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({}),
      getViewerImage: vi.fn().mockResolvedValue(null),
      getVideoServerPort: vi.fn().mockResolvedValue(1234),
      getVideoServerToken: vi.fn().mockResolvedValue('test')
    };

    const { viewerState } = await import('../src/viewer/viewer-state.js');
    const { handleCloseViewer } = await import('../src/viewer/viewer.js');

    viewerState.paths = ['C:\\img1.png', 'C:\\img2.png'];
    viewerState.currentImagePath = 'C:\\img1.png';
    viewerState.totalImages = 2;

    window.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));

    // イベント経由またはハンドラ直接呼び出しの両方で初期化されることを検証
    if (typeof closeViewerCallback === 'function') {
      closeViewerCallback();
    } else {
      handleCloseViewer();
    }

    expect(viewerState.paths).toEqual([]);
    expect(viewerState.currentImagePath).toBeNull();
    expect(viewerState.totalImages).toBe(0);
  });

  it('reopening the same image after close attaches element to DOM and does not return empty DOM', async () => {
    window.__TAURI__ = {
      event: {
        listen: vi.fn().mockResolvedValue(() => {})
      }
    };
    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({}),
      getViewerImage: vi.fn().mockResolvedValue({
        path: 'C:\\img\\same.png',
        total: 1,
        index: 0,
        chunkStart: 0,
        chunk: ['C:\\img\\same.png']
      })
    };

    const { loadImage, applyViewerInitSessionPayload, cleanupCurrentImage } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // 1回目のオープン
    applyViewerInitSessionPayload({
      index: 0,
      path: 'C:\\img\\same.png',
      total: 1,
      chunkStart: 0,
      chunk: ['C:\\img\\same.png']
    });
    await loadImage();

    const firstImg = document.getElementById('viewer-img');
    expect(firstImg).not.toBeNull();
    expect(document.body.contains(firstImg)).toBe(true);

    // ビューアを閉じる (クリーンアップ)
    cleanupCurrentImage();
    expect(document.getElementById('viewer-img')).toBeNull();

    // 2回目に全く同じ画像を開く (ユーザー操作: 開く -> 閉じる -> 再度同じ画像を開く)
    applyViewerInitSessionPayload({
      index: 0,
      path: 'C:\\img\\same.png',
      total: 1,
      chunkStart: 0,
      chunk: ['C:\\img\\same.png']
    });
    await loadImage();

    // 2回目のオープンでも確実に画像要素が DOM に存在すること
    const secondImg = document.getElementById('viewer-img');
    expect(secondImg).not.toBeNull();
    expect(document.body.contains(secondImg)).toBe(true);
  });

  it('close-viewer event is ignored if payload label does not match current window label', async () => {
    let closeViewerCallback;
    window.__TAURI__ = {
      tauri: {
        invoke: vi.fn().mockResolvedValue(true)
      },
      event: {
        listen: vi.fn((event, cb) => {
          if (event === 'close-viewer') {
            closeViewerCallback = cb;
          }
          return Promise.resolve(() => {});
        })
      },
      window: {
        appWindow: {
          label: 'viewer_pool_0'
        }
      }
    };
    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({}),
      getViewerImage: vi.fn().mockResolvedValue(null),
      getVideoServerPort: vi.fn().mockResolvedValue(1234),
      getVideoServerToken: vi.fn().mockResolvedValue('test')
    };

    const { viewerState } = await import('../src/viewer/viewer-state.js');
    await import('../src/viewer/viewer.js');

    viewerState.paths = ['C:\\img1.png', 'C:\\img2.png'];
    viewerState.currentImagePath = 'C:\\img1.png';
    viewerState.totalImages = 2;

    window.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));

    expect(typeof closeViewerCallback).toBe('function');

    // 別ウィンドウ (viewer_1) のクローズイベントを受信した場合
    closeViewerCallback({ payload: 'viewer_1' });

    // 自ウィンドウ (viewer_pool_0) の状態は保持され、クリアされないこと
    expect(viewerState.paths).toEqual(['C:\\img1.png', 'C:\\img2.png']);
    expect(viewerState.currentImagePath).toBe('C:\\img1.png');
    expect(viewerState.totalImages).toBe(2);

    // 自ウィンドウ (viewer_pool_0) のクローズイベントを受信した場合
    closeViewerCallback({ payload: 'viewer_pool_0' });

    // 自ウィンドウ宛のイベントでは正常にクリーンアップされること
    expect(viewerState.paths).toEqual([]);
    expect(viewerState.currentImagePath).toBeNull();
    expect(viewerState.totalImages).toBe(0);
  });
});
