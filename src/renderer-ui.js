import { appState } from './renderer-state.js';

const CHUNK_SIZE = 100;

function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '-';
  return bytes.toLocaleString();
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  // Rust側のUnixタイムスタンプ(秒)とJSのミリ秒の違いを吸収
  const ms = timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}/${MM}/${dd} ${hh}:${mm}:${ss}`;
}

/**
 * メイン画面のUIとDOM操作を管理するクラス
 */
class UIManager {
  static ICONS = {
    DRIVE: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#a0a0a0" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`,
    FOLDER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#ebc06d" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    CHEVRON_LEFT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
    CHEVRON_RIGHT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
    CHEVRON_UP: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
    CHEVRON_DOWN: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
    SORT_ASC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
    SORT_DESC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
    ERASER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>`,
    COPY: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`
  };

  /**
   * コピーボタンのHTMLを生成します。
   * @param {string} text コピー対象のテキスト
   * @returns {string} ボタンのHTML
   */
  static createCopyButtonHTML(text) {
    if (!text || text === '-') return '';
    const escaped = String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="diff-copy-btn" title="コピー" data-copy-text="${escaped}">
        ${UIManager.ICONS.COPY}
      </span>`;
  }

  /**
   * @param {AppState} state - アプリケーション状態のインスタンス
   */
  constructor(state) {
    this.state = state;
    // 頻繁に操作するDOM要素はここで取得しておく
    /**
     * @type {{
     *   fileListBody: HTMLElement,
     *   thumbnailGrid: HTMLElement,
     *   dirTree: HTMLElement,
     *   thumbnailSizeSlider: HTMLInputElement,
     *   resizerLeft: HTMLElement,
     *   resizerRight: HTMLElement,
     *   resizerCenter: HTMLElement,
     *   searchBar: HTMLInputElement,
     *   searchClearBtn: HTMLElement,
     *   openCacheBtn: HTMLElement,
     *   clearCacheBtn: HTMLElement
     * }}
     */
    this.elements = {
      fileListBody: document.getElementById('file-list-body'),
      thumbnailGrid: document.getElementById('center-bottom'),
      dirTree: document.getElementById('dir-tree'),
      thumbnailSizeSlider: document.getElementById('thumbnail-size-slider'),
      resizerLeft: document.getElementById('resizer-left'),
      resizerRight: document.getElementById('resizer-right'),
      resizerCenter: document.getElementById('resizer-center'),
      searchBar: document.getElementById('search-bar'),
      searchClearBtn: document.getElementById('search-clear-btn'),
      openCacheBtn: document.getElementById('open-cache-btn'),
      clearCacheBtn: document.getElementById('clear-cache-btn')
    };
    this.toastContainer = document.getElementById('toast-container');
  }

  /**
   * トースト通知を画面に表示します。
   * @param {string} message - 表示するメッセージ
   * @param {number} [duration=3000] - 表示する時間(ミリ秒)。0の場合は自動で消えません。
   * @param {string|null} [id=null] - トーストの一意なID。既存のトーストを更新する場合に使用。
   * @param {string} [type='info'] - トーストの種類 ('info', 'success', 'warning', 'error')
   */
  showToast(message, duration = 3000, id = null, type = 'info') {
    if (!this.toastContainer) {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
      this.toastContainer = container;
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
      this.toastContainer.appendChild(toast);
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
   * カスタムプロンプトダイアログを表示します。
   * @param {string} message 
   * @param {string} defaultValue 
   * @param {boolean} selectBaseNameOnly 
   * @returns {Promise<string|null>}
   */
  showPrompt(message, defaultValue = '', selectBaseNameOnly = false) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'dialog-box';

      const messageEl = document.createElement('div');
      messageEl.className = 'dialog-message has-input';
      messageEl.textContent = message;

      const inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'dialog-input';
      inputEl.value = defaultValue;
      inputEl.spellcheck = false;

      const warningEl = document.createElement('div');
      warningEl.className = 'dialog-warning';

      const inputContainer = document.createElement('div');
      inputContainer.style.display = 'flex';
      inputContainer.style.flexDirection = 'column';
      inputContainer.appendChild(inputEl);
      inputContainer.appendChild(warningEl);

      const buttonsDiv = document.createElement('div');
      buttonsDiv.className = 'dialog-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dialog-btn cancel';
      cancelBtn.textContent = 'キャンセル';

      const okBtn = document.createElement('button');
      okBtn.className = 'dialog-btn primary';
      okBtn.textContent = 'OK';

      buttonsDiv.appendChild(cancelBtn);
      buttonsDiv.appendChild(okBtn);

      dialog.appendChild(messageEl);
      dialog.appendChild(inputContainer);
      dialog.appendChild(buttonsDiv);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cleanup = () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      };

      const validateInput = () => {
        const val = inputEl.value;
        if (/[\\/:*?"<>|]/.test(val)) {
          warningEl.textContent = '以下の文字は使用できません: \\ / : * ? " < > |';
          warningEl.classList.add('show');
          inputEl.classList.add('error');
          okBtn.disabled = true;
        } else if (val.trim() === '') {
          warningEl.textContent = '名前を入力してください。';
          warningEl.classList.add('show');
          inputEl.classList.remove('error');
          okBtn.disabled = true;
        } else {
          warningEl.classList.remove('show');
          inputEl.classList.remove('error');
          okBtn.disabled = false;
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
   * カスタム確認ダイアログを表示します。
   * @param {string} message 
   * @returns {Promise<boolean>}
   */
  showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'dialog-box';

      const messageEl = document.createElement('div');
      messageEl.className = 'dialog-message';
      messageEl.textContent = message;

      const buttonsDiv = document.createElement('div');
      buttonsDiv.className = 'dialog-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dialog-btn cancel';
      cancelBtn.textContent = 'キャンセル';

      const okBtn = document.createElement('button');
      okBtn.className = 'dialog-btn danger';
      okBtn.textContent = '削除';

      buttonsDiv.appendChild(cancelBtn);
      buttonsDiv.appendChild(okBtn);

      dialog.appendChild(messageEl);
      dialog.appendChild(buttonsDiv);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cleanup = () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      };

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

      cancelBtn.focus();
    });
  }

  /**
   * アイコンや要素を発光させます。
   * @param {HTMLElement} el 対象の要素
   */
  applyGlowEffect(el) {
    if (!el) return;
    el.style.transition = 'none';
    el.classList.add('glow');
    setTimeout(() => {
      el.style.transition = 'color 0.6s ease-out, filter 0.6s ease-out, stroke 0.6s ease-out';
      el.classList.remove('glow');
      setTimeout(() => { el.style.transition = ''; }, 600);
    }, 200);
  }

  /**
   * リストとサムネイルグリッドの選択状態を表すUIを一括で更新します。
   */
  updateSelectionUI() {
    if (!this.elements.fileListBody || !this.elements.thumbnailGrid) {
      this.elements.fileListBody = document.getElementById('file-list-body');
      this.elements.thumbnailGrid = document.getElementById('center-bottom');
      if (!this.elements.fileListBody || !this.elements.thumbnailGrid) return;
    }

    // 全要素をループするのではなく、既に選択されている要素のクラスを外す
    const currentSelectedRows = this.elements.fileListBody.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedRows.length; i++) currentSelectedRows[i].classList.remove('selected');
    
    const currentSelectedThumbs = this.elements.thumbnailGrid.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedThumbs.length; i++) currentSelectedThumbs[i].classList.remove('selected');

    // 新たに選択された要素のみにクラスを付与する
    const rows = this.elements.fileListBody.children;
    const thumbs = this.elements.thumbnailGrid.children;
    for (const i of this.state.selection) {
      if (rows[i]) rows[i].classList.add('selected');
      if (thumbs[i]) thumbs[i].classList.add('selected');
    }
  }

  /**
   * パネル（左右ペイン）の表示・非表示や幅を CSS 変数に反映してレイアウトを更新します。
   */
  applyLayout() {
    const root = document.documentElement;
    const lWidth = this.state.layout.leftVisible ? `${this.state.layout.leftWidth}px` : '0px';
    const rWidth = this.state.layout.rightVisible ? `${this.state.layout.rightWidth}px` : '0px';
    
    root.style.setProperty('--left-width', lWidth);
    root.style.setProperty('--right-width', rWidth);
  }

  /**
   * 2つの画像ファイルの全メタデータを比較表示します。
   * 全項目をプロンプトと同じテキストボックス形式で左右に並べて表示します。
   */
  showDiffModal(file1, file2, meta1 = {}, meta2 = {}) {
    const modal = document.getElementById('diff-modal');
    const container = document.getElementById('diff-container');
    if (!modal || !container) return;

    const parse = (text) => text ? text.split(',').map(t => t.trim()).filter(t => t) : [];
    

    const extractData = (file, meta) => {
      const p = meta.params || {};
      const data = {
        name: file.name,
        source: meta.source || file.source || null,
        prompt: meta.prompt || file.prompt || '',
        negativePrompt: meta.negativePrompt || file.negativePrompt || '',
        chars: [],
        params: {}
      };
      if (Array.isArray(p.characterPrompts)) {
        data.chars = p.characterPrompts.map(cp => ({ prompt: cp.prompt || '', uc: cp.uc || '' }));
      } else if (Array.isArray(file.charPrompts)) {
        data.chars = file.charPrompts.map(cp => ({
          prompt: (cp && typeof cp === 'object' && cp.prompt) ? cp.prompt : String(cp),
          uc: (cp && typeof cp === 'object' && cp.uc) ? cp.uc : ''
        }));
      }
      const res = (p.width && p.height) ? `${p.width}x${p.height}` : (meta.width && meta.height ? `${meta.width}x${meta.height}` : null);
      let sampler = p.sampler || file.sampler || null;
      if (sampler !== '-' && p.sm && !sampler.includes('karras')) sampler += " (karras)";
      data.params = {
        resolution: res,
        seed: p.seed ?? file.seed ?? null,
        steps: p.steps ?? file.steps ?? null,
        sampler: sampler,
        scale: p.scale ?? file.scale ?? null,
        cfg_rescale: p.cfg_rescale ?? file.cfg_rescale ?? null,
        uncond_scale: p.uncond_scale ?? file.uncond_scale ?? null,
        rawParameters: p.rawParameters ?? file.rawParameters ?? null
      };
      return data;
    };

    const d1 = extractData(file1, meta1);
    const d2 = extractData(file2, meta2);

    const renderSideBySideSection = (title, text1, text2, isParam = false) => {
      const v1 = text1 ?? '-';
      const v2 = text2 ?? '-';
      if (v1 === '-' && v2 === '-') return ''; 

      const tags1 = parse(String(v1));
      const tags2 = parse(String(v2));
      const set1 = new Set(tags1);
      const set2 = new Set(tags2);

      // 単純な文字列比較ではなく、パース・整理されたタグ配列の中身で比較する
      // これにより「末尾のスペース」や「余分なカンマ」だけの違いを無視できます
      const hasDiff = tags1.join(',') !== tags2.join(',');
      const titleClass = hasDiff ? 'has-diff' : '';

      const renderTags = (tags, otherSet, mode) => {
        if (tags.length === 0 || tags[0] === '-') return '<span style="opacity:0.3">なし</span>';
        return tags.map(t => {
          let className = 'common';
          if (mode === 'left' && !otherSet.has(t)) className = 'removed';
          if (mode === 'right' && !otherSet.has(t)) className = 'added';
          return `<span class="diff-tag ${className}">${t}</span>`;
        }).join('');
      };

      const boxClass = isParam ? "prompt-look param-box" : "prompt-look";

      return `
        <div class="diff-columns">
          <div class="diff-column">
            <div class="diff-section">
              <h3 class="${titleClass}" style="display: flex; justify-content: space-between; align-items: center;">
                <span>${title}</span>${UIManager.createCopyButtonHTML(v1)}
              </h3>
              <div class="${boxClass}">${renderTags(tags1, set2, 'left')}</div>
            </div>
          </div>
          <div class="diff-column">
            <div class="diff-section">
              <h3 class="${titleClass}" style="display: flex; justify-content: space-between; align-items: center;">
                <span>${title}</span>${UIManager.createCopyButtonHTML(v2)}
              </h3>
              <div class="${boxClass}">${renderTags(tags2, set1, 'right')}</div>
            </div>
          </div>
        </div>
      `;
    };

    let contentHtml = '';
    contentHtml += renderSideBySideSection('モデル / バージョン', d1.source, d2.source, true);
    contentHtml += renderSideBySideSection('プロンプト', d1.prompt, d2.prompt);
    contentHtml += renderSideBySideSection('除外したい要素', d1.negativePrompt, d2.negativePrompt);

    const maxChars = Math.max(d1.chars.length, d2.chars.length);
    for (let i = 0; i < maxChars; i++) {
      const c1 = d1.chars[i] || { prompt: '', uc: '' };
      const c2 = d2.chars[i] || { prompt: '', uc: '' };
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} プロンプト`, c1.prompt, c2.prompt);
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} 除外したい要素`, c1.uc, c2.uc);
    }

    contentHtml += renderSideBySideSection('画像サイズ', d1.params.resolution, d2.params.resolution, true);
    contentHtml += renderSideBySideSection('シード値', d1.params.seed, d2.params.seed, true);
    contentHtml += renderSideBySideSection('ステップ', d1.params.steps, d2.params.steps, true);
    contentHtml += renderSideBySideSection('サンプラー', d1.params.sampler, d2.params.sampler, true);
    contentHtml += renderSideBySideSection('プロンプトガイダンス', d1.params.scale, d2.params.scale, true);
    contentHtml += renderSideBySideSection('プロンプトガイダンスの再調整', d1.params.cfg_rescale, d2.params.cfg_rescale, true);
    contentHtml += renderSideBySideSection('除外したい要素の強さ', d1.params.uncond_scale, d2.params.uncond_scale, true);
    contentHtml += renderSideBySideSection('生成パラメータ (Raw)', d1.params.rawParameters, d2.params.rawParameters);

    const src1 = window.veloceAPI.convertFileSrc(file1.path);
    const src2 = window.veloceAPI.convertFileSrc(file2.path);

    const headerHtml = `
      <div style="display: flex; gap: 15px; margin-bottom: 15px;">
        <div style="flex: 1; display: flex; flex-direction: column;">
          <div class="diff-thumbnail-container" style="margin-top: 0;">
            <img src="${src1}" class="diff-thumbnail" decoding="async">
          </div>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column;">
          <div class="diff-thumbnail-container" style="margin-top: 0;">
            <img src="${src2}" class="diff-thumbnail" decoding="async">
          </div>
        </div>
      </div>
    `;

    container.innerHTML = headerHtml + contentHtml;

    container.querySelectorAll('.diff-copy-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const target = e.currentTarget;
        const text = target.getAttribute('data-copy-text');
        if (text && text !== '-') {
          try {
            await navigator.clipboard.writeText(text);
            this.showToast("クリップボードにコピーしました");
            this.applyGlowEffect(target);
          } catch (err) {}
        }
      });
    });

    // --- 【追加】Diff画面でのドラッグ選択コピー対応 ---
    container.querySelectorAll('.prompt-look').forEach(lookDiv => {
      lookDiv.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (selection.isCollapsed) return;

        const clone = selection.getRangeAt(0).cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(clone);

        const tags = tempDiv.querySelectorAll('.diff-tag');
        tags.forEach(tag => {
          tag.textContent = tag.textContent + ", ";
        });

        let copiedText = tempDiv.textContent;
        copiedText = copiedText.replace(/,\s*$/, '').trim();

        e.clipboardData.setData('text/plain', copiedText);
        e.preventDefault();
      });
    });
    // --- ここまで ---

    modal.style.display = 'flex';

    // モーダルが表示されてレイアウトが計算された後にスクロールをリセットする
    requestAnimationFrame(() => {
      if (container.parentElement) {
        container.parentElement.scrollTop = 0;
      }
      container.scrollTop = 0;
      
      const diffModal = document.getElementById('diff-modal');
      if (diffModal) diffModal.scrollTop = 0;
    });
  }

  /**
   * ファイルリストとサムネイルグリッドの描画を非同期で行います。
   */
  async renderAll(resetScroll = false) {
    if (!this.elements.fileListBody || !this.elements.thumbnailGrid) {
      this.elements.fileListBody = document.getElementById('file-list-body');
      this.elements.thumbnailGrid = document.getElementById('center-bottom');
    }

    const renderId = ++this.state.currentRenderId;

    // 既存の画像の監視をすべて停止
    if (this.state.thumbnailObserver) {
        this.state.thumbnailObserver.disconnect();
    }

    // 本当に新規作成が必要なサムネイルの枚数を計算
    const cachedCount = this.state.filteredFiles.filter(f => this.state.thumbnailUrls.has(f.path) || f.hasThumbnailCache).length;
    this.state.thumbnailTotalRequested = this.state.filteredFiles.length - cachedCount;
    this.state.thumbnailCompleted = 0;
    
    // 初期進捗の反映
    if (this.state.thumbnailTotalRequested > 0 && this.state.thumbnailCompleted < this.state.thumbnailTotalRequested) {
      if (typeof updateThumbnailToast === 'function') updateThumbnailToast();
    }

    if (this.elements.fileListBody) this.elements.fileListBody.innerHTML = '';
    if (this.elements.thumbnailGrid) this.elements.thumbnailGrid.innerHTML = '';

    if (this.elements.thumbnailGrid) {
      this.elements.thumbnailGrid.style.display = 'flex';
      this.elements.thumbnailGrid.style.flexWrap = 'wrap';
      this.elements.thumbnailGrid.style.gap = '8px';
      this.elements.thumbnailGrid.style.justifyContent = 'flex-start';
      this.elements.thumbnailGrid.style.alignContent = 'flex-start';
    }

    const fileListContainer = document.getElementById('center-top');
    if (resetScroll) {
      if (fileListContainer) fileListContainer.scrollTop = 0;
      if (this.elements.thumbnailGrid) this.elements.thumbnailGrid.scrollTop = 0;
    }

    if (this.state.filteredFiles.length === 0 && this.elements.thumbnailGrid) {
      const emptyMessage = document.createElement('div');
      emptyMessage.style.width = '100%';
      emptyMessage.style.textAlign = 'center';
      emptyMessage.style.color = '#888';
      emptyMessage.style.marginTop = '40px';
      emptyMessage.textContent = '表示対象の画像がありません';
      this.elements.thumbnailGrid.appendChild(emptyMessage);
    }

    for (let i = 0; i < this.state.filteredFiles.length; i += CHUNK_SIZE) {
      if (renderId !== this.state.currentRenderId) return;

      const chunk = this.state.filteredFiles.slice(i, i + CHUNK_SIZE);
      const tableFragment = document.createDocumentFragment();
      const gridFragment = document.createDocumentFragment();

      chunk.forEach((file, chunkIndex) => {
        const index = i + chunkIndex;
        const isSelected = this.state.selection.has(index);

        // --- テーブル行の作成 ---
        const tr = document.createElement('tr');
        if (isSelected) tr.classList.add('selected');
        tr.dataset.index = index;
        tr.innerHTML = `
          <td>${file.name}</td>
          <td>${file.ext}</td>
          <td style="text-align: right;">${file.width ? file.width.toLocaleString() : '-'}</td>
          <td style="text-align: right;">${file.height ? file.height.toLocaleString() : '-'}</td>
          <td style="text-align: right;">${formatSize(file.size)}</td>
          <td>${formatDate(file.mtime)}</td>
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
        if (this.state.thumbnailObserver) {
          this.state.thumbnailObserver.observe(img);
        }
      });

      if (this.elements.fileListBody) this.elements.fileListBody.appendChild(tableFragment);
      if (this.elements.thumbnailGrid) this.elements.thumbnailGrid.appendChild(gridFragment);

      // メインスレッドのブロック回避
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // バックグラウンド生成の再スタート
    if (!this.state.isPreloadRunning) {
      this.state.isPreloadRunning = true;
      if (typeof window.processNextTask === 'function') {
        setTimeout(window.processNextTask, 50);
      }
    }
  }
}

export { UIManager };
export const uiManager = new UIManager(appState);