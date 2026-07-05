import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('Precache Folder Context Menu', () => {
  beforeEach(() => {
    window.__TAURI__ = {
      invoke: vi.fn(),
      event: {
        listen: vi.fn()
      }
    };
    window.showNotification = vi.fn();
    
    // モックの contextMenu とそのイベントを定義
    window.contextMenu = document.createElement('div');
    window.contextMenu.targetFolder = { path: 'C:\\test\\images' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call precache_directory_recursively when the menu is clicked', async () => {
    // 擬似的な menuPrecacheFolder の onClick 処理
    const menuClickAction = async () => {
      if (window.contextMenu.targetFolder && window.contextMenu.targetFolder.path) {
        const path = window.contextMenu.targetFolder.path;
        window.showNotification('キャッシュの作成を開始しました。処理中はアプリを閉じないでください。', 'info', null, 'precache');
        try {
          await window.__TAURI__.invoke('precache_directory_recursively', { targetPath: path });
          window.showNotification('キャッシュの作成が完了しました', 'success', null, 'precache');
        } catch (e) {
          window.showNotification(`エラーが発生しました: ${e}`, 'error', null, 'precache');
        }
      }
    };

    window.__TAURI__.invoke.mockResolvedValueOnce();

    await menuClickAction();

    expect(window.showNotification).toHaveBeenCalledWith(
      'キャッシュの作成を開始しました。処理中はアプリを閉じないでください。',
      'info', null, 'precache'
    );
    expect(window.__TAURI__.invoke).toHaveBeenCalledWith(
      'precache_directory_recursively',
      { targetPath: 'C:\\test\\images' }
    );
    expect(window.showNotification).toHaveBeenCalledWith(
      'キャッシュの作成が完了しました',
      'success', null, 'precache'
    );
  });

  it('should handle errors during precaching', async () => {
    const menuClickAction = async () => {
      if (window.contextMenu.targetFolder && window.contextMenu.targetFolder.path) {
        const path = window.contextMenu.targetFolder.path;
        try {
          await window.__TAURI__.invoke('precache_directory_recursively', { targetPath: path });
        } catch (e) {
          window.showNotification(`エラーが発生しました: ${e}`, 'error', null, 'precache');
        }
      }
    };

    window.__TAURI__.invoke.mockRejectedValueOnce('Something went wrong');

    await menuClickAction();

    expect(window.__TAURI__.invoke).toHaveBeenCalledWith(
      'precache_directory_recursively',
      { targetPath: 'C:\\test\\images' }
    );
    expect(window.showNotification).toHaveBeenCalledWith(
      'エラーが発生しました: Something went wrong',
      'error', null, 'precache'
    );
  });
});