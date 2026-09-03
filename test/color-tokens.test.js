import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Design Token and Color Consistency', () => {
  const cssContent = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf-8');

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
});
