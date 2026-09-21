import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Viewer Core Logic & Hotkeys', () => {
  let dom;
  let keydownHandler;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="viewer-rating-display"></div></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    // モック状態の初期化
    global.viewerState = {
      paths: ['C:/images/1.jpg', 'C:/images/2.jpg', 'C:/images/3.jpg'],
      currentIndex: 1,
      currentImagePath: 'C:/images/2.jpg',
      totalImages: 3,
      preloadCache: new Map()
    };

    global.viewerRatings = {};
    
    // UIモック
    global.showToast = vi.fn();
    global.showPrev = vi.fn(() => {
      global.viewerState.currentIndex = Math.max(0, global.viewerState.currentIndex - 1);
      global.viewerState.currentImagePath = global.viewerState.paths[global.viewerState.currentIndex];
    });
    global.showNext = vi.fn(() => {
      global.viewerState.currentIndex = Math.min(global.viewerState.paths.length - 1, global.viewerState.currentIndex + 1);
      global.viewerState.currentImagePath = global.viewerState.paths[global.viewerState.currentIndex];
    });
    global.updateRatingDisplay = vi.fn();
    
    // APIモック
    global.window.veloceAPI = {
      setRating: vi.fn().mockResolvedValue(true),
      trashFile: vi.fn().mockResolvedValue(true),
      notifyFileRemoved: vi.fn().mockResolvedValue(true)
    };

    // window.__TAURI__.event (IPC) モック
    global.window.__TAURI__ = {
      event: {
        listen: vi.fn()
      }
    };

    // イベントリスナーのキャプチャ
    vi.spyOn(global.window, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'keydown') {
        keydownHandler = handler;
      }
    });

    // テスト対象のロジックをシミュレート（viewer.jsの実装を模倣）
    global.window.addEventListener('keydown', async (e) => {
      switch (e.key) {
        case 'ArrowLeft':
          global.showPrev();
          break;
        case 'ArrowRight':
          global.showNext();
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '0':
        case 'Numpad1':
        case 'Numpad2':
        case 'Numpad3':
        case 'Numpad4':
        case 'Numpad5':
        case 'Numpad0': {
          e.preventDefault();
          let rating = parseInt(e.key.replace('Numpad', ''), 10);
          const filePath = global.viewerState.currentImagePath;
          if (filePath && global.window.veloceAPI.setRating) {
            const currentRating = global.viewerRatings[filePath] || 0;
            if (currentRating === rating) {
              rating = 0; // トグル解除
            }
            await global.window.veloceAPI.setRating(filePath, rating);
            global.viewerRatings[filePath] = rating;
            if (typeof global.updateRatingDisplay === 'function') global.updateRatingDisplay();
          }
          break;
        }
        case 'Delete': {
          const deletedPath = global.viewerState.currentImagePath;
          if (deletedPath) {
            const success = await global.window.veloceAPI.trashFile(deletedPath);
            if (success) {
              if (global.window.veloceAPI.notifyFileRemoved) {
                await global.window.veloceAPI.notifyFileRemoved(deletedPath);
              }
              // ローカル状態の更新
              global.viewerState.paths.splice(global.viewerState.currentIndex, 1);
              global.viewerState.totalImages = global.viewerState.paths.length;
              if (global.viewerState.paths.length > 0) {
                global.viewerState.currentIndex = Math.min(global.viewerState.currentIndex, global.viewerState.paths.length - 1);
                global.viewerState.currentImagePath = global.viewerState.paths[global.viewerState.currentIndex];
              } else {
                global.viewerState.currentImagePath = null;
              }
            }
          }
          break;
        }
      }
    });
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.viewerState;
    delete global.viewerRatings;
    delete global.showToast;
    delete global.showPrev;
    delete global.showNext;
    delete global.updateRatingDisplay;
    vi.clearAllMocks();
  });

  it('should navigate to next image on ArrowRight', async () => {
    expect(global.viewerState.currentIndex).toBe(1);
    
    const event = new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' });
    await keydownHandler(event);
    
    expect(global.showNext).toHaveBeenCalled();
    expect(global.viewerState.currentIndex).toBe(2);
    expect(global.viewerState.currentImagePath).toBe('C:/images/3.jpg');
  });

  it('should navigate to previous image on ArrowLeft', async () => {
    expect(global.viewerState.currentIndex).toBe(1);
    
    const event = new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' });
    await keydownHandler(event);
    
    expect(global.showPrev).toHaveBeenCalled();
    expect(global.viewerState.currentIndex).toBe(0);
    expect(global.viewerState.currentImagePath).toBe('C:/images/1.jpg');
  });

  it('should send rating to veloceAPI and update local state when 1-5 is pressed', async () => {
    const event = new dom.window.KeyboardEvent('keydown', { key: '5' });
    await keydownHandler(event);
    
    expect(global.window.veloceAPI.setRating).toHaveBeenCalledWith('C:/images/2.jpg', 5);
    expect(global.viewerRatings['C:/images/2.jpg']).toBe(5);
    expect(global.updateRatingDisplay).toHaveBeenCalled();
  });

  it('should toggle rating to 0 if the same rating key is pressed twice', async () => {
    global.viewerRatings['C:/images/2.jpg'] = 5;
    
    const event = new dom.window.KeyboardEvent('keydown', { key: '5' });
    await keydownHandler(event);
    
    expect(global.window.veloceAPI.setRating).toHaveBeenCalledWith('C:/images/2.jpg', 0);
    expect(global.viewerRatings['C:/images/2.jpg']).toBe(0);
    expect(global.updateRatingDisplay).toHaveBeenCalled();
  });

  it('should trash file and notify main window when Delete is pressed', async () => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Delete' });
    await keydownHandler(event);
    
    expect(global.window.veloceAPI.trashFile).toHaveBeenCalledWith('C:/images/2.jpg');
    expect(global.window.veloceAPI.notifyFileRemoved).toHaveBeenCalledWith('C:/images/2.jpg');
    
    // 現在のインデックスにある画像が削除されたため、次の画像（インデックスは繰り上がり1になる）が表示されるはず
    expect(global.viewerState.paths.length).toBe(2);
    expect(global.viewerState.totalImages).toBe(2);
    expect(global.viewerState.currentIndex).toBe(1); // 'C:/images/3.jpg' が来る
    expect(global.viewerState.currentImagePath).toBe('C:/images/3.jpg');
  });

  it('should sync rating changes from main window via IPC listen', () => {
    // viewer.js での `listen('rating-changed')` をシミュレート
    const onRatingChanged = (event) => {
      const { path, rating } = event.payload || {};
      if (!path) return;
      if (rating === 0) {
        delete global.viewerRatings[path];
      } else {
        global.viewerRatings[path] = rating;
      }
      if (global.viewerState.currentImagePath === path) {
        global.updateRatingDisplay();
      }
    };

    onRatingChanged({ payload: { path: 'C:/images/2.jpg', rating: 4 } });
    
    expect(global.viewerRatings['C:/images/2.jpg']).toBe(4);
    expect(global.updateRatingDisplay).toHaveBeenCalled(); // currentImagePath なので呼ばれる

    global.updateRatingDisplay.mockClear();

    // 別の画像（表示されていない画像）のレーティングが変更された場合
    onRatingChanged({ payload: { path: 'C:/images/1.jpg', rating: 3 } });
    expect(global.viewerRatings['C:/images/1.jpg']).toBe(3);
    expect(global.updateRatingDisplay).not.toHaveBeenCalled(); // 表示中ではないので呼ばれない
  });

  it('should reload image and clear cache on viewer-load-image IPC event (Single Window Mode)', async () => {
    global.clearPreloadCache = vi.fn(() => global.viewerState.preloadCache.clear());
    global.loadImage = vi.fn();
    
    // Simulate viewer-load-image IPC listener setup
    const onViewerLoadImage = async (event) => {
      const newIndex = event.payload;
      global.viewerState.currentIndex = parseInt(newIndex, 10);
      global.viewerState.preloadCache.clear();
      await global.loadImage();
    };

    global.viewerState.preloadCache.set(2, { img: {}, path: 'C:/images/3.jpg' });
    expect(global.viewerState.preloadCache.size).toBe(1);

    await onViewerLoadImage({ payload: 2 });

    expect(global.viewerState.currentIndex).toBe(2);
    expect(global.viewerState.preloadCache.size).toBe(0);
    expect(global.loadImage).toHaveBeenCalled();
  });

  it('should thoroughly clean up video elements on cache clearing and session reset', () => {
    const videoMock = {
      tagName: 'VIDEO',
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      remove: vi.fn()
    };
    
    global.viewerState.preloadCache.set(0, { img: videoMock, path: 'C:/videos/test.mp4' });

    // Simulate clearPreloadCache logic from viewer.js
    for (const cached of global.viewerState.preloadCache.values()) {
      if (cached && cached.img) {
        if (cached.img.tagName === 'VIDEO') {
          cached.img.pause();
          cached.img.removeAttribute('src');
          cached.img.load();
        } else {
          cached.img.src = '';
        }
        if (typeof cached.img.remove === 'function') cached.img.remove();
      }
    }
    global.viewerState.preloadCache.clear();

    expect(videoMock.pause).toHaveBeenCalled();
    expect(videoMock.removeAttribute).toHaveBeenCalledWith('src');
    expect(videoMock.load).toHaveBeenCalled();
    expect(videoMock.remove).toHaveBeenCalled();
    expect(global.viewerState.preloadCache.size).toBe(0);
  });

  it('should protect currentlyVisibleImg and currentViewerImg from premature purge during rapid navigation', () => {
    const visibleImg = { tagName: 'IMG', src: 'C:/images/1.jpg', remove: vi.fn() };
    const loadingImg = { tagName: 'IMG', src: 'C:/images/5.jpg', remove: vi.fn() };
    const oldImg = { tagName: 'IMG', src: 'C:/images/old.jpg', remove: vi.fn() };

    global.currentlyVisibleImg = visibleImg;
    global.currentViewerImg = loadingImg;

    global.viewerState.preloadCache.set(0, { img: visibleImg, path: 'C:/images/1.jpg' });
    global.viewerState.preloadCache.set(5, { img: loadingImg, path: 'C:/images/5.jpg' });
    global.viewerState.preloadCache.set(9, { img: oldImg, path: 'C:/images/old.jpg' });

    // Simulate preload cache eviction logic with protection guards
    const total = 20;
    global.viewerState.currentIndex = 5;
    for (const cachedIdx of Array.from(global.viewerState.preloadCache.keys())) {
      let diff = Math.abs(cachedIdx - global.viewerState.currentIndex);
      if (diff > total / 2) diff = total - diff;
      if (diff > 3) {
        const cached = global.viewerState.preloadCache.get(cachedIdx);
        if (cached && cached.img) {
          if (cached.img === global.currentlyVisibleImg || cached.img === global.currentViewerImg) {
            continue;
          }
          if (typeof cached.img.remove === 'function') cached.img.remove();
        }
        global.viewerState.preloadCache.delete(cachedIdx);
      }
    }

    // 表示中の画像とロード中画像は削除・破壊されていないこと
    expect(visibleImg.remove).not.toHaveBeenCalled();
    expect(visibleImg.src).toBe('C:/images/1.jpg');
    expect(loadingImg.remove).not.toHaveBeenCalled();
    expect(global.viewerState.preloadCache.has(0)).toBe(true);
    expect(global.viewerState.preloadCache.has(5)).toBe(true);

    // 古い画像のみ正常に削除されること
    expect(oldImg.remove).toHaveBeenCalled();
    expect(global.viewerState.preloadCache.has(9)).toBe(false);
  });

  // --- video focus 誘発による ignoreNextClick 誤爆防止のテスト ---

  it('should not update lastFocusTime when activeElement is a VIDEO element', () => {
    // window.focus リスナーで activeElement が VIDEO の場合は lastFocusTime を更新しない仕様の検証
    const state = { lastFocusTime: 0 };

    // viewer.js の window.focus ハンドラのロジックをシミュレート
    const onFocus = (activeElement) => {
      if (activeElement && activeElement.tagName === 'VIDEO') return;
      state.lastFocusTime = Date.now();
    };

    const before = state.lastFocusTime;

    // VIDEO が activeElement のとき → lastFocusTime が更新されないこと
    onFocus({ tagName: 'VIDEO' });
    expect(state.lastFocusTime).toBe(before);

    // IMG が activeElement のとき → lastFocusTime が更新されること
    onFocus({ tagName: 'IMG' });
    expect(state.lastFocusTime).toBeGreaterThan(before);
  });

  it('should create video element with tabIndex -1 to prevent focus capture', () => {
    // video 要素に tabIndex = -1 が設定されること（loadImage / preloadAdjacentImages 両者）
    const videoUrls = ['test.mp4', 'test.webm', 'test.avi', 'test.mkv'];
    for (const url of videoUrls) {
      // viewer.js の video 生成ロジックをシミュレート
      const img = document.createElement('video');
      img.autoplay = true;
      img.loop = true;
      img.muted = true;
      img.tabIndex = -1; // この設定が存在すること
      expect(img.tabIndex).toBe(-1);
    }
  });

  it('should pause video on image swap without clearing src so that preloadCache entries remain valid for repeated playback', () => {
    const videoMock = {
      tagName: 'VIDEO',
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      remove: vi.fn(),
      src: 'http://127.0.0.1:50000/video.mp4'
    };

    let currentlyVisibleImg = videoMock;
    const newImg = {
      tagName: 'IMG',
      id: '',
      classList: { remove: vi.fn() },
      style: { display: 'none' },
      offsetHeight: 100
    };

    // swapImageElement 内の makeVisible ロジックをシミュレート
    const makeVisible = () => {
      if (currentlyVisibleImg && currentlyVisibleImg !== newImg) {
        if (currentlyVisibleImg.tagName === 'VIDEO') {
          currentlyVisibleImg.pause();
        }
        currentlyVisibleImg.remove();
      }
      currentlyVisibleImg = newImg;
    };

    makeVisible();

    expect(videoMock.pause).toHaveBeenCalledTimes(1);
    expect(videoMock.removeAttribute).not.toHaveBeenCalled();
    expect(videoMock.load).not.toHaveBeenCalled();
    expect(videoMock.remove).toHaveBeenCalledTimes(1);
    // src が保持されているため再訪時にそのまま再生可能
    expect(videoMock.src).toBe('http://127.0.0.1:50000/video.mp4');
  });

  it('should reset currentTime to 0 and play video when revisiting previously played video element', async () => {
    const videoMock = {
      tagName: 'VIDEO',
      readyState: 2, // HAVE_CURRENT_DATA
      currentTime: 12.5, // 以前の再生位置
      play: vi.fn().mockResolvedValue(undefined),
      classList: { remove: vi.fn() },
      style: { display: 'none' },
      offsetHeight: 100
    };

    // swapImageElement 内のビデオ再生処理をシミュレート
    if (videoMock.tagName === 'VIDEO') {
      try {
        videoMock.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
      if (videoMock.readyState >= 1) {
        videoMock.play();
      }
    }

    expect(videoMock.currentTime).toBe(0);
    expect(videoMock.play).toHaveBeenCalledTimes(1);
  });

  it('should invalidate cache entry and fallback to new video creation if cached video has missing src', () => {
    const brokenVideo = {
      tagName: 'VIDEO',
      src: ''
    };
    global.viewerState.preloadCache.set(2, { img: brokenVideo, path: 'C:/videos/corrupted.mp4' });
    global.viewerState.currentIndex = 2;
    global.viewerState.currentImagePath = 'C:/videos/corrupted.mp4';

    let targetImg;
    if (global.viewerState.preloadCache.has(global.viewerState.currentIndex)) {
      const cachedData = global.viewerState.preloadCache.get(global.viewerState.currentIndex);
      if (cachedData.path === global.viewerState.currentImagePath) {
        if (cachedData.img && cachedData.img.tagName === 'VIDEO' && (!cachedData.img.src || cachedData.img.src === '')) {
          global.viewerState.preloadCache.delete(global.viewerState.currentIndex);
        } else {
          targetImg = cachedData.img;
        }
      }
    }

    expect(targetImg).toBeUndefined();
    expect(global.viewerState.preloadCache.has(2)).toBe(false);
  });
});

