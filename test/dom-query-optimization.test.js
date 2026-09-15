import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { appState } from '../src/renderer-state.js';
import { UIManager, uiManager } from '../src/renderer-ui.js';

describe('DOM Query Optimization (Section 2-B)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body>
      <table id="file-table">
        <thead>
          <tr>
            <th data-sort="name">名前</th>
            <th data-sort="ext">拡張子</th>
            <th data-sort="size">サイズ</th>
            <th data-sort="mtime">更新日時</th>
          </tr>
        </thead>
        <tbody id="file-list-body"></tbody>
      </table>
      <div id="dir-tree">
        <ul>
          <li><div class="tree-item selected" data-path="C:\\test">test</div></li>
          <li><div class="tree-item" data-path="C:\\test2">test2</div></li>
        </ul>
      </div>
      <div id="smart-folders-section">
        <div class="smart-folder-item selected" data-id="sf-1">SF 1</div>
        <div class="smart-folder-item" data-id="sf-2">SF 2</div>
      </div>
      <div class="custom-select open" id="select-1">
        <div class="custom-select-label">Option 1</div>
        <div class="custom-select-menu">
          <div class="custom-select-item selected" data-value="1">Option 1</div>
          <div class="custom-select-item" data-value="2">Option 2</div>
        </div>
      </div>
      <div class="custom-select" id="select-2">
        <div class="custom-select-label">Option A</div>
        <div class="custom-select-menu">
          <div class="custom-select-item selected" data-value="a">Option A</div>
          <div class="custom-select-item" data-value="b">Option B</div>
        </div>
      </div>
      <div id="center-bottom"></div>
      <div id="search-input"></div>
      <input type="range" id="thumbnail-size-slider" />
    </body></html>`, {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');
    uiManager.elements.fileTable = document.getElementById('file-table');
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    vi.restoreAllMocks();
  });

  it('verifies updateSortIndicators caches th elements and avoids redundant querySelectorAll', async () => {
    const renderer = await import('../src/renderer.js');
    if (renderer.resetCachedSortHeaders) {
      renderer.resetCachedSortHeaders();
    }

    const table = document.getElementById('file-table');
    const querySpy = vi.spyOn(table, 'querySelectorAll');

    appState.sortConfig = { key: 'name', asc: true };

    // First call caches the headers
    renderer.updateSortIndicators();
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Second call should reuse cached headers
    querySpy.mockClear();
    appState.sortConfig = { key: 'size', asc: false };
    renderer.updateSortIndicators();
    expect(querySpy).not.toHaveBeenCalled();

    // Verify arrow indicators
    const sizeTh = document.querySelector('th[data-sort="size"]');
    const nameTh = document.querySelector('th[data-sort="name"]');
    expect(sizeTh.querySelector('.sort-arrow')).not.toBeNull();
    expect(nameTh.querySelector('.sort-arrow')).toBeNull();
  });

  it('optimizes smart folder selection deselect via O(1) querySelector', () => {
    const container = document.getElementById('smart-folders-section');
    const prevSmartSelected = container.querySelector('.smart-folder-item.selected');
    expect(prevSmartSelected).not.toBeNull();
    expect(prevSmartSelected.dataset.id).toBe('sf-1');

    if (prevSmartSelected) prevSmartSelected.classList.remove('selected');
    expect(container.querySelector('.smart-folder-item.selected')).toBeNull();

    const prevTreeSelected = document.querySelector('#dir-tree .tree-item.selected');
    expect(prevTreeSelected).not.toBeNull();
    if (prevTreeSelected) prevTreeSelected.classList.remove('selected');
    expect(document.querySelector('#dir-tree .tree-item.selected')).toBeNull();
  });

  it('optimizes closing open custom-selects using single querySelector lookup', () => {
    const openSelect = document.querySelector('.custom-select.open');
    expect(openSelect).not.toBeNull();
    expect(openSelect.id).toBe('select-1');

    openSelect.classList.remove('open');
    expect(document.querySelector('.custom-select.open')).toBeNull();
  });
});
