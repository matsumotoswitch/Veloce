import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UIManager } from '../src/renderer-ui.js';
import { appState } from '../src/renderer-state.js';

describe('Tab Drag and Drop', () => {
  let uiManager;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="tab-container">
        <button id="new-tab-btn"></button>
      </div>
    `;
    
    appState.tabs = [
      { id: 'tab1', path: 'C:/folder1', name: 'folder1' },
      { id: 'tab2', path: 'C:/folder2', name: 'folder2' },
      { id: 'tab3', path: 'C:/folder3', name: 'folder3' }
    ];
    appState.activeTabIndex = 0;
    
    uiManager = new UIManager(appState);
    uiManager.renderTabs();
  });

  it('should reorder tabs when dropped', () => {
    const tabs = document.querySelectorAll('.tab-item');
    expect(tabs.length).toBe(3);

    const tab0 = tabs[0];
    const tab1 = tabs[1];

    // Unmock to let the real onTabMove execute
    // (It's defined in renderer-tabs.js, but for UI test we can just include it here or test if DOM reorders)
    // Actually, onTabMove is defined in renderer-tabs.js which isn't loaded.
    // Let's mock it to reorder appState and call renderTabs just like the real one.
    window.onTabMove = (fromIndex, toIndex, insertAfter) => {
      if (fromIndex === toIndex) return;
      const tabs = appState.tabs;
      const activeTab = tabs[appState.activeTabIndex];
      const [movedTab] = tabs.splice(fromIndex, 1);
      let adjustedToIndex = toIndex;
      if (fromIndex < toIndex) adjustedToIndex -= 1;
      if (insertAfter) adjustedToIndex += 1;
      tabs.splice(adjustedToIndex, 0, movedTab);
      appState.activeTabIndex = tabs.indexOf(activeTab);
      uiManager.renderTabs();
    };

    // 1. dragstart on tab0
    const dragStartEvent = new Event('dragstart');
    dragStartEvent.dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn().mockReturnValue('0'),
      types: ['application/json-tab']
    };
    tab0.dispatchEvent(dragStartEvent);

    expect(dragStartEvent.dataTransfer.setData).toHaveBeenCalledWith('application/json-tab', '0');

    // 2. dragover on tab1
    const dragOverEvent = new Event('dragover');
    dragOverEvent.dataTransfer = dragStartEvent.dataTransfer;
    // mock getBoundingClientRect
    tab1.getBoundingClientRect = () => ({ left: 100, width: 100 });
    dragOverEvent.clientX = 180; // right side
    tab1.dispatchEvent(dragOverEvent);

    expect(tab1.classList.contains('drag-over-right')).toBe(true);

    // 3. drop on tab1
    const dropEvent = new Event('drop');
    dropEvent.dataTransfer = dragStartEvent.dataTransfer;
    dropEvent.clientX = 180;
    tab1.dispatchEvent(dropEvent);

    // Check if onTabMove was called correctly and DOM updated
    const newTabs = document.querySelectorAll('.tab-item');
    expect(newTabs[0].dataset.tabId).toBe('tab2');
    expect(newTabs[1].dataset.tabId).toBe('tab1');
    expect(appState.tabs[0].id).toBe('tab2');
    expect(appState.tabs[1].id).toBe('tab1');
    expect(appState.tabs[2].id).toBe('tab3');

    // BUT! Are the DOM elements actually reordered?
    expect(newTabs[0].dataset.tabId).toBe('tab2');
    expect(newTabs[1].dataset.tabId).toBe('tab1');
  });
});
