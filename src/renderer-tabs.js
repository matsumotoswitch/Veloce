import { checkPathExists } from './path-utils.js';

/**
 * 現在のタブの状態を同期します。
 * @param {import('./renderer-state.js').AppState} appState
 * @param {import('./renderer-ui.js').UIManager} uiManager
 */
export function updateCurrentTabState(appState, uiManager) {
  if (appState.activeTabIndex >= 0 && appState.tabs[appState.activeTabIndex]) {
    const currentTab = appState.tabs[appState.activeTabIndex];
    if (typeof appState.searchQuery !== 'undefined') currentTab.searchQuery = appState.searchQuery;
    if (appState.sortConfig) currentTab.sortConfig = JSON.parse(JSON.stringify(appState.sortConfig));
    if (uiManager.elements.thumbnailGrid) {
      currentTab.scrollTop = uiManager.elements.thumbnailGrid.scrollTop || 0;
    }
  }
}

/**
 * タブの状態をローカルストレージに保存します。
 * @param {import('./renderer-state.js').AppState} appState
 * @param {import('./renderer-ui.js').UIManager} uiManager
 */
export function saveTabsState(appState, uiManager) {
  updateCurrentTabState(appState, uiManager);
  const state = {
    tabs: appState.tabs.map(t => ({
      id: t.id,
      path: t.path,
      name: t.name,
      searchQuery: t.searchQuery || '',
      sortConfig: t.sortConfig || { key: 'name', asc: true },
      scrollTop: t.scrollTop || 0,
      history: t.history || [t.path],
      historyIndex: t.historyIndex !== undefined ? t.historyIndex : 0
    })),
    activeTabIndex: appState.activeTabIndex
  };
  localStorage.setItem('tabsState', JSON.stringify(state));
}

/**
 * パスからタブの表示名を取得します。
 * @param {string} path
 * @param {Array<{path: string, name: string}>} favorites
 */
export function getTabNameForPath(path, favorites) {
  if (!path) return '';
  if (path === 'PC') return 'PC';
  const fav = favorites.find(f => f.path === path);
  if (fav) return fav.name;
  return path.split('\\').pop() || path;
}

/**
 * タブ操作ハンドラを初期化して window に登録します。
 * @param {object} ctx
 */
export function initTabHandlers(ctx) {
  const {
    appState,
    uiManager,
    expandTreeToPath,
    clearMetadataUI,
    updateNavButtons,
    updateSortIndicators
  } = ctx;

  window.onTabClick = async (index) => {
    if (index === appState.activeTabIndex) return;

    const tab = appState.tabs[index];
    if (!tab) return;

    const exists = await checkPathExists(tab.path);
    if (!exists) {
      const canCloseTab = appState.tabs.length > 1;
      const action = await uiManager.showMissingFolderDialog(tab.path, canCloseTab);
      if (action === 'close') {
        await window.onTabClose(index);
      }
      return;
    }

    updateCurrentTabState(appState, uiManager);

    appState.activeTabIndex = index;
    uiManager.renderTabs();

    appState.searchQuery = tab.searchQuery || '';
    if (uiManager.elements.searchBar) uiManager.elements.searchBar.value = appState.searchQuery;
    if (tab.sortConfig) {
      appState.sortConfig = JSON.parse(JSON.stringify(tab.sortConfig));
      localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
      updateSortIndicators();
    }

    if (window.veloceAPI.loadDirectory) {
      appState.currentDirectory = tab.path;
      localStorage.setItem('currentDirectory', appState.currentDirectory);
      appState.totalCount = 0;
      appState.selection.clear();
      uiManager.renderAll(true);
      clearMetadataUI();
      uiManager.showToast('フォルダを読み込み中', 0, 'dir-load-progress', 'info');

      updateNavButtons();

      window.veloceAPI.loadDirectory(tab.path);

      await expandTreeToPath(appState.currentDirectory);
      saveTabsState(appState, uiManager);
    }
  };

  window.onNewTabClick = async () => {
    let newPath = 'PC';
    try {
      if (window.__TAURI__?.path?.pictureDir) {
        newPath = await window.__TAURI__.path.pictureDir();
      }
    } catch (e) {
      console.warn('Failed to get picture dir:', e);
    }

    const newTab = {
      id: Date.now(),
      path: newPath,
      name: getTabNameForPath(newPath, appState.favorites),
      isNew: true,
      searchQuery: '',
      sortConfig: { key: 'name', asc: true },
      scrollTop: 0,
      history: [newPath],
      historyIndex: 0
    };
    appState.tabs.push(newTab);
    saveTabsState(appState, uiManager);

    await window.onTabClick(appState.tabs.length - 1);

    const container = document.getElementById('tab-container');
    if (container) {
      container.scrollLeft = container.scrollWidth;
    }
  };

  window.onTabClose = async (index) => {
    if (appState.tabs.length <= 1) return;

    const tabToRemove = appState.tabs[index];
    if (!tabToRemove || tabToRemove.isClosing) return;
    tabToRemove.isClosing = true;

    const container = document.getElementById('tab-container');
    let delay = 0;
    let targetTabEl = null;

    if (container) {
      targetTabEl = container.querySelector(`.tab-item[data-index="${index}"]`);
      if (targetTabEl) {
        targetTabEl.style.width = `${targetTabEl.offsetWidth}px`;
        targetTabEl.style.minWidth = '0px';
        void targetTabEl.offsetWidth;
        targetTabEl.classList.add('tab-fade-out');
        targetTabEl.removeAttribute('data-index');
        delay = 200;
      }
    }

    appState.tabs.splice(index, 1);
    saveTabsState(appState, uiManager);

    let shouldSwitch = false;
    let nextIndex = appState.activeTabIndex;

    if (appState.activeTabIndex === index) {
      nextIndex = index - 1;
      if (nextIndex < 0) nextIndex = 0;
      shouldSwitch = true;
      appState.activeTabIndex = -1;
    } else if (appState.activeTabIndex > index) {
      appState.activeTabIndex -= 1;
    }

    if (shouldSwitch) {
      await window.onTabClick(nextIndex);
    } else {
      uiManager.renderTabs();
    }

    if (delay > 0) {
      setTimeout(() => {
        if (targetTabEl?.parentElement) targetTabEl.remove();
      }, delay);
    } else if (targetTabEl?.parentElement) {
      targetTabEl.remove();
    }
  };

  window.onTabMove = (fromIndex, toIndex, insertAfter) => {
    if (fromIndex === toIndex) return;

    const tabs = appState.tabs;
    const activeTab = tabs[appState.activeTabIndex];

    const [movedTab] = tabs.splice(fromIndex, 1);

    let adjustedToIndex = toIndex;
    if (fromIndex < toIndex) adjustedToIndex -= 1;
    if (insertAfter) adjustedToIndex += 1;

    tabs.splice(adjustedToIndex, 0, movedTab);
    appState.activeTabIndex = tabs.indexOf(activeTab);

    uiManager.renderTabs();
    saveTabsState(appState, uiManager);
  };
}
