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

  it('updateVirtualGrid should synchronize preloadCursor to visibleEndIndex + 1 when user scrolls', async () => {
    const totalFiles = 200;
    const testFiles = Array.from({ length: totalFiles }, (_, i) => ({
      path: `C:/images/img_${String(i).padStart(3, '0')}.png`,
      name: `img_${String(i).padStart(3, '0')}.png`,
      mtime: 1000 + i,
      hasThumbnailCache: false
    }));

    sharedAppState.totalCount = totalFiles;
    sharedAppState.preloadCursor = 0;

    window.veloceAPI = {
      getItems: vi.fn().mockImplementation((offset, limit) => {
        return Promise.resolve(testFiles.slice(offset, offset + limit));
      })
    };

    const resetPreloadMock = vi.fn();
    window.thumbnailManager = {
      _preloadAnchor: 0,
      _preloadWrapped: false,
      resetPreload: resetPreloadMock,
      enqueuePriorityBatch: vi.fn(),
      enqueuePriority: vi.fn(),
      processNext: vi.fn()
    };

    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    // scrollTop = 1288 -> startRow = 10, cols = 5 -> visibleStartIndex = 50
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

    // visibleEndIndex は画面末尾。preloadCursor は visibleEndIndex + 1 に同期されていること
    expect(sharedAppState.preloadCursor).toBeGreaterThan(50);
    expect(window.thumbnailManager._preloadAnchor).toBe(sharedAppState.preloadCursor);
    expect(window.thumbnailManager._preloadWrapped).toBe(false);
    expect(resetPreloadMock).toHaveBeenCalled();
  });

  it('ThumbnailQueueManager.processNext should fetch preload from preloadCursor and wrap around at totalCount', async () => {
    const queueManager = new ThumbnailQueueManager(4);
    // バックグラウンド実行リミットに達するようにアクティブタスクを保持し、自動消化を一時抑止
    queueManager.runTask = vi.fn((filePath) => {
      queueManager.activeTasks.add(filePath);
    });

    const totalCount = 120;
    sharedAppState.totalCount = totalCount;
    sharedAppState.preloadCursor = 100;
    queueManager._preloadAnchor = 100;
    queueManager._preloadWrapped = false;

    const fetchedRanges = [];
    window.veloceAPI = {
      getItems: vi.fn((offset, limit) => {
        fetchedRanges.push({ offset, limit });
        const items = [];
        for (let i = 0; i < limit && offset + i < totalCount; i++) {
          items.push({ path: `C:/images/img_${offset + i}.png` });
        }
        return Promise.resolve(items);
      })
    };

    // 1回目: 100からフェッチ（100〜120までの20件が返り、preloadCursorは120へ進む）
    queueManager.processNext();
    await new Promise(r => setTimeout(r, 10));

    expect(fetchedRanges[0]).toEqual({ offset: 100, limit: 50 });
    expect(sharedAppState.preloadCursor).toBe(120);
    expect(queueManager.preloadQueue.length).toBeGreaterThan(0);
    expect(queueManager._preloadWrapped).toBe(false);

    // キューを消化し、アクティブタスクをクリアして次のイテレーションを実行
    queueManager.preloadQueue = [];
    queueManager.activeTasks.clear();
    queueManager.processNext();
    await new Promise(r => setTimeout(r, 10));

    // 2回目: preloadCursor(120) >= totalCount(120) のため、ラップアラウンドが発生して 0 になり、先頭領域フェッチが実行される
    expect(queueManager._preloadWrapped).toBe(true);
    expect(fetchedRanges[1]).toEqual({ offset: 0, limit: 50 });
    expect(sharedAppState.preloadCursor).toBe(50);
  });

  it('ThumbnailQueueManager fast scroll should cancel outdated preload fetch via _preloadFetchId', async () => {
    const queueManager = new ThumbnailQueueManager(4);
    sharedAppState.totalCount = 500;
    sharedAppState.preloadCursor = 0;
    queueManager._preloadAnchor = 0;

    let resolveFirstFetch;
    window.veloceAPI = {
      getItems: vi.fn(() => {
        return new Promise((resolve) => {
          resolveFirstFetch = resolve;
        });
      })
    };

    // 1. 最初のプレロードフェッチ開始 (offset: 0)
    queueManager.processNext();
    expect(sharedAppState.isFetchingPreload).toBe(true);

    // 2. ユーザーが急激にスクロールし、resetPreload() が呼ばれカーソルが 300 にジャンプ
    sharedAppState.preloadCursor = 300;
    queueManager._preloadAnchor = 300;
    queueManager.resetPreload();

    // 3. 遅延していた最初のフェッチ (offset: 0 のアイテム) が解決
    resolveFirstFetch([
      { path: 'C:/images/old_0.png' },
      { path: 'C:/images/old_1.png' }
    ]);
    await Promise.resolve();
    await Promise.resolve();

    // 世代番号 _preloadFetchId により、古いフェッチ結果は破棄され、preloadCursor も 300 のまま維持されること
    expect(queueManager.preloadQueue.length).toBe(0);
    expect(sharedAppState.preloadCursor).toBe(300);
  });

  it('updateVirtualGrid should dynamically prioritize top buffer over bottom buffer when scrolling up (Phase 2)', async () => {
    const totalFiles = 200;
    const testFiles = Array.from({ length: totalFiles }, (_, i) => ({
      path: `C:/images/img_${String(i).padStart(3, '0')}.png`,
      name: `img_${String(i).padStart(3, '0')}.png`,
      mtime: 1000 + i,
      hasThumbnailCache: false
    }));

    sharedAppState.totalCount = totalFiles;
    window.veloceAPI = {
      getItems: vi.fn((offset, limit) => {
        return Promise.resolve(testFiles.slice(offset, offset + limit));
      })
    };

    let enqueuedBatches = [];
    window.thumbnailManager = {
      _preloadAnchor: 0,
      _preloadWrapped: false,
      resetPreload: vi.fn(),
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
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    // 最初は 1288px (約10行目)
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

    // 1回目描画 (1288px, 初期状態・下スクロール方向)
    await ui.updateVirtualGrid(true);
    expect(ui.scrollDirection).toBe('down');

    // 2回目描画: 上方向にスクロール (1288px -> 640px)
    enqueuedBatches = [];
    container.scrollTop = 640;
    await ui.updateVirtualGrid(true);

    expect(ui.scrollDirection).toBe('up');

    // 画面内アイテム（img_020.png）が先頭にあること
    expect(enqueuedBatches[0]).toBe('C:/images/img_020.png');

    // 上スクロール時のバッファ優先度: 上側バッファ（img_019.png 等）が下側バッファ（img_040.png 等）より前にあること！
    const indexOfImg19 = enqueuedBatches.indexOf('C:/images/img_019.png'); // 上側バッファ直近
    const indexOfImg40 = enqueuedBatches.indexOf('C:/images/img_040.png'); // 下側バッファ直近

    expect(indexOfImg19).toBeGreaterThan(-1);
    expect(indexOfImg40).toBeGreaterThan(-1);
    expect(indexOfImg19).toBeLessThan(indexOfImg40);
  });

  it('ThumbnailQueueManager.purgeOutOfView should remove tasks no longer in visibleSet (Phase 3)', () => {
    const queueManager = new ThumbnailQueueManager(4);
    // processNext の自動取り出しを停止して priorityQueue にタスクを留める
    queueManager.processNext = vi.fn();

    const fileVisible1 = 'C:/images/visible_1.png';
    const fileVisible2 = 'C:/images/visible_2.png';
    const fileOutOfView1 = 'C:/images/out_1.png';
    const fileOutOfView2 = 'C:/images/out_2.png';

    // 優先キューに4アイテムを追加
    queueManager.enqueuePriorityBatch([fileVisible1, fileOutOfView1, fileVisible2, fileOutOfView2], true);

    expect(queueManager.priorityQueue.length).toBe(4);
    expect(queueManager.totalEnqueued).toBe(4);
    expect(queueManager.priorityQueueSet.has(fileOutOfView1)).toBe(true);

    // 有効な可視セットは visible_1 と visible_2 のみ
    const validSet = new Set([fileVisible1, fileVisible2]);

    queueManager.purgeOutOfView(validSet);

    // 範囲外のアイテムが優先キューおよび追跡セットから除去されていること
    expect(queueManager.priorityQueue.length).toBe(2);
    expect(queueManager.priorityQueue.map(r => r.filePath)).toEqual([fileVisible1, fileVisible2]);
    expect(queueManager.priorityQueueSet.has(fileOutOfView1)).toBe(false);
    expect(queueManager.priorityQueueSet.has(fileOutOfView2)).toBe(false);
    expect(queueManager.priorityQueueSet.has(fileVisible1)).toBe(true);
    expect(queueManager.priorityQueueSet.has(fileVisible2)).toBe(true);

    // totalEnqueued がパージされた分だけ減少し、プログレスバー計算が整合していること
    expect(queueManager.totalEnqueued).toBe(2);
  });

  it('updateVirtualGrid should automatically trigger purgeOutOfView on scroll transition (Phase 3)', async () => {
    const totalFiles = 100;
    const testFiles = Array.from({ length: totalFiles }, (_, i) => ({
      path: `C:/images/img_${String(i).padStart(3, '0')}.png`,
      name: `img_${String(i).padStart(3, '0')}.png`,
      mtime: 1000 + i,
      hasThumbnailCache: false
    }));

    sharedAppState.totalCount = totalFiles;
    window.veloceAPI = {
      getItems: vi.fn((offset, limit) => {
        return Promise.resolve(testFiles.slice(offset, offset + limit));
      })
    };

    const purgeOutOfViewMock = vi.fn();
    window.thumbnailManager = {
      _preloadAnchor: 0,
      _preloadWrapped: false,
      resetPreload: vi.fn(),
      enqueuePriorityBatch: vi.fn(),
      enqueuePriority: vi.fn(),
      purgeOutOfView: purgeOutOfViewMock,
      processNext: vi.fn()
    };

    const container = document.createElement('div');
    container.id = 'center-bottom';
    Object.defineProperty(container, 'clientWidth', { value: 648, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 384, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true });

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

    expect(purgeOutOfViewMock).toHaveBeenCalled();
    const calledSet = purgeOutOfViewMock.mock.calls[0][0];
    expect(calledSet instanceof Set).toBe(true);
    expect(calledSet.size).toBeGreaterThan(0);
  });

  it('ThumbnailQueueManager should limit concurrent video tasks and prioritize static images when video slots are full (Phase 4)', () => {
    // concurrency = 4 の場合、maxVideoConcurrency = 1 となる
    const queueManager = new ThumbnailQueueManager(4);
    expect(queueManager.maxVideoConcurrency).toBe(1);

    const startedTasks = [];
    queueManager.runTask = vi.fn((filePath) => {
      startedTasks.push(filePath);
      // 自動完了させずに保持
    });

    const video1 = 'C:/media/video1.mp4';
    const video2 = 'C:/media/video2.mp4';
    const image1 = 'C:/media/image1.png';
    const image2 = 'C:/media/image2.png';

    // 画面内アイテムとして設定（isVisible = true）
    sharedAppState.viewportPathSet = new Set([video1, video2, image1, image2]);

    // 優先キューに [video1, video2, image1, image2] を投入
    // processNext を一時停止して投入
    queueManager.processNext = vi.fn();
    queueManager.enqueuePriorityBatch([video1, video2, image1, image2], true);

    expect(queueManager.priorityQueue.length).toBe(4);

    // 本来の processNext 実装を復元してタスク抽出を実行
    delete queueManager.processNext;
    queueManager.processNext();

    // 検証:
    // 1. video1.mp4 は開始され、動画枠（1枠）が埋まる
    // 2. video2.mp4 は動画枠が満杯のためスキップされる
    // 3. 後続の image1.png と image2.png がブロックされずに並行起動される！
    expect(startedTasks).toContain(video1);
    expect(startedTasks).toContain(image1);
    expect(startedTasks).toContain(image2);
    expect(startedTasks).not.toContain(video2);

    expect(queueManager.activeVideoTasks.has(video1)).toBe(true);
    expect(queueManager.activeVideoTasks.size).toBe(1);
    expect(queueManager.activeTasks.size).toBe(3);

    // video2.mp4 はキュー内に待機していること
    expect(queueManager.priorityQueue.length).toBe(1);
    expect(queueManager.priorityQueue[0].filePath).toBe(video2);

    // video1.mp4 が完了して枠が空いた状態をシミュレート
    queueManager.activeTasks.delete(video1);
    queueManager.activeVideoTasks.delete(video1);

    // 次の processNext で video2.mp4 が開始されること
    queueManager.processNext();
    expect(startedTasks).toContain(video2);
    expect(queueManager.activeVideoTasks.has(video2)).toBe(true);
  });
});
