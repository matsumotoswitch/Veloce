import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UIManager } from '../src/renderer-ui.js';

describe('Wheel scroll abort logic and infinite loop prevention', () => {
  let uiManager;
  let container;
  let rafSpy;

  beforeEach(() => {
    // requestAnimationFrame を即時実行にモック
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => setTimeout(cb, 0));

    // appState のモック
    window.appState = {
      totalCount: 100,
      imagePaths: [],
      selection: new Set(),
      searchQuery: '',
      thumbnailUrls: new Map(),
      dragState: {}
    };

    container = document.createElement('div');
    container.id = 'center-bottom';
    
    // スクロール可能な状態をモック
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true });
    Object.defineProperty(container, 'scrollHeight', { value: 2000, writable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true });
    
    document.body.appendChild(container);

    uiManager = new UIManager(window.appState);
    uiManager.elements.thumbnailGrid = container;
    
    // initWheelControl を呼び出してリスナーを登録
    uiManager.initWheelControl();
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('ホイールスクロールでアニメーションが進行すること', async () => {
    // targetScroll が計算される
    const wheelEvent = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
    container.dispatchEvent(wheelEvent);

    // deltaY 100 * WHEEL_SCALE_FACTOR(1.5) = 150 の目標位置が設定される
    // 減衰付きアニメーションが走る（最初のフレームで150 * 0.45 = 67.5動くはず）
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(container.scrollTop).toBeGreaterThan(0);
  });

  it('外部からのscrollTop変更（キー移動など）を検知してアニメーションを中断すること', async () => {
    container.scrollTop = 0;
    
    // ホイールスクロールをトリガー
    const wheelEvent = new WheelEvent('wheel', { deltaY: 200, deltaMode: 0, cancelable: true });
    container.dispatchEvent(wheelEvent);
    
    await new Promise(resolve => setTimeout(resolve, 0));
    const firstStepScroll = container.scrollTop;
    
    // アニメーション中に「キーボード操作などでscrollTopが大きく変わった」状態をシミュレート
    // (期待されるscrollTopと実際のscrollTopに20px以上の差をつける)
    container.scrollTop = firstStepScroll + 50; 
    
    // 次のフレームへ
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // アニメーションが中断され、scrollTopが目標位置(300)に向けて進まないことを確認
    // container.scrollTop += (target - container.scrollTop) * 0.45 などの処理が走っていないこと
    expect(container.scrollTop).toBe(firstStepScroll + 50);
  });
});
