// --- グローバル状態管理 ---
let currentFiles = []; // 現在のディレクトリ内の画像ファイルリスト
let filteredFiles = []; // 検索・ソート結果の表示用ファイルリスト
let currentSort = { key: 'name', asc: true }; // 現在のソート条件
let searchQuery = ''; // 現在の検索クエリ
let selectedIndex = -1; // 最後に選択された画像のインデックス
let selectedIndices = new Set(); // 複数選択された画像のインデックスセット
let currentDirectory = ''; // 現在表示しているディレクトリパス
let thumbnailObserver;
let currentMetaBatchId = 0; // フォルダ移動時にメタデータ読み込みをキャンセルするため
let currentMetaRequestId = 0; // 非同期パースの競合対策用
let currentRenderId = 0; // レンダリングのキャンセル用
let currentPromptBatchId = 0; // プロンプトバックグラウンド取得のキャンセル用
let thumbnailUrls = new Map(); // filepath -> assetUrl (サムネイルのキャッシュ)
let pendingThumbnails = new Set(); // filepath -> boolean (サムネイルリクエスト中フラグ)
let preloadCursor = 0; // バックグラウンド生成の検索カーソル
let isPreloadRunning = false; // バックグラウンド生成が稼働中かどうか

// --- トースト通知状態管理 ---
let thumbnailTotalRequested = 0;
let thumbnailCompleted = 0;
let thumbnailToastTimeout = null;

// --- ドラッグ＆ドロップ状態管理 ---
const dragState = {
  paths: [], // ドラッグ中の複数ファイルパス
  isAppDragging: false, // アプリ内からのドラッグ中かどうか
  pendingRefresh: false // ドラッグ終了後のリスト更新を待機しているか
};

// --- 定数定義 (アイコン) ---
// OSや環境に依存しないインラインSVGアイコン
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

// --- トースト通知機能 ---

/**
 * トースト通知を表示する
 * @param {string} message - 表示するメッセージ
 * @param {number} duration - 表示時間（ミリ秒）。0の場合は自動で消えない
 * @param {string|null} id - 通知のID。同じIDの場合は上書きされる
 * @param {'info' | 'success' | 'error' | 'warning'} [type='info'] - 通知の種類
 */
function showToast(message, duration = 3000, id = null, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  let toast = id ? document.getElementById(`toast-${id}`) : null;

  if (toast) {
    toast.textContent = message;
    // Reset type classes
    toast.classList.remove('success', 'error', 'warning');
  } else {
    toast = document.createElement('div');
    toast.className = 'toast-message';
    if (id) toast.id = `toast-${id}`;
    toast.textContent = message;
    container.appendChild(toast);
  }

  if (type !== 'info') {
    toast.classList.add(type);
  }

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  if (toast.timeoutId) {
    clearTimeout(toast.timeoutId);
  }

  if (duration > 0) {
    toast.timeoutId = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        if (toast.parentElement) toast.remove();
      }, 300);
    }, duration);
  }
}

/**
 * 汎用的な通知を表示する
 * @param {string} message - 表示するメッセージ
 * @param {'info' | 'warning'} [type='info'] - 通知の種類
 */
function showNotification(message, type = 'info') {
  showToast(message, 3000, null, type);
}

// --- コンテキストメニュー作成 ---
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

/**
 * コンテキストメニューのオプション要素を作成する
 * @param {string} text - メニュー項目のテキスト
 * @param {function} onClick - クリック時のコールバック
 * @returns {HTMLDivElement}
 */
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

/**
 * カスタムダイアログのベース要素を構築する内部関数
 * @param {string} message - ダイアログに表示するメッセージ
 * @param {HTMLElement} [contentElement] - メッセージの下に配置する追加要素
 * @returns {object} { buttonsDiv, cleanup } ボタンを追加するコンテナと破棄関数
 */
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

/**
 * カスタムダイアログ用のボタン要素を生成する
 * @param {string} text - ボタンテキスト
 * @param {string} bgColor - 背景色
 * @returns {HTMLButtonElement} 生成されたボタン要素
 */
function createDialogButton(text, bgColor) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `padding: 6px 16px; cursor: pointer; border: none; border-radius: 4px; font-family: inherit; font-size: inherit; background-color: ${bgColor}; color: #fff;`;
  return btn;
}

/**
 * ユーザー入力を求めるカスタムプロンプトダイアログを表示する
 * @param {string} message - 表示するメッセージ
 * @param {string} [defaultValue=''] - 入力欄の初期値
 * @param {boolean} [selectBaseNameOnly=false] - 拡張子を除いたベース名のみを選択状態にするか
 * @returns {Promise<string|null>} 入力された文字列。キャンセルされた場合は null
 */
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

/**
 * 確認を求めるカスタムダイアログを表示する
 * @param {string} message - 表示するメッセージ
 * @returns {Promise<boolean>} OKが押された場合は true、キャンセル時は false
 */
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

      // 親フォルダまで展開し、親フォルダ自身も展開状態（サブフォルダ表示）にする
      await expandTreeToPath(parentPath, true);
      const escapedParentPath = CSS.escape(parentPath);
      const parentDiv = document.querySelector(`.tree-item[data-path="${escapedParentPath}"]`);
      if (parentDiv && parentDiv.expandNode) {
        await parentDiv.expandNode();
      }

      // ツリーの選択状態（フォーカス）を、現在開いているディレクトリに戻す
      if (currentDirectory) {
        const escapedCurrent = CSS.escape(currentDirectory);
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
      if (currentDirectory.startsWith(oldPath)) {
        currentDirectory = currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', currentDirectory);
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
      if (currentDirectory.startsWith(oldPath)) {
        // 削除したフォルダ以下を表示していた場合、親フォルダに移動してリストを更新する
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      alert('フォルダの削除に失敗しました:\n' + (result ? result.error : 'Unknown error'));
    }
  }
});

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
      if (currentDirectory.startsWith(oldPath)) {
        currentDirectory = currentDirectory.replace(oldPath, result.path);
        localStorage.setItem('currentDirectory', currentDirectory);
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
      if (currentDirectory.startsWith(oldPath)) {
        const sep = '\\';
        const parts = oldPath.split(sep);
        parts.pop();
        let parentDir = parts.join(sep);
        if (!parentDir.includes(sep)) parentDir += sep;
        currentDirectory = parentDir;
        localStorage.setItem('currentDirectory', currentDirectory);
        await refreshFileList();
      }
      await refreshTree();
    } else {
      showNotification(`フォルダの削除に失敗しました: ${result ? result.error : '不明なエラー'}`, 'warning');
    }
  }
}

