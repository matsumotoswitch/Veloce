import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateFilename, checkPathExists } from '../src/path-utils.js';

describe('Path Utils', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('validateFilename', () => {
    it('should return valid true for normal filenames', () => {
      const result = validateFilename('normal_file_name.png');
      expect(result.valid).toBe(true);
      expect(result.message).toBe('');
    });

    it('should return valid false for empty names', () => {
      expect(validateFilename('').valid).toBe(false);
      expect(validateFilename('   ').valid).toBe(false);
      expect(validateFilename(null).valid).toBe(false);
    });

    it('should return valid false for names containing invalid characters', () => {
      const invalidChars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
      invalidChars.forEach(char => {
        const result = validateFilename(`file${char}name`);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('以下の文字は使用できません');
      });
    });
  });

  describe('checkPathExists', () => {
    afterEach(() => {
      delete window.veloceAPI;
    });

    it('should return true immediately if path is falsy or "PC"', async () => {
      expect(await checkPathExists(null)).toBe(true);
      expect(await checkPathExists('')).toBe(true);
      expect(await checkPathExists('PC')).toBe(true);
    });

    it('should return true if window.veloceAPI is not defined', async () => {
      expect(await checkPathExists('C:\\test')).toBe(true);
    });

    it('should return result from window.veloceAPI.pathExists', async () => {
      window.veloceAPI = {
        pathExists: vi.fn().mockResolvedValue(false)
      };
      
      expect(await checkPathExists('C:\\missing_folder')).toBe(false);
      expect(window.veloceAPI.pathExists).toHaveBeenCalledWith('C:\\missing_folder');
    });

    it('should return true if veloceAPI.pathExists throws an error', async () => {
      window.veloceAPI = {
        pathExists: vi.fn().mockRejectedValue(new Error('IPC Error'))
      };
      
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await checkPathExists('C:\\error_folder')).toBe(true);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
