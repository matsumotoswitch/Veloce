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

    global.CSS = { escape: vi.fn(s => s) };

    document.body.innerHTML = `
      <div id="directories-section" style="height: 400px; overflow: auto;">
        <div id="dir-tree"></div>
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
    it('should calculate container scrollTop without throwing', () => {
      const node = createTreeNode({ name: 'folder1', path: 'C:\\folder1' });
      document.getElementById('dir-tree').appendChild(node);
      const itemDiv = node.querySelector('.tree-item');

      expect(() => scrollTreeItemIntoView(itemDiv, 'center')).not.toThrow();
      expect(() => scrollTreeItemIntoView(itemDiv, 'nearest')).not.toThrow();
    });
  });

  describe('expandTreeToPath', () => {
    it('should expand path hierarchy in tree', async () => {
      const rootNode = createTreeNode({ name: 'C:\\', path: 'C:\\' }, true);
      const ul = document.createElement('ul');
      ul.className = 'tree-root';
      ul.appendChild(rootNode);
      document.getElementById('dir-tree').appendChild(ul);

      await expandTreeToPath('C:\\test', true);
      expect(global.CSS.escape).toHaveBeenCalled();
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
