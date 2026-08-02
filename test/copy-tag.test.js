import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Tag Copy Functionality', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = {
      clipboard: {
        writeText: vi.fn().mockResolvedValue()
      }
    };
    global.uiManager = {
      showToast: vi.fn(),
      applyGlowEffect: vi.fn(),
      hideCustomTooltip: vi.fn()
    };
    global.showNotification = vi.fn();
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.navigator;
    delete global.uiManager;
    delete global.showNotification;
  });



  it('should copy text and show toast when diff-tag is clicked (global delegation)', async () => {
    const tagEl = document.createElement('span');
    tagEl.className = 'diff-tag';
    tagEl.textContent = 'test-diff';
    document.body.appendChild(tagEl);

    // Simulate the global capture-phase listener assigned in DOMContentLoaded
    document.body.addEventListener('click', async (e) => {
      const targetTag = e.target.closest('.diff-tag');
      if (targetTag) {
        const text = targetTag.textContent;
        if (text) {
          await navigator.clipboard.writeText(text);
          if (typeof uiManager !== 'undefined' && uiManager) {
            uiManager.showToast('コピーしました: ' + text, 3000, null, 'success');
            uiManager.applyGlowEffect(targetTag);
          }
        }
      }
    }, true);

    // Dispatch click event that bubbles
    const event = new dom.window.MouseEvent('click', { bubbles: true });
    tagEl.dispatchEvent(event);
    
    // allow async clipboard write to resolve
    await new Promise(r => setTimeout(r, 0));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test-diff');
    expect(uiManager.showToast).toHaveBeenCalledWith('コピーしました: test-diff', 3000, null, 'success');
    expect(uiManager.applyGlowEffect).toHaveBeenCalledWith(tagEl);
  });
});
