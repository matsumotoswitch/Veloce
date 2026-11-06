import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import { toggleHelpOverlay } from '../src/renderer/renderer-help.js';

describe('Navigate Up (Parent Folder) Button & Shortcut', () => {
  let globalKeydownHandler;
  let navigateUp;
  let updateNavButtons;
  let initNavUpButton;

  beforeAll(async () => {
    document.body.innerHTML = `
      <div id="toolbar" class="toolbar">
        <button id="nav-back-btn" class="icon-btn" disabled></button>
        <button id="nav-forward-btn" class="icon-btn" disabled></button>
        <button id="nav-up-btn" class="icon-btn" disabled></button>
        <button id="nav-reload-btn" class="icon-btn"></button>
      </div>
      <div id="tab-container"></div>
      <input type="text" id="search-input" />
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="file-list-top-spacer"></div>
      <div id="file-list-bottom-spacer"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" min="100" max="500" value="160" />
      <div id="inspector-header-path"></div>
      <div id="inspector-content"></div>
      <div id="inspector-empty"></div>
      <div id="static-file-info-table"></div>
      <div id="file-info-empty"></div>
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    global.CSS = { escape: vi.fn((s) => s) };

    const renderer = await import('../src/renderer/renderer.js');
    globalKeydownHandler = renderer.globalKeydownHandler;
    navigateUp = renderer.navigateUp;
    updateNavButtons = renderer.updateNavButtons;
    initNavUpButton = renderer.initNavUpButton;
    initNavUpButton(document.getElementById('nav-up-btn'));
  });

  beforeEach(() => {
    appState.totalCount = 0;
    appState.selectedIndex = -1;
    appState.selection = new Set();
    appState.favorites = [];
    appState.smartFolders = [];
    appState.isNavigatingHistory = false;
    appState.savedScrollTopGrid = 0;
    appState.savedScrollTopList = 0;

    appState.tabs = [
      {
        id: 1,
        path: 'C:\\Users\\Photos',
        name: 'Photos',
        searchQuery: '',
        sortConfig: { key: 'name', asc: true },
        scrollTop: 120,
        history: ['C:\\Users\\Photos'],
        historyIndex: 0
      }
    ];
    appState.activeTabIndex = 0;
    appState.currentDirectory = 'C:\\Users\\Photos';

    window.veloceAPI = {
      loadDirectory: vi.fn().mockResolvedValue({ files: [], current_dir: '' }),
      setViewParams: vi.fn().mockResolvedValue(undefined),
      getItems: vi.fn().mockResolvedValue([]),
      getAllRatings: vi.fn().mockResolvedValue({})
    };

    uiManager.showToast = vi.fn();
    uiManager.dismissToast = vi.fn();
    uiManager.hideCustomTooltip = vi.fn();
    uiManager.updateSelectionUI = vi.fn();
    uiManager.renderTabs = vi.fn();
    uiManager.renderAll = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.getElementById('search-input').blur();
    const diffModal = document.getElementById('diff-modal');
    if (diffModal) diffModal.remove();
    const helpOverlay = document.getElementById('help-overlay');
    if (helpOverlay) helpOverlay.remove();
  });

  it('places #nav-up-btn between #nav-forward-btn and #nav-reload-btn in src/index.html', () => {
    const htmlPath = path.resolve(process.cwd(), 'src/index.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const toolbar = doc.getElementById('toolbar');
    expect(toolbar).not.toBeNull();

    const buttons = Array.from(toolbar.querySelectorAll(':scope > button')).map((b) => b.id);
    expect(buttons.slice(0, 4)).toEqual([
      'nav-back-btn',
      'nav-forward-btn',
      'nav-up-btn',
      'nav-reload-btn'
    ]);

    const upBtn = doc.getElementById('nav-up-btn');
    expect(upBtn.disabled).toBe(true);
    expect(upBtn.querySelector('svg')).not.toBeNull();
  });

  it('navigates to parent directory when clicking enabled #nav-up-btn', async () => {
    const upBtn = document.getElementById('nav-up-btn');
    updateNavButtons();
    expect(upBtn.disabled).toBe(false);

    upBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(uiManager.hideCustomTooltip).toHaveBeenCalled();
    expect(appState.currentDirectory).toBe('C:\\Users');
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:\\Users');
  });

  it('updates #nav-up-btn disabled state accurately across folder types', () => {
    const upBtn = document.getElementById('nav-up-btn');

    appState.currentDirectory = 'C:\\Users\\Photos';
    updateNavButtons();
    expect(upBtn.disabled).toBe(false);

    appState.currentDirectory = 'C:\\Users';
    updateNavButtons();
    expect(upBtn.disabled).toBe(false);

    appState.currentDirectory = 'C:\\';
    updateNavButtons();
    expect(upBtn.disabled).toBe(true);

    appState.currentDirectory = 'PC';
    updateNavButtons();
    expect(upBtn.disabled).toBe(true);

    appState.currentDirectory = 'smart://fav-1';
    updateNavButtons();
    expect(upBtn.disabled).toBe(true);

    appState.currentDirectory = '\\\\nas\\images\\2026';
    updateNavButtons();
    expect(upBtn.disabled).toBe(false);

    appState.currentDirectory = '\\\\nas\\images';
    updateNavButtons();
    expect(upBtn.disabled).toBe(true);
  });

  it('navigates step-by-step up to the drive root, pushes history, and stops at root', async () => {
    const upBtn = document.getElementById('nav-up-btn');
    const backBtn = document.getElementById('nav-back-btn');

    appState.selection.add(0);
    appState.selectedIndex = 0;

    // 1st step: C:\Users\Photos -> C:\Users
    await navigateUp();

    expect(appState.currentDirectory).toBe('C:\\Users');
    expect(appState.tabs[0].path).toBe('C:\\Users');
    expect(appState.tabs[0].name).toBe('Users');
    expect(appState.tabs[0].scrollTop).toBe(0);
    expect(appState.tabs[0].history).toEqual(['C:\\Users\\Photos', 'C:\\Users']);
    expect(appState.tabs[0].historyIndex).toBe(1);
    expect(window.veloceAPI.loadDirectory).toHaveBeenLastCalledWith('C:\\Users');
    expect(upBtn.disabled).toBe(false);
    expect(backBtn.disabled).toBe(false);

    // 2nd step: C:\Users -> C:\
    await navigateUp();

    expect(appState.currentDirectory).toBe('C:\\');
    expect(appState.tabs[0].path).toBe('C:\\');
    expect(appState.tabs[0].history).toEqual(['C:\\Users\\Photos', 'C:\\Users', 'C:\\']);
    expect(appState.tabs[0].historyIndex).toBe(2);
    expect(window.veloceAPI.loadDirectory).toHaveBeenLastCalledWith('C:\\');
    expect(upBtn.disabled).toBe(true);

    // 3rd step at root: no-op
    window.veloceAPI.loadDirectory.mockClear();
    await navigateUp();
    expect(window.veloceAPI.loadDirectory).not.toHaveBeenCalled();
    expect(appState.currentDirectory).toBe('C:\\');
  });

  it('triggers navigateUp on Alt+ArrowUp and suppresses when modal or input is active', async () => {
    const event = new window.KeyboardEvent('keydown', {
      key: 'ArrowUp',
      altKey: true,
      cancelable: true
    });
    const preventSpy = vi.spyOn(event, 'preventDefault');

    await globalKeydownHandler(event);

    expect(preventSpy).toHaveBeenCalled();
    expect(appState.currentDirectory).toBe('C:\\Users');
    expect(window.veloceAPI.loadDirectory).toHaveBeenCalledWith('C:\\Users');

    // Should not trigger while an input is focused
    window.veloceAPI.loadDirectory.mockClear();
    const input = document.getElementById('search-input');
    input.focus();
    const inputEvent = new window.KeyboardEvent('keydown', {
      key: 'ArrowUp',
      altKey: true,
      cancelable: true
    });
    await globalKeydownHandler(inputEvent);
    expect(window.veloceAPI.loadDirectory).not.toHaveBeenCalled();
    input.blur();

    // Should not trigger while a modal overlay is open
    const modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'modal show';
    document.body.appendChild(modal);

    const modalEvent = new window.KeyboardEvent('keydown', {
      key: 'ArrowUp',
      altKey: true,
      cancelable: true
    });
    await globalKeydownHandler(modalEvent);
    expect(window.veloceAPI.loadDirectory).not.toHaveBeenCalled();
  });

  it('documents Alt + ↑ shortcut in the help overlay and README.md', () => {
    toggleHelpOverlay(true);
    const overlay = document.getElementById('help-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('ひとつ上のフォルダへ移動');
    toggleHelpOverlay(false);

    const readmePath = path.resolve(process.cwd(), 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf-8');
    expect(readme).toContain('| `Alt + ↑` | ひとつ上のフォルダへ移動 |');
  });
});

