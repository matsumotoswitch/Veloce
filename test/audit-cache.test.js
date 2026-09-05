import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Audit Cache Lifecycle and Progress Sync', () => {
  let toasts = [];
  let uiManager;

  beforeEach(() => {
    toasts = [];
    uiManager = {
      showConfirm: vi.fn(),
      showToast: vi.fn((msg, duration, id, type) => {
        toasts.push({ msg, duration, id, type });
      }),
      applyGlowEffect: vi.fn(),
      hideCustomTooltip: vi.fn(),
      elements: {
        auditCacheBtn: {
          addEventListener: vi.fn()
        }
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not invoke audit_cache if user cancels confirm dialog', async () => {
    uiManager.showConfirm.mockResolvedValue(false);
    const mockInvoke = vi.fn();
    const mockListen = vi.fn();

    // シミュレーション実行関数
    async function runAudit() {
      const isConfirmed = await uiManager.showConfirm('実行しますか？');
      if (isConfirmed) {
        let unlisten = null;
        try {
          unlisten = await mockListen('audit-progress', () => {});
          uiManager.showToast('キャッシュの精査を開始しました...', 0, 'cache-audit', 'info');
          await mockInvoke('audit_cache');
          uiManager.showToast('キャッシュの精査と修復が完了しました！', 3000, 'cache-audit', 'success');
        } finally {
          if (unlisten) unlisten();
        }
      }
    }

    await runAudit();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
    expect(toasts.length).toBe(0);
  });

  it('should update progress toast while running and show completion toast ONLY after invoke resolves', async () => {
    uiManager.showConfirm.mockResolvedValue(true);
    let progressCallback = null;
    const unlistenMock = vi.fn();
    const mockListen = vi.fn().mockImplementation((event, cb) => {
      progressCallback = cb;
      return Promise.resolve(unlistenMock);
    });

    let resolveInvoke;
    const invokePromise = new Promise(resolve => {
      resolveInvoke = resolve;
    });
    const mockInvoke = vi.fn().mockReturnValue(invokePromise);

    async function runAudit() {
      const isConfirmed = await uiManager.showConfirm('実行しますか？');
      if (isConfirmed) {
        let unlisten = null;
        try {
          unlisten = await mockListen('audit-progress', (event) => {
            const p = event.payload;
            uiManager.showToast(`キャッシュ精査中... ${p.current} / ${p.total}\n削除: ${p.deleted} | 修復: ${p.fixed}`, 0, 'cache-audit', 'info');
          });
          uiManager.showToast('キャッシュの精査を開始しました...', 0, 'cache-audit', 'info');
          await mockInvoke('audit_cache');
          uiManager.showToast('キャッシュの精査と修復が完了しました！', 3000, 'cache-audit', 'success');
        } catch (err) {
          uiManager.showToast('キャッシュの精査中にエラーが発生しました。', 3000, 'cache-audit', 'error');
        } finally {
          if (unlisten) unlisten();
        }
      }
    }

    const auditRunPromise = runAudit();

    // 開始直後: 開始トーストが表示され、invokeが呼ばれるがまだ完了していない
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('audit_cache'));
    expect(toasts.some(t => t.msg === 'キャッシュの精査を開始しました...')).toBe(true);
    expect(toasts.some(t => t.msg === 'キャッシュの精査と修復が完了しました！')).toBe(false);
    expect(unlistenMock).not.toHaveBeenCalled();

    // 進行中イベントを受信: 進捗トーストが更新される
    progressCallback({ payload: { current: 50, total: 100, deleted: 10, fixed: 5 } });
    expect(toasts.some(t => t.msg.includes('50 / 100') && t.msg.includes('削除: 10 | 修復: 5'))).toBe(true);
    expect(toasts.some(t => t.msg === 'キャッシュの精査と修復が完了しました！')).toBe(false);

    // バックエンド処理が完了してinvokeが解決
    resolveInvoke();
    await auditRunPromise;

    // 完了後: 完了トーストが表示され、リスナーが解除される
    expect(toasts.some(t => t.msg === 'キャッシュの精査と修復が完了しました！' && t.type === 'success')).toBe(true);
    expect(unlistenMock).toHaveBeenCalled();
  });

  it('should show error toast and unlisten if audit_cache rejects', async () => {
    uiManager.showConfirm.mockResolvedValue(true);
    const unlistenMock = vi.fn();
    const mockListen = vi.fn().mockResolvedValue(unlistenMock);
    const mockInvoke = vi.fn().mockRejectedValue(new Error('Database error'));

    async function runAudit() {
      const isConfirmed = await uiManager.showConfirm('実行しますか？');
      if (isConfirmed) {
        let unlisten = null;
        try {
          unlisten = await mockListen('audit-progress', () => {});
          uiManager.showToast('キャッシュの精査を開始しました...', 0, 'cache-audit', 'info');
          await mockInvoke('audit_cache');
          uiManager.showToast('キャッシュの精査と修復が完了しました！', 3000, 'cache-audit', 'success');
        } catch (err) {
          uiManager.showToast('キャッシュの精査中にエラーが発生しました。', 3000, 'cache-audit', 'error');
        } finally {
          if (unlisten) unlisten();
        }
      }
    }

    await runAudit();
    expect(toasts.some(t => t.msg === 'キャッシュの精査中にエラーが発生しました。' && t.type === 'error')).toBe(true);
    expect(unlistenMock).toHaveBeenCalled();
  });
});
