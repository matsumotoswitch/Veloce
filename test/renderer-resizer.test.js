import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';
import { uiManager } from '../src/renderer/renderer-ui.js';
import {
  resizingState,
  createResizerToggle,
  setupResizer,
  initResizers,
  initResizerGlobalEvents
} from '../src/renderer/renderer-resizer.js';

describe('Renderer Resizer Controller (renderer-resizer.js)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.className = '';
    document.body.style.cursor = 'default';

    appState.layout = {
      leftVisible: true,
      rightVisible: true,
      leftTopVisible: true,
      leftWidth: 250,
      rightWidth: 300,
      leftTopHeight: 150,
      rightTopHeight: 200
    };

    uiManager.applyLayout = vi.fn();
    uiManager.elements.resizerLeft = document.createElement('div');
    uiManager.elements.resizerRight = document.createElement('div');
    uiManager.elements.resizerCenter = document.createElement('div');

    document.body.innerHTML = `
      <div id="resizer-left-pane"></div>
      <div id="resizer-right-pane"></div>
      <div id="center-pane" style="height: 500px;"></div>
      <div id="left-pane" style="height: 500px;"></div>
      <div id="right-pane" style="height: 500px;"></div>
    `;
  });

  describe('createResizerToggle', () => {
    it('should create vertical toggle button for left/right resizers', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'left');

      const btn = resizer.querySelector('.resizer-toggle');
      expect(btn).not.toBeNull();
      expect(btn.classList.contains('resizer-toggle-vertical')).toBe(true);
      expect(btn.classList.contains('resizer-toggle-horizontal')).toBe(false);
    });

    it('should create horizontal toggle button for center/leftTop/rightTop resizers', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'center');

      const btn = resizer.querySelector('.resizer-toggle');
      expect(btn).not.toBeNull();
      expect(btn.classList.contains('resizer-toggle-horizontal')).toBe(true);
      expect(btn.classList.contains('resizer-toggle-vertical')).toBe(false);
    });

    it('should toggle leftVisible and call uiManager.applyLayout on click', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'left');
      const btn = resizer.querySelector('.resizer-toggle');

      btn.click();
      expect(appState.layout.leftVisible).toBe(false);
      expect(btn.classList.contains('expanded')).toBe(true);
      expect(uiManager.applyLayout).toHaveBeenCalled();

      btn.click();
      expect(appState.layout.leftVisible).toBe(true);
      expect(btn.classList.contains('expanded')).toBe(false);
    });

    it('should toggle rightVisible and call uiManager.applyLayout on click', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'right');
      const btn = resizer.querySelector('.resizer-toggle');

      btn.click();
      expect(appState.layout.rightVisible).toBe(false);
      expect(btn.classList.contains('expanded')).toBe(true);
      expect(uiManager.applyLayout).toHaveBeenCalled();
    });

    it('should toggle center collapsed state and --top-height property on click', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'center');
      const btn = resizer.querySelector('.resizer-toggle');

      document.documentElement.style.setProperty('--top-height', '250px');
      btn.click();

      expect(document.documentElement.style.getPropertyValue('--top-height')).toBe('0px');
      expect(document.documentElement.getAttribute('data-center-collapsed')).toBe('true');
      expect(btn.classList.contains('expanded')).toBe(true);

      btn.click();
      expect(document.documentElement.style.getPropertyValue('--top-height')).toBe('250px');
      expect(document.documentElement.hasAttribute('data-center-collapsed')).toBe(false);
      expect(btn.classList.contains('expanded')).toBe(false);
    });
    it('should toggle leftTop (smart folders) collapsed state and height on click', () => {
      const resizer = document.createElement('div');
      createResizerToggle(resizer, 'leftTop');
      const btn = resizer.querySelector('.resizer-toggle');

      document.documentElement.style.setProperty('--left-top-height', '150px');
      btn.click();

      expect(document.documentElement.style.getPropertyValue('--left-top-height')).toBe('0px');
      expect(document.documentElement.getAttribute('data-left-top-collapsed')).toBe('true');
      expect(appState.layout.leftTopVisible).toBe(false);
      expect(btn.classList.contains('expanded')).toBe(true);

      btn.click();
      expect(document.documentElement.style.getPropertyValue('--left-top-height')).toBe('150px');
      expect(document.documentElement.hasAttribute('data-left-top-collapsed')).toBe(false);
      expect(appState.layout.leftTopVisible).toBe(true);
      expect(btn.classList.contains('expanded')).toBe(false);
    });
  });

  describe('setupResizer and mouseup dimension persistence', () => {
    it('should register mousedown event and set cursor and is-resizing class', () => {
      const resizer = document.createElement('div');
      setupResizer(resizer, 'left', 'col-resize');

      resizer.dispatchEvent(new MouseEvent('mousedown'));
      expect(resizingState.left).toBe(true);
      expect(resizer.classList.contains('resizing')).toBe(true);
      expect(document.body.style.cursor).toBe('col-resize');
      expect(document.body.classList.contains('is-resizing')).toBe(true);

      // Cleanup
      resizingState.left = false;
      document.body.classList.remove('is-resizing');
      document.body.style.cursor = 'default';
    });

    it('should persist widths and heights on window mouseup event', () => {
      initResizerGlobalEvents();

      // Left pane resize end
      resizingState.left = true;
      appState.layout.leftWidth = 320;
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(resizingState.left).toBe(false);
      expect(localStorage.getItem('leftWidth')).toBe('320');

      // Right pane resize end
      resizingState.right = true;
      appState.layout.rightWidth = 380;
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(resizingState.right).toBe(false);
      expect(localStorage.getItem('rightWidth')).toBe('380');

      // Center pane resize end
      resizingState.center = true;
      document.documentElement.style.setProperty('--top-height', '280px');
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(resizingState.center).toBe(false);
      expect(localStorage.getItem('topHeight')).toBe('280px');
      expect(localStorage.getItem('prevTopHeight')).toBe('280px');

      // Left-top pane resize end
      resizingState.leftTop = true;
      document.documentElement.style.setProperty('--left-top-height', '180px');
      appState.layout.leftTopVisible = true;
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(resizingState.leftTop).toBe(false);
      expect(localStorage.getItem('leftTopHeight')).toBe('180px');
      expect(localStorage.getItem('prevLeftTopHeight')).toBe('180px');
      expect(localStorage.getItem('leftTopVisible')).toBe('true');
    });
  });

  describe('updateResizerToggleStates', () => {
    it('should synchronize expanded class on all toggle buttons according to layout and DOM states', async () => {
      const { updateResizerToggleStates } = await import('../src/renderer/renderer-resizer.js');

      const leftResizer = uiManager.elements.resizerLeft;
      const rightResizer = uiManager.elements.resizerRight;
      const centerResizer = uiManager.elements.resizerCenter;
      const leftTopResizer = document.getElementById('resizer-left-pane');

      createResizerToggle(leftResizer, 'left');
      createResizerToggle(rightResizer, 'right');
      createResizerToggle(centerResizer, 'center');
      createResizerToggle(leftTopResizer, 'leftTop');

      const leftBtn = leftResizer.querySelector('.resizer-toggle');
      const rightBtn = rightResizer.querySelector('.resizer-toggle');
      const centerBtn = centerResizer.querySelector('.resizer-toggle');
      const leftTopBtn = leftTopResizer.querySelector('.resizer-toggle');

      // Initially all visible
      appState.layout.leftVisible = true;
      appState.layout.rightVisible = true;
      appState.layout.leftTopVisible = true;
      document.documentElement.removeAttribute('data-center-collapsed');
      document.documentElement.removeAttribute('data-left-top-collapsed');
      document.documentElement.style.setProperty('--top-height', '250px');
      document.documentElement.style.setProperty('--left-top-height', '150px');

      updateResizerToggleStates();

      expect(leftBtn.classList.contains('expanded')).toBe(false);
      expect(rightBtn.classList.contains('expanded')).toBe(false);
      expect(centerBtn.classList.contains('expanded')).toBe(false);
      expect(leftTopBtn.classList.contains('expanded')).toBe(false);

      // Now collapse all
      appState.layout.leftVisible = false;
      appState.layout.rightVisible = false;
      appState.layout.leftTopVisible = false;
      document.documentElement.setAttribute('data-center-collapsed', 'true');
      document.documentElement.setAttribute('data-left-top-collapsed', 'true');
      document.documentElement.style.setProperty('--top-height', '0px');
      document.documentElement.style.setProperty('--left-top-height', '0px');

      updateResizerToggleStates();

      expect(leftBtn.classList.contains('expanded')).toBe(true);
      expect(rightBtn.classList.contains('expanded')).toBe(true);
      expect(centerBtn.classList.contains('expanded')).toBe(true);
      expect(leftTopBtn.classList.contains('expanded')).toBe(true);
    });
  });

  describe('initResizers', () => {
    it('should initialize all resizers without throwing error', () => {
      expect(() => initResizers()).not.toThrow();
    });
  });
});

