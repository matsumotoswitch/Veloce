import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UIManager } from '../src/renderer-ui.js';
import '../src/renderer-state.js';

describe('File Dimensions and Aspect Ratio Dynamic Update', () => {
  let uiManager;
  let mockTable;
  let mockRow;

  beforeEach(() => {
    window.appState = {
      thumbnailUrls: new Map(),
      selection: new Set(),
      ratings: {},
      initialChunk: [
        { path: 'C:\\images\\new_image.png', name: 'new_image', ext: '.png', width: 0, height: 0, size: 2048, mtime: 1000 }
      ]
    };

    window.veloceAPI = {
      updateFileDimensions: vi.fn(),
      notifyFileChanged: vi.fn().mockResolvedValue(1),
      convertFileSrc: vi.fn(p => `asset://${p}`),
      getThumbnail: vi.fn().mockResolvedValue(null),
      saveThumbnail: vi.fn().mockResolvedValue('asset://thumb')
    };

    uiManager = new UIManager(window.appState);

    // ファイル一覧テーブルの行を模したDOMを構築
    mockTable = document.createElement('tbody');
    mockRow = document.createElement('tr');
    mockRow.dataset.filepath = 'C:\\images\\new_image.png';
    mockRow.dataset.index = '0';

    // カラム構成: [0]name, [1]ext, [2]width, [3]height, [4]ratio, [5]size, [6]mtime, [7]rating
    const colContents = ['new_image', '.png', '-', '-', '-', '2 KB', '2026/01/01', '-'];
    for (const text of colContents) {
      const td = document.createElement('td');
      td.textContent = text;
      mockRow.appendChild(td);
    }
    mockTable.appendChild(mockRow);

    uiManager._listDomByPath = new Map();
    uiManager._listDomByPath.set('C:\\images\\new_image.png', mockRow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初期状態で幅、高さ、比率が "-" になっていること', () => {
    const tds = mockRow.children;
    expect(tds[2].textContent).toBe('-');
    expect(tds[3].textContent).toBe('-');
    expect(tds[4].textContent).toBe('-');
  });

  it('updateFileDimensions により、ファイル一覧テーブルの幅・高さ・比率が即時更新されること', () => {
    uiManager.updateFileDimensions('C:\\images\\new_image.png', 1024, 1536);

    const tds = mockRow.children;
    expect(tds[2].textContent).toBe('1,024');
    expect(tds[3].textContent).toBe('1,536');
    // 1024:1536 -> gcd=512 -> 2:3
    expect(tds[4].textContent).toBe('2:3');
  });

  it('正方形画像の場合、比率が 1:1 になること', () => {
    uiManager.updateFileDimensions('C:\\images\\new_image.png', 512, 512);

    const tds = mockRow.children;
    expect(tds[2].textContent).toBe('512');
    expect(tds[3].textContent).toBe('512');
    expect(tds[4].textContent).toBe('1:1');
  });

  it('ワイド比率（横長）画像の場合、正しい比率文字列が計算されること', () => {
    uiManager.updateFileDimensions('C:\\images\\new_image.png', 1920, 1080);

    const tds = mockRow.children;
    expect(tds[2].textContent).toBe('1,920');
    expect(tds[3].textContent).toBe('1,080');
    // 1920:1080 -> gcd=120 -> 16:9
    expect(tds[4].textContent).toBe('16:9');
  });

  it('appState.initialChunk のキャッシュオブジェクトの width / height も更新されること', () => {
    uiManager.updateFileDimensions('C:\\images\\new_image.png', 800, 600);

    const cached = window.appState.initialChunk.find(f => f.path === 'C:\\images\\new_image.png');
    expect(cached).toBeDefined();
    expect(cached.width).toBe(800);
    expect(cached.height).toBe(600);
  });

  it('幅または高さが 0 や不正値の場合は更新されないこと', () => {
    uiManager.updateFileDimensions('C:\\images\\new_image.png', 0, 0);

    const tds = mockRow.children;
    expect(tds[2].textContent).toBe('-');
    expect(tds[3].textContent).toBe('-');
    expect(tds[4].textContent).toBe('-');
  });

  it('登録されていないファイルパスの場合はエラーにならず何もしないこと', () => {
    expect(() => {
      uiManager.updateFileDimensions('C:\\images\\not_exist.png', 1024, 768);
    }).not.toThrow();
  });
});
