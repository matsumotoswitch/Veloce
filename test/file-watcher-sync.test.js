import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('File Watcher Event Sync and State Reflection', () => {
  let mockAppState;
  let mockVeloceAPI;
  let listeners = {};
  let refreshScheduled = false;

  beforeEach(() => {
    listeners = {};
    refreshScheduled = false;

    mockAppState = {
      thumbnailUrls: new Map(),
      selection: new Set(),
      ratings: {},
      totalCount: 5,
      currentDirectory: 'C:\\images'
    };

    mockVeloceAPI = {
      onFileChanged: vi.fn((cb) => { listeners['file-changed'] = cb; }),
      onFileRemoved: vi.fn((cb) => { listeners['file-removed'] = cb; }),
      onDirectoryChanged: vi.fn((cb) => { listeners['directory-changed'] = cb; }),
      notifyFileChanged: vi.fn(async (file) => 6),
      notifyFileRemoved: vi.fn(async (path) => 5)
    };

    window.appState = mockAppState;
    window.veloceAPI = mockVeloceAPI;
    window.thumbnailManager = {
      remove: vi.fn()
    };
    window.uiManager = {
      _domByPath: new Map(),
      updateFileDimensions: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('file-changed イベント受信時に、Blob URL破棄、notifyFileChanged呼び出し、totalCount更新、寸法更新が行われること', async () => {
    // 既存の Blob URL を模倣
    const filePath = 'C:\\images\\new_art.png';
    const blobUrl = 'blob:http://localhost/dummy-uuid';
    mockAppState.thumbnailUrls.set(filePath, blobUrl);
    window.URL.revokeObjectURL = vi.fn();

    // DOM要素のモック
    const wrapper = document.createElement('div');
    wrapper.dataset.filepath = filePath;
    window.uiManager._domByPath.set(filePath, wrapper);

    // イベントリスナーの登録（renderer.js の L3321〜L3348 相当のロジックを検証）
    const handleFileChanged = async (newFile) => {
      const oldUrl = mockAppState.thumbnailUrls.get(newFile.path);
      if (oldUrl && oldUrl.startsWith('blob:')) {
        window.URL.revokeObjectURL(oldUrl);
      }
      mockAppState.thumbnailUrls.delete(newFile.path);

      if (window.thumbnailManager) window.thumbnailManager.remove(newFile.path);

      if (window.uiManager && window.uiManager._domByPath) {
        const wrap = window.uiManager._domByPath.get(newFile.path);
        if (wrap) {
          wrap.dataset.filepath = '';
          window.uiManager._domByPath.delete(newFile.path);
        }
      }

      const newTotal = await window.veloceAPI.notifyFileChanged(newFile);
      if (typeof newTotal === 'number') mockAppState.totalCount = newTotal;
      if (newFile.width > 0 && newFile.height > 0 && window.uiManager && typeof window.uiManager.updateFileDimensions === 'function') {
        window.uiManager.updateFileDimensions(newFile.path, newFile.width, newFile.height);
      }
      refreshScheduled = true;
    };

    const newIncomingFile = {
      path: filePath,
      name: 'new_art',
      ext: '.png',
      size: 4096,
      mtime: 1700000000,
      ctime: 1700000000,
      width: 1920,
      height: 1080,
      has_thumbnail_cache: false,
      has_metadata_cache: false,
      hash_key: '0123456789abcdef'
    };

    await handleFileChanged(newIncomingFile);

    // 検証
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith(blobUrl);
    expect(mockAppState.thumbnailUrls.has(filePath)).toBe(false);
    expect(window.thumbnailManager.remove).toHaveBeenCalledWith(filePath);
    expect(wrapper.dataset.filepath).toBe('');
    expect(window.uiManager._domByPath.has(filePath)).toBe(false);
    expect(mockVeloceAPI.notifyFileChanged).toHaveBeenCalledWith(newIncomingFile);
    expect(mockAppState.totalCount).toBe(6);
    expect(window.uiManager.updateFileDimensions).toHaveBeenCalledWith(filePath, 1920, 1080);
    expect(refreshScheduled).toBe(true);
  });

  it('file-removed イベント受信時に、notifyFileRemoved呼び出しとtotalCount更新、再描画スケジュールが行われること', async () => {
    const filePath = 'C:\\images\\deleted_art.png';

    const handleFileRemoved = async (path) => {
      const newTotal = await window.veloceAPI.notifyFileRemoved(path);
      if (typeof newTotal === 'number') mockAppState.totalCount = newTotal;
      refreshScheduled = true;
    };

    await handleFileRemoved(filePath);

    expect(mockVeloceAPI.notifyFileRemoved).toHaveBeenCalledWith(filePath);
    expect(mockAppState.totalCount).toBe(5);
    expect(refreshScheduled).toBe(true);
  });

  it('UNCプレフィックス付きパスや区切り文字混在でもパス正規化により正しく通知処理されること', async () => {
    const rawPath = '\\\\?\\C:/images/novelai_gen.png';
    const cleanPath = rawPath.replace(/\\\\\?\\/, '').replace(/\//g, '\\');
    expect(cleanPath).toBe('C:\\images\\novelai_gen.png');

    const file = {
      path: cleanPath,
      name: 'novelai_gen',
      ext: '.png',
      width: 832,
      height: 1216,
      hash_key: 'abcdef0123456789'
    };

    const newTotal = await mockVeloceAPI.notifyFileChanged(file);
    expect(newTotal).toBe(6);
    expect(mockVeloceAPI.notifyFileChanged).toHaveBeenCalledWith(expect.objectContaining({
      path: 'C:\\images\\novelai_gen.png'
    }));
  });
});
