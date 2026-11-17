import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('preload getFolders', () => {
  let originalWindow;

  beforeEach(() => {
    vi.resetModules();
  });

  it('should call get_subfolders via invoke when available', async () => {
    const mockSubfolders = [
      { name: 'sub1', path: 'C:\\test\\sub1', hasChildren: true },
      { name: 'sub2', path: 'C:\\test\\sub2', hasChildren: false }
    ];

    const invokeMock = vi.fn().mockResolvedValue(mockSubfolders);
    window.__TAURI__ = {
      invoke: invokeMock,
      event: { listen: vi.fn() },
      window: { appWindow: {} }
    };

    // preload.js を実行して window.veloceAPI を構築
    await import('../src/common/preload.js');

    const result = await window.veloceAPI.getFolders('C:\\test');

    expect(invokeMock).toHaveBeenCalledWith('get_subfolders', { dirPath: 'C:\\test' });
    expect(result).toEqual(mockSubfolders);
  });

  it('should fallback to fs.readDir when get_subfolders fails', async () => {
    const invokeMock = vi.fn().mockRejectedValue(new Error('Command not found'));
    const readDirMock = vi.fn().mockResolvedValue([
      { name: 'file1.txt', path: 'C:\\test\\file1.txt' },
      { name: 'sub2', path: 'C:\\test\\sub2', children: [] },
      { name: 'sub10', path: 'C:\\test\\sub10', children: [] }
    ]);

    window.__TAURI__ = {
      invoke: invokeMock,
      fs: { readDir: readDirMock },
      event: { listen: vi.fn() },
      window: { appWindow: {} }
    };

    await import('../src/common/preload.js');

    const result = await window.veloceAPI.getFolders('C:\\test');

    expect(invokeMock).toHaveBeenCalledWith('get_subfolders', { dirPath: 'C:\\test' });
    expect(readDirMock).toHaveBeenCalledWith('C:\\test');
    // ファイルは除外され、自然順（sub2 -> sub10）でソートされる
    expect(result).toEqual([
      { name: 'sub2', path: 'C:\\test\\sub2' },
      { name: 'sub10', path: 'C:\\test\\sub10' }
    ]);
  });

  it('should return empty array when both invoke and fallback fail', async () => {
    const invokeMock = vi.fn().mockRejectedValue(new Error('Invoke error'));
    const readDirMock = vi.fn().mockRejectedValue(new Error('Permission denied'));

    window.__TAURI__ = {
      invoke: invokeMock,
      fs: { readDir: readDirMock },
      event: { listen: vi.fn() },
      window: { appWindow: {} }
    };

    await import('../src/common/preload.js');

    const result = await window.veloceAPI.getFolders('C:\\invalid');
    expect(result).toEqual([]);
  });
});

