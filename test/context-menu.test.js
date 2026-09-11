import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initInspectorDelegation, resetInspectorDelegationForTest } from '../src/renderer-inspector.js';

describe('Context Menu (Inspector Header)', () => {
  let mockCmm;

  beforeEach(() => {
    resetInspectorDelegationForTest();
    document.body.innerHTML = `
      <div id="right-pane">
        <div id="inspector-header">
          <div id="inspector-header-path" class="open-folder-btn" data-path="C:\\test\\folder\\image.png"></div>
        </div>
        <div id="inspector-content"></div>
      </div>
    `;

    mockCmm = {
      show: vi.fn(),
      hide: vi.fn()
    };
    window.contextMenuManager = mockCmm;
  });

  afterEach(() => {
    resetInspectorDelegationForTest();
    delete window.contextMenuManager;
    delete window.veloceAPI;
    vi.restoreAllMocks();
  });

  it('should calculate directory path and show menu via window.contextMenuManager when contextmenu is fired on open-folder-btn', () => {
    initInspectorDelegation();

    const btn = document.getElementById('inspector-header-path');
    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 });
    event.preventDefault = vi.fn();
    event.stopPropagation = vi.fn();

    btn.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(mockCmm.show).toHaveBeenCalledWith(
      'inspector-header',
      { targetFolder: { path: 'C:\\test\\folder', name: 'folder' }, isRoot: false },
      100,
      200
    );
  });

  it('should show menu when contextmenu is fired on inspector-header container', () => {
    initInspectorDelegation();

    const header = document.getElementById('inspector-header');
    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 250 });
    event.preventDefault = vi.fn();
    event.stopPropagation = vi.fn();

    header.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(mockCmm.show).toHaveBeenCalledWith(
      'inspector-header',
      { targetFolder: { path: 'C:\\test\\folder', name: 'folder' }, isRoot: false },
      150,
      250
    );
  });

  it('should show menu when contextMenuManager is passed in options', () => {
    delete window.contextMenuManager;
    initInspectorDelegation({ contextMenuManager: mockCmm });

    const btn = document.getElementById('inspector-header-path');
    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 });
    btn.dispatchEvent(event);

    expect(mockCmm.show).toHaveBeenCalledWith(
      'inspector-header',
      { targetFolder: { path: 'C:\\test\\folder', name: 'folder' }, isRoot: false },
      100,
      200
    );
  });

  it('should NOT show menu when inspector-header-path has no data-path', () => {
    initInspectorDelegation();

    const btn = document.getElementById('inspector-header-path');
    btn.removeAttribute('data-path');

    const event = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 });
    btn.dispatchEvent(event);

    expect(mockCmm.show).not.toHaveBeenCalled();
  });

  it('should NOT open in explorer when left clicking the open-folder-btn', () => {
    initInspectorDelegation();

    const btn = document.getElementById('inspector-header-path');
    window.veloceAPI = { openInExplorer: vi.fn() };

    const event = new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 200 });
    btn.dispatchEvent(event);

    expect(window.veloceAPI.openInExplorer).not.toHaveBeenCalled();
  });
});

describe('normalizeMenuItems (Separator Normalization)', () => {
  let normalizeMenuItems;

  beforeEach(async () => {
    const mod = await import('../src/renderer-context-menu.js');
    normalizeMenuItems = mod.normalizeMenuItems;
  });

  it('should remove leading and trailing separators', () => {
    const items = [
      { type: 'separator' },
      { id: 'item1', label: 'Item 1' },
      { id: 'item2', label: 'Item 2' },
      { type: 'separator' }
    ];

    const result = normalizeMenuItems(items);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('item1');
    expect(result[1].id).toBe('item2');
  });

  it('should collapse consecutive separators into a single separator', () => {
    const items = [
      { id: 'item1', label: 'Item 1' },
      { type: 'separator' },
      { type: 'separator' },
      { type: 'separator' },
      { id: 'item2', label: 'Item 2' }
    ];

    const result = normalizeMenuItems(items);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('item1');
    expect(result[1].type).toBe('separator');
    expect(result[2].id).toBe('item2');
  });

  it('should exclude items when visible(ctx) evaluates to false and normalize remaining separators', () => {
    const items = [
      { id: 'item1', label: 'Item 1' },
      { type: 'separator' },
      { id: 'item2', label: 'Item 2', visible: (ctx) => !ctx.hideItem2 },
      { type: 'separator' },
      { id: 'item3', label: 'Item 3' }
    ];

    // item2 が非表示の場合、separator が連続するため1つに統合される
    const resultHidden = normalizeMenuItems(items, { hideItem2: true });
    expect(resultHidden).toHaveLength(3);
    expect(resultHidden[0].id).toBe('item1');
    expect(resultHidden[1].type).toBe('separator');
    expect(resultHidden[2].id).toBe('item3');

    // item2 が表示される場合
    const resultVisible = normalizeMenuItems(items, { hideItem2: false });
    expect(resultVisible).toHaveLength(5);
    expect(resultVisible[0].id).toBe('item1');
    expect(resultVisible[1].type).toBe('separator');
    expect(resultVisible[2].id).toBe('item2');
    expect(resultVisible[3].type).toBe('separator');
    expect(resultVisible[4].id).toBe('item3');
  });

  it('should return empty array when all items are separators or invisible', () => {
    const items = [
      { type: 'separator' },
      { id: 'item1', label: 'Item 1', visible: () => false },
      { type: 'separator' }
    ];

    const result = normalizeMenuItems(items);
    expect(result).toHaveLength(0);
  });

  it('should handle non-array or empty input safely', () => {
    expect(normalizeMenuItems(null)).toEqual([]);
    expect(normalizeMenuItems(undefined)).toEqual([]);
    expect(normalizeMenuItems([])).toEqual([]);
  });
});

