import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Titlebar and Window Control Buttons Consistency', () => {
  const cssContent = getFullCssContent();

  it('should unify button dimensions (48px width, 40px height / 100%) between main window and viewer', () => {
    // メイン画面のタイトルバーボタン: 幅 48px, 高さ 100%
    expect(cssContent).toMatch(/\.titlebar-button\s*\{[^}]*width:\s*48px;/);
    expect(cssContent).toMatch(/\.titlebar-button\s*\{[^}]*height:\s*100%;/);

    // ビューア画面のウィンドウコントロールボタン: 幅 48px, 高さ 40px
    expect(cssContent).toMatch(/\.window-ctrl-btn\s*\{[^}]*width:\s*48px;/);
    expect(cssContent).toMatch(/\.window-ctrl-btn\s*\{[^}]*height:\s*40px;/);
  });

  it('should unify SVG icon dimensions to 12px x 12px for both main and viewer control buttons', () => {
    // メイン画面のSVG
    expect(cssContent).toMatch(/\.titlebar-button svg\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/);

    // ビューア画面のSVG
    expect(cssContent).toMatch(/\.window-ctrl-btn svg\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/);
  });

  it('should define appropriate hover styling: translucent accent/danger for main window, gradient matching header for viewer', () => {
    // メイン画面の最小化・最大化ホバー
    expect(cssContent).toMatch(/\.titlebar-button:hover\s*\{[^}]*background-color:\s*var\(--accent-hover-translucent\);/);
    expect(cssContent).toMatch(/\.titlebar-button:hover\s*\{[^}]*color:\s*var\(--text-light\);/);

    // ビューア画面の最小化・最大化ホバー（ヘッダ部のフェードグラデーションと調和するグラデーション）
    expect(cssContent).toMatch(/\.window-ctrl-btn--min:hover[^}]*background:\s*linear-gradient\(to bottom,\s*rgba\(var\(--accent-hover-rgb\)/);
    expect(cssContent).toMatch(/\.window-ctrl-btn--min:hover[^}]*color:\s*var\(--text-light\);/);

    // メイン画面の閉じるボタンホバー
    expect(cssContent).toMatch(/\.titlebar-button\.titlebar-close:hover\s*\{[^}]*background-color:\s*var\(--danger-red-translucent\);/);

    // ビューア画面の閉じるボタンホバー（ヘッダ部のフェードグラデーションと調和するグラデーション）
    expect(cssContent).toMatch(/\.window-ctrl-btn--close:hover\s*\{[^}]*background:\s*linear-gradient\(to bottom,\s*rgba\(var\(--danger-rgb\)/);
  });

  it('should define matching SVG icons with currentColor in UIManager and ViewerUI', async () => {
    const { UIManager } = await import('../src/renderer-ui.js');
    const { ViewerUI } = await import('../src/viewer-ui.js');

    expect(UIManager.ICONS.WINDOW_MINIMIZE).toBe(ViewerUI.ICONS.MINIMIZE);
    expect(UIManager.ICONS.WINDOW_MAXIMIZE).toBe(ViewerUI.ICONS.MAXIMIZE);
    expect(UIManager.ICONS.WINDOW_RESTORE).toBe(ViewerUI.ICONS.RESTORE);
    expect(UIManager.ICONS.WINDOW_CLOSE).toBe(ViewerUI.ICONS.CLOSE);

    // ハードコードされた #fff ではなく currentColor を使用していること
    expect(ViewerUI.ICONS.MINIMIZE).not.toContain('#fff');
    expect(ViewerUI.ICONS.MAXIMIZE).not.toContain('#fff');
    expect(ViewerUI.ICONS.RESTORE).not.toContain('#fff');
    expect(ViewerUI.ICONS.CLOSE).not.toContain('#fff');

    expect(ViewerUI.ICONS.MINIMIZE).toContain('currentColor');
    expect(ViewerUI.ICONS.MAXIMIZE).toContain('currentColor');
    expect(ViewerUI.ICONS.RESTORE).toContain('currentColor');
    expect(ViewerUI.ICONS.CLOSE).toContain('currentColor');
  });

  it('should unify titlebar button hover transition (0.15s ease) between main window and viewer', () => {
    // メイン画面のタイトルバーボタン: 0.15s ease
    expect(cssContent).toMatch(/\.titlebar-button\s*\{[^}]*transition:\s*background-color\s+0\.15s\s+ease,\s*color\s+0\.15s\s+ease;/);

    // ビューア画面のウィンドウコントロールボタン: 0.15s ease
    expect(cssContent).toMatch(/\.window-ctrl-btn\s*\{[^}]*transition:\s*background\s+0\.15s\s+ease,\s*background-color\s+0\.15s\s+ease,\s*color\s+0\.15s\s+ease;/);
  });

  it('should maintain transparent background on viewer control buttons and info container to prevent obtrusiveness', () => {
    // コントロールボタンは常時視認化（目立つ背景色）を避け、通常時 transparent であること
    expect(cssContent).toMatch(/\.window-ctrl-btn\s*\{[^}]*background-color:\s*transparent;/);
    // アイコン輪郭の自然な視認性確保のため、ボタン矩形ではなくSVGアイコンにのみドロップシャドウを適用
    expect(cssContent).toMatch(/\.window-ctrl-btn svg\s*\{[^}]*filter:\s*drop-shadow\(/);
    // ホバー時はボタン矩形・アイコンともに不要な影を完全に排除すること
    expect(cssContent).toMatch(/\.window-ctrl-btn:hover\s*\{[^}]*filter:\s*none;/);
    expect(cssContent).toMatch(/\.window-ctrl-btn:hover svg\s*\{[^}]*filter:\s*none;/);

    // 情報コンテナのテキストシャドウ（背景色ボックスなしで輪郭を保護）
    expect(cssContent).toMatch(/\.viewer-rating-display\s*\{[^}]*text-shadow:\s*0 1px 3px/);
    expect(cssContent).toMatch(/\.window-scale-display\s*\{[^}]*text-shadow:\s*0 1px 3px/);
  });
});
