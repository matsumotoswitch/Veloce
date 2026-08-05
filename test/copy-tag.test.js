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
        writeText: vi.fn().mockResolvedValue(),
        readText: vi.fn().mockResolvedValue('')
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



  let _lastCopiedTags = "";
  const setupGlobalListener = () => {
    _lastCopiedTags = ""; // リセット
    document.body.addEventListener('click', async (e) => {
      const targetTag = e.target.closest('.diff-tag');
      if (targetTag) {
        const text = targetTag.textContent;
        if (text) {
          let textToCopy = text;
          let isAppended = false;
          if (e.ctrlKey && _lastCopiedTags) {
            isAppended = true;
            const currentTags = _lastCopiedTags.split(',').map(t => t.trim()).filter(t => t);
            if (!currentTags.includes(text)) {
              textToCopy = _lastCopiedTags + ', ' + text;
            } else {
              textToCopy = _lastCopiedTags;
            }
          }
          _lastCopiedTags = textToCopy;
          await navigator.clipboard.writeText(textToCopy);
          if (typeof uiManager !== 'undefined' && uiManager) {
            const displayTxt = textToCopy.length > 20 ? textToCopy.substring(0, 20) + '...' : textToCopy;
            const prefix = isAppended ? '追加コピーしました: ' : 'コピーしました: ';
            uiManager.showToast(prefix + displayTxt, 3000, null, 'success');
            uiManager.applyGlowEffect(targetTag);
          }
        }
      }
    }, true);
  };

  it('should copy text and show toast when diff-tag is clicked (global delegation)', async () => {
    const tagEl = document.createElement('span');
    tagEl.className = 'diff-tag';
    tagEl.textContent = 'test-diff';
    document.body.appendChild(tagEl);

    setupGlobalListener();

    // Dispatch click event that bubbles
    const event = new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: false });
    tagEl.dispatchEvent(event);
    
    // allow async clipboard write to resolve
    await new Promise(r => setTimeout(r, 0));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test-diff');
    expect(uiManager.showToast).toHaveBeenCalledWith('コピーしました: test-diff', 3000, null, 'success');
    expect(uiManager.applyGlowEffect).toHaveBeenCalledWith(tagEl);
  });

  it('should append text with comma when Ctrl+Click is used', async () => {
    setupGlobalListener();
    
    // 最初のクリック（通常クリック）で状態を設定
    const tag1 = document.createElement('span');
    tag1.className = 'diff-tag';
    tag1.textContent = 'existing-tag1';
    document.body.appendChild(tag1);
    
    const tag2 = document.createElement('span');
    tag2.className = 'diff-tag';
    tag2.textContent = 'new-tag';
    document.body.appendChild(tag2);

    tag1.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: false }));
    await new Promise(r => setTimeout(r, 0));

    // 追加のクリック（Ctrl+Click）
    tag2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 0));

    // 追加コピーされていることを確認
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('existing-tag1, new-tag');
    expect(uiManager.showToast).toHaveBeenCalledWith('追加コピーしました: existing-tag1, new-t...', 3000, null, 'success');
  });

  it('should not append duplicate text when Ctrl+Click is used', async () => {
    setupGlobalListener();
    
    const tagEl = document.createElement('span');
    tagEl.className = 'diff-tag';
    tagEl.textContent = 'new-tag';
    document.body.appendChild(tagEl);

    // 1回目のクリック
    tagEl.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: false }));
    await new Promise(r => setTimeout(r, 0));

    // 2回目のクリック（重複）
    tagEl.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 0));

    // 追加されず、そのままの文字列で writeText が呼ばれることを確認
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('new-tag');
  });
});
