import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { UIManager, uiManager } from '../src/renderer-ui.js';

describe('UIManager Toast Management (Section 3-B)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="toast-container"></div></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    vi.useFakeTimers();
    global.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };
    global.cancelAnimationFrame = vi.fn();

    // Reset uiManager toastContainer
    uiManager.toastContainer = document.getElementById('toast-container');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
  });

  describe('showToast', () => {
    it('creates container if missing and appends toast element', () => {
      const existingContainer = document.getElementById('toast-container');
      existingContainer.remove();
      uiManager.toastContainer = null;

      uiManager.showToast('Test Notification', 3000, null, 'info');

      const container = document.getElementById('toast-container');
      expect(container).not.toBeNull();
      const toast = container.querySelector('.toast-message');
      expect(toast).not.toBeNull();
      expect(toast.textContent).toBe('Test Notification');
      expect(toast.classList.contains('show')).toBe(true);
    });

    it('sets correct id attribute when id is specified', () => {
      uiManager.showToast('Loading', 0, 'sample-task', 'info');

      const toast = document.getElementById('toast-sample-task');
      expect(toast).not.toBeNull();
      expect(toast.id).toBe('toast-sample-task');
    });

    it('normalizes id when already prefixed with toast-', () => {
      uiManager.showToast('Loading with prefix', 0, 'toast-prefixed-task', 'info');

      const toast = document.getElementById('toast-prefixed-task');
      expect(toast).not.toBeNull();
      expect(document.getElementById('toast-toast-prefixed-task')).toBeNull();
    });

    it('updates existing toast text and class without duplicating DOM elements', () => {
      uiManager.showToast('Initial message', 0, 'updatable', 'info');
      const firstEl = document.getElementById('toast-updatable');
      expect(firstEl.textContent).toBe('Initial message');

      uiManager.showToast('Updated message', 0, 'updatable', 'success');
      const secondEl = document.getElementById('toast-updatable');
      expect(secondEl).toBe(firstEl);
      expect(secondEl.textContent).toBe('Updated message');
      expect(secondEl.classList.contains('success')).toBe(true);
      expect(secondEl.classList.contains('info')).toBe(false);

      const allToasts = document.querySelectorAll('.toast-message');
      expect(allToasts.length).toBe(1);
    });

    it('stays persistent when duration is 0', () => {
      uiManager.showToast('Persistent task', 0, 'persistent-task', 'info');

      const toast = document.getElementById('toast-persistent-task');
      expect(toast).not.toBeNull();

      vi.advanceTimersByTime(10000);
      expect(document.getElementById('toast-persistent-task')).not.toBeNull();
      expect(toast.classList.contains('show')).toBe(true);
    });

    it('auto-dismisses after duration when duration > 0', () => {
      uiManager.showToast('Auto dismiss', 1000, 'auto-task', 'info');
      const toast = document.getElementById('toast-auto-task');
      expect(toast.classList.contains('show')).toBe(true);

      // duration (1000ms)
      vi.advanceTimersByTime(1000);
      expect(toast.classList.contains('show')).toBe(false);

      // fade-out animation (300ms)
      vi.advanceTimersByTime(300);
      expect(document.getElementById('toast-auto-task')).toBeNull();
    });
  });

  describe('dismissToast', () => {
    it('dismisses toast and removes it from DOM after fade-out using short id', () => {
      uiManager.showToast('In progress...', 0, 'operation-x', 'info');
      const toast = document.getElementById('toast-operation-x');
      expect(toast).not.toBeNull();
      expect(toast.classList.contains('show')).toBe(true);

      uiManager.dismissToast('operation-x');

      // Immediately removes show class
      expect(toast.classList.contains('show')).toBe(false);
      expect(document.getElementById('toast-operation-x')).not.toBeNull();

      // Removes element after 300ms animation
      vi.advanceTimersByTime(300);
      expect(document.getElementById('toast-operation-x')).toBeNull();
    });

    it('dismisses toast when full toast- prefix id is passed', () => {
      uiManager.showToast('In progress...', 0, 'operation-y', 'info');
      const toast = document.getElementById('toast-operation-y');
      expect(toast).not.toBeNull();

      uiManager.dismissToast('toast-operation-y');

      expect(toast.classList.contains('show')).toBe(false);
      vi.advanceTimersByTime(300);
      expect(document.getElementById('toast-operation-y')).toBeNull();
    });

    it('clears pending auto-dismiss timeout if dismissed early', () => {
      uiManager.showToast('Auto dismiss soon', 5000, 'operation-z', 'info');
      const toast = document.getElementById('toast-operation-z');
      expect(toast.timeoutId).not.toBeNull();

      uiManager.dismissToast('operation-z');
      expect(toast.timeoutId).toBeNull();
      expect(toast.classList.contains('show')).toBe(false);

      vi.advanceTimersByTime(300);
      expect(document.getElementById('toast-operation-z')).toBeNull();
    });

    it('handles non-existent or falsy IDs gracefully', () => {
      expect(() => {
        uiManager.dismissToast(null);
        uiManager.dismissToast(undefined);
        uiManager.dismissToast('');
        uiManager.dismissToast('non-existent-id');
      }).not.toThrow();
    });
  });

  describe('Static UIManager helpers', () => {
    it('UIManager.showToast delegates to uiManager instance', () => {
      const spy = vi.spyOn(uiManager, 'showToast');
      UIManager.showToast('Static call', 2000, 'static-toast', 'warning');
      expect(spy).toHaveBeenCalledWith('Static call', 2000, 'static-toast', 'warning');
    });

    it('UIManager.dismissToast delegates to uiManager instance', () => {
      const spy = vi.spyOn(uiManager, 'dismissToast');
      UIManager.dismissToast('static-toast');
      expect(spy).toHaveBeenCalledWith('static-toast');
    });

    it('UIManager.dismissToast falls back to direct DOM removal if uiManager is null', () => {
      const container = document.getElementById('toast-container');
      const el = document.createElement('div');
      el.id = 'toast-standalone';
      el.className = 'toast-message show';
      container.appendChild(el);

      // Call static directly without throwing
      UIManager.dismissToast('standalone');
      expect(el.classList.contains('show')).toBe(false);

      vi.advanceTimersByTime(300);
      expect(document.getElementById('toast-standalone')).toBeNull();
    });
  });
});
