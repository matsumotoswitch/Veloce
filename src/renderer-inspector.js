/**
 * Veloce - Inspector & DOM Pool Management Module (renderer-inspector.js)
 * 
 * 責務:
 * 1. 右ペインインスペクター (#inspector-content) のメタデータ・タグ描画
 * 2. DOM Pool パターンによるセクション・タグ要素の再利用と GC (ガベージコレクション) 抑制
 * 3. 単一ファイルメタデータ描画 (renderMetadata)
 * 4. 複数画像選択時のサマリー描画 (renderMultipleSelectionSummary)
 * 5. インスペクターの空状態リセット・クリア (clearMetadataUI, resetInspectorPools)
 * 6. コピーボタン、ツールチップ、パス右クリック、プロンプトテキストコピー等のイベント委譲
 * 
 * Windows 8.1 / WebView2 (Chromium 109) 互換性を厳格に維持。
 */

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';
import {
  extractMetadataFields,
  highlightSearchTerms,
  buildInspectorSections,
  createSearchTermsRegex
} from './metadata-format.js';

// --- DOM Pool for Inspector ---
const inspectorSectionPool = [];
const inspectorTagPool = [];
let inspectorSectionIndex = 0;
let inspectorTagIndex = 0;
let _inspectorDelegationInit = false;
let _inspectorDelegationOptions = {};

export function resetInspectorDelegationForTest() {
  _inspectorDelegationInit = false;
  _inspectorDelegationOptions = {};
}

/**
 * DOM Pool からセクション要素を取得する（不足時は新規生成してPoolに追加）
 * @returns {{ root: HTMLDivElement, title: HTMLSpanElement, subLabel: HTMLSpanElement, copyWrapper: HTMLDivElement, copyBtn: HTMLElement|null, box: HTMLDivElement }}
 */
export function getInspectorSection() {
  if (inspectorSectionIndex < inspectorSectionPool.length) {
    const el = inspectorSectionPool[inspectorSectionIndex++];
    el.root.style.display = 'block';
    return el;
  }
  const section = document.createElement('div');
  section.className = 'inspector-section inspector-section-block';

  const h3 = document.createElement('h3');
  h3.className = 'inspector-section-h3';

  const titleWrapper = document.createElement('span');
  titleWrapper.className = 'inspector-title-wrapper';

  const titleSpan = document.createElement('span');
  const subLabelSpan = document.createElement('span');

  titleWrapper.appendChild(titleSpan);
  titleWrapper.appendChild(subLabelSpan);

  const copyWrapper = document.createElement('div');
  copyWrapper.className = 'inspector-copy-wrapper';

  h3.appendChild(titleWrapper);
  h3.appendChild(copyWrapper);

  const box = document.createElement('div');
  box.tabIndex = -1;

  section.appendChild(h3);
  section.appendChild(box);

  const elObj = {
    root: section,
    title: titleSpan,
    subLabel: subLabelSpan,
    copyWrapper: copyWrapper,
    copyBtn: null,
    box: box
  };

  inspectorSectionPool.push(elObj);
  inspectorSectionIndex++;
  return elObj;
}

/**
 * DOM Pool からタグ要素を取得する（不足時は新規生成してPoolに追加）
 * @returns {HTMLSpanElement}
 */
export function getInspectorTag() {
  if (inspectorTagIndex < inspectorTagPool.length) {
    const el = inspectorTagPool[inspectorTagIndex++];
    el.style.display = 'inline';
    return el;
  }
  const span = document.createElement('span');
  span.className = 'diff-tag common';
  inspectorTagPool.push(span);
  inspectorTagIndex++;
  return span;
}

/**
 * DOM Pool の利用インデックスをリセットし、プール内のDOM要素を初期状態へ戻す
 */
export function resetInspectorPools() {
  for (let i = 0; i < inspectorSectionIndex; i++) {
    const sec = inspectorSectionPool[i];
    sec.root.style.display = 'none';
    sec.box.replaceChildren();
    sec.title.style.color = '';
    sec.subLabel.textContent = '';
    sec.subLabel.className = '';
    sec.subLabel.replaceChildren();
    sec.copyWrapper.style.display = 'none';
    sec.box.className = 'prompt-look';
    sec.box.style.cssText = '';
  }
  for (let i = 0; i < inspectorTagIndex; i++) {
    inspectorTagPool[i].classList.remove('search-match');
  }
  inspectorSectionIndex = 0;
  inspectorTagIndex = 0;
}

/**
 * インスペクターのメタデータ表示を空状態にクリアする
 */