async function renameSelectedFile() {
  if (selectedIndex > -1 && filteredFiles[selectedIndex]) {
    const file = filteredFiles[selectedIndex];
    const newName = await showCustomPrompt('新しいファイル名を入力してください:', file.name, true);
    if (newName !== null && newName !== file.name) {
      if (newName.trim() === '') {
        showToast('ファイル名を入力してください。', 3000, 'file-rename', 'warning');
        return;
      }
      if (/[\\/:*?"<>|]/.test(newName)) {
        showToast('ファイル名に以下の文字は使用できません: \\ / : * ? " < > |', 3000, 'file-rename', 'warning');
        return;
      }

      const result = await window.veloceAPI.renameFile(file.path, newName);
      if (result && result.success) {
        showToast(`ファイル名を「${newName}」に変更しました`, 3000, 'file-rename', 'success');
        
        const newExt = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';
        
        const currentIdx = currentFiles.findIndex(f => f.path === file.path);
        if (currentIdx > -1) {
          currentFiles[currentIdx].path = result.path;
          currentFiles[currentIdx].name = newName;
          currentFiles[currentIdx].ext = newExt;
        }
        
        file.path = result.path;
        file.name = newName;
        file.ext = newExt;

        clearThumbnailCache();
        scheduleRefresh();
      } else {
        showToast(`ファイル名の変更に失敗しました: ${result ? result.error : '不明なエラー'}`, 3000, 'file-rename', 'warning');
      }
    }
  }
}

async function deleteSelectedFiles() {
  if (selectedIndices.size > 0) {
    const pathsToDelete = [];
    for (const i of selectedIndices) {
      if (filteredFiles[i]) pathsToDelete.push(filteredFiles[i].path);
    }

    selectedIndices.clear();
    selectedIndex = -1;
    updateSelectionUI();
    clearMetadataUI();

    let trashedCount = 0;
    const total = pathsToDelete.length;
    showToast(`${total}件のアイテムをゴミ箱に移動中...`, 0, 'file-trash', 'warning');
    
    for (const path of pathsToDelete) {
      try {
        const success = await window.veloceAPI.trashFile(path);
        if (success) trashedCount++;
      } catch (err) {
        console.error('Failed to trash file:', err);
      }
    }

    if (trashedCount > 0) {
      showToast(`${trashedCount}件のアイテムをゴミ箱に移動しました`, 3000, 'file-trash', 'warning');
    } else {
      showToast('ゴミ箱への移動に失敗しました', 3000, 'file-trash', 'warning');
    }
  }
}

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

// --- ドラッグツールチップの作成 ---
const dragTooltip = document.createElement('div');
dragTooltip.id = 'drag-tooltip';
dragTooltip.style.position = 'fixed';
dragTooltip.style.pointerEvents = 'none'; // マウスイベントを透過させてドロップの邪魔にならないようにする
dragTooltip.style.zIndex = '10000';
dragTooltip.style.padding = '4px 8px';
dragTooltip.style.backgroundColor = 'rgba(0, 0, 0, 1.0)'; // 背景を完全に不透明にする
dragTooltip.style.color = '#ffffff'; // 文字色を真っ白にする
dragTooltip.style.border = '1px solid #555'; // 視認性を高めるために薄い枠線を追加
dragTooltip.style.borderRadius = '4px';
dragTooltip.style.display = 'none';
dragTooltip.style.boxShadow = '0 2px 5px rgba(0,0,0,0.5)';
document.body.appendChild(dragTooltip);

// ドラッグ終了時にツールチップを隠す
document.addEventListener('dragend', async () => {
  dragTooltip.style.display = 'none';
  dragState.paths = [];
  dragState.isAppDragging = false;

  // ドラッグ操作が完全に終了してから、安全にUIを更新して古い画像を消去する
  if (dragState.pendingRefresh) {
    dragState.pendingRefresh = false;
    await refreshFileList();
  }
});

// --- ドラッグ時のOS標準ゴースト画像を消すための透明画像 ---
const emptyDragImage = new Image();
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// --- DOM要素のキャッシュ ---
const fileListBody = document.getElementById('file-list-body');
const thumbnailGrid = document.getElementById('center-bottom');
const promptText = document.getElementById('prompt-text');
const negativePromptText = document.getElementById('negative-prompt-text');
const dirTree = document.getElementById('dir-tree');
const thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');
const resizerLeft = document.getElementById('resizer-left');
const resizerRight = document.getElementById('resizer-right');
const resizerCenter = document.getElementById('resizer-center');

// --- イベントデリゲーション ---
// 数千件の要素に対して個別にイベントを登録するのを防ぎ、メモリ消費とレンダリング速度を改善
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
  
  if (!selectedIndices.has(index)) selectImage(index);
  const paths = Array.from(selectedIndices).map(idx => filteredFiles[idx].path);
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

  if (!selectedIndices.has(index)) selectImage(index);

  menuNewFolder.style.display = 'none';
  menuRenameFolder.style.display = 'none';
  menuDeleteFolder.style.display = 'none';
  menuRenameFile.style.display = selectedIndices.size === 1 ? 'block' : 'none'; // 複数選択時はリネーム不可
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

// --- UIリサイズ機能 ---
// ペインの折りたたみ状態を管理するフラグ
const paneState = {
  left: { isCollapsed: false, preCollapseValue: '', cssVar: '--left-width', storageKey: 'leftWidth', defaultSize: '250px', openIcon: ICONS.CHEVRON_LEFT, closeIcon: ICONS.CHEVRON_RIGHT },
  right: { isCollapsed: false, preCollapseValue: '', cssVar: '--right-width', storageKey: 'rightWidth', defaultSize: '250px', openIcon: ICONS.CHEVRON_RIGHT, closeIcon: ICONS.CHEVRON_LEFT },
  center: { isCollapsed: false, preCollapseValue: '', cssVar: '--top-height', storageKey: 'topHeight', defaultSize: '250px', openIcon: ICONS.CHEVRON_UP, closeIcon: ICONS.CHEVRON_DOWN }
};

// 各リザイザー（ペイン間の境界線）のドラッグ状態を管理するフラグ
const resizingState = { left: false, right: false, center: false };

/**
 * リサイズ境界線を設定し、ドラッグ操作とトグルボタンを初期化する
 * @param {HTMLElement} resizer - 境界線のDOM要素
 * @param {string} type - 'left', 'right', 'center'
 * @param {string} cursor - マウスカーソルの種類
 */
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

  // ドラッグ操作と干渉しないようイベント伝播を防止
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  
  resizer.appendChild(btn);
}

setupResizer(resizerLeft, 'left', 'col-resize');
setupResizer(resizerRight, 'right', 'col-resize');
setupResizer(resizerCenter, 'center', 'row-resize');

