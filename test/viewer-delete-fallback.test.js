/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Viewer Delete Fallback (Cause 6)', () => {
  let originalVeloceAPI;
  let originalTauri;

  beforeEach(() => {
    vi.resetModules();
    originalVeloceAPI = window.veloceAPI;
    originalTauri = window.__TAURI__;
    window.scrollTo = vi.fn();

    document.body.innerHTML = `
      <img id="viewer-img" decoding="async" src="" alt="">
      <div id="border-overlay"></div>
    `;

    // veloceAPI モック
    window.veloceAPI = {
      trashFile: vi.fn().mockResolvedValue(true),
      notifyFileRemoved: vi.fn().mockResolvedValue(true),
      closeWindow: vi.fn(),
      getVideoServerPort: vi.fn().mockResolvedValue(12345),
      getVideoServerToken: vi.fn().mockResolvedValue('token'),
      convertFileSrc: vi.fn(p => `asset://localhost/${encodeURIComponent(p)}`),
      getViewerImage: vi.fn().mockResolvedValue(null),
      showWindow: vi.fn().mockResolvedValue(true),
      isViewerMaximized: vi.fn().mockResolvedValue(false),
      getAllRatings: vi.fn().mockResolvedValue({})
    };

    // Tauri モック
    window.__TAURI__ = {
      event: {
        listen: vi.fn().mockResolvedValue(() => {})
      }
    };
  });

  afterEach(() => {
    window.veloceAPI = originalVeloceAPI;
    window.__TAURI__ = originalTauri;
    vi.restoreAllMocks();
  });

  it('advanceAfterPathDeleted should advance to next image when viewer-list-updated does not arrive', async () => {
    const { advanceAfterPathDeleted } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/img/1.png', 'C:/img/2.png', 'C:/img/3.png'];
    viewerState.currentIndex = 1;
    viewerState.currentImagePath = 'C:/img/2.png';
    viewerState.totalImages = 3;

    // 削除処理とフォールバックの実行
    await advanceAfterPathDeleted('C:/img/2.png');

    // 1. paths から削除パスが除去されていること
    expect(viewerState.paths).toEqual(['C:/img/1.png', 'C:/img/3.png']);
    expect(viewerState.totalImages).toBe(2);

    // 2. 次の画像 (C:/img/3.png) に進み、currentImagePath が更新されること
    expect(viewerState.currentIndex).toBe(1);
    expect(viewerState.currentImagePath).toBe('C:/img/3.png');
    expect(window.veloceAPI.closeWindow).not.toHaveBeenCalled();
  });

  it('advanceAfterPathDeleted should close window when last remaining image is deleted', async () => {
    const { advanceAfterPathDeleted } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/img/single.png'];
    viewerState.currentIndex = 0;
    viewerState.currentImagePath = 'C:/img/single.png';
    viewerState.totalImages = 1;

    // 最後の1件の削除フォールバック
    await advanceAfterPathDeleted('C:/img/single.png');

    // 1. paths が空になること
    expect(viewerState.paths).toEqual([]);
    expect(viewerState.totalImages).toBe(0);

    // 2. closeWindow が呼ばれること
    expect(window.veloceAPI.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('advanceAfterPathDeleted should not duplicate transition if viewer-list-updated arrived first', async () => {
    const { advanceAfterPathDeleted } = await import('../src/viewer/viewer.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    viewerState.paths = ['C:/img/1.png', 'C:/img/3.png'];
    viewerState.currentIndex = 1;
    viewerState.currentImagePath = 'C:/img/3.png'; // 既に 3.png に切り替わっている
    viewerState.totalImages = 2;

    // 既に切り替わった後に遅延して advanceAfterPathDeleted が呼ばれた場合
    await advanceAfterPathDeleted('C:/img/2.png');

    // 二重にインデックス変更や closeWindow が起きないこと
    expect(viewerState.currentIndex).toBe(1);
    expect(viewerState.currentImagePath).toBe('C:/img/3.png');
    expect(window.veloceAPI.closeWindow).not.toHaveBeenCalled();
  });
});
