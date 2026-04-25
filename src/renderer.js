// ============================================================================
// Veloce - Main Controller (renderer.js)
// ============================================================================

const logicalCores = navigator.hardwareConcurrency || 8;
const MAX_CONCURRENT_THUMBNAILS = logicalCores * 2;

const dragState = {
  paths: [], // ドラッグ中の複数ファイルパス
  isAppDragging: false, // アプリ内からのドラッグ中かどうか
  pendingRefresh: false // ドラッグ終了後のリスト更新を待機しているか
};

const ICONS = {
  DRIVE: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#a0a0a0" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`,
  FOLDER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#ebc06d" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  CHEVRON_LEFT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
  CHEVRON_RIGHT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  CHEVRON_UP: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
  CHEVRON_DOWN: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  SORT_ASC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
  SORT_DESC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  ERASER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>`
};

const emptyDragImage = new Image();
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const fileListBody = document.getElementById('file-list-body');
const thumbnailGrid = document.getElementById('center-bottom');
const promptText = document.getElementById('prompt-text');
const negativePromptText = document.getElementById('negative-prompt-text');
const dirTree = document.getElementById('dir-tree');
const thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');
const resizerLeft = document.getElementById('resizer-left');
const resizerRight = document.getElementById('resizer-right');
const resizerCenter = document.getElementById('resizer-center');

const paneState = {
  left: { isCollapsed: false, preCollapseValue: '', cssVar: '--left-width', storageKey: 'leftWidth', defaultSize: '250px', openIcon: ICONS.CHEVRON_LEFT, closeIcon: ICONS.CHEVRON_RIGHT },
  right: { isCollapsed: false, preCollapseValue: '', cssVar: '--right-width', storageKey: 'rightWidth', defaultSize: '250px', openIcon: ICONS.CHEVRON_RIGHT, closeIcon: ICONS.CHEVRON_LEFT },
  center: { isCollapsed: false, preCollapseValue: '', cssVar: '--top-height', storageKey: 'topHeight', defaultSize: '250px', openIcon: ICONS.CHEVRON_UP, closeIcon: ICONS.CHEVRON_DOWN }
};

const resizingState = { left: false, right: false, center: false };

const contextMenu = document.createElement('div');
contextMenu.id = 'context-menu';
contextMenu.style.position = 'fixed';
contextMenu.style.display = 'none';
contextMenu.style.backgroundColor = '#2d2d2d';
contextMenu.style.border = '1px solid #444';
contextMenu.style.borderRadius = '4px';
contextMenu.style.padding = '4px 0';
contextMenu.style.zIndex = '10001';
contextMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
contextMenu.style.minWidth = '150px';
contextMenu.style.fontSize = '13px';

// ----------------------------------------------------------------------------
// 1. Tauri API & Backend Communication
// ----------------------------------------------------------------------------

async function refreshFileList() {
  if (!appState.currentDirectory || !window.veloceAPI.loadDirectory) return;
  const result = await window.veloceAPI.loadDirectory(appState.currentDirectory);
  if (!result) return;

  appState.files = result.imageFiles || [];  
  resetThumbnailPreloader();
  appState.applyFiltersAndSort();
  window.uiManager.renderAll();
  loadAllMetadataInBackground();
  
  window.uiManager.updateSelectionUI();
  if (appState.selectedIndex > -1) {
    const requestId = ++appState.currentMetaRequestId;
    const meta = await window.veloceAPI.parseMetadata(appState.filteredFiles[appState.selectedIndex].path);
    if (appState.currentMetaRequestId === requestId) renderMetadata(meta);
  } else {
    clearMetadataUI();
  }
}

async function refreshTree() {
  if (!window.veloceAPI.getDrives) return;
  const scrollTop = dirTree.scrollTop;
  const scrollLeft = dirTree.scrollLeft;

  const expandedPaths = Array.from(dirTree.querySelectorAll('.tree-children.expanded'))
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

  dirTree.innerHTML = '';
  dirTree.appendChild(ul);
  dirTree.scrollTop = scrollTop;
  dirTree.scrollLeft = scrollLeft;
}

async function expandTreeToPath(targetPath, disableScroll = false, rootElement = document) {
  if (!targetPath || targetPath === 'PC') return;

  const separator = '\\';
  const parts = targetPath.split(separator).filter(p => p !== '');
  let pathsToExpand = [];
  
  let current = parts[0] + separator;
  pathsToExpand.push(current);
  for(let i = 1; i < parts.length; i++) {
      current += parts[i];
      pathsToExpand.push(current);
      current += separator;
  }

  for (let i = 0; i < pathsToExpand.length; i++) {
      const p = pathsToExpand[i];
      const escapedPath = CSS.escape(p);
      const itemDiv = rootElement.querySelector(`.tree-item[data-path="${escapedPath}"]`);
      
      if (itemDiv) {
          if (i === pathsToExpand.length - 1) {
              const activeItem = rootElement.querySelector('.tree-item.selected');
              if (activeItem) activeItem.classList.remove('selected');
              itemDiv.classList.add('selected');
              if (!disableScroll) {
                  itemDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
          } else {
              if (itemDiv.expandNode) await itemDiv.expandNode();
          }
      } else {
          break;
      }
  }
}

async function loadAllMetadataInBackground() {
  if (!window.veloceAPI.getFullMetadataBatch) return;
  const filesToLoad = appState.files.filter(f => !f.metaLoaded);
  if (filesToLoad.length === 0) return;

  const batchId = ++appState.currentMetaBatchId;
  const pathsToLoad = filesToLoad.map(f => f.path);
  const CHUNK_SIZE = 100; 

  const processNextChunk = (chunkIndex) => {
    if (appState.currentMetaBatchId !== batchId) return;

    if (chunkIndex >= pathsToLoad.length) {
      window.uiManager.showToast(`情報の読み込み完了 (${pathsToLoad.length}/${pathsToLoad.length})`, 1000, 'meta-progress');
      if (['width', 'height'].includes(appState.sortConfig.key)) {
        appState.applyFiltersAndSort();
        window.uiManager.renderAll();
      }
      return;
    }

    requestIdleCallback(async () => {
      if (appState.currentMetaBatchId !== batchId) return;
      
      try {
        const chunkPaths = pathsToLoad.slice(chunkIndex, chunkIndex + CHUNK_SIZE);
        window.uiManager.showToast(`情報の読み込み中... (${Math.min(chunkIndex + CHUNK_SIZE, pathsToLoad.length)}/${pathsToLoad.length})`, 0, 'meta-progress', 'info');
        
        const metadataList = await window.veloceAPI.getFullMetadataBatch(chunkPaths);
        if (appState.currentMetaBatchId !== batchId) return;

        const pathToIndex = new Map();
        appState.files.forEach((f, i) => pathToIndex.set(f.path, i));

        metadataList.forEach(meta => {
          const fileIndex = pathToIndex.get(meta.path);
          if (fileIndex !== undefined && fileIndex > -1) {
            const file = appState.files[fileIndex];
            file.width = meta.width;
            file.height = meta.height;
            file.prompt = meta.prompt || '';
            file.negativePrompt = meta.negativePrompt || '';
            file.source = meta.source || '';
            if (meta.params && Array.isArray(meta.params.characterPrompts)) {
                file.charPrompts = meta.params.characterPrompts;
            }
            file.metaLoaded = true;

            const tableIndex = appState.filteredFiles.findIndex(f => f.path === meta.path);
            if (tableIndex !== -1 && fileListBody.children[tableIndex]) {
              const row = fileListBody.children[tableIndex];
              row.children[2].textContent = meta.width ? meta.width.toLocaleString() : '-';
              row.children[3].textContent = meta.height ? meta.height.toLocaleString() : '-';
            }
          }
        });

        if (appState.searchQuery.trim() !== '') {
            scheduleRefresh();
        }
      } catch (error) {
        console.error('Failed to load metadata in background:', error);
      }
      processNextChunk(chunkIndex + CHUNK_SIZE);
    }, { timeout: 2000 });
  };
  processNextChunk(0);
}

async function renameSelectedFolder() {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement.parentElement.classList.contains('tree-root');
  if (isRoot) {
    showNotification('ドライブ名を変更することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const oldName = selectedFolderEl.querySelector('.tree-label').textContent;

  const newName = await showCustomPrompt('新しいフォルダ名を入力してください:', oldName);
  if (newName !== null && newName !== oldName) {
    if (newName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
      return;
    }

    const result = await window.veloceAPI.renameFolder(oldPath, newName);
    if (result && result.success) {
      showNotification(`フォルダ名を「${newName}」に変更しました`);
      if (appState.currentDirectory.startsWith(oldPath)) {
        appState.currentDirectory = appState.currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', appState.currentDirectory);
      }
      await refreshTree();
    } else {
      showNotification(`フォルダ名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

async function deleteSelectedFolder() {
  const selectedFolderEl = document.querySelector('#dir-tree .tree-item.selected');
  if (!selectedFolderEl) return;

  const isRoot = selectedFolderEl.parentElement.parentElement.classList.contains('tree-root');
  if (isRoot) {
    showNotification('ドライブを削除することはできません。', 'warning');
    return;
  }

  const oldPath = selectedFolderEl.dataset.path;
  const folderName = selectedFolderEl.querySelector('.tree-label').textContent;

  const isConfirmed = await showCustomConfirm(`本当にフォルダ「${folderName}」をゴミ箱に移動しますか？`);
  if (isConfirmed) {
    const result = await window.veloceAPI.trashFolder(oldPath);
    if (result && result.success) {
      showNotification(`フォルダ「${folderName}」をゴミ箱に移動しました`, 'warning');
      if (appState.currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        appState.currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', appState.currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      showNotification(`フォルダの削除に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

async function renameSelectedFile() {
  if (appState.selectedIndex > -1 && appState.filteredFiles[appState.selectedIndex]) {
    const file = appState.filteredFiles[appState.selectedIndex];
    const oldPath = file.path;
    const newName = await showCustomPrompt('新しいファイル名を入力してください:', file.name, true);
    if (newName !== null && newName !== file.name) {
      if (newName.trim() === '') {
        window.uiManager.showToast('ファイル名を入力してください。', 3000, 'file-rename', 'warning');
        return;
      }
      if (/[\\/:*?"<>|]/.test(newName)) {
        window.uiManager.showToast('ファイル名に以下の文字は使用できません: \\ / : * ? " < > |', 3000, 'file-rename', 'warning');
        return;
      }

      const result = await window.veloceAPI.renameFile(oldPath, newName);
      if (result && result.success) {
        window.uiManager.showToast(`ファイル名を「${newName}」に変更しました`, 3000, 'file-rename', 'success');
        
        const newExt = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';
        const currentIdx = appState.files.findIndex(f => f.path === oldPath);
        if (currentIdx > -1) {
          appState.files[currentIdx].path = result.path;
          appState.files[currentIdx].name = newName;
          appState.files[currentIdx].ext = newExt;
        }
        file.path = result.path;
        file.name = newName;
        file.ext = newExt;

        appState.thumbnailUrls.delete(oldPath);
        resetThumbnailPreloader();
        scheduleRefresh();
      } else {
        window.uiManager.showToast(`ファイル名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 3000, 'file-rename', 'warning');
      }
    }
  }
}

async function deleteSelectedFiles() {
  if (appState.selection.size > 0) {
    const pathsToDelete = [];
    for (const i of appState.selection) {
      if (appState.filteredFiles[i]) pathsToDelete.push(appState.filteredFiles[i].path);
    }

    appState.selection.clear();
    appState.selectedIndex = -1;
    window.uiManager.updateSelectionUI();
    clearMetadataUI();

    let trashedCount = 0;
    const total = pathsToDelete.length;
    window.uiManager.showToast(`${total}件のアイテムをゴミ箱に移動中...`, 0, 'file-trash', 'warning');
    
    for (const path of pathsToDelete) {
      try {
        const success = await window.veloceAPI.trashFile(path);
        if (success) trashedCount++;
      } catch (err) {
        console.error('Failed to trash file:', err);
      }
    }

    if (trashedCount > 0) {
      window.uiManager.showToast(`${trashedCount}件のアイテムをゴミ箱に移動しました`, 3000, 'file-trash', 'warning');
    } else {
      window.uiManager.showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

// ----------------------------------------------------------------------------
// 2. Core Business Logic
// ----------------------------------------------------------------------------

function showNotification(message, type = 'info') {
  window.uiManager.showToast(message, 3000, null, type);
}

function applyIconGlowEffect(el) {
  if (!el) return;
  el.style.transition = 'none';
  el.style.color = '#fff';
  el.style.filter = 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 6px #ebc06d) drop-shadow(0 0 10px #ebc06d)';
  setTimeout(() => {
    el.style.transition = 'color 0.4s ease-out, filter 0.4s ease-out';
    el.style.color = '';
    el.style.filter = 'none';
    setTimeout(() => { el.style.transition = ''; }, 400);
  }, 100);
}

const createMenuOption = (text, onClick) => {
  const option = document.createElement('div');
  option.textContent = text;
  option.style.padding = '6px 16px';
  option.style.cursor = 'pointer';
  option.style.color = '#ccc';
  option.onmouseenter = () => option.style.backgroundColor = '#3a7afe';
  option.onmouseleave = () => option.style.backgroundColor = 'transparent';
  option.addEventListener('click', (e) => {
    e.stopPropagation();
    contextMenu.style.display = 'none';
    onClick();
  });
  return option;
};

function createCustomDialogBase(message, contentElement) {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  overlay.style.zIndex = '10002'; // コンテキストメニューより上に表示
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';

  const dialog = document.createElement('div');
  dialog.style.backgroundColor = '#2d2d2d';
  dialog.style.border = '1px solid #444';
  dialog.style.borderRadius = '4px';
  dialog.style.padding = '20px';
  dialog.style.minWidth = '300px';
  dialog.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
  dialog.style.color = '#ccc';
  dialog.style.fontFamily = 'inherit';

  const messageEl = document.createElement('div');
  messageEl.textContent = message;
  messageEl.style.marginBottom = contentElement ? '10px' : '20px';

  const buttonsDiv = document.createElement('div');
  buttonsDiv.style.display = 'flex';
  buttonsDiv.style.justifyContent = 'flex-end';
  buttonsDiv.style.gap = '10px';

  dialog.appendChild(messageEl);
  if (contentElement) dialog.appendChild(contentElement);
  dialog.appendChild(buttonsDiv);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const cleanup = () => {
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  return { buttonsDiv, cleanup };
}

function createDialogButton(text, bgColor) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `padding: 6px 16px; cursor: pointer; border: none; border-radius: 4px; font-family: inherit; font-size: inherit; background-color: ${bgColor}; color: #fff;`;
  return btn;
}

function showCustomPrompt(message, defaultValue = '', selectBaseNameOnly = false) {
  return new Promise((resolve) => {
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.value = defaultValue;
    inputEl.spellcheck = false; // スペルチェックの赤線を無効化
    inputEl.style.width = '100%';
    inputEl.style.boxSizing = 'border-box';
    inputEl.style.padding = '6px';
    inputEl.style.backgroundColor = '#1e1e1e';
    inputEl.style.color = '#d4d4d4';
    inputEl.style.border = '1px solid #333';
    inputEl.style.borderRadius = '4px';
    inputEl.style.marginBottom = '4px';
    inputEl.style.fontFamily = 'inherit';
    inputEl.style.fontSize = 'inherit';
    inputEl.style.outline = 'none';

    const warningEl = document.createElement('div');
    warningEl.style.color = '#e81123';
    warningEl.style.fontSize = '12px';
    warningEl.style.minHeight = '14px';
    warningEl.style.marginBottom = '10px';
    warningEl.style.display = 'none';

    const inputContainer = document.createElement('div');
    inputContainer.style.display = 'flex';
    inputContainer.style.flexDirection = 'column';
    inputContainer.appendChild(inputEl);
    inputContainer.appendChild(warningEl);

    const { buttonsDiv, cleanup } = createCustomDialogBase(message, inputContainer);

    const cancelBtn = createDialogButton('キャンセル', '#444');
    const okBtn = createDialogButton('OK', '#3a7afe');

    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(okBtn);

    const validateInput = () => {
      const val = inputEl.value;
      if (/[\\/:*?"<>|]/.test(val)) {
        warningEl.textContent = '以下の文字は使用できません: \\ / : * ? " < > |';
        warningEl.style.display = 'block';
        inputEl.style.borderColor = '#e81123';
        okBtn.disabled = true;
        okBtn.style.opacity = '0.5';
        okBtn.style.cursor = 'not-allowed';
      } else if (val.trim() === '') {
        warningEl.textContent = '名前を入力してください。';
        warningEl.style.display = 'block';
        inputEl.style.borderColor = '#333';
        okBtn.disabled = true;
        okBtn.style.opacity = '0.5';
        okBtn.style.cursor = 'not-allowed';
      } else {
        warningEl.style.display = 'none';
        inputEl.style.borderColor = '#333';
        okBtn.disabled = false;
        okBtn.style.opacity = '1';
        okBtn.style.cursor = 'pointer';
      }
    };

    inputEl.addEventListener('input', validateInput);
    validateInput();

    inputEl.focus();
    if (selectBaseNameOnly && defaultValue.lastIndexOf('.') > 0) {
      inputEl.setSelectionRange(0, defaultValue.lastIndexOf('.'));
    } else {
      inputEl.select();
    }

    okBtn.addEventListener('click', () => {
      if (!okBtn.disabled) {
        cleanup();
        resolve(inputEl.value);
      }
    });

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (!okBtn.disabled) {
          cleanup();
          resolve(inputEl.value);
        }
      } else if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    });
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const { buttonsDiv, cleanup } = createCustomDialogBase(message);

    const cancelBtn = createDialogButton('キャンセル', '#444');
    const okBtn = createDialogButton('削除', '#e81123'); // 削除アクションなので目立つ赤色

    buttonsDiv.appendChild(cancelBtn);
    buttonsDiv.appendChild(okBtn);

    const keydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        document.removeEventListener('keydown', keydownHandler);
        cleanup();
        resolve(false);
      }
    };

    document.addEventListener('keydown', keydownHandler);

    okBtn.addEventListener('click', () => { 
      document.removeEventListener('keydown', keydownHandler);
      cleanup(); 
      resolve(true); 
    });
    cancelBtn.addEventListener('click', () => { 
      document.removeEventListener('keydown', keydownHandler);
      cleanup(); 
      resolve(false); 
    });

    cancelBtn.focus(); // 誤操作(Enter連打)を防ぐためデフォルトでキャンセルにフォーカス
  });
}

function resetThumbnailPreloader() {
  appState.thumbnailRequestQueue = [];
  appState.pendingThumbnails.clear();
  appState.preloadCursor = 0;
}

function updateThumbnailToast() {
  if (appState.thumbnailTotalRequested === 0) return;

  const now = Date.now();
  const THROTTLE_DELAY = 50; // 50msに1回まで更新を許可

  // 最後の更新から十分な時間が経過したか、または最後の1件の時のみUIを更新
  if (now - appState.lastThumbnailToastTime > THROTTLE_DELAY || appState.thumbnailCompleted === appState.thumbnailTotalRequested) {
    appState.lastThumbnailToastTime = now;

    if (appState.thumbnailCompleted < appState.thumbnailTotalRequested) {
      window.uiManager.showToast(`サムネイル作成中 (${appState.thumbnailCompleted}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress', 'info');
    } else {
      window.uiManager.showToast(`サムネイル作成完了 (${appState.thumbnailTotalRequested}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress');
      clearTimeout(appState.thumbnailToastTimeout);
      appState.thumbnailToastTimeout = setTimeout(() => {
        const t = document.getElementById('toast-thumbnail-progress');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
        appState.thumbnailTotalRequested = 0;
        appState.thumbnailCompleted = 0;
        appState.lastThumbnailToastTime = 0;
      }, 1000);
    }
  }
}

function processThumbnailQueue() {
  // キューに空きがあり、かつタスクが残っている限り、連続でタスクを投入する（whileループ化）
  while (appState.activeThumbnailTasks < MAX_CONCURRENT_THUMBNAILS && appState.thumbnailRequestQueue.length > 0) {
    // 見えている画像の中から「一番最初（＝一番上）」にあるものを探す
    let targetIndex = appState.thumbnailRequestQueue.findIndex(req => req.img.dataset.isVisible === 'true');

    // 見えている画像がキュー内に無い場合は、一番最初（一番古いタスク）から処理してスキップ消化する
    if (targetIndex === -1) {
      targetIndex = 0;
    }

    // キューから該当するタスクを抜き出す
    const req = appState.thumbnailRequestQueue.splice(targetIndex, 1)[0];
    const { filePath, requestRenderId, img } = req;

    // 既に不要なリクエスト（画面外に出た、またはフォルダ移動した）場合はスキップ
    if (appState.currentRenderId !== requestRenderId || img.dataset.isVisible !== 'true') {
      appState.pendingThumbnails.delete(filePath);
      continue; // returnではなくcontinueで次のループへ
    }

    appState.activeThumbnailTasks++;
    window.veloceAPI.getThumbnail(filePath).then(url => {
      appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
      appState.pendingThumbnails.delete(filePath);

      if (appState.currentRenderId !== requestRenderId) {
        processThumbnailQueue();
        return;
      }

      if (url) {
        appState.thumbnailUrls.set(filePath, url);
        if (img.dataset.isVisible === 'true') {
          img.src = url;
        }
      } else {
        const fallbackUrl = window.veloceAPI.convertFileSrc(filePath);
        appState.thumbnailUrls.set(filePath, fallbackUrl);
        if (img.dataset.isVisible === 'true') img.src = fallbackUrl;
      }

      const fileObj = appState.files.find(f => f.path === filePath);
      if (fileObj && !fileObj.hasThumbnailCache) {
        fileObj.hasThumbnailCache = true;
        appState.thumbnailCompleted++;
        updateThumbnailToast();
      }

      // 処理が完了したら、枠が空いたので次の画像を処理する
      processThumbnailQueue();
    }).catch(() => {
      appState.activeThumbnailTasks = Math.max(0, appState.activeThumbnailTasks - 1);
      appState.pendingThumbnails.delete(filePath);
      processThumbnailQueue();
    });
  }
}

function initializeThumbnailObserver() {
    const options = {
        root: document.getElementById('center-bottom'), // 正しいスクロールコンテナを指定
        rootMargin: '400px 0px 400px 0px', // 少し広めに範囲を取る
    };
    appState.thumbnailObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const img = entry.target;
            const filePath = img.dataset.filepath;
            if (entry.isIntersecting) {
                img.dataset.isVisible = 'true';
                if (filePath && !img.hasAttribute('src')) {
                    if (appState.thumbnailUrls.has(filePath)) {
                        // すでにキャッシュがあればそれを使う
                        img.src = appState.thumbnailUrls.get(filePath);
                    } else if (!appState.pendingThumbnails.has(filePath)) {
                        // プレースホルダーを入れて二重リクエストを防止
                        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        
                        const requestRenderId = appState.currentRenderId;
                        appState.pendingThumbnails.add(filePath);
                        appState.thumbnailRequestQueue.push({ filePath, requestRenderId, img });
                        processThumbnailQueue();
                    }
                }
            } else {
                img.dataset.isVisible = 'false';
                // 画面外に出たら、srcをクリアしてメモリを解放する
                img.removeAttribute('src');
            }
        }
    }, options);
}

function processIdleThumbnails(deadline) {
  if (appState.pendingThumbnails.size > 8) {
    requestIdleCallback(processIdleThumbnails);
    return;
  }

  let targetFile = null;
  while (appState.preloadCursor < appState.filteredFiles.length) {
    const filePath = appState.filteredFiles[appState.preloadCursor].path;
    if (!appState.thumbnailUrls.has(filePath) && !appState.pendingThumbnails.has(filePath)) {
      targetFile = filePath;
      break;
    }
    appState.preloadCursor++;
  }

  if (!targetFile) {
    appState.isPreloadRunning = false;
    return;
  }

  appState.pendingThumbnails.add(targetFile);

  window.veloceAPI.getThumbnail(targetFile).then(url => {
    appState.pendingThumbnails.delete(targetFile);
    
    const finalUrl = url || window.veloceAPI.convertFileSrc(targetFile);
    appState.thumbnailUrls.set(targetFile, finalUrl);

    const fileObj = appState.files.find(f => f.path === targetFile);
    if (fileObj && !fileObj.hasThumbnailCache) {
        fileObj.hasThumbnailCache = true; 
        appState.thumbnailCompleted++;
        updateThumbnailToast();
    }

    const escapedPath = CSS.escape(targetFile);
    const img = document.querySelector(`.thumbnail-item[data-filepath="${escapedPath}"]`);
    if (img && img.dataset.isVisible === 'true' && !img.hasAttribute('src')) {
      img.src = finalUrl;
    }
  });

  requestIdleCallback(processIdleThumbnails);
}

function clearMetadataUI() {
  const container = document.getElementById('metadata-container');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

function scheduleRefresh() {
  clearTimeout(appState.searchTimeout); 
  appState.searchTimeout = setTimeout(() => {
    appState.preloadCursor = 0;
    appState.applyFiltersAndSort();

    window.uiManager.renderAll();
    loadAllMetadataInBackground();
    window.uiManager.updateSelectionUI();
    if (appState.selectedIndex === -1) {
      clearMetadataUI();
    }
  }, 100); 
}

function createTreeNode(folder, isRoot = false) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const itemDiv = document.createElement('div');
  itemDiv.className = 'tree-item folder';
  itemDiv.dataset.path = folder.path; // 展開用の目印としてパスを持たせる
  itemDiv.style.display = 'flex';
  itemDiv.style.alignItems = 'center';

  // 展開・折りたたみ用のトグルアイコン
  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon';
  toggleIcon.innerHTML = ICONS.CHEVRON_RIGHT;
  toggleIcon.style.cursor = 'pointer';
  toggleIcon.style.marginRight = '5px';
  toggleIcon.style.display = 'inline-flex';
  toggleIcon.style.alignItems = 'center';
  toggleIcon.style.width = '14px';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = isRoot ? ICONS.DRIVE : ICONS.FOLDER;
  icon.style.marginRight = '4px';
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = isRoot ? folder.path : folder.name;

  itemDiv.appendChild(toggleIcon);
  itemDiv.appendChild(icon);
  itemDiv.appendChild(label);
  li.appendChild(itemDiv);

  const childrenUl = document.createElement('ul');
  childrenUl.className = 'tree-children collapsed';
  childrenUl.style.display = 'none';
  li.appendChild(childrenUl);

  let isLoaded = false;

  // ノードを展開してサブフォルダを遅延読み込みする処理
  const expandNode = async () => {
    if (!isLoaded) {
      const subFolders = await window.veloceAPI.getFolders(folder.path);
      subFolders.forEach(subFolder => {
        childrenUl.appendChild(createTreeNode(subFolder));
      });
      isLoaded = true;
    }
    childrenUl.style.display = 'block';
    childrenUl.classList.remove('collapsed');
    childrenUl.classList.add('expanded');
    toggleIcon.innerHTML = ICONS.CHEVRON_DOWN;
  };

  // 外部から展開処理を呼び出せるように要素に紐付ける
  itemDiv.expandNode = expandNode;

  // ノードを折りたたむ処理
  const collapseNode = () => {
    childrenUl.style.display = 'none';
    childrenUl.classList.remove('expanded');
    childrenUl.classList.add('collapsed');
    toggleIcon.innerHTML = ICONS.CHEVRON_RIGHT;
  };

  // トグルアイコン部分だけをクリックした場合は開閉のみを行う
  toggleIcon.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isExpanded = childrenUl.classList.contains('expanded');
    if (isExpanded) {
      collapseNode();
    } else {
      await expandNode();
    }
  });

  // フォルダ項目がクリックされたときのイベントハンドラ
  itemDiv.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (e.target === toggleIcon) return; // トグルクリック時は全体の選択・ロード処理をスキップ

    // 他のペインの選択を解除
    appState.selection.clear();    appState.selectedIndex = -1;
    window.uiManager.updateSelectionUI();
    
    if (window.veloceAPI.loadDirectory) {
      // クリックされたフォルダの画像一覧を中央ペインに表示
      const result = await window.veloceAPI.loadDirectory(folder.path);
      if (result) {
        appState.currentDirectory = result.path;
        localStorage.setItem('currentDirectory', appState.currentDirectory); // フォルダ移動時にパスを保存
        appState.files = result.imageFiles || [];
        resetThumbnailPreloader();
        appState.applyFiltersAndSort();
        window.uiManager.renderAll();
        loadAllMetadataInBackground(); 
        clearMetadataUI();
      }
    }

    const wasSelected = itemDiv.classList.contains('selected');

    if (e.target === icon || wasSelected) {
      const isExpanded = childrenUl.classList.contains('expanded');
      if (isExpanded) {
        collapseNode();
      } else {
        await expandNode();
      }
    } else {
      await expandNode();
    }
    
    const activeItem = document.querySelector('.tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    itemDiv.classList.add('selected');
  });

  itemDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const activeItem = document.querySelector('.tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    itemDiv.classList.add('selected');

    contextMenu.targetFolder = folder;
    contextMenu.isRoot = isRoot;

    menuNewFolder.style.display = 'block';
    menuRenameFolder.style.display = isRoot ? 'none' : 'block';
    menuDeleteFolder.style.display = isRoot ? 'none' : 'block';
    menuRenameFile.style.display = 'none';
    menuDeleteFile.style.display = 'none';

    contextMenu.style.display = 'block';
    const rect = contextMenu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;
    
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
  });

  itemDiv.addEventListener('dragenter', (e) => {
    e.preventDefault();
    itemDiv.style.backgroundColor = 'rgba(58, 122, 254, 0.3)'; // ホバー時のハイライト
  });

  itemDiv.addEventListener('dragover', (e) => {
    e.preventDefault(); 
    
    let actionStr = 'コピー'; // 外部からのドロップのデフォルト
    if (dragState.paths.length > 0) {
      const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
      actionStr = getRoot(dragState.paths[0]) === getRoot(folder.path) ? '移動' : 'コピー';
    }
    e.dataTransfer.dropEffect = actionStr === '移動' ? 'move' : 'copy';

    const folderName = isRoot ? folder.path : folder.name;
    const countStr = dragState.paths.length > 1 ? `${dragState.paths.length}個のファイルを ` : '';
    dragTooltip.textContent = `${countStr}「${folderName}」へ${actionStr}`;
    dragTooltip.style.display = 'block';
    dragTooltip.style.left = (e.clientX + 15) + 'px';
    dragTooltip.style.top = (e.clientY + 15) + 'px'; 
  });

  itemDiv.addEventListener('dragleave', (e) => {
    if (!itemDiv.contains(e.relatedTarget)) {
      itemDiv.style.backgroundColor = '';
      dragTooltip.style.display = 'none';
    }
  });

  itemDiv.addEventListener('drop', (e) => {
    e.preventDefault();
    itemDiv.style.backgroundColor = '';
    dragTooltip.style.display = 'none';
    
    const paths = getPathsFromDragEvent(e);

    if (paths.length > 0 && window.veloceAPI.moveOrCopyFile) {
      let actionStr = 'コピー';
      if (paths.length > 0) {
        const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
        actionStr = getRoot(paths[0]) === getRoot(folder.path) ? '移動' : 'コピー';
      }

      window.uiManager.showToast(`${paths.length}件のファイルを${actionStr}中...`, 0, 'file-move', 'info');

      setTimeout(async () => {
        let successCount = 0;
        for (const p of paths) {
          const result = await window.veloceAPI.moveOrCopyFile(p, folder.path);
          if (result && result.success) {
            successCount++;
          }
        }
        if (successCount > 0) {
          window.uiManager.showToast(`${successCount}件のファイルを${actionStr}しました`, 3000, 'file-move');
          if (dragState.isAppDragging) {
            dragState.pendingRefresh = true; 
          } else {
            await refreshFileList(); 
          }
        } else {
          window.uiManager.showToast(`ファイルの${actionStr}に失敗しました`, 3000, 'file-move');
        }
      }, 10);
    }
  });

  return li;
}

function getPathsFromDragEvent(e) {
  if (dragState.paths && dragState.paths.length > 0) {
    return [...dragState.paths];
  }
  
  const paths = [];
  const jsonData = e.dataTransfer.getData('application/json');
  if (jsonData) {
    try { 
      const parsed = JSON.parse(jsonData); 
      if (Array.isArray(parsed)) return parsed;
    } catch(err) {}
  } 
  
  const sourcePath = e.dataTransfer.getData('text/plain');
  if (sourcePath) {
    let cleanPath = decodeURIComponent(sourcePath).trim();
    cleanPath = cleanPath.replace(/^file:(?:\/|\\)*/i, '');
    if (!cleanPath.match(/^[A-Za-z]:/)) cleanPath = '/' + cleanPath;
    paths.push(cleanPath);
  }
  return paths;
}

const TABLE_HEADERS = {
  name: '名前',
  ext: '拡張子',
  width: '幅',
  height: '高さ',
  size: 'サイズ',
  mtime: '更新日時',
};

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const key = th.dataset.sort;
    if (TABLE_HEADERS[key]) {
      if (appState.sortConfig.key === key) {
        th.innerHTML = TABLE_HEADERS[key] + (appState.sortConfig.asc ? ICONS.SORT_ASC : ICONS.SORT_DESC);
      } else {
        th.textContent = TABLE_HEADERS[key];
      }
    }
  });
}

