import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { UIManager } from '../src/renderer/renderer-ui.js';
import { appState } from '../src/renderer/renderer-state.js';

describe('Theme Mode (Light / Dark Theme Switching)', () => {
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

  describe('Titlebar DOM Layout Order', () => {
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

    it('should match index.html titlebar controls layout', () => {
      const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
      const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

      // titlebar-controls 内の順序が指定通りであることを検証
      const regex = /id="titlebar-tab-list"[\s\S]*?class="titlebar-divider"[\s\S]*?id="titlebar-theme-toggle"[\s\S]*?class="titlebar-divider"[\s\S]*?id="titlebar-minimize"/;
      expect(htmlContent).toMatch(regex);
    });
  });

  describe('UIManager.prototype.applyTheme', () => {
    it('should set data-theme="light" and update button icon to Moon in light mode', () => {
      const ui = new UIManager(appState);
      ui.applyTheme('light');

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(ui.state.theme).toBe('light');

      const btn = document.getElementById('titlebar-theme-toggle');
      expect(btn.querySelector('svg')).not.toBeNull();
      // 月アイコンのパスが存在すること
      expect(btn.querySelector('path[d*="M12 3a6 6 0 0 0 9 9"]')).not.toBeNull();
      expect(btn.hasAttribute('title')).toBe(false);
    });

    it('should remove data-theme attribute and update button icon to Sun in dark mode', () => {
      const ui = new UIManager(appState);
      // 先にライトモードにしてからダークモードへ
      ui.applyTheme('light');
      ui.applyTheme('dark');

      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
      expect(ui.state.theme).toBe('dark');

      const btn = document.getElementById('titlebar-theme-toggle');
      expect(btn.querySelector('svg')).not.toBeNull();
      // 太陽アイコンの円と光線パスが存在すること
      expect(btn.querySelector('circle[cx="12"]')).not.toBeNull();
      expect(btn.hasAttribute('title')).toBe(false);
    });

    it('should prevent duplicate tooltips by not setting native title attribute on applyTheme', () => {
      const ui = new UIManager(appState);
      const btn = document.getElementById('titlebar-theme-toggle');
      btn.setAttribute('title', 'Some native title');

      ui.applyTheme('light');
      expect(btn.hasAttribute('title')).toBe(false);

      ui.applyTheme('dark');
      expect(btn.hasAttribute('title')).toBe(false);
    });
  });

  describe('CSS Variables and Tokens for Light Mode', () => {
    it('should define complete :root[data-theme="light"] tokens in variables.css', () => {
      const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
      const cssContent = fs.readFileSync(variablesCssPath, 'utf-8');

      expect(cssContent).toContain(':root[data-theme="light"] {');
      expect(cssContent).toContain('--bg-color: #ffffff;');
      expect(cssContent).toContain('--panel-bg: #f0f7fa;');
      expect(cssContent).toContain('--top-bar-bg: #dfedf3;');
      expect(cssContent).toContain('--text-color: #153340;');
      expect(cssContent).toContain('--titlebar-bg: #f0f7fa;');
      expect(cssContent).toContain('--tab-inactive-bg: #f0f7fa;');
      expect(cssContent).toContain('--accent-color: #0284c7;');
      expect(cssContent).toContain('--folder-icon-color: #f59e0b;');
      expect(cssContent).toContain('--border-color: #8ba8b7;');
      expect(cssContent).toContain('--border-color-light: #7292a2;');
      expect(cssContent).toContain('--tab-active-bg: var(--top-bar-bg);');
      expect(cssContent).toContain('--tab-active-color: #153340;');
      expect(cssContent).toContain('--titlebar-divider-color: rgba(0, 0, 0, 0.25);');
    });

    it('should define folder icon tokens and class in variables.css', () => {
      const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
      const cssContent = fs.readFileSync(variablesCssPath, 'utf-8');

      expect(cssContent).toContain('--folder-icon-color: #f59e0b;');
      expect(cssContent).toContain('--drive-icon-color:');
      expect(cssContent).toContain('.icon-color-folder {');
    });

    it('should use --titlebar-divider-color in layout.css for titlebar divider', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toMatch(/\.titlebar-divider\s*\{[^}]*background-color:\s*var\(--titlebar-divider-color/);
      expect(cssContent).toMatch(/#titlebar-theme-toggle svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/);
    });

    it('should ensure #tab-bar right offset is at least 260px so new-tab-btn does not overlap titlebar-controls', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      const match = cssContent.match(/#tab-bar\s*\{[^}]*right:\s*(\d+)px;/);
      expect(match).not.toBeNull();
      const rightVal = parseInt(match[1], 10);
      expect(rightVal).toBeGreaterThanOrEqual(260);
    });

    it('should apply folder-icon-color to tree icons and preserve folder color on selection', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toContain('color: var(--folder-icon-color');
      // .tree-item.selected .tree-icon が白反転されていないこと
      expect(cssContent).not.toMatch(/\.tree-item\.selected\s+\.tree-icon[^{]*\{\s*color:\s*var\(--text-light\)/);
    });

    it('should define modern light theme selection styles in layout.css', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      // ディレクトリツリーの選択スタイル
      expect(cssContent).toContain(':root[data-theme="light"] #dir-tree .tree-item.selected');
      // スマートフォルダの選択スタイル
      expect(cssContent).toContain(':root[data-theme="light"] .smart-folder-item.selected');
      // ブックマークの選択スタイル
      expect(cssContent).toContain(':root[data-theme="light"] .bookmark-item.selected');
      // アクティブタブのスタイル
      expect(cssContent).toContain(':root[data-theme="light"] #tab-container .tab-item.active');
      // 検索バーのスタイル
      expect(cssContent).toContain(':root[data-theme="light"] #search-container');
    });

    it('should set #ffffff background for smart folders and directory tree interiors in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toContain(':root[data-theme="light"] #smart-folders-list');
      expect(cssContent).toContain(':root[data-theme="light"] #dir-tree');
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+#smart-folders-list[\s\S]*?background-color:\s*#ffffff;/);
    });

    it('should ensure pane headers and resizer dividers reference --panel-bg (#f1f5f9)', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const baseCssPath = path.resolve(__dirname, '../src/common/css/base.css');
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');

      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');
      const baseContent = fs.readFileSync(baseCssPath, 'utf-8');
      const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');

      expect(layoutContent).toContain('.pane-header {');
      expect(layoutContent).toMatch(/\.pane-header\s*\{[^}]*background:\s*var\(--panel-bg\);/);
      expect(baseContent).toMatch(/\.resizer\s*\{[^}]*background-color:\s*var\(--panel-bg\);/);
      expect(componentsContent).toMatch(/\.resizer-h\s*\{[^}]*background-color:\s*var\(--panel-bg\);/);
    });

    it('should ensure help overlay and dialog text colors use --text-color in light theme for readability', () => {
      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');

      expect(dialogsContent).toContain(':root[data-theme="light"] #help-overlay');
      expect(dialogsContent).toContain(':root[data-theme="light"] .help-table td');
      expect(dialogsContent).toContain(':root[data-theme="light"] kbd');
      expect(dialogsContent).toContain(':root[data-theme="light"] .dialog-btn');
    });

    it('should ensure license markdown blockquote background is transparent in light theme', () => {
      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');

      expect(dialogsContent).toContain(':root[data-theme="light"] .md-blockquote');
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.md-blockquote\s*\{[^}]*background:\s*transparent\s*!important;/);
    });

    it('should ensure dropdown boxes (.custom-select) have transparent background in light theme matching sort select', () => {
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
      const thumbnailCssPath = path.resolve(__dirname, '../src/renderer/css/thumbnail.css');

      const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');
      const thumbnailContent = fs.readFileSync(thumbnailCssPath, 'utf-8');

      // ソート順のドロップダウンが transparent であること
      expect(thumbnailContent).toMatch(/#thumbnail-controls\s+\.custom-select\s*\{[^}]*background-color:\s*transparent;/);
      // ライトモードで .custom-select 全般が transparent に統一されていること
      expect(componentsContent).toContain(':root[data-theme="light"] .custom-select');
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.custom-select\s*\{[^}]*background-color:\s*transparent;/);
    });
  });
});


