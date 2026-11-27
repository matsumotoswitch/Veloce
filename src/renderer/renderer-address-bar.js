// ============================================================================
// Veloce - Address Bar & Breadcrumb Navigation (renderer-address-bar.js)
// ============================================================================
// 本モジュールは、ツールバー左側の Explorer 形式アドレスバーを担当する。
//
// 主な責務:
// 1. パス文字列からパンくずセグメント配列への純粋変換（Windowsドライブ / UNC / smart:// / PC）
// 2. パンくずの描画、セグメントクリックによる階層遷移、およびフルパスツールチップ表示
// 3. 余白クリック・Ctrl+L によるテキスト編集モード遷移、パス検証（フォルダ／ファイル／不存在）、
//    エラー表示と Esc / 変更なし blur / 外部遷移時の編集状態破棄
// 4. シェブロンクリックによる兄弟フォルダ一覧ドロップダウンの非同期取得・表示・選択遷移
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';
import { checkPathExists, getParentDirectory } from '../common/path-utils.js';
import { setSetting } from '../common/settings-store.js';

let addressBarCallbacks = {
  refreshFileList: async () => {},
  expandTreeToPath: async () => {},
  saveTabsState: () => {},
  getTabNameForPath: (p) => p,
  showNotification: (msg, type = 'error') => {
    if (uiManager && typeof uiManager.showToast === 'function') {
      uiManager.showToast(msg, 3000, 'address-bar-notification', type);
    }
  }
};

let _isEditing = false;
let _editInitialValue = '';
let _isValidating = false;
let _menuRequestSeq = 0;
let _activeChevronBtn = null;
let _hoveredSegment = null;

/**
 * アドレスバーに必要な外部コールバック群を登録し、DOMイベントを初期化する。
 * @param {Object} [callbacks={}]
 */
export function initAddressBar(callbacks = {}) {
  addressBarCallbacks = { ...addressBarCallbacks, ...callbacks };
  bindAddressBarEvents();
}

/**
 * 指定パスがテキスト編集モードへ遷移可能かを判定する。
 * スマートフォルダ（smart://）および PC は仮想パスのため編集不可とする。
 * @param {string} path
 * @returns {boolean}
 */
export function isAddressBarEditable(path) {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed || trimmed === 'PC' || trimmed.startsWith('smart://')) {
    return false;
  }
  return true;
}

/**
 * 比較用にパスを正規化する（Windows パスにおける大文字小文字および末尾区切り差異を吸収）。
 * @param {string} path
 * @returns {string}
 */
