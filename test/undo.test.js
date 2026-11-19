import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { performUndo } from '../src/renderer/renderer-file-ops.js';

describe('Undo Functionality', () => {
  beforeEach(() => {
    appState.undoStack = [];
    vi.clearAllMocks();

    window.veloceAPI = {
      renameFile: vi.fn().mockResolvedValue({ success: true }),
      moveOrCopyFile: vi.fn().mockResolvedValue({ success: true }),
      renameFolder: vi.fn().mockResolvedValue({ success: true })
    };

    window.__TAURI__ = {
      path: {
        basename: vi.fn(async (p) => p.split('/').pop()),
        dirname: vi.fn(async (p) => p.substring(0, p.lastIndexOf('/')))
      },
      fs: {
        removeFile: vi.fn().mockResolvedValue(undefined)
      }
    };
  });

  it('should push actions to the undo stack', () => {
    appState.undoStack.push({
      type: 'RENAME_FILE',
      oldPath: '/dir/old.png',
      newPath: '/dir/new.png'
    });
    expect(appState.undoStack.length).toBe(1);
    expect(appState.undoStack[0].type).toBe('RENAME_FILE');
  });

  it('should pop and perform undo for RENAME_FILE', async () => {
    appState.undoStack.push({
      type: 'RENAME_FILE',
      oldPath: '/dir/old.png',
      newPath: '/dir/new.png'
    });

    await performUndo();
    
    expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('/dir/new.png', 'old.png');
    expect(appState.undoStack.length).toBe(0);
  });

  it('should pop and perform undo for MOVE_FILE', async () => {
    appState.undoStack.push({
      type: 'MOVE_FILE',
      sourcePath: '/source/file.png',
      targetPath: '/dest/file.png'
    });

    await performUndo();
    
    expect(window.__TAURI__.path.dirname).toHaveBeenCalledWith('/source/file.png');
    expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledWith('/dest/file.png', '/source', 'move');
    expect(appState.undoStack.length).toBe(0);
  });

  it('should pop and perform undo for MOVE_FILE and restore ratings in appState', async () => {
    appState.ratings = { '/dest/file.png': 3 };
    appState.undoStack.push({
      type: 'MOVE_FILE',
      sourcePath: '/source/file.png',
      targetPath: '/dest/file.png'
    });

    window.veloceAPI.moveOrCopyFile.mockResolvedValue({
      success: true,
      action: 'move',
      targetPath: '/source/file.png'
    });

    await performUndo();

    expect(window.veloceAPI.moveOrCopyFile).toHaveBeenCalledWith('/dest/file.png', '/source', 'move');
    expect(appState.ratings['/source/file.png']).toBe(3);
    expect(appState.ratings['/dest/file.png']).toBeUndefined();
    expect(appState.undoStack.length).toBe(0);
  });

  it('should not overwrite or pop undo stack when MOVE_FILE undo detects a conflict at original directory', async () => {
    window.veloceAPI.checkConflicts = vi.fn().mockResolvedValue(['/dest/file.png']);
    appState.undoStack.push({
      type: 'MOVE_FILE',
      sourcePath: '/source/file.png',
      targetPath: '/dest/file.png'
    });

    await performUndo();

    expect(window.veloceAPI.checkConflicts).toHaveBeenCalledWith(['/dest/file.png'], '/source');
    expect(window.veloceAPI.moveOrCopyFile).not.toHaveBeenCalled();
    expect(appState.undoStack.length).toBe(1);
  });

  it('should retain action on undo stack when operation fails', async () => {
    window.veloceAPI.renameFile.mockResolvedValue({ success: false, error: 'Exists' });
    appState.undoStack.push({
      type: 'RENAME_FILE',
      oldPath: '/dir/old.png',
      newPath: '/dir/new.png'
    });

    await performUndo();

    expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('/dir/new.png', 'old.png');
    expect(appState.undoStack.length).toBe(1);
  });

  it('should use trashFile instead of permanent removeFile when undoing COPY_FILE', async () => {
    window.veloceAPI.trashFile = vi.fn().mockResolvedValue(true);
    window.veloceAPI.notifyFileRemoved = vi.fn().mockResolvedValue(undefined);
    appState.undoStack.push({
      type: 'COPY_FILE',
      targetPath: '/dest/copied.png'
    });

    await performUndo();

    expect(window.veloceAPI.trashFile).toHaveBeenCalledWith('/dest/copied.png');
    expect(window.__TAURI__.fs.removeFile).not.toHaveBeenCalled();
    expect(window.veloceAPI.notifyFileRemoved).toHaveBeenCalledWith('/dest/copied.png');
    expect(appState.undoStack.length).toBe(0);
  });

  it('clears thumbnailUrls for both old and new paths and restores ratings when undoing RENAME_FILE', async () => {
    appState.thumbnailUrls.set('/dir/old.png', 'blob:http://localhost/old');
    appState.thumbnailUrls.set('/dir/new.png', 'blob:http://localhost/new');
    appState.ratings = { '/dir/new.png': 5 };

    const scheduleRefreshMock = vi.fn();

    appState.undoStack.push({
      type: 'RENAME_FILE',
      oldPath: '/dir/old.png',
      newPath: '/dir/new.png'
    });

    window.veloceAPI.renameFile.mockResolvedValue({ success: true, path: '/dir/old.png' });

    await performUndo({ scheduleRefresh: scheduleRefreshMock });

    expect(window.veloceAPI.renameFile).toHaveBeenCalledWith('/dir/new.png', 'old.png');
    expect(appState.thumbnailUrls.has('/dir/old.png')).toBe(false);
    expect(appState.thumbnailUrls.has('/dir/new.png')).toBe(false);
    expect(appState.ratings['/dir/old.png']).toBe(5);
    expect(appState.ratings['/dir/new.png']).toBeUndefined();
    expect(scheduleRefreshMock).toHaveBeenCalled();
    expect(appState.undoStack.length).toBe(0);
  });

  it('migrates descendant ratings when undoing RENAME_FOLDER without touching sibling folder', async () => {
    appState.ratings = {
      'C:\\album_renamed\\sub\\a.png': 4,
      'C:\\album_renamed2\\b.png': 3
    };

    appState.undoStack.push({
      type: 'RENAME_FOLDER',
      oldPath: 'C:\\album',
      newPath: 'C:\\album_renamed'
    });

    window.veloceAPI.renameFolder.mockResolvedValue({ success: true, path: 'C:\\album' });

    await performUndo();

    expect(appState.ratings['C:\\album\\sub\\a.png']).toBe(4);
    expect(appState.ratings['C:\\album_renamed\\sub\\a.png']).toBeUndefined();
    expect(appState.ratings['C:\\album_renamed2\\b.png']).toBe(3);
  });
});
