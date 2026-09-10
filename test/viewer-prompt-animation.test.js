import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFullCssContent } from './helpers/css-helper.js';
import { viewerState } from '../src/viewer-state.js';
import {
  createMetadataOverlay,
  toggleMetadataOverlay
} from '../src/viewer.js';

describe('Viewer Prompt Overlay Animation (Pop & Hide)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <img id="viewer-img" src="asset://test.png" />
      <div id="window-filename-display"></div>
      <div id="window-controls"></div>
    `;

    viewerState.currentIndex = 0;
    viewerState.totalImages = 1;
    viewerState.currentImagePath = 'C:\\images\\test.png';
    viewerState.isMetadataVisible = false;

    window.veloceAPI = {
      parseMetadata: vi.fn(async () => ({ prompt: 'test prompt' })),
      closeWindow: vi.fn()
    };
  });

  afterEach(() => {
    const overlay = document.getElementById('viewer-metadata-overlay');
    if (overlay) overlay.remove();
    viewerState.isMetadataVisible = false;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('表示時に .show と .prompt-pop クラスが付与されること', () => {
    toggleMetadataOverlay(true);

    const overlay = document.getElementById('viewer-metadata-overlay');
    expect(overlay).not.toBeNull();
    expect(viewerState.isMetadataVisible).toBe(true);
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.classList.contains('prompt-pop')).toBe(true);
    expect(overlay.classList.contains('prompt-hide')).toBe(false);
  });

  it('消去時に .show が解除され、.prompt-hide クラスが付与されること', () => {
    toggleMetadataOverlay(true);
    const overlay = document.getElementById('viewer-metadata-overlay');
    expect(overlay.classList.contains('show')).toBe(true);

    toggleMetadataOverlay(false);
    expect(viewerState.isMetadataVisible).toBe(false);
    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.classList.contains('prompt-pop')).toBe(false);
    expect(overlay.classList.contains('prompt-hide')).toBe(true);
  });

  it('消去アニメーション時間 (220ms) 経過後に .prompt-hide が安全に除去されること', () => {
    toggleMetadataOverlay(true);
    const overlay = document.getElementById('viewer-metadata-overlay');

    toggleMetadataOverlay(false);
    expect(overlay.classList.contains('prompt-hide')).toBe(true);

    // 100ms 経過時点ではまだアニメーション中
    vi.advanceTimersByTime(100);
    expect(overlay.classList.contains('prompt-hide')).toBe(true);

    // 220ms 経過でアニメーション完了クリーンアップ
    vi.advanceTimersByTime(120);
    expect(overlay.classList.contains('prompt-hide')).toBe(false);
    expect(overlay.classList.contains('show')).toBe(false);
  });

  it('消去アニメーション途中で再表示された場合、タイマーが解除され即座に .prompt-pop に切り替わること', () => {
    toggleMetadataOverlay(true);
    const overlay = document.getElementById('viewer-metadata-overlay');

    // 消去開始
    toggleMetadataOverlay(false);
    expect(overlay.classList.contains('prompt-hide')).toBe(true);

    // 100ms 後に再オープン
    vi.advanceTimersByTime(100);
    toggleMetadataOverlay(true);

    expect(overlay.classList.contains('prompt-hide')).toBe(false);
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.classList.contains('prompt-pop')).toBe(true);

    // さらに時間が経過しても消去用タイマーが誤発火しないこと
    vi.advanceTimersByTime(300);
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.classList.contains('prompt-hide')).toBe(false);
  });

  it('初期非表示状態で toggleMetadataOverlay(false) を呼んでも .prompt-hide は付与されないこと', () => {
    const overlay = createMetadataOverlay();
    expect(overlay.classList.contains('show')).toBe(false);

    toggleMetadataOverlay(false);
    expect(overlay.classList.contains('prompt-hide')).toBe(false);
  });

  it('p および P キーでプロンプトオーバーレイの開閉がトグルされること', () => {
    expect(viewerState.isMetadataVisible).toBe(false);

    // 'p' キーで表示
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    expect(viewerState.isMetadataVisible).toBe(true);
    const overlay = document.getElementById('viewer-metadata-overlay');
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.classList.contains('prompt-pop')).toBe(true);

    // 'P' キーで消去
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P' }));
    expect(viewerState.isMetadataVisible).toBe(false);
    expect(overlay.classList.contains('prompt-hide')).toBe(true);
  });

  it('CSS に左右方向のマイルドなアニメーション (viewerPromptPop / viewerPromptHide) が正しく定義されていること', () => {
    const css = getFullCssContent();

    // 表示用キーフレーム（左右方向のみ・マイルドな-4pxオーバーシュート）
    expect(css).toContain('@keyframes viewerPromptPop');
    expect(css).toMatch(/@keyframes viewerPromptPop\s*\{[\s\S]*translateX\(100%\)[\s\S]*translateX\(-4px\)[\s\S]*translateX\(0\)/);

    // 消去用キーフレーム (左右方向のみのマイルドな視覚的逆再生: 30%で-3pxわずかにクッションして右へ退場)
    expect(css).toContain('@keyframes viewerPromptHide');
    expect(css).toMatch(/@keyframes viewerPromptHide\s*\{[\s\S]*30%[\s\S]*translateX\(-3px\)[\s\S]*100%[\s\S]*translateX\(100%\)/);

    // 上下方向のアニメーション（viewerPromptSectionIn や translateY）が存在しないこと
    expect(css).not.toContain('@keyframes viewerPromptSectionIn');
    expect(css).not.toMatch(/@keyframes viewerPromptPop[^{]*\{[^}]*translateY/);
    expect(css).not.toMatch(/@keyframes viewerPromptHide[^{]*\{[^}]*translateY/);

    // クラス適用
    expect(css).toContain('.viewer-metadata-overlay.prompt-pop');
    expect(css).toContain('animation: viewerPromptPop 0.25s linear forwards;');
    expect(css).toContain('.viewer-metadata-overlay.prompt-hide');
    expect(css).toContain('animation: viewerPromptHide 0.22s linear forwards;');
  });

  it('クッションバウンス時の左移動で右側に画像が露出しないよう画面外拡張疑似要素 (::after) が定義されていること', () => {
    const css = getFullCssContent();

    // オーバーレイ本体の右側画面外拡張
    expect(css).toMatch(/\.viewer-metadata-overlay::after\s*\{[^}]*left:\s*100%;/);
    expect(css).toMatch(/\.viewer-metadata-overlay::after\s*\{[^}]*width:\s*20px;/);
    expect(css).toMatch(/\.viewer-metadata-overlay::after\s*\{[^}]*height:\s*100%;/);

    // ヘッダー部分の右側画面外拡張（ヘッダー背景色と下ボーダー同期）
    expect(css).toMatch(/\.viewer-metadata-header::after\s*\{[^}]*left:\s*100%;/);
    expect(css).toMatch(/\.viewer-metadata-header::after\s*\{[^}]*width:\s*20px;/);
    expect(css).toMatch(/\.viewer-metadata-header::after\s*\{[^}]*height:\s*40px;/);
  });

  it('プロンプト情報表示時に metadata-open クラスが付与され、非表示時に解除されること', () => {
    const controls = document.getElementById('window-controls');
    expect(document.body.classList.contains('metadata-open')).toBe(false);
    expect(controls.classList.contains('metadata-open')).toBe(false);

    // プロンプト情報表示
    toggleMetadataOverlay(true);
    expect(document.body.classList.contains('metadata-open')).toBe(true);
    expect(controls.classList.contains('metadata-open')).toBe(true);

    // プロンプト情報非表示
    toggleMetadataOverlay(false);
    expect(document.body.classList.contains('metadata-open')).toBe(false);
    expect(controls.classList.contains('metadata-open')).toBe(false);
  });

  it('CSS で metadata-open 適用時はコントロール部のホバー背景色がグラデーションなし（フラット）になること', () => {
    const css = getFullCssContent();

    // プロンプト表示中の最小化・最大化ホバー（フラットな背景色）
    expect(css).toMatch(/\.viewer-body\.metadata-open \.window-ctrl-btn--min:hover[^{]*\{[^}]*background:\s*var\(--accent-hover-translucent\);/);
    // プロンプト表示中の閉じるボタンホバー（フラットな背景色）
    expect(css).toMatch(/\.viewer-body\.metadata-open \.window-ctrl-btn--close:hover[^{]*\{[^}]*background:\s*var\(--danger-red-translucent\);/);
  });
});
