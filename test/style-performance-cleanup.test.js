import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Style & Performance Cleanups (AGENTS.md & Code Quality)', () => {
  const cssContent = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf-8');
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf-8');
  const rendererJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
  const rendererUiJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
  const mainRsContent = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf-8');

  describe('1. Color Tokens & CSS Variables', () => {
    it('should define palette colors in :root in style.css', () => {
      expect(cssContent).toContain('--palette-default:');
      expect(cssContent).toContain('--palette-red:');
      expect(cssContent).toContain('--palette-blue:');
      expect(cssContent).toContain('--palette-green:');
      expect(cssContent).toContain('--palette-yellow:');
      expect(cssContent).toContain('--palette-purple:');
      expect(cssContent).toContain('--palette-pink:');
      expect(cssContent).toContain('--palette-cyan:');
    });

    it('should use CSS variables for .icon-color-* classes', () => {
      expect(cssContent).toMatch(/\.icon-color-default\s*\{[^}]*color:\s*var\(--palette-default\);/);
      expect(cssContent).toMatch(/\.icon-color-red\s*\{[^}]*color:\s*var\(--palette-red\);/);
      expect(cssContent).toMatch(/\.icon-color-blue\s*\{[^}]*color:\s*var\(--palette-blue\);/);
      expect(cssContent).toMatch(/\.icon-color-green\s*\{[^}]*color:\s*var\(--palette-green\);/);
      expect(cssContent).toMatch(/\.icon-color-yellow\s*\{[^}]*color:\s*var\(--palette-yellow\);/);
      expect(cssContent).toMatch(/\.icon-color-purple\s*\{[^}]*color:\s*var\(--palette-purple\);/);
      expect(cssContent).toMatch(/\.icon-color-pink\s*\{[^}]*color:\s*var\(--palette-pink\);/);
      expect(cssContent).toMatch(/\.icon-color-cyan\s*\{[^}]*color:\s*var\(--palette-cyan\);/);
    });

    it('should use var(--text-light) for glow animation shadows instead of hardcoded #ffffff', () => {
      expect(cssContent).toMatch(/outline-glow-anim[\s\S]*?filter:\s*drop-shadow\(0 0 1px var\(--text-light\)\)/);
      expect(cssContent).toMatch(/outline-glow-text-anim[\s\S]*?text-shadow:\s*0 0 2px var\(--text-light\)/);
    });
  });

  describe('2. Modal & Dialog Uniformity (AGENTS.md Sec 2)', () => {
    it('should not have border-bottom on modal and dialog h2 titles', () => {
      expect(cssContent).toMatch(/\.modal-content h2,\s*\.dialog-box h2\s*\{[^}]*border-bottom:\s*none;/);
    });

    it('should include a uniform close button in showLicenseDialog', () => {
      expect(rendererJsContent).toContain('id="license-close-btn"');
      expect(rendererJsContent).toContain('modal-header-row');
      expect(rendererJsContent).toContain("content.querySelector('#license-close-btn')");
    });
  });

  describe('3. Inline Style Elimination & Class Consolidation', () => {
    it('should not have inline styles on rating-filter-container in index.html', () => {
      expect(htmlContent).not.toMatch(/id="rating-filter-container"\s+style=/);
      expect(htmlContent).toContain('class="rating-filter-wrapper"');
    });

    it('should not have inline styles on left-controls and slider-wrapper in index.html', () => {
      expect(htmlContent).not.toMatch(/class="left-controls"\s+style=/);
      expect(htmlContent).not.toMatch(/class="slider-wrapper"\s+style=/);
    });

    it('should not have inline styles on right-pane and inspector-header in index.html', () => {
      expect(htmlContent).not.toMatch(/id="right-pane"\s+style=/);
      expect(htmlContent).not.toMatch(/id="inspector-header"[^>]*style=/);
      expect(htmlContent).not.toMatch(/id="inspector-section"[^>]*style=/);
    });

    it('should not have inline styles on smart folder condition template in index.html', () => {
      expect(htmlContent).not.toMatch(/class="sf-condition-row"[^>]*style=/);
      expect(htmlContent).not.toMatch(/class="custom-select cond-type-select"[^>]*style=/);
      expect(htmlContent).not.toMatch(/class="custom-select cond-op-select"[^>]*style=/);
    });

    it('should use CSS classes for context menu item contents in renderer.js', () => {
      expect(rendererJsContent).toContain('class="menu-icon-placeholder"');
      expect(rendererJsContent).toContain('class="menu-label"');
      expect(rendererJsContent).toContain('class="menu-shortcut"');
      expect(rendererJsContent).not.toContain('<span style="text-align: left; white-space: nowrap;">');
    });

    it('should use CSS classes for diff modal containers in renderer-ui.js', () => {
      expect(rendererUiJsContent).toContain('class="diff-pane-container"');
      expect(rendererUiJsContent).toContain('class="diff-pane-col"');
      expect(rendererUiJsContent).not.toContain('<div style="display: flex; gap: 15px; margin-bottom: 15px;">');
    });

    it('should use CSS classes for list spacers in renderer-ui.js', () => {
      expect(rendererUiJsContent).toContain('list-spacer-row');
      expect(rendererUiJsContent).toContain('list-spacer-cell');
      expect(rendererUiJsContent).not.toContain('<tr class="list-top-spacer" style="border: none; padding: 0;">');
    });
  });

  describe('4. Performance & DOM Optimizations', () => {
    it('should use CSS classes instead of inline style assignments in getInspectorSection', () => {
      expect(rendererJsContent).toContain('inspector-section-block');
      expect(rendererJsContent).toContain('inspector-section-h3');
      expect(rendererJsContent).toContain('inspector-title-wrapper');
      expect(rendererJsContent).toContain('inspector-copy-wrapper');
      expect(rendererJsContent).not.toContain("h3.style.fontSize = 'var(--font-size-xs)'");
      expect(rendererJsContent).not.toContain("h3.style.lineHeight = '22px'");
    });

    it('should reuse copy button DOM in renderMetadata rather than innerHTML string parsing every time', () => {
      expect(rendererJsContent).toContain('if (!secEl.copyBtn)');
      expect(rendererJsContent).toContain("secEl.copyBtn.setAttribute('data-copy-text', section.value)");
    });

    it('should avoid innerHTML re-parse on dragover by caching tooltip child nodes', () => {
      expect(rendererJsContent).toContain('function updateDragTooltip');
      expect(rendererJsContent).toContain('dragTooltipText.textContent !== text');
      expect(rendererJsContent).not.toMatch(/dragover[\s\S]*?dragTooltip\.innerHTML\s*=/);
    });

    it('should avoid re-parsing empty state SVG in updateVirtualGrid when mode has not changed', () => {
      expect(rendererUiJsContent).toContain('emptyContainer.dataset.mode !== targetMode');
    });
  });

  describe('5. Documentation & Compliance (AGENTS.md Sec 4)', () => {
    it('should not contain exaggerated expressions like "超高速な" in main.rs', () => {
      expect(mainRsContent).not.toContain('超高速な');
      expect(mainRsContent).toContain('高速な `xxHash (xxh3_64)`');
    });
  });
});