function normalizePathForCompare(path) {
  if (typeof path !== 'string') return '';
  let s = path.trim().replace(/\//g, '\\');
  if (!/^[A-Za-z]:\\$/.test(s) && s !== '\\' && s !== '/') {
    s = s.replace(/\\+$/, '');
  }
  return s.toLowerCase();
}

/**
 * アドレスバーに入力されたパス文字列を正規化する。
 * 前後の空白やエクスプローラーの「パスとしてコピー」由来の二重引用符を取り除き、
 * 区切り文字と末尾区切りを Veloce の標準形式へ揃える。
 * @param {string} rawInput
 * @returns {string}
 */
export function normalizeAddressBarInput(rawInput) {
  if (typeof rawInput !== 'string') return '';
  let trimmed = rawInput.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return '';
  if (trimmed === 'PC' || trimmed.startsWith('smart://')) {
    return trimmed;
  }

  // UNC パス (\\server\share...)
  if (trimmed.startsWith('\\\\')) {
    const normalized = trimmed.replace(/\//g, '\\').replace(/\\+$/g, '');
    return normalized;
  }

  // Windows ドライブパス (C:\..., C:/..., C:)
  if (/^[A-Za-z]:([\\/]|$)/.test(trimmed)) {
    const normalized = trimmed.replace(/\//g, '\\');
    const driveRoot = normalized.slice(0, 2) + '\\';
    const rest = normalized.slice(2).replace(/^\\+|\\+$/g, '');
    if (!rest) {
      return driveRoot;
    }
    return driveRoot + rest;
  }

  // POSIX パス
  if (trimmed.startsWith('/')) {
    const normalized = trimmed.replace(/\/+$/g, '');
    return normalized || '/';
  }

  return trimmed;
}

/**
 * パス文字列をパンくずセグメント配列へ変換する純粋関数。
 * 各セグメントは表示ラベルと累積パスを保持する。
 *
 * 例:
 * - `C:\a\b` -> `[{ label: 'C:', path: 'C:\\' }, { label: 'a', path: 'C:\\a' }, { label: 'b', path: 'C:\\a\\b' }]`
 * - `C:\` -> `[{ label: 'C:', path: 'C:\\' }]`
 * - `\\server\share\a` -> `[{ label: '\\\\server\\share', path: '\\\\server\\share' }, { label: 'a', path: '\\\\server\\share\\a' }]`
 * - `smart://<id>` -> `[{ label: '<スマートフォルダ名>', path: 'smart://<id>', isVirtual: true }]`
 * - `PC` -> `[{ label: 'PC', path: 'PC', isVirtual: true }]`
 *
 * @param {string} rawPath
 * @param {{ smartFolders?: Array<{id: string, name: string}> }} [options={}]
 * @returns {Array<{ label: string, path: string, isVirtual: boolean, isRoot: boolean }>}
 */
export function parsePathToSegments(rawPath, options = {}) {
  if (typeof rawPath !== 'string') return [];
  const trimmed = rawPath.trim();
  if (!trimmed) return [];

  if (trimmed === 'PC') {
    return [{ label: 'PC', path: 'PC', isVirtual: true, isRoot: true }];
  }

  if (trimmed.startsWith('smart://')) {
    const id = trimmed.slice('smart://'.length);
    const smartFolders = Array.isArray(options.smartFolders)
      ? options.smartFolders
      : (Array.isArray(appState?.smartFolders) ? appState.smartFolders : []);
    const matched = smartFolders.find(f => f && f.id === id);
    const label = (matched && matched.name) ? matched.name : 'スマートフォルダ';
    return [{ label, path: trimmed, isVirtual: true, isRoot: true }];
  }

  // UNC パス (\\server\share\...)
  if (trimmed.startsWith('\\\\')) {
    const normalized = trimmed.replace(/\//g, '\\').replace(/\\+$/g, '');
    const parts = normalized.slice(2).split('\\').filter(Boolean);
    if (parts.length === 0) return [];
    if (parts.length === 1) {
      const serverRoot = '\\\\' + parts[0];
      return [{ label: serverRoot, path: serverRoot, isVirtual: false, isRoot: true }];
    }
    const shareRoot = '\\\\' + parts[0] + '\\' + parts[1];
    const segments = [{ label: shareRoot, path: shareRoot, isVirtual: false, isRoot: true }];
    let acc = shareRoot;
    for (let i = 2; i < parts.length; i++) {
      acc = acc + '\\' + parts[i];
      segments.push({ label: parts[i], path: acc, isVirtual: false, isRoot: false });
    }
    return segments;
  }

  // Windows ドライブパス (C:\..., C:/..., C:)
  if (/^[A-Za-z]:([\\/]|$)/.test(trimmed)) {
    const normalized = trimmed.replace(/\//g, '\\');
    const driveLabel = normalized.slice(0, 2);
    const driveRoot = driveLabel + '\\';
    const rest = normalized.slice(2).replace(/^\\+|\\+$/g, '');
    const segments = [{ label: driveLabel, path: driveRoot, isVirtual: false, isRoot: true }];
    if (!rest) {
      return segments;
    }
    const parts = rest.split('\\').filter(Boolean);
    let acc = driveLabel;
    for (let i = 0; i < parts.length; i++) {
      acc = acc + '\\' + parts[i];
      segments.push({ label: parts[i], path: acc, isVirtual: false, isRoot: false });
    }
    return segments;
  }

  // POSIX パス (/a/b 等)
  if (trimmed.startsWith('/')) {
    const normalized = trimmed.replace(/\/+$/g, '');
    const segments = [{ label: '/', path: '/', isVirtual: false, isRoot: true }];
    if (!normalized) {
      return segments;
    }
    const parts = normalized.slice(1).split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc + '/' + parts[i];
      segments.push({ label: parts[i], path: acc, isVirtual: false, isRoot: false });
    }
    return segments;
  }

  return [{ label: trimmed, path: trimmed, isVirtual: false, isRoot: true }];
}

/**
 * テキスト入力欄から確定されたパスを検証し、遷移先を決定する。
 * - 実在するディレクトリ: そのまま遷移（status: 'directory'）
 * - 実在するファイル: 親ディレクトリへ遷移（status: 'file'）
 * - 存在しないパス: エラーとして編集継続（status: 'not_found'）
 *
 * @param {string} rawInput
 * @param {Object} [deps={}] - テスト注入用の依存関数群
 * @param {(path: string) => Promise<boolean>} [deps.checkDirectoryExists]
 * @param {(filePath: string, parentPath: string) => Promise<boolean>} [deps.checkFileExists]
 * @param {Array<{id: string, name: string}>} [deps.smartFolders]
 * @returns {Promise<{ status: 'directory'|'file'|'not_found', targetPath: string|null, normalizedPath: string }>}
 */
export async function resolveAddressBarTarget(rawInput, deps = {}) {
  const normalized = normalizeAddressBarInput(rawInput);
  if (!normalized) {
    return { status: 'not_found', targetPath: null, normalizedPath: '' };
  }

  if (normalized === 'PC') {
    return { status: 'directory', targetPath: 'PC', normalizedPath: 'PC' };
  }

  if (normalized.startsWith('smart://')) {
    const id = normalized.slice('smart://'.length);
    const smartFolders = Array.isArray(deps.smartFolders)
      ? deps.smartFolders
      : (Array.isArray(appState?.smartFolders) ? appState.smartFolders : []);
    const exists = smartFolders.some(f => f && f.id === id);
    if (exists) {
      return { status: 'directory', targetPath: normalized, normalizedPath: normalized };
    }
    return { status: 'not_found', targetPath: null, normalizedPath: normalized };
  }

  const checkDir = typeof deps.checkDirectoryExists === 'function'
    ? deps.checkDirectoryExists
    : async (p) => {
        if (window.veloceAPI && typeof window.veloceAPI.pathExists === 'function') {
          try {
            return Boolean(await window.veloceAPI.pathExists(p));
          } catch (_) {
            return false;
          }
        }
        return checkPathExists(p);
      };

  const checkFile = typeof deps.checkFileExists === 'function'
    ? deps.checkFileExists
    : async (filePath, parentPath) => {
        if (window.veloceAPI && typeof window.veloceAPI.checkConflicts === 'function') {
          try {
            const conflicts = await window.veloceAPI.checkConflicts([filePath], parentPath);
            return Array.isArray(conflicts) && conflicts.length > 0;
          } catch (_) {
            return false;
          }
        }
        return false;
      };

  try {
    if (await checkDir(normalized)) {
      return { status: 'directory', targetPath: normalized, normalizedPath: normalized };
    }

    const parentPath = getParentDirectory(normalized);
    if (!parentPath) {
      return { status: 'not_found', targetPath: null, normalizedPath: normalized };
    }

    if (!(await checkDir(parentPath))) {
      return { status: 'not_found', targetPath: null, normalizedPath: normalized };
    }

    if (await checkFile(normalized, parentPath)) {
      return { status: 'file', targetPath: parentPath, normalizedPath: normalized };
    }
  } catch (_) {
    return { status: 'not_found', targetPath: null, normalizedPath: normalized };
  }

  return { status: 'not_found', targetPath: null, normalizedPath: normalized };
}

/**
 * シェブロンメニュー用の表示モデルを構築する純粋関数。
 * @param {Array<{name: string, path: string}>|null|undefined} subfolders
 * @param {string} [currentSegmentPath='']
 * @param {Error|string|null} [error=null]
 * @returns {{ state: 'ready'|'empty'|'error', items: Array<{name: string, path: string, isCurrent: boolean}>, message: string }}
 */
export function buildSiblingMenuModel(subfolders, currentSegmentPath = '', error = null) {
  if (error) {
    return {
      state: 'error',
      items: [],
      message: 'フォルダ一覧の取得に失敗しました'
    };
  }

  if (!Array.isArray(subfolders) || subfolders.length === 0) {
    return {
      state: 'empty',
      items: [],
      message: '（フォルダなし）'
    };
  }

  const normCurrent = normalizePathForCompare(currentSegmentPath);
  const items = [];
  for (let i = 0; i < subfolders.length; i++) {
    const entry = subfolders[i];
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
    const name = (typeof entry.name === 'string' && entry.name)
      ? entry.name
      : (entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path);
    const isCurrent = normCurrent !== '' && normalizePathForCompare(entry.path) === normCurrent;
    items.push({
      name,
      path: entry.path,
      isCurrent
    });
  }

  if (items.length === 0) {
    return {
      state: 'empty',
      items: [],
      message: '（フォルダなし）'
    };
  }

  return {
    state: 'ready',
    items,
    message: ''
  };
}

/**
 * 指定ディレクトリへ Veloce 共通の遷移作法で移動する。
 * @param {string} targetPath
 */
async function navigateToPath(targetPath) {
  if (!targetPath) return;

  appState.selection.clear();
  appState.selectedIndex = -1;
  if (uiManager && typeof uiManager.updateSelectionUI === 'function') {
    uiManager.updateSelectionUI();
  }

  const activeTab = appState.tabs && appState.tabs[appState.activeTabIndex];
  if (activeTab) {
    activeTab.path = targetPath;
    activeTab.name = addressBarCallbacks.getTabNameForPath(targetPath);
    activeTab.scrollTop = 0;
  }

  appState.savedScrollTopGrid = 0;
  appState.savedScrollTopList = 0;
  appState.currentDirectory = targetPath;
  setSetting('currentDirectory', targetPath);

  if (uiManager && typeof uiManager.renderTabs === 'function') {
    uiManager.renderTabs();
  }
  addressBarCallbacks.saveTabsState();

  await addressBarCallbacks.refreshFileList(true);
  await addressBarCallbacks.expandTreeToPath(targetPath);
}

/**
 * シェブロンメニュー要素を取得または生成する。
 * @returns {HTMLElement}
 */
function ensureAddressBarMenuElement() {
  let menu = document.getElementById('address-bar-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'address-bar-menu';
    document.body.appendChild(menu);
  }
  return menu;
}

/**
 * シェブロンから開いている兄弟フォルダドロップダウンメニューを閉じる。
 */
export function closeAddressBarMenu() {
  _menuRequestSeq++;
  const menu = document.getElementById('address-bar-menu');
  if (menu) {
    menu.classList.remove('show');
  }
  if (_activeChevronBtn) {
    _activeChevronBtn.classList.remove('open');
    _activeChevronBtn = null;
  }
}

/**
 * 兄弟フォルダドロップダウンメニューが表示中かを返す。
 * @returns {boolean}
 */
export function isAddressBarMenuOpen() {
  const menu = document.getElementById('address-bar-menu');
  return Boolean(menu && menu.classList.contains('show'));
}

/**
 * テキスト編集モード中かを返す。
 * @returns {boolean}
 */
export function isAddressBarEditing() {
  return _isEditing;
}

/**
 * テキスト編集モードを終了し、パンくず表示へ戻す。
 */
export function exitAddressBarEditMode() {
  _isEditing = false;
  _isValidating = false;
  _editInitialValue = '';

  const bar = document.getElementById('address-bar');
  const input = document.getElementById('address-bar-input');
  if (bar) {
    bar.classList.remove('editing', 'error');
  }
  if (input && document.activeElement === input) {
    input.blur();
  }
}

/**
 * テキスト編集モードへ切り替える。
 * スマートフォルダや PC 表示中は編集不可のため何もしない。
 * @returns {boolean} 編集モードに入った場合 true
 */
export function enterAddressBarEditMode() {
  const currentPath = appState.currentDirectory || '';
  if (!isAddressBarEditable(currentPath)) {
    return false;
  }

  const bar = document.getElementById('address-bar');
  const input = document.getElementById('address-bar-input');
  if (!bar || !input) return false;

  closeAddressBarMenu();
  if (uiManager && typeof uiManager.hideCustomTooltip === 'function') {
    uiManager.hideCustomTooltip();
  }

  _isEditing = true;
  _isValidating = false;
  _editInitialValue = currentPath;

  bar.classList.remove('error');
  bar.classList.add('editing');
  input.value = currentPath;
  input.focus();
  input.select();
  return true;
}

/**
 * シェブロンクリック時に親パス直下の兄弟フォルダ一覧を取得・表示する。
 * @param {HTMLElement} chevronBtn - クリックされたシェブロン要素
 * @param {string} parentPath - サブフォルダ一覧を取得する親パス
 * @param {string} [currentSegmentPath=''] - メニュー内で強調表示する現在のセグメントパス
 * @param {{ getSubfolders?: (dirPath: string) => Promise<Array<{name: string, path: string}>> }} [deps={}]
 */
export async function openChevronMenu(chevronBtn, parentPath, currentSegmentPath = '', deps = {}) {
  if (!chevronBtn || !parentPath) return;

  // 同じシェブロンを再度クリックした場合はトグルして閉じる
  if (_activeChevronBtn === chevronBtn && isAddressBarMenuOpen()) {
    closeAddressBarMenu();
    return;
  }

  closeAddressBarMenu();
  if (uiManager && typeof uiManager.hideCustomTooltip === 'function') {
    uiManager.hideCustomTooltip();
  }

  const menu = ensureAddressBarMenuElement();
  const requestId = ++_menuRequestSeq;
  _activeChevronBtn = chevronBtn;
  chevronBtn.classList.add('open');

  // 読み込み中表示を即座に出して応答性を維持
  const loadingEl = document.createElement('div');
  loadingEl.className = 'address-bar-menu-status';
  loadingEl.textContent = '読み込み中…';
  menu.replaceChildren(loadingEl);

  const rect = chevronBtn.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 1024;
  const maxLeft = Math.max(8, viewportWidth - 220);
  menu.style.left = `${Math.min(Math.max(8, rect.left), maxLeft)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.classList.add('show');

  const fetchSubfolders = typeof deps.getSubfolders === 'function'
    ? deps.getSubfolders
    : async (dirPath) => {
        if (window.veloceAPI && typeof window.veloceAPI.getSubfolders === 'function') {
          return window.veloceAPI.getSubfolders(dirPath);
        }
        if (window.veloceAPI && typeof window.veloceAPI.getFolders === 'function') {
          return window.veloceAPI.getFolders(dirPath);
        }
        throw new Error('get_subfolders API is not available');
      };

  try {
    const subfolders = await fetchSubfolders(parentPath);
    if (requestId !== _menuRequestSeq) return;

    const model = buildSiblingMenuModel(subfolders, currentSegmentPath, null);
    if (model.state === 'empty') {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'address-bar-menu-status';
      emptyEl.textContent = model.message;
      menu.replaceChildren(emptyEl);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < model.items.length; i++) {
      const item = model.items[i];
      const itemEl = document.createElement('div');
      itemEl.className = item.isCurrent
        ? 'context-menu-item address-bar-menu-item current'
        : 'context-menu-item address-bar-menu-item';
      itemEl.dataset.path = item.path;
      itemEl.title = item.path;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'menu-icon icon-color-folder menu-item-icon';
      iconSpan.innerHTML = UIManager.ICONS.FOLDER;

      const textSpan = document.createElement('span');
      textSpan.className = 'menu-item-text';
      textSpan.textContent = item.name;

      itemEl.appendChild(iconSpan);
      itemEl.appendChild(textSpan);
      itemEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAddressBarMenu();
        await navigateToPath(item.path);
      });

      fragment.appendChild(itemEl);
    }

    menu.replaceChildren(fragment);
  } catch (err) {
    if (requestId !== _menuRequestSeq) return;
    const errorModel = buildSiblingMenuModel(null, currentSegmentPath, err || 'error');
    closeAddressBarMenu();
    if (typeof addressBarCallbacks.showNotification === 'function') {
      addressBarCallbacks.showNotification(errorModel.message, 'error');
    } else if (uiManager && typeof uiManager.showToast === 'function') {
      uiManager.showToast(errorModel.message, 3000, 'address-bar-subfolders-error', 'error');
    }
  }
}

/**
 * 現在のディレクトリ（appState.currentDirectory）からアドレスバーのパンくずを描画する。
 * 編集モード中やドロップダウン表示中に呼ばれた場合は、それらを破棄してパンくず表示へ戻す。
 * @param {string} [pathOverride] - 省略時は appState.currentDirectory を使用
 */
export function renderAddressBar(pathOverride) {
  const bar = document.getElementById('address-bar');
  const breadcrumbsEl = document.getElementById('address-bar-breadcrumbs');
  if (!bar || !breadcrumbsEl) return;

  bindAddressBarEvents();

  // タブ切り替えや外部遷移時に編集状態・メニューを確実に破棄する
  exitAddressBarEditMode();
  closeAddressBarMenu();
  _hoveredSegment = null;

  const targetPath = typeof pathOverride === 'string' ? pathOverride : (appState.currentDirectory || '');
  const editable = isAddressBarEditable(targetPath);
  bar.classList.toggle('readonly', !editable);

  const segments = parsePathToSegments(targetPath, { smartFolders: appState.smartFolders });
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    const segBtn = document.createElement('button');
    segBtn.type = 'button';
    segBtn.className = seg.isVirtual ? 'address-bar-segment virtual' : 'address-bar-segment';
    segBtn.dataset.path = seg.path;
    segBtn.dataset.tooltip = seg.isVirtual ? seg.label : seg.path;
    segBtn.dataset.virtual = seg.isVirtual ? 'true' : 'false';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'address-bar-segment-label';
    labelSpan.textContent = seg.label;
    segBtn.appendChild(labelSpan);

    fragment.appendChild(segBtn);

    // 非仮想パスではセグメント間およびルート単独表示時にシェブロンを配置する
    const hasNextSegment = i < segments.length - 1;
    const isSingleRoot = segments.length === 1 && !seg.isVirtual;
    if (hasNextSegment || isSingleRoot) {
      const chevronBtn = document.createElement('button');
      chevronBtn.type = 'button';
      chevronBtn.className = 'address-bar-chevron';
      chevronBtn.textContent = '›';
      chevronBtn.dataset.parentPath = seg.path;
      chevronBtn.dataset.currentChildPath = hasNextSegment ? segments[i + 1].path : '';
      chevronBtn.setAttribute('aria-label', `${seg.label} 配下のフォルダ一覧`);
      fragment.appendChild(chevronBtn);
    }
  }

  breadcrumbsEl.replaceChildren(fragment);
}

/**
 * テキスト入力欄での Enter 確定処理を実行する。
 */
async function commitAddressBarEdit() {
  if (!_isEditing || _isValidating) return;

  const bar = document.getElementById('address-bar');
  const input = document.getElementById('address-bar-input');
  if (!bar || !input) return;

  _isValidating = true;
  try {
    const result = await resolveAddressBarTarget(input.value);
    if (!_isEditing) return;

    if (result.status === 'not_found' || !result.targetPath) {
      bar.classList.add('error');
      input.focus();
      return;
    }

    const nextPath = result.targetPath;
    exitAddressBarEditMode();
    if (normalizePathForCompare(nextPath) !== normalizePathForCompare(appState.currentDirectory)) {
      await navigateToPath(nextPath);
    }
  } finally {
    _isValidating = false;
  }
}

/**
 * アドレスバー要素へのイベント委譲リスナーを一度だけバインドする。
 */
function bindAddressBarEvents() {
  const bar = document.getElementById('address-bar');
  const breadcrumbsEl = document.getElementById('address-bar-breadcrumbs');
  const input = document.getElementById('address-bar-input');
  if (!bar || !breadcrumbsEl || !input) return;
  if (bar.dataset.addressBarInitialized === 'true') return;
  bar.dataset.addressBarInitialized = 'true';

  // アドレスバー全体のクリック: セグメント遷移 / シェブロンメニュー / 余白クリックでテキスト編集
  bar.addEventListener('click', async (e) => {
    if (_isEditing) return;

    const chevronBtn = e.target.closest('.address-bar-chevron');
    if (chevronBtn) {
      e.stopPropagation();
      const parentPath = chevronBtn.dataset.parentPath || '';
      const currentChildPath = chevronBtn.dataset.currentChildPath || '';
      await openChevronMenu(chevronBtn, parentPath, currentChildPath);
      return;
    }

    const segBtn = e.target.closest('.address-bar-segment');
    if (segBtn) {
      e.stopPropagation();
      closeAddressBarMenu();
      if (uiManager && typeof uiManager.hideCustomTooltip === 'function') {
        uiManager.hideCustomTooltip();
      }
      if (segBtn.dataset.virtual === 'true') return;
      const targetPath = segBtn.dataset.path;
      if (targetPath) {
        await navigateToPath(targetPath);
      }
      return;
    }

    // 余白クリックでテキスト編集モードに入る（スマートフォルダ／PC では無効）
    enterAddressBarEditMode();
  });

  // パンくずセグメントのホバーツールチップ（フルパス表示）
  breadcrumbsEl.addEventListener('mouseover', (e) => {
    const segBtn = e.target.closest('.address-bar-segment');
    if (!segBtn) {
      if (_hoveredSegment) {
        if (uiManager && typeof uiManager.hideCustomTooltip === 'function') {
          uiManager.hideCustomTooltip();
        }
        _hoveredSegment = null;
      }
      return;
    }
    if (segBtn !== _hoveredSegment) {
      _hoveredSegment = segBtn;
      const tip = segBtn.dataset.tooltip || segBtn.dataset.path || '';
      if (tip && uiManager && typeof uiManager.showCustomTooltip === 'function') {
        uiManager.showCustomTooltip(tip, e.clientX, e.clientY);
      }
    }
  });

  breadcrumbsEl.addEventListener('mousemove', (e) => {
    if (_hoveredSegment && uiManager && typeof uiManager.showCustomTooltip === 'function') {
      const tip = _hoveredSegment.dataset.tooltip || _hoveredSegment.dataset.path || '';
      if (tip) {
        uiManager.showCustomTooltip(tip, e.clientX, e.clientY);
      }
    }
  });

  breadcrumbsEl.addEventListener('mouseleave', () => {
    if (_hoveredSegment) {
      if (uiManager && typeof uiManager.hideCustomTooltip === 'function') {
        uiManager.hideCustomTooltip();
      }
      _hoveredSegment = null;
    }
  });

  // 編集入力欄イベント
  input.addEventListener('input', () => {
    if (bar.classList.contains('error')) {
      bar.classList.remove('error');
    }
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      exitAddressBarEditMode();
      return;
    }
    if (e.key === 'Enter' || e.keyCode === 13) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      await commitAddressBarEdit();
    }
  });

  input.addEventListener('blur', () => {
    if (!_isEditing || _isValidating) return;
    // 変更なしの blur のみパンくず表示へ戻し、編集中テキストは不用意に破棄しない
    if (input.value === _editInitialValue) {
      exitAddressBarEditMode();
    }
  });
}

