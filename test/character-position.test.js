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

      // Verify that parameters precede the position section
      const rawParamIndex = sections.findIndex(s => s.title === '生成パラメータ (Raw)');
      const positionIndex = sections.findIndex(s => s.title === '位置');
      expect(positionIndex).toBeGreaterThan(rawParamIndex);
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
  });
});
