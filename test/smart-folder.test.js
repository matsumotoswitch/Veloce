import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';

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
});