let resizerRafId = null;
window.addEventListener('mousemove', (e) => {
  // いずれかのリサイズがアクティブな場合、マウスの動きに合わせてペインの幅/高さを更新
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
  // リサイズが終了した（マウスボタンが離された）場合
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

// --- サムネイルサイズ変更機能 ---

function updateThumbnailSize() {
  // index.htmlで設定された min="100" max="500" の値をそのままピクセルサイズとして使用
  const size = parseFloat(thumbnailSizeSlider.value) || 120;
  document.body.style.setProperty('--thumbnail-size', `${size}px`);
}

thumbnailSizeSlider.addEventListener('input', updateThumbnailSize);

thumbnailSizeSlider.addEventListener('change', (e) => {
  localStorage.setItem('thumbnailScale', e.target.value);
});

// --- ウィンドウサイズ・位置の保存 ---
let windowStateTimer;
window.addEventListener('resize', () => {
  clearTimeout(windowStateTimer);
  // リサイズ中に連続で保存処理が走らないよう、操作後500ms待機して保存
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
  // 終了時、最大化されていなければ最終的な位置を確実に保存する
  if (localStorage.getItem('mainWinMaximized') !== 'true') {
    localStorage.setItem('mainWinX', window.screenX);
    localStorage.setItem('mainWinY', window.screenY);
  }
});

/**
 * フォルダ移動時に不要になったサムネイルのキャッシュをクリアする。
 * （現在はAsset URLを使用しているため、明示的なメモリ解放(revokeObjectURL)は不要です）
 */
function clearThumbnailCache() {
  thumbnailUrls.clear();
  pendingThumbnails.clear();
  preloadCursor = 0;
}

/**
 * サムネイル生成の進捗をトースト通知として更新する
 */
function updateThumbnailToast() {
  if (thumbnailTotalRequested === 0) return;
  
  if (thumbnailCompleted < thumbnailTotalRequested) {
    showToast(`サムネイル作成中 (${thumbnailCompleted}/${thumbnailTotalRequested})`, 0, 'thumbnail-progress', 'info');
  } else {
    showToast(`サムネイル作成完了 (${thumbnailTotalRequested}/${thumbnailTotalRequested})`, 0, 'thumbnail-progress');
    clearTimeout(thumbnailToastTimeout);
    thumbnailToastTimeout = setTimeout(() => {
       const t = document.getElementById('toast-thumbnail-progress');
       if (t) {
         t.classList.remove('show');
         setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
       }
       thumbnailTotalRequested = 0;
       thumbnailCompleted = 0;
    }, 1000);
  }
}

/**
 * サムネイルの遅延読み込みとメモリ解放のためのIntersectionObserverを初期化する
 */
function initializeThumbnailObserver() {
    const options = {
        root: document.getElementById('center-pane'), // 正しいスクロールコンテナを指定
        rootMargin: '400px 0px 400px 0px', // 少し広めに範囲を取る
    };
    thumbnailObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const img = entry.target;
            const filePath = img.dataset.filepath;
            if (entry.isIntersecting) {
                img.dataset.isVisible = 'true';
                if (filePath && !img.hasAttribute('src')) {
                    if (thumbnailUrls.has(filePath)) {
                        // すでにキャッシュがあればそれを使う
                        img.src = thumbnailUrls.get(filePath);
                    } else if (!pendingThumbnails.has(filePath)) {
                        // プレースホルダーを入れて二重リクエストを防止
                        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        
                        const requestRenderId = currentRenderId;
                        pendingThumbnails.add(filePath);

                        window.veloceAPI.getThumbnail(filePath).then(url => {
                            pendingThumbnails.delete(filePath);
                            if (currentRenderId !== requestRenderId) return; // フォルダ移動等で不要になった場合は破棄
                            
                            if (url) {
                                thumbnailUrls.set(filePath, url);
                                if (img.dataset.isVisible === 'true') {
                                    img.src = url;
                                }
                            } else {
                                // サムネイル生成失敗時はオリジナル画像をフォールバック表示
                                const fallbackUrl = window.veloceAPI.convertFileSrc(filePath);
                                thumbnailUrls.set(filePath, fallbackUrl);
                                if (img.dataset.isVisible === 'true') img.src = fallbackUrl;
                            }

                            thumbnailCompleted++;
                            updateThumbnailToast();
                        });
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

/**
 * ブラウザのアイドル時間を利用してバックグラウンドでサムネイルを事前生成する
 * @param {IdleDeadline} deadline 
 */
function processIdleThumbnails(deadline) {
  // スクロール操作などメインスレッドの負荷（IntersectionObserverの邪魔）を避けるため、
  // 同時にリクエストするサムネイル数を制限する
  if (pendingThumbnails.size > 2) {
    requestIdleCallback(processIdleThumbnails);
    return;
  }

  let targetFile = null;
  while (preloadCursor < filteredFiles.length) {
    const filePath = filteredFiles[preloadCursor].path;
    if (!thumbnailUrls.has(filePath) && !pendingThumbnails.has(filePath)) {
      targetFile = filePath;
      break;
    }
    preloadCursor++;
  }

  if (!targetFile) {
    isPreloadRunning = false;
    return;
  }

  pendingThumbnails.add(targetFile);

  window.veloceAPI.getThumbnail(targetFile).then(url => {
    pendingThumbnails.delete(targetFile);
    
    const finalUrl = url || window.veloceAPI.convertFileSrc(targetFile);
    thumbnailUrls.set(targetFile, finalUrl);

    thumbnailCompleted++;
    updateThumbnailToast();

    // DOM上に該当画像のimg要素があり、画面内に入っているのにsrcが空の場合は即座に反映する
    // (スクロールとプリロードのタイミングが被った場合のフェイルセーフ)
    const escapedPath = CSS.escape(targetFile);
    const img = document.querySelector(`.thumbnail-item[data-filepath="${escapedPath}"]`);
    if (img && img.dataset.isVisible === 'true' && !img.hasAttribute('src')) {
      img.src = finalUrl;
    }
  });

  // ループを継続
  requestIdleCallback(processIdleThumbnails);
}

/**
 * プロンプト情報（メタデータ）の表示をクリアして非表示にする。
 */
function clearMetadataUI() {
  const container = document.getElementById('metadata-container');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

/**
 * 選択状態のUI（クラス）を一括更新する。
 * querySelectorAllを使用せず、直接子要素を参照してパフォーマンスを劇的に向上させる。
 */
function updateSelectionUI() {
  // 全要素をループするのではなく、既に選択されている要素のクラスを外す
  const currentSelectedRows = fileListBody.querySelectorAll('.selected');
  for (let i = 0; i < currentSelectedRows.length; i++) currentSelectedRows[i].classList.remove('selected');
  
  const currentSelectedThumbs = thumbnailGrid.querySelectorAll('.selected');
  for (let i = 0; i < currentSelectedThumbs.length; i++) currentSelectedThumbs[i].classList.remove('selected');

  // 新たに選択された要素のみにクラスを付与する
  const rows = fileListBody.children;
  const thumbs = thumbnailGrid.children;
  for (const i of selectedIndices) {
    if (rows[i]) rows[i].classList.add('selected');
    if (thumbs[i]) thumbs[i].classList.add('selected');
  }
}

// AI等による連続したファイル生成に追従するための差分更新ロジック
let autoRefreshTimer = null;
function scheduleRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => {
    preloadCursor = 0;
    applySearchAndSort();

    renderAll();
    loadMetadataInBackground();
    updateSelectionUI();
    if (selectedIndex === -1) {
      clearMetadataUI();
    }
  }, 300); // バッチ処理等を考慮し、300ms間更新が止まったタイミングで描画する
}

/**
 * 現在表示しているディレクトリのファイルリストを再読み込みし、UIを更新する。
 * ファイルの削除や追加があった場合に呼び出される。
 */
async function refreshFileList() {
  if (!currentDirectory || !window.veloceAPI.loadDirectory) return;
  
  // メインプロセスにディレクトリの再読み込みを要求
  const result = await window.veloceAPI.loadDirectory(currentDirectory);
  if (!result) return;

  currentFiles = result.imageFiles || [];
  
  clearThumbnailCache(); // フォルダ移動時にキャッシュをクリーンアップ

  applySearchAndSort();

  renderAll();
  loadMetadataInBackground();
  loadPromptsInBackground();
  
  // 選択状態のUIを復元、またはリセット
  updateSelectionUI();
  if (selectedIndex > -1) {
    // selectImageを使うと複数選択が解除されるため、個別にメタデータのみ更新する
    const requestId = ++currentMetaRequestId;
    const meta = await window.veloceAPI.parseMetadata(filteredFiles[selectedIndex].path);
    if (currentMetaRequestId === requestId) renderMetadata(meta);
  } else {
    // 完全に選択が失われた場合（フォルダが空になった場合など）
    clearMetadataUI();
  }
}

/**
 * アプリケーションの初期化処理。DOMの読み込み完了後に実行される。
 */
window.addEventListener('DOMContentLoaded', async () => {
  // localStorageから前回のウィンドウサイズ・位置・最大化状態を復元
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

  // localStorageから前回のペインサイズを復元
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

  // localStorageから前回のサムネイルサイズ(100〜500)を復元
  const savedThumbScale = localStorage.getItem('thumbnailScale');
  if (savedThumbScale !== null && parseFloat(savedThumbScale) >= 100) {
    // 古いバージョン(0〜100)の値でない場合のみ復元する
    thumbnailSizeSlider.value = savedThumbScale;
  } else {
    thumbnailSizeSlider.value = 120; // 初期値（120px）
  }
  updateThumbnailSize();

  // 検索バーの初期化
  const searchBar = document.getElementById('search-bar');
  if (searchBar) {
    searchBar.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      scheduleRefresh();
    });
  }

  // 検索クリアボタンの初期化
  const searchClearBtn = document.getElementById('search-clear-btn');
  if (searchClearBtn) {
    searchClearBtn.innerHTML = ICONS.ERASER;
    searchClearBtn.addEventListener('click', () => {
      if (searchBar) {
        searchBar.value = '';
        searchQuery = '';
        scheduleRefresh();

        // コピーボタンと同じ発光エフェクト
        searchClearBtn.style.transition = 'none';
        searchClearBtn.style.color = '#fff';
        searchClearBtn.style.filter = 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 6px #ebc06d) drop-shadow(0 0 10px #ebc06d)';
        setTimeout(() => {
          searchClearBtn.style.transition = 'color 0.4s ease-out, filter 0.4s ease-out';
          searchClearBtn.style.color = '';
          searchClearBtn.style.filter = 'none';
          setTimeout(() => { searchClearBtn.style.transition = ''; }, 400);
        }, 100);
      }
    });
  }

  // ソート順の復元
  const savedSort = localStorage.getItem('currentSort');
  if (savedSort) {
    try {
      currentSort = JSON.parse(savedSort);
    } catch (e) {
      console.error('Failed to parse saved sort:', e);
    }
  }

  // ファイル一覧のヘッダーを初期化（ソート記号付き）
  updateSortIndicators();

  // 初期状態では右ペインのすべての要素を非表示にする
  if (promptText && promptText.parentElement) {
    Array.from(promptText.parentElement.children).forEach(child => {
      child.style.display = 'none';
    });
  }

  // --- ディレクトリツリーの初期化を先に実行（UIを即座に表示させるため） ---
  await refreshTree();

  // --- ツリー構築後にディレクトリの読み込みを行う ---
  if (window.veloceAPI.loadDirectory) {
    // localStorageから前回のディレクトリを復元、なければ 'PC'（ホームディレクトリ）
    const savedDirectory = localStorage.getItem('currentDirectory') || 'PC';
    const result = await window.veloceAPI.loadDirectory(savedDirectory);
    if (result) {
      currentDirectory = result.path;
      localStorage.setItem('currentDirectory', currentDirectory); // 有効なパスを保存
      currentFiles = result.imageFiles || [];
      clearThumbnailCache();
      applySearchAndSort();
      renderAll();
      loadMetadataInBackground(); // バックグラウンドでメタデータ読み込みを開始
      loadPromptsInBackground(); // プロンプトのバックグラウンド解析を開始
      clearMetadataUI();

      // ツリーを保存されていたディレクトリの階層まで自動展開する
      await expandTreeToPath(currentDirectory);
    }
  }

  if (window.veloceAPI.onFileChanged) {
    window.veloceAPI.onFileChanged((newFile) => {
      const index = currentFiles.findIndex(f => f.path === newFile.path);
      if (index > -1) {
        const oldFile = currentFiles[index];
        if (oldFile.size !== newFile.size || oldFile.mtime !== newFile.mtime) {
          currentFiles[index] = { ...oldFile, size: newFile.size, mtime: newFile.mtime, width: 0, height: 0 };
          scheduleRefresh();
        }
      } else {
        currentFiles.push(newFile);
        loadPromptsInBackground();
        scheduleRefresh();
      }
    });
  }

  if (window.veloceAPI.onFileRemoved) {
    window.veloceAPI.onFileRemoved((path) => {
      const index = currentFiles.findIndex(f => f.path === path);
      if (index > -1) {
        currentFiles.splice(index, 1);
        scheduleRefresh();
      }
    });
  }

  // バックグラウンドでのサムネイル事前生成ループを開始
  if (!isPreloadRunning) {
    isPreloadRunning = true;
    requestIdleCallback(processIdleThumbnails);
  }
});

/**
 * フォルダツリー全体を再構築し、現在のディレクトリを展開する。
 */
async function refreshTree() {
  if (!window.veloceAPI.getDrives) return;

  const scrollTop = dirTree.scrollTop;
  const scrollLeft = dirTree.scrollLeft;

  // バックグラウンド（メモリ上）で新しいツリーを構築し、チラつきを完全に防止する
  const tempContainer = document.createElement('div');
  const ul = document.createElement('ul');
  ul.className = 'tree-root';
  const drives = await window.veloceAPI.getDrives();
  for (const drive of drives) {
    ul.appendChild(createTreeNode({ name: drive, path: drive }, true));
  }
  tempContainer.appendChild(ul);

  if (currentDirectory) {
    // 画面に反映する前に、メモリ上のツリーを展開しきる
    await expandTreeToPath(currentDirectory, true, tempContainer);
  }

  // 構築が完全に終わったツリーを一気に画面に反映する
  dirTree.innerHTML = '';
  dirTree.appendChild(ul);

  // スクロール位置を正確に復元する
  dirTree.scrollTop = scrollTop;
  dirTree.scrollLeft = scrollLeft;
}

/**
 * 指定されたパスまでツリーをルートから再帰的に展開し、選択状態にする
 * @param {string} targetPath 展開する対象のディレクトリパス
 * @param {boolean} disableScroll スクロールを無効にするかどうか
 * @param {HTMLElement} rootElement 検索対象のルート要素（デフォルトはdocument）
 */
async function expandTreeToPath(targetPath, disableScroll = false, rootElement = document) {
  if (!targetPath || targetPath === 'PC') return;

  const separator = '\\';
  const parts = targetPath.split(separator).filter(p => p !== '');
  let pathsToExpand = [];
  
  // パスを階層ごとの文字列に分解する (例: "C:\A\B" -> ["C:\", "C:\A", "C:\A\B"])
  let current = parts[0] + separator;
  pathsToExpand.push(current);
  for(let i = 1; i < parts.length; i++) {
      current += parts[i];
      pathsToExpand.push(current);
      current += separator;
  }

  // ルートから順番にDOM要素を探して展開していく
  for (let i = 0; i < pathsToExpand.length; i++) {
      const p = pathsToExpand[i];
      // 属性セレクタに利用するため、パスのバックスラッシュ等をエスケープ
      const escapedPath = CSS.escape(p);
      const itemDiv = rootElement.querySelector(`.tree-item[data-path="${escapedPath}"]`);
      
      if (itemDiv) {
          if (i === pathsToExpand.length - 1) {
              // 最後の目的のフォルダを選択状態にする
              const activeItem = rootElement.querySelector('.tree-item.selected');
              if (activeItem) activeItem.classList.remove('selected');
              itemDiv.classList.add('selected');
              if (!disableScroll) {
                  itemDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
          } else {
              // 途中の階層なら、そのフォルダを展開（サブフォルダをロード）する
              if (itemDiv.expandNode) await itemDiv.expandNode();
          }
      } else {
          break; // パスが見つからない（削除された等）場合は展開を打ち切る
      }
  }
}

/**
 * ファイルツリーの各ノード（フォルダ）に対応するDOM要素を再帰的に生成する。
 * @param {object} folder - フォルダ情報（{ name, path }）。
 * @param {boolean} [isRoot=false] - このノードがルートノードかどうか。
 * @returns {HTMLLIElement} 生成されたツリーノードのli要素。
 */
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
    selectedIndices.clear();
    selectedIndex = -1;
    updateSelectionUI();
    
    if (window.veloceAPI.loadDirectory) {
      // クリックされたフォルダの画像一覧を中央ペインに表示
      const result = await window.veloceAPI.loadDirectory(folder.path);
      if (result) {
        currentDirectory = result.path;
        localStorage.setItem('currentDirectory', currentDirectory); // フォルダ移動時にパスを保存
        currentFiles = result.imageFiles || [];
        clearThumbnailCache();
        applySearchAndSort();
        renderAll();
        loadMetadataInBackground(); // ディレクトリ変更後もバックグラウンド読み込み
        loadPromptsInBackground();
        clearMetadataUI();
      }
    }

    const wasSelected = itemDiv.classList.contains('selected');

    // フォルダアイコン自体、または選択済みの項目を再度クリックした場合は開閉状態をトグルする
    if (e.target === icon || wasSelected) {
      const isExpanded = childrenUl.classList.contains('expanded');
      if (isExpanded) {
        collapseNode();
      } else {
        await expandNode();
      }
    } else {
      // 別の未選択項目をクリックした場合は、必ず展開する
      await expandNode();
    }
    
    // クリックされた項目を選択状態にし、他の項目は非選択にする
    const activeItem = document.querySelector('.tree-item.selected');
    if (activeItem) activeItem.classList.remove('selected');
    itemDiv.classList.add('selected');
  });

  // --- コンテキストメニュー (右クリック) の処理 ---
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
    // メニューが画面外にはみ出る場合は位置を内側にずらす
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height;
    
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
  });

  // --- ドラッグ＆ドロップ (ドロップ先) の処理 ---
  itemDiv.addEventListener('dragenter', (e) => {
    e.preventDefault();
    itemDiv.style.backgroundColor = 'rgba(58, 122, 254, 0.3)'; // ホバー時のハイライト
  });

  itemDiv.addEventListener('dragover', (e) => {
    e.preventDefault(); // ドロップを許可するために必要
    
    // ドライブレターが同じか判定（Windows想定。その他は常に'/'）
    let actionStr = 'コピー'; // 外部からのドロップのデフォルト
    if (dragState.paths.length > 0) {
      const getRoot = p => p.match(/^[A-Za-z]:/) ? p.match(/^[A-Za-z]:/)[0].toLowerCase() : '/';
      actionStr = getRoot(dragState.paths[0]) === getRoot(folder.path) ? '移動' : 'コピー';
    }
    // ブラウザの仕様に準拠した dropEffect を設定（copyMoveは無効な値のため除外）
    e.dataTransfer.dropEffect = actionStr === '移動' ? 'move' : 'copy';

    const folderName = isRoot ? folder.path : folder.name;
    const countStr = dragState.paths.length > 1 ? `${dragState.paths.length}個のファイルを ` : '';
    dragTooltip.textContent = `${countStr}「${folderName}」へ${actionStr}`;
    dragTooltip.style.display = 'block';
    dragTooltip.style.left = (e.clientX + 15) + 'px';
    dragTooltip.style.top = (e.clientY + 15) + 'px'; // ゴースト画像を消すため、見やすい右下の位置に戻す
  });

  itemDiv.addEventListener('dragleave', (e) => {
    // 子要素に乗った際の色抜けを防ぐ
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

      showToast(`${paths.length}件のファイルを${actionStr}中...`, 0, 'file-move', 'info');

      // ブラウザのドラッグ終了処理がフリーズするバグを完全に防ぐため、
      // ファイルの移動自体はすぐに行うが、UIの更新はドラッグ終了イベントまで待機する
      setTimeout(async () => {
        let successCount = 0;
        for (const p of paths) {
          const result = await window.veloceAPI.moveOrCopyFile(p, folder.path);
          if (result && result.success) {
            successCount++;
          }
        }
        if (successCount > 0) {
          showToast(`${successCount}件のファイルを${actionStr}しました`, 3000, 'file-move');
          if (dragState.isAppDragging) {
            dragState.pendingRefresh = true; // アプリ内ドラッグの場合は dragend で更新する
          } else {
            await refreshFileList(); // 外部からのドロップの場合はすぐに更新する
          }
        } else {
          showToast(`ファイルの${actionStr}に失敗しました`, 3000, 'file-move');
        }
      }, 10);
    }
  });

  return li;
}