function formatSize(bytes) {
  return bytes.toLocaleString();
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}/${MM}/${dd} ${hh}:${mm}:${ss}`;
}

async function selectImage(index, event = null) {
  if (event && event.ctrlKey) {
    // Ctrlキーで個別に選択/解除
    if (appState.selection.has(index)) {
      appState.selection.delete(index);
      if (appState.selectedIndex === index) {
        appState.selectedIndex = appState.selection.size > 0 ? Array.from(appState.selection).pop() : -1;
      }
    } else {
      appState.selection.add(index);
      appState.selectedIndex = index;
    }
  } else if (event && event.shiftKey && appState.selectedIndex !== -1) {
    // Shiftキーで範囲選択
    const start = Math.min(appState.selectedIndex, index);
    const end = Math.max(appState.selectedIndex, index);
    appState.selection.clear();
    for (let i = start; i <= end; i++) {
      appState.selection.add(i);
    }
    appState.selectedIndex = index;
  } else {
    // 通常のクリック（単一選択）
    appState.selection.clear();
    appState.selection.add(index);
    appState.selectedIndex = index;
  }

  if (appState.selectedIndex === -1) {
    window.uiManager.updateSelectionUI();
    clearMetadataUI();
    return;
  }

  const file = appState.filteredFiles[index];
  
  window.uiManager.updateSelectionUI();

  // 選択した画像やリスト行が画面内に表示されるように自動スクロール
  const items = thumbnailGrid.children;
  if (items[index]) {
    if (items[index].scrollIntoViewIfNeeded) {
      items[index].scrollIntoViewIfNeeded(false);
    } else {
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }
  const rows = fileListBody.children;
  if (rows[index]) {
    const thead = document.querySelector('#file-table thead');
    if (thead) {
      rows[index].style.scrollMarginTop = `${thead.getBoundingClientRect().height}px`;
    }
    
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  const requestId = ++appState.currentMetaRequestId;

  // インスペクターの更新
  const meta = await window.veloceAPI.parseMetadata(file.path);
  
  if (appState.currentMetaRequestId !== requestId) return;

  renderMetadata(meta);
}

function highlightText(text, terms) {
  if (!text) return '';
  if (!terms || terms.length === 0) return text;
  let highlighted = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  terms.forEach(term => {
    const escapedTerm = term.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const regex = new RegExp(`(${escapedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    highlighted = highlighted.replace(regex, '<mark style="background-color: rgba(235, 192, 109, 0.6); color: #fff; border-radius: 2px; padding: 0 2px;">$1</mark>');
  });
  return highlighted;
}

