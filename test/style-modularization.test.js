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
    'variables.css',
    'base.css',
    'layout.css',
    'components.css',
    'dialogs.css',
    'thumbnail.css',
    'inspector.css',
    'viewer.css'
  ];

  it('should import all 8 CSS modules in style.css', () => {
    for (const mod of EXPECTED_MODULES) {
      const importStatement = `@import './css/${mod}';`;
      expect(styleCssContent, `style.css must import ${mod}`).toContain(importStatement);
    }
  });

  it('should have all 8 sub-CSS files existing and non-empty in src/css/', () => {
    for (const mod of EXPECTED_MODULES) {
      const filePath = path.join(cssDir, mod);
      expect(fs.existsSync(filePath), `${mod} must exist in src/css/`).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content.trim().length, `${mod} must not be empty`).toBeGreaterThan(50);
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
      const filePath = path.join(cssDir, mod);
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(emojiRegex);
      expect(match, `Emoji detected in ${mod}: ${match ? match[0] : ''}`).toBeNull();
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
      const filePath = path.join(cssDir, mod);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(() => {
        postcss.parse(content, { from: filePath });
      }, `Syntax error detected in ${mod}`).not.toThrow();
    }

    const fullCss = getFullCssContent();
    expect(() => {
      postcss.parse(fullCss, { from: styleCssPath });
    }, 'Syntax error detected in full combined CSS').not.toThrow();
  });
});