/**
 * ドラッグ＆ドロップイベントからファイルパスの配列を抽出する。
 * アプリ内ドラッグの場合は状態変数から、外部からのドロップの場合はdataTransferから取得・サニタイズする。
 * @param {DragEvent} e - ドラッグイベントオブジェクト
 * @returns {string[]} 抽出されたファイルパスの配列
 */
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
    // ブラウザによって画像URLがセットされた場合のサニタイズ (file:///C:/... 等)
    let cleanPath = decodeURIComponent(sourcePath).trim();
    // file:/// や file:\ など、あらゆる形式のファイルスキームを確実に除去する
    cleanPath = cleanPath.replace(/^file:(?:\/|\\)*/i, '');
    if (!cleanPath.match(/^[A-Za-z]:/)) cleanPath = '/' + cleanPath;
    paths.push(cleanPath);
  }
  return paths;
}

// --- ソート機能 ---
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
      if (currentSort.key === key) {
        // ソート対象の列に昇順/降順のアイコンを追加する
        th.innerHTML = TABLE_HEADERS[key] + (currentSort.asc ? ICONS.SORT_ASC : ICONS.SORT_DESC);
      } else {
        th.textContent = TABLE_HEADERS[key];
      }
    }
  });
}

document.querySelectorAll('th').forEach(th => {
  th.addEventListener('click', () => {
	const key = th.dataset.sort;
	if (currentSort.key === key) {
	  currentSort.asc = !currentSort.asc;
	} else {
	  currentSort.key = key;
	  currentSort.asc = true;
	}
	localStorage.setItem('currentSort', JSON.stringify(currentSort));
	updateSortIndicators();
	applySearchAndSort();
	renderAll();
  });
});