function renderMetadata(meta) {
  let container = document.getElementById('metadata-container');
  const rightPane = promptText ? promptText.parentElement : null;
  
  const hasAiMetadata = meta.prompt || meta.negativePrompt || meta.source || (meta.params && Object.keys(meta.params).length > 0);

  if (!container) {
    container = document.createElement('div');
    container.id = 'metadata-container';
    container.style.display = hasAiMetadata ? 'flex' : 'none';
    container.style.flexDirection = 'column';
    container.style.gap = '10px';
    container.style.width = '100%';
    container.style.boxSizing = 'border-box';
    container.style.paddingRight = '8px'; 
    
    // 既存の子要素（古いテキストエリア等）を非表示にして新しいコンテナを追加
    if (rightPane) {
      rightPane.style.overflowY = 'auto';
      Array.from(rightPane.children).forEach(child => {
         child.style.display = 'none';
      });
      rightPane.appendChild(container);
    }
  } else {
    container.style.display = hasAiMetadata ? 'flex' : 'none';
  }
  
  container.innerHTML = '';

  if (!hasAiMetadata) {
    return; 
  }

  const terms = appState.searchQuery.trim() !== '' ? appState.searchQuery.toLowerCase().split(',').map(t => t.trim()).filter(t => t) : [];

  const addField = (label, value, isMultiline = false, customMinHeight = '80px') => {
    if (value === undefined || value === null) return;
    
    const fieldDiv = document.createElement('div');
    fieldDiv.style.display = 'flex';
    fieldDiv.style.flexDirection = 'column';
    
    const labelWrapper = document.createElement('div');
    labelWrapper.style.display = 'flex';
    labelWrapper.style.justifyContent = 'space-between';
    labelWrapper.style.alignItems = 'center';
    labelWrapper.style.marginBottom = '4px';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.style.color = '#ccc';

    const copyBtn = document.createElement('span');
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.color = '#888';
    copyBtn.title = 'クリップボードにコピー';
    copyBtn.style.transition = 'color 0.1s, filter 0.1s';
    copyBtn.style.display = 'inline-flex';
    copyBtn.style.alignItems = 'center';
    
    copyBtn.onmouseenter = () => { if (copyBtn.style.color === 'rgb(136, 136, 136)' || copyBtn.style.color === '#888') copyBtn.style.color = '#3a7afe'; };
    copyBtn.onmouseleave = () => { if (copyBtn.style.color === 'rgb(58, 122, 254)' || copyBtn.style.color === '#3a7afe') copyBtn.style.color = '#888'; };
    
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        showNotification("プロンプトをクリップボードにコピーしました");
        applyIconGlowEffect(copyBtn);
      } catch (err) {
        console.error('Failed to copy: ', err);
      }
    });
    
    labelWrapper.appendChild(labelEl);
    labelWrapper.appendChild(copyBtn);
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'metadata-content';
    contentDiv.innerHTML = highlightText(String(value), terms);
    contentDiv.style.width = '100%';
    contentDiv.style.boxSizing = 'border-box';
    contentDiv.style.padding = '6px';
    contentDiv.style.backgroundColor = '#1e1e1e';
    contentDiv.style.color = '#d4d4d4';
    contentDiv.style.border = '1px solid #333';
    contentDiv.style.borderRadius = '4px';
    contentDiv.style.fontFamily = 'inherit';
    contentDiv.style.fontSize = '1em';
    contentDiv.style.userSelect = 'text';
    contentDiv.style.cursor = 'text';

    if (isMultiline) {
      contentDiv.style.minHeight = customMinHeight;
      contentDiv.style.overflowY = 'auto';
      contentDiv.style.resize = 'vertical';
      contentDiv.style.wordBreak = 'break-all';
    } else {
      contentDiv.style.whiteSpace = 'nowrap';
      contentDiv.style.overflowX = 'auto';
      contentDiv.style.overflowY = 'hidden';
    }
    
    fieldDiv.appendChild(labelWrapper);
    fieldDiv.appendChild(contentDiv);
    container.appendChild(fieldDiv);
  };

  if (meta.source) {
    addField('モデル / バージョン', meta.source);
  }
  addField('プロンプト', meta.prompt, true, '160px');
  addField('除外したい要素', meta.negativePrompt, true, '160px');
  
  if (meta.params) {
    if (Array.isArray(meta.params.characterPrompts)) {
      meta.params.characterPrompts.forEach((char, idx) => {
        addField(`キャラクター ${idx + 1} プロンプト`, char.prompt, true, '90px');
        addField(`キャラクター ${idx + 1} 除外したい要素`, char.uc, true, '90px');
      });
    }
    
    const resolution = (meta.params.width && meta.params.height) 
      ? `${meta.params.width}x${meta.params.height}` 
      : (meta.width && meta.height ? `${meta.width}x${meta.height}` : null);
    addField('画像サイズ', resolution);
    
    addField('シード値', meta.params.seed);
    addField('ステップ', meta.params.steps);
    
    let sampler = meta.params.sampler;
    if (sampler && meta.params.sm && !sampler.includes('karras')) {
        sampler += " (karras)";
    }
    addField('サンプラー', sampler);
    
    addField('プロンプトガイダンス', meta.params.scale);
    addField('プロンプトガイダンスの再調整', meta.params.cfg_rescale);
    addField('除外したい要素の強さ', meta.params.uncond_scale);

    if (meta.params.rawParameters) {
      addField('生成パラメータ', meta.params.rawParameters, true);
    }
  }
}

