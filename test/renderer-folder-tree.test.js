import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  createTreeNode,
  expandTreeToPath,
  scrollTreeItemIntoView,
  refreshTree,
  handleTreeNavigation,
  initFolderTree
} from '../src/renderer/renderer-folder-tree.js';

describe('Renderer Folder Tree Controller (renderer-folder-tree.js)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.currentDirectory = 'C:\\test';
    appState.tabs = [{ path: 'C:\\test', name: 'test' }];
    appState.activeTabIndex = 0;

    window.veloceAPI = {
      getFolders: vi.fn().mockResolvedValue([]),
      getDrives: vi.fn().mockResolvedValue(['C:\\']),
      loadDirectory: vi.fn().mockResolvedValue(undefined),
      setViewParams: vi.fn().mockResolvedValue(undefined)
    };

    global.CSS = window.CSS || { escape: (s) => s.replace(/([\\:])/g, '\\$1') };

    document.body.innerHTML = `
      <div id="directories-section" style="overflow: hidden;">
        <div class="pane-header">フォルダ</div>
        <div id="dir-tree" style="height: 400px; overflow: auto;"></div>
      </div>
    `;
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.renderTabs = vi.fn();
    uiManager.updateSelectionUI = vi.fn();
  });

  describe('createTreeNode', () => {
    it('should create node elements with proper CSS classes and attributes', () => {
      const node = createTreeNode({ name: 'folder1', path: 'C:\\folder1' });
      expect(node.classList.contains('tree-node')).toBe(true);

      const itemDiv = node.querySelector('.tree-item');
      expect(itemDiv).not.toBeNull();
      expect(itemDiv.dataset.path).toBe('C:\\folder1');
      expect(itemDiv.dataset.name).toBe('folder1');

      const toggle = node.querySelector('.tree-toggle');
      expect(toggle).not.toBeNull();

      const icon = node.querySelector('.tree-icon');
      expect(icon).not.toBeNull();

      const label = node.querySelector('.tree-label');
      expect(label.textContent).toBe('folder1');

      const childrenUl = node.querySelector('.tree-children');
      expect(childrenUl.classList.contains('collapsed')).toBe(true);
    });

    it('should expand and collapse node via expandNode and collapseNode closures', async () => {
      window.veloceAPI.getFolders.mockResolvedValueOnce([
        { name: 'sub1', path: 'C:\\folder1\\sub1' }
      ]);

      const node = createTreeNode({ name: 'folder1', path: 'C:\\folder1' });
      const itemDiv = node.querySelector('.tree-item');
      const childrenUl = node.querySelector('.tree-children');
      const toggle = node.querySelector('.tree-toggle');

      await itemDiv.expandNode();
      expect(childrenUl.classList.contains('expanded')).toBe(true);
      expect(childrenUl.classList.contains('collapsed')).toBe(false);
      expect(toggle.classList.contains('expanded')).toBe(true);
      expect(childrenUl.children.length).toBe(1);

      itemDiv.collapseNode();
      expect(childrenUl.classList.contains('expanded')).toBe(false);
      expect(childrenUl.classList.contains('collapsed')).toBe(true);
      expect(toggle.classList.contains('expanded')).toBe(false);
    });
  });

  describe('scrollTreeItemIntoView', () => {
    it('should scroll #dir-tree container (not #directories-section) to center target item', () => {
      const dirSection = document.getElementById('directories-section');
      const dirTree = document.getElementById('dir-tree');
      const node = createTreeNode({ name: 'folder1', path: 'C:\\folder1' });
      dirTree.appendChild(node);
      const itemDiv = node.querySelector('.tree-item');

      // dirTree のモック座標（高さ400px）
      dirTree.getBoundingClientRect = vi.fn(() => ({
        top: 100,
        bottom: 500,
        left: 0,
        right: 200,
        width: 200,
        height: 400
      }));
      dirTree.scrollTop = 0;
      dirSection.scrollTop = 0;

      // itemDiv のモック座標（画面下部 Y: 600、高さ30px）
      itemDiv.getBoundingClientRect = vi.fn(() => ({
        top: 600,
        bottom: 630,
        left: 10,
        right: 150,
        width: 140,
        height: 30
      }));

      scrollTreeItemIntoView(itemDiv, 'center');

      // #directories-section ではなく #dir-tree の scrollTop が中央位置にスクロールされること
      expect(dirSection.scrollTop).toBe(0);
      // targetScrollTop = 0 + (600 - 100) - (400 / 2) + (30 / 2) = 500 - 200 + 15 = 315
      expect(dirTree.scrollTop).toBe(315);
    });

    it('should scroll #dir-tree when block is nearest', () => {
      const dirTree = document.getElementById('dir-tree');
      const node = createTreeNode({ name: 'folder2', path: 'C:\\folder2' });
      dirTree.appendChild(node);
      const itemDiv = node.querySelector('.tree-item');

      dirTree.getBoundingClientRect = vi.fn(() => ({
        top: 100,
        bottom: 500,
        left: 0,
        right: 200,
        width: 200,
        height: 400
      }));
      dirTree.scrollTop = 0;

      // 下側に見切れている場合 (itemDiv bottom: 550, container bottom: 500)
      itemDiv.getBoundingClientRect = vi.fn(() => ({
        top: 520,
        bottom: 550,
        left: 10,
        right: 150,
        width: 140,
        height: 30
      }));

      scrollTreeItemIntoView(itemDiv, 'nearest');
      // scrollTop = 0 + (550 - 500) = 50
      expect(dirTree.scrollTop).toBe(50);
    });
  });

  describe('expandTreeToPath', () => {
    it('should expand path hierarchy in tree and scroll target into view', async () => {
      window.veloceAPI.getFolders.mockImplementation(async (path) => {
        if (path === 'C:\\') {
          return [{ name: 'test', path: 'C:\\test' }];
        }
        return [];
      });

      const rootNode = createTreeNode({ name: 'C:\\', path: 'C:\\' }, true);
      const ul = document.createElement('ul');
      ul.className = 'tree-root';
      ul.appendChild(rootNode);
      const dirTree = document.getElementById('dir-tree');
      dirTree.appendChild(ul);

      dirTree.getBoundingClientRect = vi.fn(() => ({
        top: 100,
        bottom: 500,
        left: 0,
        right: 200,
        width: 200,
        height: 400
      }));
      dirTree.scrollTop = 0;

      await expandTreeToPath('C:\\test', false);

      const itemDiv = dirTree.querySelector('.tree-item[data-path="C:\\\\test"]');
      expect(itemDiv).not.toBeNull();
      expect(itemDiv.classList.contains('selected')).toBe(true);
    });
  });

  describe('handleTreeNavigation', () => {
    it('should navigate between visible tree items on ArrowDown / ArrowUp', async () => {
      const node1 = createTreeNode({ name: 'folder1', path: 'C:\\folder1' });
      const node2 = createTreeNode({ name: 'folder2', path: 'C:\\folder2' });
      const ul = document.createElement('ul');
      ul.appendChild(node1);
      ul.appendChild(node2);
      document.getElementById('dir-tree').appendChild(ul);

      const item1 = node1.querySelector('.tree-item');
      item1.classList.add('selected');

      const refreshFileList = vi.fn();
      initFolderTree({ refreshFileList });

      await handleTreeNavigation('ArrowDown');
      const item2 = node2.querySelector('.tree-item');
      expect(item2.classList.contains('selected')).toBe(true);

      await handleTreeNavigation('ArrowUp');
      expect(item1.classList.contains('selected')).toBe(true);
    });
  });
});
