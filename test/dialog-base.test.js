import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  createDialogShell,
  createDialogButtons,
  createDialogMessage,
  showAppDialog
} from '../src/dialog-base.js';

describe('Dialog Base UI', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.KeyboardEvent = dom.window.KeyboardEvent;
    
    vi.useFakeTimers();
    global.requestAnimationFrame = cb => {
      cb();
      return 1;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
    delete global.KeyboardEvent;
  });

  describe('createDialogShell', () => {
    it('should create overlay and dialog container', () => {
      const { overlay, dialog, cleanup, bindEscape } = createDialogShell();
      expect(overlay.className).toBe('dialog-overlay');
      expect(dialog.className).toBe('dialog-box');
      expect(overlay.contains(dialog)).toBe(true);
      
      expect(typeof cleanup).toBe('function');
      expect(typeof bindEscape).toBe('function');
    });

    it('should remove overlay after cleanup (with animation delay)', () => {
      const { overlay, cleanup } = createDialogShell();
      document.body.appendChild(overlay);
      expect(document.body.contains(overlay)).toBe(true);
      
      cleanup();
      expect(overlay.classList.contains('show')).toBe(false);
      
      // Cleanup uses setTimeout of 200ms
      vi.advanceTimersByTime(250);
      expect(document.body.contains(overlay)).toBe(false);
    });

    it('should resolve with provided value when Escape is pressed', () => {
      const { bindEscape } = createDialogShell();
      
      const resolveMock = vi.fn();
      bindEscape(resolveMock, 'cancel');

      const escapeEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escapeEvent);

      expect(resolveMock).toHaveBeenCalledWith('cancel');
    });
  });

  describe('createDialogMessage', () => {
    it('should create text content by default', () => {
      const el = createDialogMessage('Hello World');
      expect(el.className).toBe('dialog-message');
      expect(el.textContent).toBe('Hello World');
      expect(el.innerHTML).toBe('Hello World');
    });

    it('should create HTML content if specified', () => {
      const el = createDialogMessage('<b>Hello</b>', { html: true, className: 'custom-class' });
      expect(el.className).toBe('custom-class');
      expect(el.innerHTML).toBe('<b>Hello</b>');
    });
  });

  describe('createDialogButtons', () => {
    it('should create buttons and bind click events to resolve', () => {
      const buttonsConfig = [
        { label: 'OK', className: 'btn-ok', value: 'ok' },
        { label: 'Cancel', className: 'btn-cancel', value: 'cancel' }
      ];

      const { buttonsDiv, bind } = createDialogButtons(buttonsConfig);
      expect(buttonsDiv.className).toBe('dialog-buttons');
      expect(buttonsDiv.children.length).toBe(2);
      expect(buttonsDiv.children[0].textContent).toBe('OK');
      expect(buttonsDiv.children[0].className).toBe('btn-ok');

      const resolveMock = vi.fn();
      const cleanupMock = vi.fn();
      
      bind(resolveMock, cleanupMock);
      
      buttonsDiv.children[1].click(); // Click Cancel

      expect(cleanupMock).toHaveBeenCalled();
      expect(resolveMock).toHaveBeenCalledWith('cancel');
    });
  });

  describe('showAppDialog', () => {
    it('should show dialog and resolve when button clicked', async () => {
      const config = {
        message: 'Are you sure?',
        buttons: [
          { label: 'Yes', className: 'btn-yes', value: true },
          { label: 'No', className: 'btn-no', value: false }
        ],
        escapeValue: false
      };

      const dialogPromise = showAppDialog(config);

      const overlay = document.querySelector('.dialog-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay.classList.contains('show')).toBe(true);

      const messageEl = document.querySelector('.dialog-message');
      expect(messageEl.textContent).toBe('Are you sure?');

      const btnYes = document.querySelector('.btn-yes');
      btnYes.click();

      const result = await dialogPromise;
      expect(result).toBe(true);
    });

    it('should resolve with escapeValue when Escape key is pressed', async () => {
      const config = {
        message: 'Prompt',
        buttons: [{ label: 'OK', className: 'btn-ok', value: 'ok' }],
        escapeValue: 'escaped'
      };

      const dialogPromise = showAppDialog(config);
      
      const escapeEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escapeEvent);

      const result = await dialogPromise;
      expect(result).toBe('escaped');
    });
  });
});
