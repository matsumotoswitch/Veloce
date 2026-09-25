import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseCharacterCenters,
  extractMetadataFields,
  buildInspectorSections
} from '../src/common/metadata-format.js';
import { renderMetadata, resetInspectorPools } from '../src/renderer/renderer-inspector.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Character Positioning (NovelAI v4 / v5)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="inspector-header">
        <div id="inspector-header-path"></div>
      </div>
      <div id="inspector-content"></div>
    `;
    appState.thumbnailUrls = new Map([['test_file.png', 'blob:http://localhost/thumb1']]);
    window.appState = appState;
    window.veloceAPI = {
      convertFileSrc: vi.fn(path => `asset://${path}`)
    };
    window.uiManager = {
      elements: {},
      createCopyButtonHTML: vi.fn((val) => `<span class="diff-copy-btn" data-copy-text="${val}">copy</span>`)
    };
    resetInspectorPools();
  });

  describe('parseCharacterCenters', () => {
    it('should extract coordinates from centers array', () => {
      const cp = {
        prompt: '1girl, red hair',
        centers: [{ x: 0.3, y: 0.4 }]
      };
      const result = parseCharacterCenters(cp);
      expect(result).toEqual([{ x: 0.3, y: 0.4 }]);
    });

    it('should extract coordinates from single center object', () => {
      const cp = {
        prompt: '1boy',
        center: { x: 0.7, y: 0.5 }
      };
      const result = parseCharacterCenters(cp);
      expect(result).toEqual([{ x: 0.7, y: 0.5 }]);
    });

    it('should extract coordinates from array format [x, y]', () => {
      const cp = {
        prompt: 'cat',
        centers: [[0.2, 0.8]]
      };
      const result = parseCharacterCenters(cp);
      expect(result).toEqual([{ x: 0.2, y: 0.8 }]);
    });

    it('should return empty array for missing or invalid center values', () => {
      expect(parseCharacterCenters(null)).toEqual([]);
      expect(parseCharacterCenters({})).toEqual([]);
      expect(parseCharacterCenters({ centers: 'invalid' })).toEqual([]);
      expect(parseCharacterCenters({ centers: [{ x: 'nan', y: 0.5 }] })).toEqual([]);
    });
  });

  describe('extractMetadataFields with character positions', () => {
    it('should extract charPositions and image dimensions', () => {
      const file = { name: 'nai_v5.png', path: 'C:\\test\\nai_v5.png' };
      const meta = {
        source: 'NovelAI Diffusion V4.5 Curated',
        prompt: 'masterpiece, 2girls',
        negativePrompt: 'worst quality',
        params: {
          width: 1216,
          height: 832,
          seed: 11223344,
          steps: 28,
          sampler: 'k_euler',
          characterPrompts: [
            { prompt: 'girl 1, pink hair', uc: 'bad eyes', centers: [{ x: 0.25, y: 0.5 }] },
            { prompt: 'girl 2, blue hair', uc: 'bad hands', centers: [{ x: 0.75, y: 0.5 }] }
          ]
        }
      };

      const data = extractMetadataFields(file, meta);
      expect(data.width).toBe(1216);
      expect(data.height).toBe(832);
      expect(data.charPositions.length).toBe(2);
      expect(data.charPositions[0]).toEqual({
        index: 1,
        centers: [{ x: 0.25, y: 0.5 }]
      });
      expect(data.charPositions[1]).toEqual({
        index: 2,
        centers: [{ x: 0.75, y: 0.5 }]
      });
    });

    it('should leave charPositions empty when no character has centers', () => {
      const file = { name: 'plain.png', path: 'C:\\test\\plain.png' };
      const meta = {
        prompt: '1girl',
        params: {
          characterPrompts: [
            { prompt: 'girl 1', uc: '' }
          ]
        }
      };

      const data = extractMetadataFields(file, meta);
      expect(data.charPositions).toEqual([]);
    });
  });

  describe('buildInspectorSections', () => {
    it('should place position section at the bottom under parameters', () => {
      const data = {
        source: 'NovelAI',
        prompt: 'test prompt',
        negativePrompt: 'test neg',
        chars: [
          { prompt: 'c1', uc: 'u1', centers: [{ x: 0.3, y: 0.4 }] }
        ],
        params: {
          resolution: '1216x832',
          seed: 1234,
          steps: '28',
          sampler: 'k_euler',
          scale: 5,
          cfg_rescale: 0,
          uncond_scale: 1,
          rawParameters: 'raw data'
        },
        width: 1216,
        height: 832,
        charPositions: [
          { index: 1, centers: [{ x: 0.3, y: 0.4 }] }
        ]
      };

      const sections = buildInspectorSections(data);
      const lastSection = sections[sections.length - 1];

      expect(lastSection.title).toBe('位置');
      expect(lastSection.isPosition).toBe(true);
      expect(lastSection.width).toBe(1216);
      expect(lastSection.height).toBe(832);
      expect(lastSection.charPositions.length).toBe(1);
      expect(lastSection.positionMode).toBe('カスタム');

      // Verify that parameters precede the position section
      const rawParamIndex = sections.findIndex(s => s.title === '生成パラメータ (Raw)');
      const positionIndex = sections.findIndex(s => s.title === '位置');
      expect(positionIndex).toBeGreaterThan(rawParamIndex);
    });

    it('should set positionMode to "AIにおまかせ" when useCoords is false', () => {
      const data = {
        source: 'NovelAI',
        prompt: 'test prompt',
        negativePrompt: 'test neg',
        chars: [],
        params: {},
        useCoords: false,
        charPositions: [{ index: 1, centers: [{ x: 0.5, y: 0.5 }] }]
      };

      const sections = buildInspectorSections(data);
      const posSec = sections.find(s => s.title === '位置');
      expect(posSec).toBeDefined();
      expect(posSec.positionMode).toBe('AIにおまかせ');
      expect(posSec.useCoords).toBe(false);
    });

    it('should set positionMode to "カスタム" when useCoords is true or undefined', () => {
      const dataTrue = {
        source: 'NovelAI',
        prompt: 'test prompt',
        negativePrompt: 'test neg',
        chars: [],
        params: {},
        useCoords: true,
        charPositions: [{ index: 1, centers: [{ x: 0.5, y: 0.5 }] }]
      };
      const sectionsTrue = buildInspectorSections(dataTrue);
      expect(sectionsTrue.find(s => s.title === '位置').positionMode).toBe('カスタム');

      const dataUndefined = {
        source: 'NovelAI',
        prompt: 'test prompt',
        negativePrompt: 'test neg',
        chars: [],
        params: {},
        charPositions: [{ index: 1, centers: [{ x: 0.5, y: 0.5 }] }]
      };
      const sectionsUndefined = buildInspectorSections(dataUndefined);
      expect(sectionsUndefined.find(s => s.title === '位置').positionMode).toBe('カスタム');
    });

    it('should not add position section when charPositions is empty', () => {
      const data = {
        source: 'NovelAI',
        prompt: 'test prompt',
        negativePrompt: 'test neg',
        chars: [],
        params: {},
        charPositions: []
      };

      const sections = buildInspectorSections(data);
      expect(sections.some(s => s.title === '位置')).toBe(false);
    });
  });

  describe('renderMetadata with character positions', () => {
    it('should render position map, markers, and coordinate data in inspector container', async () => {
      const file = { name: 'test_file.png', path: 'test_file.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '2girls, talking',
        negativePrompt: 'worst quality',
        params: {
          width: 1024,
          height: 700,
          seed: 9999,
          characterPrompts: [
            { prompt: 'girl left', uc: '', centers: [{ x: 0.2, y: 0.4 }] },
            { prompt: 'girl right', uc: '', centers: [{ x: 0.8, y: 0.4 }] }
          ]
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);

      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      expect(container).not.toBeNull();

      // Find the position block
      const positionBlock = container.querySelector('.inspector-position-block');
      expect(positionBlock).not.toBeNull();

      // Verify map wrapper and map aspect-ratio
      const map = positionBlock.querySelector('.inspector-position-map');
      expect(map).not.toBeNull();
      expect(map.style.aspectRatio).toBe('1024 / 700');

      // Verify background preview image
      const bgImg = map.querySelector('.inspector-position-bg-img');
      expect(bgImg).not.toBeNull();
      expect(bgImg.src).toContain('thumb1');

      // Verify markers
      const markers = map.querySelectorAll('.inspector-position-marker');
      expect(markers.length).toBe(2);

      expect(markers[0].textContent).toBe('1');
      expect(markers[0].style.left).toBe('20.00%');
      expect(markers[0].style.top).toBe('40.00%');
      expect(markers[0].classList.contains('char-marker-1')).toBe(true);

      expect(markers[1].textContent).toBe('2');
      expect(markers[1].style.left).toBe('80.00%');
      expect(markers[1].style.top).toBe('40.00%');
      expect(markers[1].classList.contains('char-marker-2')).toBe(true);

      // Verify coordinate list items
      const coordItems = positionBlock.querySelectorAll('.inspector-coord-item');
      expect(coordItems.length).toBe(2);

      expect(coordItems[0].querySelector('.inspector-coord-badge').textContent).toBe('1');
      expect(coordItems[0].querySelector('.inspector-coord-text').textContent).toContain('X: 20.0%');
      expect(coordItems[0].querySelector('.inspector-coord-text').textContent).toContain('Y: 40.0%');

      expect(coordItems[1].querySelector('.inspector-coord-badge').textContent).toBe('2');
      expect(coordItems[1].querySelector('.inspector-coord-text').textContent).toContain('X: 80.0%');
      expect(coordItems[1].querySelector('.inspector-coord-text').textContent).toContain('Y: 40.0%');
    });

    it('should correctly pass dimensions from metadata and apply aspect-ratio without truncation', async () => {
      const file = { name: 'portrait.png', path: 'portrait.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '1girl',
        negativePrompt: 'worst quality',
        params: {
          width: 832,
          height: 1216,
          characterPrompts: [
            { prompt: 'girl', uc: '', centers: [{ x: 0.5, y: 0.8 }] }
          ]
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const map = container.querySelector('.inspector-position-map');
      expect(map.style.aspectRatio).toBe('832 / 1216');

      const marker = map.querySelector('.inspector-position-marker');
      expect(marker.style.top).toBe('80.00%');
    });

    it('should render metadata without position section and have proper container bottom padding and spacer', async () => {
      const file = { name: 'no_position.png', path: 'no_position.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '1girl, smiling',
        negativePrompt: 'low quality',
        params: {
          cfg_rescale: 0.4,
          scale: 6.0
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      expect(container.querySelector('.inspector-position-block')).toBeNull();

      // Ensure inspector-bottom-spacer is appended at the bottom
      const spacer = container.querySelector('#inspector-bottom-spacer');
      expect(spacer).not.toBeNull();
      expect(spacer.style.display).toBe('block');
      expect(container.lastElementChild).toBe(spacer);

      // Ensure CSS rules for .inspector-bottom-spacer
      const fs = await import('fs');
      const cssContent = fs.readFileSync('src/renderer/css/inspector.css', 'utf-8');
      expect(cssContent).toContain('.inspector-bottom-spacer {');
      expect(cssContent).toContain('height: 20px;');
    });

    it('should also render inspector-bottom-spacer for images with character position', async () => {
      const file = { name: 'with_pos.png', path: 'with_pos.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '1girl',
        negativePrompt: 'low quality',
        params: {
          characterPrompts: [
            { prompt: 'girl', uc: '', centers: [{ x: 0.5, y: 0.5 }] }
          ]
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      expect(container.querySelector('.inspector-position-block')).not.toBeNull();

      const spacer = container.querySelector('#inspector-bottom-spacer');
      expect(spacer).not.toBeNull();
      expect(spacer.style.display).toBe('block');
      expect(container.lastElementChild).toBe(spacer);
    });

    it('should display "AIにおまかせ" mode text between title and map when use_coords is false', async () => {
      const file = { name: 'auto_pos.png', path: 'auto_pos.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '2girls',
        negativePrompt: 'low quality',
        params: {
          use_coords: false,
          characterPrompts: [
            { prompt: 'girl 1', uc: '', centers: [{ x: 0.3, y: 0.5 }] },
            { prompt: 'girl 2', uc: '', centers: [{ x: 0.7, y: 0.5 }] }
          ]
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const positionBlock = container.querySelector('.inspector-position-block');
      expect(positionBlock).not.toBeNull();

      // Check that positionBlock itself is a single prompt-look container
      expect(positionBlock.classList.contains('prompt-look')).toBe(true);

      // Check mode element within the single container
      const modeRow = positionBlock.querySelector('.inspector-position-mode-row');
      expect(modeRow).not.toBeNull();
      expect(modeRow.querySelector('.diff-tag')).toBeNull();

      const modeTag = modeRow.querySelector('.inspector-position-mode-text');
      expect(modeTag).not.toBeNull();
      expect(modeTag.textContent).toBe('AIにおまかせ');
      expect(modeTag.classList.contains('inspector-position-mode--auto')).toBe(true);

      // 「AIにおまかせ」の場合はその旨のみ表示し、画像マップや座標情報は表示しない
      expect(positionBlock.firstElementChild).toBe(modeRow);
      expect(positionBlock.querySelector('.inspector-position-map-wrapper')).toBeNull();
      expect(positionBlock.querySelector('.inspector-position-coords')).toBeNull();
    });

    it('should display "カスタム" mode text and render map and coords when use_coords is true', async () => {
      const file = { name: 'custom_pos.png', path: 'custom_pos.png' };
      const meta = {
        source: 'NovelAI',
        prompt: '2girls',
        negativePrompt: 'low quality',
        params: {
          use_coords: true,
          characterPrompts: [
            { prompt: 'girl 1', uc: '', centers: [{ x: 0.3, y: 0.5 }] },
            { prompt: 'girl 2', uc: '', centers: [{ x: 0.7, y: 0.5 }] }
          ]
        }
      };

      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);
      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const positionBlock = container.querySelector('.inspector-position-block');
      expect(positionBlock).not.toBeNull();
      expect(positionBlock.classList.contains('prompt-look')).toBe(true);

      const modeRow = positionBlock.querySelector('.inspector-position-mode-row');
      expect(modeRow).not.toBeNull();
      expect(modeRow.querySelector('.diff-tag')).toBeNull();

      const modeTag = modeRow.querySelector('.inspector-position-mode-text');
      expect(modeTag).not.toBeNull();
      expect(modeTag.textContent).toBe('カスタム');
      expect(modeTag.classList.contains('inspector-position-mode--custom')).toBe(true);
      expect(positionBlock.firstElementChild).toBe(modeRow);
      // カスタムの場合は画像マップと座標が表示されること
      expect(positionBlock.querySelector('.inspector-position-map-wrapper')).not.toBeNull();
      expect(positionBlock.querySelector('.inspector-position-coords')).not.toBeNull();
    });
  });

  describe('showDiffModal with character positions', () => {
    let uiManager;

    beforeEach(async () => {
      const { UIManager } = await import('../src/renderer/renderer-ui.js');
      uiManager = new UIManager(appState);
      document.body.innerHTML = `
        <div id="diff-modal" class="modal-backdrop">
          <div id="diff-container"></div>
        </div>
      `;
    });

    it('should render position diff sections when both files have character positions', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        params: {
          characterPrompts: [
            { prompt: 'girl 1', centers: [{ x: 0.2, y: 0.5 }] }
          ]
        }
      };
      const meta2 = {
        params: {
          characterPrompts: [
            { prompt: 'girl 1', centers: [{ x: 0.2, y: 0.5 }] }
          ]
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posBlocks = container.querySelectorAll('.inspector-position-block');
      expect(posBlocks.length).toBe(2);

      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(2);
      expect(posHeaders[0].classList.contains('has-diff')).toBe(false);
      expect(posHeaders[1].classList.contains('has-diff')).toBe(false);

      expect(posBlocks[0].querySelector('.inspector-position-mode-row')).not.toBeNull();
      expect(posBlocks[0].querySelector('.inspector-position-map-wrapper')).not.toBeNull();
      expect(posBlocks[0].querySelector('.inspector-position-coords')).not.toBeNull();
    });

    it('should mark position header with has-diff when coordinates differ', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        params: {
          characterPrompts: [
            { prompt: 'girl', centers: [{ x: 0.2, y: 0.5 }] }
          ]
        }
      };
      const meta2 = {
        params: {
          characterPrompts: [
            { prompt: 'girl', centers: [{ x: 0.8, y: 0.5 }] }
          ]
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(2);
      expect(posHeaders[0].classList.contains('has-diff')).toBe(true);
      expect(posHeaders[1].classList.contains('has-diff')).toBe(true);
    });

    it('should mark position header with has-diff when mode differs', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        params: {
          use_coords: false,
          characterPrompts: [{ prompt: 'girl', centers: [{ x: 0.5, y: 0.5 }] }]
        }
      };
      const meta2 = {
        params: {
          use_coords: true,
          characterPrompts: [{ prompt: 'girl', centers: [{ x: 0.5, y: 0.5 }] }]
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(2);
      expect(posHeaders[0].classList.contains('has-diff')).toBe(true);

      const posBlocks = container.querySelectorAll('.inspector-position-block');
      expect(posBlocks[0].querySelector('.inspector-position-mode-text').textContent).toBe('AIにおまかせ');
      expect(posBlocks[1].querySelector('.inspector-position-mode-text').textContent).toBe('カスタム');
      expect(posBlocks[0].querySelector('.inspector-position-mode-row .diff-tag')).toBeNull();
      expect(posBlocks[1].querySelector('.inspector-position-mode-row .diff-tag')).toBeNull();
      // 「AIにおまかせ」側は画像と座標を表示しないこと
      expect(posBlocks[0].querySelector('.inspector-position-map-wrapper')).toBeNull();
      expect(posBlocks[0].querySelector('.inspector-position-coords')).toBeNull();
      // 「カスタム」側は画像と座標を表示すること
      expect(posBlocks[1].querySelector('.inspector-position-map-wrapper')).not.toBeNull();
      expect(posBlocks[1].querySelector('.inspector-position-coords')).not.toBeNull();
    });

    it('should not mark position header with has-diff when both files are in "AIにおまかせ" mode', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        params: {
          use_coords: false,
          characterPrompts: [{ prompt: 'girl', centers: [{ x: 0.2, y: 0.3 }] }]
        }
      };
      const meta2 = {
        params: {
          use_coords: false,
          characterPrompts: [{ prompt: 'girl', centers: [{ x: 0.8, y: 0.7 }] }]
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(2);
      expect(posHeaders[0].classList.contains('has-diff')).toBe(false);
      expect(posHeaders[1].classList.contains('has-diff')).toBe(false);

      const posBlocks = container.querySelectorAll('.inspector-position-block');
      expect(posBlocks[0].querySelector('.inspector-position-map-wrapper')).toBeNull();
      expect(posBlocks[1].querySelector('.inspector-position-map-wrapper')).toBeNull();
    });

    it('should render position block on one side and "なし" on the other when only one file has positions', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        params: {
          characterPrompts: [{ prompt: 'girl', centers: [{ x: 0.5, y: 0.5 }] }]
        }
      };
      const meta2 = {
        params: {}
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posBlocks = container.querySelectorAll('.inspector-position-block');
      expect(posBlocks.length).toBe(1);

      const emptyTags = container.querySelectorAll('.diff-tag-empty');
      const hasEmptyInPosition = Array.from(emptyTags).some(t => t.textContent === 'なし');
      expect(hasEmptyInPosition).toBe(true);

      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(2);
      expect(posHeaders[0].classList.contains('has-diff')).toBe(true);
    });

    it('should not render copy button on position header or parameter headers in showDiffModal', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        prompt: 'girl',
        negativePrompt: 'bad',
        params: {
          seed: 100,
          steps: 28,
          characterPrompts: [{ prompt: 'girl', uc: 'worst quality', centers: [{ x: 0.5, y: 0.5 }] }]
        }
      };
      const meta2 = {
        prompt: 'girl',
        negativePrompt: 'bad',
        params: {
          seed: 200,
          steps: 28,
          characterPrompts: [{ prompt: 'girl', uc: 'worst quality', centers: [{ x: 0.5, y: 0.5 }] }]
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const sections = container.querySelectorAll('.diff-section');

      sections.forEach(sec => {
        const titleSpan = sec.querySelector('h3 > span > span') || sec.querySelector('h3 > span');
        const title = titleSpan ? titleSpan.textContent.trim() : '';
        const copyBtn = sec.querySelector('h3 .diff-copy-btn');

        if (
          title === 'プロンプト' ||
          title === '除外したい要素' ||
          title.endsWith('プロンプト') ||
          title.endsWith('除外したい要素')
        ) {
          expect(copyBtn, `Copy button should exist on ${title}`).not.toBeNull();
        } else if (title) {
          expect(copyBtn, `Copy button should NOT exist on ${title}`).toBeNull();
        }
      });
    });

    it('should render parameter sections with diff-param-text without diff-tag chips in showDiffModal', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = {
        prompt: 'masterpiece, 1girl',
        negativePrompt: 'low quality, bad anatomy',
        params: {
          seed: 12345,
          steps: 28
        }
      };
      const meta2 = {
        prompt: 'masterpiece, 1girl',
        negativePrompt: 'low quality, bad anatomy',
        params: {
          seed: 67890,
          steps: 28
        }
      };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const paramBoxes = container.querySelectorAll('.prompt-look.param-box');
      expect(paramBoxes.length).toBeGreaterThan(0);

      paramBoxes.forEach(box => {
        // パラメータボックス内には四角い diff-tag が存在しないこと
        const diffTag = box.querySelector('.diff-tag');
        expect(diffTag).toBeNull();

        // 代わりに diff-param-text（または diff-tag-empty）が存在すること
        const paramText = box.querySelector('.diff-param-text, .diff-tag-empty');
        expect(paramText).not.toBeNull();
      });

      // プロンプトボックスには diff-tag が存在すること
      const promptBoxes = container.querySelectorAll('.prompt-look:not(.param-box):not(.inspector-position-block)');
      expect(promptBoxes.length).toBeGreaterThan(0);
      promptBoxes.forEach(box => {
        expect(box.querySelectorAll('.diff-tag').length).toBeGreaterThan(0);
      });
    });

    it('should not render position section when neither file has character positions', () => {
      const file1 = { name: 'f1.png', path: 'f1.png' };
      const file2 = { name: 'f2.png', path: 'f2.png' };
      const meta1 = { params: {} };
      const meta2 = { params: {} };

      uiManager.showDiffModal(file1, file2, meta1, meta2);

      const container = document.getElementById('diff-container');
      const posHeaders = Array.from(container.querySelectorAll('.diff-section h3')).filter(h => h.textContent.includes('位置'));
      expect(posHeaders.length).toBe(0);
    });
  });

  describe('Palette Color Cycling & Contrast for Multi-Characters (up to 27 characters)', () => {
    it('should cycle through 8 palette classes for characters 1 to 27', async () => {
      // 27人分のキャラクター座標メタデータを生成
      const charPrompts = [];
      for (let i = 1; i <= 27; i++) {
        charPrompts.push({
          prompt: `character ${i}`,
          centers: [{ x: (i * 0.035).toFixed(3), y: 0.5 }]
        });
      }

      const file = { name: 'nai_27chars.png', path: 'nai_27chars.png' };
      const meta = {
        source: 'NovelAI Diffusion V5',
        params: {
          width: 1216,
          height: 832,
          characterPrompts: charPrompts
        }
      };
      window.veloceAPI.parseMetadata = vi.fn().mockResolvedValue(meta);

      await renderMetadata(file);

      const container = document.getElementById('inspector-content');
      const markers = container.querySelectorAll('.inspector-position-marker');
      expect(markers.length).toBe(27);

      const coordBadges = container.querySelectorAll('.inspector-coord-badge');
      expect(coordBadges.length).toBe(27);

      // 各キャラクターのクラス割り当て（1〜8のパレット色ループ）を検証
      for (let i = 1; i <= 27; i++) {
        const expectedIndex = ((i - 1) % 8) + 1;
        const expectedClass = `char-marker-${expectedIndex}`;

        expect(markers[i - 1].classList.contains(expectedClass)).toBe(true);
        expect(coordBadges[i - 1].classList.contains(expectedClass)).toBe(true);
      }

      // 9人目が1人目と同じ char-marker-1（default）であること
      expect(markers[8].classList.contains('char-marker-1')).toBe(true);
      // 27人目が ((27 - 1) % 8) + 1 = 3 (blue: char-marker-3) であること
      expect(markers[26].classList.contains('char-marker-3')).toBe(true);
    });

    it('should define high-contrast text and border colors in inspector.css for bright and dark palette colors', () => {
      const fs = require('fs');
      const path = require('path');
      const inspectorCss = fs.readFileSync(path.resolve(__dirname, '../src/renderer/css/inspector.css'), 'utf-8');
      const variablesCss = fs.readFileSync(path.resolve(__dirname, '../src/common/css/variables.css'), 'utf-8');

      // variables.css に暗色テキストと境界線トークンが定義されていること
      expect(variablesCss).toContain('--text-dark: #000000;');
      expect(variablesCss).toContain('--border-dark: rgba(0, 0, 0, 0.65);');

      // 明るいパレット色（default, green, yellow, cyan）は暗色文字・暗色枠線が指定されていること
      expect(inspectorCss).toMatch(/\.char-marker-1[^}]*background-color:\s*var\(--palette-default\);[^}]*color:\s*var\(--text-dark\);[^}]*border-color:\s*var\(--text-dark\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-4[^}]*background-color:\s*var\(--palette-green\);[^}]*color:\s*var\(--text-dark\);[^}]*border-color:\s*var\(--text-dark\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-5[^}]*background-color:\s*var\(--palette-yellow\);[^}]*color:\s*var\(--text-dark\);[^}]*border-color:\s*var\(--text-dark\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-8[^}]*background-color:\s*var\(--palette-cyan\);[^}]*color:\s*var\(--text-dark\);[^}]*border-color:\s*var\(--text-dark\);/s);

      // 暗い・濃いパレット色（red, blue, purple, pink）は明色文字・明色枠線が指定されていること
      expect(inspectorCss).toMatch(/\.char-marker-2[^}]*background-color:\s*var\(--palette-red\);[^}]*color:\s*var\(--text-light\);[^}]*border-color:\s*var\(--text-light\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-3[^}]*background-color:\s*var\(--palette-blue\);[^}]*color:\s*var\(--text-light\);[^}]*border-color:\s*var\(--text-light\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-6[^}]*background-color:\s*var\(--palette-purple\);[^}]*color:\s*var\(--text-light\);[^}]*border-color:\s*var\(--text-light\);/s);
      expect(inspectorCss).toMatch(/\.char-marker-7[^}]*background-color:\s*var\(--palette-pink\);[^}]*color:\s*var\(--text-light\);[^}]*border-color:\s*var\(--text-light\);/s);

      // .inspector-coord-badge の定義がカラークラスより前にあり、後勝ちによる上書き破壊が発生しないこと
      const badgeDefIdx = inspectorCss.indexOf('.inspector-coord-badge {');
      const colorDefIdx = inspectorCss.indexOf('.char-marker-1,');
      expect(badgeDefIdx).toBeGreaterThan(-1);
      expect(colorDefIdx).toBeGreaterThan(-1);
      expect(badgeDefIdx).toBeLessThan(colorDefIdx);
    });
  });
});
