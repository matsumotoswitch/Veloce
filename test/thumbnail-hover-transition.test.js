import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Thumbnail Hover Transition Improvements (TODO.md 視覚的改善)', () => {
  const cssPath = path.resolve(__dirname, '../src/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  it('.thumbnail-item に will-change: transform とスムーズなトランジションが設定されていること', () => {
    // .thumbnail-item ブロックの抽出
    const itemMatch = cssContent.match(/\.thumbnail-item\s*\{([^}]+)\}/);
    expect(itemMatch).not.toBeNull();
    const itemBody = itemMatch[1];

    expect(itemBody).toContain('will-change: transform');
    expect(itemBody).toMatch(/transition:\s*transform\s+0\.15s\s+var\(--transition-smooth\)/);
  });

  it('.thumbnail-item:hover に scale(1.03) と控えめなアクセント発光が適用されていること', () => {
    const hoverMatch = cssContent.match(/\.thumbnail-item:hover\s*\{([^}]+)\}/);
    expect(hoverMatch).not.toBeNull();
    const hoverBody = hoverMatch[1];

    expect(hoverBody).toContain('scale(1.03)');
    expect(hoverBody).toContain('border-color: var(--accent-hover)');
    expect(hoverBody).toMatch(/box-shadow:[^;]*rgba\(var\(--accent-rgb\),\s*0\.35\)/);

    // Reflow を誘発するジオメトリプロパティ（translateY, margin, top, left, width, height）が含まれていないこと
    expect(hoverBody).not.toContain('translateY');
    expect(hoverBody).not.toMatch(/\b(top|left|margin|width|height)\s*:/);
  });

  it('.thumbnail-item.selected:hover にも scale(1.03) と調和した発光が適用されていること', () => {
    const selectedHoverMatch = cssContent.match(/\.thumbnail-item\.selected:hover\s*\{([^}]+)\}/);
    expect(selectedHoverMatch).not.toBeNull();
    const selectedHoverBody = selectedHoverMatch[1];

    expect(selectedHoverBody).toContain('scale(1.03)');
    expect(selectedHoverBody).toContain('var(--accent-hover)');
    expect(selectedHoverBody).toMatch(/box-shadow:[^;]*rgba\(var\(--accent-rgb\),\s*0\.45\)/);
  });
});
