import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Viewer Window Resize and Letterbox Compensation', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(
      '<!DOCTYPE html><html><body>' +
      '<div id="viewer-container"><img id="viewer-img" src="" /></div>' +
      '<div id="window-scale-display"></div>' +
      '<div id="window-controls"></div>' +
      '<div id="border-overlay"></div>' +
      '</body></html>',
      { url: 'http://localhost/viewer.html' }
    );
    global.window = dom.window;
    global.document = dom.window.document;
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    global.cancelAnimationFrame = (id) => clearTimeout(id);

    // Mock screen properties: Full HD with standard 40px taskbar
    global.window.screen = {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040
    };
    global.window.innerWidth = 1024;
    global.window.innerHeight = 768;

    global.window.__TAURI__ = {
      tauri: { invoke: vi.fn().mockResolvedValue(true) },
      event: { listen: vi.fn().mockResolvedValue(() => {}) },
      window: { appWindow: { label: 'viewer_pool_0' } }
    };
    global.window.veloceAPI = {
      setWindowSize: vi.fn().mockResolvedValue(true),
      getViewerImage: vi.fn().mockResolvedValue(null),
      getVideoServerPort: vi.fn().mockResolvedValue(1234),
      getVideoServerToken: vi.fn().mockResolvedValue('test')
    };
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.ResizeObserver;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
  });

  it('resizeWindowToFitImage uses availHeight rather than screen.height to fit within taskbar work area', async () => {
    const { resizeWindowToFitImage } = await import('../src/viewer/viewer.js');
    const { viewerUI } = await import('../src/viewer/viewer-ui.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    // Simulate vertical image (e.g. 800 x 1200)
    const img = viewerUI.elements.viewerImg;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true });
    viewerState.isZoomed = false;
    viewerState.isFullscreen = false;
    viewerState.isImmersiveArranged = false;

    // Trigger window resize
    resizeWindowToFitImage();

    // With availHeight = 1040 and height = 1080, scale should be based on 1040:
    // scale = 1040 / 1200 = 0.86666...
    // targetWidth = floor(800 * 0.86666...) = 693
    // targetHeight = floor(1200 * 0.86666...) = 1040
    expect(global.window.veloceAPI.setWindowSize).toHaveBeenCalledWith(693, 1040);
  });

  it('updateCompensateScale calculates compensation scale to eliminate horizontal black letterbox bars', async () => {
    const { updateCompensateScale } = await import('../src/viewer/viewer.js');
    const { viewerUI } = await import('../src/viewer/viewer-ui.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    const img = viewerUI.elements.viewerImg;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true });
    viewerState.isZoomed = false;
    viewerState.isFullscreen = false;
    viewerState.isImmersiveArranged = false;

    // Simulate window being slightly wider than image aspect ratio (e.g. 700x1040 instead of 693x1040)
    // Image aspect ratio: 800 / 1200 = 0.6666...
    // Rendered width at height 1040: 1040 * (800 / 1200) = 693.33px
    // Window width is 700px -> 6.67px horizontal gap (letterbox)
    global.window.innerWidth = 700;
    global.window.innerHeight = 1040;

    updateCompensateScale();

    // Required compensate scale = 700 / 693.333 = ~1.0096
    expect(viewerState.compensateScale).toBeGreaterThan(1.0);
    expect(viewerState.compensateScale).toBeLessThan(1.02);
  });

  it('updateCompensateScale calculates compensation scale to eliminate vertical black letterbox bars', async () => {
    const { updateCompensateScale } = await import('../src/viewer/viewer.js');
    const { viewerUI } = await import('../src/viewer/viewer-ui.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    const img = viewerUI.elements.viewerImg;
    Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 800, configurable: true });
    viewerState.isZoomed = false;
    viewerState.isFullscreen = false;
    viewerState.isImmersiveArranged = false;

    // Simulate window being slightly taller than image aspect ratio
    // Image aspect ratio: 1200 / 800 = 1.5
    // Rendered height at width 1200: 1200 / 1.5 = 800px
    // Window height is 810px -> 10px vertical gap
    global.window.innerWidth = 1200;
    global.window.innerHeight = 810;

    updateCompensateScale();

    expect(viewerState.compensateScale).toBeGreaterThan(1.0);
    expect(viewerState.compensateScale).toBeLessThan(1.02);
  });

  it('updateCompensateScale resets compensateScale to 1.0 when user enters zoom mode', async () => {
    const { updateCompensateScale } = await import('../src/viewer/viewer.js');
    const { viewerUI } = await import('../src/viewer/viewer-ui.js');
    const { viewerState } = await import('../src/viewer/viewer-state.js');

    const img = viewerUI.elements.viewerImg;
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true });

    viewerState.compensateScale = 1.015;
    viewerState.isZoomed = true; // User zoomed in

    updateCompensateScale();

    expect(viewerState.compensateScale).toBe(1.0);
  });
});
