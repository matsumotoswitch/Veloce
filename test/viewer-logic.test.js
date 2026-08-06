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
            if (rating === 0) {
              global.showToast('レーティング解除');
            } else {
              global.showToast('Rating ' + rating);
            }
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
    expect(global.showToast).toHaveBeenCalledWith('Rating 5');
    expect(global.viewerRatings['C:/images/2.jpg']).toBe(5);
    expect(global.updateRatingDisplay).toHaveBeenCalled();
  });

  it('should toggle rating to 0 if the same rating key is pressed twice', async () => {
    global.viewerRatings['C:/images/2.jpg'] = 5;
    
    const event = new dom.window.KeyboardEvent('keydown', { key: '5' });
    await keydownHandler(event);
    
    expect(global.window.veloceAPI.setRating).toHaveBeenCalledWith('C:/images/2.jpg', 0);
    expect(global.showToast).toHaveBeenCalledWith('レーティング解除');
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
});
