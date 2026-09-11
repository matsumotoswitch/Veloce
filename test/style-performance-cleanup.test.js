import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Style & Performance Cleanups (AGENTS.md & Code Quality)', () => {
  const cssContent = getFullCssContent();
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf-8');
  const rendererJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
  const helpJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-help.js'), 'utf-8');
  const inspectorJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-inspector.js'), 'utf-8');
  const dndJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-dnd.js'), 'utf-8');
  const contextMenuJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-context-menu.js'), 'utf-8');
  const rendererUiJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
  const viewerJsContent = fs.readFileSync(path.resolve(__dirname, '../src/viewer.js'), 'utf-8');
  const thumbnailsJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer-thumbnails.js'), 'utf-8');
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

    it('should tokenize bookmark-item.selected gradient and eliminate hardcoded rgba(28, 94, 105, ...)', () => {
      expect(cssContent).toMatch(/\.bookmark-item\.selected\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(var\(--accent-rgb\),\s*0\.25\),\s*rgba\(var\(--accent-rgb\),\s*0\.35\)\);/);
      expect(cssContent).not.toContain('28, 94, 105');
    });
  });

  describe('2. Modal & Dialog Uniformity (AGENTS.md Sec 2)', () => {
    it('should not have border-bottom on modal and dialog h2 titles', () => {
      expect(cssContent).toMatch(/\.modal-content h2,\s*\.dialog-box h2\s*\{[^}]*border-bottom:\s*none;/);
    });

    it('should include a uniform close button in showLicenseDialog', () => {
      expect(helpJsContent).toContain('id="license-close-btn"');
      expect(helpJsContent).toContain('modal-header-row');
      expect(helpJsContent).toContain("content.querySelector('#license-close-btn')");
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

    it('should use CSS classes for context menu item contents in renderer-context-menu.js', () => {
      expect(contextMenuJsContent).toContain('class="menu-icon-placeholder"');
      expect(contextMenuJsContent).toContain('class="menu-label"');
      expect(contextMenuJsContent).toContain('class="menu-shortcut"');
      expect(contextMenuJsContent).not.toContain('<span style="text-align: left; white-space: nowrap;">');
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

    it('should eliminate inline cubic-bezier transition override on flash effect in viewer.js', () => {
      expect(viewerJsContent).not.toMatch(/flash\.style\.transition\s*=\s*['"][^'"]*cubic-bezier/);
      expect(viewerJsContent).toContain("flash.style.transition = '';");
    });

    it('should eliminate inline style assignments in createTreeNode in renderer.js and consolidate tree icon styles in layout.css', () => {
      // renderer.js
      expect(rendererJsContent).not.toMatch(/createTreeNode[\s\S]*?itemDiv\.style\.display\s*=\s*'flex'/);
      expect(rendererJsContent).not.toMatch(/createTreeNode[\s\S]*?toggleIcon\.style\.display\s*=\s*'inline-flex'/);
      expect(rendererJsContent).not.toMatch(/createTreeNode[\s\S]*?icon\.style\.marginRight\s*=\s*'4px'/);
      expect(rendererJsContent).not.toMatch(/createTreeNode[\s\S]*?icon\.style\.color\s*=\s*'var\(--accent-hover\)'/);

      // layout.css
      expect(cssContent).toMatch(/#dir-tree \.tree-icon\s*\{[^}]*display:\s*inline-flex;/);
      expect(cssContent).toMatch(/#dir-tree \.tree-icon\s*\{[^}]*align-items:\s*center;/);
      expect(cssContent).toMatch(/#dir-tree \.tree-icon\s*\{[^}]*color:\s*var\(--accent-hover\);/);
      expect(cssContent).toMatch(/#dir-tree \.tree-item\[data-is-root="true"\] \.tree-icon\s*\{[^}]*color:\s*var\(--text-color\);/);
    });
  });

  describe('4. Performance & DOM Optimizations', () => {
    it('should use CSS classes instead of inline style assignments in getInspectorSection', () => {
      expect(inspectorJsContent).toContain('inspector-section-block');
      expect(inspectorJsContent).toContain('inspector-section-h3');
      expect(inspectorJsContent).toContain('inspector-title-wrapper');
      expect(inspectorJsContent).toContain('inspector-copy-wrapper');
      expect(inspectorJsContent).not.toContain("h3.style.fontSize = 'var(--font-size-xs)'");
      expect(inspectorJsContent).not.toContain("h3.style.lineHeight = '22px'");
    });

    it('should reuse copy button DOM in renderMetadata rather than innerHTML string parsing every time', () => {
      expect(inspectorJsContent).toContain('if (!secEl.copyBtn)');
      expect(inspectorJsContent).toContain("secEl.copyBtn.setAttribute('data-copy-text', section.value)");
    });

    it('should use prompt-look raw-box class and avoid inline styles for unsupported metadata in renderer-inspector.js', () => {
      expect(inspectorJsContent).not.toContain("secEl.box.style.fontFamily = 'Consolas, monospace'");
      expect(inspectorJsContent).not.toContain("secEl.box.style.whiteSpace = 'pre-wrap'");
      expect(inspectorJsContent).not.toContain("secEl.box.style.wordBreak = 'break-all'");
      expect(inspectorJsContent).not.toContain('Consolas');
      expect(inspectorJsContent).toContain("secEl.box.className = 'prompt-look raw-box';");
      expect(inspectorJsContent).toContain("secEl.box.style.cssText = '';");
    });

    it('should avoid innerHTML re-parse on dragover by caching tooltip child nodes', () => {
      expect(dndJsContent).toContain('function updateDragTooltip');
      expect(dndJsContent).toContain('dragTooltipText.textContent !== text');
      expect(dndJsContent).not.toMatch(/dragover[\s\S]*?dragTooltip\.innerHTML\s*=/);
    });

    it('should avoid re-parsing empty state SVG in updateVirtualGrid when mode has not changed', () => {
      expect(rendererUiJsContent).toContain('emptyContainer.dataset.mode !== targetMode');
    });

    it('should eliminate innerHTML getter overhead in updateVirtualList by caching rating in _cachedRating', () => {
      // innerHTML ゲッターの排除（毎スクロールフレームでの C++ DOM ツリーシリアライズを防止）
      expect(rendererUiJsContent).not.toMatch(/tds\[7\]\.innerHTML\s*!==/);
      expect(rendererUiJsContent).toContain('if (tds[7]._cachedRating !== rating)');
      expect(rendererUiJsContent).toContain('tds[7]._cachedRating = rating;');

      // renderer.js の applyRatingUI でも _cachedRating が正しく同期されていること
      expect(rendererJsContent).toContain('td._cachedRating = rating;');
    });

    it('should suppress Watchdog DOM traversal during idle state in renderer-thumbnails.js', () => {
      expect(thumbnailsJsContent).toContain("activeCenterPane !== 'grid'");
      expect(thumbnailsJsContent).toContain('allHealthy = false');
      expect(thumbnailsJsContent).toContain('export function checkThumbnailSelfHealing');
      expect(thumbnailsJsContent).toContain('window.checkThumbnailSelfHealing = checkThumbnailSelfHealing;');
    });

    it('should use replaceChildren() instead of innerHTML = "" for DOM clearing to reduce GC and avoid HTML parser overhead', () => {
      // renderer.js
      expect(rendererJsContent).not.toMatch(/innerHTML\s*=\s*['"]['"]/);
      expect(rendererJsContent).toContain('uiManager.elements.dirTree.replaceChildren(ul);');
      expect(rendererJsContent).toContain('container.replaceChildren();');
      expect(rendererJsContent).toContain('childrenUl.replaceChildren();');
      expect(rendererJsContent).toContain('menu.replaceChildren();');
      expect(rendererJsContent).toContain('bookmarkOverflowMenu.replaceChildren();');
      expect(rendererJsContent).toContain('tabListMenu.replaceChildren();');

      // renderer-ui.js
      expect(rendererUiJsContent).not.toMatch(/innerHTML\s*=\s*['"]['"]/);
      expect(rendererUiJsContent).toContain('this.elements.fileListBody.replaceChildren();');
      expect(rendererUiJsContent).toContain('content.replaceChildren();');
      expect(rendererUiJsContent).toContain('tbody.replaceChildren();');
      expect(rendererUiJsContent).toContain('tds[7].replaceChildren();');

      // renderer-inspector.js
      expect(inspectorJsContent).not.toMatch(/innerHTML\s*=\s*['"]['"]/);
      expect(inspectorJsContent).toContain('sec1.copyWrapper.replaceChildren();');
      expect(inspectorJsContent).toContain('sec2.copyWrapper.replaceChildren();');
      expect(inspectorJsContent).toContain('secEl.subLabel.replaceChildren();');

      // viewer.js
      expect(viewerJsContent).not.toMatch(/innerHTML\s*=\s*['"]['"]/);
      expect(viewerJsContent).toContain('contentEl.replaceChildren(fragment);');
    });
  });

  describe('5. Documentation & Compliance (AGENTS.md Sec 4)', () => {
    it('should not contain exaggerated expressions like "超高速な" in main.rs', () => {
      expect(mainRsContent).not.toContain('超高速な');
      expect(mainRsContent).toContain('高速な `xxHash (xxh3_64)`');
    });
  });
});
