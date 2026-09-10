/**
 * Veloce - Help & License Overlay Management Module (renderer-help.js)
 * 
 * 責務:
 * 1. ヘルプ・ショートカット一覧オーバーレイ (#help-overlay) の表示・非表示切り替え
 * 2. メイン画面 / ビューワー画面のショートカット一覧タブ制御
 * 3. サードパーティライセンス・クレジットダイアログ (#license-overlay) の表示および Markdown パース
 * 4. キーボード操作（Esc, F1, H）および背景クリックによる閉じる処理の統合
 * 
 * Windows 8.1 / WebView2 (Chromium 109) 互換性を厳格に維持。
 */

/**
 * 簡易 Markdown をパースして安全な HTML 文字列に変換する
 * @param {string} text - Markdown 形式のテキスト
 * @returns {string} 変換後の HTML 文字列
 */
export function parseLicenseMarkdown(text) {
  if (!text) return '';

  let html = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = html.split('\n');
  const processedLines = [];
  let bqBuffer = [];

  for (const line of lines) {
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

  // URL文字列をリンクに変換（すでに href="..." 等になっているものは除外）
  html = html.replace(/(?<!href=["'])(https?:\/\/[^\s&<"'>\)]+)/g, '<a href="$1">$1</a>');

  html = html.replace(/\n/g, '<br>');

  return html;
}

/**
 * ライセンス・クレジット情報ダイアログを表示する
 */
export async function showLicenseDialog() {
  const overlay = document.createElement('div');
  overlay.id = 'license-overlay';

  const content = document.createElement('div');
  content.className = 'license-modal-content';

  let licenseText = 'ライセンス情報を読み込み中';
  try {
    if (window.__TAURI__ && window.__TAURI__.invoke) {
      licenseText = await window.__TAURI__.invoke('get_license_text');
    } else if (window.veloceAPI && window.veloceAPI.getLicenseText) {
      licenseText = await window.veloceAPI.getLicenseText();
    }
  } catch (e) {
    console.error('Failed to load licenses:', e);
    licenseText = 'ライセンス情報の読み込みに失敗しました。';
  }

  const combinedText = licenseText;
  const parsedText = parseLicenseMarkdown(combinedText);

  content.innerHTML = `
    <div class="modal-header-row">
      <h2 class="modal-header-title">ライセンス情報</h2>
      <button class="dialog-close-btn" id="license-close-btn" title="閉じる (Esc)">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div id="license-text">${parsedText}</div>
  `;

  // リンクのクリック処理（OS標準ブラウザで開く）
  content.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = a.href;
      if (window.__TAURI__ && window.__TAURI__.shell && window.__TAURI__.shell.open) {
        await window.__TAURI__.shell.open(url);
      } else {
        window.open(url, '_blank');
      }
    });
  });

  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', keydownHandler, true);
  };

  const closeBtn = content.querySelector('#license-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', cleanup);
  }

  const keydownHandler = (e) => {
    if (e.key === 'Escape' || e.key === 'F1' || e.key.toLowerCase() === 'h') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();

      if (e.key === 'F1' || e.key.toLowerCase() === 'h') {
        const helpOverlay = document.getElementById('help-overlay');
        if (helpOverlay) {
          helpOverlay.remove();
        }
      }
    }
  };

  document.addEventListener('keydown', keydownHandler, true);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });

  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

/**
 * ヘルプ・ショートカット一覧オーバーレイの表示/非表示を切り替える
 * @param {boolean} [forceShow] - 強制表示フラグ (falseで強制非表示)
 */
