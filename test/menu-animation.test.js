import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { uiManager } from '../src/renderer-ui.js';

describe('showMenuWithAnimation (Screen boundary clamp and animation)', () => {
  let showMenuWithAnimation;
  let menuElement;

  beforeAll(async () => {
    document.body.innerHTML = `
      <input type="text" id="search-input" />
      <div id="center-top"></div>
      <div id="center-bottom"></div>
      <div id="file-list-body"></div>
      <div id="dir-tree"></div>
      <input type="range" id="thumbnail-size-slider" />
    `;

    uiManager.elements.thumbnailGrid = document.getElementById('center-bottom');
    uiManager.elements.searchBar = document.getElementById('search-input');
    uiManager.elements.fileListBody = document.getElementById('file-list-body');
    uiManager.elements.dirTree = document.getElementById('dir-tree');
    uiManager.elements.thumbnailSizeSlider = document.getElementById('thumbnail-size-slider');

    const rendererModule = await import('../src/renderer.js');
    showMenuWithAnimation = rendererModule.showMenuWithAnimation;
  });

  beforeEach(() => {
    window.innerWidth = 1000;
    window.innerHeight = 800;

    menuElement = document.createElement('div');
    menuElement.id = 'test-menu';
    document.body.appendChild(menuElement);

    menuElement.getBoundingClientRect = vi.fn(() => ({
      width: 200,
      height: 300,
      top: 0,
      left: 0,
      bottom: 300,
      right: 200,
    }));
  });

  it('should position menu directly when within window boundaries', () => {
    showMenuWithAnimation(menuElement, 100, 150);

    expect(menuElement.style.left).toBe('100px');
    expect(menuElement.style.top).toBe('150px');
    expect(menuElement.style.transformOrigin).toBe('top left');
    expect(menuElement.classList.contains('show')).toBe(true);
  });

  it('should clamp X coordinate and set transformOrigin to right when overflowing horizontally', () => {
    showMenuWithAnimation(menuElement, 900, 150);

    expect(menuElement.style.left).toBe('800px');
    expect(menuElement.style.top).toBe('150px');
    expect(menuElement.style.transformOrigin).toBe('top right');
  });

  it('should clamp Y coordinate and set transformOrigin to bottom when overflowing vertically', () => {
    showMenuWithAnimation(menuElement, 100, 700);

    expect(menuElement.style.left).toBe('100px');
    expect(menuElement.style.top).toBe('500px');
    expect(menuElement.style.transformOrigin).toBe('bottom left');
  });

  it('should clamp both X and Y when overflowing in bottom-right corner', () => {
    showMenuWithAnimation(menuElement, 950, 750);

    expect(menuElement.style.left).toBe('800px');
    expect(menuElement.style.top).toBe('500px');
    expect(menuElement.style.transformOrigin).toBe('bottom right');
  });
});
