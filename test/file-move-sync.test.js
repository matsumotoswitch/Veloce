import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('File Move Cache and Rating Sync (Section 4)', () => {
  const preloadPath = path.resolve(__dirname, '../src/common/preload.js');
  const mainRsPath = path.resolve(__dirname, '../src-tauri/src/main.rs');
  const preloadCode = fs.readFileSync(preloadPath, 'utf-8');
  const mainRsCode = fs.readFileSync(mainRsPath, 'utf-8');

  describe('Static Contract Tests', () => {
    it('main.rs defines sync_path_rename_in_db function', () => {
      expect(mainRsCode).toContain('pub fn sync_path_rename_in_db(');
      expect(mainRsCode).toContain('UPDATE ratings SET path = ?1 WHERE path = ?2 COLLATE NOCASE OR path = ?3 COLLATE NOCASE');
      expect(mainRsCode).toContain('SELECT mtime, hash_key FROM cache WHERE path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE');
    });

    it('main.rs defines sync_file_move command and registers it in invoke_handler', () => {
      expect(mainRsCode).toContain('async fn sync_file_move(');
      expect(mainRsCode).toContain('sync_path_rename_in_db(&state, &old_path, &new_path);');
      expect(mainRsCode).toContain('sync_file_move,');
    });

    it('preload.js exposes syncFileMove API', () => {
      expect(preloadCode).toContain("syncFileMove: (oldPath, newPath) => invoke('sync_file_move', { oldPath, newPath })");
    });

    it('preload.js invokes sync_file_move on successful file move in moveOrCopyFile', () => {
      expect(preloadCode).toContain("await invoke('sync_file_move', { oldPath: sourcePath, newPath: targetPath })");
    });
  });

  describe('preload.js moveOrCopyFile Behavior', () => {
    let mockInvoke;
    let mockFs;
    let mockPath;

    beforeEach(() => {
      mockInvoke = vi.fn().mockResolvedValue(undefined);
      mockFs = {
        copyFile: vi.fn().mockResolvedValue(undefined),
        renameFile: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined)
      };
      mockPath = {
        basename: vi.fn(async (p) => p.split(/[/\\]/).pop()),
        dirname: vi.fn(async (p) => p.substring(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))),
        join: vi.fn(async (dir, base) => `${dir}\\${base}`)
      };

      window.__TAURI__ = {
        invoke: mockInvoke,
        tauri: { invoke: mockInvoke },
        fs: mockFs,
        path: mockPath,
        event: { listen: vi.fn() },
        window: { appWindow: {} }
      };

      // preload.js を実行して window.veloceAPI を構築
      const runPreload = new Function('window', preloadCode);
      runPreload(window);
    });

    it('invokes sync_file_move when move operation succeeds', async () => {
      const source = 'C:\\source\\image.png';
      const targetDir = 'C:\\dest';

      const result = await window.veloceAPI.moveOrCopyFile(source, targetDir, 'move');

      expect(result.success).toBe(true);
      expect(result.action).toBe('move');
      expect(mockFs.renameFile).toHaveBeenCalledWith(source, 'C:\\dest\\image.png');
      expect(mockInvoke).toHaveBeenCalledWith('sync_file_move', {
        oldPath: source,
        newPath: 'C:\\dest\\image.png'
      });
    });

    it('does not invoke sync_file_move when copy operation is requested', async () => {
      const source = 'C:\\source\\image.png';
      const targetDir = 'C:\\dest';

      const result = await window.veloceAPI.moveOrCopyFile(source, targetDir, 'copy');

      expect(result.success).toBe(true);
      expect(result.action).toBe('copy');
      expect(mockFs.copyFile).toHaveBeenCalledWith(source, 'C:\\dest\\image.png');
      expect(mockInvoke).not.toHaveBeenCalledWith('sync_file_move', expect.anything());
    });

    it('safely completes move even if sync_file_move throws error', async () => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'sync_file_move') {
          throw new Error('DB lock error');
        }
      });

      const source = 'C:\\source\\image.png';
      const targetDir = 'C:\\dest';

      const result = await window.veloceAPI.moveOrCopyFile(source, targetDir, 'move');

      expect(result.success).toBe(true);
      expect(result.action).toBe('move');
    });

    it('syncFileMove API calls invoke with sync_file_move', async () => {
      await window.veloceAPI.syncFileMove('C:\\old.png', 'C:\\new.png');

      expect(mockInvoke).toHaveBeenCalledWith('sync_file_move', {
        oldPath: 'C:\\old.png',
        newPath: 'C:\\new.png'
      });
    });
  });
});
