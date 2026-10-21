import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Video Seek Bar', () => {
  beforeEach(() => {
    // Mock ResizeObserver
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    // Remove previous viewerImg if any
    const oldImg = document.getElementById('viewer-img');
    if (oldImg) oldImg.remove();
    
    // Create viewer UI elements
    const viewerImg = document.createElement('video');
    viewerImg.id = 'viewer-img';
    document.body.appendChild(viewerImg);

    // Mock HTMLMediaElement methods for JSDOM
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();

    // Mock APIs
    window.veloceAPI = {
      convertFileSrc: vi.fn(),
      showWindow: vi.fn(),
      setWindowSize: vi.fn().mockResolvedValue()
    };
    window.showToast = vi.fn();
  });

  it('should toggle video seek bar on "s" keypress', async () => {
    // Dynamic import to load viewer.js and initialize event listeners
    await import('../src/viewer/viewer.js');

    // Give viewer.js time to attach listeners
    await new Promise(r => setTimeout(r, 50));

    // Initial state: seek bar might not exist, or if it does, it's not visible
    const getContainer = () => document.getElementById('video-controls-container');
    if (getContainer()) {
      getContainer().style.display = 'none';
    }

    // Simulate 's' keypress
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

    // Seek bar should be created and visible
    const container = getContainer();
    expect(container).not.toBeNull();
    expect(container.style.display).not.toBe('none');

    // Simulate 's' keypress again
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

    // Seek bar should be hidden
    expect(container.style.display).toBe('none');
  });

  it('should prevent propagation of mouse events on seek bar', async () => {
    await import('../src/viewer/viewer.js');
    
    // Show seek bar
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    const container = document.getElementById('video-controls-container');
    
    // Create a mock listener on window to check if event bubbles
    const windowListener = vi.fn();
    window.addEventListener('mousedown', windowListener);
    
    // Dispatch mousedown on container
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    
    // Should be stopped
    expect(windowListener).not.toHaveBeenCalled();
    
    window.removeEventListener('mousedown', windowListener);
  });

  it('should define line-height: 1 and tabular-nums for video-time-display', () => {
    const cssContent = getFullCssContent();

    expect(cssContent).toMatch(/#video-time-display\s*\{[^}]*line-height:\s*1;/);
    expect(cssContent).toMatch(/#video-time-display\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/);
  });

  it('should use form-label class for favorite and smart folder icon editor sections', async () => {
    const { createFavoriteEditorUI } = await import('../src/renderer/renderer-ui.js');
    const container = document.createElement('div');
    createFavoriteEditorUI(container, 'star', 'default');

    const labels = container.querySelectorAll('.form-label');
    expect(labels.length).toBe(2);
    expect(labels[0].textContent).toBe('アイコンを選択');
    expect(labels[1].textContent).toBe('カラーを選択');
  });

  it('should configure high transparency (low opacity) when idle and low transparency (high opacity) when hovered', () => {
    const cssContent = getFullCssContent();

    // 通常時（非ホバー時）: 存在が分かる程度に透明度を高く（opacity 0.35, 背景 0.65）
    expect(cssContent).toMatch(/#video-controls-container\s*\{[^}]*opacity:\s*0\.35;/);
    expect(cssContent).toMatch(/#video-controls-container\s*\{[^}]*background:\s*rgba\(var\(--panel-rgb\),\s*0\.65\);/);
    expect(cssContent).toMatch(/#video-controls-container\s*\{[^}]*transition:[^}]*opacity/);

    // ホバー時: 操作・視認に支障がない低い透明度（opacity 0.95, 背景 0.95）
    // 操作後にフォーカスが残って透明度が戻らなくなる不具合を防ぐため、:focus-withinは使用せず:hoverのみとする
    expect(cssContent).toMatch(/#video-controls-container:hover\s*\{[^}]*opacity:\s*0\.95;/);
    expect(cssContent).toMatch(/#video-controls-container:hover\s*\{[^}]*background:\s*rgba\(var\(--panel-rgb\),\s*0\.95\);/);
    expect(cssContent).not.toMatch(/#video-controls-container:focus-within/);
  });

  it('should blur seek bar elements on mouseleave, click, and change to restore transparency', async () => {
    await import('../src/viewer/viewer.js');
    window.setVideoSeekBarVisibility(true);

    const container = document.getElementById('video-controls-container');
    const seekBar = document.getElementById('video-seek-bar');
    const playBtn = document.getElementById('video-play-btn');

    expect(container).not.toBeNull();
    expect(seekBar).not.toBeNull();
    expect(playBtn).not.toBeNull();

    // シークバー操作完了時（change）にフォーカスが解除されること
    seekBar.focus();
    expect(document.activeElement).toBe(seekBar);
    seekBar.dispatchEvent(new Event('change'));
    expect(document.activeElement).not.toBe(seekBar);

    // 再生ボタンクリック時にフォーカスが解除されること
    playBtn.focus();
    expect(document.activeElement).toBe(playBtn);
    playBtn.dispatchEvent(new MouseEvent('click'));
    expect(document.activeElement).not.toBe(playBtn);

    // シークバーにフォーカスがある状態でマウスがコンテナ外へ離れた際（mouseleave）にフォーカスが解除されること
    seekBar.focus();
    expect(document.activeElement).toBe(seekBar);
    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.activeElement).not.toBe(seekBar);
  });

  it('should have "show-viewer-seekbar-chk" checkbox in index.html right after filename checkbox', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    expect(htmlContent).toContain('id="show-viewer-seekbar-chk"');
    expect(htmlContent).toContain('ビュー画面にシークバーを表示');

    // ファイル名チェックボックスの後にシークバーチェックボックスが配置されている順序を検証
    const nameIndex = htmlContent.indexOf('id="show-viewer-name-chk"');
    const seekbarIndex = htmlContent.indexOf('id="show-viewer-seekbar-chk"');
    expect(nameIndex).toBeGreaterThan(-1);
    expect(seekbarIndex).toBeGreaterThan(nameIndex);
  });

  it('should read showViewerSeekBar setting via isDefaultSeekBarEnabled', async () => {
    await import('../src/viewer/viewer.js');

    // 規定（未設定）は false
    localStorage.removeItem('showViewerSeekBar');
    expect(window.isDefaultSeekBarEnabled()).toBe(false);

    // true に設定された場合
    localStorage.setItem('showViewerSeekBar', 'true');
    expect(window.isDefaultSeekBarEnabled()).toBe(true);

    // false に設定された場合
    localStorage.setItem('showViewerSeekBar', 'false');
    expect(window.isDefaultSeekBarEnabled()).toBe(false);
  });

  it('should show seek bar by default when showViewerSeekBar is true and video is loaded', async () => {
    await import('../src/viewer/viewer.js');
    localStorage.setItem('showViewerSeekBar', 'true');

    window.setVideoSeekBarVisibility(window.isDefaultSeekBarEnabled());
    const container = document.getElementById('video-controls-container');
    expect(container).not.toBeNull();
    expect(container.style.display).toBe('flex');
  });

  it('should not show seek bar by default when showViewerSeekBar is false', async () => {
    await import('../src/viewer/viewer.js');
    localStorage.setItem('showViewerSeekBar', 'false');

    window.setVideoSeekBarVisibility(window.isDefaultSeekBarEnabled());
    const container = document.getElementById('video-controls-container');
    expect(container.style.display).toBe('none');
  });

  it('should toggle seek bar with "s" key without mutating showViewerSeekBar in storage', async () => {
    await import('../src/viewer/viewer.js');
    localStorage.setItem('showViewerSeekBar', 'false');

    const initialStorageVal = localStorage.getItem('showViewerSeekBar');
    expect(initialStorageVal).toBe('false');

    // Sキーでトグル（表示）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    const container = document.getElementById('video-controls-container');
    expect(container.style.display).toBe('flex');

    // 設定値は書き換わっていないこと（Sキーは設定を保存しない）
    expect(localStorage.getItem('showViewerSeekBar')).toBe('false');

    // 再度Sキーでトグル（非表示）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    expect(container.style.display).toBe('none');
    expect(localStorage.getItem('showViewerSeekBar')).toBe('false');
  });
});
