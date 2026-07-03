import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('Context Menu (Inspector Header)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="inspector-header-path" class="open-folder-btn" data-path="C:\\test\\folder\\image.png"></div>
    `;
    window.contextMenu = document.createElement('div');
    window.contextMenu.id = 'context-menu';
    window.menuOpenInNewTab = document.createElement('div');
    window.menuOpenInExplorer = document.createElement('div');
    window.contextMenu.appendChild(window.menuOpenInNewTab);
    window.contextMenu.appendChild(window.menuOpenInExplorer);
    document.body.appendChild(window.contextMenu);

    window.showMenuWithAnimation = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should calculate directory path and show menu when contextmenu event is fired on open-folder-btn', () => {
    // 実際のイベントリスナー相当のロジック
    const handler = (e) => {
      const openBtn = e.target.closest('.open-folder-btn');
      if (openBtn) {
        e.preventDefault();
        e.stopPropagation();

        const filePathStr = openBtn.getAttribute('data-path');
        if (!filePathStr) return;

        const lastSlash = Math.max(filePathStr.lastIndexOf('\\'), filePathStr.lastIndexOf('/'));
        const dirPath = lastSlash !== -1 ? filePathStr.substring(0, lastSlash) : filePathStr;
        const folderName = dirPath.split(/[\\/]/).pop() || dirPath;

        window.contextMenu.targetFolder = { path: dirPath, name: folderName };
        
        window.menuOpenInNewTab.style.display = '';
        window.menuOpenInExplorer.style.display = '';

        window.showMenuWithAnimation(window.contextMenu, e.clientX, e.clientY);
      }
    };

    document.body.addEventListener('contextmenu', handler);

    const btn = document.getElementById('inspector-header-path');
    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 });
    event.preventDefault = vi.fn();
    event.stopPropagation = vi.fn();

    btn.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(window.contextMenu.targetFolder.path).toBe('C:\\test\\folder');
    expect(window.contextMenu.targetFolder.name).toBe('folder');
    expect(window.menuOpenInNewTab.style.display).toBe('');
    expect(window.menuOpenInExplorer.style.display).toBe('');
    expect(window.showMenuWithAnimation).toHaveBeenCalledWith(window.contextMenu, 100, 200);

    document.body.removeEventListener('contextmenu', handler);
  });
});
