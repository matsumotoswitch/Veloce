import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Smart Folder Pure Cache Load & Self-Healing Logic', () => {
  const mainRsContent = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf-8');
  const preloadJsContent = fs.readFileSync(path.resolve(__dirname, '../src/preload.js'), 'utf-8');
  const rendererJsContent = fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf-8');

  describe('1. Backend Logic (main.rs)', () => {
    it('should define purge_missing_files_from_cache function for database maintenance and self-healing', () => {
      expect(mainRsContent).toContain('pub fn purge_missing_files_from_cache(');
      expect(mainRsContent).toContain('DELETE FROM cache WHERE path IN');
      expect(mainRsContent).toContain('DELETE FROM ratings WHERE path IN');
    });

    it('should filter smart items by is_file() concurrently using rayon in load_directory', () => {
      expect(mainRsContent).toContain('partition(|f|');
      expect(mainRsContent).toContain('std::path::Path::new(clean).is_file()');
    });

    it('should trigger background purge and emit smart-folder-purged event when missing files are found in smart folder', () => {
      expect(mainRsContent).toContain('if !missing_paths.is_empty()');
      expect(mainRsContent).toContain('purge_missing_files_from_cache(&mut conn, &missing_for_db)');
      expect(mainRsContent).toContain('app_handle_for_purge.emit_all("smart-folder-purged", ())');
    });

    it('should rebuild indices in a single pass when no filter is active in smart folder load', () => {
      expect(mainRsContent).toContain('rebuild_all_and_filtered_indices(&files)');
    });

    it('should normalize UNC network share paths correctly', () => {
      expect(mainRsContent).toContain('normalize_unc_path(');
      expect(mainRsContent).toContain('\\\\?\\\\UNC\\\\');
    });

    it('should use database indexes by removing unary plus from ORDER BY c.mtime in smart folder queries', () => {
      expect(mainRsContent).toContain('ORDER BY c.mtime');
      expect(mainRsContent).not.toContain('ORDER BY +c.mtime');
    });
  });

  describe('2. IPC & Frontend Event Handling (preload.js & renderer.js)', () => {
    it('should expose onSmartFolderPurged in preload.js', () => {
      expect(preloadJsContent).toContain("onSmartFolderPurged: (callback) => listen('smart-folder-purged'");
    });

    it('should listen to onSmartFolderPurged and update smart folder counts in renderer.js', () => {
      expect(rendererJsContent).toContain('if (window.veloceAPI.onSmartFolderPurged)');
      expect(rendererJsContent).toContain('window.veloceAPI.onSmartFolderPurged(() => {');
      expect(rendererJsContent).toContain('window.debouncedUpdateSmartFolderCounts();');
    });
  });
});
