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
});
