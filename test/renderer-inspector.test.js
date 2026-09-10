/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { uiManager } from '../src/renderer-ui.js';
import {
  getInspectorSection,
  getInspectorTag,
  resetInspectorPools,
  clearMetadataUI,
  renderMultipleSelectionSummary,
  renderMetadata
} from '../src/renderer-inspector.js';

describe('renderer-inspector.js', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="right-pane">
        <div id="inspector-header-path" style="display: none;"></div>
        <div id="inspector-content">
          <div id="inspector-empty" class="show"></div>
        </div>
      </div>
      <div id="static-file-info-table" style="display: block;"></div>
      <div id="file-info-empty" style="display: none;"></div>
      <input type="text" id="search-bar" />
    `;

    uiManager.elements.searchBar = document.getElementById('search-bar');
    resetInspectorPools();

    appState.selection = new Set();
    appState.totalCount = 100;
  });

  afterEach(() => {
    resetInspectorPools();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('DOM Pool', () => {
    it('should reuse inspector sections from pool', () => {
      const sec1 = getInspectorSection();
      const sec2 = getInspectorSection();
      expect(sec1).not.toBe(sec2);

      resetInspectorPools();
      expect(sec1.root.style.display).toBe('none');

      const sec1Reused = getInspectorSection();
      expect(sec1Reused).toBe(sec1);
      expect(sec1Reused.root.style.display).toBe('block');
    });

    it('should reuse inspector tags from pool', () => {
      const tag1 = getInspectorTag();
      const tag2 = getInspectorTag();
      expect(tag1).not.toBe(tag2);

      resetInspectorPools();

      const tag1Reused = getInspectorTag();
      expect(tag1Reused).toBe(tag1);
    });
  });

  describe('clearMetadataUI', () => {
    it('should switch file info table to empty and hide header path', () => {
      const staticTable = document.getElementById('static-file-info-table');
      const emptyMsg = document.getElementById('file-info-empty');
      const headerPath = document.getElementById('inspector-header-path');
      const emptyInspector = document.getElementById('inspector-empty');

      headerPath.style.display = 'block';
      emptyInspector.classList.remove('show');

      clearMetadataUI();

      expect(staticTable.style.display).toBe('none');
      expect(emptyMsg.style.display).toBe('flex');
      expect(headerPath.style.display).toBe('none');
      expect(emptyInspector.classList.contains('show')).toBe(true);
    });
  });

  describe('renderMultipleSelectionSummary', () => {
    it('should render summary with count and shortcuts guide', async () => {
      appState.selection = new Set([1, 2, 3]);
      appState.totalCount = 10;

      await renderMultipleSelectionSummary();

      const headerPath = document.getElementById('inspector-header-path');
      expect(headerPath.style.display).toBe('block');
      expect(headerPath.innerHTML).toContain('3 / 10 件選択中 (30.0%)');

      const container = document.getElementById('inspector-content');
      const text = container.textContent;
      expect(text).toContain('複数選択概要');
      expect(text).toContain('ショートカット操作');
      expect(text).toContain('1 〜 5 : 一括レーティング');
    });
  });

  describe('renderMetadata', () => {
    it('should parse and render metadata sections into inspector-content', async () => {
      window.veloceAPI = {
        parseMetadata: vi.fn().mockResolvedValue({
          prompt: 'masterpiece, 1girl',
          negativePrompt: 'worst quality',
          width: 512,
          height: 768
        })
      };

      const file = { path: 'C:\\test\\image.png', width: 0, height: 0 };
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const headerPath = document.getElementById('inspector-header-path');

      expect(headerPath.style.display).toBe('block');
      expect(headerPath.innerHTML).toContain('C:\\test');

      const text = container.textContent;
      expect(text).toContain('プロンプト');
      expect(text).toContain('masterpiece');
      expect(text).toContain('1girl');

      delete window.veloceAPI;
    });
  });
});
