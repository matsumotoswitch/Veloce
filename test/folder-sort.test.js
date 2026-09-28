import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  SettingsStore,
  getFolderSort,
  setFolderSort,
  normalizeFolderPath
} from '../src/common/settings-store.js';

describe('Per-Folder and Per-Smart-Folder Sort Persistence (folder-sort.test.js)', () => {
  let mockStorage;
  let mockApi;

  beforeEach(() => {
    vi.clearAllMocks();

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
      })
    };

    mockApi = {
      initSettings: vi.fn().mockImplementation((entries) => Promise.resolve(entries || {})),
      setSettingsBatch: vi.fn().mockResolvedValue(),
      deleteSetting: vi.fn().mockResolvedValue()
    };

    // グローバルモック
    window.localStorage = mockStorage;
    window.veloceAPI = mockApi;
    SettingsStore.resetForTesting();

    appState.sortConfig = { key: 'name', asc: true };
    appState.currentDirectory = '';
    appState.tabs = [];
    appState.activeTabIndex = 0;
  });

  describe('Path normalization', () => {
    it('normalizes normal Windows folder paths with trailing slashes and forward slashes', () => {
      expect(normalizeFolderPath('C:/images/folder1/')).toBe('C:\\images\\folder1');
      expect(normalizeFolderPath('C:\\images\\folder1\\')).toBe('C:\\images\\folder1');
      expect(normalizeFolderPath('C:\\images\\folder1')).toBe('C:\\images\\folder1');
    });

    it('preserves smart folder URIs without alteration', () => {
      expect(normalizeFolderPath('smart://fav_5')).toBe('smart://fav_5');
      expect(normalizeFolderPath('smart://all_portrait')).toBe('smart://all_portrait');
    });
  });

  describe('Sort persistence per folder', () => {
    it('saves and retrieves sort configuration for regular directory paths', async () => {
      await SettingsStore.init(mockApi);

      const pathA = 'C:\\images\\landscape';
      const pathB = 'C:\\images\\portrait';

      // Initially null
      expect(getFolderSort(pathA)).toBeNull();
      expect(getFolderSort(pathB)).toBeNull();

      // Set sort for pathA
      setFolderSort(pathA, { key: 'mtime', asc: false });
      expect(getFolderSort(pathA)).toEqual({ key: 'mtime', asc: false });

      // PathB remains null
      expect(getFolderSort(pathB)).toBeNull();

      // Set sort for pathB with different criteria
      setFolderSort(pathB, { key: 'rating', asc: false });
      expect(getFolderSort(pathB)).toEqual({ key: 'rating', asc: false });

      // PathA should keep its own sort configuration
      expect(getFolderSort(pathA)).toEqual({ key: 'mtime', asc: false });
    });

    it('saves and retrieves sort configuration for smart folder URIs', async () => {
      await SettingsStore.init(mockApi);

      const smart1 = 'smart://fav_stars_5';
      const smart2 = 'smart://recent_wallpapers';

      setFolderSort(smart1, { key: 'width', asc: true });
      setFolderSort(smart2, { key: 'height', asc: false });

      expect(getFolderSort(smart1)).toEqual({ key: 'width', asc: true });
      expect(getFolderSort(smart2)).toEqual({ key: 'height', asc: false });
    });

    it('works across different path formats pointing to the same folder', async () => {
      await SettingsStore.init(mockApi);

      setFolderSort('D:/Photos/2026/Summer/', { key: 'size', asc: false });

      expect(getFolderSort('D:\\Photos\\2026\\Summer')).toEqual({ key: 'size', asc: false });
      expect(getFolderSort('D:/Photos/2026/Summer')).toEqual({ key: 'size', asc: false });
    });
  });

  describe('Integration with tabs and folder navigation', () => {
    it('restores per-folder sort when switching folders in tabs', async () => {
      await SettingsStore.init(mockApi);

      const folderA = 'C:\\Data\\FolderA';
      const smartFolder = 'smart://fav_5';

      setFolderSort(folderA, { key: 'mtime', asc: false });
      setFolderSort(smartFolder, { key: 'rating', asc: false });

      const tab1 = { id: 1, path: folderA, sortConfig: { key: 'name', asc: true } };
      const tab2 = { id: 2, path: smartFolder, sortConfig: { key: 'name', asc: true } };
      appState.tabs = [tab1, tab2];
      appState.activeTabIndex = 0;

      // Simulate loading folderA
      const sortA = getFolderSort(tab1.path);
      if (sortA) {
        appState.sortConfig = { ...sortA };
        tab1.sortConfig = { ...sortA };
      }
      expect(appState.sortConfig).toEqual({ key: 'mtime', asc: false });

      // Simulate switching to smart folder tab
      appState.activeTabIndex = 1;
      const sortSmart = getFolderSort(tab2.path);
      if (sortSmart) {
        appState.sortConfig = { ...sortSmart };
        tab2.sortConfig = { ...sortSmart };
      }
      expect(appState.sortConfig).toEqual({ key: 'rating', asc: false });

      // Simulate switching back to tab 1
      appState.activeTabIndex = 0;
      const sortBack = getFolderSort(tab1.path);
      if (sortBack) {
        appState.sortConfig = { ...sortBack };
        tab1.sortConfig = { ...sortBack };
      }
      expect(appState.sortConfig).toEqual({ key: 'mtime', asc: false });
    });
  });
});
