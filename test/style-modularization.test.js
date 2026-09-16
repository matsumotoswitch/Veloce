import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import { getFullCssContent } from './helpers/css-helper.js';

describe('style.css Modularization', () => {
  const srcDir = path.resolve(__dirname, '../src');
  const cssDir = path.join(srcDir, 'css');
  const styleCssPath = path.join(srcDir, 'style.css');
  const styleCssContent = fs.readFileSync(styleCssPath, 'utf-8');

  const EXPECTED_MODULES = [
    { name: 'variables.css', relPath: 'common/css/variables.css' },
    { name: 'base.css', relPath: 'common/css/base.css' },
    { name: 'layout.css', relPath: 'renderer/css/layout.css' },
    { name: 'components.css', relPath: 'renderer/css/components.css' },
    { name: 'dialogs.css', relPath: 'renderer/css/dialogs.css' },
    { name: 'thumbnail.css', relPath: 'renderer/css/thumbnail.css' },
    { name: 'inspector.css', relPath: 'renderer/css/inspector.css' },
    { name: 'viewer.css', relPath: 'viewer/viewer.css' }
  ];

  it('should import all 8 CSS modules in style.css', () => {
    for (const mod of EXPECTED_MODULES) {
      const importStatement = `@import './${mod.relPath}';`;
      expect(styleCssContent, `style.css must import ${mod.name}`).toContain(importStatement);
    }
  });

  it('should have all 8 sub-CSS files existing and non-empty in their domain subdirectories', () => {
    for (const mod of EXPECTED_MODULES) {
      const filePath = path.join(srcDir, mod.relPath);
      expect(fs.existsSync(filePath), `${mod.name} must exist in src/${mod.relPath}`).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content.trim().length, `${mod.name} must not be empty`).toBeGreaterThan(50);
    }
  });

  it('should successfully combine all submodules via getFullCssContent()', () => {
    const fullCss = getFullCssContent();
    expect(fullCss).toContain('--glow-gold:');
    expect(fullCss).toContain('::-webkit-scrollbar');
    expect(fullCss).toContain('.titlebar');
    expect(fullCss).toContain('.context-menu-item');
    expect(fullCss).toContain('.dialog-box');
    expect(fullCss).toContain('.thumbnail-item');
    expect(fullCss).toContain('#inspector-section');
    expect(fullCss).toContain('.viewer-body');
  });

  it('should not contain emojis in any sub-CSS files', () => {
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    for (const mod of EXPECTED_MODULES) {
      const filePath = path.join(srcDir, mod.relPath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(emojiRegex);
      expect(match, `Emoji detected in ${mod.name}: ${match ? match[0] : ''}`).toBeNull();
    }
  });

  it('should not have border-bottom on modal headers in any sub-CSS files', () => {
    const fullCss = getFullCssContent();
    const modalHeaderMatch = fullCss.match(/\.modal-header\s*\{[^}]*\}/g) || [];
    for (const block of modalHeaderMatch) {
      expect(block).not.toMatch(/border-bottom:\s*(?!none\b)[^;]+;/);
    }
  });

  it('should parse all sub-CSS files and combined CSS without syntax errors via postcss', () => {
    for (const mod of EXPECTED_MODULES) {
      const filePath = path.join(srcDir, mod.relPath);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(() => {
        postcss.parse(content, { from: filePath });
      }, `Syntax error detected in ${mod.name}`).not.toThrow();
    }

    const fullCss = getFullCssContent();
    expect(() => {
      postcss.parse(fullCss, { from: styleCssPath });
    }, 'Syntax error detected in full combined CSS').not.toThrow();
  });
});
