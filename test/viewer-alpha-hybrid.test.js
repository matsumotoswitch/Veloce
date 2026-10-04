/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { viewerState } from '../src/viewer/viewer-state.js';
import {
  applyAlphaOverlay,
  toggleAlphaOverlayMode,
  toggleMetadataOverlay,
  showToast
} from '../src/viewer/viewer.js';

describe('Viewer Alpha Overlay Hybrid with I Key Integration', () => {
  let mockImg;
  let mockGetAlphaOverlayImage;
  let mockParseMetadata;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="toast-container"></div>
      <div id="window-controls"></div>
      <img id="viewer-img" src="asset://original-image.png" />
    `;

    mockImg = document.getElementById('viewer-img');

    // State reset
    viewerState.currentIndex = 0;
    viewerState.paths = ['E:/test/stealth.png'];
    viewerState.currentImagePath = 'E:/test/stealth.png';
    viewerState.isMetadataVisible = false;
    viewerState.isAlphaOverlayMode = false;
    viewerState.originalSrc = null;
    viewerState.overlayCache.clear();

    // Mock APIs
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

    mockParseMetadata = vi.fn().mockResolvedValue({
      prompt: 'masterpiece, 1girl, smiling',
      negativePrompt: 'lowres, bad quality',
      params: { steps: 28, sampler: 'Euler' },
      source: 'NovelAI'
    });

    window.veloceAPI = {
      getAlphaOverlayImage: mockGetAlphaOverlayImage,
      parseMetadata: mockParseMetadata,
      arrangeViewers: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const overlay = document.getElementById('viewer-metadata-overlay');
    if (overlay) overlay.remove();
    document.body.innerHTML = '';
  });

  it('should toggle both metadata text and alpha hybrid overlay ON via toggleMetadataOverlay (I key)', async () => {
    toggleMetadataOverlay();

    expect(viewerState.isMetadataVisible).toBe(true);
    expect(viewerState.isAlphaOverlayMode).toBe(true);

    // Wait for async applyAlphaOverlay & parseMetadata
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(viewerState.originalSrc).toBe('asset://original-image.png');
    expect(mockImg.src).toBe('data:image/png;base64,mockHybridOverlayData');
    expect(mockGetAlphaOverlayImage).toHaveBeenCalledWith('E:/test/stealth.png');
    expect(mockParseMetadata).toHaveBeenCalledWith('E:/test/stealth.png');

    // Check toast content
    const toast = document.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('アルファオーバーレイ: ON');
    expect(toast.textContent).toContain('16,536 px');
    expect(toast.textContent).toContain('166 列');
    expect(toast.textContent).toContain('2.0 KiB');
    expect(toast.textContent).toContain('15.50%');

    // Check metadata text overlay DOM
    const metaOverlay = document.getElementById('viewer-metadata-overlay');
    expect(metaOverlay).not.toBeNull();
    expect(metaOverlay.classList.contains('show')).toBe(true);
  });

  it('should toggle both metadata text and alpha overlay OFF and restore originalSrc via toggleMetadataOverlay (I key)', async () => {
    // Turn ON
    toggleMetadataOverlay();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewerState.isAlphaOverlayMode).toBe(true);

    // Turn OFF
    toggleMetadataOverlay();
    expect(viewerState.isMetadataVisible).toBe(false);
    expect(viewerState.isAlphaOverlayMode).toBe(false);
    expect(viewerState.originalSrc).toBeNull();
    expect(mockImg.src).toBe('asset://original-image.png');

    const metaOverlay = document.getElementById('viewer-metadata-overlay');
    expect(metaOverlay.classList.contains('show')).toBe(false);
  });

  it('should only show metadata text without alpha overlay when image has no alpha metadata', async () => {
    mockGetAlphaOverlayImage.mockRejectedValueOnce(new Error('No stealth metadata signature found'));

    toggleMetadataOverlay();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(viewerState.isMetadataVisible).toBe(true);
    expect(viewerState.isAlphaOverlayMode).toBe(false);
    expect(mockImg.src).toBe('asset://original-image.png');

    // Metadata text overlay should still be visible
    const metaOverlay = document.getElementById('viewer-metadata-overlay');
    expect(metaOverlay).not.toBeNull();
    expect(metaOverlay.classList.contains('show')).toBe(true);
  });

  it('should support standalone toggleAlphaOverlayMode', async () => {
    await toggleAlphaOverlayMode();
    expect(viewerState.isAlphaOverlayMode).toBe(true);
    expect(mockImg.src).toBe('data:image/png;base64,mockHybridOverlayData');

    await toggleAlphaOverlayMode();
    expect(viewerState.isAlphaOverlayMode).toBe(false);
    expect(mockImg.src).toBe('asset://original-image.png');
  });

  it('should handle auto-follow when navigating images with metadata visible', async () => {
    toggleMetadataOverlay();
    await new Promise((resolve) => setTimeout(resolve, 50));
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
});
