import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { THUMBNAIL_ENCODE_QUALITY, thumbnailWorkerPool } from '../src/renderer/renderer-thumbnails.js';

describe('Phase 3: WebP Encode Quality Optimization', () => {
  beforeEach(() => {
    window.veloceAPI = {
      convertFileSrc: vi.fn(p => `asset://${p}`),
      readBinaryFile: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('THUMBNAIL_ENCODE_QUALITY が 0.85 で定義されていること', () => {
    expect(THUMBNAIL_ENCODE_QUALITY).toBe(0.85);
  });

  it('OffscreenCanvas による WebP エンコード時に quality: 0.85 が指定されること', async () => {
    let capturedOptions = null;

    // OffscreenCanvas のモック
    const mockBlob = new Blob(['mock-webp'], { type: 'image/webp' });
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    
    globalThis.OffscreenCanvas = class MockOffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext(type) {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          fillStyle: '',
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: vi.fn()
        };
      }
      async convertToBlob(options) {
        capturedOptions = options;
        return mockBlob;
      }
    };

    // createImageBitmap のモック
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      close: vi.fn()
    });

    // fetch のモック
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['dummy'], { type: 'image/png' })
    });

    try {
      const res = await thumbnailWorkerPool.generate('C:/images/test_alpha.png', 'asset://C:/images/test_alpha.png');
      expect(res).toBeDefined();
      expect(capturedOptions).toEqual({
        type: 'image/webp',
        quality: 0.85
      });
    } finally {
      globalThis.OffscreenCanvas = originalOffscreenCanvas;
      globalThis.createImageBitmap = originalCreateImageBitmap;
      globalThis.fetch = originalFetch;
    }
  });

  it('透過を持たない形式（例: jpg）では JPEG かつ quality: 0.85 でエンコードされること', async () => {
    let capturedOptions = null;
    const mockBlob = new Blob(['mock-jpeg'], { type: 'image/jpeg' });
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    
    globalThis.OffscreenCanvas = class MockOffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext(type) {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          fillStyle: '',
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: vi.fn()
        };
      }
      async convertToBlob(options) {
        capturedOptions = options;
        return mockBlob;
      }
    };

    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      close: vi.fn()
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['dummy'], { type: 'image/jpeg' })
    });

    try {
      const res = await thumbnailWorkerPool.generate('C:/images/test_opaque.jpg', 'asset://C:/images/test_opaque.jpg');
      expect(res).toBeDefined();
      expect(capturedOptions).toEqual({
        type: 'image/jpeg',
        quality: 0.85
      });
    } finally {
      globalThis.OffscreenCanvas = originalOffscreenCanvas;
      globalThis.createImageBitmap = originalCreateImageBitmap;
      globalThis.fetch = originalFetch;
    }
  });
});
