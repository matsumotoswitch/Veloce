import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Video Seek Bar', () => {
  beforeEach(() => {
    // Mock ResizeObserver
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    // Remove previous viewerImg if any
    const oldImg = document.getElementById('viewer-img');
    if (oldImg) oldImg.remove();
    
    // Create viewer UI elements
    const viewerImg = document.createElement('video');
    viewerImg.id = 'viewer-img';
    document.body.appendChild(viewerImg);

    // Mock APIs
    window.veloceAPI = {
      convertFileSrc: vi.fn(),
      showWindow: vi.fn(),
      setWindowSize: vi.fn().mockResolvedValue()
    };
    window.showToast = vi.fn();
  });

  it('should toggle video seek bar on "s" keypress', async () => {
    // Dynamic import to load viewer.js and initialize event listeners
    await import('../src/viewer.js');

    // Give viewer.js time to attach listeners
    await new Promise(r => setTimeout(r, 50));

    // Initial state: seek bar might not exist, or if it does, it's not visible
    const getContainer = () => document.getElementById('video-controls-container');
    if (getContainer()) {
      getContainer().style.display = 'none';
    }

    // Simulate 's' keypress
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

    // Seek bar should be created and visible
    const container = getContainer();
    expect(container).not.toBeNull();
    expect(container.style.display).not.toBe('none');

    // Simulate 's' keypress again
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));

    // Seek bar should be hidden
    expect(container.style.display).toBe('none');
  });

  it('should prevent propagation of mouse events on seek bar', async () => {
    await import('../src/viewer.js');
    
    // Show seek bar
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    const container = document.getElementById('video-controls-container');
    
    // Create a mock listener on window to check if event bubbles
    const windowListener = vi.fn();
    window.addEventListener('mousedown', windowListener);
    
    // Dispatch mousedown on container
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    
    // Should be stopped
    expect(windowListener).not.toHaveBeenCalled();
    
    window.removeEventListener('mousedown', windowListener);
  });
});
