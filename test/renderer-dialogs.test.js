import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  updateSmartFolderRowUI,
  showEditSmartFolderModal,
  showEditFavoriteModal,
  initModalHandlers,
  handleModalEscapeKey
} from '../src/renderer-dialogs.js';
import { appState, SmartFolderStore } from '../src/renderer-state.js';

describe('renderer-dialogs.js - Modal and Dialog Management', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="diff-modal" class="modal-backdrop">
        <button id="diff-close-btn"></button>
        <button id="diff-bottom-close-btn"></button>
      </div>

      <div id="edit-favorite-modal" class="modal-backdrop">
        <button id="fav-modal-close-btn"></button>
        <div id="fav-icon-selector"></div>
        <input id="fav-name-input" type="text" />
        <input id="fav-path-input" type="text" />
        <button id="fav-save-btn">保存</button>
        <button id="fav-cancel-btn">キャンセル</button>
      </div>

      <div id="edit-smart-folder-modal" class="modal-backdrop">
        <h2 id="smart-modal-title"></h2>
        <button id="smart-modal-close-btn"></button>
        <div id="smart-icon-selector"></div>
        <input id="smart-name-input" type="text" />
        <div id="smart-conditions-list"></div>
        <button id="smart-add-condition-btn">条件追加</button>
        <button id="smart-save-btn">保存</button>
        <button id="smart-cancel-btn">キャンセル</button>
      </div>

      <template id="sf-condition-template">
        <div class="sf-condition-row">
          <input type="hidden" class="cond-type" value="prompt" />
          <div class="custom-select cond-type-select">
            <span class="custom-select-label">プロンプト</span>
            <div class="custom-select-menu">
              <div class="custom-select-item selected" data-value="prompt">プロンプト</div>
              <div class="custom-select-item" data-value="rating">レーティング</div>
              <div class="custom-select-item" data-value="path">パス</div>
            </div>
          </div>
          <input type="hidden" class="cond-operator" value="contains" />
          <div class="custom-select cond-op-select">
            <span class="custom-select-label">を含む</span>
            <div class="custom-select-menu"></div>
          </div>
          <div class="cond-value-container"></div>
          <button type="button" class="btn-remove-cond">削除</button>
        </div>
      </template>
    `;

    appState.favorites = [];
    appState.smartFolders = [];
    appState.tabs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateSmartFolderRowUI', () => {
    it('sets up prompt condition row elements correctly', () => {
      const template = document.getElementById('sf-condition-template');
      const clone = template.content.cloneNode(true);
      const row = clone.querySelector('.sf-condition-row');

      updateSmartFolderRowUI(row, 'prompt', { operator: 'contains', value: 'masterpiece' });

      const input = row.querySelector('.cond-value-input');
      expect(input).not.toBeNull();
      expect(input.value).toBe('masterpiece');
      expect(input.placeholder).toBe('キーワード');

      const opInput = row.querySelector('.cond-operator');
      expect(opInput.value).toBe('contains');
    });

    it('sets up rating condition row elements correctly', () => {
      const template = document.getElementById('sf-condition-template');
      const clone = template.content.cloneNode(true);
      const row = clone.querySelector('.sf-condition-row');

      updateSmartFolderRowUI(row, 'rating', { operator: '>=', value: 4 });

      const input = row.querySelector('.cond-value-input');
      expect(input).not.toBeNull();
      expect(input.type).toBe('number');
      expect(input.min).toBe('0');
      expect(input.max).toBe('5');
      expect(input.value).toBe('4');
    });

    it('sets up path condition row with browse button', () => {
      const template = document.getElementById('sf-condition-template');
      const clone = template.content.cloneNode(true);
      const row = clone.querySelector('.sf-condition-row');

      updateSmartFolderRowUI(row, 'path', { operator: 'under_folder', value: 'C:/Images' });

      const input = row.querySelector('.cond-path-input');
      expect(input).not.toBeNull();
      expect(input.value).toBe('C:/Images');

      const browseBtn = row.querySelector('.btn-browse-path');
      expect(browseBtn).not.toBeNull();
      expect(browseBtn.textContent).toBe('参照...');
    });
  });

  describe('showEditSmartFolderModal', () => {
    it('opens modal with new smart folder title and saves data on save button click', async () => {
      const upsertSpy = vi.spyOn(SmartFolderStore, 'upsertFolder').mockResolvedValue([]);
      const updateCountsSpy = vi.fn();

      const newSf = { name: '', icon: 'FAV_STAR', color: 'orange', conditions: [] };
      showEditSmartFolderModal(newSf, true, {
        updateSmartFolderCountsUI: updateCountsSpy
      });

      const modal = document.getElementById('edit-smart-folder-modal');
      expect(modal.classList.contains('show')).toBe(true);

      const titleEl = document.getElementById('smart-modal-title');
      expect(titleEl.textContent).toBe('新規スマートフォルダ');

      const nameInput = document.getElementById('smart-name-input');
      nameInput.value = 'My Smart Folder';

      const saveBtn = document.getElementById('smart-save-btn');
      saveBtn.click();
      await new Promise(r => setTimeout(r, 10));

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(newSf.name).toBe('My Smart Folder');
      expect(modal.classList.contains('show')).toBe(false);
      expect(updateCountsSpy).toHaveBeenCalled();
    });

    it('closes modal on cancel button click', () => {
      const sf = { id: 'sf_1', name: 'Test', icon: 'FAV_STAR', color: 'blue', conditions: [] };
      showEditSmartFolderModal(sf, false);

      const modal = document.getElementById('edit-smart-folder-modal');
      expect(modal.classList.contains('show')).toBe(true);

      const cancelBtn = document.getElementById('smart-cancel-btn');
      cancelBtn.click();

      expect(modal.classList.contains('show')).toBe(false);
    });
  });

  describe('showEditFavoriteModal', () => {
    it('opens favorite modal and saves changes to localStorage', () => {
      const fav = { id: 'fav_1', name: 'Original Name', path: 'C:/Photos', icon: 'FAV_FOLDER', color: 'default' };
      appState.favorites = [fav];

      const renderFavoritesSpy = vi.fn();
      showEditFavoriteModal(fav, { renderFavorites: renderFavoritesSpy });

      const modal = document.getElementById('edit-favorite-modal');
      expect(modal.classList.contains('show')).toBe(true);

      const nameInput = document.getElementById('fav-name-input');
      expect(nameInput.value).toBe('Original Name');
      nameInput.value = 'Updated Name';

      const saveBtn = document.getElementById('fav-save-btn');
      saveBtn.click();

      expect(fav.name).toBe('Updated Name');
      expect(renderFavoritesSpy).toHaveBeenCalled();
      expect(modal.classList.contains('show')).toBe(false);
    });
  });

  describe('handleModalEscapeKey and initModalHandlers', () => {
    it('closes open modals in priority order when escape is pressed', () => {
      const diffModal = document.getElementById('diff-modal');
      const favModal = document.getElementById('edit-favorite-modal');
      const sfModal = document.getElementById('edit-smart-folder-modal');

      // None open
      expect(handleModalEscapeKey()).toBe(false);

      // sfModal open
      sfModal.classList.add('show');
      expect(handleModalEscapeKey()).toBe(true);
      expect(sfModal.classList.contains('show')).toBe(false);

      // favModal open
      favModal.classList.add('show');
      expect(handleModalEscapeKey()).toBe(true);
      expect(favModal.classList.contains('show')).toBe(false);

      // diffModal open
      diffModal.classList.add('show');
      expect(handleModalEscapeKey()).toBe(true);
      expect(diffModal.classList.contains('show')).toBe(false);
    });

    it('initializes modal close buttons and overlay click handlers', () => {
      initModalHandlers();

      const diffModal = document.getElementById('diff-modal');
      diffModal.classList.add('show');

      const diffCloseBtn = document.getElementById('diff-close-btn');
      diffCloseBtn.click();
      expect(diffModal.classList.contains('show')).toBe(false);

      // Overlay click test
      diffModal.classList.add('show');
      diffModal.dispatchEvent(new MouseEvent('click', { bubbles: true, target: diffModal }));
      expect(diffModal.classList.contains('show')).toBe(false);
    });
  });
});