export function clearMetadataUI() {
  const staticTable = document.getElementById('static-file-info-table');
  const emptyInfoMsg = document.getElementById('file-info-empty');
  if (staticTable && emptyInfoMsg) {
    staticTable.style.display = 'none';
    emptyInfoMsg.style.display = 'flex';
  }

  resetInspectorPools();

  const emptyInspectorMsg = document.getElementById('inspector-empty');
  if (emptyInspectorMsg) {
    emptyInspectorMsg.classList.add('show');
  }

  const headerPath = document.getElementById('inspector-header-path');
  if (headerPath) {
    headerPath.style.display = 'none';
  }
}

/**
 * 複数画像選択時のインスペクターサマリーを描画する
 */
export async function renderMultipleSelectionSummary() {
  const container = document.getElementById('inspector-content');
  const headerPath = document.getElementById('inspector-header-path');
  const staticTable = document.getElementById('static-file-info-table');
  const emptyInfoMsg = document.getElementById('file-info-empty');

  // 単一ファイル用の静的ファイル情報テーブルを隠し、空状態表示へ切り替え
  if (staticTable && emptyInfoMsg) {
    staticTable.style.display = 'none';
    emptyInfoMsg.style.display = 'flex';
  }

  const emptyInspectorMsg = document.getElementById('inspector-empty');
  if (emptyInspectorMsg) emptyInspectorMsg.classList.remove('show');

  // DOM Pool の再利用インデックスをリセットし、前回のセクション・タグをクリーンアップ
  resetInspectorPools();

  const count = appState.selection.size;
  const total = appState.totalCount || count;
  const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '100';

  // インスペクターヘッダーに選択件数と割合を表示
  if (headerPath) {
    headerPath.innerHTML = `<bdi dir="ltr">${count} / ${total} 件選択中 (${pct}%)</bdi>`;
    headerPath.removeAttribute('data-path');
    headerPath.style.display = 'block';
  }

  // 1. 複数選択概要セクション (DOM Poolから要素を取得してGC発生を抑制)
  const sec1 = getInspectorSection();
  sec1.title.textContent = '複数選択概要';
  sec1.copyWrapper.replaceChildren();
  sec1.subLabel.textContent = '';
  sec1.box.className = 'prompt-look param-box';
  sec1.box.style.cssText = '';

  const tag1 = getInspectorTag();
  tag1.style.cssText = '';
  tag1.className = 'diff-tag common';
  tag1.textContent = `選択数: ${count} 件 (フォルダ内 ${total} 件中 ${pct}%)`;
  sec1.box.appendChild(tag1);

  if (sec1.root.parentNode !== container) container.appendChild(sec1.root);

  // 2. 一括ショートカット操作ガイドセクション
  const sec2 = getInspectorSection();
  sec2.title.textContent = 'ショートカット操作';
  sec2.copyWrapper.replaceChildren();
  sec2.subLabel.textContent = '';
  sec2.box.className = 'prompt-look';
  sec2.box.style.cssText = '';

  const shortcuts = [
    '1 〜 5 : 一括レーティング',
    'Delete : 一括ゴミ箱移動',
    'Ctrl + C : パスコピー',
    'Ctrl + A : すべて選択'
  ];

  for (const sc of shortcuts) {
    const tag = getInspectorTag();
    tag.style.cssText = '';
    tag.className = 'diff-tag common';
    tag.textContent = sc;
    sec2.box.appendChild(tag);
  }

  if (sec2.root.parentNode !== container) container.appendChild(sec2.root);
}

/**
 * インスペクター内のイベント委譲を初期化する
 * @param {Object} [options]
 * @param {Object} [options.contextMenuManager] - コンテキストメニュー管理オブジェクト
 * @param {Function} [options.showNotification] - 通知関数
 */
