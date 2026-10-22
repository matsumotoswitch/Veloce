import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { UIManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';
import { applyViewerTheme } from '../src/viewer/viewer.js';

describe('Theme Architecture (Dual Theme: Dark & Light Mode Architecture)', () => {
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
          <div class="titlebar-button" id="titlebar-theme-toggle"></div>
          <div class="titlebar-divider"></div>
          <div class="titlebar-button" id="titlebar-minimize"></div>
          <div class="titlebar-button" id="titlebar-maximize"></div>
          <div class="titlebar-button titlebar-close" id="titlebar-close"></div>
        </div>
      </div>
    `;
  });

  describe('Titlebar DOM & Controls (UI Layout)', () => {
    it('should have controls in strict order: tab-list, divider, theme-toggle, divider, minimize, maximize, close', () => {
      const controls = document.querySelector('.titlebar-controls');
      expect(controls).not.toBeNull();
      const children = Array.from(controls.children);

      expect(children.length).toBe(7);
      expect(children[0].id).toBe('titlebar-tab-list');
      expect(children[1].classList.contains('titlebar-divider')).toBe(true);
      expect(children[2].id).toBe('titlebar-theme-toggle');
      expect(children[3].classList.contains('titlebar-divider')).toBe(true);
      expect(children[4].id).toBe('titlebar-minimize');
      expect(children[5].id).toBe('titlebar-maximize');
      expect(children[6].id).toBe('titlebar-close');
    });

    it('should match index.html titlebar controls layout with theme toggle button and dividers', () => {
      const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
      const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

      // titlebar-theme-toggle が存在すること
      expect(htmlContent).toContain('titlebar-theme-toggle');

      // titlebar-controls 内の順序が tab-list -> divider -> theme-toggle -> divider -> minimize -> maximize -> close であること
      const regex = /id="titlebar-tab-list"[\s\S]*?class="titlebar-divider"[\s\S]*?id="titlebar-theme-toggle"[\s\S]*?class="titlebar-divider"[\s\S]*?id="titlebar-minimize"[\s\S]*?id="titlebar-maximize"[\s\S]*?id="titlebar-close"/;
      expect(htmlContent).toMatch(regex);
    });
  });

  describe('UIManager Theme Handling (Dual Theme)', () => {
    it('should set data-theme="light" and update state when applyTheme("light") is called', () => {
      const ui = new UIManager(appState);
      ui.applyTheme('light');

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(ui.state.theme).toBe('light');
    });

    it('should remove data-theme and maintain dark mode when applyTheme("dark") is called', () => {
      const ui = new UIManager(appState);
      ui.applyTheme('light');
      ui.applyTheme('dark');

      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(ui.state.theme).toBe('dark');
    });

    it('should operate safely without throwing when theme toggle button is absent in DOM', () => {
      const ui = new UIManager(appState);
      expect(() => {
        ui.applyTheme('dark');
        ui.applyTheme('light');
        ui.applyTheme();
      }).not.toThrow();
    });
  });

  describe('Viewer Theme Handling (Independent Viewer Window)', () => {
    it('should toggle data-theme attribute on viewer window according to theme selection', () => {
      applyViewerTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');

      applyViewerTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    });
  });

  describe('CSS Theme Selectors & Tokens Integrity', () => {
    const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
    const variablesContent = fs.readFileSync(variablesCssPath, 'utf-8');
    const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
    const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

    it('should define light theme overrides block in variables.css with Win8.1 Chrome tokens', () => {
      expect(variablesContent).toContain(':root[data-theme="light"]');
      expect(variablesContent).toContain('--bg-color: #f3f8fb;');
      expect(variablesContent).toContain('--panel-bg: #e4eff6;');
      expect(variablesContent).toContain('--top-bar-bg: #ffffff;');
      expect(variablesContent).toContain('--bookmark-bar-bg: #ffffff;');
      expect(variablesContent).toContain('--tab-inactive-bg: #a8d8fc;');
      expect(variablesContent).toContain('--titlebar-bg: #b6e0fd;');
      expect(variablesContent).toContain('--text-color: #1e2930;');
      expect(variablesContent).toContain('--accent-color: #0288d1;');
    });

    it('should configure light theme pane hierarchy and unified header/resizer rules in layout.css', () => {
      expect(layoutContent).toContain(':root[data-theme="light"] .pane-header');
      expect(layoutContent).toContain(':root[data-theme="light"] #file-table th');
      expect(layoutContent).toContain(':root[data-theme="light"] #thumbnail-controls');
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer');
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer-h');
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer-toggle');
      expect(layoutContent).toContain(':root[data-theme="light"] #inspector-section');
      expect(layoutContent).toContain(':root[data-theme="light"] #tab-container .tab-item');
    });

    it('should configure light theme resizer and resizer-toggle hover/active highlight rules in layout.css', () => {
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer:hover');
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer-h:hover');
      expect(layoutContent).toContain(':root[data-theme="light"] .resizer-toggle:hover');
      expect(layoutContent).toContain('background: var(--accent-color) !important;');
      expect(layoutContent).toContain('color: var(--text-on-accent) !important;');
    });

    it('should define modern selection style rules (light tint background + crisp cyan indicator line) in layout.css', () => {
      expect(layoutContent).toContain(':root[data-theme="light"] #file-table tr.selected');
      expect(layoutContent).toContain(':root[data-theme="light"] #dir-tree .tree-item.selected');
      expect(layoutContent).toContain(':root[data-theme="light"] .smart-folder-item.selected');
      expect(layoutContent).toContain(':root[data-theme="light"] .bookmark-item.selected');
      expect(layoutContent).toContain(':root[data-theme="light"] #search-container');
      expect(layoutContent).toContain(':root[data-theme="light"] .custom-select');
      expect(layoutContent).toContain('#bookmark-bar');
    });

    it('should define titlebar-theme-toggle rules in layout.css for CSS-driven icon switching', () => {
      expect(layoutContent).toContain('#titlebar-theme-toggle');
      expect(layoutContent).toContain(':root[data-theme="light"] #titlebar-theme-toggle .theme-icon-to-light');
      expect(layoutContent).toContain(':root[data-theme="light"] #titlebar-theme-toggle .theme-icon-to-dark');
    });

    it('should configure Win8.1 Chrome styled tab-bar and bookmark-bar rules in layout.css', () => {
      expect(layoutContent).toContain(':root[data-theme="light"] #bookmark-bar');
      expect(layoutContent).toContain('background-color: var(--bookmark-bar-bg);');
      expect(layoutContent).toContain(':root[data-theme="light"] #tab-container .tab-item');
      expect(layoutContent).toContain('color: #000000 !important;');
      expect(layoutContent).toContain(':root[data-theme="light"] #tab-container .tab-item.active::after');
      expect(layoutContent).toContain(':root[data-theme="light"] .bookmark-item:hover:not(.selected)');
      expect(layoutContent).toContain('background-color: rgba(0, 0, 0, 0.06) !important;');
      expect(layoutContent).toContain(':root[data-theme="light"] .titlebar #new-tab-btn');
      expect(layoutContent).toContain('opacity: 1 !important;');
      expect(layoutContent).toContain('border-left: 1px solid rgba(0, 0, 0, 0.08) !important;');
      expect(variablesContent).toContain('--titlebar-divider-color: rgba(0, 0, 0, 0.25);');
    });

    it('should align light theme search-container and custom-select background (#f5f6f8) with matching radius', () => {
      const lightSearchMatch = layoutContent.match(/:root\[data-theme="light"\]\s+#search-container\s*\{([^}]+)\}/);
      expect(lightSearchMatch).not.toBeNull();
      expect(lightSearchMatch[1]).toContain('background: #f5f6f8;');
      expect(lightSearchMatch[1]).toContain('border-radius: var(--radius-sm);');
      expect(lightSearchMatch[1]).not.toContain('border-radius: 14px;');

      const lightSelectMatch = layoutContent.match(/:root\[data-theme="light"\]\s+\.custom-select\s*\{([^}]+)\}/);
      expect(lightSelectMatch).not.toBeNull();
      expect(lightSelectMatch[1]).toContain('background-color: #f5f6f8;');
    });
  });

  describe('Dark Mode Core Token Integrity (Non-Regression)', () => {
    const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
    const variablesContent = fs.readFileSync(variablesCssPath, 'utf-8');

    it('should define essential dark theme variables in :root', () => {
      expect(variablesContent).toContain('--bg-color: #080d0f;');
      expect(variablesContent).toContain('--panel-bg: #182529;');
      expect(variablesContent).toContain('--top-bar-bg: #22343a;');
      expect(variablesContent).toContain('--bookmark-bar-bg: var(--top-bar-bg);');
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
