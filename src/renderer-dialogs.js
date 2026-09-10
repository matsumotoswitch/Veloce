// ============================================================================
// Veloce - Dialog & Modal Management Module (renderer-dialogs.js)
// ============================================================================
// 本モジュールは、各種モーダルダイアログ（スマートフォルダ編集、お気に入り編集、
// 差分表示モーダル等）のUI生成・表示制御・イベントバインドおよび安全なクローズ処理を担当する。
//
// 主な責務:
// 1. スマートフォルダ編集モーダルの初期化、条件行UI生成、保存・更新処理
// 2. お気に入り編集モーダルの初期化、アイコンセレクター連携、保存処理
// 3. モーダル共通のクローズ処理（×ボタン、キャンセル、オーバーレイ背景クリック、Escapeキー）
// 4. Chromium 109 / Windows 8.1 互換のイベント管理とDOM更新
// ============================================================================

import { appState, SmartFolderStore } from './renderer-state.js';
import { createFavoriteEditorUI, uiManager } from './renderer-ui.js';

let sfModalDelegated = false;

/**
 * スマートフォルダ条件行のUI（演算子プルダウンおよび入力欄）を条件種別に応じて更新する。
 *
 * @param {HTMLElement} row - 条件行要素 (.sf-condition-row)
 * @param {string} type - 条件種別 ('prompt' | 'negative_prompt' | 'source' | 'width' | 'height' | 'rating' | 'aspect_ratio' | 'path')
 * @param {Object|null} initialCond - 既存条件データ
 */
export function updateSmartFolderRowUI(row, type, initialCond = null) {
  const typeSelect = row.querySelector('.cond-type-select');
  const typeInput = row.querySelector('.cond-type');
  const opSelect = row.querySelector('.cond-op-select');
  const opInput = row.querySelector('.cond-operator');
  const valueContainer = row.querySelector('.cond-value-container');

  if (typeInput) typeInput.value = type;
  if (typeSelect) {
    const typeLabel = typeSelect.querySelector('.custom-select-label');
    const typeItems = typeSelect.querySelectorAll('.custom-select-item');
    typeItems.forEach(i => {
      const match = i.dataset.value === type;
      i.classList.toggle('selected', match);
      if (match && typeLabel) typeLabel.textContent = i.textContent;
    });
  }

  const opVal = initialCond ? initialCond.operator : null;
  const valVal = initialCond ? initialCond.value : '';

  function setOpCustomSelect(ops) {
    if (!opSelect) return;
    const menu = opSelect.querySelector('.custom-select-menu');
    const label = opSelect.querySelector('.custom-select-label');
    const selectedOp = ops.find(o => o.value === opVal) || ops[0];

    if (menu) {
      menu.innerHTML = ops.map(o => `<div class="custom-select-item ${o.value === selectedOp.value ? 'selected' : ''}" data-value="${o.value}">${o.label}</div>`).join('');
    }
    if (label) label.textContent = selectedOp.label;
    if (opInput) opInput.value = selectedOp.value;
  }

  if (type === 'prompt' || type === 'negative_prompt') {
    setOpCustomSelect([
      { value: 'contains', label: 'を含む' },
      { value: 'not_contains', label: 'を含まない' }
    ]);
    valueContainer.innerHTML = '<input type="text" class="cond-value-input dialog-input flex-1" placeholder="キーワード">';
    valueContainer.querySelector('input').value = valVal;
  } else if (type === 'source') {
    setOpCustomSelect([
      { value: '==', label: 'と一致' },
      { value: '!=', label: 'と一致しない' }
    ]);
    valueContainer.innerHTML = '<input type="text" class="cond-value-input dialog-input flex-1" placeholder="生成元">';
    valueContainer.querySelector('input').value = valVal;
  } else if (type === 'width' || type === 'height') {
    setOpCustomSelect([
      { value: '<=', label: '以下' },
      { value: '==', label: 'ちょうど' },
      { value: '>=', label: '以上' }
    ]);
    valueContainer.innerHTML = '<input type="number" class="cond-value-input dialog-input flex-1" min="0">';
    valueContainer.querySelector('input').value = valVal || 0;
  } else if (type === 'rating') {
    setOpCustomSelect([
      { value: '>=', label: '以上' },
      { value: '<=', label: '以下' },
      { value: '==', label: 'と一致' }
    ]);
    valueContainer.innerHTML = '<input type="number" class="cond-value-input dialog-input flex-1" min="0" max="5">';
    valueContainer.querySelector('input').value = valVal || 0;
  } else if (type === 'aspect_ratio') {
    setOpCustomSelect([
      { value: 'portrait', label: '縦長' },
      { value: 'landscape', label: '横長' },
      { value: 'square', label: '正方形' }
    ]);
    valueContainer.innerHTML = '<div class="flex-1"></div><input type="hidden" class="cond-value-input" value="">';
  } else if (type === 'path') {
    setOpCustomSelect([
      { value: 'in_folder', label: '直下のみ' },
      { value: 'under_folder', label: 'サブフォルダ含む' }
    ]);
    valueContainer.innerHTML = `
      <input type="text" class="cond-value-input dialog-input cond-path-input flex-1">
      <button type="button" class="btn-browse-path dialog-btn">参照...</button>
    `;
    valueContainer.querySelector('input').value = valVal;
  }
}

