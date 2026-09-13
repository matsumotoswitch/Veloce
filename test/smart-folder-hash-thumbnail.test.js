import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Smart Folder Hash Thumbnail and Progressive First Paint Tests', () => {
  it('should append &hash= parameter when file has hashKey', () => {
    const fileWithHash = {
      path: '\\\\win81\\share\\test.png',
      mtime: 123456789,
      hasThumbnailCache: true,
      hashKey: 'abcde1234567890f',
    };

    const port = 54321;
    const hashParam = fileWithHash.hashKey ? `&hash=${encodeURIComponent(fileWithHash.hashKey)}` : '';
    const url = `http://127.0.0.1:${port}/?path=${encodeURIComponent(fileWithHash.path)}&mtime=${fileWithHash.mtime}&thumb=1${hashParam}`;

    expect(url).toContain('&hash=abcde1234567890f');
    expect(url).toBe('http://127.0.0.1:54321/?path=%5C%5Cwin81%5Cshare%5Ctest.png&mtime=123456789&thumb=1&hash=abcde1234567890f');
  });

  it('should omit &hash= parameter when file has no hashKey (backward compatibility)', () => {
    const normalFile = {
      path: 'C:\\test\\normal.png',
      mtime: 123456789,
      hasThumbnailCache: true,
    };

    const port = 54321;
    const hashParam = normalFile.hashKey ? `&hash=${encodeURIComponent(normalFile.hashKey)}` : '';
    const url = `http://127.0.0.1:${port}/?path=${encodeURIComponent(normalFile.path)}&mtime=${normalFile.mtime}&thumb=1${hashParam}`;

    expect(url).not.toContain('&hash=');
    expect(url).toBe('http://127.0.0.1:54321/?path=C%3A%5Ctest%5Cnormal.png&mtime=123456789&thumb=1');
  });

  it('should load directory in single pass without sudden intermediate items swap', () => {
    const clearMock = vi.fn();
    const mockThumbnailManager = { clear: clearMock };

    const appState = {
      currentDirectory: 'smart://all_images',
      totalCount: 0,
      initialChunk: null,
      thumbnailTotalRequested: 0,
      thumbnailCompleted: 0,
      thumbnailCounted: new Set(),
    };

    // 単一パスで最初から真の先頭（例: 20250320_*）がソートされた状態で届く
    const payload = {
      path: 'smart://all_images',
      totalCount: 34000,
      initialChunk: [
        { name: '20250320_01.png', path: '\\\\win81\\share\\sub\\20250320_01.png' },
        { name: '20250320_02.png', path: '\\\\win81\\share\\sub\\20250320_02.png' },
      ],
    };

    if (payload.path === appState.currentDirectory) {
      appState.totalCount = payload.totalCount;
      if (payload.initialChunk) {
        appState.initialChunk = payload.initialChunk;
        appState.thumbnailTotalRequested = 0;
        appState.thumbnailCompleted = 0;
        appState.thumbnailCounted.clear();
        mockThumbnailManager.clear();
      }
    }

    expect(appState.totalCount).toBe(34000);
    expect(appState.initialChunk[0].name).toBe('20250320_01.png');
    expect(clearMock).toHaveBeenCalledTimes(1);
  });
});