function openViewer(index) {
  const file = appState.filteredFiles[index];

  window.veloceAPI.openViewer({ 
    currentIndex: index,
    width: file ? file.width : 0,
    height: file ? file.height : 0,
    monitorWidth: window.screen.availWidth,
    monitorHeight: window.screen.availHeight
  });
}

function parseLicenseMarkdown(text) {
  if (!text) return '';
  
  let html = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = html.split('\n');
  let processedLines = [];
  let bqBuffer = [];

  for (let line of lines) {
    const bqMatch = line.match(/^\s*&gt;\s?(.*)$/);
    if (bqMatch) {
      bqBuffer.push(bqMatch[1]);
    } else {
      if (bqBuffer.length > 0) {
        processedLines.push(`<blockquote class="md-blockquote">${bqBuffer.join('<br>')}</blockquote>`);
        bqBuffer = [];
      }
      processedLines.push(line);
    }
  }
  if (bqBuffer.length > 0) {
    processedLines.push(`<blockquote class="md-blockquote">${bqBuffer.join('<br>')}</blockquote>`);
  }
  html = processedLines.join('\n');
  
  html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/gm, '<strong>$1</strong>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\s+(.*)$/gm, '<li class="md-list-item">$1</li>');
  html = html.replace(/(?:<li class="md-list-item">.*?<\/li>\n?)+/g, match => {
    return `<ul class="md-list">${match.replace(/\n/g, '')}</ul>`;
  });

  const tags = 'h1|h2|h3|ul|li|blockquote|hr';
  html = html.replace(new RegExp(`\\n+(<\\/?(?:${tags})[^>]*>)`, 'gi'), '$1');
  html = html.replace(new RegExp(`(<\\/?(?:${tags})[^>]*>)\\n+`, 'gi'), '$1');

  html = html.replace(/\n/g, '<br>');

  return html;
}

