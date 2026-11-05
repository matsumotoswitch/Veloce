import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { uiManager } from '../src/renderer/renderer-ui.js';

describe('Thumbnail Size Slider rAF Throttling & Setting Persistence', () => {
  let setupThumbnailSliderEvents;
  let updateThumbnailSize;
  let slider;
  let onUpdateSizeSpy;
  let onUpdateGridSpy;
  let onSaveSettingSpy;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <button id="search-clear-btn" type="button"></button>
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" min="100" max="500" value="120" />
      <div id="thumbnail-slider-tooltip"></div>
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.searchClearBtn = document.getElementById('search-clear-btn');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    const renderer = await import('../src/renderer/renderer.js');
    setupThumbnailSliderEvents = renderer.setupThumbnailSliderEvents;
    updateThumbnailSize = renderer.updateThumbnailSize;
  });

  beforeEach(() => {
    vi.useFakeTimers();

    slider = document.getElementById('thumbnail-size-slider');
    slider.value = '150';
    uiManager.elements.thumbnailSizeSlider = slider;

    // requestAnimationFrame / cancelAnimationFrame をタイマーベースで安全にモック化
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return setTimeout(cb, 16);
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id);
    });

    onUpdateSizeSpy = vi.fn();
    onUpdateGridSpy = vi.fn();
    onSaveSettingSpy = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('inputイベント発火時、CSS変数とツールチップの更新（onUpdateSize）は同期的・即座に実行されること', () => {
    const handle = setupThumbnailSliderEvents(slider, {
      onUpdateSize: onUpdateSizeSpy,
      onUpdateGrid: onUpdateGridSpy,
      onSaveSetting: onSaveSettingSpy
    });

    slider.value = '180';
    slider.dispatchEvent(new Event('input'));

    expect(onUpdateSizeSpy).toHaveBeenCalledTimes(1);
    // rAF前（0ms）なので onUpdateGrid はまだ呼ばれていない
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(0);

    // 16ms経過（1フレーム後）でグリッド再計算が実行される
    vi.advanceTimersByTime(16);
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(1);

    handle.cleanup();
  });

  it('連続して複数回inputイベントが発火した際、onUpdateGridの呼び出しがrAFで1回にスロットリングされること', () => {
    const handle = setupThumbnailSliderEvents(slider, {
      onUpdateSize: onUpdateSizeSpy,
      onUpdateGrid: onUpdateGridSpy,
      onSaveSetting: onSaveSettingSpy
    });

    // 短時間に10回連続でスライダーが動かされたケース
    for (let i = 0; i < 10; i++) {
      slider.value = String(150 + i * 5);
      slider.dispatchEvent(new Event('input'));
    }

    // サイズ・ツールチップ更新は10回即座に同期実行される
    expect(onUpdateSizeSpy).toHaveBeenCalledTimes(10);
    // しかし仮想グリッド再計算はまだ発火していない
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(0);

    // 1フレーム（16ms）進める
    vi.advanceTimersByTime(16);

    // 10回の連続入力に対しても、グリッド再計算は1回のみ実行される（間引き成功）
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(1);

    handle.cleanup();
  });

  it('changeイベント（ドラッグ完了時）に、未完了のrAFが即時キャンセル・確定され、設定が保存されること', () => {
    const handle = setupThumbnailSliderEvents(slider, {
      onUpdateSize: onUpdateSizeSpy,
      onUpdateGrid: onUpdateGridSpy,
      onSaveSetting: onSaveSettingSpy
    });

    // ドラッグ中の入力
    slider.value = '200';
    slider.dispatchEvent(new Event('input'));

    expect(onUpdateGridSpy).toHaveBeenCalledTimes(0);

    // 16ms経過前にドラッグ終了（changeイベント発火）
    slider.dispatchEvent(new Event('change'));

    // 保留中のrAFが待たずに即座に実行され、同期的・確実にグリッド更新と設定保存が実行される
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(1);
    expect(onSaveSettingSpy).toHaveBeenCalledWith('200');

    // その後16ms経過しても二重実行されない
    vi.advanceTimersByTime(16);
    expect(onUpdateGridSpy).toHaveBeenCalledTimes(1);

    handle.cleanup();
  });

  it('updateThumbnailSize() が --thumbnail-size プロパティとツールチップを正しく更新すること', () => {
    slider.value = '240';
    updateThumbnailSize();

    expect(document.body.style.getPropertyValue('--thumbnail-size')).toBe('240px');
    const tooltip = document.getElementById('thumbnail-slider-tooltip');
    expect(tooltip.textContent).toBe('240px');
  });

  it('cleanup() 実行後はリスナーと保留中のrAFが安全に破棄されること', () => {
    const handle = setupThumbnailSliderEvents(slider, {
      onUpdateSize: onUpdateSizeSpy,
      onUpdateGrid: onUpdateGridSpy,
      onSaveSetting: onSaveSettingSpy
    });

    slider.dispatchEvent(new Event('input'));
    handle.cleanup();

    // 破棄されているため16ms経過しても onUpdateGrid は呼ばれない
    vi.advanceTimersByTime(16);
    expect(onUpdateGridSpy).not.toHaveBeenCalled();

    onUpdateSizeSpy.mockClear();
    slider.dispatchEvent(new Event('input'));
    expect(onUpdateSizeSpy).not.toHaveBeenCalled();
  });
});
