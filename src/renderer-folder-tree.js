// ============================================================================
// Veloce - Directory Folder Tree Controller (renderer-folder-tree.js)
// ============================================================================
// 本モジュールは、左ペインのディレクトリツリー階層構造（ドライブ一覧・フォルダ展開）、
// 遅延読み込み（Lazy Loading）、ツリー内キーボードナビゲーション（矢印キー操作）、
// および安全なコンテナ内スクロール（scrollTreeItemIntoView）を管理する。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';

let treeCallbacks = {
  refreshFileList: () => {},
  getTabNameForPath: (p) => p.split(/[\\/]/).pop(),
  saveTabsState: () => {},
  showNotification: () => {}
};

/**
 * ツリー操作で使用するコールバック群を設定します。
 * @param {Object} callbacks
 */
export function initFolderTree(callbacks = {}) {
  treeCallbacks = { ...treeCallbacks, ...callbacks };
}

/**
 * フォルダツリー要素を安全にスクロール表示します。
 * ネイティブの scrollIntoView() による祖先要素の不正なスクロール暴走を防ぐため、
 * 親コンテナの scrollTop のみを直接計算して操作します。
 * @param {HTMLElement} itemDiv - 表示対象のツリーアイテム要素
 * @param {'center'|'nearest'} [block='center'] - スクロール位置
 */
export function scrollTreeItemIntoView(itemDiv, block = 'center') {
  if (!itemDiv) return;
  const container = itemDiv.closest('#directories-section') || itemDiv.closest('#dir-tree');
  if (!container) return;

  const itemRect = itemDiv.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  if (block === 'center') {
    const targetScrollTop = container.scrollTop + (itemRect.top - containerRect.top) - (containerRect.height / 2) + (itemRect.height / 2);
    container.scrollTop = Math.max(0, targetScrollTop);
  } else {
    if (itemRect.top < containerRect.top) {
      container.scrollTop = Math.max(0, container.scrollTop - (containerRect.top - itemRect.top));
    } else if (itemRect.bottom > containerRect.bottom) {
      container.scrollTop = container.scrollTop + (itemRect.bottom - containerRect.bottom);
    }
  }
}

/**
 * 1つのフォルダツリーノード（li要素）を生成します。
 * サブフォルダの展開・遅延読み込み用クロージャを含みます。
 * @param {{ path: string, name: string }} folder
 * @param {boolean} [isRoot=false]
 * @returns {HTMLLIElement}
 */
export function createTreeNode(folder, isRoot = false) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const itemDiv = document.createElement('div');
  itemDiv.className = 'tree-item folder';
  itemDiv.dataset.path = folder.path;
  itemDiv.dataset.name = folder.name;
  itemDiv.dataset.isRoot = isRoot;
  itemDiv.draggable = !isRoot;

  // 展開・折りたたみ用のトグルアイコン
  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'tree-toggle toggle-icon';
  toggleIcon.innerHTML = UIManager.ICONS.CHEVRON_RIGHT;

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = isRoot ? UIManager.ICONS.DRIVE : UIManager.ICONS.FOLDER;

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = isRoot ? folder.path : folder.name;

  itemDiv.appendChild(toggleIcon);
  itemDiv.appendChild(icon);
  itemDiv.appendChild(label);
  li.appendChild(itemDiv);

  const childrenUl = document.createElement('ul');
  childrenUl.className = 'tree-children collapsed';
  li.appendChild(childrenUl);

  let isLoaded = false;

  // ノードを展開してサブフォルダを遅延読み込みする処理
  const expandNode = async () => {
    if (!isLoaded) {
      const subFolders = await window.veloceAPI.getFolders(folder.path);

      if (subFolders.length === 0) {
        toggleIcon.classList.add('tree-toggle-hidden');
        isLoaded = true;
        return;
      }

      subFolders.forEach(subFolder => {
        const childNode = createTreeNode(subFolder);
        childrenUl.appendChild(childNode);

        window.veloceAPI.getFolders(subFolder.path).then(grandChildren => {
          if (grandChildren && grandChildren.length === 0) {
            const childToggle = childNode.querySelector('.tree-toggle');
            if (childToggle) childToggle.classList.add('tree-toggle-hidden');
          }
        }).catch(err => console.error('Failed to check subfolders:', err));
      });
      isLoaded = true;
    }

    if (childrenUl.children.length > 0) {
      childrenUl.classList.remove('collapsed');
      childrenUl.classList.add('expanded');
      toggleIcon.classList.add('expanded');
    }
  };

  itemDiv.expandNode = expandNode;

  itemDiv.reloadFolder = async () => {
    isLoaded = false;
    childrenUl.replaceChildren();
    const wasExpanded = childrenUl.classList.contains('expanded');

    const subFolders = await window.veloceAPI.getFolders(folder.path);
    if (subFolders.length === 0) {
      toggleIcon.classList.add('tree-toggle-hidden');
      childrenUl.classList.remove('expanded');
      childrenUl.classList.add('collapsed');
      toggleIcon.classList.remove('expanded');
      isLoaded = true;
      return;
    }

    toggleIcon.classList.remove('tree-toggle-hidden');

    if (wasExpanded) {
      await expandNode();
    }
  };

  const collapseNode = () => {
    childrenUl.classList.remove('expanded');
    childrenUl.classList.add('collapsed');
    toggleIcon.classList.remove('expanded');
  };
  itemDiv.collapseNode = collapseNode;

  return li;
}