/**
 * スマートフォルダ新規作成・編集モーダルを表示する。
 *
 * @param {Object} sf - 編集対象のスマートフォルダオブジェクト
 * @param {boolean} isNew - 新規作成フラグ
 * @param {Object} options - コールバック群 ({ createSmartFolderNode, refreshFileList, updateSmartFolderCountsUI })
 */
export function showEditSmartFolderModal(sf, isNew = false, options = {}) {
  try {
    const {
      createSmartFolderNode = null,
      refreshFileList = null,
      updateSmartFolderCountsUI = null
    } = options;

    const modal = document.getElementById('edit-smart-folder-modal');
    if (!modal) return;
    modal.style.display = ''; // Inline style のリセット
    const titleEl = document.getElementById('smart-modal-title');
    if (titleEl) {
      titleEl.textContent = isNew ? '新規スマートフォルダ' : 'スマートフォルダを編集';
    }
    const container = document.getElementById('smart-icon-selector');
    const getIconData = createFavoriteEditorUI(container, sf.icon || 'FAV_STAR', sf.color || 'orange');

    const nameInput = document.getElementById('smart-name-input');
    nameInput.value = sf.name || '';

    const conditionsList = document.getElementById('smart-conditions-list');
    const template = document.getElementById('sf-condition-template');
    const fragment = document.createDocumentFragment();
    const conds = Array.isArray(sf.conditions) ? sf.conditions : [];

    conds.forEach(cond => {
      const clone = template.content.cloneNode(true);
      const row = clone.querySelector('.sf-condition-row');
      const typeInput = row.querySelector('.cond-type');
      if (typeInput) typeInput.value = cond.type;
      updateSmartFolderRowUI(row, cond.type, cond);
      fragment.appendChild(clone);
    });
    conditionsList.replaceChildren(fragment);

    if (!sfModalDelegated) {
      sfModalDelegated = true;

      modal.addEventListener('click', async (e) => {
        const selectItem = e.target.closest('.custom-select-item');
        if (selectItem) {
          const parentSelect = selectItem.closest('.custom-select');
          if (parentSelect) {
            const hiddenInput = parentSelect.querySelector('input[type="hidden"]');
            const label = parentSelect.querySelector('.custom-select-label');
            const val = selectItem.dataset.value;

            parentSelect.querySelectorAll('.custom-select-item').forEach(i => i.classList.remove('selected'));
            selectItem.classList.add('selected');
            if (label) label.textContent = selectItem.textContent;
            if (hiddenInput) hiddenInput.value = val;
            parentSelect.classList.remove('open');
            parentSelect.classList.remove('open-up');

            const parentRow = parentSelect.closest('.sf-condition-row');
            if (parentRow) parentRow.classList.remove('open-select');

            if (parentSelect.classList.contains('cond-type-select')) {
              if (parentRow) updateSmartFolderRowUI(parentRow, val);
            }
          }
          return;
        }

        const customSelect = e.target.closest('.custom-select');
        if (customSelect) {
          e.stopPropagation();
          const isOpen = customSelect.classList.contains('open');

          modal.querySelectorAll('.custom-select.open').forEach(el => {
            el.classList.remove('open');
            el.classList.remove('open-up');
          });
          modal.querySelectorAll('.sf-condition-row.open-select').forEach(el => el.classList.remove('open-select'));

          if (!isOpen) {
            customSelect.classList.add('open');
            const row = customSelect.closest('.sf-condition-row');
            if (row) row.classList.add('open-select');

            const rect = customSelect.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;

            if (spaceBelow < 180 && rect.top > 200) {
              customSelect.classList.add('open-up');
            }
          }
          return;
        }

        modal.querySelectorAll('.custom-select.open').forEach(el => {
          el.classList.remove('open');
          el.classList.remove('open-up');
        });
        modal.querySelectorAll('.sf-condition-row.open-select').forEach(el => el.classList.remove('open-select'));

        if (e.target.closest('.btn-remove-cond')) {
          const row = e.target.closest('.sf-condition-row');
          if (row) {
            row.classList.add('row-fade-out');
            setTimeout(() => {
              if (row.parentNode) row.remove();
            }, 240);
          }
        }

        if (e.target.closest('#smart-add-condition-btn')) {
          const clone = template.content.cloneNode(true);
          const row = clone.querySelector('.sf-condition-row');
          const list = document.getElementById('smart-conditions-list');
          list.appendChild(clone);
          const newRow = list.lastElementChild;
          const typeInput = newRow.querySelector('.cond-type');
          if (typeInput) typeInput.value = 'rating';
          updateSmartFolderRowUI(newRow, 'rating', { operator: '>=', value: '4' });
        }

        if (e.target.closest('.btn-browse-path')) {
          const row = e.target.closest('.sf-condition-row');
          const input = row.querySelector('.cond-value-input');
          if (window.veloceAPI && window.veloceAPI.openFolderDialog) {
            const folder = await window.veloceAPI.openFolderDialog();
            if (folder) input.value = folder;
          }
        }
      });

      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.target && e.target.tagName === 'BUTTON') return;
          e.preventDefault();
          e.stopPropagation();
          document.getElementById('smart-save-btn').click();
        }
      });
    }

    const saveBtn = document.getElementById('smart-save-btn');
    const cancelBtn = document.getElementById('smart-cancel-btn');

    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      modal.classList.remove('show');
    });

    newSaveBtn.addEventListener('click', async () => {
      const rules = [];
      const rows = conditionsList.querySelectorAll('.sf-condition-row');
      for (const row of rows) {
        const type = row.querySelector('.cond-type').value;
        const operator = row.querySelector('.cond-operator').value;
        const valInput = row.querySelector('.cond-value-input');
        const value = valInput ? valInput.value.trim() : '';

        if (value === '' && type !== 'aspect_ratio' && type !== 'rating') {
          continue;
        }

        rules.push({ type, operator, value });
      }

      const data = getIconData();
      sf.icon = data.icon;
      sf.color = data.color;
      sf.name = nameInput.value || '無題のスマートフォルダ';
      sf.conditions = rules;
      sf.matchType = 'all';

      if (isNew) {
        sf.id = 'smart_' + Date.now();
      }
      appState.smartFolders = await SmartFolderStore.upsertFolder(sf);

      if (createSmartFolderNode) {
        if (isNew) {
          const listContainer = document.getElementById('smart-folders-list');
          if (listContainer) listContainer.appendChild(createSmartFolderNode(sf));
        } else {
          const oldNode = document.querySelector(`.smart-folder-item[data-id="${sf.id}"]`);
          if (oldNode) {
            const newNode = createSmartFolderNode(sf);
            if (oldNode.classList.contains('selected')) {
              newNode.classList.add('selected');
            }
            oldNode.replaceWith(newNode);
          }
        }
      }

      modal.classList.remove('show');

      if (appState.currentDirectory === 'smart://' + sf.id && refreshFileList) {
        refreshFileList(true);
      }

      if (updateSmartFolderCountsUI) {
        updateSmartFolderCountsUI();
      }
    });

    modal.classList.add('show');
  } catch (err) {
    console.error('showEditSmartFolderModal error:', err);
    if (uiManager && uiManager.showToast) {
      uiManager.showToast('Error: ' + err.message, 5000, 'error');
    }
  }
}

