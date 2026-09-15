import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { performUndo } from '../src/renderer-file-ops.js';

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
});
