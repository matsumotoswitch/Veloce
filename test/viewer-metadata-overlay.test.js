import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { viewerState } from '../src/viewer-state.js';
import {
  createMetadataOverlay,
  toggleMetadataOverlay,
  updateMetadataOverlay
} from '../src/viewer.js';

describe('Viewer Metadata Overlay (A-4)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <img id="viewer-img" src="asset://test.png" />
      <div id="window-filename-display"></div>
    `;

    viewerState.currentIndex = 0;
    viewerState.totalImages = 1;
    viewerState.currentImagePath = 'C:\\images\\test_character.png';
    viewerState.isMetadataVisible = false;

    window.veloceAPI = {
      parseMetadata: vi.fn(async (filePath) => {
        if (filePath.includes('empty')) {
          return null;
        }
        return {
          prompt: '1girl, masterpiece, solo, smile',
          negativePrompt: 'lowres, bad anatomy',
          params: {
            steps: 28,
            sampler: 'k_euler',
            scale: 7.0,
            seed: 123456789,
            width: 832,
            height: 1216
          }
        };
      }),
      closeWindow: vi.fn()
    };
  });

  afterEach(() => {
    const overlay = document.getElementById('viewer-metadata-overlay');
    if (overlay) overlay.remove();
    viewerState.isMetadataVisible = false;
    vi.restoreAllMocks();
  });

  it('createMetadataOverlay で DOM 要素が正しく構築されること', () => {
    const overlay = createMetadataOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.id).toBe('viewer-metadata-overlay');

    const content = document.getElementById('viewer-metadata-content');
    expect(content).not.toBeNull();

    const closeBtn = document.getElementById('viewer-metadata-close-btn');
    expect(closeBtn).not.toBeNull();

    // 2回呼んでも多重生成されないこと
    const overlay2 = createMetadataOverlay();
    expect(overlay).toBe(overlay2);
  });

  it('オーバーレイ内のクリックイベントの伝播が停止されること', () => {
    const overlay = createMetadataOverlay();
    let bodyClicked = false;
    document.body.addEventListener('click', () => { bodyClicked = true; });

    const clickEvent = new MouseEvent('click', { bubbles: true });
    overlay.dispatchEvent(clickEvent);
    expect(bodyClicked).toBe(false);
  });

  it('toggleMetadataOverlay で表示状態がトグルされること', () => {
    expect(viewerState.isMetadataVisible).toBe(false);

    toggleMetadataOverlay();
    expect(viewerState.isMetadataVisible).toBe(true);
    const overlay = document.getElementById('viewer-metadata-overlay');
    expect(overlay.classList.contains('show')).toBe(true);

    toggleMetadataOverlay();
    expect(viewerState.isMetadataVisible).toBe(false);
    expect(overlay.classList.contains('show')).toBe(false);
  });

  it('toggleMetadataOverlay(false) で明示的に非表示にできること', () => {
    toggleMetadataOverlay(true);
    expect(viewerState.isMetadataVisible).toBe(true);

    toggleMetadataOverlay(false);
    expect(viewerState.isMetadataVisible).toBe(false);
  });

  it('updateMetadataOverlay でプロンプトタグやパラメータが正しく描画されること', async () => {
    viewerState.isMetadataVisible = true;
    toggleMetadataOverlay(true);

    await updateMetadataOverlay();

    const content = document.getElementById('viewer-metadata-content');
    expect(window.veloceAPI.parseMetadata).toHaveBeenCalledWith('C:\\images\\test_character.png');

    // ファイル名が表示されていること
    expect(content.textContent).toContain('test_character.png');

    // プロンプトタグがメイン画面と同一の .diff-tag で表示されていること
    const tags = content.querySelectorAll('.diff-tag');
    expect(tags.length).toBeGreaterThan(0);
    const tagTexts = Array.from(tags).map(t => t.textContent);
    expect(tagTexts).toContain('1girl');
    expect(tagTexts).toContain('masterpiece');

    // メイン画面と同一の prompt-look ボックスが使われていること
    const boxes = content.querySelectorAll('.prompt-look');
    expect(boxes.length).toBeGreaterThan(0);

    // コピーボタンが配置されていること
    const copyBtns = content.querySelectorAll('.diff-copy-btn');
    expect(copyBtns.length).toBeGreaterThan(0);

    // パラメータ（Seed, Steps 等）が表示されていること
    expect(content.textContent).toContain('123456789');
    expect(content.textContent).toContain('k_euler');
    expect(content.textContent).toContain('28');
  });

  it('コピーボタンをクリックしたときにセクション内容がクリップボードにコピーされること', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });

    toggleMetadataOverlay(true);
    await updateMetadataOverlay();

    const copyBtn = document.querySelector('.diff-copy-btn');
    expect(copyBtn).not.toBeNull();

    const textToCopy = copyBtn.getAttribute('data-copy-text');
    expect(textToCopy).toBeTruthy();

    copyBtn.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(textToCopy);
  });

  it('タグチップをクリックしたときにそのタグがクリップボードにコピーされること', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });

    toggleMetadataOverlay(true);
    await updateMetadataOverlay();

    const tag = document.querySelector('.diff-tag');
    expect(tag).not.toBeNull();

    const tagText = tag.textContent;
    tag.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(tagText);
  });

  it('メタデータが存在しない画像の場合は「メタデータが見つかりません」が表示されること', async () => {
    viewerState.currentImagePath = 'C:\\images\\empty.png';
    viewerState.isMetadataVisible = true;
    toggleMetadataOverlay(true);

    await updateMetadataOverlay();

    const content = document.getElementById('viewer-metadata-content');
    expect(content.textContent).toContain('メタデータが見つかりません');
  });

  it('I キー押下でオーバーレイの開閉がトグルされること', () => {
    expect(viewerState.isMetadataVisible).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    expect(viewerState.isMetadataVisible).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I' }));
    expect(viewerState.isMetadataVisible).toBe(false);
  });

  it('オーバーレイ表示中に Escape キーを押すとオーバーレイのみが閉じ、closeWindow は呼ばれないこと', () => {
    toggleMetadataOverlay(true);
    expect(viewerState.isMetadataVisible).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(viewerState.isMetadataVisible).toBe(false);
    expect(window.veloceAPI.closeWindow).not.toHaveBeenCalled();

    // 再度 Escape を押すと closeWindow が呼ばれること
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(window.veloceAPI.closeWindow).toHaveBeenCalled();
  });

  it('閉じるボタンのクリックでオーバーレイが閉じること', () => {
    toggleMetadataOverlay(true);
    expect(viewerState.isMetadataVisible).toBe(true);

    const closeBtn = document.getElementById('viewer-metadata-close-btn');
    closeBtn.click();
    expect(viewerState.isMetadataVisible).toBe(false);
  });

  it('画像パスが切り替わった際に updateMetadataOverlay で新しい画像のメタデータが表示されること', async () => {
    toggleMetadataOverlay(true);
    await updateMetadataOverlay();

    const content = document.getElementById('viewer-metadata-content');
    expect(content.textContent).toContain('test_character.png');

    // 新しい画像に切り替え
    viewerState.currentImagePath = 'C:\\images\\second_character.png';
    window.veloceAPI.parseMetadata.mockResolvedValueOnce({
      prompt: 'scenery, sunset, sky',
      params: { steps: 30, sampler: 'ddim', seed: 99999 }
    });

    await updateMetadataOverlay();

    expect(window.veloceAPI.parseMetadata).toHaveBeenCalledWith('C:\\images\\second_character.png');
    expect(content.textContent).toContain('second_character.png');
    expect(content.textContent).toContain('sunset');
    expect(content.textContent).toContain('ddim');
    expect(content.textContent).toContain('99999');
  });

  it('style.css で #viewer-metadata-overlay, .viewer-metadata-content, .prompt-look に user-select: text が指定されていること', () => {
    const fs = require('fs');
    const path = require('path');
    const cssPath = path.resolve(__dirname, '../src/style.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // テキスト選択許可エリアに #viewer-metadata-overlay, .viewer-metadata-content, .prompt-look が含まれていること
    const textSelectMatch = cssContent.match(/\/\* --- テキスト選択・コピーを明示的に許可するエリア --- \*\/\s*([^\{]+)\{([^}]+)\}/);
    expect(textSelectMatch).not.toBeNull();
    const selectors = textSelectMatch[1];
    const styles = textSelectMatch[2];

    expect(selectors).toContain('#viewer-metadata-overlay');
    expect(selectors).toContain('.viewer-metadata-content');
    expect(selectors).toContain('.prompt-look');
    expect(styles).toContain('user-select: text');
    expect(styles).toContain('-webkit-user-select: text');

    // .prompt-look 単体にも user-select: text が指定されていること
    const promptLookMatch = cssContent.match(/\.prompt-look\s*\{([^}]+)\}/);
    expect(promptLookMatch).not.toBeNull();
    expect(promptLookMatch[1]).toContain('user-select: text');
  });

  it('ドラッグ等でテキスト選択が行われている状態では、個別タグのクリックコピーが抑制されること', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });

    toggleMetadataOverlay(true);
    await updateMetadataOverlay();

    const tag = document.querySelector('.diff-tag');
    expect(tag).not.toBeNull();

    // テキスト選択状態をモック (non-collapsed, 文字列あり)
    const mockSelection = {
      isCollapsed: false,
      toString: () => '1girl, masterpiece'
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(mockSelection);

    tag.click();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    // 選択が解除された状態（collapsed）では正常にコピーされること
    window.getSelection.mockReturnValue({
      isCollapsed: true,
      toString: () => ''
    });

    tag.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(tag.textContent);
  });

  it('プロンプトボックス内のドラッグ選択コピー時に、タグがカンマ区切りでクリップボードに格納されること', async () => {
    toggleMetadataOverlay(true);
    await updateMetadataOverlay();

    const overlay = document.getElementById('viewer-metadata-overlay');
    const promptLook = Array.from(overlay.querySelectorAll('.prompt-look')).find(b => b.querySelectorAll('.diff-tag').length > 1);
    expect(promptLook).not.toBeNull();

    const tags = promptLook.querySelectorAll('.diff-tag');
    expect(tags.length).toBeGreaterThan(1);

    // 複数タグを含むクローンフラグメントを作成してモック
    const fragment = document.createDocumentFragment();
    const tag1 = document.createElement('span');
    tag1.className = 'diff-tag common';
    tag1.textContent = tags[0].textContent;
    const tag2 = document.createElement('span');
    tag2.className = 'diff-tag common';
    tag2.textContent = tags[1].textContent;
    fragment.appendChild(tag1);
    fragment.appendChild(tag2);

    const mockRange = {
      cloneContents: () => fragment
    };
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      getRangeAt: () => mockRange
    });

    const clipboardDataMock = {
      setData: vi.fn()
    };
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    Object.assign(copyEvent, { clipboardData: clipboardDataMock });

    promptLook.dispatchEvent(copyEvent);

    expect(clipboardDataMock.setData).toHaveBeenCalledWith(
      'text/plain',
      `${tags[0].textContent}, ${tags[1].textContent}`
    );
    expect(copyEvent.defaultPrevented).toBe(true);
  });

  it('オーバーレイ上のマウス・ポインターイベントの伝播が停止されること', () => {
    toggleMetadataOverlay(true);
    const overlay = document.getElementById('viewer-metadata-overlay');

    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'dblclick']) {
      const evt = new MouseEvent(evtName, { bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(evt, 'stopPropagation');
      overlay.dispatchEvent(evt);
      expect(stopSpy).toHaveBeenCalled();
    }
  });

  it('テキスト選択中に Ctrl+C を押したときは画像コピーをスキップし、テキストコピー通知が表示されること', () => {
    viewerState.currentImagePath = 'C:\\images\\test_character.png';
    window.veloceAPI.copyImageToClipboard = vi.fn();

    // テキスト選択がある状態
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => '1girl, masterpiece'
    });

    const keyEvent = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(keyEvent);

    // 画像のコピーAPIは呼ばれないこと
    expect(window.veloceAPI.copyImageToClipboard).not.toHaveBeenCalled();

    // トーストコンテナに「テキストをクリップボードにコピーしました」が表示されること
    const toastContainer = document.getElementById('toast-container');
    expect(toastContainer).not.toBeNull();
    expect(toastContainer.textContent).toContain('テキストをクリップボードにコピーしました');

    // 選択がない状態では画像コピーが実行されること
    window.getSelection.mockReturnValue({
      isCollapsed: true,
      toString: () => ''
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(window.veloceAPI.copyImageToClipboard).toHaveBeenCalledWith('C:\\images\\test_character.png');
  });
});
