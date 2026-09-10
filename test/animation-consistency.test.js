import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Animation and Transition Consistency', () => {
  const srcCssDir = path.resolve(__dirname, '../src/css');
  const fullCss = getFullCssContent();

  it('should define @keyframes menuFadeIn in components.css and not in viewer.css', () => {
    const componentsCss = fs.readFileSync(path.join(srcCssDir, 'components.css'), 'utf-8');
    const viewerCss = fs.readFileSync(path.join(srcCssDir, 'viewer.css'), 'utf-8');

    // components.css で定義され、サブメニュー表示アニメーションとして使用されていること
    expect(componentsCss).toContain('@keyframes menuFadeIn');
    expect(componentsCss).toMatch(/\.context-menu-item:hover\s*>\s*\.submenu\s*\{[^}]*animation:\s*menuFadeIn\s+0\.15s/);

    // viewer.css にはモジュール責務外の menuFadeIn が残存していないこと
    expect(viewerCss).not.toContain('@keyframes menuFadeIn');
  });

  it('should have completely removed unused @keyframes staggeredFadeIn from base.css and all CSS files', () => {
    const cssFiles = fs.readdirSync(srcCssDir).filter((f) => f.endsWith('.css'));
    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(srcCssDir, file), 'utf-8');
      expect(content, `staggeredFadeIn must not be defined in ${file}`).not.toContain('staggeredFadeIn');
    }
    expect(fullCss).not.toContain('staggeredFadeIn');
  });

  it('should unify titlebar button hover transition (0.15s ease) between main window and viewer window', () => {
    const layoutCss = fs.readFileSync(path.join(srcCssDir, 'layout.css'), 'utf-8');
    const viewerCss = fs.readFileSync(path.join(srcCssDir, 'viewer.css'), 'utf-8');

    // メイン画面タイトルバーボタン (.titlebar-button): 0.15s ease
    expect(layoutCss).toMatch(/\.titlebar-button\s*\{[^}]*transition:\s*background-color\s+0\.15s\s+ease,\s*color\s+0\.15s\s+ease;/);

    // ビューア画面コントロールボタン (.window-ctrl-btn): 0.15s ease
    expect(viewerCss).toMatch(/\.window-ctrl-btn\s*\{[^}]*transition:\s*background\s+0\.15s\s+ease,\s*background-color\s+0\.15s\s+ease,\s*color\s+0\.15s\s+ease;/);
  });
});