/**
 * 検索クエリで currentFiles をフィルタリングし、ソート設定に基づいて並び替える。
 */
function applySearchAndSort() {
  // ソート後も選択状態を維持するためにパスを記録
  const selectedPath = selectedIndex > -1 && filteredFiles[selectedIndex] ? filteredFiles[selectedIndex].path : null;
  const selectedPaths = new Set(Array.from(selectedIndices).map(i => filteredFiles[i] ? filteredFiles[i].path : null).filter(Boolean));

  let files = currentFiles;

  if (searchQuery.trim() !== '') {
    const terms = searchQuery.toLowerCase().split(',').map(t => t.trim()).filter(t => t);
    
    files = files.filter(f => {
      const charPromptsText = f.charPrompts ? JSON.stringify(f.charPrompts) : '';
      const textToSearch = [f.name, f.prompt, f.negativePrompt, f.source, charPromptsText].filter(Boolean).join(' ').toLowerCase();
      return terms.every(term => textToSearch.includes(term));
    });
  }

  files.sort((a, b) => {
	let valA = a[currentSort.key] !== undefined ? a[currentSort.key] : 0;
	let valB = b[currentSort.key] !== undefined ? b[currentSort.key] : 0;
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
	if (valA < valB) return currentSort.asc ? -1 : 1;
	if (valA > valB) return currentSort.asc ? 1 : -1;
	return 0;
  });

  filteredFiles = files;

  selectedIndices.clear();
  selectedIndex = -1;
  filteredFiles.forEach((f, i) => {
    if (selectedPaths.has(f.path)) selectedIndices.add(i);
    if (f.path === selectedPath) selectedIndex = i;
  });

  if (window.veloceAPI && window.veloceAPI.syncImagePaths) {
    const sortedPaths = filteredFiles.map(f => f.path);
    window.veloceAPI.syncImagePaths(sortedPaths);
  }
}

// --- レンダリング関連 ---

/**
 * テーブルとグリッドの両方を再描画する。
 * 数千枚の画像がある場合でもUIがフリーズしないよう、チャンク分割して非同期に描画する。
 */
