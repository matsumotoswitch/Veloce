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
    let targetTabEl = null;

    if (container) {
      targetTabEl = container.querySelector(`.tab-item[data-tab-id="${tabToRemove.id}"]`) || container.querySelector(`.tab-item[data-index="${index}"]`);
    }

    // フェーズ1: tabFadeOut アニメーション開始
    if (targetTabEl) {
      // アニメーション開始前に現在の幅を確定してロック（flex による可変幅を固定値にする）
      const currentWidth = targetTabEl.getBoundingClientRect().width;
      targetTabEl.style.minWidth = currentWidth + 'px';
      targetTabEl.style.maxWidth = currentWidth + 'px';
      targetTabEl.style.width = currentWidth + 'px';

      targetTabEl.classList.add('tab-dent');

      // transform アニメーション完了(220ms)後に幅ゼロへのトランジションを開始する
      // transform animation と width transition を分離することで、
      // 視覚的なアニメーションが width 縮小によって打ち消されるのを防ぐ
      // 隣のタブは 220ms 後にスライドしてくる（60ms で完了）
      setTimeout(() => {
        if (!targetTabEl.parentNode) return;
        targetTabEl.style.transition =
          'min-width 0.06s ease-in, max-width 0.06s ease-in, width 0.06s ease-in, ' +
          'padding-left 0.06s ease-in, padding-right 0.06s ease-in, ' +
          'margin-left 0.06s ease-in, margin-right 0.06s ease-in, ' +
          'border-width 0.06s ease-in';
        targetTabEl.style.minWidth = '0';
        targetTabEl.style.maxWidth = '0';
        targetTabEl.style.width = '0';
        targetTabEl.style.paddingLeft = '0';
        targetTabEl.style.paddingRight = '0';
        targetTabEl.style.marginLeft = '0';
        targetTabEl.style.marginRight = '0';
        targetTabEl.style.borderWidth = '0';
      }, 220);
    }

    let nextIndex = appState.activeTabIndex;
    let shouldSwitch = false;

    if (appState.activeTabIndex === index) {
      nextIndex = index - 1;
      if (nextIndex < 0) nextIndex = 0;
      shouldSwitch = true;
    } else if (appState.activeTabIndex > index) {
      appState.activeTabIndex -= 1;
    }

    if (shouldSwitch && appState.tabs[nextIndex]) {
      const nextTab = appState.tabs[nextIndex];
      appState.activeTabIndex = nextIndex;

      if (container) {
        container.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'));
        const newActiveEl = container.querySelector(`.tab-item[data-tab-id="${nextTab.id}"]`) || container.querySelector(`.tab-item[data-index="${nextIndex}"]`);
        if (newActiveEl) newActiveEl.classList.add('active');
      }

      if (window.veloceAPI?.loadDirectory) {
        // 重いDOM更新とIPC通信を遅延させ、タブが閉じるアニメーション（220ms）が
        // メインスレッドのブロックによってコマ落ち（フレームドロップ）しないようにする
        setTimeout(() => {
          // もし遅延中に別のタブがアクティブになっていたらキャンセル
          if (appState.activeTabIndex !== nextIndex) return;

          appState.currentDirectory = nextTab.path;
          localStorage.setItem('currentDirectory', appState.currentDirectory);
          appState.totalCount = 0;
          appState.selection.clear();
          uiManager.renderAll(true);
          clearMetadataUI();
          updateNavButtons();
          window.veloceAPI.loadDirectory(nextTab.path);
          expandTreeToPath(appState.currentDirectory);
        }, 220);
      }
    }

    // フェーズ2: アニメーション(220ms) + 幅縮小(60ms) + 余白(20ms) = 300ms後にDOM削除
    setTimeout(function() {
      const currentTabIdx = appState.tabs.indexOf(tabToRemove);
      if (currentTabIdx !== -1) {
        appState.tabs.splice(currentTabIdx, 1);
      }

      if (targetTabEl && targetTabEl.parentNode) {
        targetTabEl.remove();
      }

      uiManager.renderTabs();
      saveTabsState(appState, uiManager);
    }, 300);
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
