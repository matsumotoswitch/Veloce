import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThumbnailQueueManager } from '../src/renderer/renderer-thumbnails.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Smart Folder Thumbnail Preload Cache Filter', () => {
  let tm;
  let batchSpy;

  beforeEach(() => {
    appState.thumbnailUrls.clear();
    appState.selection.clear();
    appState.viewportPathSet = new Set();
    appState.visiblePathSet = new Set();
    appState.totalCount = 0;
    appState.preloadCursor = 0;
    appState.isPreloadRunning = false;
    appState.isFetchingPreload = false;

    document.body.innerHTML = `
      <div id="thumbnail-controls">
        <div id="thumbnail-progress-container">
          <div id="thumbnail-progress-bar"></div>
        </div>
      </div>
      <div id="center-bottom"></div>
    `;

    batchSpy = vi.fn().mockImplementation(async (paths) => {
      return paths.map(p => ({ path: p, url: `http://127.0.0.1:8080/thumb?path=${p}` }));
    });

    window.veloceAPI = {
      convertFileSrc: vi.fn(path => `asset://${path}`),
      getThumbnail: vi.fn().mockResolvedValue(null),
      generateThumbnailBatch: batchSpy,
      saveThumbnail: vi.fn().mockResolvedValue('asset://saved'),
      readBinaryFile: vi.fn()
    };

    tm = new ThumbnailQueueManager(4);
  });

  afterEach(() => {
    if (tm) tm.clear();
    vi.restoreAllMocks();
  });

  it('hasThumbnailCache=true のアイテムは preloadQueue に積まれず、hasThumbnailCache=false のアイテムのみ積まれること', async () => {
    const mockFiles = [
      { path: 'C:/images/cached_1.png', hasThumbnailCache: true },
      { path: 'C:/images/uncached_1.png', hasThumbnailCache: false },
      { path: 'C:/images/cached_2.png', hasThumbnailCache: true },
      { path: 'C:/images/uncached_2.png', hasThumbnailCache: false },
      { path: 'C:/images/cached_3.png', hasThumbnailCache: true },
    ];

    appState.totalCount = 5;
    appState.preloadCursor = 0;
    tm._preloadAnchor = 0;
    tm._preloadWrapped = false;

    window.veloceAPI.getItems = vi.fn().mockResolvedValue(mockFiles);

    // プリロード処理を開始
    tm.processNext();

    // getItems の非同期解決を待つ
    await vi.waitFor(() => {
      expect(appState.preloadCursor).toBe(5);
    });

    // 1. preloadCursor は全件分（5件）進んでいること
    expect(appState.preloadCursor).toBe(5);

    // 2. preloadQueue には未キャッシュの2件のみが入っていること（または処理中）
    // バッチ等でキューから取り出されても、キューおよびアクティブタスク全体で未キャッシュのみであることを確認
    const queuedPaths = tm.preloadQueue.map(item => item.filePath);
    expect(queuedPaths).not.toContain('C:/images/cached_1.png');
    expect(queuedPaths).not.toContain('C:/images/cached_2.png');
    expect(queuedPaths).not.toContain('C:/images/cached_3.png');
  });

  it('全件キャッシュ済みのスマートフォルダでは preloadQueue に何も積まれず generateThumbnailBatch も呼ばれないこと', async () => {
    const allCachedFiles = [
      { path: 'C:/images/img_1.png', hasThumbnailCache: true },
      { path: 'C:/images/img_2.png', hasThumbnailCache: true },
      { path: 'C:/images/img_3.png', hasThumbnailCache: true },
    ];

    appState.totalCount = 3;
    appState.preloadCursor = 0;
    tm._preloadAnchor = 0;
    tm._preloadWrapped = false;

    window.veloceAPI.getItems = vi.fn().mockResolvedValue(allCachedFiles);

    tm.processNext();

    await vi.waitFor(() => {
      expect(appState.preloadCursor).toBe(3);
    });

    // preloadQueue は空のまま
    expect(tm.preloadQueue.length).toBe(0);

    // generateThumbnailBatch は呼び出されないこと（不要なDB照会・バックグラウンド負荷ゼロ）
    expect(batchSpy).not.toHaveBeenCalled();

    // プリロード完了状態への移行
    expect(appState.isPreloadRunning).toBe(false);
  });

  it('未キャッシュアイテムのプリロード時のみバッチ生成が実行され、キャッシュ済みアイテムがバッチに含まれないこと', async () => {
    const files = [
      { path: 'C:/images/cached_a.png', hasThumbnailCache: true },
      { path: 'C:/images/uncached_b.png', hasThumbnailCache: false },
    ];

    appState.totalCount = 2;
    appState.preloadCursor = 0;
    tm._preloadAnchor = 0;
    tm._preloadWrapped = false;

    window.veloceAPI.getItems = vi.fn().mockResolvedValue(files);

    tm.processNext();

    // バッチタスク実行（未キャッシュアイテムがバッチに投入されるのを待つ）
    await vi.waitFor(() => {
      expect(batchSpy).toHaveBeenCalled();
    });

    // generateThumbnailBatch に渡されたパス一覧に cached_a が含まれず、uncached_b のみであること
    const calledPaths = batchSpy.mock.calls[0][0];
    expect(calledPaths).toEqual(['C:/images/uncached_b.png']);
    expect(calledPaths).not.toContain('C:/images/cached_a.png');
  });

  it('キャッシュ済みアイテムがスキップされても進捗カウンタ（totalEnqueued, completedCount）が狂わないこと', async () => {
    const progressBar = document.getElementById('thumbnail-progress-bar');
    expect(tm.totalEnqueued).toBe(0);
    expect(tm.completedCount).toBe(0);

    // 背景プリロードで全件キャッシュ済みアイテムが取得された場合
    const allCached = [
      { path: 'C:/images/cached_10.png', hasThumbnailCache: true },
      { path: 'C:/images/cached_11.png', hasThumbnailCache: true },
    ];
    appState.totalCount = 2;
    appState.preloadCursor = 0;
    tm._preloadAnchor = 0;
    window.veloceAPI.getItems = vi.fn().mockResolvedValue(allCached);

    tm.processNext();

    await vi.waitFor(() => {
      expect(appState.preloadCursor).toBe(2);
    });

    // プリロードのキャッシュ済みアイテムによって totalEnqueued や completedCount が不整合を起こさないこと
    expect(tm.totalEnqueued).toBe(0);
    expect(tm.completedCount).toBe(0);
    expect(progressBar.style.width).toBe('');
  });
});
