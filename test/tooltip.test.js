import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { UIManager, uiManager } from '../src/renderer/renderer-ui.js';

describe('UIManager bindTooltip (Section 2-A)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body><div id="test-btn" title="Old title">Button</div></body></html>`, {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.MouseEvent = dom.window.MouseEvent;
    uiManager.initCustomTooltip();
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.MouseEvent;
    vi.restoreAllMocks();
  });

  it('removes title attribute and registers mouseenter, mousemove, mouseleave listeners', () => {
    const btn = document.getElementById('test-btn');
    const showSpy = vi.spyOn(uiManager, 'showCustomTooltip');
    const hideSpy = vi.spyOn(uiManager, 'hideCustomTooltip');

    uiManager.bindTooltip(btn, 'ヘルプテキスト');

    expect(btn.hasAttribute('title')).toBe(false);

    const mouseEnterEvent = new dom.window.MouseEvent('mouseenter', { clientX: 50, clientY: 100 });
    btn.dispatchEvent(mouseEnterEvent);
    expect(showSpy).toHaveBeenCalledWith('ヘルプテキスト', 50, 100);

    const mouseMoveEvent = new dom.window.MouseEvent('mousemove', { clientX: 60, clientY: 110 });
    btn.dispatchEvent(mouseMoveEvent);
    expect(showSpy).toHaveBeenCalledWith('ヘルプテキスト', 60, 110);

    btn.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
    expect(hideSpy).toHaveBeenCalled();
  });

  it('supports dynamic text function', () => {
    const btn = document.getElementById('test-btn');
    const showSpy = vi.spyOn(uiManager, 'showCustomTooltip');
    let count = 0;

    uiManager.bindTooltip(btn, () => `アイテム数: ${++count}`);

    btn.dispatchEvent(new dom.window.MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    expect(showSpy).toHaveBeenCalledWith('アイテム数: 1', 10, 20);

    btn.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 15, clientY: 25 }));
    expect(showSpy).toHaveBeenCalledWith('アイテム数: 2', 15, 25);
  });

  it('respects isDisabled option and element.disabled', () => {
    const btn = document.getElementById('test-btn');
    const showSpy = vi.spyOn(uiManager, 'showCustomTooltip');
    let disabledFlag = true;

    uiManager.bindTooltip(btn, '無効時テキスト', {
      isDisabled: () => disabledFlag
    });

    btn.dispatchEvent(new dom.window.MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    expect(showSpy).not.toHaveBeenCalled();

    disabledFlag = false;
    btn.dispatchEvent(new dom.window.MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    expect(showSpy).toHaveBeenCalledWith('無効時テキスト', 10, 20);

    showSpy.mockClear();
    btn.disabled = true;
    btn.dispatchEvent(new dom.window.MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    expect(showSpy).not.toHaveBeenCalled();
  });

  it('invokes onMouseEnter hook on mouseenter', () => {
    const btn = document.getElementById('test-btn');
    const hookSpy = vi.fn();

    uiManager.bindTooltip(btn, 'テキスト', {
      onMouseEnter: hookSpy
    });

    btn.dispatchEvent(new dom.window.MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    expect(hookSpy).toHaveBeenCalled();
  });

  it('stops event propagation when stopPropagation is true', () => {
    const btn = document.getElementById('test-btn');
    uiManager.bindTooltip(btn, 'テキスト', { stopPropagation: true });

    const enterEvent = new dom.window.MouseEvent('mouseenter', { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(enterEvent, 'stopPropagation');
    btn.dispatchEvent(enterEvent);
    expect(stopSpy).toHaveBeenCalled();

    const leaveEvent = new dom.window.MouseEvent('mouseleave', { bubbles: true, cancelable: true });
    const leaveStopSpy = vi.spyOn(leaveEvent, 'stopPropagation');
    btn.dispatchEvent(leaveEvent);
    expect(leaveStopSpy).toHaveBeenCalled();
  });

  it('hides tooltip on click', () => {
    const btn = document.getElementById('test-btn');
    const hideSpy = vi.spyOn(uiManager, 'hideCustomTooltip');

    uiManager.bindTooltip(btn, 'テキスト');
    btn.dispatchEvent(new dom.window.MouseEvent('click'));

    expect(hideSpy).toHaveBeenCalled();
  });

  it('delegates to instance when static UIManager.bindTooltip is called', () => {
    const btn = document.getElementById('test-btn');
    const instanceSpy = vi.spyOn(uiManager, 'bindTooltip');

    UIManager.bindTooltip(btn, '静的呼び出しテキスト');
    expect(instanceSpy).toHaveBeenCalledWith(btn, '静的呼び出しテキスト', {});
  });
});
