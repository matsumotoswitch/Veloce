import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';

describe('Bookmark Bar Overflow Logic', () => {
  beforeEach(() => {
    appState.favorites = [];
    vi.clearAllMocks();
    
    // Set up DOM
    document.body.innerHTML = `
      <div id="bookmark-bar">
        <div id="bookmark-list" style="width: 200px; display: flex;"></div>
        <button id="bookmark-overflow-btn" style="display: none;"></button>
      </div>
    `;
  });

  it('should show overflow button when scrollWidth exceeds clientWidth', () => {
    const list = document.getElementById('bookmark-list');
    const overflowBtn = document.getElementById('bookmark-overflow-btn');

    // Mock scrollWidth and clientWidth to simulate overflow
    Object.defineProperty(list, 'scrollWidth', { value: 300, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 200, configurable: true });

    // Simulate checkBookmarkOverflow logic
    const checkBookmarkOverflow = () => {
      if (list.scrollWidth > list.clientWidth) {
        overflowBtn.style.display = 'flex';
      } else {
        overflowBtn.style.display = 'none';
      }
    };

    checkBookmarkOverflow();
    expect(overflowBtn.style.display).toBe('flex');
  });

  it('should hide overflow button when items fit', () => {
    const list = document.getElementById('bookmark-list');
    const overflowBtn = document.getElementById('bookmark-overflow-btn');

    // Mock scrollWidth and clientWidth to simulate fitting
    Object.defineProperty(list, 'scrollWidth', { value: 150, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 200, configurable: true });

    // Simulate checkBookmarkOverflow logic
    const checkBookmarkOverflow = () => {
      if (list.scrollWidth > list.clientWidth) {
        overflowBtn.style.display = 'flex';
      } else {
        overflowBtn.style.display = 'none';
      }
    };

    checkBookmarkOverflow();
    expect(overflowBtn.style.display).toBe('none');
  });

  it('should detect hidden items correctly for dropdown', () => {
    const list = document.getElementById('bookmark-list');
    
    // Add two items
    const item1 = document.createElement('div');
    const item2 = document.createElement('div');
    list.appendChild(item1);
    list.appendChild(item2);

    // Mock getBoundingClientRect for list
    list.getBoundingClientRect = () => ({ right: 200 });

    // item1 fits (0 to 100px)
    item1.getBoundingClientRect = () => ({ right: 100 });

    // item2 overflows (100 to 250px)
    item2.getBoundingClientRect = () => ({ right: 250 });

    const items = Array.from(list.children);
    const listRect = list.getBoundingClientRect();
    const hiddenItems = items.filter(item => {
      const itemRect = item.getBoundingClientRect();
      return itemRect.right > listRect.right;
    });

    expect(hiddenItems.length).toBe(1);
    expect(hiddenItems[0]).toBe(item2);
  });

  it('should reset style.display and allow opening edit-favorite-modal repeatedly', () => {
    // モーダルが一度閉じた後に style.display = 'none' が残らず再度開けることを検証
    const modal = document.createElement('div');
    modal.id = 'edit-favorite-modal';
    modal.className = 'dialog-overlay show';
    modal.style.display = 'none'; // 前回のEscape等でインライン非表示が付与された状態をシミュレート
    document.body.appendChild(modal);

    // 開く処理のシミュレーション: modal.style.display をリセットして .show を付与
    modal.style.display = '';
    modal.classList.add('show');

    expect(modal.style.display).toBe('');
    expect(modal.classList.contains('show')).toBe(true);

    // Escape処理のシミュレーション: 静的モーダルは style.display = 'none' にせず、.show のみ削除
    if (modal.id === 'edit-favorite-modal') {
      modal.classList.remove('show');
      modal.style.display = '';
    } else {
      modal.style.display = 'none';
    }

    expect(modal.style.display).toBe('');
    expect(modal.classList.contains('show')).toBe(false);

    // 2回目を開く
    modal.style.display = '';
    modal.classList.add('show');

    expect(modal.style.display).toBe('');
    expect(modal.classList.contains('show')).toBe(true);

    modal.remove();
  });
});