/**
 * 指定されたファイルパスに合わせてツリーを展開し、対象アイテムを選択・スクロール表示します。
 * @param {string} targetPath
 * @param {boolean} [disableScroll=false]
 * @param {HTMLElement|Document} [rootElement=document]
 */
export async function expandTreeToPath(targetPath, disableScroll = false, rootElement = document) {
  if (!targetPath || targetPath === 'PC') return;

  const searchRoot = rootElement === document ? document.getElementById('dir-tree') : rootElement;
  if (!searchRoot) return;

  if (targetPath.startsWith('smart://')) {
    const activeItem = searchRoot.querySelector('.tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    return;
  }

  const separator = '\\';
  const parts = targetPath.split(separator).filter(p => p !== '');
  let pathsToExpand = [];

  let current = parts[0] + separator;
  pathsToExpand.push(current);
  for (let i = 1; i < parts.length; i++) {
    current += parts[i];
    pathsToExpand.push(current);
    current += separator;
  }

  for (let i = 0; i < pathsToExpand.length; i++) {
    const p = pathsToExpand[i];
    const escapedPath = CSS.escape(p);
    const itemDiv = searchRoot.querySelector(`.tree-item[data-path="${escapedPath}"]`);

    if (itemDiv) {
      if (i === pathsToExpand.length - 1) {
        const activeItem = searchRoot.querySelector('.tree-item.selected');
        if (activeItem) activeItem.classList.remove('selected');
        itemDiv.classList.add('selected');
        if (!disableScroll) {
          scrollTreeItemIntoView(itemDiv, 'center');
        }
      } else {
        if (itemDiv.expandNode) await itemDiv.expandNode();
      }
    } else {
      break;
    }
  }
}

/**
 * ドライブ一覧とツリーの展開状態を最新化して再描画します。
 */
export async function refreshTree() {
  if (!window.veloceAPI?.getDrives) return;
  const dirTreeEl = uiManager.elements.dirTree || document.getElementById('dir-tree');
  if (!dirTreeEl) return;
  const scrollTop = dirTreeEl.scrollTop;
  const scrollLeft = dirTreeEl.scrollLeft;

  const expandedPaths = Array.from(dirTreeEl.querySelectorAll('.tree-children.expanded'))
    .map(ul => ul.previousElementSibling?.dataset?.path)
    .filter(Boolean);

  const tempContainer = document.createElement('div');
  const ul = document.createElement('ul');
  ul.className = 'tree-root';
  const drives = await window.veloceAPI.getDrives();
  for (const drive of drives) {
    ul.appendChild(createTreeNode({ name: drive, path: drive }, true));
  }
  tempContainer.appendChild(ul);

  expandedPaths.sort((a, b) => a.length - b.length);
  for (const p of expandedPaths) {
    await expandTreeToPath(p, true, tempContainer);
    const escapedPath = CSS.escape(p);
    const itemDiv = tempContainer.querySelector(`.tree-item[data-path="${escapedPath}"]`);
    if (itemDiv && itemDiv.expandNode) {
      await itemDiv.expandNode();
    }
  }

  if (appState.currentDirectory) {
    await expandTreeToPath(appState.currentDirectory, true, tempContainer);
  }

  dirTreeEl.replaceChildren(ul);
  dirTreeEl.scrollTop = scrollTop;
  dirTreeEl.scrollLeft = scrollLeft;
}

/**
 * フォルダツリーにフォーカスがある際の矢印キー操作を処理します。
 * @param {string} key
 * @param {Object} [callbacks=treeCallbacks]
 */
export async function handleTreeNavigation(key, callbacks = treeCallbacks) {
  const getVisibleTreeItems = (root) => {
    let items = [];
    const walk = (ul) => {
      for (const li of ul.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const item = li.firstElementChild;
        if (item && item.classList.contains('tree-item')) items.push(item);
        const childrenUl = li.children[1];
        if (childrenUl && childrenUl.classList.contains('tree-children') && childrenUl.classList.contains('expanded')) {
          walk(childrenUl);
        }
      }
    };
    for (const ul of root.children) {
      if (ul.tagName.toLowerCase() === 'ul') walk(ul);
    }
    return items;
  };

  const rootEl = document.getElementById('dir-tree');
  if (!rootEl) return;
  const visibleItems = getVisibleTreeItems(rootEl);
  if (visibleItems.length === 0) return;

  const currentSelected = document.querySelector('#dir-tree .tree-item.selected');
  let currentIndex = currentSelected ? visibleItems.indexOf(currentSelected) : -1;

  if (currentIndex === -1) {
    const currentItem = document.querySelector(`#dir-tree .tree-item[data-path="${CSS.escape(appState.currentDirectory)}"]`);
    if (currentItem) currentIndex = visibleItems.indexOf(currentItem);
    if (currentIndex === -1) currentIndex = 0;
  }

  const currentItem = visibleItems[currentIndex];
  const childrenUl = currentItem.nextElementSibling;
  const isExpanded = childrenUl && childrenUl.classList.contains('expanded');
  const toggleIcon = currentItem.querySelector('.tree-toggle');
  const hasChildren = toggleIcon && !toggleIcon.classList.contains('tree-toggle-hidden') && toggleIcon.style.visibility !== 'hidden';

  const selectItem = async (item, autoExpand = false) => {
    if (item) {
      scrollTreeItemIntoView(item, 'nearest');
    }

    appState.selection.clear();
    appState.selectedIndex = -1;
    uiManager.updateSelectionUI();

    const path = item.dataset.path;
    if (window.veloceAPI.loadDirectory) {
      if (window.veloceAPI.setViewParams) {
        await appState.setViewParams();
      }
      const activeTab = appState.tabs[appState.activeTabIndex];
      if (activeTab && activeTab.path !== path) {
        activeTab.path = path;
        activeTab.name = typeof callbacks.getTabNameForPath === 'function' ? callbacks.getTabNameForPath(path) : path.split(/[\\/]/).pop();
        activeTab.scrollTop = 0;
        appState.currentDirectory = path;
        localStorage.setItem('currentDirectory', path);
        uiManager.renderTabs();
        if (typeof callbacks.saveTabsState === 'function') callbacks.saveTabsState();
        if (typeof callbacks.refreshFileList === 'function') callbacks.refreshFileList(true);
      }
    }

    if (autoExpand && !isExpanded) {
      if (item.expandNode) await item.expandNode();
    }

    const activeItem = document.querySelector('#dir-tree .tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    item.classList.add('selected');
  };

  if (key === 'ArrowUp') {
    if (currentIndex > 0) await selectItem(visibleItems[currentIndex - 1]);
  } else if (key === 'ArrowDown') {
    if (currentIndex < visibleItems.length - 1) await selectItem(visibleItems[currentIndex + 1]);
  } else if (key === 'ArrowLeft') {
    if (isExpanded) {
      if (currentItem.collapseNode) currentItem.collapseNode();
    } else {
      const parentUl = currentItem.closest('ul.tree-children');
      if (parentUl && parentUl.previousElementSibling && parentUl.previousElementSibling.classList.contains('tree-item')) {
        await selectItem(parentUl.previousElementSibling);
      }
    }
  } else if (key === 'ArrowRight') {
    if (isExpanded) {
      if (currentIndex < visibleItems.length - 1) await selectItem(visibleItems[currentIndex + 1]);
    } else {
      if (hasChildren && currentItem.expandNode) await currentItem.expandNode();
    }
  }
}
