// ============================================================================
// Veloce - Smart Folder UI & Counter Controller (renderer-smart-folder.js)
// ============================================================================
// 本モジュールは、スマートフォルダ一覧（#smart-folders-list）のDOMノード生成、
// 該当件数の一括非同期取得・UI反映、クリックによるディレクトリ遷移、
// およびコンテキストメニューのルーティングを担当する。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';
import { ICON_SVGS } from './favorite-icons.js';
import { debounce } from '../common/utils.js';
import { setSetting } from '../common/settings-store.js';

let smartFoldersDelegated = false;

/**
 * 1件のスマートフォルダ設定データからDOMノード（#smart-folder-template クローン）を生成する
 * @param {Object} f - スマートフォルダ設定オブジェクト
 * @returns {HTMLElement} 生成されたスマートフォルダアイテム要素
 */
export function createSmartFolderNode(f) {
  const template = document.getElementById('smart-folder-template');
  if (!template) return document.createElement('div');
  const clone = template.content.cloneNode(true);
  const item = clone.querySelector('.smart-folder-item');
  if (!item) return document.createElement('div');
  item.dataset.id = f.id;

  const iconSpan = clone.querySelector('.smart-folder-icon');
  if (iconSpan) {
    if (f.icon && ICON_SVGS && ICON_SVGS[f.icon]) {
      iconSpan.innerHTML = ICON_SVGS[f.icon];
      iconSpan.className = `smart-folder-icon icon-color-${f.color || 'default'}`;
    } else if (f.icon && f.icon.startsWith('FAV_')) {
      iconSpan.innerHTML = UIManager.ICONS[f.icon] || UIManager.ICONS['FAV_STAR'];
      iconSpan.className = `smart-folder-icon icon-color-${f.color || 'default'}`;
    } else {
      iconSpan.className = `smart-folder-icon icon-color-${f.color || 'default'}`;
      iconSpan.innerHTML = f.icon || UIManager.ICONS.FAV_STAR;
    }
  }

  const nameSpan = clone.querySelector('.folder-name');
  if (nameSpan) {
    nameSpan.textContent = f.name;
  }

  return item;
}

/**
 * スマートフォルダの件数を取得してUIに反映する非同期関数
 */
export async function updateSmartFolderCountsUI() {
  if (!window.veloceAPI || !window.veloceAPI.getSmartFolderCounts) return;
  try {
    const rules = appState.smartFolders || [];
    const counts = await window.veloceAPI.getSmartFolderCounts(rules);
    const list = document.getElementById('smart-folders-list');
    if (!list) return;
    const items = list.querySelectorAll('.smart-folder-item');
    items.forEach(item => {
      const id = item.dataset.id;
      const countSpan = item.querySelector('.smart-folder-count');
      if (id && countSpan) {
        if (counts[id] !== undefined) {
          countSpan.textContent = Number(counts[id]).toLocaleString();
          countSpan.classList.add('show');
        } else {
          countSpan.classList.remove('show');
        }
      }
    });
  } catch (e) {
    console.error('Failed to update smart folder counts:', e);
  }
}

export const debouncedUpdateSmartFolderCounts = debounce(updateSmartFolderCountsUI, 500);
if (typeof window !== 'undefined') {
  window.debouncedUpdateSmartFolderCounts = debouncedUpdateSmartFolderCounts;
}

/**
 * スマートフォルダのUI初期化とイベント設定を行います
 * @param {Object} [options={}] - 外部連携コールバック
 */
export function initSmartFolders(options = {}) {
  const container = document.getElementById('smart-folders-list');
  if (!container) return;

  const getTabName = options.getTabNameForPath || ((path) => path);
  const saveTabs = options.saveTabsState || (() => {});
  const refresh = options.refreshFileList || (() => {});
  const getContextMenu = options.getContextMenuManager || (() => window.contextMenuManager);

  const fragment = document.createDocumentFragment();
  const folders = appState.smartFolders || [];

  folders.forEach(f => {
    fragment.appendChild(createSmartFolderNode(f));
  });

  // 1回のReflowでDOMツリーを更新
  container.replaceChildren(fragment);
  updateSmartFolderCountsUI();

  // イベント委譲 (Event Delegation) は1回だけ設定
  if (!smartFoldersDelegated) {
    smartFoldersDelegated = true;

    container.addEventListener('click', async (e) => {
      const item = e.target.closest('.smart-folder-item');
      if (!item) return;

      // 選択状態の更新（スマートフォルダはタブと状態が合わなくなるため選択状態を付与しない）
      const prevSmartSelected = container.querySelector('.smart-folder-item.selected');
      if (prevSmartSelected) prevSmartSelected.classList.remove('selected');

      // ツリー側の選択状態を解除
      const prevTreeSelected = document.querySelector('#dir-tree .tree-item.selected');
      if (prevTreeSelected) prevTreeSelected.classList.remove('selected');

      const fId = item.dataset.id;
      const f = appState.smartFolders.find(x => x.id === fId);
      if (!f) return;

      const path = `smart://${f.id}`;
      appState.selection.clear();
      appState.selectedIndex = -1;
      uiManager.updateSelectionUI();

      if (window.veloceAPI && window.veloceAPI.loadDirectory) {
        const activeTab = appState.tabs[appState.activeTabIndex];
        if (activeTab) {
          activeTab.path = path;
          activeTab.name = getTabName(path, appState.favorites);
          activeTab.scrollTop = 0;
          appState.currentDirectory = path;
          setSetting('currentDirectory', appState.currentDirectory);
          uiManager.renderTabs();
          saveTabs(appState, uiManager);

          refresh(true);
        }
      }
    });

    const section = document.getElementById('smart-folders-section');
    if (section) {
      section.addEventListener('contextmenu', (e) => {
        const cmm = getContextMenu();
        if (!cmm) return;

        const item = e.target.closest('.smart-folder-item');
        if (item) {
          // アイテム上での右クリック
          e.preventDefault();
          e.stopPropagation();

          const fId = item.dataset.id;
          const f = appState.smartFolders.find(x => x.id === fId);
          if (!f) return;

          cmm.show('smart-folder', {
            targetSmartFolderId: f.id,
            targetFolder: { path: `smart://${f.id}`, name: f.name }
          }, e.clientX, e.clientY);
        } else {
          // セクション余白での右クリック
          e.preventDefault();
          e.stopPropagation();

          cmm.show('smart-folder-background', {}, e.clientX, e.clientY);
        }
      });
    }
  }
}

