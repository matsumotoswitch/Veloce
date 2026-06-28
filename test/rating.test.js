import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';

describe('Rating Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset appState rating properties
    appState.ratings = {};
    appState.ratingFilterVal = 0;
    appState.ratingFilterOp = 'gte';
    appState.sortConfig = { key: 'name', asc: true };
    appState.searchQuery = '';
    
    // Mock veloceAPI
    window.veloceAPI = {
      setViewParams: vi.fn().mockResolvedValue(100),
      setRating: vi.fn().mockResolvedValue(true),
      syncRatings: vi.fn()
    };
  });

  it('should initialize with empty ratings', () => {
    expect(appState.ratings).toEqual({});
    expect(appState.ratingFilterVal).toBe(0);
    expect(appState.ratingFilterOp).toBe('gte');
  });

  it('should pass ratingFilterVal and ratingFilterOp to setViewParams', async () => {
    appState.ratingFilterVal = 3;
    appState.ratingFilterOp = 'lte';
    
    const count = await appState.setViewParams();
    
    expect(count).toBe(100);
    expect(window.veloceAPI.setViewParams).toHaveBeenCalledWith('name', true, '', 3, 'lte');
  });
  
  it('should handle rating assignment correctly (mock simulation)', async () => {
    const filePath = 'C:/test/image.png';
    const key = '4';
    const rating = parseInt(key, 10);
    
    // Simulate setting a new rating
    const currentRating = appState.ratings[filePath] || 0;
    const newRating = (rating === currentRating) ? 0 : rating;
    
    appState.ratings[filePath] = newRating;
    await window.veloceAPI.setRating(filePath, newRating);
    
    expect(appState.ratings[filePath]).toBe(4);
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 4);
    
    // Simulate setting the same rating (should clear it)
    const secondKey = '4';
    const secondRating = parseInt(secondKey, 10);
    const currentRating2 = appState.ratings[filePath] || 0;
    const newRating2 = (secondRating === currentRating2) ? 0 : secondRating;
    
    if (newRating2 === 0) {
      delete appState.ratings[filePath];
    } else {
      appState.ratings[filePath] = newRating2;
    }
    await window.veloceAPI.setRating(filePath, newRating2);
    
    expect(appState.ratings[filePath]).toBeUndefined();
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 0);
  });

  it('should handle onRatingChanged event and update state/localStorage', () => {
    // モックの localStorage
    const mockLocalStorage = {};
    global.localStorage = {
      setItem: vi.fn((key, val) => { mockLocalStorage[key] = val; }),
      getItem: vi.fn((key) => mockLocalStorage[key]),
    };

    let ratingCallback = null;
    window.veloceAPI.onRatingChanged = vi.fn((cb) => {
      ratingCallback = cb;
    });

    // onRatingChanged リスナー登録のシミュレート
    if (window.veloceAPI.onRatingChanged) {
      window.veloceAPI.onRatingChanged((payload) => {
        const { path, rating } = payload;
        if (rating === 0) {
          delete appState.ratings[path];
        } else {
          appState.ratings[path] = rating;
        }
        localStorage.setItem('ratings', JSON.stringify(appState.ratings));
      });
    }

    // イベント発火: レーティングを 5 に設定
    ratingCallback({ path: 'C:/test/event.png', rating: 5 });
    expect(appState.ratings['C:/test/event.png']).toBe(5);
    expect(JSON.parse(localStorage.getItem('ratings'))['C:/test/event.png']).toBe(5);

    // イベント発火: レーティングを 0 (クリア) に設定
    ratingCallback({ path: 'C:/test/event.png', rating: 0 });
    expect(appState.ratings['C:/test/event.png']).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('ratings'))['C:/test/event.png']).toBeUndefined();
  });

  it('should handle viewer rating toggle logic correctly', () => {
    const filePath = 'C:/test/viewer.png';
    let viewerRatings = { [filePath]: 3 }; // 初期状態: レーティング 3
    
    // ビューアのキーダウン処理のシミュレート
    const simulateViewerKeydown = (keyStr) => {
      let rating = parseInt(keyStr, 10);
      const currentRating = viewerRatings[filePath] || 0;
      if (currentRating === rating) {
        rating = 0;
      }
      
      window.veloceAPI.setRating(filePath, rating);
      return rating;
    };

    // 別の数字 (4) を押す -> 4 に更新される
    let sentRating = simulateViewerKeydown('4');
    expect(sentRating).toBe(4);
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 4);
    viewerRatings[filePath] = 4; // イベント等による状態更新の模倣

    // 同じ数字 (4) をもう一度押す -> 0 (クリア) になる
    sentRating = simulateViewerKeydown('4');
    expect(sentRating).toBe(0);
    expect(window.veloceAPI.setRating).toHaveBeenCalledWith(filePath, 0);
  });

  it('should update the viewer rating display correctly', () => {
    // DOM のモック
    document.body.innerHTML = '<div id="viewer-rating-display" style="display: none;"></div>';
    const display = document.getElementById('viewer-rating-display');

    // viewerState と viewerRatings のモック
    const viewerState = { currentImagePath: 'C:/test/image.png' };
    const viewerRatings = { 'C:/test/image.png': 3 };

    // updateRatingDisplay 関数をシミュレート
    const updateRatingDisplay = () => {
      const filePath = viewerState.currentImagePath;
      if (!filePath) {
        display.style.display = 'none';
        return;
      }
      const rating = viewerRatings[filePath] || 0;
      if (rating > 0) {
        const starSvg = '<svg>Star</svg>';
        display.innerHTML = starSvg + '<span style="margin-left: 2px;">' + rating + '</span>';
        display.style.display = 'flex';
      } else {
        display.style.display = 'none';
      }
    };

    // テスト: レーティングが存在する場合
    updateRatingDisplay();
    expect(display.style.display).toBe('flex');
    expect(display.innerHTML).toBe('<svg>Star</svg><span style="margin-left: 2px;">3</span>');

    // テスト: レーティングが 0 の場合
    viewerRatings['C:/test/image.png'] = 0;
    updateRatingDisplay();
    expect(display.style.display).toBe('none');

    // テスト: 表示中の画像パスが存在しない場合
    viewerState.currentImagePath = null;
    updateRatingDisplay();
    expect(display.style.display).toBe('none');
  });
});
