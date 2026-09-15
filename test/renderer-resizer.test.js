import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer-state.js';
import { uiManager } from '../src/renderer-ui.js';
import {
  resizingState,
  createResizerToggle,
  setupResizer,
  initResizers,
  initResizerGlobalEvents
} from '../src/renderer-resizer.js';

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
  });

  describe('setupResizer', () => {
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
  });

  describe('initResizers', () => {
    it('should initialize all resizers without throwing error', () => {
      expect(() => initResizers()).not.toThrow();
    });
  });
});