async function showLicenseDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'license-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  overlay.style.zIndex = '10000'; 
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';
  
  const content = document.createElement('div');
  content.style.backgroundColor = '#1e1e1e';
  content.style.padding = '20px';
  content.style.borderRadius = '8px';
  content.style.border = '1px solid #555';
  content.style.width = '80%';
  content.style.maxWidth = '800px';
  content.style.height = '80%';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.boxShadow = '0 4px 20px rgba(0,0,0,0.8)';
  content.style.cursor = 'default';
  
  let licenseText = "ライセンス情報を読み込み中...";
  try {
    if (window.__TAURI__ && window.__TAURI__.invoke) {
      licenseText = await window.__TAURI__.invoke('get_license_text');
    } else if (window.veloceAPI && window.veloceAPI.getLicenseText) {
      licenseText = await window.veloceAPI.getLicenseText();
    }
  } catch (e) {
    console.error("Failed to load licenses:", e);
    licenseText = "ライセンス情報の読み込みに失敗しました。";
  }

  const combinedText = licenseText;

  const parsedText = parseLicenseMarkdown(combinedText);

  content.innerHTML = `
    <h2 style="margin-top: 0; color: #ebc06d;">ライセンス情報</h2>
    <div style="background-color: rgba(232, 17, 35, 0.1); border: 1px solid #e81123; border-radius: 4px; padding: 12px; margin-bottom: 15px; color: #ff6b6b; font-weight: bold; font-size: 14px;">
      ※本ソフトウェアは商用利用不可です。無保証・無サポートで提供されており、すべて自己責任でのご利用となります。
    </div>
    <div id="license-text" style="flex: 1; overflow-y: auto; background-color: #2d2d2d; padding: 0px 20px 20px 20px; border: 1px solid #444; border-radius: 4px; color: #ccc; font-family: sans-serif; white-space: normal; font-size: 14px; line-height: 1.6;">${parsedText}</div>
  `;
  
  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', keydownHandler, true);
  };

  const keydownHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
    }
  };

  document.addEventListener('keydown', keydownHandler, true);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  
  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

