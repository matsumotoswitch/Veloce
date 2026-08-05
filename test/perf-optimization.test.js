import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Performance optimization tests
// - gcd hoisted to module scope (was re-defined per row in list view)
// - ThumbnailQueueManager.enqueuePriority O(1) dedup with Set
// ============================================================

// ------- gcd module-scope hoisting test -------
// renderer-ui.js と同じモジュールスコープの gcd 関数を再現
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function calcRatio(w, h) {
  const d = gcd(w, h);
  const rw = w / d;
  const rh = h / d;
  return (rw > 100 || rh > 100) ? `${(w / h).toFixed(2)}:1` : `${rw}:${rh}`;
}

describe('gcd (module-scope) - aspect ratio calculation', () => {
  it('1920x1080 -> 16:9', () => {
    expect(calcRatio(1920, 1080)).toBe('16:9');
  });

  it('3840x2160 -> 16:9', () => {
    expect(calcRatio(3840, 2160)).toBe('16:9');
  });

  it('1024x1024 -> 1:1', () => {
    expect(calcRatio(1024, 1024)).toBe('1:1');
  });

  it('832x1216 (portrait NovelAI standard) -> 13:19', () => {
    expect(calcRatio(832, 1216)).toBe('13:19');
  });

  it('large prime dimensions -> decimal:1 form', () => {
    // 1921x1080: gcd=1, rw=1921 > 100, so decimal form
    const result = calcRatio(1921, 1080);
    expect(result).toMatch(/^\d+\.\d+:1$/);
  });

  it('gcd of equal numbers returns the number', () => {
    expect(gcd(100, 100)).toBe(100);
  });

  it('gcd(12, 8) = 4', () => {
    expect(gcd(12, 8)).toBe(4);
  });
});

// ------- ThumbnailQueueManager Set-based dedup test -------
// renderer.js の ThumbnailQueueManager を最小限の形で再現してロジックをテスト
function createMockAppState() {
  return {
    thumbnailUrls: new Map(),
    visiblePathSet: new Set(),
    preloadCursor: 0,
    totalCount: 0,
    isFetchingPreload: false,
    isPreloadRunning: false,
  };
}

class ThumbnailQueueManagerTest {
  constructor(concurrency, mockAppState) {
    this.concurrency = concurrency;
    this.activeTasks = new Set();
    this.priorityQueue = [];
    this.priorityQueueSet = new Set();
    this.preloadQueue = [];
    this.isProcessing = false;
    this._appState = mockAppState;
  }

  enqueuePriority(filePath) {
    if (!this.activeTasks.has(filePath) && !this._appState.thumbnailUrls.has(filePath)) {
      if (!this.priorityQueueSet.has(filePath)) {
        this.priorityQueueSet.add(filePath);
        this.priorityQueue.push({ filePath });
      }
    }
  }

  clear() {
    this.priorityQueue = [];
    this.priorityQueueSet.clear();
    this.preloadQueue = [];
    this.activeTasks.clear();
  }

  remove(filePath) {
    this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
    this.priorityQueueSet.delete(filePath);
    this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);
  }

  dequeue() {
    if (this.priorityQueue.length === 0) return null;
    const req = this.priorityQueue.splice(0, 1)[0];
    this.priorityQueueSet.delete(req.filePath);
    return req.filePath;
  }
}

describe('ThumbnailQueueManager - O(1) Set-based dedup', () => {
  let queue;
  let mockState;

  beforeEach(() => {
    mockState = createMockAppState();
    queue = new ThumbnailQueueManagerTest(4, mockState);
  });

  it('同じパスを2回 enqueue しても1件しかキューに入らない', () => {
    queue.enqueuePriority('a.png');
    queue.enqueuePriority('a.png');
    expect(queue.priorityQueue.length).toBe(1);
    expect(queue.priorityQueueSet.size).toBe(1);
  });

  it('異なるパスはそれぞれキューに入る', () => {
    queue.enqueuePriority('a.png');
    queue.enqueuePriority('b.png');
    expect(queue.priorityQueue.length).toBe(2);
    expect(queue.priorityQueueSet.size).toBe(2);
  });

  it('thumbnailUrlsに既にある場合はキューに入らない', () => {
    mockState.thumbnailUrls.set('cached.png', 'http://example.com/thumb.jpg');
    queue.enqueuePriority('cached.png');
    expect(queue.priorityQueue.length).toBe(0);
    expect(queue.priorityQueueSet.size).toBe(0);
  });

  it('clear() で priorityQueue と priorityQueueSet 両方がリセットされる', () => {
    queue.enqueuePriority('a.png');
    queue.enqueuePriority('b.png');
    queue.clear();
    expect(queue.priorityQueue.length).toBe(0);
    expect(queue.priorityQueueSet.size).toBe(0);
  });

  it('remove() でArray・Set両方から削除される', () => {
    queue.enqueuePriority('a.png');
    queue.enqueuePriority('b.png');
    queue.remove('a.png');
    expect(queue.priorityQueue.length).toBe(1);
    expect(queue.priorityQueueSet.has('a.png')).toBe(false);
    expect(queue.priorityQueueSet.has('b.png')).toBe(true);
  });

  it('dequeue() でArray・Set両方から取り出せる', () => {
    queue.enqueuePriority('a.png');
    queue.enqueuePriority('b.png');
    const out = queue.dequeue();
    expect(out).toBe('a.png');
    expect(queue.priorityQueueSet.has('a.png')).toBe(false);
    expect(queue.priorityQueue.length).toBe(1);
  });

  it('dequeue()後に同じパスを再enqueueできる（Setから削除されているため）', () => {
    queue.enqueuePriority('a.png');
    queue.dequeue();
    queue.enqueuePriority('a.png');
    expect(queue.priorityQueue.length).toBe(1);
    expect(queue.priorityQueueSet.size).toBe(1);
  });

  it('activeTasksにあるパスはキューに入らない', () => {
    queue.activeTasks.add('active.png');
    queue.enqueuePriority('active.png');
    expect(queue.priorityQueue.length).toBe(0);
    expect(queue.priorityQueueSet.size).toBe(0);
  });

  it('Array と Set のサイズは常に一致する', () => {
    queue.enqueuePriority('x.png');
    queue.enqueuePriority('y.png');
    queue.enqueuePriority('x.png'); // 重複
    expect(queue.priorityQueue.length).toBe(queue.priorityQueueSet.size);

    queue.remove('x.png');
    expect(queue.priorityQueue.length).toBe(queue.priorityQueueSet.size);
  });
});
