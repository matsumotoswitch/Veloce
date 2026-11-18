/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Viewer initialization order, chunk hydration, and deferred preload', () => {
  let originalVeloceAPI;
  let originalTauri;
  let originalVideoServerPort;
  let originalVideoServerToken;

  beforeEach(() => {
    vi.resetModules();
    originalVeloceAPI = window.veloceAPI;
    originalTauri = window.__TAURI__;
    originalVideoServerPort = window.videoServerPort;
    originalVideoServerToken = window.videoServerToken;

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
    window.videoServerPort = originalVideoServerPort;
    window.videoServerToken = originalVideoServerToken;
    vi.restoreAllMocks();
  });

  it('registers viewer-init-session listener before fetching port/token in parallel and notifies pool ready', async () => {
    const callOrder = [];
    let resolvePort;
    let resolveToken;
    let portStarted = false;
    let tokenStarted = false;

    window.__TAURI__ = {
      event: {
        listen: vi.fn((eventName) => {
          callOrder.push(`listen:${eventName}`);
          return Promise.resolve(() => {});
        })
      }
    };

    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      notifyViewerPoolReady: vi.fn(() => {
        callOrder.push('notifyViewerPoolReady');
        return Promise.resolve();
      }),
      getVideoServerPort: vi.fn(() => {
        portStarted = true;
        callOrder.push('getVideoServerPort');
        return new Promise((resolve) => { resolvePort = resolve; });
      }),
      getVideoServerToken: vi.fn(() => {
        tokenStarted = true;
        callOrder.push('getVideoServerToken');
        return new Promise((resolve) => { resolveToken = resolve; });
      }),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({}),
      getViewerImage: vi.fn().mockResolvedValue(null),
      showWindow: vi.fn().mockResolvedValue(true)
    };

    await import('../src/viewer/viewer.js');

    window.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // リスナー登録が port / token 取得より先に呼ばれていること
    const initSessionIdx = callOrder.indexOf('listen:viewer-init-session');
    const loadImageIdx = callOrder.indexOf('listen:viewer-load-image');
    const poolReadyIdx = callOrder.indexOf('notifyViewerPoolReady');
    const portIdx = callOrder.indexOf('getVideoServerPort');
    const tokenIdx = callOrder.indexOf('getVideoServerToken');

    expect(initSessionIdx).toBeGreaterThanOrEqual(0);
    expect(loadImageIdx).toBeGreaterThanOrEqual(0);
    expect(poolReadyIdx).toBeGreaterThan(initSessionIdx);
    expect(portIdx).toBeGreaterThan(initSessionIdx);
    expect(tokenIdx).toBeGreaterThan(initSessionIdx);

    // port 解決前でも token 取得が並列に開始されていること
    expect(portStarted).toBe(true);
    expect(tokenStarted).toBe(true);

    resolvePort(45678);
    resolveToken('tok_parallel');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.videoServerPort).toBe(45678);
    expect(window.videoServerToken).toBe('tok_parallel');
  });

  it('hydrates viewerState.paths from chunk payload and also handles legacy payload without chunk', async () => {
    window.__TAURI__ = {
      event: { listen: vi.fn().mockResolvedValue(() => {}) }
    };
    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      getViewerImage: vi.fn().mockResolvedValue(null),
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({})
    };

    const { applyViewerInitSessionPayload } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // チャンク同梱ペイロード
    applyViewerInitSessionPayload({
      index: 10,
      path: 'C:\\img\\10.png',
      total: 50,
      chunkStart: 8,
      chunk: [
        'C:\\img\\8.png',
        'C:\\img\\9.png',
        'C:\\img\\10.png',
        'C:\\img\\11.png',
        'C:\\img\\12.png'
      ]
    });

    expect(viewerState.currentIndex).toBe(10);
    expect(viewerState.currentImagePath).toBe('C:\\img\\10.png');
    expect(viewerState.totalImages).toBe(50);
    expect(viewerState.paths).toHaveLength(50);
    expect(viewerState.paths[7]).toBeNull();
    expect(viewerState.paths[8]).toBe('C:\\img\\8.png');
    expect(viewerState.paths[9]).toBe('C:\\img\\9.png');
    expect(viewerState.paths[10]).toBe('C:\\img\\10.png');
    expect(viewerState.paths[11]).toBe('C:\\img\\11.png');
    expect(viewerState.paths[12]).toBe('C:\\img\\12.png');
    expect(viewerState.paths[13]).toBeNull();

    // チャンク無し（旧形式）ペイロードでも初期化が完了すること
    applyViewerInitSessionPayload({
      index: 3,
      path: 'C:\\legacy\\3.png',
      total: 10
    });

    expect(viewerState.currentIndex).toBe(3);
    expect(viewerState.currentImagePath).toBe('C:\\legacy\\3.png');
    expect(viewerState.totalImages).toBe(10);
    expect(viewerState.paths).toHaveLength(10);
    expect(viewerState.paths[3]).toBe('C:\\legacy\\3.png');
    expect(viewerState.paths[2]).toBeNull();
    expect(viewerState.paths[4]).toBeNull();
  });

  it('defers adjacent preloading until displayed image decode resolves and ignores stale sequence', async () => {
    window.__TAURI__ = {
      event: { listen: vi.fn().mockResolvedValue(() => {}) }
    };
    const getViewerImageMock = vi.fn().mockResolvedValue(null);
    window.veloceAPI = {
      convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
      getViewerImage: getViewerImageMock,
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({})
    };

    const { loadImage, applyViewerInitSessionPayload } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // 各 <img> 要素の decode() を手動解決できるようにフックする
    const decodeResolvers = new Map();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      const el = origCreateElement(tagName, options);
      if (String(tagName).toLowerCase() === 'img') {
        el.decode = () => new Promise((resolve) => {
          decodeResolvers.set(el.src, resolve);
        });
      }
      return el;
    });

    applyViewerInitSessionPayload({
      index: 2,
      path: 'C:\\img\\2.png',
      total: 6,
      chunkStart: 0,
      chunk: [
        'C:\\img\\0.png',
        'C:\\img\\1.png',
        'C:\\img\\2.png',
        'C:\\img\\3.png',
        'C:\\img\\4.png',
        'C:\\img\\5.png'
      ]
    });
    viewerState.preloadCache.clear();

    // 1枚目ロード開始（decode 未解決）
    await loadImage();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // decode 解決前は現在画像(2)のみキャッシュにあり、隣接画像(3,4,5,1)のプリロードは始まっていないこと
    expect(viewerState.preloadCache.has(2)).toBe(true);
    expect(viewerState.preloadCache.has(3)).toBe(false);
    expect(viewerState.preloadCache.has(4)).toBe(false);
    expect(viewerState.preloadCache.has(1)).toBe(false);

    // decode 解決後に隣接プリロードが開始されること（チャンク同梱済みのため getViewerImage IPC 不要）
    const img2Src = viewerState.preloadCache.get(2).img.src;
    decodeResolvers.get(img2Src)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(viewerState.preloadCache.has(3)).toBe(true);
    expect(viewerState.preloadCache.has(4)).toBe(true);
    expect(viewerState.preloadCache.has(5)).toBe(true);
    expect(viewerState.preloadCache.has(1)).toBe(true);
    expect(getViewerImageMock).not.toHaveBeenCalled();

    // 連続ナビゲーション時の陳腐化確認:
    // index 0 の decode が未解決のまま index 5 へ切り替えた場合、index 0 の遅延解決でプリロードが走らないこと
    viewerState.preloadCache.clear();
    viewerState.currentIndex = 0;
    await loadImage();
    const img0Src = viewerState.preloadCache.get(0).img.src;

    viewerState.currentIndex = 5;
    await loadImage();
    const img5Src = viewerState.preloadCache.get(5).img.src;

    // 古い index 0 の decode を解決しても隣接(1,2,3)はプリロードされないこと
    decodeResolvers.get(img0Src)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewerState.preloadCache.has(1)).toBe(false);
    expect(viewerState.preloadCache.has(2)).toBe(false);

    // 最新の index 5 の decode 解決で初めて隣接(0,1,2,4)がプリロードされること
    decodeResolvers.get(img5Src)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewerState.preloadCache.has(1)).toBe(true);
    expect(viewerState.preloadCache.has(4)).toBe(true);
  });
});

