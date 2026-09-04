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
});
