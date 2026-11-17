import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';

describe('Preload Refresh Behavior', () => {
  let scheduleRefresh;

  beforeAll(async () => {
    document.body.innerHTML = `
      <div id="center-top">
        <table id="file-table">
          <tbody id="file-list-body"></tbody>
        </table>
      </div>
      <div id="center-bottom"></div>
      <div id="dir-tree"></div>
      <div id="thumbnail-controls">
        <div id="thumbnail-progress-container">
          <div id="thumbnail-progress-bar"></div>
        </div>
      </div>
    `;

    const mod = await import('../src/renderer/renderer.js');
    scheduleRefresh = mod.scheduleRefresh;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    appState.preloadCursor = 120;
    window.thumbnailManager = {
      _preloadAnchor: 120,
      _preloadWrapped: false,
      clear: vi.fn()
    };
    appState.setViewParams = vi.fn().mockResolvedValue(100);
    window.uiManager = {
      renderAll: vi.fn(),
      updateSelectionUI: vi.fn(),
      updateVirtualList: vi.fn()
    };
    window.veloceAPI = {
      getFileByIndex: vi.fn().mockResolvedValue(null)
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ウォッチャー由来のリフレッシュ（resetPreload: false）では preloadCursor とアンカーが保持されること', async () => {
    appState.preloadCursor = 150;
    window.thumbnailManager._preloadAnchor = 150;

    // ウォッチャー由来の scheduleRefresh
    scheduleRefresh({ resetScroll: false, resetPreload: false });

    // デバウンス待機時間を進める (CONFIG.REFRESH_DELAY = 100ms)
    vi.advanceTimersByTime(150);
    await Promise.resolve();

    // preloadCursor および _preloadAnchor が 0 にリセットされず維持されていること
    expect(appState.preloadCursor).toBe(150);
    expect(window.thumbnailManager._preloadAnchor).toBe(150);
  });

  it('表示定義変更時（引数なし / resetScroll: true）では preloadCursor とアンカーが 0 にリセットされること', async () => {
    appState.preloadCursor = 200;
    window.thumbnailManager._preloadAnchor = 200;

    // 表示定義変更（ソート・検索・フィルタ変更等、従来通りの呼び出し）
    scheduleRefresh(true);

    vi.advanceTimersByTime(150);
    await Promise.resolve();

    // プリロード進捗が 0 にリセットされること
    expect(appState.preloadCursor).toBe(0);
    expect(window.thumbnailManager._preloadAnchor).toBe(0);
    expect(window.thumbnailManager._preloadWrapped).toBe(false);
  });

  it('引数なし scheduleRefresh() の場合も安全側に倒してリセットされること', async () => {
    appState.preloadCursor = 250;
    window.thumbnailManager._preloadAnchor = 250;

    // 引数なし
    scheduleRefresh();

    vi.advanceTimersByTime(150);
    await Promise.resolve();

    expect(appState.preloadCursor).toBe(0);
    expect(window.thumbnailManager._preloadAnchor).toBe(0);
  });
});