/**
 * お気に入り編集モーダルを表示する。
 *
 * @param {Object} fav - 編集対象のお気に入りオブジェクト
 * @param {Object} options - コールバック群 ({ renderFavorites, saveTabsState, renderTabs })
 */
export function showEditFavoriteModal(fav, options = {}) {
  const {
    renderFavorites = null,
    saveTabsState = null,
    renderTabs = null
  } = options;

  const modal = document.getElementById('edit-favorite-modal');
  if (modal) {
    modal.style.display = ''; // Inline style のリセット
  }
  const container = document.getElementById('fav-icon-selector');
  const getFavData = createFavoriteEditorUI(container, fav.icon, fav.color || 'default');

  const saveBtn = document.getElementById('fav-save-btn');
  const cancelBtn = document.getElementById('fav-cancel-btn');

  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.style.display = '';

  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  newCancelBtn.style.display = '';

  newCancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (modal) {
      modal.classList.remove('show');
      modal.style.display = '';
    }
  });

  newSaveBtn.addEventListener('click', () => {
    const data = getFavData();
    fav.icon = data.icon;
    fav.color = data.color;
    fav.name = document.getElementById('fav-name-input').value;
    fav.path = document.getElementById('fav-path-input').value;
    localStorage.setItem('favorites', JSON.stringify(appState.favorites));
    if (renderFavorites) renderFavorites();

    let tabUpdated = false;
    appState.tabs.forEach(t => {
      if (t.path === fav.path) {
        t.name = fav.name;
        tabUpdated = true;
      }
    });
    if (tabUpdated) {
      if (saveTabsState) saveTabsState();
      if (renderTabs) renderTabs();
      else if (uiManager && uiManager.renderTabs) uiManager.renderTabs();
    }

    if (modal) {
      modal.classList.remove('show');
      modal.style.display = '';
    }
  });

  const nameInput = document.getElementById('fav-name-input');
  nameInput.value = fav.name;
  document.getElementById('fav-path-input').value = fav.path;
  if (modal) {
    modal.classList.add('show');
  }
  nameInput.focus();
  nameInput.select();
}