function toggleHelpOverlay(forceShow) {
  let overlay = document.getElementById('help-overlay');
  
  if (overlay) {
    overlay.remove();
    return;
  }
  
  if (forceShow === false) return;

  overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  overlay.style.backdropFilter = 'blur(10px)';
  overlay.style.webkitBackdropFilter = 'blur(10px)'; 
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';
  overlay.style.color = '#fff';
  overlay.style.cursor = 'pointer';
  
  const content = document.createElement('div');
  content.style.backgroundColor = 'rgba(30, 30, 30, 0.8)';
  content.style.padding = '30px';
  content.style.borderRadius = '10px';
  content.style.border = '1px solid #555';
  content.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
  content.style.cursor = 'default';
  
  content.innerHTML = `
    <h2 style="margin-top: 0; text-align: center; color: #ebc06d;">ヘルプ・ショートカット一覧</h2>
    <div style="display: flex; gap: 40px; font-size: inherit;">
      <div style="display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <h3 style="color: #ccc; border-bottom: 1px solid #555; padding-bottom: 5px; margin-top: 0;">メイン画面</h3>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 6px 15px; font-weight: bold;">F1 / H</td><td style="padding: 6px 15px;">ヘルプの表示/非表示</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">矢印キー</td><td style="padding: 6px 15px;">画像の選択を移動</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">F5</td><td style="padding: 6px 15px;">最新の情報に更新</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl / Shift + クリック</td><td style="padding: 6px 15px;">画像の複数選択</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + A</td><td style="padding: 6px 15px;">すべての画像を選択</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + F</td><td style="padding: 6px 15px;">検索バーに入力</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">A</td><td style="padding: 6px 15px;">開いているビューワーを横一列に並べる</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">F2</td><td style="padding: 6px 15px;">名前を変更</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">選択中の画像をゴミ箱に移動</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">選択中の画像をコピー</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">ダブルクリック</td><td style="padding: 6px 15px;">サムネイルからビューワーを開く</td></tr>
            <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ヘルプを閉じる</td></tr>
          </table>
        </div>
        <div style="text-align: center; padding-bottom: 6px;">
          <span id="license-link" style="color: #3a7afe; text-decoration: underline; cursor: pointer; font-size: 0.9em;">ライセンスについて</span>
        </div>
      </div>
      <div>
        <h3 style="color: #ccc; border-bottom: 1px solid #555; padding-bottom: 5px; margin-top: 0;">ビューワー画面</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tr><td style="padding: 6px 15px; font-weight: bold;">F1 / H</td><td style="padding: 6px 15px;">ヘルプの表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">← / →</td><td style="padding: 6px 15px;">前 / 次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">マウスホイール</td><td style="padding: 6px 15px;">前 / 次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">右クリック</td><td style="padding: 6px 15px;">次の画像を表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">↑ / ↓</td><td style="padding: 6px 15px;">右 / 左に90度回転</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">0</td><td style="padding: 6px 15px;">100%表示 (大きい画像はフィット)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">1</td><td style="padding: 6px 15px;">完全な100%表示 (画面外にはみ出す)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Enter</td><td style="padding: 6px 15px;">ズーム解除 / 強制フィット切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F11</td><td style="padding: 6px 15px;">フルスクリーン切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">左ドラッグ</td><td style="padding: 6px 15px;">ウィンドウ / 画像の移動</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">W</td><td style="padding: 6px 15px;">ウィンドウを画像にフィット</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">B</td><td style="padding: 6px 15px;">ウィンドウ枠の表示/非表示</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">S</td><td style="padding: 6px 15px;">画像のシャープ / 滑らか表示切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Delete</td><td style="padding: 6px 15px;">画像をゴミ箱に移動して次へ</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Ctrl + C</td><td style="padding: 6px 15px;">画像をクリップボードにコピー</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Esc</td><td style="padding: 6px 15px;">ビューワーを閉じる (ヘルプ表示時は閉じる)</td></tr>
        </table>
      </div>
    </div>
  `;
  
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'license-link') {
      showLicenseDialog();
      return;
    }
    toggleHelpOverlay(false);
  });
  
  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

// ----------------------------------------------------------------------------
// 3. Event Handlers (User Interactions)
// ----------------------------------------------------------------------------

