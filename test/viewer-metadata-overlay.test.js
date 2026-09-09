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

    // プロンプトタグが表示されていること
    const tags = content.querySelectorAll('.viewer-meta-tag');
    expect(tags.length).toBeGreaterThan(0);
    const tagTexts = Array.from(tags).map(t => t.textContent);
    expect(tagTexts).toContain('1girl');
    expect(tagTexts).toContain('masterpiece');

    // パラメータ（Seed, Steps 等）が表示されていること
    expect(content.textContent).toContain('123456789');
    expect(content.textContent).toContain('k_euler');
    expect(content.textContent).toContain('28');
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
});
