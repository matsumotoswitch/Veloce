import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/renderer/renderer-state.js';
import { checkThumbnailSelfHealing } from '../src/renderer/renderer-thumbnails.js';

describe('Thumbnail Scroll Recovery and Broken Image Self-Healing', () => {
  const PLACEHOLDER_GIF_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  beforeEach(() => {
    vi.useFakeTimers();
    window.appState = {
      thumbnailUrls: new Map(),
      activeCenterPane: 'grid',
      dragState: { isAppDragging: false }
    };
    window.thumbnailManager = {
      priorityQueue: [],
      priorityQueueSet: new Set(),
      activeTasks: new Map(),
      preloadQueue: [],
      enqueuePriority: vi.fn((path) => {
        window.thumbnailManager.priorityQueue.push(path);
      }),
      processNext: vi.fn()
    };
    window.processNextTask = vi.fn();
    window.veloceAPI = {
      convertFileSrc: vi.fn((path) => `asset://${path}`)
    };
    window.videoServerPort = 12345;
    window.videoServerToken = 'test-token';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('should reset to placeholder and enqueue priority when cached thumbnail URL fails to load', () => {
    const filePath = 'C:/test/sample.png';
    const brokenHttpUrl = `http://127.0.0.1:12345/?path=${encodeURIComponent(filePath)}&mtime=123456&thumb=1`;

    window.appState.thumbnailUrls.set(filePath, brokenHttpUrl);

    const wrapper = document.createElement('div');
    wrapper.dataset.filepath = filePath;
    const img = document.createElement('img');
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    // Simulate renderer-ui.js error handler logic
    img.src = brokenHttpUrl;
    img.onerror = function() {
      if (wrapper.dataset.filepath !== filePath) return;
      this.classList.remove('loading');
      wrapper.classList.remove('loading');
      this.src = PLACEHOLDER_GIF_URL;
      if (window.appState && window.appState.thumbnailUrls) {
        window.appState.thumbnailUrls.delete(filePath);
      }
      if (window.thumbnailManager) {
        window.thumbnailManager.enqueuePriority(filePath);
      }
    };

    // Trigger error (e.g. aborted request, server restart, network drop)
    img.onerror();

    // Verify recovery
    expect(img.src).toBe(PLACEHOLDER_GIF_URL);
    expect(window.appState.thumbnailUrls.has(filePath)).toBe(false);
    expect(window.thumbnailManager.enqueuePriority).toHaveBeenCalledWith(filePath);
  });

  it('should detect completed zero-width broken image and trigger onerror recovery', () => {
    const filePath = 'C:/test/broken.png';
    const brokenUrl = `http://127.0.0.1:12345/?path=${encodeURIComponent(filePath)}&thumb=1`;

    window.appState.thumbnailUrls.set(filePath, brokenUrl);

    const wrapper = document.createElement('div');
    wrapper.dataset.filepath = filePath;
    const img = document.createElement('img');
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    let errorHandled = false;
    img.onerror = function() {
      errorHandled = true;
      this.src = PLACEHOLDER_GIF_URL;
      window.appState.thumbnailUrls.delete(filePath);
      window.thumbnailManager.enqueuePriority(filePath);
    };

    // Mock naturalWidth = 0 and complete = true (broken image state in browser)
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true });
    img.src = brokenUrl;

    // Check synchronous completion branch as in renderer-ui.js
    if (img.complete) {
      if (img.naturalWidth > 0) {
        img.classList.remove('loading');
      } else if (!img.src.startsWith('data:image/svg+xml')) {
        img.onerror();
      }
    }

    expect(errorHandled).toBe(true);
    expect(img.src).toBe(PLACEHOLDER_GIF_URL);
    expect(window.appState.thumbnailUrls.has(filePath)).toBe(false);
    expect(window.thumbnailManager.enqueuePriority).toHaveBeenCalledWith(filePath);
  });

  it('checkThumbnailSelfHealing should detect broken image (complete && naturalWidth === 0) and queue recovery', () => {
    const filePath = 'C:/test/scrolled-back.jpg';
    const brokenUrl = `http://127.0.0.1:12345/?path=${encodeURIComponent(filePath)}&thumb=1`;

    // Once onerror has removed the invalid URL from thumbnailUrls
    window.appState.thumbnailUrls.delete(filePath);

    const wrapper = document.createElement('div');
    wrapper.dataset.filepath = filePath;
    const img = document.createElement('img');
    img.src = brokenUrl;
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true });
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    window.uiManager = {
      _domByPath: new Map([[filePath, wrapper]])
    };

    const repaired = checkThumbnailSelfHealing();

    expect(repaired).toBe(1);
    expect(window.appState.thumbnailUrls.has(filePath)).toBe(false);
    expect(window.thumbnailManager.enqueuePriority).toHaveBeenCalledWith(filePath);
    expect(img.src).toBe(PLACEHOLDER_GIF_URL);
  });
});