export function toggleHelpOverlay(forceShow) {
  const licenseOverlay = document.getElementById('license-overlay');
  if (licenseOverlay) {
    licenseOverlay.remove();
  }

  let overlay = document.getElementById('help-overlay');

  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(() => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 200);
    return;
  }

  if (forceShow === false) return;

  overlay = document.createElement('div');
  overlay.id = 'help-overlay';

  const content = document.createElement('div');
  content.className = 'help-modal-content';

  content.innerHTML = `
    <div class="modal-header-row">
      <h2 class="modal-header-title">ヘルプ・ショートカット一覧</h2>
      <div class="modal-header-actions">
        <span id="license-link" class="license-link-btn">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="7"></circle>
            <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>
          </svg>
          ライセンス ＆ クレジット
        </span>
        <button class="dialog-close-btn" id="help-close-btn" title="閉じる (Esc)">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>

    <div class="help-tabs">
      <div class="help-tab active" data-target="help-main">メイン画面</div>
      <div class="help-tab" data-target="help-viewer">ビューワー画面</div>
    </div>

    <div id="help-main" class="help-tab-content active">
      <h3 class="help-group-title">ナビゲーション・選択</h3>
      <table class="help-table">
        <tr><td><kbd>矢印キー</kbd> / <kbd>PageUp/Down</kbd> / <kbd>Home/End</kbd></td><td>画像の選択を移動（矢印キーはShift 併用で範囲選択）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>A</kbd></td><td>現在のフォルダ内のすべての画像を選択</td></tr>
        <tr><td><kbd>Ctrl</kbd> / <kbd>Shift</kbd> + クリック</td><td>画像の複数選択</td></tr>
        <tr><td><kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd></td><td>フォルダ移動履歴の「戻る」 / 「進む」</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Tab</kbd> / <kbd>PageDown</kbd></td><td>次のタブへ切り替え</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> / <kbd>PageUp</kbd></td><td>前のタブへ切り替え</td></tr>
      </table>

      <h3 class="help-group-title">ファイル操作</h3>
      <table class="help-table">
        <tr><td><kbd>ダブルクリック</kbd> / <kbd>Enter</kbd></td><td>選択したサムネイルから独立ビューアーを開く</td></tr>
        <tr><td><kbd>F2</kbd></td><td>選択中のファイル/フォルダの名前を変更</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>選択中のファイル/フォルダを安全にゴミ箱へ移動</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>C</kbd></td><td>選択中の画像をクリップボードにコピー（テキスト選択中はテキストコピー）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td><td>直前のファイル/フォルダ名の変更を元に戻す</td></tr>
        <tr><td><kbd>0</kbd> 〜 <kbd>5</kbd></td><td>選択中の画像にレーティング（星の数）を設定 / 解除</td></tr>
      </table>

      <h3 class="help-group-title">ツール・表示</h3>
      <table class="help-table">
        <tr><td><kbd>F5</kbd></td><td>最新の情報に更新（再読み込み）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>F</kbd></td><td>検索キーワード入力欄にフォーカス</td></tr>
        <tr><td><kbd>A</kbd></td><td>開いているビューアーウィンドウを横一列に整列</td></tr>
        <tr><td><kbd>D</kbd></td><td>選択した2枚の画像の情報を比較 (Diffモーダル)</td></tr>
        <tr><td><kbd>F1</kbd> / <kbd>H</kbd></td><td>ヘルプの表示 / 非表示</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>各種モーダル・ヘルプ・メニューを閉じる</td></tr>
      </table>
    </div>

    <div id="help-viewer" class="help-tab-content">
      <h3 class="help-group-title">画像切り替え</h3>
      <table class="help-table">
        <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>前の画像 / 次の画像を表示</td></tr>
        <tr><td>左クリック / 右クリック</td><td>前の画像 / 次の画像を表示</td></tr>
        <tr><td>マウスホイール</td><td>上スクロールで前 / 下スクロールで次を表示</td></tr>
      </table>

      <h3 class="help-group-title">ズーム・移動</h3>
      <table class="help-table">
        <tr><td><kbd>Ctrl</kbd> + ホイール</td><td>画像のズームイン / ズームアウト</td></tr>
        <tr><td>左ドラッグ</td><td>ウィンドウの移動 / スクロール（ズーム時）</td></tr>
        <tr><td><kbd>Ctrl</kbd> + 左ドラッグ</td><td>ズームイン時、画像内を自由にパン移動</td></tr>
        <tr><td><kbd>F</kbd></td><td>100%表示（モニターより大きい画像はリサイズ）</td></tr>
        <tr><td><kbd>Space</kbd></td><td>完全な100%等倍ウィンドウ表示（画面外許可）</td></tr>
      </table>

      <h3 class="help-group-title">変形・フィルター</h3>
      <table class="help-table">
        <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>右に90度回転 / 左に90度回転</td></tr>
        <tr><td><kbd>H</kbd></td><td>画像を左右反転（水平反転）</td></tr>
        <tr><td><kbd>V</kbd></td><td>画像を上下反転（垂直反転）</td></tr>
        <tr><td><kbd>U</kbd></td><td>シャープ表示 / 滑らか表示の切り替え</td></tr>
      </table>

      <h3 class="help-group-title">ウィンドウ・操作</h3>
      <table class="help-table">
        <tr><td><kbd>F11</kbd></td><td>フルスクリーン表示切り替え</td></tr>
        <tr><td><kbd>A</kbd></td><td>すべてのビューアーを横一列に整列</td></tr>
        <tr><td><kbd>B</kbd></td><td>ウィンドウ枠（ボーダー）・UIの表示切替</td></tr>
        <tr><td><kbd>I</kbd></td><td>メタデータオーバーレイの表示 / 非表示</td></tr>
        <tr><td><kbd>S</kbd></td><td>動画のシークバーの表示 / 非表示</td></tr>
        <tr><td><kbd>Delete</kbd></td><td>画像をゴミ箱に移動し、次の画像を表示</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>C</kbd></td><td>表示中の画像をクリップボードにコピー（テキスト選択中はテキストコピー）</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>ビューワーウィンドウを閉じる（オーバーレイ表示時はオーバーレイを閉じる）</td></tr>
      </table>
    </div>
  `;

  const tabs = content.querySelectorAll('.help-tab');
  const tabContents = content.querySelectorAll('.help-tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.target;
      content.querySelector('#' + targetId).classList.add('active');
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('#help-close-btn')) {
      toggleHelpOverlay(false);
      return;
    }
    if (e.target.closest('#license-link')) {
      showLicenseDialog();
      return;
    }
    if (!e.target.closest('.help-modal-content')) {
      toggleHelpOverlay(false);
    }
  });

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add('show');
  });
}
