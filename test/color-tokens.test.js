import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Design Token and Color Consistency (AGENTS.md Sec 2)', () => {
  const cssContent = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf-8');

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

  it('should use classList.toggle for inspector search match in renderer.js instead of inline #ffcc00 styling', () => {
    const rendererJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');
    expect(rendererJs).toContain("tagEl.classList.toggle('search-match', isMatch);");
    expect(rendererJs).not.toContain("tagEl.style.color = '#ffcc00';");
    expect(rendererJs).not.toContain("tagEl.style.border = '1px solid #ffcc00';");
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
});