export function initInspectorDelegation(options = {}) {
  if (options.contextMenuManager) {
    _inspectorDelegationOptions.contextMenuManager = options.contextMenuManager;
  }
  if (options.showNotification) {
    _inspectorDelegationOptions.showNotification = options.showNotification;
  }

  if (_inspectorDelegationInit) return;
  const container = document.getElementById('inspector-content');
  const delegationRoot = document.getElementById('right-pane') || container;
  if (!delegationRoot) return;

  _inspectorDelegationInit = true;

  delegationRoot.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.diff-copy-btn');
    if (copyBtn) {
      const text = copyBtn.getAttribute('data-copy-text');
      if (text) {
        await navigator.clipboard.writeText(text);
        if (window.uiManager) window.uiManager.showToast('クリップボードにコピーしました', 3000, null, 'success');
        else if (options.showNotification) options.showNotification('クリップボードにコピーしました', 'success');
        uiManager.applyGlowEffect(copyBtn);
        uiManager.hideCustomTooltip();
      }
    }
  });

  delegationRoot.addEventListener('mousemove', (e) => {
    const copyBtn = e.target.closest('.diff-copy-btn');
    if (copyBtn) {
      uiManager.showCustomTooltip('コピー', e.clientX, e.clientY);
    } else {
      uiManager.hideCustomTooltip();
    }
  });

  delegationRoot.addEventListener('mouseleave', () => {
    uiManager.hideCustomTooltip();
  }, true);

  delegationRoot.addEventListener('contextmenu', (e) => {
    const openBtn = e.target.closest('.open-folder-btn') ||
      (e.target.closest('#inspector-header')?.querySelector('#inspector-header-path'));
    if (openBtn) {
      e.preventDefault();
      e.stopPropagation();

      const filePathStr = openBtn.getAttribute('data-path');
      if (!filePathStr) return;

      const lastSlash = Math.max(filePathStr.lastIndexOf('\\'), filePathStr.lastIndexOf('/'));
      const dirPath = lastSlash !== -1 ? filePathStr.substring(0, lastSlash) : filePathStr;
      const folderName = dirPath.split(/[\\/]/).pop() || dirPath;

      const cmm = _inspectorDelegationOptions.contextMenuManager || options.contextMenuManager || window.contextMenuManager;
      if (cmm) {
        cmm.show('inspector-header', {
          targetFolder: { path: dirPath, name: folderName },
          isRoot: false
        }, e.clientX, e.clientY);
      }
    }
  });

  delegationRoot.addEventListener('copy', (e) => {
    const selection = window.getSelection();
    if (selection.isCollapsed) return;
    const promptLook = e.target.closest('.prompt-look');
    if (!promptLook) return;

    const clone = selection.getRangeAt(0).cloneContents();
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(clone);
    const tags = tempDiv.querySelectorAll('.diff-tag');
    tags.forEach(tag => { tag.textContent = tag.textContent + ', '; });
    let copiedText = tempDiv.textContent.replace(/,\s*$/, '').trim();
    e.clipboardData.setData('text/plain', copiedText);
    e.preventDefault();
  });
}

/**
 * 単一ファイルのメタデータをインスペクターに描画する
 * @param {Object} file - 描画対象のファイルオブジェクト
 * @param {Object} [options] - 委譲初期化用オプション
 */
