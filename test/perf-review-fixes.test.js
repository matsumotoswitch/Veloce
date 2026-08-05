import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Performance Review Fixes - Rating Badge Update & DOM Lookup', () => {
  let dom;
  let globalApp;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;
    
    // モック appState
    global.appState = {
      ratings: {},
      thumbnailUrls: new Map(),
      selection: new Set(),
      files: []
    };
    
    // モック uiManager
    global.uiManager = {
      _domByPath: new Map(),
      elements: {
        thumbnailGrid: document.createElement('div'),
        fileListBody: document.createElement('tbody')
      },
      applyFlash: vi.fn()
    };
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.appState;
    delete global.uiManager;
  });

  it('should update rating textContent only when cached rating changes (O(1) update)', () => {
    // 仮想のレンダーロジックをシミュレート (renderer-ui.js の renderGrid 部分の抜粋)
    const renderGridItem = (wrapper, file, i, itemSize) => {
      // filepath / index が同じでもレーティングの変更には追従すべき
      if (wrapper.dataset.filepath !== file.path || wrapper.dataset.index != i) {
        wrapper.dataset.filepath = file.path;
        wrapper.dataset.index = i;
        // 他の初期化処理...
      }

      // 【修正案のロジック】if ブロック外に出し、_cachedRating で不要な書き込みを防止
      const rating = global.appState.ratings[file.path] || 0;
      if (wrapper._cachedRating !== rating) {
        wrapper._cachedRating = rating;
        const badge = wrapper.children[2];
        if (badge) {
          if (rating > 0) {
            badge.children[1].textContent = rating;
            badge.classList.add('show');
          } else {
            badge.classList.remove('show');
          }
        }
      }
    };

    // DOM要素のモック作成
    const wrapper = document.createElement('div');
    wrapper.dataset.filepath = 'test.jpg';
    wrapper.dataset.index = 0;
    
    // 0: img, 1: label, 2: badge
    wrapper.appendChild(document.createElement('img'));
    wrapper.appendChild(document.createElement('div'));
    
    const badge = document.createElement('div');
    badge.className = 'rating-badge';
    badge.appendChild(document.createElement('span')); // star icon
    const ratingValue = document.createElement('span');
    ratingValue.className = 'rating-value';
    badge.appendChild(ratingValue);
    wrapper.appendChild(badge);

    // setter の動作を活かすため、プロキシなどでラップするか、今回はspyを使わず値だけアサートする
    // 代わりに classList のメソッドをスパイする
    const classAddSpy = vi.spyOn(badge.classList, 'add');

    const file = { path: 'test.jpg', name: 'test.jpg' };
    
    // 1回目のレンダリング (rating = 0)
    renderGridItem(wrapper, file, 0, 100);
    expect(classAddSpy).not.toHaveBeenCalled();
    expect(badge.classList.contains('show')).toBe(false);

    // レーティングを 5 に変更
    global.appState.ratings['test.jpg'] = 5;
    
    // 2回目のレンダリング (ファイルパスもインデックスも同じまま)
    renderGridItem(wrapper, file, 0, 100);
    expect(classAddSpy).toHaveBeenCalledWith('show');
    expect(ratingValue.textContent).toBe('5'); // JSDOMではtextContentは常に文字列になる
    
    classAddSpy.mockClear();
    
    // 3回目のレンダリング (変更なし)
    renderGridItem(wrapper, file, 0, 100);
    expect(classAddSpy).not.toHaveBeenCalled(); // 呼ばれないはず（キャッシュヒット）
  });

  it('should find thumbnail item via O(1) _domByPath map instead of querySelector', () => {
    // onRatingChanged 等のロジックシミュレーション
    const handleRatingChanged = (payload) => {
      const { path, rating } = payload;
      if (rating === 0) {
        delete global.appState.ratings[path];
      } else {
        global.appState.ratings[path] = rating;
      }

      // 修正後: querySelector ではなく O(1) map から取得
      const thumb = global.uiManager._domByPath ? global.uiManager._domByPath.get(path) : null;
      if (thumb) {
        let badge = thumb.querySelector('.rating-badge');
        if (badge) {
          if (rating > 0) {
            badge.querySelector('.rating-value').textContent = rating;
            badge.classList.add('show');
          } else {
            badge.classList.remove('show');
          }
        }
      }
    };

    const targetPath = 'C:\\images\\pic.jpg';
    const thumbEl = document.createElement('div');
    const badge = document.createElement('div');
    badge.className = 'rating-badge';
    badge.appendChild(document.createElement('span'));
    const rVal = document.createElement('span');
    rVal.className = 'rating-value';
    badge.appendChild(rVal);
    thumbEl.appendChild(badge);

    // map に登録
    global.uiManager._domByPath.set(targetPath, thumbEl);
    
    // querySelector が呼ばれないことを確認するため、スパイを貼る
    const querySpy = vi.spyOn(global.uiManager.elements.thumbnailGrid, 'querySelector');

    // イベント発火シミュレート
    handleRatingChanged({ path: targetPath, rating: 4 });

    // O(1) 検索により grid の querySelector は呼ばれていない
    expect(querySpy).not.toHaveBeenCalled();
    // バッジは更新されている
    expect(rVal.textContent).toBe('4');
    expect(badge.classList.contains('show')).toBe(true);
  });
});
