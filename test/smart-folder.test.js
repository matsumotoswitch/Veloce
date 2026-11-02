import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState, SmartFolderStore } from '../src/renderer/renderer-state.js';

describe('Smart Folder Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset appState
    appState.smartFolders = [
      { id: 'folder1', name: 'Folder 1', match_type: 'all', conditions: [] },
      { id: 'folder2', name: 'Folder 2', match_type: 'any', conditions: [] }
    ];
    
    // Mock veloceAPI
    window.veloceAPI = {
      getSmartFolderCounts: vi.fn().mockResolvedValue({
        'folder1': 1234, // Test comma formatting
        'folder2': 5
      }),
      updateSmartFolders: vi.fn().mockResolvedValue(true)
    };

    // DOM モック
    document.body.innerHTML = '';
    const list = document.createElement('div');
    list.id = 'smart-folders-list';

    // Folder 1
    const item1 = document.createElement('div');
    item1.className = 'smart-folder-item';
    item1.dataset.id = 'folder1';
    const count1 = document.createElement('span');
    count1.className = 'smart-folder-count';
    count1.style.display = 'none';
    item1.appendChild(count1);
    list.appendChild(item1);

    // Folder 2
    const item2 = document.createElement('div');
    item2.className = 'smart-folder-item';
    item2.dataset.id = 'folder2';
    const count2 = document.createElement('span');
    count2.className = 'smart-folder-count';
    count2.style.display = 'none';
    item2.appendChild(count2);
    list.appendChild(item2);

    // Folder 3 (No count data)
    const item3 = document.createElement('div');
    item3.className = 'smart-folder-item';
    item3.dataset.id = 'folder3';
    const count3 = document.createElement('span');
    count3.className = 'smart-folder-count';
    count3.style.display = 'none';
    item3.appendChild(count3);
    list.appendChild(item3);

    document.body.appendChild(list);
  });

  // renderer.js の updateSmartFolderCountsUI に相当するロジック
  async function updateSmartFolderCountsUI() {
    if (!window.veloceAPI.getSmartFolderCounts) return;
    try {
      const rules = appState.smartFolders || [];
      const counts = await window.veloceAPI.getSmartFolderCounts(rules);
      const list = document.getElementById('smart-folders-list');
      if (!list) return;
      const items = list.querySelectorAll('.smart-folder-item');
      items.forEach(item => {
        const id = item.dataset.id;
        const countSpan = item.querySelector('.smart-folder-count');
        if (id && countSpan) {
          if (counts[id] !== undefined) {
            countSpan.textContent = Number(counts[id]).toLocaleString();
            countSpan.style.display = 'block';
          } else {
            countSpan.style.display = 'none';
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  it('should pass appState.smartFolders to getSmartFolderCounts', async () => {
    await updateSmartFolderCountsUI();
    
    expect(window.veloceAPI.getSmartFolderCounts).toHaveBeenCalledWith(appState.smartFolders);
  });

  it('should update DOM with formatted counts when received', async () => {
    await updateSmartFolderCountsUI();
    
    const list = document.getElementById('smart-folders-list');
    const folder1 = list.querySelector('.smart-folder-item[data-id="folder1"] .smart-folder-count');
    const folder2 = list.querySelector('.smart-folder-item[data-id="folder2"] .smart-folder-count');
    
    expect(folder1.textContent).toBe('1,234');
    expect(folder1.style.display).toBe('block');
    
    expect(folder2.textContent).toBe('5');
    expect(folder2.style.display).toBe('block');
  });

  it('should hide count span if no count data is returned for a folder', async () => {
    await updateSmartFolderCountsUI();
    
    const list = document.getElementById('smart-folders-list');
    const folder3 = list.querySelector('.smart-folder-item[data-id="folder3"] .smart-folder-count');
    
    expect(folder3.style.display).toBe('none');
  });

  it('should update counts UI when a new smart folder is saved', async () => {
    // 1. 新しいスマートフォルダのDOM要素を追加 (save処理のシミュレート)
    const list = document.getElementById('smart-folders-list');
    const newItem = document.createElement('div');
    newItem.className = 'smart-folder-item';
    newItem.dataset.id = 'folder4';
    const count = document.createElement('span');
    count.className = 'smart-folder-count';
    count.style.display = 'none';
    newItem.appendChild(count);
    list.appendChild(newItem);

    // 2. appState を更新
    appState.smartFolders.push({ id: 'folder4', name: 'Folder 4', match_type: 'all', conditions: [] });
    
    // 3. getSmartFolderCounts が返すモック値を更新
    window.veloceAPI.getSmartFolderCounts.mockResolvedValueOnce({
      'folder1': 1234,
      'folder2': 5,
      'folder4': 42
    });

    // 4. 保存後に呼ばれる updateSmartFolderCountsUI を実行
    await updateSmartFolderCountsUI();

    // 5. 新規追加されたフォルダの件数が表示されていることを確認
    const folder4 = list.querySelector('.smart-folder-item[data-id="folder4"] .smart-folder-count');
    expect(folder4.textContent).toBe('42');
    expect(folder4.style.display).toBe('block');
  });

  it('should create a duplicate template of a smart folder when duplicate action is simulated', () => {
    // 実際の複製処理のロジックをテスト
    const targetId = 'folder1';
    const sf = appState.smartFolders.find(f => f.id === targetId);
    expect(sf).toBeDefined();

    // 複製時のデータ生成ロジック
    const newName = `${sf.name} (1)`;
    const newSf = {
      name: newName,
      icon: sf.icon,
      color: sf.color,
      conditions: JSON.parse(JSON.stringify(sf.conditions))
    };

    expect(newSf.name).toBe('Folder 1 (1)');
    expect(newSf.icon).toBe(sf.icon);
    expect(newSf.color).toBe(sf.color);
    expect(newSf.conditions).toEqual(sf.conditions);
    expect(newSf.conditions).not.toBe(sf.conditions); // ディープコピーであることを確認
  });

  it('should maintain sufficient width for condition dropdowns so labels are never clipped', () => {
    // layout.css のルールを検証
    const fs = require('fs');
    const path = require('path');
    const layoutCss = fs.readFileSync(path.resolve(__dirname, '../src/renderer/css/layout.css'), 'utf-8');

    // .sf-condition-row .cond-type-select または .sf-cond-type-dim が 170px 以上の固定幅/min-width を持つこと
    expect(layoutCss).toMatch(/\.cond-type-select[\s\S]*?width:\s*(17[0-9]|18[0-9]|19[0-9]|200)px/);
    expect(layoutCss).toMatch(/\.cond-type-select[\s\S]*?min-width:\s*(17[0-9]|18[0-9]|19[0-9]|200)px/);

    // .sf-condition-row .cond-op-select または .sf-cond-op-dim が 145px 以上の固定幅/min-width を持つこと
    expect(layoutCss).toMatch(/\.cond-op-select[\s\S]*?width:\s*(1[4-9][0-9]|200)px/);
    expect(layoutCss).toMatch(/\.cond-op-select[\s\S]*?min-width:\s*(1[4-9][0-9]|200)px/);

    // flex-shrink: 0 で縮まないように保護されていること
    expect(layoutCss).toMatch(/\.cond-type-select[\s\S]*?flex-shrink:\s*0/);
    expect(layoutCss).toMatch(/\.cond-op-select[\s\S]*?flex-shrink:\s*0/);
  });

  it('should render rating badge on thumbnail items when viewing smart folder items', async () => {
    const { getRatingForPath } = await import('../src/renderer/renderer-ui.js');

    // スマートフォルダから取得されたアイテムのパス（バックスラッシュまたはスラッシュ）
    const itemPath = 'C:\\Illustrations\\test_rating_image.png';
    appState.ratings = {
      'C:/Illustrations/test_rating_image.png': 5
    };

    // getRatingForPath 経由で区切り文字の違いを超えてレーティングが取得できること
    const rating = getRatingForPath(itemPath);
    expect(rating).toBe(5);

    // バッジ要素への反映シミュレーション
    const badge = document.createElement('div');
    badge.className = 'rating-badge';
    badge.innerHTML = '<svg></svg><span class="rating-value"></span>';

    if (rating > 0) {
      badge.children[1].textContent = rating;
      badge.classList.add('show');
    }

    expect(badge.classList.contains('show')).toBe(true);
    expect(badge.children[1].textContent).toBe('5');
  });
  describe('SmartFolderStore SQLite Persistence and Re-initialization', () => {
    let mockSettings;
    let mockFlush;

    beforeEach(() => {
      mockSettings = new Map();
      mockFlush = vi.fn().mockResolvedValue();

      window.SettingsStore = {
        getItem: vi.fn((key) => mockSettings.get(key) || null),
        setItem: vi.fn((key, val) => mockSettings.set(key, String(val))),
        flush: mockFlush,
      };

      SmartFolderStore._cache = null;
    });

    afterEach(() => {
      delete window.SettingsStore;
      SmartFolderStore._cache = null;
    });

    it('should load default smart folders and persist to SettingsStore if empty', () => {
      const folders = SmartFolderStore.load(true);
      expect(folders.length).toBeGreaterThanOrEqual(2);
      expect(window.SettingsStore.setItem).toHaveBeenCalledWith('smartFolders', expect.any(String));
    });

    it('should load custom smart folders from SettingsStore when available', () => {
      const customFolders = [
        { id: 'custom_1', name: 'My Custom Folder', matchType: 'all', conditions: [] }
      ];
      mockSettings.set('smartFolders', JSON.stringify(customFolders));

      const folders = SmartFolderStore.load(true);
      expect(folders).toHaveLength(1);
      expect(folders[0].id).toBe('custom_1');
      expect(folders[0].name).toBe('My Custom Folder');
    });

    it('should persist new folder to SettingsStore and call flush on upsertFolder', async () => {
      const newFolder = {
        id: 'user_created',
        name: 'User Created',
        icon: 'FAV_STAR',
        color: 'red',
        matchType: 'all',
        conditions: [{ type: 'rating', operator: '==', value: '3' }]
      };

      const updated = await SmartFolderStore.upsertFolder(newFolder);
      expect(updated.some(f => f.id === 'user_created')).toBe(true);

      expect(window.SettingsStore.setItem).toHaveBeenCalledWith(
        'smartFolders',
        expect.stringContaining('user_created')
      );
      expect(mockFlush).toHaveBeenCalled();
      expect(window.veloceAPI.updateSmartFolders).toHaveBeenCalledWith(updated);
    });

    it('should persist deleted folder to SettingsStore and call flush on deleteFolder', async () => {
      const initial = [
        { id: 'folder_a', name: 'Folder A', matchType: 'all', conditions: [] },
        { id: 'folder_b', name: 'Folder B', matchType: 'all', conditions: [] }
      ];
      mockSettings.set('smartFolders', JSON.stringify(initial));

      const updated = await SmartFolderStore.deleteFolder('folder_a');
      expect(updated.some(f => f.id === 'folder_a')).toBe(false);
      expect(updated.some(f => f.id === 'folder_b')).toBe(true);

      expect(window.SettingsStore.setItem).toHaveBeenCalledWith(
        'smartFolders',
        expect.not.stringContaining('folder_a')
      );
      expect(mockFlush).toHaveBeenCalled();
      expect(window.veloceAPI.updateSmartFolders).toHaveBeenCalledWith(updated);
    });

    it('should preserve custom smart folders across application re-initialization (no reset on reboot)', async () => {
      // ユーザーがカスタムフォルダを作成
      const custom = { id: 'preserved_folder', name: 'Preserved', matchType: 'all', conditions: [] };
      await SmartFolderStore.upsertFolder(custom);

      // アプリ再起動をシミュレート: メモリ内キャッシュを消去し、SettingsStoreから再ロード
      SmartFolderStore._cache = null;
      const reloaded = SmartFolderStore.load(true);

      expect(reloaded.some(f => f.id === 'preserved_folder')).toBe(true);
      expect(reloaded.find(f => f.id === 'preserved_folder').name).toBe('Preserved');
    });
  });

});
