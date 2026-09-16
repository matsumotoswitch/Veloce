import { describe, it, expect, beforeEach } from 'vitest';
import {
  appState,
  dndState,
  fileOpsState,
  layoutState,
  thumbnailState
} from '../src/renderer/renderer-state.js';

describe('Subdomain State Modularization & AppState Facade', () => {
  beforeEach(() => {
    dndState.reset();
    fileOpsState.clear();
    thumbnailState.resetProgress();
    thumbnailState.urls.clear();
    thumbnailState.visiblePathSet.clear();
  });

  describe('dndState (Drag & Drop Domain)', () => {
    it('dndState の直接操作と reset が正しく機能すること', () => {
      dndState.paths = ['/path/to/a.png', '/path/to/b.png'];
      dndState.indices = [0, 1];
      dndState.cachedRoot = '/path/to';
      dndState.isAppDragging = true;
      dndState.pendingRefresh = true;

      expect(dndState.paths).toHaveLength(2);
      expect(dndState.isAppDragging).toBe(true);

      dndState.reset();
      expect(dndState.paths).toEqual([]);
      expect(dndState.indices).toEqual([]);
      expect(dndState.cachedRoot).toBeNull();
      expect(dndState.isAppDragging).toBe(false);
      // pendingRefresh は reset で保持される仕様（リフレッシュ待機のため）
      expect(dndState.pendingRefresh).toBe(true);
    });

    it('appState.dragState 経由のプロキシ読み書きが dndState と同期すること', () => {
      appState.dragState = {
        paths: ['/foo/bar.png'],
        indices: [5],
        cachedRoot: '/foo',
        isAppDragging: true,
        pendingRefresh: false
      };

      expect(dndState.paths).toEqual(['/foo/bar.png']);
      expect(dndState.indices).toEqual([5]);
      expect(dndState.isAppDragging).toBe(true);
      expect(appState.dragState.paths).toEqual(['/foo/bar.png']);
    });
  });

  describe('fileOpsState (Undo / File Operations Domain)', () => {
    it('fileOpsState の push, pop, clear が正しく機能すること', () => {
      expect(fileOpsState.undoStack).toHaveLength(0);

      const action1 = { type: 'rename', oldPath: 'a.png', newPath: 'b.png' };
      const action2 = { type: 'delete', paths: ['c.png'] };

      fileOpsState.push(action1);
      fileOpsState.push(action2);
      expect(fileOpsState.undoStack).toHaveLength(2);

      const popped = fileOpsState.pop();
      expect(popped).toEqual(action2);
      expect(fileOpsState.undoStack).toHaveLength(1);

      fileOpsState.clear();
      expect(fileOpsState.undoStack).toHaveLength(0);
    });

    it('appState.undoStack 経由のプロキシ読み書きが fileOpsState と同期すること', () => {
      appState.undoStack = [{ type: 'trash', paths: ['x.png'] }];
      expect(fileOpsState.undoStack).toHaveLength(1);
      expect(fileOpsState.undoStack[0].type).toBe('trash');

      fileOpsState.push({ type: 'move', src: '1', dest: '2' });
      expect(appState.undoStack).toHaveLength(2);

      appState.undoStack = [];
      expect(fileOpsState.undoStack).toHaveLength(0);
    });
  });

  describe('layoutState (Pane Resizing & Layout Domain)', () => {
    it('layoutState のプロパティが更新できること', () => {
      layoutState.leftWidth = 320;
      layoutState.leftVisible = false;
      layoutState.rightWidth = 400;
      layoutState.rightVisible = true;

      expect(layoutState.leftWidth).toBe(320);
      expect(layoutState.leftVisible).toBe(false);
    });

    it('appState.layout への Object.assign 代入が layoutState に反映されること', () => {
      appState.layout = {
        leftWidth: 180,
        leftVisible: true,
        rightWidth: 280,
        rightVisible: false
      };

      expect(layoutState.leftWidth).toBe(180);
      expect(layoutState.leftVisible).toBe(true);
      expect(layoutState.rightWidth).toBe(280);
      expect(layoutState.rightVisible).toBe(false);

      expect(appState.layout.leftWidth).toBe(180);
    });
  });

  describe('thumbnailState (Thumbnail & Pipeline Progress Domain)', () => {
    it('thumbnailState の URL キャッシュおよび visiblePathSet が正しく動作すること', () => {
      thumbnailState.urls.set('/img/1.png', 'blob:http://localhost/uuid-1');
      thumbnailState.urls.set('/img/2.png', 'blob:http://localhost/uuid-2');
      thumbnailState.visiblePathSet.add('/img/1.png');

      expect(thumbnailState.urls.size).toBe(2);
      expect(thumbnailState.visiblePathSet.has('/img/1.png')).toBe(true);
      expect(appState.thumbnailUrls.size).toBe(2);
      expect(appState.visiblePathSet.has('/img/1.png')).toBe(true);
    });

    it('thumbnailState.resetProgress が進捗情報をリセットすること', () => {
      thumbnailState.progress.totalRequested = 25;
      thumbnailState.progress.completed = 10;
      thumbnailState.progress.counted.add('/img/1.png');
      thumbnailState.progress.lastToastTime = 12345;

      expect(appState.thumbnailTotalRequested).toBe(25);
      expect(appState.thumbnailCompleted).toBe(10);

      thumbnailState.resetProgress();

      expect(thumbnailState.progress.totalRequested).toBe(0);
      expect(thumbnailState.progress.completed).toBe(0);
      expect(thumbnailState.progress.counted.size).toBe(0);
      expect(thumbnailState.progress.lastToastTime).toBe(0);
      expect(appState.thumbnailTotalRequested).toBe(0);
      expect(appState.thumbnailCompleted).toBe(0);
    });

    it('appState 側のプロキシ経由で進捗値の読み書きができること', () => {
      appState.thumbnailTotalRequested = 50;
      appState.thumbnailCompleted = 25;
      appState.preloadCursor = 100;
      appState.isPreloadRunning = true;

      expect(thumbnailState.progress.totalRequested).toBe(50);
      expect(thumbnailState.progress.completed).toBe(25);
      expect(thumbnailState.preloadCursor).toBe(100);
      expect(thumbnailState.isPreloadRunning).toBe(true);
    });
  });
});
