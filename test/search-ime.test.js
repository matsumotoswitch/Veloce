import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { uiManager } from '../src/renderer/renderer-ui.js';

describe('Search Bar Japanese IME (Composition) Event Handling', () => {
  let setupSearchBarEvents;
  let searchBar;
  let clearBtn;
  let onSearchSpy;
  let updateIndicatorSpy;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <button id="search-clear-btn" type="button"></button>
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.searchClearBtn = document.getElementById('search-clear-btn');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    const renderer = await import('../src/renderer/renderer.js');
    setupSearchBarEvents = renderer.setupSearchBarEvents;
  });

  beforeEach(() => {
    vi.useFakeTimers();

    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <button id="search-clear-btn" type="button"></button>
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
    `;
    searchBar = document.getElementById('search-input');
    clearBtn = document.getElementById('search-clear-btn');
    uiManager.elements.searchBar = searchBar;
    uiManager.elements.searchClearBtn = clearBtn;

    onSearchSpy = vi.fn();
    updateIndicatorSpy = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('通常の英数字入力時は、指定したデバウンス時間（300ms）経過後に検索が実行されること', () => {
    setupSearchBarEvents(searchBar, {
      searchDelay: 300,
      onSearch: onSearchSpy,
      updateIndicator: updateIndicatorSpy,
      clearBtn
    });

    searchBar.value = 'cat';
    searchBar.dispatchEvent(new Event('input'));

    expect(updateIndicatorSpy).toHaveBeenCalledTimes(1);
    expect(onSearchSpy).not.toHaveBeenCalled();

    // 299ms時点ではまだ未発火
    vi.advanceTimersByTime(299);
    expect(onSearchSpy).not.toHaveBeenCalled();

    // 300ms経過で検索実行
    vi.advanceTimersByTime(1);
    expect(onSearchSpy).toHaveBeenCalledTimes(1);
    expect(onSearchSpy).toHaveBeenCalledWith('cat');
  });

  it('日本語IME変換中（compositionstart後）は、300ms経過しても検索が保留されること', () => {
    const handle = setupSearchBarEvents(searchBar, {
      searchDelay: 300,
      onSearch: onSearchSpy,
      updateIndicator: updateIndicatorSpy,
      clearBtn
    });

    expect(handle.isComposing()).toBe(false);

    // 1. IME入力開始 (compositionstart)
    searchBar.dispatchEvent(new Event('compositionstart'));
    expect(handle.isComposing()).toBe(true);

    // 2. 未確定のかな文字が入力される (input: 'ねこ')
    searchBar.value = 'ねこ';
    searchBar.dispatchEvent(new Event('input'));

    // デバウンス時間を超えて待機
    vi.advanceTimersByTime(500);

    // IME変換確定前なので検索は一切トリガーされない
    expect(onSearchSpy).not.toHaveBeenCalled();
    expect(handle.isComposing()).toBe(true);
  });

  it('日本語IMEの確定操作（compositionend）発生時に、最新の確定文字列で即座に検索が実行されること', () => {
    const handle = setupSearchBarEvents(searchBar, {
      searchDelay: 300,
      onSearch: onSearchSpy,
      updateIndicator: updateIndicatorSpy,
      clearBtn
    });

    // 1. IME入力開始
    searchBar.dispatchEvent(new Event('compositionstart'));

    // 2. 途中の未確定入力
    searchBar.value = 'ねこ';
    searchBar.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(300);
    expect(onSearchSpy).not.toHaveBeenCalled();

    // 3. 変換確定（例: 漢字「猫」に変換・確定）
    searchBar.value = '猫';
    searchBar.dispatchEvent(new Event('compositionend'));

    // 確定時に即座に検索がトリガーされる
    expect(handle.isComposing()).toBe(false);
    expect(onSearchSpy).toHaveBeenCalledTimes(1);
    expect(onSearchSpy).toHaveBeenCalledWith('猫');
  });

  it('Escapeキー押下時に検索クリアボタンがクリックされフォーカスが外れること', () => {
    const clearClickSpy = vi.fn();
    clearBtn.addEventListener('click', clearClickSpy);
    const blurSpy = vi.spyOn(searchBar, 'blur');

    setupSearchBarEvents(searchBar, {
      searchDelay: 300,
      onSearch: onSearchSpy,
      updateIndicator: updateIndicatorSpy,
      clearBtn
    });

    searchBar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(clearClickSpy).toHaveBeenCalledTimes(1);
    expect(blurSpy).toHaveBeenCalledTimes(1);
  });

  it('cleanup() を実行するとイベントリスナーが解除されること', () => {
    const handle = setupSearchBarEvents(searchBar, {
      searchDelay: 300,
      onSearch: onSearchSpy,
      updateIndicator: updateIndicatorSpy,
      clearBtn
    });

    handle.cleanup();

    searchBar.value = 'test';
    searchBar.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(300);

    expect(onSearchSpy).not.toHaveBeenCalled();
    expect(updateIndicatorSpy).not.toHaveBeenCalled();
  });
});
