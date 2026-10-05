import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Thumbnail Viewport Start Priority (User Experience Optimization)', () => {
  let sharedAppState;
  let UIManager;
  let ThumbnailQueueManager;

  beforeEach(async () => {
    const stateModule = await import('../src/renderer/renderer-state.js');
    sharedAppState = stateModule.appState;
    sharedAppState.thumbnailUrls.clear();
    sharedAppState.selection.clear();
    sharedAppState.ratings = {};
    sharedAppState.dragState = { isAppDragging: false };
    sharedAppState.initialChunk = null;
    sharedAppState.viewportPathSet = new Set();
    sharedAppState.visiblePathSet = new Set();
    window.appState = sharedAppState;

    const uiModule = await import('../src/renderer/renderer-ui.js');
    UIManager = uiModule.UIManager;

    const thumbModule = await import('../src/renderer/renderer-thumbnails.js');
    ThumbnailQueueManager = thumbModule.ThumbnailQueueManager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updateVirtualGrid should start thumbnail processing from visibleStartIndex (first file visible on screen)', async () => {
    // 1行5アイテム (cols = 5), itemSize = 120, rowHeight = 128 (itemSize:120 + gap:8)
    // padding = 8, containerHeight = 384 (約3行分表示)
    // scrollTop = 1280 (約10行目までスクロールした状態)
    // -> startRow = Math.floor((1280 - 8) / 128) = 9 (または10)
    // -> visibleStartIndex = startRow * 5 = 45 or 50
    // -> safeStartRow = startRow - 8 = 1 or 2 (画面上部バッファが存在する)
    const totalFiles = 100;
    const testFiles = Array.from({ length: totalFiles }, (_, i) => ({
      path: `C:/images/img_${String(i).padStart(3, '0')}.png`,
      name: `img_${String(i).padStart(3, '0')}.png`,
      mtime: 1000 + i,
      hasThumbnailCache: false
    }));

    sharedAppState.totalCount = totalFiles;

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => {
        return Promise.resolve(testFiles.slice(offset, offset + limit));
      })
    };

    const enqueuedBatches = [];
    window.thumbnailManager = {
      enqueuePriorityBatch: vi.fn((paths) => {
        enqueuedBatches.push(...paths);
      }),
      enqueuePriority: vi.fn((path) => {
        enqueuedBatches.push(path);
      }),
      processNext: vi.fn()
    };

    const container = document.createElement('div');
    container.id = 'center-bottom';
    // 幅 640px -> width 640 - 16 = 624 -> cols = Math.floor((624+8)/(120+8)) = 4 ではなく、幅を調整して cols=5 にする
    // cols: Math.floor((width + gap) / (itemSize + gap))
    // itemSize = 120, gap = 8 -> 128
    // 5 cols: (5 * 128) - 8 = 632. padding 8*2 = 16 -> clientWidth = 648
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    // scrollTop: 1280px (約10行分スクロール)
    Object.defineProperty(container, 'scrollTop', { value: 1288, writable: true, configurable: true });

    const content = document.createElement('div');
    content.className = 'virtual-content';
    const spacer = document.createElement('div');
    spacer.className = 'virtual-spacer';
    container.appendChild(content);
    container.appendChild(spacer);

    const ui = new UIManager(sharedAppState);
    ui.elements.thumbnailGrid = container;
    ui.elements.thumbnailSizeSlider = { value: '120' };

    await ui.updateVirtualGrid(true);

    // 計算の確認:
    // rowHeight = 128, padding = 8, scrollTop = 1288
    // startRow = Math.floor((1288 - 8) / 128) = 10
    // cols = 5 -> visibleStartIndex = 10 * 5 = 50
    // safeStartRow = 10 - 8 = 2 -> startIndex = 2 * 5 = 10
    // 画面外の上部バッファ: インデックス 10 〜 49 (40個)
    // 画面内に見えている先頭アイテム: インデックス 50 (img_050.png)
    expect(enqueuedBatches.length).toBeGreaterThan(0);

    // 最重要検証: enqueuedBatches の最初のアイテムは、画面外の上部(img_010.png)ではなく、
    // 現在画面に表示されている先頭ファイル (img_050.png) からスタートしていること！
    const firstEnqueued = enqueuedBatches[0];
    expect(firstEnqueued).toBe('C:/images/img_050.png');

    // 画面内アイテム (img_050 〜) が上部バッファ (img_010 〜 img_049) よりも先に積まれていること
    const indexOfImg50 = enqueuedBatches.indexOf('C:/images/img_050.png');
    const indexOfImg10 = enqueuedBatches.indexOf('C:/images/img_010.png');
    expect(indexOfImg50).toBe(0);
    expect(indexOfImg10).toBeGreaterThan(indexOfImg50);

    // viewportPathSet に画面内のファイルが含まれ、画面外上部バッファが含まれないこと
    expect(sharedAppState.viewportPathSet.has('C:/images/img_050.png')).toBe(true);
    expect(sharedAppState.viewportPathSet.has('C:/images/img_010.png')).toBe(false);
  });

  it('ThumbnailQueueManager.processNext should prioritize items in viewportPathSet first', async () => {
    const queueManager = new ThumbnailQueueManager(4);
    const executedTasks = [];

    // runTask をモックして実行順序を記録
    queueManager.runTask = vi.fn((filePath) => {
      executedTasks.push(filePath);
      queueManager.activeTasks.delete(filePath);
      queueManager.processNext();
    });

    // 画面外バッファのアイテムと、画面内の先頭アイテムを用意
    const offscreenBufferFile = 'C:/images/offscreen_buffer.png';
    const viewportStartFile = 'C:/images/viewport_start.png';
    const viewportSecondFile = 'C:/images/viewport_second.png';

    // 画面内Setを設定
    sharedAppState.viewportPathSet = new Set([viewportStartFile, viewportSecondFile]);
    sharedAppState.visiblePathSet = new Set([offscreenBufferFile, viewportStartFile, viewportSecondFile]);

    // あえて画面外アイテムを先にキューに入れる
    queueManager.priorityQueue = [
      { filePath: offscreenBufferFile, skipDbCheck: true },
      { filePath: viewportStartFile, skipDbCheck: true },
      { filePath: viewportSecondFile, skipDbCheck: true }
    ];
    queueManager.priorityQueueSet = new Set([offscreenBufferFile, viewportStartFile, viewportSecondFile]);

    await queueManager.processNext();

    // 実行順序の検証:
    // priorityQueue 内で offscreenBufferFile が先頭にあっても、
    // viewportPathSet にある viewportStartFile が最優先で選択・実行されること！
    expect(executedTasks[0]).toBe(viewportStartFile);
    expect(executedTasks[1]).toBe(viewportSecondFile);
    expect(executedTasks[2]).toBe(offscreenBufferFile);
  });
});