export async function renderMetadata(file, options = {}) {
  const container = document.getElementById('inspector-content');
  if (!file || !container) return;

  const emptyInspectorMsg = document.getElementById('inspector-empty');
  if (emptyInspectorMsg) emptyInspectorMsg.classList.remove('show');

  try {
    const rawMeta = window.veloceAPI?.parseMetadata
      ? await window.veloceAPI.parseMetadata(file.path)
      : null;
    const meta = rawMeta || {};

    if (meta.width > 0 && meta.height > 0 && (!file.width || !file.height)) {
      file.width = meta.width;
      file.height = meta.height;
      if (uiManager && typeof uiManager.updateFileDimensions === 'function') {
        uiManager.updateFileDimensions(file.path, meta.width, meta.height);
      }
      if (window.veloceAPI && typeof window.veloceAPI.updateFileDimensions === 'function') {
        window.veloceAPI.updateFileDimensions(file.path, meta.width, meta.height);
      }
    }

    const d = extractMetadataFields(file, meta);

    let searchStr = '';
    if (uiManager.elements.searchBar?.value) {
      searchStr = uiManager.elements.searchBar.value;
    } else if (typeof appState !== 'undefined' && appState.searchQuery) {
      searchStr = appState.searchQuery;
    }
    const terms = searchStr.trim() !== ''
      ? searchStr.toLowerCase().split(/[,\n\r]+/).map(t => t.trim()).filter(Boolean)
      : [];
    const termsRegex = terms.length > 0 ? createSearchTermsRegex(terms) : null;

    resetInspectorPools();

    const badge = container.querySelector('.inspector-location-badge');
    if (badge) badge.remove();

    const headerPath = document.getElementById('inspector-header-path');
    if (headerPath) {
      if (file.path) {
        const filePathStr = String(file.path);
        const lastSlash = Math.max(filePathStr.lastIndexOf('\\'), filePathStr.lastIndexOf('/'));
        const dirPath = lastSlash !== -1 ? filePathStr.substring(0, lastSlash) : filePathStr;
        const escapedPath = dirPath.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        headerPath.innerHTML = `<bdi dir="ltr">${escapedPath}</bdi>`;
        headerPath.setAttribute('data-path', file.path);
        headerPath.removeAttribute('title');
        headerPath.style.display = 'block';
      } else {
        headerPath.style.display = 'none';
      }
    }

    let hasContent = false;
    const sections = buildInspectorSections(d);

    for (const section of sections) {
      if (!section.value || section.value === '-') continue;
      hasContent = true;

      const secEl = getInspectorSection();
      secEl.title.textContent = section.title;

      if (!secEl.copyBtn) {
        secEl.copyWrapper.innerHTML = UIManager.createCopyButtonHTML(section.value);
        secEl.copyBtn = secEl.copyWrapper.firstElementChild;
      } else {
        secEl.copyBtn.setAttribute('data-copy-text', section.value);
      }
      secEl.copyWrapper.style.display = 'flex';

      let sectionHasMatch = false;

      if (section.isRaw) {
        secEl.box.className = 'prompt-look raw-box';
        secEl.box.style.cssText = '';
        const rawText = String(section.value);
        if (termsRegex) {
          termsRegex.lastIndex = 0;
          sectionHasMatch = termsRegex.test(rawText);
          if (sectionHasMatch) {
            secEl.box.innerHTML = highlightSearchTerms(rawText, termsRegex);
          } else {
            secEl.box.textContent = rawText;
          }
        } else {
          secEl.box.textContent = rawText;
        }
      } else {
        secEl.box.className = section.isParam ? 'prompt-look param-box' : 'prompt-look';
        secEl.box.style.cssText = '';

        const tags = section.isParam ? [String(section.value)] : String(section.value).split(/[,\n\r]+/).map(t => t.trim()).filter(t => t);
        for (const t of tags) {
          const tagEl = getInspectorTag();

          if (termsRegex) {
            termsRegex.lastIndex = 0;
            const isMatch = termsRegex.test(t);
            if (isMatch) {
              sectionHasMatch = true;
            }
            tagEl.classList.toggle('search-match', isMatch);
            tagEl.innerHTML = highlightSearchTerms(t, termsRegex);
          } else {
            tagEl.classList.remove('search-match');
            tagEl.textContent = t;
          }
          secEl.box.appendChild(tagEl);
        }
      }

      if (sectionHasMatch) {
        secEl.title.style.color = 'var(--glow-gold)';
      } else {
        secEl.title.style.color = '';
      }

      if (section.subLabel && section.subLabel !== 'Text to Image') {
        const labels = section.subLabel.split(' + ');
        secEl.subLabel.replaceChildren();
        secEl.subLabel.className = 'sublabel-tags-wrapper';

        labels.forEach(lbl => {
          let modifier = '';
          if (lbl.includes('Inpainting')) {
            modifier = ' sublabel-tag--inpainting';
          } else if (lbl.includes('Vibe Transfer')) {
            modifier = ' sublabel-tag--vibe';
          } else if (lbl.includes('Character Reference')) {
            modifier = ' sublabel-tag--char-ref';
          } else if (lbl.includes('Image to Image') || lbl.includes('Img2Img')) {
            modifier = ' sublabel-tag--img2img';
          }
          const span = document.createElement('span');
          span.className = `sublabel-tag${modifier}`;
          span.textContent = `[${lbl}]`;
          secEl.subLabel.appendChild(span);
        });
      } else {
        secEl.subLabel.replaceChildren();
        secEl.subLabel.className = '';
      }

      if (secEl.root.parentNode !== container) {
        container.appendChild(secEl.root);
      }
    }

    if (!hasContent) {
      const rawMetaStr = JSON.stringify(meta, null, 2);
      if (rawMetaStr !== '{}' && rawMetaStr !== 'null') {
        const secEl = getInspectorSection();
        secEl.title.textContent = '未対応のメタデータ形式';
        secEl.copyWrapper.replaceChildren();
        secEl.subLabel.textContent = '';
        secEl.box.className = 'prompt-look';
        secEl.box.style.whiteSpace = 'pre-wrap';
        secEl.box.style.fontFamily = 'Consolas, monospace';
        secEl.box.style.fontSize = 'var(--font-size-xs)';
        secEl.box.style.wordBreak = 'break-all';
        secEl.box.style.maxHeight = '400px';
        secEl.box.style.overflowY = 'auto';
        secEl.box.textContent = rawMetaStr;
        if (secEl.root.parentNode !== container) container.appendChild(secEl.root);
      }
    }

    initInspectorDelegation(options);
  } catch (error) {
    if (container) {
      container.innerHTML = `<div class="render-error-box">描画エラー: ${error.message}</div>`;
    }
  }
}
