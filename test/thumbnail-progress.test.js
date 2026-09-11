import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThumbnailQueueManager, cleanupContext } from '../src/renderer-thumbnails.js';
import { appState } from '../src/renderer-state.js';

describe('Thumbnail Generation Progress Bar (D-1)', () => {
  let manager;
  let progressBar;
  let progressContainer;

  beforeEach(() => {
    vi.useFakeTimers();
    appState.thumbnailUrls.clear();
    if (appState.visiblePathSet) appState.visiblePathSet.clear();

    // DOM のモック
    document.body.innerHTML = `
      <div id="thumbnail-controls">
        <div id="thumbnail-progress-container">
          <div id="thumbnail-progress-bar"></div>
        </div>
      </div>
      <div id="center-bottom"></div>
    `;
    progressBar = document.getElementById('thumbnail-progress-bar');
    progressContainer = document.getElementById('thumbnail-progress-container');

    window.appState = {
      thumbnailUrls: new Map(),
      visiblePathSet: new Set()
    };
    window.veloceAPI = {
      getThumbnail: vi.fn(async () => 'data:image/jpeg;base64,mock')
    };

    manager = new ThumbnailQueueManager(4);
  });

  afterEach(() => {
    if (manager) manager.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('初期状態では進捗バーの幅は0%であること', () => {
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
    expect(progressBar.style.width).toBe('');
  });

  it('enqueuePriority でキュー追加時に totalEnqueued が増加しプログレスバーが更新されること', () => {
    manager.enqueuePriority('img1.png');
    expect(manager.totalEnqueued).toBe(1);
    expect(progressBar.style.opacity).toBe('1');
    expect(progressBar.style.width).toBe('0%'); // 0 / 1 = 0%

    manager.enqueuePriority('img2.png');
    expect(manager.totalEnqueued).toBe(2);
    expect(manager.priorityQueue.length + manager.activeTasks.size).toBe(2);
  });

  it('enqueuePriorityBatch で複数アイテム追加時に totalEnqueued が一括増加すること', () => {
    manager.enqueuePriorityBatch(['img1.png', 'img2.png', 'img3.png']);
    expect(manager.totalEnqueued).toBe(3);
    expect(progressBar.style.opacity).toBe('1');
  });

  it('進捗率の計算とプログレスバーの幅設定が正確であること', () => {
    manager.totalEnqueued = 4;
    manager.completedCount = 1;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('25%');

    manager.completedCount = 2;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('50%');

    manager.completedCount = 3;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('75%');
  });

  it('全件完了時に100%になり、一定時間後にフェードアウトとリセットが行われること', () => {
    manager.totalEnqueued = 2;
    manager.completedCount = 2;
    manager.activeTasks.clear();
    manager.updateProgressBar();

    expect(progressBar.style.width).toBe('100%');
    expect(progressBar.style.opacity).toBe('1');

    // 300ms 経過でフェードアウト開始 (opacity: 0)
    vi.advanceTimersByTime(300);
    expect(progressBar.style.opacity).toBe('0');

    // さらに 500ms 経過でリセット (width: 0%, totalEnqueued: 0, completedCount: 0)
    vi.advanceTimersByTime(500);
    expect(progressBar.style.width).toBe('0%');
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
  });

  it('clear() 呼び出し時にカウンタとプログレスバーが即時リセットされること', () => {
    manager.totalEnqueued = 10;
    manager.completedCount = 5;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('50%');

    manager.clear();
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
    expect(progressBar.style.opacity).toBe('0');
    expect(progressBar.style.width).toBe('0%');
  });

  it('プログレスバーが thumbnail-controls 内に配置され center-bottom のヘッダー下線を押し下げないこと', () => {
    const controls = document.getElementById('thumbnail-controls');
    const centerBottom = document.getElementById('center-bottom');
    const container = document.getElementById('thumbnail-progress-container');

    // container は controls の子要素であること
    expect(controls.contains(container)).toBe(true);
    // controls の次の要素が直接 centerBottom であること（間にブロック要素が挟まらない）
    expect(controls.nextElementSibling).toBe(centerBottom);
  });

  it('バックグラウンドプリロードタスクが完了しても追跡対象でなければ completedCount を不正に増加させないこと', async () => {
    // 未追跡のバックグラウンドアイテムの runTask 完了をシミュレート
    await manager.runTask('untracked-bg.png', false);

    // 未追跡アイテムは completedCount を増やさない
    expect(manager.completedCount).toBe(0);
    expect(manager.totalEnqueued).toBe(0);

    // 追跡対象アイテムを1件追加
    manager.enqueuePriority('tracked.png');
    expect(manager.totalEnqueued).toBe(1);
    expect(manager._trackedPaths.has('tracked.png')).toBe(true);

    // tracked.png の完了を待機
    await manager.runTask('tracked.png', false);
    expect(manager.completedCount).toBe(1);
    expect(manager.totalEnqueued).toBe(1);
    expect(progressBar.style.width).toBe('100%');
  });

  it('バックグラウンド実行中のタスクが表示領域に入った場合に追跡対象へ昇格されること', () => {
    manager.activeTasks.add('bg-running.png');

    // 表示領域に入って enqueuePriority された場合
    manager.enqueuePriority('bg-running.png');

    expect(manager._trackedPaths.has('bg-running.png')).toBe(true);
    expect(manager.totalEnqueued).toBe(1);
    expect(progressBar.style.width).toBe('0%');
  });

  it('別フォルダへの移動時および復帰時に進捗バーの計算が正常にリセット・再計算されること', () => {
    // フォルダAで5件生成開始
    manager.enqueuePriorityBatch(['a1.png', 'a2.png', 'a3.png', 'a4.png', 'a5.png']);
    expect(manager.totalEnqueued).toBe(5);

    // 2件完了
    manager.completedCount = 2;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('40%');

    // 別フォルダBへ移動（clear() 呼び出し）
    manager.clear();
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
    expect(progressBar.style.width).toBe('0%');
    expect(progressBar.style.opacity).toBe('0');

    // フォルダAに戻った際、未キャッシュの残存3件を再キューイング
    manager.enqueuePriorityBatch(['a3.png', 'a4.png', 'a5.png']);
    expect(manager.totalEnqueued).toBe(3);
    expect(manager.completedCount).toBe(0);
    expect(progressBar.style.opacity).toBe('1');
    expect(progressBar.style.width).toBe('0%');

    // 1件完了
    manager._trackedPaths.delete('a3.png');
    manager.completedCount = 1;
    manager.updateProgressBar();
    expect(progressBar.style.width).toBe('33%');
  });

  it('completedCount が totalEnqueued を超える異常値が発生しても100%にクランプされること', () => {
    manager.totalEnqueued = 2;
    manager.completedCount = 5;
    manager.updateProgressBar();

    expect(progressBar.style.width).toBe('100%');
  });

  it('cleanupContext 呼び出し時に rebuiltPaths や進捗要求数が初期化されキューがリセットされること', () => {
    window.thumbnailManager = manager;
    appState.rebuiltPaths = new Set(['rebuild1.png', 'rebuild2.png']);
    appState.thumbnailTotalRequested = 10;
    appState.thumbnailCompleted = 4;
    manager.totalEnqueued = 5;
    manager.completedCount = 2;

    cleanupContext();

    expect(appState.rebuiltPaths).toBeNull();
    expect(appState.thumbnailTotalRequested).toBe(0);
    expect(appState.thumbnailCompleted).toBe(0);
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
  });

  it('バックグラウンドタスクが activeTasks で実行中であっても100%達成時に必ずフェードアウト・消去されること', () => {
    manager.totalEnqueued = 3;
    manager.completedCount = 3;
    // バックグラウンドプリロードタスクが実行中
    manager.activeTasks.add('bg-task-running.png');

    manager.updateProgressBar();

    expect(progressBar.style.width).toBe('100%');
    expect(progressBar.style.opacity).toBe('1');

    // 300ms 経過でフェードアウト (opacity: 0)
    vi.advanceTimersByTime(300);
    expect(progressBar.style.opacity).toBe('0');

    // さらに 500ms 経過で完全消去 (width: 0%, totalEnqueued: 0, completedCount: 0)
    vi.advanceTimersByTime(500);
    expect(progressBar.style.width).toBe('0%');
    expect(manager.totalEnqueued).toBe(0);
    expect(manager.completedCount).toBe(0);
  });
});


