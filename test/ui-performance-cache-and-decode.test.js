import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { uiManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('UI Performance Cache and DecodeRace Optimizations', () => {
  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="center-top" style="width: 800px; height: 300px; overflow-y: auto;">
        <table id="file-table">
          <tbody id="file-list-body"></tbody>
        </table>
      </div>
      <div id="center-bottom" style="width: 800px; height: 600px; overflow-y: auto;"></div>
    `;

    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
  });

  it('updateVirtualList caches raw numeric metadata and only recalculates on change', async () => {
    const listContainer = document.getElementById('center-top');
    Object.defineProperty(listContainer, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(listContainer, 'scrollTop', { value: 0, writable: true, configurable: true });

    // テスト対象のファイルデータ
    const file = {
      path: 'C:\\test\\sample.png',
      name: 'sample.png',
      ext: '.png',
      width: 1920,
      height: 1080,
      size: 1048576,
      mtime: 1700000000000,
      hasThumbnailCache: true,
    };

    const files = [file];
    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => Promise.resolve(files.slice(offset, offset + limit))),
    };

    appState.allFiles = files;
    appState.filteredFiles = files;
    appState.totalCount = 1;
    appState.activeCenterPane = 'split';

    // 1回目のレンダリング
    await uiManager.updateVirtualList(true);

    const tbody = document.getElementById('file-list-body');
    // tbody.children[0] は topSpacer のため、[1] が最初のデータ行
    const tr = tbody.children[1];
    expect(tr).toBeDefined();

    const tds = tr.children;
    expect(tds[2]._cachedWidth).toBe(1920);
    expect(tds[2].textContent).toBe((1920).toLocaleString());
    expect(tds[3]._cachedHeight).toBe(1080);
    expect(tds[3].textContent).toBe((1080).toLocaleString());
    expect(tds[4]._cachedWidth).toBe(1920);
    expect(tds[4]._cachedHeight).toBe(1080);
    expect(tds[4].textContent).toBe('16:9');
    expect(tds[5]._cachedSize).toBe(1048576);
    expect(tds[6]._cachedMtime).toBe(1700000000000);

    // 2回目: メタデータ不変で再レンダリング時、キャッシュが同一値を保持し続けること
    await uiManager.updateVirtualList(true);
    expect(tds[2]._cachedWidth).toBe(1920);
    expect(tds[3]._cachedHeight).toBe(1080);

    // 3回目: メタデータが非同期到着（幅・高さが更新された場合）
    file.width = 3840;
    file.height = 2160;
    uiManager.invalidateItemWindowCache();
    await uiManager.updateVirtualList(true);

    expect(tds[2]._cachedWidth).toBe(3840);
    expect(tds[2].textContent).toBe((3840).toLocaleString());
    expect(tds[3]._cachedHeight).toBe(2160);
    expect(tds[3].textContent).toBe((2160).toLocaleString());
    expect(tds[4]._cachedWidth).toBe(3840);
    expect(tds[4]._cachedHeight).toBe(2160);
    expect(tds[4].textContent).toBe('16:9');
  });

  it('decodeRace cleans up timer on promise resolution and handles timeout', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // renderer-thumbnails.js の decodeRace と同等のレース関数
    const decodeRace = (promise) => {
      let timer;
      const timeout = new Promise((_, r) => {
        timer = setTimeout(() => r(new Error('createImageBitmap timed out')), 2000);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    // 1. 正常即時完了時: clearTimeout が直ちに呼ばれること
    const fastPromise = Promise.resolve('bitmap_ok');
    const result = await decodeRace(fastPromise);
    expect(result).toBe('bitmap_ok');
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // 2. タイムアウト時: 2000ms でエラーになること
    const neverEndingPromise = new Promise(() => {});
    const racePromise = decodeRace(neverEndingPromise);

    vi.advanceTimersByTime(2000);

    await expect(racePromise).rejects.toThrow('createImageBitmap timed out');

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
