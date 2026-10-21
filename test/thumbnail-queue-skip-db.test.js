import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { ThumbnailQueueManager, thumbnailWorkerPool } from '../src/renderer/renderer-thumbnails.js';

describe('ThumbnailQueueManager: skipDbCheck IPC Optimization (Phase 1)', () => {
  let tm;
  let getThumbnailSpy;
  let generateSpy;

  beforeEach(() => {
    appState.thumbnailUrls.clear();
    appState.selection.clear();
    appState.viewportPathSet = new Set();
    appState.visiblePathSet = new Set();
    appState.totalCount = 0;
    appState.preloadCursor = 0;
    appState.isPreloadRunning = false;
    appState.isFetchingPreload = false;

    getThumbnailSpy = vi.fn().mockResolvedValue(null);
    window.veloceAPI = {
      convertFileSrc: vi.fn(path => `asset://${path}`),
      getThumbnail: getThumbnailSpy,
      saveThumbnail: vi.fn().mockResolvedValue('asset://saved'),
      readBinaryFile: vi.fn()
    };

    generateSpy = vi.spyOn(thumbnailWorkerPool, 'generate').mockImplementation(async (filePath, assetUrl, signal) => {
      return {
        url: `blob:mock/${filePath}`,
        blob: new Blob(['mock'], { type: 'image/webp' }),
        base64Promise: Promise.resolve('data:image/webp;base64,mock'),
        width: 100,
        height: 100
      };
    });

    tm = new ThumbnailQueueManager(4);
  });

  afterEach(() => {
    if (tm) tm.clear();
    vi.restoreAllMocks();
  });

  it('enqueuePriorityBatch で skipDbCheck: true の場合、getThumbnail を呼ばずに直接 workerPool.generate を実行すること', async () => {
    const filePath = 'C:/images/uncached_1.png';
    tm.enqueuePriorityBatch([{ filePath, skipDbCheck: true }]);

    await vi.waitFor(() => {
      expect(appState.thumbnailUrls.has(filePath)).toBe(true);
    });

    // getThumbnail（Rust 照会 IPC）がスキップされたことを検証
    expect(getThumbnailSpy).not.toHaveBeenCalled();
    // workerPool.generate が直接呼ばれたことを検証
    expect(generateSpy).toHaveBeenCalledWith(filePath, `asset://${filePath}`, expect.any(Object));
  });

  it('enqueuePriorityBatch で skipDbCheck: false の場合、従来どおり getThumbnail を呼び出すこと', async () => {
    const filePath = 'C:/images/may_cached_2.png';
    getThumbnailSpy.mockResolvedValueOnce('http://127.0.0.1:8080/cached.jpg');

    tm.enqueuePriorityBatch([{ filePath, skipDbCheck: false }]);

    await vi.waitFor(() => {
      expect(appState.thumbnailUrls.has(filePath)).toBe(true);
    });

    // getThumbnail が呼ばれたことを検証
    expect(getThumbnailSpy).toHaveBeenCalledWith(filePath);
    // キャッシュヒットのため workerPool.generate は呼ばれないことを検証
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('preloadQueue にオブジェクト形式 ({ filePath, skipDbCheck: true }) が格納された場合も正しく getThumbnail をスキップすること', async () => {
    const filePath = 'C:/images/preload_uncached.png';
    tm.preloadQueue.push({ filePath, skipDbCheck: true });
    tm.processNext();

    await vi.waitFor(() => {
      expect(appState.thumbnailUrls.has(filePath)).toBe(true);
    });

    expect(getThumbnailSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalledWith(filePath, `asset://${filePath}`, expect.any(Object));
  });

  it('remove(filePath) がオブジェクト形式の preloadQueue からも該当アイテムを正しく除外できること', () => {
    const p1 = 'C:/images/file1.png';
    const p2 = 'C:/images/file2.png';
    tm.preloadQueue = [
      { filePath: p1, skipDbCheck: true },
      { filePath: p2, skipDbCheck: false }
    ];

    tm.remove(p1);

    expect(tm.preloadQueue.length).toBe(1);
    expect(tm.preloadQueue[0].filePath).toBe(p2);
  });
});
