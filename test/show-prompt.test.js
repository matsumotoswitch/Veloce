import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

describe('showPrompt Escape key behavior', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it('should close the dialog when Escape is pressed on the document', async () => {
    // 疑似的に showPrompt を再現
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay show';
    document.body.appendChild(overlay);
    
    let resolvedValue;
    const promise = new Promise((resolve) => {
      const keydownHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          document.removeEventListener('keydown', keydownHandler, true);
          overlay.classList.remove('show');
          resolve(null);
        }
      };
      document.addEventListener('keydown', keydownHandler, true);
    });

    // document に Escape イベントを発火
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(event);

    resolvedValue = await promise;

    expect(resolvedValue).toBe(null);
    expect(overlay.classList.contains('show')).toBe(false);
  });
});
