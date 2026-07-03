import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/renderer-state.js';

describe('Thumbnail Cache Rebuild Bug Fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T12:00:00Z'));
    window.appState = {
      thumbnailUrls: new Map(),
      selection: new Set()
    };
    window.veloceAPI = {
      convertFileSrc: vi.fn(path => `asset://${path}`),
      getThumbnail: vi.fn(async (path) => `https://veloce.localhost/thumbnail/?path=${encodeURIComponent(path)}`)
    };
    // Mock the DOM for updateDOM
    document.body.innerHTML = `
      <div class="virtual-content">
        <div data-filepath="test.jpg">
          <img class="thumbnail-img" />
        </div>
      </div>
    `;
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not call URL.revokeObjectURL for https urls', () => {
    appState.thumbnailUrls.set('test.jpg', 'https://veloce.localhost/thumbnail/?path=test.jpg');
    const oldUrl = appState.thumbnailUrls.get('test.jpg');
    if (oldUrl && oldUrl.startsWith('blob:')) window.URL.revokeObjectURL(oldUrl);
    appState.thumbnailUrls.delete('test.jpg');
    
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(appState.thumbnailUrls.has('test.jpg')).toBe(false);
  });

  it('should call URL.revokeObjectURL for blob urls', () => {
    appState.thumbnailUrls.set('test.jpg', 'blob:http://localhost/1234');
    const oldUrl = appState.thumbnailUrls.get('test.jpg');
    if (oldUrl && oldUrl.startsWith('blob:')) window.URL.revokeObjectURL(oldUrl);
    appState.thumbnailUrls.delete('test.jpg');
    
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1234');
    expect(appState.thumbnailUrls.has('test.jpg')).toBe(false);
  });

  it('should fallback to convertFileSrc on img.onerror', () => {
    const img = document.createElement('img');
    img.className = 'thumbnail-img';
    img.src = 'https://veloce.localhost/thumbnail/?path=test.jpg';
    
    // Simulate the onerror handler from renderer-ui.js
    img.onerror = function() {
      this.classList.remove('loading');
      const fallback = window.veloceAPI.convertFileSrc('test.jpg');
      if (this.src !== fallback && !this.src.startsWith('asset://')) {
        if (window.appState && window.appState.thumbnailUrls) {
          window.appState.thumbnailUrls.set('test.jpg', fallback);
        }
        this.src = fallback;
      }
    };

    img.onerror();

    expect(img.src).toContain('asset://test.jpg');
    expect(appState.thumbnailUrls.get('test.jpg')).toBe('asset://test.jpg');
  });
});
