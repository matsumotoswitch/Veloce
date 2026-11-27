/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeTagForMatch,
  toggleTagInQuery,
  resolveChipFilterMode
} from '../src/renderer/renderer-toolbar.js';
import { isExcludeSectionTitle } from '../src/common/metadata-format.js';
import { showDiffModal } from '../src/renderer/renderer-diff.js';

describe('Chip Shift+Click Filter (v1.20.0 Item 3)', () => {
  describe('normalizeTagForMatch & toggleTagInQuery', () => {
    it('adds a tag to an empty query and removes it when toggled again (include mode)', () => {
      const added = toggleTagInQuery('', '1girl', 'include');
      expect(added).toBe('1girl');

      const removed = toggleTagInQuery(added, '1girl', 'include');
      expect(removed).toBe('');
    });

    it('adds and removes exclude tags with leading hyphen (exclude mode)', () => {
      const added = toggleTagInQuery('', 'lowres', 'exclude');
      expect(added).toBe('-lowres');

      const appended = toggleTagInQuery('1girl, smile', 'lowres', 'exclude');
      expect(appended).toBe('1girl, smile, -lowres');

      const removed = toggleTagInQuery('1girl, -lowres, smile', 'lowres', 'exclude');
      expect(removed).toBe('1girl, smile');
    });

    it('matches underscore/space and case variations when removing without altering written form of other terms', () => {
      // クエリ側 "hatsune miku" に対しチップ "hatsune_miku" で追加ではなく解除になること
      expect(toggleTagInQuery('hatsune miku', 'hatsune_miku', 'include')).toBe('');
      expect(toggleTagInQuery('Masterpiece, hatsune miku, Solo_Girl', 'hatsune_miku', 'include'))
        .toBe('Masterpiece, Solo_Girl');

      // 逆方向・大文字小文字・連続スペースの表記ゆれ
      expect(toggleTagInQuery('Hatsune_Miku, Blue_Eyes', 'hatsune   miku', 'include'))
        .toBe('Blue_Eyes');
      expect(toggleTagInQuery('1GIRL, Smile', 'smile', 'include')).toBe('1GIRL');

      // 除外モードでも表記ゆれを吸収して解除すること
      expect(toggleTagInQuery('1girl, -Bad Hands, solo', 'bad_hands', 'exclude'))
        .toBe('1girl, solo');
    });

    it('preserves chip literal formatting (underscores, case, weights) when appending', () => {
      expect(toggleTagInQuery('Masterpiece', 'hatsune_miku', 'include'))
        .toBe('Masterpiece, hatsune_miku');
      expect(toggleTagInQuery('1girl', '1.2::blue_hair::', 'include'))
        .toBe('1girl, 1.2::blue_hair::');
      expect(toggleTagInQuery('1girl, 1.2::blue_hair::', '1.2::blue_hair::', 'include'))
        .toBe('1girl');
      expect(toggleTagInQuery('1girl', 'Worst_Quality', 'exclude'))
        .toBe('1girl, -Worst_Quality');
    });

    it('keeps include and exclude modes independent for the same tag', () => {
      expect(toggleTagInQuery('1girl', '1girl', 'exclude')).toBe('1girl, -1girl');
      expect(toggleTagInQuery('-1girl', '1girl', 'include')).toBe('-1girl, 1girl');
      expect(toggleTagInQuery('1girl, -1girl', '1girl', 'include')).toBe('-1girl');
      expect(toggleTagInQuery('1girl, -1girl', '1girl', 'exclude')).toBe('1girl');
    });

    it('preserves exact spelling and order of untouched terms', () => {
      const q1 = toggleTagInQuery('Alpha_One, Beta Two, Gamma_Three', 'Delta_Four', 'include');
      expect(q1).toBe('Alpha_One, Beta Two, Gamma_Three, Delta_Four');

      const q2 = toggleTagInQuery(q1, 'beta_two', 'include');
      expect(q2).toBe('Alpha_One, Gamma_Three, Delta_Four');
    });

    it('handles whitespace-only tag safely without mutating query', () => {
      expect(toggleTagInQuery('1girl, solo', '   ', 'include')).toBe('1girl, solo');
      expect(normalizeTagForMatch('  Hatsune__Miku  ')).toBe('hatsune miku');
    });
  });

  describe('isExcludeSectionTitle & resolveChipFilterMode', () => {
    it('identifies UC exclude section titles accurately without matching parameter sections', () => {
      expect(isExcludeSectionTitle('除外したい要素')).toBe(true);
      expect(isExcludeSectionTitle('採用除外したい要素')).toBe(true);
      expect(isExcludeSectionTitle('キャラクター 1 除外したい要素')).toBe(true);
      expect(isExcludeSectionTitle('キャラクター 2 採用除外したい要素')).toBe(true);

      expect(isExcludeSectionTitle('プロンプト')).toBe(false);
      expect(isExcludeSectionTitle('採用プロンプト')).toBe(false);
      expect(isExcludeSectionTitle('キャラクター 1 プロンプト')).toBe(false);
      expect(isExcludeSectionTitle('除外したい要素の強さ')).toBe(false);
    });

    it('resolves filter mode from data-filter-mode or ancestor section heading', () => {
      document.body.innerHTML = `
        <div class="inspector-section">
          <h3><span class="inspector-title-wrapper"><span>キャラクター 1 除外したい要素</span><span></span></span></h3>
          <div class="prompt-look"><span class="diff-tag" id="uc-chip">bad hands</span></div>
        </div>
        <div class="diff-section">
          <h3><span><span>採用プロンプト</span></span></h3>
          <div class="prompt-look"><span class="diff-tag" id="pos-chip">1girl</span></div>
        </div>
      `;

      expect(resolveChipFilterMode(document.getElementById('uc-chip'))).toBe('exclude');
      expect(resolveChipFilterMode(document.getElementById('pos-chip'))).toBe('include');

      const explicitChip = document.createElement('span');
      explicitChip.dataset.filterMode = 'exclude';
      expect(resolveChipFilterMode(explicitChip)).toBe('exclude');
    });
  });

  describe('Diff Modal chip hints and filter modes', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="diff-modal" class="modal">
          <div id="diff-container"></div>
        </div>
      `;
      window.veloceAPI = {
        convertFileSrc: vi.fn(p => `asset://${p}`)
      };
      window.requestAnimationFrame = cb => cb();
    });

    it('sets custom tooltip hints (data-tooltip) without native title and shows custom tooltip on hover in Diff modal', () => {
      const uiMock = {
        bindTooltip: vi.fn(),
        showCustomTooltip: vi.fn(),
        hideCustomTooltip: vi.fn(),
        showToast: vi.fn(),
        applyGlowEffect: vi.fn()
      };
      showDiffModal(
        { name: 'a.png', path: 'C:\\a.png' },
        { name: 'b.png', path: 'C:\\b.png' },
        { prompt: '1girl, smile', negativePrompt: 'lowres' },
        { prompt: '1girl, blue eyes', negativePrompt: 'lowres, bad hands' },
        uiMock
      );

      const container = document.getElementById('diff-container');
      const includeChips = container.querySelectorAll('.diff-tag[data-filter-mode="include"]');
      const excludeChips = container.querySelectorAll('.diff-tag[data-filter-mode="exclude"]');

      expect(includeChips.length).toBeGreaterThan(0);
      expect(excludeChips.length).toBeGreaterThan(0);

      includeChips.forEach(chip => {
        expect(chip.hasAttribute('title')).toBe(false);
        expect(chip.dataset.tooltip).toBe('クリックでコピー / Shift+クリックでフィルタ切替');
      });
      excludeChips.forEach(chip => {
        expect(chip.hasAttribute('title')).toBe(false);
        expect(chip.dataset.tooltip).toBe('クリックでコピー / Shift+クリックで除外切替');
      });

      includeChips[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 60 }));
      expect(uiMock.showCustomTooltip).toHaveBeenCalledWith('クリックでコピー / Shift+クリックでフィルタ切替', 50, 60);

      excludeChips[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 70, clientY: 80 }));
      expect(uiMock.showCustomTooltip).toHaveBeenCalledWith('クリックでコピー / Shift+クリックで除外切替', 70, 80);
    });
  });
});

