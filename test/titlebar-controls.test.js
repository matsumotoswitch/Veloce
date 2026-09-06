import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Titlebar and Window Control Buttons Consistency', () => {
  const cssPath = path.resolve(__dirname, '../src/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

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

  it('should unify hover styling: translucent blue accent for min/max, translucent danger-red for close', () => {
    // メイン画面の最小化・最大化ホバー
    expect(cssContent).toMatch(/\.titlebar-button:hover\s*\{[^}]*background-color:\s*var\(--accent-hover-translucent\);/);
    expect(cssContent).toMatch(/\.titlebar-button:hover\s*\{[^}]*color:\s*var\(--text-light\);/);

    // ビューア画面の最小化・最大化ホバー
    expect(cssContent).toMatch(/\.window-ctrl-btn--min:hover[^}]*background-color:\s*var\(--accent-hover-translucent\);/);
    expect(cssContent).toMatch(/\.window-ctrl-btn--min:hover[^}]*color:\s*var\(--text-light\);/);

    // メイン画面の閉じるボタンホバー
    expect(cssContent).toMatch(/\.titlebar-button\.titlebar-close:hover\s*\{[^}]*background-color:\s*var\(--danger-red-translucent\);/);

    // ビューア画面の閉じるボタンホバー
    expect(cssContent).toMatch(/\.window-ctrl-btn--close:hover\s*\{[^}]*background-color:\s*var\(--danger-red-translucent\);/);
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
});