/**
 * モーダル共通のイベントハンドラ（閉じるボタン、オーバーレイ背景クリック）を初期化する。
 */
export function initModalHandlers() {
  document.getElementById('fav-cancel-btn')?.addEventListener('click', () => {
    const m = document.getElementById('edit-favorite-modal');
    if (m) {
      m.classList.remove('show');
      m.style.display = '';
    }
  });

  document.getElementById('fav-modal-close-btn')?.addEventListener('click', () => {
    const m = document.getElementById('edit-favorite-modal');
    if (m) {
      m.classList.remove('show');
      m.style.display = '';
    }
  });

  document.getElementById('smart-modal-close-btn')?.addEventListener('click', () => {
    const m = document.getElementById('edit-smart-folder-modal');
    if (m) {
      m.classList.remove('show');
      m.style.display = '';
    }
  });

  document.getElementById('diff-close-btn')?.addEventListener('click', () => {
    document.getElementById('diff-modal')?.classList.remove('show');
  });

  document.getElementById('diff-bottom-close-btn')?.addEventListener('click', () => {
    document.getElementById('diff-modal')?.classList.remove('show');
  });

  // オーバーレイ背景クリック時の安全な閉じる処理
  window.addEventListener('click', (e) => {
    const diffModal = document.getElementById('diff-modal');
    if (diffModal && e.target === diffModal) {
      diffModal.classList.remove('show');
    }
    const favModal = document.getElementById('edit-favorite-modal');
    if (favModal && e.target === favModal) {
      favModal.classList.remove('show');
    }
    const sfModal = document.getElementById('edit-smart-folder-modal');
    if (sfModal && e.target === sfModal) {
      sfModal.classList.remove('show');
    }
  });
}

/**
 * Escapeキー押下時に開いている各種モーダルを安全に閉じる。
 *
 * @param {KeyboardEvent} [e] - キーボードイベント（提供された場合は preventDefault を実行）
 * @returns {boolean} モーダルが閉じられた場合は true、開いているモーダルがなければ false
 */
export function handleModalEscapeKey(e = null) {
  const diffModal = document.getElementById('diff-modal');
  if (diffModal && diffModal.classList.contains('show')) {
    if (e) e.preventDefault();
    diffModal.classList.remove('show');
    return true;
  }
  const favModal = document.getElementById('edit-favorite-modal');
  if (favModal && favModal.classList.contains('show')) {
    if (e) e.preventDefault();
    favModal.classList.remove('show');
    return true;
  }
  const sfModal = document.getElementById('edit-smart-folder-modal');
  if (sfModal && sfModal.classList.contains('show')) {
    if (e) e.preventDefault();
    sfModal.classList.remove('show');
    return true;
  }
  return false;
}
