import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { UIManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';
import { applyViewerTheme } from '../src/viewer/viewer.js';

describe('Theme Architecture (Deprecation of Light Mode & Dark Theme Single Architecture)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = `
      <div data-tauri-drag-region class="titlebar">
        <div id="tab-bar">
          <div id="tab-container"></div>
          <div id="new-tab-btn" class="new-tab-btn"></div>
        </div>
        <div class="titlebar-controls">
          <div class="titlebar-button" id="titlebar-tab-list"></div>
          <div class="titlebar-divider"></div>
          <div class="titlebar-button" id="titlebar-minimize"></div>
          <div class="titlebar-button" id="titlebar-maximize"></div>
          <div class="titlebar-button titlebar-close" id="titlebar-close"></div>
        </div>
      </div>
    `;
  });

  describe('Titlebar DOM & Controls (UI Simplification)', () => {
    it('should have controls in strict order without theme toggle: tab-list, divider, minimize, maximize, close', () => {
      const controls = document.querySelector('.titlebar-controls');
      expect(controls).not.toBeNull();
      const children = Array.from(controls.children);

      expect(children.length).toBe(5);
      expect(children[0].id).toBe('titlebar-tab-list');
      expect(children[1].classList.contains('titlebar-divider')).toBe(true);
      expect(children[2].id).toBe('titlebar-minimize');
      expect(children[3].id).toBe('titlebar-maximize');
      expect(children[4].id).toBe('titlebar-close');
    });

    it('should match index.html titlebar controls layout without theme toggle button', () => {
      const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
      const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

      // titlebar-theme-toggle が存在しないこと
      expect(htmlContent).not.toContain('titlebar-theme-toggle');

      // titlebar-controls 内の順序が tab-list -> divider -> minimize -> maximize -> close であること
      const regex = /id="titlebar-tab-list"[\s\S]*?class="titlebar-divider"[\s\S]*?id="titlebar-minimize"[\s\S]*?id="titlebar-maximize"[\s\S]*?id="titlebar-close"/;
      expect(htmlContent).toMatch(regex);
    });
  });

  describe('UIManager Theme Handling (Dark Mode Single Architecture)', () => {
    it('should maintain dark mode without data-theme attribute when applyTheme is called', () => {
      const ui = new UIManager(appState);
      ui.applyTheme('dark');

      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(ui.state.theme).toBe('dark');
    });

    it('should safely fall back to dark mode even if light theme is requested', () => {
      const ui = new UIManager(appState);
      ui.applyTheme('light');

      // ライトモード廃止により、data-theme 属性は設定されず常にダークモードを維持
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(ui.state.theme).toBe('dark');
    });

    it('should operate safely without throwing when theme toggle button is absent in DOM', () => {
      const ui = new UIManager(appState);
      expect(() => {
        ui.applyTheme('dark');
        ui.applyTheme();
      }).not.toThrow();
    });
  });

  describe('Viewer Theme Handling (Independent Viewer Window)', () => {
    it('should maintain dark mode without data-theme attribute on viewer window', () => {
      applyViewerTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();

      applyViewerTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    });
  });

  describe('Complete Absence of Light Mode Selectors in CSS (Regression Prevention)', () => {
    const cssFiles = [
      '../src/common/css/variables.css',
      '../src/renderer/css/layout.css',
      '../src/renderer/css/components.css',
      '../src/renderer/css/dialogs.css',
      '../src/renderer/css/inspector.css',
      '../src/viewer/viewer.css'
    ];

    it.each(cssFiles)('should not contain any [data-theme="light"] rules in %s', (relPath) => {
      const filePath = path.resolve(__dirname, relPath);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).not.toContain('data-theme="light"');
      expect(content).not.toContain("data-theme='light'");
      expect(content).not.toContain(':root[data-theme="light"]');
    });

    it('should not contain #titlebar-theme-toggle rule in layout.css', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');
      expect(layoutContent).not.toContain('#titlebar-theme-toggle');
    });
  });

  describe('Dark Mode Core Token Integrity', () => {
    const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
    const variablesContent = fs.readFileSync(variablesCssPath, 'utf-8');

    it('should define essential dark theme variables in :root', () => {
      expect(variablesContent).toContain('--bg-color: #080d0f;');
      expect(variablesContent).toContain('--panel-bg: #182529;');
      expect(variablesContent).toContain('--top-bar-bg: #22343a;');
      expect(variablesContent).toContain('--text-color: #cddbe0;');
      expect(variablesContent).toContain('--prompt-bg: #000000;');
      expect(variablesContent).toContain('--border-color: #3b5057;');
      expect(variablesContent).toContain('--accent-color: #257e8c;');
      expect(variablesContent).toContain('--accent-rgb: 37, 126, 140;');
    });

    it('should define 4-step translucent accent tint tokens for unified interaction', () => {
      expect(variablesContent).toMatch(/--accent-subtle:\s*rgba\(var\(--accent-rgb\),\s*0\.12\);/);
      expect(variablesContent).toMatch(/--accent-hover-tint:\s*rgba\(var\(--accent-rgb\),\s*0\.25\);/);
      expect(variablesContent).toMatch(/--accent-active-tint:\s*rgba\(var\(--accent-rgb\),\s*0\.40\);/);
      expect(variablesContent).toMatch(/--accent-focus-ring:\s*rgba\(var\(--accent-rgb\),\s*0\.60\);/);
    });

    it('should define dialog and modal background tokens matching top-bar-bg and panel-bg hierarchy', () => {
      expect(variablesContent).toMatch(/--dialog-bg:\s*#22343a;/);
      expect(variablesContent).toMatch(/--modal-bg:\s*#22343a;/);
      expect(variablesContent).toMatch(/--input-bg:\s*#182529;/);
    });
  });

  describe('Bookmark Bar Height and Pane Position Consistency', () => {
    it('should have strictly synchronized height (28px) and border-box sizing', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      // #bookmark-bar
      const baseBookmarkMatch = layoutContent.match(/(?:^|\n)#bookmark-bar\s*\{([^}]+)\}/);
      expect(baseBookmarkMatch).not.toBeNull();
      const baseRules = baseBookmarkMatch[1];
      expect(baseRules).toMatch(/height:\s*28px;/);
      expect(baseRules).toMatch(/min-height:\s*28px;/);
      expect(baseRules).toMatch(/max-height:\s*28px;/);
      expect(baseRules).toMatch(/box-sizing:\s*border-box;/);
      expect(baseRules).toMatch(/overflow:\s*hidden;/);

      // .bookmark-item のサイズ制限（親バーを押し広げない定義）
      const itemMatch = layoutContent.match(/(?:^|\n)\.bookmark-item\s*\{([^}]+)\}/);
      expect(itemMatch).not.toBeNull();
      const itemRules = itemMatch[1];
      expect(itemRules).toMatch(/height:\s*22px;/);
      expect(itemRules).toMatch(/max-height:\s*22px;/);
      expect(itemRules).toMatch(/box-sizing:\s*border-box;/);
    });
  });

  describe('Visual Style Unification across Components', () => {
    const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
    const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');
    const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
    const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');

    it('should have plain text smart-folder-count without pill background or padding', () => {
      const baseCountMatch = layoutContent.match(/(?:^|\n)\.smart-folder-count\s*\{([^}]+)\}/);
      expect(baseCountMatch).not.toBeNull();
      expect(baseCountMatch[1]).toMatch(/background:\s*transparent;/);
      expect(baseCountMatch[1]).toMatch(/padding:\s*0;/);
      expect(baseCountMatch[1]).toMatch(/border-radius:\s*0;/);
    });

    it('should not have left accent bar (box-shadow) on #file-table tr.selected', () => {
      const darkRowMatch = layoutContent.match(/(?:^|\n)#file-table\s+tr\.selected\s*\{([^}]+)\}/);
      expect(darkRowMatch).not.toBeNull();
      expect(darkRowMatch[1]).not.toContain('box-shadow');
    });

    it('should eliminate vertical borders on #file-table th and td', () => {
      const baseCellsMatch = layoutContent.match(/(?:^|\n)#file-table\s+th,\s*[\r\n]+#file-table\s+td\s*\{([^}]+)\}/);
      expect(baseCellsMatch).not.toBeNull();
      expect(baseCellsMatch[1]).toMatch(/border-right:\s*none;/);
    });

    it('should maintain natural transparent placement for thumbnail items without cards or borders', () => {
      const thumbMatch = componentsContent.match(/(?:^|\n)\.thumbnail-item\s*\{([^}]+)\}/);
      expect(thumbMatch).not.toBeNull();
      expect(thumbMatch[1]).not.toContain('box-shadow: 0 1px 3px');
      expect(thumbMatch[1]).not.toContain('background-color: #');
    });

    it('should set var(--panel-bg) background for search-container and custom-select', () => {
      const searchMatch = layoutContent.match(/(?:^|\n)#search-container\s*\{([^}]+)\}/);
      expect(searchMatch).not.toBeNull();
      expect(searchMatch[1]).toMatch(/background:\s*var\(--panel-bg\);/);

      const selectMatch = componentsContent.match(/(?:^|\n)\.custom-select\s*\{([^}]+)\}/);
      expect(selectMatch).not.toBeNull();
      expect(selectMatch[1]).toMatch(/background-color:\s*var\(--panel-bg\);/);
    });
  });
});
