import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsStore, SettingsStoreClass } from '../src/common/settings-store.js';

describe('SettingsStore & Migration Specifications', () => {
  let mockStorage;
  let mockApi;

  beforeEach(() => {
    vi.useFakeTimers();

    // モックの localStorage
    const store = new Map();
    mockStorage = {
      length: 0,
      getItem: vi.fn((k) => (store.has(k) ? store.get(k) : null)),
      setItem: vi.fn((k, v) => {
        store.set(k, String(v));
        mockStorage.length = store.size;
      }),
      removeItem: vi.fn((k) => {
        store.delete(k);
        mockStorage.length = store.size;
      }),
      clear: vi.fn(() => {
        store.clear();
        mockStorage.length = 0;
      }),
      key: vi.fn((idx) => Array.from(store.keys())[idx] || null)
    };

    global.localStorage = mockStorage;

    mockApi = {
      initSettings: vi.fn(),
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      setSettingsBatch: vi.fn().mockResolvedValue(),
      deleteSetting: vi.fn().mockResolvedValue(),
      getAllSettings: vi.fn()
    };

    SettingsStore.resetForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Case 1: No localStorage & No DB file', () => {
    it('initializes with empty settings when neither localStorage nor DB exists', async () => {
      // localStorage は空
      expect(mockStorage.length).toBe(0);

      // Rust側は空マップを返す（新設）
      mockApi.initSettings.mockResolvedValue({});

      await SettingsStore.init(mockApi);

      expect(mockApi.initSettings).toHaveBeenCalledWith({});
      expect(SettingsStore.getAll()).toEqual({});
      expect(SettingsStore.getItem('currentDirectory')).toBeNull();
      expect(SettingsStore.getItem('currentDirectory', 'PC')).toBe('PC');
    });
  });

  describe('Case 2: With localStorage & No DB file', () => {
    it('migrates localStorage settings to DB and adopts them', async () => {
      // localStorage に既存設定がある
      mockStorage.setItem('currentDirectory', 'D:/Illustrations');
      mockStorage.setItem('thumbnailScale', '1.2');
      mockStorage.setItem('tabsState', JSON.stringify({ tabs: [{ path: 'D:/Illustrations' }] }));

      // Rust側は渡されたエントリをDBに保存し、採用して返す
      mockApi.initSettings.mockImplementation(async (entries) => {
        return { ...entries };
      });

      await SettingsStore.init(mockApi);

      expect(mockApi.initSettings).toHaveBeenCalledWith({
        currentDirectory: 'D:/Illustrations',
        thumbnailScale: '1.2',
        tabsState: JSON.stringify({ tabs: [{ path: 'D:/Illustrations' }] })
      });

      expect(SettingsStore.getItem('currentDirectory')).toBe('D:/Illustrations');
      expect(SettingsStore.getItem('thumbnailScale')).toBe('1.2');
    });

    it('excludes temporary viewer IPC keys from migration', async () => {
      mockStorage.setItem('currentDirectory', 'C:/Photos');
      mockStorage.setItem('viewerPaths', '["C:/Photos/1.png"]');
      mockStorage.setItem('viewerStartIndex', '0');
      mockStorage.setItem('viewerInitialData', '{"test":true}');

      mockApi.initSettings.mockImplementation(async (entries) => entries);

      await SettingsStore.init(mockApi);

      // 一時キーは initSettings に渡されないこと
      expect(mockApi.initSettings).toHaveBeenCalledWith({
        currentDirectory: 'C:/Photos'
      });
      expect(mockApi.initSettings.mock.calls[0][0].viewerPaths).toBeUndefined();
    });
  });

  describe('Case 3: No localStorage & With DB file', () => {
    it('starts following the settings stored in DB file', async () => {
      // localStorage は空
      expect(mockStorage.length).toBe(0);

      // DBには設定が保存されている
      const dbSettings = {
        currentDirectory: 'E:/SavedFromDb',
        leftWidth: '280',
        currentSort: JSON.stringify({ key: 'date', asc: false })
      };
      mockApi.initSettings.mockResolvedValue(dbSettings);

      await SettingsStore.init(mockApi);

      expect(mockApi.initSettings).toHaveBeenCalledWith({});
      expect(SettingsStore.getItem('currentDirectory')).toBe('E:/SavedFromDb');
      expect(SettingsStore.getItem('leftWidth')).toBe('280');

      // localStorage も DB の内容で最新化（同期）されること
      expect(mockStorage.setItem).toHaveBeenCalledWith('currentDirectory', 'E:/SavedFromDb');
      expect(mockStorage.setItem).toHaveBeenCalledWith('leftWidth', '280');
    });
  });

  describe('Case 4: With localStorage & With DB file', () => {
    it('prioritizes DB settings over localStorage and synchronizes localStorage', async () => {
      // localStorage に古い設定がある
      mockStorage.setItem('currentDirectory', 'C:/OldLocalDir');
      mockStorage.setItem('thumbnailScale', '1.0');

      // DB側には最新の設定がある（Source of Truth）
      const dbSettings = {
        currentDirectory: 'Z:/MasterFromDb',
        thumbnailScale: '1.8',
        favorites: JSON.stringify([{ name: 'Anime', path: 'Z:/Anime' }])
      };
      mockApi.initSettings.mockResolvedValue(dbSettings);

      await SettingsStore.init(mockApi);

      // DB の設定が採用されること
      expect(SettingsStore.getItem('currentDirectory')).toBe('Z:/MasterFromDb');
      expect(SettingsStore.getItem('thumbnailScale')).toBe('1.8');
      expect(SettingsStore.getItem('favorites')).toBe(dbSettings.favorites);

      // localStorage も DB の内容に同期上書きされること
      expect(mockStorage.getItem('currentDirectory')).toBe('Z:/MasterFromDb');
      expect(mockStorage.getItem('thumbnailScale')).toBe('1.8');
    });
  });

  describe('CRUD & Debounced Batching', () => {
    it('updates cache synchronously and batches saves to DB', async () => {
      mockApi.initSettings.mockResolvedValue({});
      await SettingsStore.init(mockApi);

      // setItem を連続実行
      SettingsStore.setItem('mainWinX', 100);
      SettingsStore.setItem('mainWinY', 200);
      SettingsStore.setItem('mainWinWidth', 1280);

      // 即時同期読み取り可能
      expect(SettingsStore.getItem('mainWinX')).toBe('100');
      expect(SettingsStore.getItem('mainWinY')).toBe('200');
      expect(SettingsStore.getItem('mainWinWidth')).toBe('1280');

      // 100ms経過前はAPIは呼ばれていない
      expect(mockApi.setSettingsBatch).not.toHaveBeenCalled();

      // タイマーを進める
      vi.advanceTimersByTime(100);

      // 1回のバッチ呼び出しにまとめられていること
      expect(mockApi.setSettingsBatch).toHaveBeenCalledTimes(1);
      expect(mockApi.setSettingsBatch).toHaveBeenCalledWith({
        mainWinX: '100',
        mainWinY: '200',
        mainWinWidth: '1280'
      });
    });

    it('flushes pending saves immediately on flush()', async () => {
      mockApi.initSettings.mockResolvedValue({});
      await SettingsStore.init(mockApi);

      SettingsStore.setItem('currentDirectory', 'D:/FastSave');
      expect(mockApi.setSettingsBatch).not.toHaveBeenCalled();

      await SettingsStore.flush();

      expect(mockApi.setSettingsBatch).toHaveBeenCalledTimes(1);
      expect(mockApi.setSettingsBatch).toHaveBeenCalledWith({
        currentDirectory: 'D:/FastSave'
      });
    });

    it('removes item from cache, localStorage, and DB', async () => {
      mockApi.initSettings.mockResolvedValue({ tempKey: 'tempVal' });
      await SettingsStore.init(mockApi);

      expect(SettingsStore.getItem('tempKey')).toBe('tempVal');

      SettingsStore.removeItem('tempKey');

      expect(SettingsStore.getItem('tempKey')).toBeNull();
      expect(mockStorage.removeItem).toHaveBeenCalledWith('tempKey');
      expect(mockApi.deleteSetting).toHaveBeenCalledWith('tempKey');
    });
  });
});