async function renderAll() {
  const renderId = ++currentRenderId;

  // 既存の画像の監視をすべて停止
  if (thumbnailObserver) {
      thumbnailObserver.disconnect();
  }

  // キャッシュ済み枚数の一括計算
  thumbnailTotalRequested = filteredFiles.length;
  thumbnailCompleted = filteredFiles.filter(f => thumbnailUrls.has(f.path)).length;
  // 初期進捗の反映
  if (thumbnailTotalRequested > 0 && thumbnailCompleted < thumbnailTotalRequested) {
    updateThumbnailToast();
  }

  // Clear existing content
  fileListBody.innerHTML = '';
  thumbnailGrid.innerHTML = '';

  // 画面サイズ変更時にサムネイルや余白が間延びしないようレイアウトを調整
  thumbnailGrid.style.display = 'flex';
  thumbnailGrid.style.flexWrap = 'wrap';
  thumbnailGrid.style.gap = '8px';
  thumbnailGrid.style.justifyContent = 'flex-start';
  thumbnailGrid.style.alignContent = 'flex-start';

  // ファイル一覧とサムネイルのコンテナを取得
  const fileListContainer = document.getElementById('center-top');

  // コンテンツの再描画後、各ペインのスクロール位置を先頭に戻す
  if (fileListContainer) fileListContainer.scrollTop = 0;
  if (thumbnailGrid) thumbnailGrid.scrollTop = 0;

  const CHUNK_SIZE = 100; // 一度に描画するDOMの数

  for (let i = 0; i < filteredFiles.length; i += CHUNK_SIZE) {
    // 別のフォルダが選択されるなどして新しい描画リクエストが来たら、現在の描画ループを中断する
    if (renderId !== currentRenderId) return;

    const chunk = filteredFiles.slice(i, i + CHUNK_SIZE);
    const tableFragment = document.createDocumentFragment();
    const gridFragment = document.createDocumentFragment();

    chunk.forEach((file, chunkIndex) => {
      const index = i + chunkIndex;
      const isSelected = selectedIndices.has(index);

      // --- テーブル行の作成 ---
      const tr = document.createElement('tr');
      if (isSelected) tr.classList.add('selected');
      tr.dataset.index = index;
      tr.innerHTML = `
        <td>${file.name}</td>
        <td>${file.ext}</td>
        <td style="text-align: right;">${file.width ? file.width.toLocaleString() : '-'}</td>
        <td style="text-align: right;">${file.height ? file.height.toLocaleString() : '-'}</td>
        <td style="text-align: right;">${file.size ? formatSize(file.size) : '-'}</td>
        <td>${file.mtime ? formatDate(file.mtime) : '-'}</td>
      `;
      
      tr.draggable = true;
      tableFragment.appendChild(tr);

      // --- サムネイルの作成 ---
      const img = document.createElement('img');
      if (isSelected) img.classList.add('selected');
      img.decoding = "async";
      img.dataset.filepath = file.path;
      img.dataset.index = index;
      img.className = 'thumbnail-item';
      img.style.objectFit = 'contain';
      img.style.width = 'var(--thumbnail-size)';
      img.style.height = 'var(--thumbnail-size)';
      
      img.draggable = true;
      gridFragment.appendChild(img);
      thumbnailObserver.observe(img);
    });

    fileListBody.appendChild(tableFragment);
    thumbnailGrid.appendChild(gridFragment);

    // メインスレッドのブロック（UIのフリーズ）を回避するため、次のフレームに処理を譲る
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // バックグラウンドでのサムネイル事前生成を再スタート
  if (!isPreloadRunning) {
    isPreloadRunning = true;
    requestIdleCallback(processIdleThumbnails);
  }
}

/**
 * ファイルサイズをバイト単位の文字列にフォーマットする。
 * @param {number} bytes - バイト単位のファイルサイズ。
 * @returns {string} フォーマットされた文字列 (例: "123,456")。
 */
function formatSize(bytes) {
  return bytes.toLocaleString();
}

/**
 * タイムスタンプを "yyyy/MM/dd hh:mm:ss" 形式の文字列にフォーマットする。
 * @param {number} timestamp - Unixタイムスタンプ (ミリ秒)。
 * @returns {string} フォーマットされた日時文字列。
 */
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

/**
 * 画像のメタデータ（幅、高さ）をバックグラウンドで非同期に読み込み、UIを更新する。
 * UIの応答性を維持するため、requestIdleCallbackを使用し、処理をチャンクに分割する。
 */
async function loadMetadataInBackground() {
  if (!window.veloceAPI.getImageMetadataBatch) return;

  // まだメタデータ（幅・高さ・サイズ・日時）が読み込まれていないファイルだけを抽出
  const filesToLoad = currentFiles.filter(f => !f.width && !f.height);
  if (filesToLoad.length === 0) return;

  const batchId = ++currentMetaBatchId;
  const pathsToLoad = filesToLoad.map(f => f.path);
  const CHUNK_SIZE = 200; // 並列処理されているため、チャンクサイズを増やして通信回数を減らす

  const processNextChunk = (chunkIndex) => {
    if (currentMetaBatchId !== batchId) return;

    if (chunkIndex >= pathsToLoad.length) {      showToast(`情報の読み込み完了 (${pathsToLoad.length}/${pathsToLoad.length})`, 1000, 'meta-progress');
      // すべてのメタデータ取得完了後、メタデータに依存するキーでソート中の場合は再ソートして再描画する
      if (['width', 'height'].includes(currentSort.key)) {
        sortFiles();
        renderAll();
      }
      return;
    }

    // ブラウザがアイドル状態のときまで処理を遅延させる
    requestIdleCallback(async () => {
      if (currentMetaBatchId !== batchId) return;
      
      try {
        const chunkPaths = pathsToLoad.slice(chunkIndex, chunkIndex + CHUNK_SIZE);
        showToast(`情報の読み込み中... (${Math.min(chunkIndex + CHUNK_SIZE, pathsToLoad.length)}/${pathsToLoad.length})`, 0, 'meta-progress', 'info');
        const metadataList = await window.veloceAPI.getImageMetadataBatch(chunkPaths);

        if (currentMetaBatchId !== batchId) return;

        // 高速な検索のために、パスからインデックスを引くMapを作成（O(1)検索）
        const pathToIndex = new Map();
        currentFiles.forEach((f, i) => pathToIndex.set(f.path, i));

        // 取得したメタデータで currentFiles と UI（テーブル）を更新
        metadataList.forEach(meta => {
          const fileIndex = pathToIndex.get(meta.path);
          if (fileIndex !== undefined && fileIndex > -1) {
            currentFiles[fileIndex].width = meta.width;
            currentFiles[fileIndex].height = meta.height;

            // 対応するテーブル行を更新
            const tableIndex = filteredFiles.findIndex(f => f.path === meta.path);
            if (tableIndex !== -1 && fileListBody.children[tableIndex]) {
              const row = fileListBody.children[tableIndex];
              row.children[2].textContent = meta.width ? meta.width.toLocaleString() : '-';
              row.children[3].textContent = meta.height ? meta.height.toLocaleString() : '-';
            }
          }
        });
      } catch (error) {
        console.error('Failed to load metadata in background:', error);
      }

      // 次のチャンクをスケジュール（現在のチャンクが完了した後にのみ実行し、並列IPC送信を厳密に防ぐ）
      processNextChunk(chunkIndex + CHUNK_SIZE);
    }, { timeout: 2000 }); // 2秒以内にアイドル状態にならなければ強制実行
  };

  processNextChunk(0);
}

/**
 * 画像のプロンプトなどのメタデータをバックグラウンドで解析し、検索可能にする。
 */
async function loadPromptsInBackground() {
  const batchId = ++currentPromptBatchId;
  const CHUNK_SIZE = 50; 
  const pathsToLoad = currentFiles.filter(f => !f.metaLoaded).map(f => f.path);
  
  const processNextChunk = (chunkIndex) => {
    if (currentPromptBatchId !== batchId || chunkIndex >= pathsToLoad.length) return;

    requestIdleCallback(async () => {
      if (currentPromptBatchId !== batchId) return;
      
      const chunkPaths = pathsToLoad.slice(chunkIndex, chunkIndex + CHUNK_SIZE);
      const pathToIndex = new Map();
      currentFiles.forEach((f, i) => pathToIndex.set(f.path, i));

      await Promise.all(chunkPaths.map(async (path) => {
        try {
          const meta = await window.veloceAPI.parseMetadata(path);
          const idx = pathToIndex.get(path);
          if (idx !== undefined) {
            currentFiles[idx].prompt = meta.prompt || '';
            currentFiles[idx].negativePrompt = meta.negativePrompt || '';
            currentFiles[idx].source = meta.source || '';
            if (meta.params && Array.isArray(meta.params.characterPrompts)) {
                currentFiles[idx].charPrompts = meta.params.characterPrompts;
            }
            currentFiles[idx].metaLoaded = true;
          }
        } catch (e) {}
      }));

      if (searchQuery.trim() !== '') scheduleRefresh();
      processNextChunk(chunkIndex + CHUNK_SIZE);
    });
  };
  
  processNextChunk(0);
}

/**
 * 画像が選択されたときの処理。UIの選択状態を更新し、メタデータを表示する。
 * @param {number} index - 選択された画像の `filteredFiles` 配列内でのインデックス。
 * @param {MouseEvent|KeyboardEvent} event - イベントオブジェクト（CtrlやShiftの判定用）
 */
async function selectImage(index, event = null) {
  const activeFolder = document.querySelector('#dir-tree .tree-item.selected');
  if (activeFolder) activeFolder.classList.remove('selected');

  if (event && event.ctrlKey) {
    // Ctrlキーで個別に選択/解除
    if (selectedIndices.has(index)) {
      selectedIndices.delete(index);
      if (selectedIndex === index) {
        selectedIndex = selectedIndices.size > 0 ? Array.from(selectedIndices).pop() : -1;
      }
    } else {
      selectedIndices.add(index);
      selectedIndex = index;
    }
  } else if (event && event.shiftKey && selectedIndex !== -1) {
    // Shiftキーで範囲選択
    const start = Math.min(selectedIndex, index);
    const end = Math.max(selectedIndex, index);
    selectedIndices.clear();
    for (let i = start; i <= end; i++) {
      selectedIndices.add(i);
    }
    selectedIndex = index;
  } else {
    // 通常のクリック（単一選択）
    selectedIndices.clear();
    selectedIndices.add(index);
    selectedIndex = index;
  }

  if (selectedIndex === -1) {
    updateSelectionUI();
    clearMetadataUI();
    return;
  }

  const file = filteredFiles[index];
  
  updateSelectionUI();

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
    // テーブルのヘッダーの裏に行が隠れてしまうのを防ぐため、
    // ヘッダーの高さを取得して行のスクロール時の余白（マージン）として設定する
    const thead = document.querySelector('#file-table thead');
    if (thead) {
      rows[index].style.scrollMarginTop = `${thead.getBoundingClientRect().height}px`;
    }
    
    // 標準機能で最短距離の表示位置へスクロールさせる
    // （scroll-margin-top が考慮されるため、自動的にヘッダーを避けてピタッと止まります）
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  // 現在リクエストしているパース処理のIDを発行
  const requestId = ++currentMetaRequestId;

  // インスペクターの更新
  const meta = await window.veloceAPI.parseMetadata(file.path);
  
  // 非同期処理中に別の画像が選択された場合は、古い結果を破棄して上書きを防ぐ
  if (currentMetaRequestId !== requestId) return;

  renderMetadata(meta);
}

/**
 * 検索キーワードに一致するテキストをハイライト表示する
 */
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

/**
 * メタデータをテキストボックスとして動的に生成・表示する
 * @param {object} meta - 解析されたメタデータ
 */
function renderMetadata(meta) {
  let container = document.getElementById('metadata-container');
  const rightPane = promptText ? promptText.parentElement : null;
  
  // AI生成のプロンプト情報があるかどうかを判定
  const hasAiMetadata = meta.prompt || meta.negativePrompt || meta.source || (meta.params && Object.keys(meta.params).length > 0);

  if (!container) {
    container = document.createElement('div');
    container.id = 'metadata-container';
    container.style.display = hasAiMetadata ? 'flex' : 'none';
    container.style.flexDirection = 'column';
    container.style.gap = '10px';
    container.style.width = '100%';
    container.style.boxSizing = 'border-box';
    container.style.paddingRight = '8px'; // 右ペインのスクロールバーと距離を離すための余白
    
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
    return; // プロンプト情報がない場合は何も表示しない
  }

  const terms = searchQuery.trim() !== '' ? searchQuery.toLowerCase().split(',').map(t => t.trim()).filter(t => t) : [];

  const addField = (label, value, isMultiline = false, customMinHeight = '80px') => {
    // 空文字の場合でも、プロンプト情報がある場合は空の枠を表示してレイアウトを崩さないようにする
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

    // コピー用アイコン (SVG)
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
        copyBtn.style.transition = 'none'; // 光るときは一瞬で
        copyBtn.style.color = '#fff'; // 芯を白く発光させる
        copyBtn.style.filter = 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 6px #ebc06d) drop-shadow(0 0 10px #ebc06d)';
        setTimeout(() => { 
          copyBtn.style.transition = 'color 0.4s ease-out, filter 0.4s ease-out'; // スッと早くフェードアウト
          copyBtn.style.color = copyBtn.matches(':hover') ? '#3a7afe' : '#888'; 
          copyBtn.style.filter = 'none';
        }, 100); // 100msだけ最高輝度を維持
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
  // メインのプロンプト表示枠の高さを倍(160px)に設定
  addField('プロンプト', meta.prompt, true, '160px');
  addField('除外したい要素', meta.negativePrompt, true, '160px');
  
  if (meta.params) {
    if (Array.isArray(meta.params.characterPrompts)) {
      meta.params.characterPrompts.forEach((char, idx) => {
        // キャラプロンプトは3行分がきっちり表示できるよう少し高め(90px)に設定
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
    // smオプションが有効な場合、NovelAIの表示に近づけるため(karras)を付与
    if (sampler && meta.params.sm && !sampler.includes('karras')) {
        sampler += " (karras)";
    }
    addField('サンプラー', sampler);
    
    addField('プロンプトガイダンス', meta.params.scale);
    addField('プロンプトガイダンスの再調整', meta.params.cfg_rescale);
    addField('除外したい要素の強さ', meta.params.uncond_scale);

    // Automatic1111などの未パースなパラメータがある場合のフォールバック表示
    if (meta.params.rawParameters) {
      addField('生成パラメータ', meta.params.rawParameters, true);
    }
  }
}

/**
 * 画像ビューアウィンドウを開く。
 * @param {number} index - 表示を開始する画像のインデックス。
 */
function openViewer(index) {
  const file = filteredFiles[index];

  window.veloceAPI.openViewer({ 
    currentIndex: index,
    width: file ? file.width : 0,
    height: file ? file.height : 0,
    monitorWidth: window.screen.availWidth,
    monitorHeight: window.screen.availHeight
  });
}

/**
 * ライセンス情報を表示するための簡易Markdownパーサー
 * @param {string} text - Markdown形式のテキスト
 * @returns {string} HTML文字列
 */
function parseLicenseMarkdown(text) {
  return text.split('\n').map(line => {
    let l = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (l.startsWith('### ')) return `<h3 style="color: #ebc06d; margin: 1em 0 0 0;">${l.substring(4)}</h3>`;
    if (l.startsWith('## ')) return `<h2 style="color: #ebc06d; margin: 1em 0 0 0; border-bottom: 1px solid #555; padding-bottom: 4px;">${l.substring(3)}</h2>`;
    if (l.startsWith('# ')) return `<h1 style="color: #ebc06d; margin: 0 0 0.5em 0; border-bottom: 1px solid #555; padding-bottom: 4px;">${l.substring(2)}</h1>`;
    if (l.startsWith('---')) return `<hr style="border: 0; border-top: 1px solid #555; margin: 1em 0;">`;
    if (l.startsWith('&gt; ')) return `<blockquote style="border-left: 4px solid #555; padding-left: 10px; margin: 0; color: #ebc06d;">${l.substring(5)}</blockquote>`;
    
    const links = [];
    l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (match, text, url) => {
      links.push(`<a href="${url}" target="_blank" style="color: #3a7afe; text-decoration: underline;">${text}</a>`);
      return `__LINK_${links.length - 1}__`;
    });
    
    l = l.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: #3a7afe; text-decoration: underline;">$1</a>');
    
    links.forEach((linkHtml, index) => {
      l = l.replace(`__LINK_${index}__`, linkHtml);
    });

    l = l.replace(/\*\*(.*?)\*\*/g, '<strong style="color: #fff;">$1</strong>');
    return l;
  }).join('\n');
}

/**
 * オープンソースライセンスを表示するダイアログを生成
 */
async function showLicenseDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'license-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
  overlay.style.zIndex = '10000'; // ヘルプ画面より上に表示
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
    // Rust側に定義したコマンドを呼び出して、LICENSE.md と CREDITS.md の内容を取得する
    if (window.__TAURI__ && window.__TAURI__.invoke) {
      licenseText = await window.__TAURI__.invoke('get_license_text');
    } else if (window.veloceAPI && window.veloceAPI.getLicenseText) {
      licenseText = await window.veloceAPI.getLicenseText();
    }
  } catch (e) {
    console.error("Failed to load licenses:", e);
    licenseText = "ライセンス情報の読み込みに失敗しました。";
  }

  const combinedText = [
    "# Veloce",
    "**Copyright (c) 2026 Veloce**",
    "License: PolyForm Noncommercial License 1.0.0",
    "",
    "> ※本ソフトウェアの商用利用（営利目的での利用、組み込み、販売など）は固く禁止されています。",
    "",
    "---",
    "",
    licenseText
  ].join('\n');

  const parsedText = combinedText.split('\n').map(line => {
    let l = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (l.startsWith('### ')) return '<h3 style="color: #ebc06d; margin: 1em 0 0 0;">' + l.substring(4) + '</h3>';
    if (l.startsWith('## ')) return '<h2 style="color: #ebc06d; margin: 1em 0 0 0; border-bottom: 1px solid #555; padding-bottom: 4px;">' + l.substring(3) + '</h2>';
    if (l.startsWith('# ')) return '<h1 style="color: #ebc06d; margin: 0 0 0.5em 0; border-bottom: 1px solid #555; padding-bottom: 4px;">' + l.substring(2) + '</h1>';
    if (l.startsWith('---')) return '<hr style="border: 0; border-top: 1px solid #555; margin: 1em 0;">';
    if (l.startsWith('&gt; ')) return '<blockquote style="border-left: 4px solid #555; padding-left: 10px; margin: 0; color: #ebc06d;">' + l.substring(5) + '</blockquote>';
    
    const links = [];
    l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (match, text, url) => {
      links.push('<a href="' + url + '" target="_blank" style="color: #3a7afe; text-decoration: underline;">' + text + '</a>');
      return '__LINK_' + (links.length - 1) + '__';
    });
    
    l = l.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: #3a7afe; text-decoration: underline;">$1</a>');
    
    links.forEach((linkHtml, index) => {
      l = l.replace('__LINK_' + index + '__', linkHtml);
    });

    l = l.replace(/\*\*(.*?)\*\*/g, '<strong style="color: #fff;">$1</strong>');
    return l;
  }).join('\n');

  content.innerHTML = `
    <h2 style="margin-top: 0; color: #ebc06d;">ライセンス情報</h2>
    <div style="flex: 1; overflow-y: auto; background-color: #2d2d2d; padding: 20px; border: 1px solid #444; border-radius: 4px; color: #ccc; font-family: sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${parsedText}</div>
    <div style="text-align: right; margin-top: 15px;">
      <button id="close-license-btn" style="padding: 8px 24px; background-color: #3a7afe; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">閉じる</button>
    </div>
  `;
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  
  overlay.appendChild(content);
  document.body.appendChild(overlay);
  
  document.getElementById('close-license-btn').addEventListener('click', () => {
    overlay.remove();
  });
}

/**
 * ヘルプ（ショートカット一覧）をオーバーレイ表示/非表示する
 */
function toggleHelpOverlay(forceShow) {
  let overlay = document.getElementById('help-overlay');
  
  // 既に表示されている場合は非表示にする (トグル動作)
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
  overlay.style.webkitBackdropFilter = 'blur(10px)'; // Safari対応
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
            <tr><td style="padding: 6px 15px; font-weight: bold;">A</td><td style="padding: 6px 15px;">開いているビューワーを横一列に並べる</td></tr>
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
          <tr><td style="padding: 6px 15px; font-weight: bold;">↑ / ↓</td><td style="padding: 6px 15px;">右 / 左に90度回転</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">0</td><td style="padding: 6px 15px;">100%表示 (大きい画像はフィット)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">1</td><td style="padding: 6px 15px;">完全な100%表示 (画面外にはみ出す)</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">Enter</td><td style="padding: 6px 15px;">ズーム解除 / 強制フィット切替</td></tr>
          <tr><td style="padding: 6px 15px; font-weight: bold;">F11</td><td style="padding: 6px 15px;">フルスクリーン切替</td></tr>
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
  
  // 画面のどこをクリックしてもヘルプを閉じる（ライセンスリンク以外）
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

// --- キーボードショートカット ---
window.addEventListener('keydown', async (e) => {
  // Ctrl+Shift+I で開発者ツールをトグル表示
  if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    if (window.veloceAPI.toggleDevtools) window.veloceAPI.toggleDevtools();
    return;
  }

  // 入力フィールド（テキストボックス等）にフォーカスがある場合は、文字入力やテキストのコピー（Ctrl+C）、カーソル移動などの標準動作を優先する
  const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  if ((activeTagName === 'input' || activeTagName === 'textarea') && e.key !== 'Escape') {
    return;
  }

  // F1またはHでヘルプ表示のトグル
  if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
    e.preventDefault();
    toggleHelpOverlay();
    return;
  }
  
  // Escでヘルプを閉じる
  if (e.key === 'Escape' && document.getElementById('help-overlay')) {
    e.preventDefault();
    toggleHelpOverlay(false);
    return;
  }

  // Aでビューワーを横に並べる
  if (e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    if (window.veloceAPI.arrangeViewers) window.veloceAPI.arrangeViewers();
  }

  // F5で最新の情報に更新
  if (e.key === 'F5') {
    e.preventDefault();
    await refreshFileList();
  }

  // F2でファイル名を変更
  if (e.key === 'F2') {
    e.preventDefault();
    const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
    if (selectedFolder) {
      renameSelectedFolder();
    } else {
      renameSelectedFile();
    }
  }

  // Deleteで選択中の画像をゴミ箱に移動
  if (e.key === 'Delete') {
    const selectedFolder = document.querySelector('#dir-tree .tree-item.selected');
    if (selectedFolder) {
      deleteSelectedFolder();
    } else {
      deleteSelectedFiles();
    }
  }

  // Ctrl+Cで選択中の画像をクリップボードにコピー
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    if (window.getSelection().toString()) {
      showNotification('テキストをクリップボードにコピーしました');
      return;
    }

    if (selectedIndex > -1 && filteredFiles[selectedIndex]) {
      window.veloceAPI.copyImageToClipboard(filteredFiles[selectedIndex].path);
      showNotification('画像をクリップボードにコピーしました');

      // コピー成功時に選択中の画像をピカッと光らせるエフェクト
      const applyFlash = (el) => {
        if (!el) return;
        const originalTransition = el.style.transition;
        const originalFilter = el.style.filter;
        
        el.style.transition = 'none';
        el.style.filter = 'drop-shadow(0 0 3px #ebc06d) drop-shadow(0 0 6px #ebc06d) brightness(1.1)';
        
        setTimeout(() => {
          el.style.transition = 'filter 0.4s ease-out';
          el.style.filter = originalFilter || 'none';
          setTimeout(() => {
            el.style.transition = originalTransition;
            if (!originalFilter) el.style.removeProperty('filter');
          }, 400);
        }, 100);
      };

      applyFlash(thumbnailGrid.querySelector(`.thumbnail-item[data-index="${selectedIndex}"]`));
      applyFlash(fileListBody.querySelector(`tr[data-index="${selectedIndex}"]`));
    }
  }

  // 上下左右キーで画像の選択を移動
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    if (filteredFiles.length === 0) return;
    
    // 矢印キーによる画面のスクロールを防ぐ
    e.preventDefault();

    let newIndex = selectedIndex;
    
    // まだ画像が選択されていない場合は最初の画像を選択
    if (newIndex === -1) {
      newIndex = 0;
    } else {
      const containerWidth = thumbnailGrid.clientWidth;
      const itemSize = parseFloat(thumbnailSizeSlider.value) || 120;
      const gap = 8;
      const padding = 10;
      const availableWidth = Math.max(1, containerWidth - padding * 2);
      const columns = Math.max(1, Math.floor((availableWidth + gap) / (itemSize + gap)));

      // 移動先インデックスの計算
      if (e.key === 'ArrowLeft') newIndex = Math.max(0, selectedIndex - 1);
      else if (e.key === 'ArrowRight') newIndex = Math.min(filteredFiles.length - 1, selectedIndex + 1);
      else if (e.key === 'ArrowUp') newIndex = Math.max(0, selectedIndex - columns);
      else if (e.key === 'ArrowDown') newIndex = Math.min(filteredFiles.length - 1, selectedIndex + columns);
    }

    // 選択が変更された場合
    if (newIndex !== selectedIndex) {
      if (e.shiftKey) {
        selectImage(newIndex, { shiftKey: true }); // Shift+矢印で範囲選択
      } else {
        selectImage(newIndex);
      }
    }
  }
});
