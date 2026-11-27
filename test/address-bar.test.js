import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  parsePathToSegments,
  isAddressBarEditable,
  normalizeAddressBarInput,
  resolveAddressBarTarget,
  buildSiblingMenuModel,
  initAddressBar,
  renderAddressBar,
  enterAddressBarEditMode,
  exitAddressBarEditMode,
  isAddressBarEditing,
  openChevronMenu,
  closeAddressBarMenu,
  isAddressBarMenuOpen
} from '../src/renderer/renderer-address-bar.js';
import { syncFolderRenameInRendererState } from '../src/renderer/renderer-file-ops.js';

function createAddressBarDom() {
  document.body.innerHTML = `
    <div id="toolbar" class="toolbar">
      <div id="address-bar" class="address-bar">
        <div id="address-bar-breadcrumbs" class="address-bar-breadcrumbs"></div>
        <input type="text" id="address-bar-input" class="address-bar-input" spellcheck="false" autocomplete="off" aria-label="フォルダパス">
      </div>
      <div id="search-container">
        <input type="text" id="search-bar" placeholder="検索（ファイル名・プロンプト等）" spellcheck="false">
      </div>
    </div>
    <div id="toast-container"></div>
  `;
}

describe('Address Bar & Search Box Split (v1.20.0)', () => {
  describe('Step 1: parsePathToSegments (Pure Function)', () => {
    it('splits standard Windows drive paths with cumulative paths', () => {
      const segs = parsePathToSegments('C:\\a\\b');
      expect(segs).toEqual([
        { label: 'C:', path: 'C:\\', isVirtual: false, isRoot: true },
        { label: 'a', path: 'C:\\a', isVirtual: false, isRoot: false },
        { label: 'b', path: 'C:\\a\\b', isVirtual: false, isRoot: false }
      ]);
    });

    it('handles drive root with or without trailing backslash', () => {
      expect(parsePathToSegments('C:\\')).toEqual([
        { label: 'C:', path: 'C:\\', isVirtual: false, isRoot: true }
      ]);
      expect(parsePathToSegments('C:')).toEqual([
        { label: 'C:', path: 'C:\\', isVirtual: false, isRoot: true }
      ]);
      expect(parsePathToSegments('D:/')).toEqual([
        { label: 'D:', path: 'D:\\', isVirtual: false, isRoot: true }
      ]);
    });

    it('ignores trailing backslashes on subdirectories', () => {
      const segs = parsePathToSegments('C:\\Users\\Photos\\\\');
      expect(segs).toEqual([
        { label: 'C:', path: 'C:\\', isVirtual: false, isRoot: true },
        { label: 'Users', path: 'C:\\Users', isVirtual: false, isRoot: false },
        { label: 'Photos', path: 'C:\\Users\\Photos', isVirtual: false, isRoot: false }
      ]);
    });

    it('splits UNC paths keeping \\\\server\\share as root segment', () => {
      const segs = parsePathToSegments('\\\\server\\share\\a\\b\\');
      expect(segs).toEqual([
        { label: '\\\\server\\share', path: '\\\\server\\share', isVirtual: false, isRoot: true },
        { label: 'a', path: '\\\\server\\share\\a', isVirtual: false, isRoot: false },
        { label: 'b', path: '\\\\server\\share\\a\\b', isVirtual: false, isRoot: false }
      ]);

      expect(parsePathToSegments('\\\\server\\share\\')).toEqual([
        { label: '\\\\server\\share', path: '\\\\server\\share', isVirtual: false, isRoot: true }
      ]);
    });

    it('handles deep hierarchies and Japanese folder names accurately', () => {
      const deepPath = 'E:\\イラスト\\作品集\\2026年\\キャラクター設定\\ラフ案\\最終版';
      const segs = parsePathToSegments(deepPath);
      expect(segs.map(s => s.label)).toEqual([
        'E:', 'イラスト', '作品集', '2026年', 'キャラクター設定', 'ラフ案', '最終版'
      ]);
      expect(segs[0].path).toBe('E:\\');
      expect(segs[3].path).toBe('E:\\イラスト\\作品集\\2026年');
      expect(segs[segs.length - 1].path).toBe(deepPath);
    });

    it('treats smart://<id> and PC as single virtual segments', () => {
      const smartFolders = [
        { id: 'fav_5', name: 'お気に入り (星5)' },
        { id: 'recent', name: '最近生成した画像' }
      ];

      expect(parsePathToSegments('smart://fav_5', { smartFolders })).toEqual([
        { label: 'お気に入り (星5)', path: 'smart://fav_5', isVirtual: true, isRoot: true }
      ]);

      expect(parsePathToSegments('smart://unknown_id', { smartFolders })).toEqual([
        { label: 'スマートフォルダ', path: 'smart://unknown_id', isVirtual: true, isRoot: true }
      ]);

      expect(parsePathToSegments('PC')).toEqual([
        { label: 'PC', path: 'PC', isVirtual: true, isRoot: true }
      ]);
    });

    it('returns empty array for empty or non-string input', () => {
      expect(parsePathToSegments('')).toEqual([]);
      expect(parsePathToSegments('   ')).toEqual([]);
      expect(parsePathToSegments(null)).toEqual([]);
      expect(parsePathToSegments(undefined)).toEqual([]);
    });
  });

  describe('Step 1: Layout HTML/CSS & Breadcrumb DOM Interaction', () => {
    let refreshFileListMock;
    let expandTreeToPathMock;
    let saveTabsStateMock;
    let showNotificationMock;

    beforeEach(() => {
      createAddressBarDom();
      refreshFileListMock = vi.fn().mockResolvedValue(undefined);
      expandTreeToPathMock = vi.fn().mockResolvedValue(undefined);
      saveTabsStateMock = vi.fn();
      showNotificationMock = vi.fn();

      appState.tabs = [
        { id: 't1', path: 'C:\\Users\\Photos\\2026', name: '2026', history: ['C:\\Users\\Photos\\2026'], historyIndex: 0 }
      ];
      appState.activeTabIndex = 0;
      appState.currentDirectory = 'C:\\Users\\Photos\\2026';
      appState.smartFolders = [{ id: 'fav_5', name: '星5お気に入り' }];
      appState.selection = new Set();
      appState.selectedIndex = -1;

      uiManager.renderTabs = vi.fn();
      uiManager.updateSelectionUI = vi.fn();
      uiManager.showCustomTooltip = vi.fn();
      uiManager.hideCustomTooltip = vi.fn();

      initAddressBar({
        refreshFileList: refreshFileListMock,
        expandTreeToPath: expandTreeToPathMock,
        saveTabsState: saveTabsStateMock,
        getTabNameForPath: (p) => p.split('\\').pop() || p,
        showNotification: showNotificationMock
      });
    });

    afterEach(() => {
      closeAddressBarMenu();
      exitAddressBarEditMode();
      vi.clearAllMocks();
    });

    it('places #address-bar before #search-container in index.html with shortened placeholder and fixed 260px search box in layout.css', () => {
      const indexHtml = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf-8');
      const layoutCss = fs.readFileSync(path.resolve(__dirname, '../src/renderer/css/layout.css'), 'utf-8');

      const reloadIdx = indexHtml.indexOf('id="nav-reload-btn"');
      const addrIdx = indexHtml.indexOf('id="address-bar"');
      const searchIdx = indexHtml.indexOf('id="search-container"');
      expect(reloadIdx).toBeGreaterThan(-1);
      expect(addrIdx).toBeGreaterThan(reloadIdx);
      expect(searchIdx).toBeGreaterThan(addrIdx);
      // 再読み込みボタンの右には区切り線を置かず、アドレスバーと検索ボックスの間に区切り線を配置する
      expect(indexHtml.slice(reloadIdx, addrIdx)).not.toContain('control-divider');
      expect(indexHtml.slice(addrIdx, searchIdx)).toContain('class="control-divider"');
      expect(indexHtml).toContain('placeholder="検索（ファイル名・プロンプト等）"');

      expect(layoutCss).toMatch(/\.toolbar\s*\{[^}]*height:\s*40px;/);
      expect(layoutCss).toMatch(/\.toolbar\s+#address-bar\s*\{[^}]*flex:\s*1;/);
      expect(layoutCss).toMatch(/\.toolbar\s+#search-container\s*\{[^}]*flex:\s*0 0 260px;/);
      expect(layoutCss).toMatch(/\.address-bar-segment-label\s*\{[^}]*text-overflow:\s*ellipsis;/);
      // 検索ボックス・レーティングフィルタ・クリアボタン間の隙間を 4px に統一する
      const searchGroupMatch = layoutCss.match(/\.search-controls-group\s*\{([^}]+)\}/);
      expect(searchGroupMatch).not.toBeNull();
      expect(searchGroupMatch[1]).toMatch(/gap:\s*4px;/);
      const ratingWrapperMatch = layoutCss.match(/\.rating-filter-wrapper\s*\{([^}]+)\}/);
      expect(ratingWrapperMatch).not.toBeNull();
      expect(ratingWrapperMatch[1]).not.toContain('margin-left');
      expect(ratingWrapperMatch[1]).toMatch(/gap:\s*4px;/);
    });

    it('renders breadcrumb segments and navigates when a segment is clicked', async () => {
      renderAddressBar();

      const segments = document.querySelectorAll('.address-bar-segment');
      const chevrons = document.querySelectorAll('.address-bar-chevron');
      expect(Array.from(segments).map(el => el.textContent)).toEqual(['C:', 'Users', 'Photos', '2026']);
      expect(chevrons.length).toBe(3);
      expect(segments[1].dataset.path).toBe('C:\\Users');
      expect(segments[1].dataset.tooltip).toBe('C:\\Users');

      segments[1].click();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(appState.currentDirectory).toBe('C:\\Users');
      expect(appState.tabs[0].path).toBe('C:\\Users');
      expect(refreshFileListMock).toHaveBeenCalledWith(true);
      expect(expandTreeToPathMock).toHaveBeenCalledWith('C:\\Users');
    });

    it('renders a single chevron for drive root C:\\ pointing to C:\\ subfolders', () => {
      appState.currentDirectory = 'C:\\';
      renderAddressBar();

      const segments = document.querySelectorAll('.address-bar-segment');
      const chevrons = document.querySelectorAll('.address-bar-chevron');
      expect(segments.length).toBe(1);
      expect(segments[0].textContent).toBe('C:');
      expect(chevrons.length).toBe(1);
      expect(chevrons[0].dataset.parentPath).toBe('C:\\');
    });

    it('renders single virtual segment without chevrons for smart:// and PC and marks bar readonly', () => {
      appState.currentDirectory = 'smart://fav_5';
      renderAddressBar();

      const bar = document.getElementById('address-bar');
      expect(bar.classList.contains('readonly')).toBe(true);
      expect(document.querySelectorAll('.address-bar-segment').length).toBe(1);
      expect(document.querySelector('.address-bar-segment').textContent).toBe('星5お気に入り');
      expect(document.querySelectorAll('.address-bar-chevron').length).toBe(0);

      appState.currentDirectory = 'PC';
      renderAddressBar();
      expect(bar.classList.contains('readonly')).toBe(true);
      expect(document.querySelectorAll('.address-bar-segment').length).toBe(1);
      expect(document.querySelector('.address-bar-segment').textContent).toBe('PC');
      expect(document.querySelectorAll('.address-bar-chevron').length).toBe(0);
    });

    it('updates breadcrumbs when current directory is renamed via syncFolderRenameInRendererState', () => {
      appState.currentDirectory = 'C:\\Users\\OldFolder\\Sub';
      appState.tabs[0].path = 'C:\\Users\\OldFolder\\Sub';
      renderAddressBar();
      expect(Array.from(document.querySelectorAll('.address-bar-segment')).map(el => el.textContent))
        .toEqual(['C:', 'Users', 'OldFolder', 'Sub']);

      syncFolderRenameInRendererState('C:\\Users\\OldFolder', 'C:\\Users\\NewFolder');
      expect(appState.currentDirectory).toBe('C:\\Users\\NewFolder\\Sub');
      expect(Array.from(document.querySelectorAll('.address-bar-segment')).map(el => el.textContent))
        .toEqual(['C:', 'Users', 'NewFolder', 'Sub']);
    });

    it('safely renders untrusted folder names via textContent without HTML injection', () => {
      appState.currentDirectory = 'C:\\Users\\<img src=x onerror=alert(1)>';
      renderAddressBar();

      const lastSeg = document.querySelectorAll('.address-bar-segment')[2];
      expect(lastSeg.textContent).toBe('<img src=x onerror=alert(1)>');
      expect(lastSeg.querySelector('img')).toBeNull();
    });
  });

  describe('Step 2: Validation Logic & Text Edit Mode', () => {
    let refreshFileListMock;
    let expandTreeToPathMock;

    beforeEach(() => {
      createAddressBarDom();
      refreshFileListMock = vi.fn().mockResolvedValue(undefined);
      expandTreeToPathMock = vi.fn().mockResolvedValue(undefined);

      appState.tabs = [
        { id: 't1', path: 'C:\\Users\\Photos', name: 'Photos', history: ['C:\\Users\\Photos'], historyIndex: 0 }
      ];
      appState.activeTabIndex = 0;
      appState.currentDirectory = 'C:\\Users\\Photos';
      appState.smartFolders = [{ id: 'fav_5', name: '星5お気に入り' }];
      appState.selection = new Set();
      appState.selectedIndex = -1;

      uiManager.renderTabs = vi.fn();
      uiManager.updateSelectionUI = vi.fn();
      uiManager.hideCustomTooltip = vi.fn();

      initAddressBar({
        refreshFileList: refreshFileListMock,
        expandTreeToPath: expandTreeToPathMock,
        saveTabsState: vi.fn(),
        getTabNameForPath: (p) => p.split('\\').pop() || p
      });
    });

    afterEach(() => {
      exitAddressBarEditMode();
      vi.clearAllMocks();
    });

    it('normalizes quoted and forward-slash input paths', () => {
      expect(normalizeAddressBarInput('  "C:/Users/Photos/"  ')).toBe('C:\\Users\\Photos');
      expect(normalizeAddressBarInput('C:')).toBe('C:\\');
      expect(normalizeAddressBarInput('\\\\server\\share\\sub\\')).toBe('\\\\server\\share\\sub');
    });

    it('resolves existing folder, existing file (to parent), and non-existent path correctly', async () => {
      const existingDirs = new Set(['C:\\', 'C:\\Users', 'C:\\Users\\Photos']);
      const existingFiles = new Set(['C:\\Users\\Photos\\sample.png']);
      const deps = {
        checkDirectoryExists: vi.fn(async (p) => existingDirs.has(p)),
        checkFileExists: vi.fn(async (p) => existingFiles.has(p)),
        smartFolders: [{ id: 'fav_5', name: '星5' }]
      };

      // 1. フォルダが存在する -> そのまま遷移
      const dirRes = await resolveAddressBarTarget('C:\\Users\\Photos\\', deps);
      expect(dirRes).toEqual({
        status: 'directory',
        targetPath: 'C:\\Users\\Photos',
        normalizedPath: 'C:\\Users\\Photos'
      });

      // 2. ファイルが存在する -> 親フォルダへ遷移
      const fileRes = await resolveAddressBarTarget('C:\\Users\\Photos\\sample.png', deps);
      expect(fileRes).toEqual({
        status: 'file',
        targetPath: 'C:\\Users\\Photos',
        normalizedPath: 'C:\\Users\\Photos\\sample.png'
      });

      // 3. 親フォルダはあるが対象が存在しない -> not_found
      const missingLeaf = await resolveAddressBarTarget('C:\\Users\\Photos\\missing.png', deps);
      expect(missingLeaf).toEqual({
        status: 'not_found',
        targetPath: null,
        normalizedPath: 'C:\\Users\\Photos\\missing.png'
      });

      // 4. 親フォルダごと存在しない -> not_found
      const missingTree = await resolveAddressBarTarget('Z:\\NoSuch\\Folder', deps);
      expect(missingTree).toEqual({
        status: 'not_found',
        targetPath: null,
        normalizedPath: 'Z:\\NoSuch\\Folder'
      });

      // 5. 空入力 -> not_found
      const emptyRes = await resolveAddressBarTarget('   ', deps);
      expect(emptyRes.status).toBe('not_found');
    });

    it('enters edit mode on empty-space click with full path selected, and refuses for smart:// or PC', () => {
      renderAddressBar();
      const bar = document.getElementById('address-bar');
      const input = document.getElementById('address-bar-input');
      const selectSpy = vi.spyOn(input, 'select');

      bar.click();
      expect(isAddressBarEditing()).toBe(true);
      expect(bar.classList.contains('editing')).toBe(true);
      expect(input.value).toBe('C:\\Users\\Photos');
      expect(selectSpy).toHaveBeenCalled();

      // Esc でパンくず表示に戻る
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(isAddressBarEditing()).toBe(false);
      expect(bar.classList.contains('editing')).toBe(false);

      // smart:// と PC は編集不可
      expect(isAddressBarEditable('smart://fav_5')).toBe(false);
      expect(isAddressBarEditable('PC')).toBe(false);
      appState.currentDirectory = 'smart://fav_5';
      renderAddressBar();
      expect(enterAddressBarEditMode()).toBe(false);
      expect(isAddressBarEditing()).toBe(false);
    });

    it('validates path on Enter: shows error border on non-existent path and continues editing, navigates on valid path', async () => {
      renderAddressBar();
      const bar = document.getElementById('address-bar');
      const input = document.getElementById('address-bar-input');

      window.veloceAPI.pathExists = vi.fn(async (p) => p === 'C:\\Users' || p === 'C:\\Users\\Photos');
      window.veloceAPI.checkConflicts = vi.fn(async (paths) =>
        paths[0] === 'C:\\Users\\Photos\\image.png' ? paths : []
      );

      enterAddressBarEditMode();

      // 存在しないパス -> エラー表示して編集継続
      input.value = 'C:\\Users\\DoesNotExist';
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(isAddressBarEditing()).toBe(true);
      expect(bar.classList.contains('error')).toBe(true);
      expect(refreshFileListMock).not.toHaveBeenCalled();

      // 入力変更でエラー枠が解除される
      input.value = 'C:\\Users';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      expect(bar.classList.contains('error')).toBe(false);

      // 実在フォルダで Enter -> 遷移してパンくず表示へ復帰
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(isAddressBarEditing()).toBe(false);
      expect(appState.currentDirectory).toBe('C:\\Users');
      expect(refreshFileListMock).toHaveBeenCalledWith(true);
    });

    it('exits edit mode on unchanged blur, keeps edit mode on modified blur, and discards edit on renderAddressBar', () => {
      renderAddressBar();
      const input = document.getElementById('address-bar-input');

      // 変更なし blur -> パンくずへ戻る
      enterAddressBarEditMode();
      input.dispatchEvent(new window.FocusEvent('blur'));
      expect(isAddressBarEditing()).toBe(false);

      // 変更あり blur -> 編集中を維持
      enterAddressBarEditMode();
      input.value = 'C:\\Users\\Draft';
      input.dispatchEvent(new window.FocusEvent('blur'));
      expect(isAddressBarEditing()).toBe(true);

      // 外部遷移・タブ切替（renderAddressBar）で編集を破棄してパンくずへ戻る
      appState.currentDirectory = 'D:\\Other';
      renderAddressBar();
      expect(isAddressBarEditing()).toBe(false);
      expect(Array.from(document.querySelectorAll('.address-bar-segment')).map(el => el.textContent))
        .toEqual(['D:', 'Other']);
    });
  });

  describe('Step 3: Sibling Folder Dropdown Menu', () => {
    let refreshFileListMock;
    let expandTreeToPathMock;
    let showNotificationMock;

    beforeEach(() => {
      createAddressBarDom();
      refreshFileListMock = vi.fn().mockResolvedValue(undefined);
      expandTreeToPathMock = vi.fn().mockResolvedValue(undefined);
      showNotificationMock = vi.fn();

      appState.tabs = [
        { id: 't1', path: 'C:\\Users\\Photos', name: 'Photos', history: ['C:\\Users\\Photos'], historyIndex: 0 }
      ];
      appState.activeTabIndex = 0;
      appState.currentDirectory = 'C:\\Users\\Photos';
      appState.selection = new Set();
      appState.selectedIndex = -1;

      uiManager.renderTabs = vi.fn();
      uiManager.updateSelectionUI = vi.fn();
      uiManager.hideCustomTooltip = vi.fn();

      initAddressBar({
        refreshFileList: refreshFileListMock,
        expandTreeToPath: expandTreeToPathMock,
        saveTabsState: vi.fn(),
        getTabNameForPath: (p) => p.split('\\').pop() || p,
        showNotification: showNotificationMock
      });
    });

    afterEach(() => {
      closeAddressBarMenu();
      const menu = document.getElementById('address-bar-menu');
      if (menu) menu.remove();
      vi.clearAllMocks();
    });

    it('buildSiblingMenuModel highlights current segment, handles empty list, and reports error state', () => {
      const ready = buildSiblingMenuModel(
        [
          { name: 'Documents', path: 'C:\\Users\\Documents' },
          { name: 'Photos', path: 'C:\\Users\\Photos' }
        ],
        'c:\\users\\photos\\'
      );
      expect(ready.state).toBe('ready');
      expect(ready.items).toEqual([
        { name: 'Documents', path: 'C:\\Users\\Documents', isCurrent: false },
        { name: 'Photos', path: 'C:\\Users\\Photos', isCurrent: true }
      ]);

      const empty = buildSiblingMenuModel([], 'C:\\Users\\Photos');
      expect(empty).toEqual({ state: 'empty', items: [], message: '（フォルダなし）' });

      const err = buildSiblingMenuModel(null, 'C:\\Users\\Photos', new Error('Access denied'));
      expect(err).toEqual({ state: 'error', items: [], message: 'フォルダ一覧の取得に失敗しました' });
    });

    it('shows loading state, renders siblings with current highlight, and navigates on item click', async () => {
      renderAddressBar();
      const chevrons = document.querySelectorAll('.address-bar-chevron');
      // 2nd chevron sits between Users (parent: C:\Users) and Photos (current child: C:\Users\Photos)
      const usersChevron = chevrons[1];
      expect(usersChevron.dataset.parentPath).toBe('C:\\Users');
      expect(usersChevron.dataset.currentChildPath).toBe('C:\\Users\\Photos');

      let resolveFetch;
      const pendingPromise = new Promise(resolve => { resolveFetch = resolve; });
      const getSubfoldersMock = vi.fn(() => pendingPromise);

      const openPromise = openChevronMenu(usersChevron, 'C:\\Users', 'C:\\Users\\Photos', {
        getSubfolders: getSubfoldersMock
      });

      // 取得中は「読み込み中…」を表示
      const menu = document.getElementById('address-bar-menu');
      expect(menu.classList.contains('show')).toBe(true);
      expect(menu.textContent).toContain('読み込み中…');

      resolveFetch([
        { name: 'Documents', path: 'C:\\Users\\Documents' },
        { name: 'Photos', path: 'C:\\Users\\Photos' }
      ]);
      await openPromise;

      const items = menu.querySelectorAll('.address-bar-menu-item');
      expect(items.length).toBe(2);
      expect(items[0].classList.contains('current')).toBe(false);
      expect(items[1].classList.contains('current')).toBe(true);

      // 項目クリックで遷移しメニューを閉じる
      items[0].click();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(isAddressBarMenuOpen()).toBe(false);
      expect(appState.currentDirectory).toBe('C:\\Users\\Documents');
      expect(refreshFileListMock).toHaveBeenCalledWith(true);
    });

    it('displays empty message when parent has no subfolders', async () => {
      renderAddressBar();
      const rootChevron = document.querySelectorAll('.address-bar-chevron')[0];

      await openChevronMenu(rootChevron, 'C:\\', 'C:\\Users', {
        getSubfolders: vi.fn().mockResolvedValue([])
      });

      const menu = document.getElementById('address-bar-menu');
      expect(menu.classList.contains('show')).toBe(true);
      expect(menu.textContent).toContain('（フォルダなし）');
    });

    it('closes menu and notifies via toast when get_subfolders fails', async () => {
      renderAddressBar();
      const rootChevron = document.querySelectorAll('.address-bar-chevron')[0];

      await openChevronMenu(rootChevron, 'C:\\', 'C:\\Users', {
        getSubfolders: vi.fn().mockRejectedValue(new Error('Permission denied'))
      });

      expect(isAddressBarMenuOpen()).toBe(false);
      expect(showNotificationMock).toHaveBeenCalledWith('フォルダ一覧の取得に失敗しました', 'error');
    });
  });
});

