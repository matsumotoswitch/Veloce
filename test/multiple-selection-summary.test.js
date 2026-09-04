import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { uiManager } from '../src/renderer-ui.js';

describe('renderMultipleSelectionSummary (PLAN.md Sec 3.2)', () => {
  let inspectorContent;
  let headerPath;
  let staticTable;
  let emptyInfoMsg;
  let renderMultipleSelectionSummary;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
      <div id="inspector-header-path" style="display: none;"></div>
      <div id="inspector-content">
        <div id="inspector-empty" class="show"></div>
      </div>
      <div id="static-file-info-table" style="display: block;"></div>
      <div id="file-info-empty" style="display: none;"></div>
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    const rendererModule = await import('../src/renderer.js');
    renderMultipleSelectionSummary = rendererModule.renderMultipleSelectionSummary;
  });

  beforeEach(() => {
    inspectorContent = document.getElementById('inspector-content');
    headerPath = document.getElementById('inspector-header-path');
    staticTable = document.getElementById('static-file-info-table');
    emptyInfoMsg = document.getElementById('file-info-empty');

    staticTable.style.display = 'block';
    emptyInfoMsg.style.display = 'none';
    headerPath.style.display = 'none';
    headerPath.innerHTML = '';
    inspectorContent.innerHTML = '<div id="inspector-empty" class="show"></div>';

    appState.selection = new Set();
    appState.totalCount = 100;
  });

  it('should switch static table to empty message and reset inspector state', async () => {
    appState.selection = new Set([0, 1, 2]);
    appState.totalCount = 10;

    await renderMultipleSelectionSummary();

    expect(staticTable.style.display).toBe('none');
    expect(emptyInfoMsg.style.display).toBe('flex');
    expect(document.getElementById('inspector-empty').classList.contains('show')).toBe(false);
  });

  it('should render correct selection count and percentage in headerPath', async () => {
    appState.selection = new Set([5, 10, 15, 20]);
    appState.totalCount = 20;

    await renderMultipleSelectionSummary();

    expect(headerPath.style.display).toBe('block');
    expect(headerPath.innerHTML).toContain('4 / 20 件選択中 (20.0%)');
  });

  it('should build summary section and shortcut guide section in inspector container', async () => {
    appState.selection = new Set([1, 2]);
    appState.totalCount = 10;

    await renderMultipleSelectionSummary();

    const sections = inspectorContent.querySelectorAll('.inspector-section');
    expect(sections.length).toBeGreaterThanOrEqual(2);

    const sectionTitles = Array.from(sections).map(s => s.querySelector('h3 span')?.textContent);
    expect(sectionTitles).toContain('複数選択概要');
    expect(sectionTitles).toContain('ショートカット操作');

    // ショートカット一覧の検証
    const textContent = inspectorContent.textContent;
    expect(textContent).toContain('1 〜 5 : 一括レーティング');
    expect(textContent).toContain('Delete : 一括ゴミ箱移動');
    expect(textContent).toContain('Ctrl + C : パスコピー');
    expect(textContent).toContain('Ctrl + A : すべて選択');
  });
});
