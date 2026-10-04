/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { viewerState } from '../src/viewer/viewer-state.js';
import { applyAlphaOverlay, toggleAlphaOverlayMode, showToast } from '../src/viewer/viewer.js';

describe('Viewer Alpha Overlay Hybrid (Plan 1 + Plan 2 Hybrid)', () => {
  let mockImg;
  let mockGetAlphaOverlayImage;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <img id="viewer-img" src="asset://original-image.png" />
    `;

    mockImg = document.getElementById('viewer-img');

    // State reset
    viewerState.currentIndex = 0;
    viewerState.paths = ['E:/test/stealth.png'];
    viewerState.currentImagePath = 'E:/test/stealth.png';
    viewerState.isAlphaOverlayMode = false;
    viewerState.originalSrc = null;
    viewerState.overlayCache.clear();

    // Mock API
    mockGetAlphaOverlayImage = vi.fn().mockResolvedValue({
      data_url: 'data:image/png;base64,mockHybridOverlayData',
      width: 100,
      height: 100,
      header_bytes: 19,
      payload_bytes: 2048,
      total_bytes: 2067,
      total_pixels: 16536,
      image_total_pixels: 10000,
      coverage_percent: 15.5,
      occupied_columns: 166,
    });

    window.veloceAPI = {
      getAlphaOverlayImage: mockGetAlphaOverlayImage,
      arrangeViewers: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('should toggle overlay ON and replace img.src with hybrid data_url, saving originalSrc', async () => {
    await toggleAlphaOverlayMode();

    expect(viewerState.isAlphaOverlayMode).toBe(true);
    expect(viewerState.originalSrc).toBe('asset://original-image.png');
    expect(mockImg.src).toBe('data:image/png;base64,mockHybridOverlayData');
    expect(mockGetAlphaOverlayImage).toHaveBeenCalledWith('E:/test/stealth.png');

    // Check toast content
    const toast = document.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('アルファオーバーレイ: ON');
    expect(toast.textContent).toContain('16,536 px');
    expect(toast.textContent).toContain('166 列');
    expect(toast.textContent).toContain('2.0 KiB');
    expect(toast.textContent).toContain('15.50%');
  });

  it('should toggle overlay OFF and restore originalSrc', async () => {
    // Turn ON
    await toggleAlphaOverlayMode();
    expect(viewerState.isAlphaOverlayMode).toBe(true);

    // Turn OFF
    await toggleAlphaOverlayMode();
    expect(viewerState.isAlphaOverlayMode).toBe(false);
    expect(viewerState.originalSrc).toBeNull();
    expect(mockImg.src).toBe('asset://original-image.png');

    const toasts = document.querySelectorAll('.toast-message');
    const toast = toasts[toasts.length - 1];
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('アルファオーバーレイ: OFF');
  });

  it('should use cache on subsequent overlay applications for same path', async () => {
    // First toggle ON
    await toggleAlphaOverlayMode();
    expect(mockGetAlphaOverlayImage).toHaveBeenCalledTimes(1);

    // Toggle OFF
    await toggleAlphaOverlayMode();

    // Toggle ON again -> should use cached overlay result without extra IPC call
    await toggleAlphaOverlayMode();
    expect(mockGetAlphaOverlayImage).toHaveBeenCalledTimes(1);
    expect(mockImg.src).toBe('data:image/png;base64,mockHybridOverlayData');
  });

  it('should handle auto-follow when navigating images with overlay active', async () => {
    // Turn ON
    await toggleAlphaOverlayMode();
    expect(viewerState.isAlphaOverlayMode).toBe(true);

    // Navigate to next image
    viewerState.currentImagePath = 'E:/test/stealth2.png';
    mockImg.src = 'asset://image2.png';
    viewerState.originalSrc = null;

    mockGetAlphaOverlayImage.mockResolvedValueOnce({
      data_url: 'data:image/png;base64,mockHybridOverlayData2',
      width: 100,
      height: 100,
      header_bytes: 19,
      payload_bytes: 1024,
      total_bytes: 1043,
      total_pixels: 8344,
      image_total_pixels: 10000,
      coverage_percent: 8.34,
      occupied_columns: 84,
    });

    await applyAlphaOverlay(mockImg, 'E:/test/stealth2.png', true);

    expect(viewerState.originalSrc).toBe('asset://image2.png');
    expect(mockImg.src).toBe('data:image/png;base64,mockHybridOverlayData2');
  });

  it('should show warning toast and not change state when no alpha metadata found', async () => {
    mockGetAlphaOverlayImage.mockRejectedValueOnce(new Error('No stealth metadata signature found'));

    await toggleAlphaOverlayMode();

    expect(viewerState.isAlphaOverlayMode).toBe(false);
    expect(mockImg.src).toBe('asset://original-image.png');

    const toast = document.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('この画像にはアルファチャンネルのメタデータが存在しません');
  });

  it('should warn when target element is not an IMG (e.g. video)', async () => {
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <video id="viewer-img"></video>
    `;

    await toggleAlphaOverlayMode();

    expect(viewerState.isAlphaOverlayMode).toBe(false);
    const toast = document.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('アルファオーバーレイは静止画像（PNG/WebP）のみ対応しています');
  });
});
