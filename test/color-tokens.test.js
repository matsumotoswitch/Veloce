import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Design Token and Color Consistency (AGENTS.md Sec 2)', () => {
  const cssContent = getFullCssContent();

  it('should define essential color tokens in :root', () => {
    expect(cssContent).toContain('--glow-gold:');
    expect(cssContent).toContain('--danger-red:');
    expect(cssContent).toContain('--border-color:');
    expect(cssContent).toContain('--text-color:');
    expect(cssContent).toContain('--bg-color:');
  });

  it('should use var(--border-color) for scrollbar thumb instead of hardcoded hex', () => {
    expect(cssContent).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--border-color\);/);
    expect(cssContent).not.toContain('background-color: #3a454a;');
  });

  it('should use var(--text-color) with opacity for tree toggle icon instead of #888', () => {
    expect(cssContent).toMatch(/\.toggle-icon\s*\{[^}]*color:\s*var\(--text-color\);/);
    expect(cssContent).toMatch(/\.toggle-icon\s*\{[^}]*opacity:\s*0\.5;/);
    expect(cssContent).not.toMatch(/\.toggle-icon\s*\{[^}]*color:\s*#888;/);
  });

  it('should use var(--danger-red) for viewer close button hover', () => {
    expect(cssContent).toMatch(/\.viewer-body #window-controls:not\(\.has-gradient\)\s+\.window-ctrl-btn--close:hover\s*\{[^}]*background-color:\s*var\(--danger-red\);/);
  });

  it('should use var(--glow-gold) for thumbnail rating badge instead of #ffd700', () => {
    expect(cssContent).toMatch(/\.rating-badge svg\s*\{[^}]*fill:\s*var\(--glow-gold\);/);
    expect(cssContent).not.toMatch(/\.rating-badge svg\s*\{[^}]*fill:\s*#ffd700;/);
  });

  it('should style thumbnail rating badge with lightweight translucency without backdrop-filter', () => {
    expect(cssContent).toMatch(/\.rating-badge\s*\{[^}]*background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.45\);/);
    expect(cssContent).toMatch(/\.rating-badge\s*\{[^}]*border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.18\);/);
    expect(cssContent).toMatch(/\.rating-badge\s*\{[^}]*box-shadow:\s*0 2px 6px rgba\(0,\s*0,\s*0,\s*0\.35\);/);
    expect(cssContent).not.toMatch(/\.rating-badge\s*\{[^}]*backdrop-filter:\s*blur/);
  });

  it('should style thumbnail-label with lightweight translucency consistent with rating-badge', () => {
    expect(cssContent).toMatch(/\.thumbnail-label\s*\{[^}]*background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.45\);/);
    expect(cssContent).toMatch(/\.thumbnail-label\s*\{[^}]*border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.18\);/);
    expect(cssContent).toMatch(/\.thumbnail-label\s*\{[^}]*text-shadow:\s*0 1px 2px rgba\(0,\s*0,\s*0,\s*0\.8\);/);
    expect(cssContent).not.toMatch(/\.thumbnail-label\s*\{[^}]*opacity:\s*0\.75;/);
  });

  it('should unify rating-badge and thumbnail-label hover styles and remove drop-shadow on svg', () => {
    expect(cssContent).toMatch(/\.thumbnail-item:hover \.rating-badge\s*\{[^}]*background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.75\);/);
    expect(cssContent).toMatch(/\.thumbnail-item:hover \.thumbnail-label\s*\{[^}]*background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.75\);/);
    expect(cssContent).not.toMatch(/\.rating-badge svg\s*\{[^}]*filter:\s*drop-shadow/);
  });

  it('should define common .rating-star-icon using var(--glow-gold)', () => {
    expect(cssContent).toMatch(/\.rating-star-icon\s*\{[^}]*fill:\s*var\(--glow-gold\);/);
  });

  it('should use var(--text-light) for titlebar and window control buttons instead of #ffffff', () => {
    expect(cssContent).toMatch(/\.titlebar-button:hover\s*\{[^}]*color:\s*var\(--text-light\);/);
    expect(cssContent).toMatch(/\.titlebar-button\.titlebar-close:hover\s*\{[^}]*color:\s*var\(--text-light\);/);
    expect(cssContent).toMatch(/\.window-ctrl-btn--close:hover\s*\{[^}]*color:\s*var\(--text-light\);/);
  });

  it('should not contain raw unaliased #ffd700 outside variable definitions or fallback declarations in CSS', () => {
    // :root の定義行と var(--..., #ffd700) 以外の直接指定（例: fill: #ffd700; color: #ffd700;）を排除
    const lines = cssContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes('#ffd700')) {
        const isRootDef = line.includes('--glow-gold:');
        const isVarFallback = line.includes('var(');
        expect(isRootDef || isVarFallback, `Raw #ffd700 found at line ${i + 1}: "${line}"`).toBe(true);
      }
    }
  });

  it('should use var(--accent-hover) for .diff-tag.added instead of hardcoded #61c7d6', () => {
    expect(cssContent).toMatch(/\.diff-tag\.added\s*\{[^}]*color:\s*var\(--accent-hover\);/);
    expect(cssContent).not.toMatch(/\.diff-tag\.added\s*\{[^}]*color:\s*#61c7d6;/);
  });

  it('should define .diff-tag.search-match using var(--glow-gold)', () => {
    expect(cssContent).toMatch(/\.diff-tag\.search-match\s*\{[^}]*color:\s*var\(--glow-gold\)/);
    expect(cssContent).toMatch(/\.diff-tag\.search-match\s*\{[^}]*border-color:\s*var\(--glow-gold\)/);
  });

  it('should define help and license modal classes in style.css', () => {
    expect(cssContent).toContain('.license-modal-content');
    expect(cssContent).toContain('.modal-header-row');
    expect(cssContent).toContain('.modal-header-title');
    expect(cssContent).toContain('.license-link-btn');
    expect(cssContent).toContain('#license-text');
  });

  it('should use var(--accent-hover) for folder tree icons in renderer.js instead of #4da8da', () => {
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).toContain("icon.style.color = 'var(--accent-hover)';");
    expect(rendererJs).not.toContain("icon.style.color = '#4da8da';");
  });

  it('should use classList.toggle for inspector search match in renderer-inspector.js instead of inline #ffcc00 styling', () => {
    const inspectorJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-inspector.js'), 'utf-8');
    expect(inspectorJs).toContain("tagEl.classList.toggle('search-match', isMatch);");
    expect(inspectorJs).not.toContain("tagEl.style.color = '#ffcc00';");
    expect(inspectorJs).not.toContain("tagEl.style.border = '1px solid #ffcc00';");
  });

  it('should use shared BROKEN_MP4_FALLBACK_URL constant in renderer-thumbnails.js instead of inline btoa', () => {
    const thumbnailsJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-thumbnails.js'), 'utf-8');
    expect(thumbnailsJs).toContain('const fallbackUrl = BROKEN_MP4_FALLBACK_URL;');
    expect(thumbnailsJs).not.toContain("btoa(BROKEN_SVG)");
  });

  it('should maintain outer accent border and box-shadow on search container while suppressing inner focus line on search bar', () => {
    expect(cssContent).toMatch(/#search-container:focus-within\s*\{[^}]*border-color:\s*var\(--accent-color\);/);
    expect(cssContent).toMatch(/#search-container:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 2px rgba\(var\(--accent-rgb\),\s*0\.25\);/);
    expect(cssContent).toMatch(/#search-bar:focus-visible\s*\{[^}]*box-shadow:\s*none;/);
  });

  it('should define generation technique color tokens in :root', () => {
    expect(cssContent).toContain('--color-tag-inpainting: #4a9eff;');
    expect(cssContent).toContain('--color-tag-vibe: #d27aff;');
    expect(cssContent).toContain('--color-tag-char-ref: #ff9a4a;');
    expect(cssContent).toContain('--color-tag-img2img: #4ade80;');
  });

  it('should define unified classes for sublabel tags, raw-box, flash-effect, drag-ghost, and virtual containers', () => {
    expect(cssContent).toContain('.sublabel-tags-wrapper');
    expect(cssContent).toContain('.sublabel-tag--inpainting');
    expect(cssContent).toContain('.prompt-look.raw-box');
    expect(cssContent).toContain('#viewer-flash-effect');
    expect(cssContent).toContain('.bookmark-drag-ghost');
    expect(cssContent).toContain('.virtual-content');
  });

  it('should not contain hardcoded technique hex colors in renderer.js or renderer-ui.js', () => {
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    const rendererUiJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');

    for (const code of [rendererJs, rendererUiJs]) {
      expect(code).not.toContain("color = '#4a9eff'");
      expect(code).not.toContain("color = '#d27aff'");
      expect(code).not.toContain("color = '#ff9a4a'");
      expect(code).not.toContain("color = '#4ade80'");
    }
  });

  it('should define table cell right alignments in style.css and avoid inline textAlign in renderer-ui.js', () => {
    expect(cssContent).toMatch(/#file-table td:nth-child\(3\)[^}]*text-align:\s*right;/);
    const rendererUiJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
    expect(rendererUiJs).not.toContain("tds[2].style.textAlign = 'right'");
  });

  it('should define .thumbnail-flash-effect in style.css and eliminate forced reflow getComputedStyle in renderer.js', () => {
    expect(cssContent).toMatch(/\.thumbnail-flash-effect\s*\{[^}]*position:\s*fixed;/);
    expect(cssContent).toMatch(/\.thumbnail-flash-effect\s*\{[^}]*border-radius:\s*var\(--radius-xs\);/);
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).not.toContain('window.getComputedStyle(el).borderRadius');
    expect(rendererJs).toContain("flash.className = 'thumbnail-flash-effect'");
  });

  it('should define tab-list-item sub-elements in style.css and eliminate inline styles in tabListMenu', () => {
    expect(cssContent).toMatch(/\.tab-list-item \.tab-list-icon\s*\{/);
    expect(cssContent).toMatch(/\.tab-list-item \.tab-menu-item-text\s*\{/);
    expect(cssContent).toMatch(/\.tab-list-item \.tab-menu-item-name\s*\{/);
    expect(cssContent).toMatch(/\.tab-list-item \.tab-close-btn\s*\{/);

    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).not.toContain("textContainer.style.display = 'flex'");
    expect(rendererJs).not.toContain("nameLabel.style.fontWeight =");
    expect(rendererJs).not.toContain("closeBtn.style.flexShrink = '0'");
  });

  it('should define #tab-container .tab-item .tab-icon in style.css and eliminate inline styles in renderer-ui.js', () => {
    expect(cssContent).toMatch(/#tab-container \.tab-item \.tab-icon\s*\{[^}]*margin-right:\s*6px;/);
    const rendererUiJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
    expect(rendererUiJs).not.toContain("iconSpan.style.marginRight = '6px'");
  });

  it('should define .tab-collapsing in style.css and eliminate multi-property inline style assignments in renderer-tabs.js', () => {
    expect(cssContent).toMatch(/#tab-container \.tab-item\.tab-collapsing\s*\{[^}]*transition:\s*min-width/);
    const rendererTabsJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-tabs.js'), 'utf-8');
    expect(rendererTabsJs).toContain("targetTabEl.classList.add('tab-collapsing')");
    expect(rendererTabsJs).not.toContain("targetTabEl.style.minWidth = '0'");
  });

  it('should unify license modal colors with modal tokens and avoid #0d1315 or panel-bg', () => {
    expect(cssContent).toMatch(/\.license-modal-content\s*\{[^}]*background-color:\s*var\(--modal-bg\);/);
    expect(cssContent).toMatch(/\.license-modal-content\s*\{[^}]*border:\s*1px solid var\(--modal-border\);/);
    expect(cssContent).not.toContain('#0d1315');
  });

  it('should use var(--text-light) in help-overlay and license-link-btn:hover instead of #fff', () => {
    expect(cssContent).toMatch(/#help-overlay\s*\{[^}]*color:\s*var\(--text-light\);/);
    expect(cssContent).toMatch(/\.license-link-btn:hover\s*\{[^}]*color:\s*var\(--text-light\);/);
    expect(cssContent).not.toContain('color: #fff;');
  });

  it('should consolidate diff section headers in style.css and eliminate inline styles in renderer-ui.js', () => {
    expect(cssContent).toMatch(/\.diff-section h3\s*\{[^}]*display:\s*flex;/);
    expect(cssContent).toMatch(/\.diff-section h3 > span\s*\{[^}]*display:\s*flex;/);
    const rendererUiJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
    expect(rendererUiJs).not.toContain('style="display: flex; justify-content: space-between;');
  });

  it('should define .is-dragging in style.css and avoid inline opacity assignments in renderer.js and renderer-ui.js', () => {
    expect(cssContent).toMatch(/\.tab-item\.is-dragging,\s*\.bookmark-item\.is-dragging\s*\{[^}]*opacity:\s*0\.5/);
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    const rendererUiJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer-ui.js'), 'utf-8');
    expect(rendererJs).not.toContain("itemDiv.style.opacity = '0.5'");
    expect(rendererUiJs).not.toContain("tabEl.style.opacity = '0.5'");
  });

  it('should define unsharp-svg and viewer info-container gradient styles in style.css and eliminate inline styles in viewer.js', () => {
    expect(cssContent).toMatch(/\.unsharp-svg\s*\{[^}]*position:\s*absolute;/);
    expect(cssContent).toMatch(/\.viewer-body #window-controls:not\(\.has-gradient\)\s+\.window-info-container\s*\{[^}]*background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.4\);/);
    const viewerJs = fs.readFileSync(path.resolve(__dirname, '../src/viewer.js'), 'utf-8');
    expect(viewerJs).not.toContain("svgElement.style.position = 'absolute'");
    expect(viewerJs).not.toContain("infoContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.4)'");
  });

  it('should eliminate forced reflow querySelector for table thead in scrollToIndex', () => {
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).not.toContain("document.querySelector('#file-table thead')?.getBoundingClientRect()");
    expect(rendererJs).toContain("const theadHeight = 32;");
  });

  it('should unify bookmark-overflow-menu and history-menu using show class instead of inline display/animation', () => {
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).not.toContain("bookmarkOverflowMenu.style.display = 'block'");
    expect(rendererJs).not.toContain("bookmarkOverflowMenu.style.transition =");
    expect(rendererJs).not.toContain("overflowMenu.style.display = 'none'");
    expect(rendererJs).toContain("bookmarkOverflowMenu.classList.add('show')");
    expect(rendererJs).toContain("bookmarkOverflowMenu.classList.remove('show')");
    expect(rendererJs).toContain("overflowMenu.classList.remove('show')");
  });

  it('should define extended transition and font-family tokens in :root', () => {
    expect(cssContent).toContain('--transition-close:');
    expect(cssContent).toContain('--transition-glow:');
    expect(cssContent).toContain('--font-family-base:');
    expect(cssContent).toContain('--font-family-mono:');
  });

  it('should not contain unaliased font-size: 14px in any stylesheet module', () => {
    expect(cssContent).not.toMatch(/font-size:\s*14px;/);
  });

  it('should use design tokens for border-radius across UI components', () => {
    expect(cssContent).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*var\(--radius-md\);/);
    expect(cssContent).toMatch(/\.thumbnail-label\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/);
    expect(cssContent).toMatch(/\.rating-badge\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/);
    expect(cssContent).toMatch(/#video-controls-container\s*\{[^}]*border-radius:\s*var\(--radius-md\);/);
    expect(cssContent).toMatch(/#video-play-btn\s*\{[^}]*border-radius:\s*var\(--radius-xs\);/);
  });

  it('should use var(--transition-close) and var(--transition-glow) instead of raw cubic-bezier curves', () => {
    expect(cssContent).toMatch(/\.dialog-overlay,\s*\.modal\s*\{[^}]*transition:[^}]*var\(--transition-close\)/);
    expect(cssContent).toMatch(/\.dialog-box\s*\{[^}]*transition:[^}]*var\(--transition-close\)/);
    expect(cssContent).toMatch(/#context-menu[^}]*transition:[^}]*var\(--transition-close\)/);
    expect(cssContent).toMatch(/\.custom-select-menu\s*\{[^}]*transition:[^}]*var\(--transition-close\)/);
    expect(cssContent).toMatch(/\.rating-badge\.rating-pop\s*\{[^}]*animation:\s*rating-pop\s+0\.35s\s+var\(--transition-bounce\);/);
    expect(cssContent).toMatch(/\.rating-badge\.rating-hide\s*\{[^}]*animation:\s*rating-hide\s+0\.28s\s+var\(--transition-fast\)\s+forwards;/);
    expect(cssContent).toMatch(/#viewer-flash-effect\s*\{[^}]*transition:[^}]*var\(--transition-glow\)/);
  });
});
