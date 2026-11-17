import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';

describe('selectImage Debounced Inspector Metadata Fetch', () => {
  let selectImage;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
      <div id="inspector-header-path"></div>
      <div id="inspector-content"></div>
      <div id="inspector-empty"></div>
      <div id="static-file-info-table"></div>
      <div id="file-info-empty"></div>
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    const renderer = await import('../src/renderer/renderer.js');
    selectImage = renderer.selectImage;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    appState.selection = new Set();
    appState.selectedIndex = -1;

    window.veloceAPI = {
      getFileByIndex: vi.fn(async (idx) => ({
        path: `C:\\images\\file${idx}.png`,
        name: `file${idx}.png`,
        width: 100,
        height: 100
      })),
      parseMetadata: vi.fn(async (path) => ({
        width: 100,
        height: 100,
        prompt: 'test prompt'
      })),
      updateFileDimensions: vi.fn()
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should debounce rapid selectImage calls and only invoke parseMetadata for the final index', async () => {
    // 連続で 0 -> 1 -> 2 と選択を移動
    selectImage(0);
    vi.advanceTimersByTime(10);
    selectImage(1);
    vi.advanceTimersByTime(10);
    selectImage(2);

    // デバウンス時間 (40ms) を超えてタイマーを発火
    await vi.advanceTimersByTimeAsync(50);

    // 中間の 0, 1 では parseMetadata は呼ばれず、最後の 2 に対してのみ呼ばれること
    expect(window.veloceAPI.parseMetadata).toHaveBeenCalledTimes(1);
    expect(window.veloceAPI.parseMetadata).toHaveBeenCalledWith('C:\\images\\file2.png');
    expect(window.veloceAPI.getFileByIndex).toHaveBeenCalledTimes(1);
    expect(window.veloceAPI.getFileByIndex).toHaveBeenCalledWith(2);
  });

  it('should not call renderMetadata if selectedIndex changes during getFileByIndex async resolution', async () => {
    let resolveFilePromise;
    window.veloceAPI.getFileByIndex = vi.fn(() => new Promise((resolve) => {
      resolveFilePromise = resolve;
    }));

    selectImage(0);
    // デバウンスタイマー発火
    vi.advanceTimersByTime(50);

    expect(window.veloceAPI.getFileByIndex).toHaveBeenCalledWith(0);

    // getFileByIndex の解決前に、ユーザーが選択を解除 (selectedIndex = -1)
    appState.selectedIndex = -1;
    appState.selection.clear();

    // 非同期完了
    resolveFilePromise({ path: 'C:\\images\\file0.png', name: 'file0.png' });
    await Promise.resolve();

    // 解決時に index がずれていたため parseMetadata は呼ばれないこと
    expect(window.veloceAPI.parseMetadata).not.toHaveBeenCalled();
  });
});

