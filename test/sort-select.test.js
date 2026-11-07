import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// updateSortSelectDropdown と setupSortSelect のロジックを分離テスト
describe('Sort Select Dropdown', () => {
  let dom;

  const SORT_ITEMS = [
    { key: 'name', asc: true,  label: '名前 (昇順)' },
    { key: 'name', asc: false, label: '名前 (降順)' },
    { key: 'ext', asc: true,  label: '拡張子 (昇順)' },
    { key: 'ext', asc: false, label: '拡張子 (降順)' },
    { key: 'width', asc: false, label: '幅 (大きい順)' },
    { key: 'width', asc: true,  label: '幅 (小さい順)' },
    { key: 'height', asc: false, label: '高さ (大きい順)' },
    { key: 'height', asc: true,  label: '高さ (小さい順)' },
    { key: 'ratio', asc: false, label: '比率 (大きい順)' },
    { key: 'ratio', asc: true,  label: '比率 (小さい順)' },
    { key: 'size',  asc: false, label: 'サイズ (大きい順)' },
    { key: 'size',  asc: true,  label: 'サイズ (小さい順)' },
    { key: 'mtime', asc: false, label: '更新日時 (新しい順)' },
    { key: 'mtime', asc: true,  label: '更新日時 (古い順)' },
    { key: 'rating', asc: false, label: 'レーティング (高い順)' },
    { key: 'rating', asc: true,  label: 'レーティング (低い順)' },
  ];

  function buildHTML() {
    const items = SORT_ITEMS.map(s =>
      `<div class="custom-select-item${s.key === 'name' && s.asc ? ' selected' : ''}" data-sort-key="${s.key}" data-sort-asc="${s.asc}">${s.label}</div>`
    ).join('');
    return `<!DOCTYPE html><html><body>
      <div class="custom-select open-up" id="sort-select-container" tabindex="0">
        <div class="custom-select-label" id="sort-select-label">名前 (昇順)</div>
        <div class="custom-select-menu" id="sort-select-menu">${items}</div>
      </div>
    </body></html>`;
  }

  let appState;
  let scheduleRefresh;

  function updateSortSelectDropdown() {
    const container = document.getElementById('sort-select-container');
    const label = document.getElementById('sort-select-label');
    if (!container || !label) return;

    const { key, asc } = appState.sortConfig;
    const items = container.querySelectorAll('.custom-select-item');
    let matched = null;
    items.forEach(item => {
      const itemKey = item.dataset.sortKey;
      const itemAsc = item.dataset.sortAsc === 'true';
      const isMatch = itemKey === key && itemAsc === asc;
      item.classList.toggle('selected', isMatch);
      if (isMatch) matched = item;
    });
    if (matched) {
      label.textContent = matched.textContent;
    }
  }

  function setupSortSelect() {
    const container = document.getElementById('sort-select-container');
    if (!container) return;
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      container.classList.toggle('open');
    });
    container.querySelectorAll('.custom-select-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = item.dataset.sortKey;
        const asc = item.dataset.sortAsc === 'true';
        appState.sortConfig.key = key;
        appState.sortConfig.asc = asc;
        updateSortSelectDropdown();
        scheduleRefresh();
        container.classList.remove('open');
      });
    });
    updateSortSelectDropdown();
  }

  function setupCustomSelectKeyboard(doc) {
    doc.addEventListener('keydown', (e) => {
      const customSelect = e.target && e.target.closest ? e.target.closest('.custom-select') : null;
      if (!customSelect) return;

      const isOpen = customSelect.classList.contains('open');

      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) {
          customSelect.click();
        } else {
          const highlighted = customSelect.querySelector('.custom-select-item.keyboard-focused') ||
                              customSelect.querySelector('.custom-select-item.selected');
          if (highlighted) {
            highlighted.click();
          } else {
            customSelect.click();
          }
        }
      } else if (e.key === 'ArrowDown' || e.key === 'Down') {
        e.preventDefault();
        e.stopPropagation();
        const items = Array.from(customSelect.querySelectorAll('.custom-select-item'));
        if (items.length === 0) return;

        if (!isOpen) {
          customSelect.click();
        }
        let currentIdx = items.findIndex(i => i.classList.contains('keyboard-focused') || (!customSelect.querySelector('.custom-select-item.keyboard-focused') && i.classList.contains('selected')));
        let nextIdx = currentIdx + 1;
        if (nextIdx >= items.length) nextIdx = 0;

        items.forEach(i => i.classList.remove('keyboard-focused'));
        items[nextIdx].classList.add('keyboard-focused');
      } else if (e.key === 'ArrowUp' || e.key === 'Up') {
        e.preventDefault();
        e.stopPropagation();
        const items = Array.from(customSelect.querySelectorAll('.custom-select-item'));
        if (items.length === 0) return;

        if (!isOpen) {
          customSelect.click();
        }
        let currentIdx = items.findIndex(i => i.classList.contains('keyboard-focused') || (!customSelect.querySelector('.custom-select-item.keyboard-focused') && i.classList.contains('selected')));
        let prevIdx = currentIdx - 1;
        if (prevIdx < 0) prevIdx = items.length - 1;

        items.forEach(i => i.classList.remove('keyboard-focused'));
        items[prevIdx].classList.add('keyboard-focused');
      } else if (e.key === 'Escape' || e.key === 'Esc') {
        if (isOpen) {
          e.preventDefault();
          e.stopPropagation();
          customSelect.classList.remove('open', 'open-up');
          customSelect.querySelectorAll('.custom-select-item').forEach(i => i.classList.remove('keyboard-focused'));
        }
      }
    });
  }

  beforeEach(() => {
    dom = new JSDOM(buildHTML(), { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    appState = { sortConfig: { key: 'name', asc: true } };
    scheduleRefresh = vi.fn();
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it('初期表示が現在のソートに合った項目を selected にする', () => {
    setupSortSelect();
    const items = document.querySelectorAll('.custom-select-item');
    const selected = Array.from(items).filter(i => i.classList.contains('selected'));
    expect(selected.length).toBe(1);
    expect(selected[0].dataset.sortKey).toBe('name');
    expect(selected[0].dataset.sortAsc).toBe('true');
  });

  it('初期ラベルが「名前 (昇順)」になる', () => {
    setupSortSelect();
    expect(document.getElementById('sort-select-label').textContent).toBe('名前 (昇順)');
  });

  it('更新日時 (新しい順) をクリックすると appState.sortConfig が更新される', () => {
    setupSortSelect();
    const mtimeItem = Array.from(document.querySelectorAll('.custom-select-item'))
      .find(i => i.dataset.sortKey === 'mtime' && i.dataset.sortAsc === 'false');
    mtimeItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(appState.sortConfig.key).toBe('mtime');
    expect(appState.sortConfig.asc).toBe(false);
    expect(scheduleRefresh).toHaveBeenCalledOnce();
  });

  it('項目クリック後、ラベルが選んだ項目のテキストに変わる', () => {
    setupSortSelect();
    const sizeItem = Array.from(document.querySelectorAll('.custom-select-item'))
      .find(i => i.dataset.sortKey === 'size' && i.dataset.sortAsc === 'false');
    sizeItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('sort-select-label').textContent).toBe('サイズ (大きい順)');
  });

  it('項目クリック後にドロップダウンが閉じる', () => {
    setupSortSelect();
    const container = document.getElementById('sort-select-container');
    container.classList.add('open');
    const item = document.querySelector('.custom-select-item');
    item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(container.classList.contains('open')).toBe(false);
  });

  it('updateSortSelectDropdown は外部からソートが変わったときも同期する', () => {
    setupSortSelect();
    appState.sortConfig = { key: 'rating', asc: false };
    updateSortSelectDropdown();
    const selected = Array.from(document.querySelectorAll('.custom-select-item'))
      .filter(i => i.classList.contains('selected'));
    expect(selected.length).toBe(1);
    expect(selected[0].dataset.sortKey).toBe('rating');
    expect(selected[0].dataset.sortAsc).toBe('false');
    expect(document.getElementById('sort-select-label').textContent).toBe('レーティング (高い順)');
  });

  describe('Keyboard Accessibility for custom-select (Phase 2)', () => {
    it('EnterキーまたはSpaceキーでドロップダウンが開閉する', () => {
      setupSortSelect();
      setupCustomSelectKeyboard(document);
      const container = document.getElementById('sort-select-container');
      expect(container.classList.contains('open')).toBe(false);

      // Enterで開く
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(container.classList.contains('open')).toBe(true);

      // もう一度Enterで閉じる（項目選択）
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(container.classList.contains('open')).toBe(false);

      // Spaceで開く
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(container.classList.contains('open')).toBe(true);
    });

    it('ArrowDownとArrowUpで項目を移動し、Enterキーで確定選択できる', () => {
      setupSortSelect();
      setupCustomSelectKeyboard(document);
      const container = document.getElementById('sort-select-container');

      // 閉じた状態でArrowDownを押すと開き、次の項目（名前 降順）にフォーカスが当たる
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(container.classList.contains('open')).toBe(true);

      const items = Array.from(container.querySelectorAll('.custom-select-item'));
      const highlighted1 = container.querySelector('.custom-select-item.keyboard-focused');
      expect(highlighted1).toBe(items[1]); // 名前 (降順)

      // 再度ArrowDownで items[2]（拡張子 昇順）へ移動
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const highlighted2 = container.querySelector('.custom-select-item.keyboard-focused');
      expect(highlighted2).toBe(items[2]); // 拡張子 (昇順)

      // Enterで確定
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(container.classList.contains('open')).toBe(false);
      expect(appState.sortConfig.key).toBe('ext');
      expect(appState.sortConfig.asc).toBe(true);
      expect(document.getElementById('sort-select-label').textContent).toBe('拡張子 (昇順)');
    });

    it('Escapeキーで選択を変更せずにドロップダウンが閉じる', () => {
      setupSortSelect();
      setupCustomSelectKeyboard(document);
      const container = document.getElementById('sort-select-container');

      // 開く
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(container.classList.contains('open')).toBe(true);

      // Escapeで閉じる
      container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(container.classList.contains('open')).toBe(false);
      expect(appState.sortConfig.key).toBe('name'); // 変更なし
    });
  });
});