const menuNewFolder = createMenuOption('フォルダ新規作成', async () => {
  if (!contextMenu.targetFolder) return;
  const folderName = await showCustomPrompt('新しいフォルダ名を入力してください:');
  if (folderName !== null) {
    if (folderName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(folderName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
      return;
    }

    const parentPath = contextMenu.targetFolder.path;
    const result = await window.veloceAPI.createFolder(parentPath, folderName);
    if (result && result.success) {
      showNotification(`フォルダ「${folderName}」を作成しました`);
      await refreshTree();

      await expandTreeToPath(parentPath, true);
      const escapedParentPath = CSS.escape(parentPath);
      const parentDiv = document.querySelector(`.tree-item[data-path="${escapedParentPath}"]`);
      if (parentDiv && parentDiv.expandNode) {
        await parentDiv.expandNode();
      }

      if (appState.currentDirectory) {
        const escapedCurrent = CSS.escape(appState.currentDirectory);
        const currentDiv = document.querySelector(`.tree-item[data-path="${escapedCurrent}"]`);
        if (currentDiv) {
          const activeItem = document.querySelector('.tree-item.selected');
          if (activeItem) activeItem.classList.remove('selected');
          currentDiv.classList.add('selected');
        }
      }
    } else {
      alert('フォルダの作成に失敗しました:\n' + (result ? result.error : 'Unknown error'));
    }
  }
});

const menuRenameFolder = createMenuOption('フォルダ名変更', async () => {
  if (!contextMenu.targetFolder) return;
  const oldPath = contextMenu.targetFolder.path;
  const newName = await showCustomPrompt('新しいフォルダ名を入力してください:', contextMenu.targetFolder.name);
  if (newName !== null && newName !== contextMenu.targetFolder.name) {
    if (newName.trim() === '') {
      showNotification('フォルダ名を入力してください。', 'warning');
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      showNotification('フォルダ名に以下の文字は使用できません: \\ / : * ? " < > |', 'warning');
      return;
    }

    const result = await window.veloceAPI.renameFolder(oldPath, newName);
    if (result && result.success) {
      showNotification(`フォルダ名を「${newName}」に変更しました`);
      if (appState.currentDirectory.startsWith(oldPath)) {
        appState.currentDirectory = appState.currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', appState.currentDirectory);
      }
      await refreshTree();
    } else {
      showNotification(`フォルダ名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
});

const menuDeleteFolder = createMenuOption('フォルダ削除', async () => {
  if (!contextMenu.targetFolder) return;
  const oldPath = contextMenu.targetFolder.path;
  const isConfirmed = await showCustomConfirm(`本当にフォルダ「${contextMenu.targetFolder.name}」をゴミ箱に移動しますか？`);
  if (isConfirmed) {
    const result = await window.veloceAPI.trashFolder(oldPath);
    if (result && result.success) {
      showNotification(`フォルダ「${contextMenu.targetFolder.name}」をゴミ箱に移動しました`, 'warning');
      if (appState.currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        appState.currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', appState.currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      alert('フォルダの削除に失敗しました:\n' + (result ? result.error : 'Unknown error'));
    }
  }
});

const menuRenameFile = createMenuOption('ファイル名変更', renameSelectedFile);
const menuDeleteFile = createMenuOption('ファイル削除', deleteSelectedFiles);

contextMenu.appendChild(menuNewFolder);
contextMenu.appendChild(menuRenameFolder);
contextMenu.appendChild(menuDeleteFolder);
contextMenu.appendChild(menuRenameFile);
contextMenu.appendChild(menuDeleteFile);
document.body.appendChild(contextMenu);

window.addEventListener('click', () => {
  if (contextMenu.style.display === 'block') {
    contextMenu.style.display = 'none';
  }
});

const dragTooltip = document.createElement('div');
dragTooltip.id = 'drag-tooltip';
dragTooltip.style.position = 'fixed';
dragTooltip.style.pointerEvents = 'none'; 
dragTooltip.style.zIndex = '10000';
dragTooltip.style.padding = '4px 8px';
dragTooltip.style.backgroundColor = 'rgba(0, 0, 0, 1.0)'; 
dragTooltip.style.color = '#ffffff'; 
dragTooltip.style.border = '1px solid #555'; 
dragTooltip.style.borderRadius = '4px';
dragTooltip.style.display = 'none';
dragTooltip.style.boxShadow = '0 2px 5px rgba(0,0,0,0.5)';
document.body.appendChild(dragTooltip);

document.addEventListener('dragend', async () => {
  dragTooltip.style.display = 'none';
  dragState.paths = [];
  dragState.isAppDragging = false;

  if (dragState.pendingRefresh) {
    dragState.pendingRefresh = false;
    await refreshFileList();
  }
});

function handleItemClick(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  selectImage(parseInt(item.dataset.index, 10), e);
}

function handleItemDblClick(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  openViewer(parseInt(item.dataset.index, 10));
}

function handleItemDragStart(e, isGrid) {
  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  const index = parseInt(item.dataset.index, 10);
  
  if (!appState.selection.has(index)) selectImage(index);
  const paths = Array.from(appState.selection).map(idx => appState.filteredFiles[idx].path);
  e.dataTransfer.setData('application/json', JSON.stringify(paths));
  e.dataTransfer.setData('text/plain', paths[0]);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setDragImage(emptyDragImage, 0, 0);
  dragState.paths = paths;
  dragState.isAppDragging = true;
}

function handleItemContextMenu(e, isGrid) {
  e.preventDefault();
  e.stopPropagation();

  const item = e.target.closest(isGrid ? '.thumbnail-item' : 'tr');
  if (!item || !item.dataset.index) return;
  const index = parseInt(item.dataset.index, 10);

  if (!appState.selection.has(index)) selectImage(index);

  menuNewFolder.style.display = 'none';
  menuRenameFolder.style.display = 'none';
  menuDeleteFolder.style.display = 'none';
  menuRenameFile.style.display = appState.selection.size === 1 ? 'block' : 'none'; 
  menuDeleteFile.style.display = 'block';

  contextMenu.style.display = 'block';
  const rect = contextMenu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;
  
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

thumbnailGrid.addEventListener('click', (e) => handleItemClick(e, true));
thumbnailGrid.addEventListener('dblclick', (e) => handleItemDblClick(e, true));
thumbnailGrid.addEventListener('dragstart', (e) => handleItemDragStart(e, true));
thumbnailGrid.addEventListener('contextmenu', (e) => handleItemContextMenu(e, true));

fileListBody.addEventListener('click', (e) => handleItemClick(e, false));
fileListBody.addEventListener('dragstart', (e) => handleItemDragStart(e, false));
fileListBody.addEventListener('contextmenu', (e) => handleItemContextMenu(e, false));

function setupResizer(resizer, type, cursor) {
  if (!resizer) return;
  resizer.addEventListener('mousedown', () => {
    resizingState[type] = true;
    resizer.classList.add('resizing');
    document.body.style.cursor = cursor;
    if (paneState[type].isCollapsed) {
      paneState[type].isCollapsed = false;
      const btn = resizer.querySelector('.resizer-toggle');
      if (btn) btn.innerHTML = paneState[type].openIcon;
    }
  });
  createResizerToggle(resizer, type);
}

function createResizerToggle(resizer, type) {
  resizer.style.position = 'relative';

  const btn = document.createElement('div');
  btn.className = 'resizer-toggle';
  btn.style.cssText = `
    position: absolute; display: flex; justify-content: center; align-items: center;
    background-color: #333; border: 1px solid #555; border-radius: 2px; cursor: pointer;
    z-index: 1000; top: 50%; left: 50%; transform: translate(-50%, -50%);
  `;
  
  btn.addEventListener('mouseenter', () => btn.style.backgroundColor = '#444');
  btn.addEventListener('mouseleave', () => btn.style.backgroundColor = '#333');

  const isVertical = type === 'center';
  btn.style.width = isVertical ? '30px' : '14px';
  btn.style.height = isVertical ? '14px' : '30px';
  
  const state = paneState[type];
  btn.innerHTML = state.openIcon;
  
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.isCollapsed) {
      document.body.style.setProperty(state.cssVar, state.preCollapseValue || state.defaultSize);
      btn.innerHTML = state.openIcon;
      state.isCollapsed = false;
      localStorage.setItem(state.storageKey, state.preCollapseValue || state.defaultSize);
    } else {
      state.preCollapseValue = document.body.style.getPropertyValue(state.cssVar) || getComputedStyle(document.body).getPropertyValue(state.cssVar).trim();
      if (!state.preCollapseValue || state.preCollapseValue === '0px') state.preCollapseValue = state.defaultSize;
      document.body.style.setProperty(state.cssVar, '0px');
      btn.innerHTML = state.closeIcon;
      state.isCollapsed = true;
      localStorage.setItem(state.storageKey, '0px');
    }
  });

  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  
  resizer.appendChild(btn);
}

setupResizer(resizerLeft, 'left', 'col-resize');
setupResizer(resizerRight, 'right', 'col-resize');
setupResizer(resizerCenter, 'center', 'row-resize');

let resizerRafId = null;
window.addEventListener('mousemove', (e) => {
  if (!resizingState.left && !resizingState.right && !resizingState.center) return;

  if (resizerRafId) cancelAnimationFrame(resizerRafId);
  resizerRafId = requestAnimationFrame(() => {
    if (resizingState.left) {
      const newWidth = Math.max(100, Math.min(e.clientX, window.innerWidth - 400));
      document.body.style.setProperty('--left-width', `${newWidth}px`);
    } else if (resizingState.right) {
      const newWidth = Math.max(150, Math.min(window.innerWidth - e.clientX, window.innerWidth - 400));
      document.body.style.setProperty('--right-width', `${newWidth}px`);
    } else if (resizingState.center) {
      const centerPane = document.getElementById('center-pane');
      const rect = centerPane.getBoundingClientRect();
      const newHeight = Math.max(50, Math.min(e.clientY - rect.top, rect.height - 50));
      document.body.style.setProperty('--top-height', `${newHeight}px`);
    }
  });
});

window.addEventListener('mouseup', () => {
  ['left', 'right', 'center'].forEach(type => {
    if (resizingState[type]) {
      const state = paneState[type];
      localStorage.setItem(state.storageKey, document.body.style.getPropertyValue(state.cssVar));
      resizingState[type] = false;
      
      const resizer = type === 'left' ? resizerLeft : (type === 'right' ? resizerRight : resizerCenter);
      resizer.classList.remove('resizing');
    }
  });
  document.body.style.cursor = 'default';
});

function updateThumbnailSize() {
  const size = parseFloat(thumbnailSizeSlider.value) || 120;
  document.body.style.setProperty('--thumbnail-size', `${size}px`);
}

thumbnailSizeSlider.addEventListener('input', updateThumbnailSize);

thumbnailSizeSlider.addEventListener('change', (e) => {
  localStorage.setItem('thumbnailScale', e.target.value);
});

let windowStateTimer;
window.addEventListener('resize', () => {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(async () => {
    if (window.veloceAPI && window.veloceAPI.isViewerMaximized) {
      const isMax = await window.veloceAPI.isViewerMaximized();
      localStorage.setItem('mainWinMaximized', isMax);
      if (!isMax) {
        localStorage.setItem('mainWinWidth', window.outerWidth);
        localStorage.setItem('mainWinHeight', window.outerHeight);
        localStorage.setItem('mainWinX', window.screenX);
        localStorage.setItem('mainWinY', window.screenY);
      }
    }
  }, 500);
});

window.addEventListener('beforeunload', () => {
  if (localStorage.getItem('mainWinMaximized') !== 'true') {
    localStorage.setItem('mainWinX', window.screenX);
    localStorage.setItem('mainWinY', window.screenY);
  }
});

document.querySelectorAll('th').forEach(th => {
  th.addEventListener('click', () => {
	const key = th.dataset.sort;
	if (appState.sortConfig.key === key) {
	  appState.sortConfig.asc = !appState.sortConfig.asc;
	} else {
	  appState.sortConfig.key = key;
	  appState.sortConfig.asc = true;
	}
	localStorage.setItem('currentSort', JSON.stringify(appState.sortConfig));
	updateSortIndicators();
	appState.applyFiltersAndSort();
	window.uiManager.renderAll();
  });
});

window.addEventListener('keydown', async (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) {
    e.preventDefault();
    return;
  }

  if (e.key === 'F12') {
    e.preventDefault();
    return;
  }

  const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if ((activeTagName === 'input' || activeTagName === 'textarea') && e.key !== 'Escape') {
    return;
  }

  if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
    e.preventDefault();
    toggleHelpOverlay();
    return;
  }
  
  if (e.key === 'Escape' && document.getElementById('help-overlay')) {
    e.preventDefault();
    toggleHelpOverlay(false);
    return;
  }

  if (e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    if (window.veloceAPI.arrangeViewers) window.veloceAPI.arrangeViewers();
  }

  if (e.key === 'F5') {
    e.preventDefault();
    await refreshFileList();
  }

  if (e.key === 'F2') {
    e.preventDefault();
    const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
    if (selectedFolder) {
      renameSelectedFolder();
    } else {
      renameSelectedFile();
    }
  }

  if (e.key === 'Delete') {
    const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
    if (selectedFolder) {
      deleteSelectedFolder();
    } else {
      deleteSelectedFiles();
    }
  }

  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    if (window.getSelection().toString()) {
      showNotification('テキストをクリップボードにコピーしました');
      return;
    }

    if (appState.selectedIndex > -1 && appState.filteredFiles[appState.selectedIndex]) {
      window.veloceAPI.copyImageToClipboard(appState.filteredFiles[appState.selectedIndex].path);
      showNotification('画像をクリップボードにコピーしました');

      const applyFlash = (el) => {
        applyIconGlowEffect(el);
      };

      applyFlash(thumbnailGrid.querySelector(`.thumbnail-item[data-index="${appState.selectedIndex}"]`));
      applyFlash(fileListBody.querySelector(`tr[data-index="${appState.selectedIndex}"]`));
    }
  }

  if (e.ctrlKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
    e.preventDefault();
    const searchBar = document.getElementById('search-bar');
    if (searchBar) {
      searchBar.focus();
      searchBar.select();
    }
    return;
  }

  if (e.ctrlKey && (e.key.toLowerCase() === 'a' || e.code === 'KeyA')) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    e.preventDefault();
    if (appState.filteredFiles.length === 0) return;

    appState.selection.clear();
    for (let i = 0; i < appState.filteredFiles.length; i++) {
      appState.selection.add(i);
    }
    appState.selectedIndex = appState.filteredFiles.length - 1; 

    window.uiManager.updateSelectionUI();
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    if (appState.filteredFiles.length === 0) return;
    
    e.preventDefault();

    let newIndex = appState.selectedIndex;
    
    if (newIndex === -1) {
      newIndex = 0;
    } else {
      const containerWidth = thumbnailGrid.clientWidth;
      const itemSize = parseFloat(thumbnailSizeSlider.value) || 120;
      const gap = 8;
      const padding = 8;
      const availableWidth = Math.max(1, containerWidth - padding * 2);
      const columns = Math.max(1, Math.floor((availableWidth + gap) / (itemSize + gap)));

      if (e.key === 'ArrowLeft') newIndex = Math.max(0, appState.selectedIndex - 1);
      else if (e.key === 'ArrowRight') newIndex = Math.min(appState.filteredFiles.length - 1, appState.selectedIndex + 1);
      else if (e.key === 'ArrowUp') newIndex = Math.max(0, appState.selectedIndex - columns);
      else if (e.key === 'ArrowDown') newIndex = Math.min(appState.filteredFiles.length - 1, appState.selectedIndex + columns);
    }

    if (newIndex !== appState.selectedIndex) {
      if (e.shiftKey) {
        selectImage(newIndex, { shiftKey: true }); 
      } else {
        selectImage(newIndex);
      }
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// ----------------------------------------------------------------------------
// 4. Application Initialization
// ----------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
  const savedWinW = localStorage.getItem('mainWinWidth');
  const savedWinH = localStorage.getItem('mainWinHeight');
  const savedWinX = localStorage.getItem('mainWinX');
  const savedWinY = localStorage.getItem('mainWinY');
  const savedWinMax = localStorage.getItem('mainWinMaximized');

  if (savedWinW && savedWinH && window.veloceAPI && window.veloceAPI.resizeViewerWindow) {
    window.veloceAPI.resizeViewerWindow(parseInt(savedWinW, 10), parseInt(savedWinH, 10));
  }
  if (savedWinX && savedWinY && window.veloceAPI && window.veloceAPI.moveViewerWindow) {
    window.veloceAPI.moveViewerWindow(parseInt(savedWinX, 10), parseInt(savedWinY, 10));
  }
  if (savedWinMax === 'true' && window.veloceAPI && window.veloceAPI.isViewerMaximized && window.veloceAPI.maximizeViewer) {
    window.veloceAPI.isViewerMaximized().then(isMax => {
      if (!isMax) window.veloceAPI.maximizeViewer();
    });
  }

  initializeThumbnailObserver();

  ['left', 'right', 'center'].forEach(type => {
    const state = paneState[type];
    const savedVal = localStorage.getItem(state.storageKey);
    if (savedVal) {
      document.body.style.setProperty(state.cssVar, savedVal);
      if (savedVal === '0px') {
        state.isCollapsed = true;
        const resizer = type === 'left' ? resizerLeft : (type === 'right' ? resizerRight : resizerCenter);
        const btn = resizer.querySelector('.resizer-toggle');
        if (btn) btn.innerHTML = state.closeIcon;
      }
    }
  });

  const savedThumbScale = localStorage.getItem('thumbnailScale');
  if (savedThumbScale !== null && parseFloat(savedThumbScale) >= 100) {
    thumbnailSizeSlider.value = savedThumbScale;
  } else {
    thumbnailSizeSlider.value = 120; 
  }
  updateThumbnailSize();

  const searchBar = document.getElementById('search-bar');
  if (searchBar) {
    searchBar.addEventListener('input', (e) => {
      clearTimeout(appState.searchTimeout);
      appState.searchTimeout = setTimeout(() => {
        appState.searchQuery = e.target.value;
        scheduleRefresh();
      }, 300);
    });
  }

  const searchClearBtn = document.getElementById('search-clear-btn');
  if (searchClearBtn) {
    searchClearBtn.innerHTML = ICONS.ERASER;
    searchClearBtn.addEventListener('click', () => {
      if (searchBar) {
        searchBar.value = '';
        appState.searchQuery = '';
        scheduleRefresh();
        applyIconGlowEffect(searchClearBtn);
      }
    });
  }

  const openCacheBtn = document.getElementById('open-cache-btn');
  if (openCacheBtn) {
    openCacheBtn.addEventListener('click', () => {
      applyIconGlowEffect(openCacheBtn);
      window.veloceAPI.openThumbnailCache();
    });
  }

  const clearCacheBtn = document.getElementById('clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      applyIconGlowEffect(clearCacheBtn);
      const isConfirmed = await showCustomConfirm('すべてのサムネイルキャッシュを削除しますか？\nこの操作は元に戻せません。');
      if (isConfirmed) {
        window.uiManager.showToast('サムネイルキャッシュを削除しています...', 0, 'cache-clear', 'info');
        try {
          await window.veloceAPI.clearThumbnailCache();
          appState.thumbnailUrls.clear(); 
          resetThumbnailPreloader(); 
          await refreshFileList(); 
          window.uiManager.showToast('サムネイルキャッシュを削除しました。', 3000, 'cache-clear', 'success');
        } catch (err) {
          console.error("Failed to clear thumbnail cache:", err);
          window.uiManager.showToast('キャッシュの削除に失敗しました。', 3000, 'cache-clear', 'error');
        }
      }
    });
  }

  const savedSort = localStorage.getItem('currentSort');
  if (savedSort) {
    try {
      appState.sortConfig = JSON.parse(savedSort);
    } catch (e) {
      console.error('Failed to parse saved sort:', e);
    }
  }

  updateSortIndicators();

  if (promptText && promptText.parentElement) {
    Array.from(promptText.parentElement.children).forEach(child => {
      child.style.display = 'none';
    });
  }

  await refreshTree();

  if (window.veloceAPI.loadDirectory) {
    const savedDirectory = localStorage.getItem('currentDirectory') || 'PC';
    const result = await window.veloceAPI.loadDirectory(savedDirectory);
    if (result) {
      appState.currentDirectory = result.path;
      localStorage.setItem('currentDirectory', appState.currentDirectory); 
      appState.files = result.imageFiles || [];
      resetThumbnailPreloader();
      appState.applyFiltersAndSort();
      window.uiManager.renderAll();
      loadAllMetadataInBackground(); 
      clearMetadataUI();

      await expandTreeToPath(appState.currentDirectory);
    }
  }

  if (window.veloceAPI.onFileChanged) {
    window.veloceAPI.onFileChanged((newFile) => {
      const index = appState.files.findIndex(f => f.path === newFile.path);
      if (index > -1) {
        const oldFile = appState.files[index];
        if (oldFile.size !== newFile.size || oldFile.mtime !== newFile.mtime) {
            appState.thumbnailUrls.delete(newFile.path);
          appState.files[index] = { ...oldFile, size: newFile.size, mtime: newFile.mtime, width: 0, height: 0 };
          scheduleRefresh();
        }
      } else {
        appState.files.push(newFile);
        scheduleRefresh();
      }
    });
  }

  if (window.veloceAPI.onFileRemoved) {
    window.veloceAPI.onFileRemoved((path) => {
      const index = appState.files.findIndex(f => f.path === path);
      if (index > -1) {
        appState.files.splice(index, 1);
        scheduleRefresh();
      }
    });
  }

  if (window.veloceAPI.onDirectoryChanged) {
    window.veloceAPI.onDirectoryChanged(async () => {
      await refreshTree();
    });
  }

  if (!appState.isPreloadRunning) {
    appState.isPreloadRunning = true;
    requestIdleCallback(processIdleThumbnails);
  }
});
