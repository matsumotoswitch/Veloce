import { vi } from 'vitest';

// モック用のグローバルオブジェクト
window.__TAURI__ = {
  invoke: vi.fn(),
  convertFileSrc: vi.fn(path => `asset://${path}`),
  fs: {
    readDir: vi.fn(),
    createDir: vi.fn(),
    renameFile: vi.fn(),
    copyFile: vi.fn(),
    removeFile: vi.fn()
  },
  path: {
    join: vi.fn((...args) => args.join('/')),
    basename: vi.fn(p => p.split('/').pop()),
    dirname: vi.fn(p => p.split('/').slice(0, -1).join('/'))
  }
};

window.veloceAPI = {
  trashFile: vi.fn(),
  trashFolder: vi.fn(),
  renameFile: vi.fn(),
  renameFolder: vi.fn(),
  moveOrCopyFile: vi.fn()
};
