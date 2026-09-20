/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  getInspectorSection,
  getInspectorTag,
  resetInspectorPools,
  clearMetadataUI,
  renderMultipleSelectionSummary,
  renderMetadata,
  initInspectorDelegation,
  resetInspectorDelegationForTest
} from '../src/renderer/renderer-inspector.js';

describe('renderer-inspector.js', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="right-pane">
        <div id="inspector-header">
          <div id="inspector-header-path" class="open-folder-btn" style="display: none;"></div>
        </div>
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
    resetInspectorDelegationForTest();
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

    it('should render unsupported/raw metadata with prompt-look raw-box class and reset inline styles', async () => {
      window.veloceAPI = {
        parseMetadata: vi.fn().mockResolvedValue({
          unrecognized_format_key: 'debug payload value'
        })
      };

      const file = { path: 'C:\\test\\unknown.png', width: 0, height: 0 };
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const rawBox = container.querySelector('.prompt-look.raw-box');
      expect(rawBox).not.toBeNull();
      expect(rawBox.className).toBe('prompt-look raw-box');
      expect(rawBox.style.fontFamily).toBe('');
      expect(rawBox.style.whiteSpace).toBe('');
      expect(rawBox.style.maxHeight).toBe('');
      expect(rawBox.textContent).toContain('unrecognized_format_key');

      delete window.veloceAPI;
    });

    it('should show copy button only on prompt and negative prompt sections and hide it on other parameter sections', async () => {
      window.veloceAPI = {
        convertFileSrc: vi.fn(p => p),
        parseMetadata: vi.fn().mockResolvedValue({
          source: 'NovelAI',
          prompt: '1girl, smile',
          negativePrompt: 'lowres, bad anatomy',
          width: 512,
          height: 768,
          params: {
            seed: 12345,
            steps: 28,
            sampler: 'k_euler',
            characterPrompts: [
              { prompt: 'girl 1', uc: 'bad', centers: [{ x: 0.5, y: 0.5 }] }
            ]
          }
        })
      };

      const file = { path: 'C:\\test\\chara.png', width: 512, height: 768 };
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const sections = container.querySelectorAll('.inspector-section-block');
      expect(sections.length).toBeGreaterThan(0);

      let verifiedPrompt = false;
      let verifiedParam = false;

      sections.forEach(sec => {
        const titleText = sec.querySelector('.inspector-title-wrapper span')?.textContent || '';
        const copyWrapper = sec.querySelector('.inspector-copy-wrapper');
        const isCopyVisible = copyWrapper && copyWrapper.style.display !== 'none';

        if (
          titleText === 'プロンプト' ||
          titleText === '除外したい要素' ||
          titleText === 'キャラクター 1 プロンプト' ||
          titleText === 'キャラクター 1 除外したい要素'
        ) {
          expect(isCopyVisible, `Copy button should be visible for "${titleText}"`).toBe(true);
          // プロンプト項目は diff-tag で囲われていること
          const tags = sec.querySelectorAll('.diff-tag');
          expect(tags.length, `Prompt section "${titleText}" should have diff-tag`).toBeGreaterThan(0);
          verifiedPrompt = true;
        } else {
          expect(isCopyVisible, `Copy button should be hidden for "${titleText}"`).toBe(false);
          // パラメータ項目（param-box）は diff-tag で囲われず直接テキスト表示されること
          const paramBox = sec.querySelector('.prompt-look.param-box');
          if (paramBox) {
            const innerTag = paramBox.querySelector('.diff-tag');
            expect(innerTag, `Parameter section "${titleText}" should NOT have diff-tag`).toBeNull();
            expect(paramBox.textContent.trim().length).toBeGreaterThan(0);
          }
          verifiedParam = true;
        }
      });

      expect(verifiedPrompt).toBe(true);
      expect(verifiedParam).toBe(true);

      delete window.veloceAPI;
    });
  });

  describe('initInspectorDelegation & Header Path Context Menu', () => {
    it('should trigger contextMenuManager.show when right-clicking header path after renderMetadata', async () => {
      resetInspectorDelegationForTest();
      const mockCmm = { show: vi.fn() };
      window.contextMenuManager = mockCmm;

      window.veloceAPI = {
        parseMetadata: vi.fn().mockResolvedValue({})
      };

      const file = { path: 'D:\\Photos\\Landscape\\mountain.png', width: 100, height: 100 };
      await renderMetadata(file);

      const headerPath = document.getElementById('inspector-header-path');
      expect(headerPath.getAttribute('data-path')).toBe('D:\\Photos\\Landscape\\mountain.png');

      const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 });
      headerPath.dispatchEvent(event);

      expect(mockCmm.show).toHaveBeenCalledWith(
        'inspector-header',
        { targetFolder: { path: 'D:\\Photos\\Landscape', name: 'Landscape' }, isRoot: false },
        200,
        300
      );

      delete window.contextMenuManager;
      delete window.veloceAPI;
    });
  });
});