describe('ContextMenuManager', () => {
  let ContextMenuManager;
  let manager;
  let menuContainer;

  beforeEach(async () => {
    const mod = await import('../src/renderer-context-menu.js');
    ContextMenuManager = mod.ContextMenuManager;

    document.body.innerHTML = '<div id="context-menu"></div>';
    menuContainer = document.getElementById('context-menu');
    manager = new ContextMenuManager(menuContainer);
  });

  it('should register and render menu items via DOM Pool', () => {
    const actionSpy = vi.fn();
    manager.register('test-context', [
      { id: 'test-action', label: 'Test Action', action: actionSpy },
      { type: 'separator' },
      { id: 'second-action', label: 'Second Action' }
    ]);

    manager.show('test-context', { customData: 123 }, 50, 100);

    // DOM要素がコンテナ内に2件（アクション+セパレータ+アクション）正しく配置される
    expect(menuContainer.children.length).toBe(3);
    const item1 = menuContainer.children[0];
    const sep = menuContainer.children[1];
    const item2 = menuContainer.children[2];

    expect(item1.classList.contains('context-menu-item')).toBe(true);
    expect(item1.querySelector('.menu-label').textContent).toBe('Test Action');
    expect(sep.classList.contains('menu-separator')).toBe(true);
    expect(item2.querySelector('.menu-label').textContent).toBe('Second Action');

    // DOM Poolの検証: 再度 show を呼んでも同一の DOM 要素インスタンスが再利用される
    manager.show('test-context', { customData: 456 }, 50, 100);
    expect(menuContainer.children[0]).toBe(item1);
    expect(menuContainer.children[2]).toBe(item2);
  });

  it('should trigger action and hide menu when item is clicked', () => {
    const actionSpy = vi.fn();
    manager.register('click-context', [
      { id: 'clickable', label: 'Click Me', action: actionSpy }
    ]);

    manager.show('click-context', { value: 'target-data' }, 10, 10);
    const item = menuContainer.children[0];

    // クリック実行
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(actionSpy).toHaveBeenCalledWith({ value: 'target-data' });
    expect(menuContainer.classList.contains('show')).toBe(false);
  });

  it('should apply disabled state and opacity when enabled(ctx) is false', () => {
    manager.register('enabled-test', [
      { id: 'item-disabled', label: 'Disabled Item', enabled: (ctx) => !ctx.locked },
      { id: 'item-enabled', label: 'Enabled Item', enabled: (ctx) => ctx.locked }
    ]);

    manager.show('enabled-test', { locked: true }, 0, 0);

    const el1 = menuContainer.children[0];
    const el2 = menuContainer.children[1];

    expect(el1.disabled).toBe(true);
    expect(el1.style.opacity).toBe('0.5');
    expect(el1.style.pointerEvents).toBe('none');
    expect(el1.classList.contains('disabled')).toBe(true);

    expect(el2.disabled).toBe(false);
    expect(el2.style.opacity).toBe('1');
    expect(el2.style.pointerEvents).toBe('auto');
    expect(el2.classList.contains('disabled')).toBe(false);
  });

  it('should call beforeShow hook when specified', () => {
    const beforeShowSpy = vi.fn();
    manager.register('hook-test', [
      { id: 'hooked-item', label: 'Hooked', beforeShow: beforeShowSpy }
    ]);

    const ctx = { tabId: 99 };
    manager.show('hook-test', ctx, 10, 20);

    expect(beforeShowSpy).toHaveBeenCalled();
    expect(beforeShowSpy.mock.calls[0][1]).toBe(ctx);
  });

  it('should hide menu and clear active context on hide()', () => {
    manager.register('dummy', [{ id: 'd1', label: 'D' }]);
    manager.show('dummy', {}, 0, 0);
    menuContainer.classList.add('show');

    manager.hide();
    expect(menuContainer.classList.contains('show')).toBe(false);
    expect(manager.activeContext).toBeNull();
  });
});

