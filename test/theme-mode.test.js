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
      expect(cssContent).toContain('--panel-bg: #f8fbfc;');
      expect(cssContent).toContain('--top-bar-bg: #cbdee1;');
      expect(cssContent).toContain('--text-color: #0f262a;');
      expect(cssContent).toContain('--titlebar-bg: #ffffff;');
      expect(cssContent).toContain('--tab-inactive-bg: #e2eef0;');
      expect(cssContent).toContain('--accent-color: #08979c;');
      expect(cssContent).toContain('--folder-icon-color: #d97706;');
      expect(cssContent).toContain('--border-color: #94b3b8;');
      expect(cssContent).toContain('--border-color-light: #cbdee1;');
      expect(cssContent).toContain('--tab-active-bg: var(--top-bar-bg);');
      expect(cssContent).toContain('--tab-active-color: #0f262a;');
      expect(cssContent).toContain('--titlebar-divider-color: rgba(0, 0, 0, 0.25);');
    });

    it('should ensure smart-folder-count in light mode is clean unbordered text without background pill', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toContain(':root[data-theme="light"] .smart-folder-count');
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+\.smart-folder-count\s*\{[^}]*background-color:\s*transparent/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+\.smart-folder-count\s*\{[^}]*border:\s*none/);
    });

    it('should ensure active tab synchronizes background and bottom border with top-bar-bg in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+#tab-container\s+\.tab-item\.active\s*\{[^}]*background-color:\s*var\(--tab-active-bg,\s*var\(--top-bar-bg\)\)\s*!important;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+#tab-container\s+\.tab-item\.active\s*\{[^}]*border-bottom:\s*1px\s+solid\s+var\(--top-bar-bg\)\s*!important;/);
    });

    it('should ensure inactive tab hover background is intermediate cyan-slate #d7e6e8 between inactive #e2eef0 and active #cbdee1 in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+#tab-container\s+\.tab-item:not\(\.active\):hover\s*\{[^}]*background-color:\s*#d7e6e8\s*!important;/);
    });

    it('should ensure light theme component contrast (resizers matching pane header #e2eef0, custom-select, icon-btn:hover)', () => {
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
      const cssContent = fs.readFileSync(componentsCssPath, 'utf-8');

      expect(cssContent).toContain(':root[data-theme="light"] .custom-select');
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+\.custom-select\s*\{[^}]*background-color:\s*#ffffff;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+\.icon-btn:hover:not\(:disabled\)\s*\{[^}]*color:\s*#0f262a;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+\.resizer,\s*:root\[data-theme="light"\]\s+\.resizer-h\s*\{[^}]*background-color:\s*#e2eef0;/);
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

    it('should set var(--panel-bg) background for smart folders and directory tree interiors in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const cssContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(cssContent).toContain(':root[data-theme="light"] #smart-folders-list');
      expect(cssContent).toContain(':root[data-theme="light"] #dir-tree');
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s+#smart-folders-list[\s\S]*?background-color:\s*var\(--panel-bg\);/);
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

    it('should ensure dropdown boxes (.custom-select) have clear #ffffff background in light theme for visibility', () => {
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
      const thumbnailCssPath = path.resolve(__dirname, '../src/renderer/css/thumbnail.css');

      const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');
      const thumbnailContent = fs.readFileSync(thumbnailCssPath, 'utf-8');

      // ソート順の基底ドロップダウン定義が存在すること
      expect(thumbnailContent).toContain('#thumbnail-controls .custom-select');
      // ライトモードで .custom-select 全般が #ffffff で浮き彫りになること
      expect(componentsContent).toContain(':root[data-theme="light"] .custom-select');
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.custom-select\s*\{[^}]*background-color:\s*#ffffff;/);
    });

    it('should ensure all pane headers, file-table th, and thumbnail-controls unify to #e2eef0 in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(layoutContent).toContain(':root[data-theme="light"] .pane-header');
      expect(layoutContent).toContain(':root[data-theme="light"] #file-table th');
      expect(layoutContent).toContain(':root[data-theme="light"] #thumbnail-controls');
      expect(layoutContent).toContain(':root[data-theme="light"] #inspector-header');
      expect(layoutContent).toMatch(/:root\[data-theme="light"\]\s+\.pane-header[\s\S]*?background-color:\s*#e2eef0\s*!important;/);
    });

    it('should ensure #center-pane::before and #center-pane::after match #e2eef0 in light mode to eliminate bright scrollbar gutter spot', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(layoutContent).toContain(':root[data-theme="light"] #center-pane::before');
      expect(layoutContent).toContain(':root[data-theme="light"] #center-pane::after');
      expect(layoutContent).toMatch(/:root\[data-theme="light"\]\s+#center-pane::before,\s*:root\[data-theme="light"\]\s+#center-pane::after\s*\{[^}]*background:\s*#e2eef0\s*!important;/);
    });

    it('should define --viewer-bg and --viewer-bg-rgb in light mode tokens in variables.css', () => {
      const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
      const cssContent = fs.readFileSync(variablesCssPath, 'utf-8');

      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--viewer-bg:\s*#f8fbfc;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--viewer-bg-rgb:\s*248,\s*251,\s*252;/);
    });

    it('should ensure viewer metadata overlay and prompt-look match light theme styling with translucent parity', () => {
      const viewerCssPath = path.resolve(__dirname, '../src/viewer/viewer.css');
      const viewerContent = fs.readFileSync(viewerCssPath, 'utf-8');

      // 背景およびヘッダーがダークモードと同等の0.85不透明度であること
      expect(viewerContent).toContain(':root[data-theme="light"] .viewer-metadata-overlay');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-metadata-overlay\s*\{[^}]*background:\s*rgba\(var\(--bg-rgb\),\s*0\.85\);/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-metadata-header\s*\{[^}]*background:\s*rgba\(226,\s*238,\s*240,\s*0\.85\)\s*!important;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-metadata-title\s*\{[^}]*color:\s*#0f262a\s*!important;/);

      // プロンプトボックスが半透明（0.65）で背後を透過すること
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-metadata-overlay\s+\.prompt-look\s*\{[^}]*background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.65\)\s*!important;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-metadata-overlay\s+\.prompt-look\s+\.diff-tag\s*\{[^}]*background-color:\s*rgba\(238,\s*244,\s*245,\s*0\.85\);/);
    });

    it('should broadcast theme-changed event in renderer.js when theme is toggled', () => {
      const rendererPath = path.resolve(__dirname, '../src/renderer/renderer.js');
      const rendererContent = fs.readFileSync(rendererPath, 'utf-8');

      expect(rendererContent).toMatch(/window\.__TAURI__\.event\.emit\('theme-changed',\s*nextTheme\)/);
    });

    it('should set --text-light to #0f262a and define high-contrast palette colors in light mode tokens', () => {
      const variablesCssPath = path.resolve(__dirname, '../src/common/css/variables.css');
      const cssContent = fs.readFileSync(variablesCssPath, 'utf-8');

      // ライトモード時に --text-light が白ではなく黒（#0f262a）に設定されていること
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--text-light:\s*#0f262a;/);

      // ライトモード時にパレットカラー（デフォルトが黒、他色も高コントラスト）が定義されていること
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-default:\s*#0f262a;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-red:\s*#dc2626;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-blue:\s*#2563eb;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-green:\s*#16a34a;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-yellow:\s*#d97706;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-purple:\s*#9333ea;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-pink:\s*#db2777;/);
      expect(cssContent).toMatch(/:root\[data-theme="light"\]\s*\{[\s\S]*?--palette-cyan:\s*#08979c;/);
    });

    it('should ensure smart folder and bookmark icons use var(--palette-default) in light mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      expect(layoutContent).toContain(':root[data-theme="light"] .smart-folder-icon:not([class*="icon-color-"])');
      expect(layoutContent).toContain(':root[data-theme="light"] .bookmark-icon:not([class*="icon-color-"])');
      expect(layoutContent).toMatch(/:root\[data-theme="light"\]\s+\.smart-folder-icon:not\(\[class\*="icon-color-"\]\)[\s\S]*?color:\s*var\(--palette-default\);/);
    });

    it('should assign icon-color-${color} to smart folders in renderer.js', () => {
      const rendererPath = path.resolve(__dirname, '../src/renderer/renderer.js');
      const rendererContent = fs.readFileSync(rendererPath, 'utf-8');

      // smart-folder-icon にタイポなく icon-color-${...} が付与されること
      expect(rendererContent).toContain('iconSpan.className = `smart-folder-icon icon-color-${f.color || \'default\'}`;');
      expect(rendererContent).not.toMatch(/smart-folder-icon color-\$/);
    });

    it('should assign icon-color-${color} or bookmark-icon-fav to bookmarks in renderer-bookmarks.js', () => {
      const bookmarksPath = path.resolve(__dirname, '../src/renderer/renderer-bookmarks.js');
      const bookmarksContent = fs.readFileSync(bookmarksPath, 'utf-8');

      expect(bookmarksContent).toContain('icon.classList.add(\'bookmark-icon-fav\');');
      expect(bookmarksContent).toContain('icon.classList.add(`icon-color-${fav.color}`);');
      expect(bookmarksContent).toContain('icon.classList.add(`icon-color-${fav.color || \'default\'}`);');
    });

    it('should preserve custom palette color on bookmark icons and not override svg in layout.css', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      // .bookmark-item svg に直接 color を当てて子要素の色を上書きしていないこと
      expect(layoutContent).not.toMatch(/:root\[data-theme="light"\]\s+\.bookmark-item\s+svg/);
    });

    it('should bind color-btn styles in dialogs.css to palette variables in light mode', () => {
      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');

      expect(dialogsContent).toContain(':root[data-theme="light"] .color-btn[data-color="default"]');
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.color-btn\[data-color="default"\]\s*\{[^}]*background-color:\s*var\(--palette-default\)\s*!important;/);
    });

    it('should style thumbnail-label and rating-badge with white background and text-shadow none in light mode', () => {
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
      const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');

      expect(componentsContent).toContain(':root[data-theme="light"] .thumbnail-label');
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.thumbnail-label\s*\{[^}]*background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.85\);/);
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.thumbnail-item:hover\s+\.thumbnail-label\s*\{[^}]*background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.95\);/);
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.thumbnail-label\s*\{[^}]*text-shadow:\s*none;/);

      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');

      expect(dialogsContent).toContain(':root[data-theme="light"] .rating-badge');
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.rating-badge\s*\{[^}]*background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.85\);/);
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.thumbnail-item:hover\s+\.rating-badge\s*\{[^}]*background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.95\);/);
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.rating-badge\s*\{[^}]*text-shadow:\s*none;/);
    });

    it('should ensure dialog-input in light mode has pure white background and uses --input-bg', () => {
      const componentsCssPath = path.resolve(__dirname, '../src/renderer/css/components.css');
      const componentsContent = fs.readFileSync(componentsCssPath, 'utf-8');

      // ベースルールで --input-bg が使用されていること
      expect(componentsContent).toMatch(/\.dialog-input\s*\{[\s\S]*?background-color:\s*var\(--input-bg/);

      // ライトモード時に純白 #ffffff が適用されること
      expect(componentsContent).toContain(':root[data-theme="light"] .dialog-input');
      expect(componentsContent).toMatch(/:root\[data-theme="light"\]\s+\.dialog-input\s*\{[^}]*background-color:\s*#ffffff\s*!important;/);
    });

    it('should ensure dialog-btn.primary and dialog-btn.danger have explicit visible backgrounds in light mode', () => {
      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');

      expect(dialogsContent).toContain(':root[data-theme="light"] .dialog-btn.primary');
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.dialog-btn\.primary\s*\{[^}]*background-color:\s*var\(--accent-color\);/);
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.dialog-btn\.primary:hover:not\(:disabled\)\s*\{[^}]*background-color:\s*var\(--accent-hover\);/);

      expect(dialogsContent).toContain(':root[data-theme="light"] .dialog-btn.danger');
      expect(dialogsContent).toMatch(/:root\[data-theme="light"\]\s+\.dialog-btn\.danger\s*\{[^}]*background-color:\s*var\(--danger-red\);/);
    });

    it('should ensure viewer titlebar has white gradient background and dark text with white shadow in light mode', () => {
      const viewerCssPath = path.resolve(__dirname, '../src/viewer/viewer.css');
      const viewerContent = fs.readFileSync(viewerCssPath, 'utf-8');

      // タイトルバーの白グラデーション背景（画像がしっかり透けて見える半透明グラデーション）
      expect(viewerContent).toContain(':root[data-theme="light"] .viewer-body #window-controls.has-gradient');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-body\s+#window-controls\.has-gradient\s*\{[^}]*background:\s*linear-gradient\(to bottom,\s*rgba\(255,\s*255,\s*255,\s*0\.65\)\s*0%,\s*rgba\(255,\s*255,\s*255,\s*0\.35\)\s*60%/);

      // メタデータ展開時の白グラデーション背景
      expect(viewerContent).toContain(':root[data-theme="light"] .viewer-body.metadata-open #window-controls.has-gradient');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-body\.metadata-open\s+#window-controls\.has-gradient[^{]*\{[^}]*background:\s*linear-gradient\(to bottom,\s*rgba\(255,\s*255,\s*255,\s*0\.70\)\s*0%,\s*rgba\(255,\s*255,\s*255,\s*0\.40\)\s*60%/);

      // ファイル名・レーティング・拡大率の黒文字と白シャドウ
      expect(viewerContent).toContain(':root[data-theme="light"] .window-filename');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-filename\s*\{[^}]*color:\s*#0f262a;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-filename\s*\{[^}]*text-shadow:[^}]*rgba\(255,\s*255,\s*255/);

      expect(viewerContent).toContain(':root[data-theme="light"] .viewer-rating-display');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-rating-display\s*\{[^}]*color:\s*#0f262a;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.viewer-rating-display\s*\{[^}]*text-shadow:[^}]*rgba\(255,\s*255,\s*255/);

      expect(viewerContent).toContain(':root[data-theme="light"] .window-scale-display');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-scale-display\s*\{[^}]*color:\s*#0f262a;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-scale-display\s*\{[^}]*text-shadow:[^}]*rgba\(255,\s*255,\s*255/);

      // コントロールボタンのダークカラーと白シャドウ
      expect(viewerContent).toContain(':root[data-theme="light"] .window-ctrl-btn');
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-ctrl-btn\s*\{[^}]*color:\s*#334549;/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-ctrl-btn\s+svg\s*\{[^}]*drop-shadow\([^)]*rgba\(255,\s*255,\s*255/);
      expect(viewerContent).toMatch(/:root\[data-theme="light"\]\s+\.window-ctrl-btn\.window-ctrl-btn--close:hover\s*\{[^}]*background-color:\s*var\(--danger-red\);/);
    });

    it('should ensure diff-tag does not have custom font-weight in light mode to maintain identical wrapping with dark mode', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const dialogsCssPath = path.resolve(__dirname, '../src/renderer/css/dialogs.css');
      const viewerCssPath = path.resolve(__dirname, '../src/viewer/viewer.css');

      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');
      const dialogsContent = fs.readFileSync(dialogsCssPath, 'utf-8');
      const viewerContent = fs.readFileSync(viewerCssPath, 'utf-8');

      // #right-pane .prompt-look .diff-tag が font-weight を上書きせず通常ウェイトを維持すること
      const layoutMatch = layoutContent.match(/:root\[data-theme="light"\]\s+#right-pane\s+\.prompt-look\s+\.diff-tag\s*\{([^}]+)\}/);
      expect(layoutMatch).not.toBeNull();
      expect(layoutMatch[1]).not.toContain('font-weight');

      // dialogs.css の light theme diff-tag も font-weight を上書きしないこと
      const dialogsMatch = dialogsContent.match(/:root\[data-theme="light"\]\s+\.diff-tag\.common\s*\{([^}]+)\}/);
      expect(dialogsMatch).not.toBeNull();
      expect(dialogsMatch[1]).not.toContain('font-weight');

      // viewer.css の light theme diff-tag も font-weight を上書きしないこと
      const viewerMatch = viewerContent.match(/:root\[data-theme="light"]\s+\.viewer-metadata-overlay\s+\.prompt-look\s+\.diff-tag\s*\{([^}]+)\}/);
      expect(viewerMatch).not.toBeNull();
      expect(viewerMatch[1]).not.toContain('font-weight');
    });

    it('should ensure inspector-header-layout has no left border in light mode to match dark mode continuity', () => {
      const layoutCssPath = path.resolve(__dirname, '../src/renderer/css/layout.css');
      const layoutContent = fs.readFileSync(layoutCssPath, 'utf-8');

      const match = layoutContent.match(/:root\[data-theme="light"]\s+\.inspector-header-layout\s*\{([^}]+)\}/);
      expect(match).not.toBeNull();
      expect(match[1]).toMatch(/border-left:\s*none\s*!important;/);
    });
  });
});




