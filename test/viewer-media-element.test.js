import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isVideoFile, getStreamUrl } from '../src/common/utils.js';

describe('Viewer Video & Media Element Lifecycle', () => {
  describe('isVideoFile detection', () => {
    it('should correctly identify video file extensions regardless of case', () => {
      expect(isVideoFile('C:\\videos\\sample.mp4')).toBe(true);
      expect(isVideoFile('C:\\videos\\sample.MP4')).toBe(true);
      expect(isVideoFile('C:/videos/sample.webm')).toBe(true);
      expect(isVideoFile('C:/videos/sample.WEBM')).toBe(true);
      expect(isVideoFile('/path/to/video.avi')).toBe(true);
      expect(isVideoFile('/path/to/video.mkv')).toBe(true);
      expect(isVideoFile('/path/to/video.mov')).toBe(true);
      expect(isVideoFile('/path/to/video.MOV')).toBe(true);
    });

    it('should return false for static images and invalid inputs', () => {
      expect(isVideoFile('C:\\images\\photo.png')).toBe(false);
      expect(isVideoFile('C:\\images\\photo.jpg')).toBe(false);
      expect(isVideoFile('C:\\images\\photo.jpeg')).toBe(false);
      expect(isVideoFile('C:\\images\\photo.webp')).toBe(false);
      expect(isVideoFile('C:\\images\\photo.gif')).toBe(false);
      expect(isVideoFile(null)).toBe(false);
      expect(isVideoFile(undefined)).toBe(false);
      expect(isVideoFile('')).toBe(false);
      expect(isVideoFile(12345)).toBe(false);
    });
  });

  describe('loadImage element creation with tokenized stream URLs', () => {
    let originalVideoServerPort;
    let originalVideoServerToken;
    let originalVeloceAPI;

    beforeEach(() => {
      originalVideoServerPort = window.videoServerPort;
      originalVideoServerToken = window.videoServerToken;
      originalVeloceAPI = window.veloceAPI;

      window.videoServerPort = 54321;
      window.videoServerToken = 'sec_token_98765';
      window.scrollTo = vi.fn();
      window.veloceAPI = {
        convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
        showWindow: vi.fn().mockResolvedValue(true),
        resizeViewer: vi.fn().mockResolvedValue(true),
        getAllRatings: vi.fn().mockResolvedValue({}),
        isViewerMaximized: vi.fn().mockResolvedValue(false),
      };

      document.body.innerHTML = `
        <img id="viewer-img" decoding="async" src="" alt="">
        <div id="border-overlay"></div>
      `;
    });

    afterEach(() => {
      window.videoServerPort = originalVideoServerPort;
      window.videoServerToken = originalVideoServerToken;
      window.veloceAPI = originalVeloceAPI;
      vi.restoreAllMocks();
    });

    it('should create a <video> element when currentImagePath is an mp4 even if stream URL contains query tokens', async () => {
      const { loadImage } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      const videoPath = 'C:\\media\\animation.mp4';
      viewerState.currentImagePath = videoPath;
      viewerState.currentIndex = 0;
      viewerState.totalImages = 1;
      viewerState.paths = [videoPath];
      viewerState.preloadCache.clear();

      await loadImage();

      // preloadCache に格納された要素が VIDEO タグであること
      expect(viewerState.preloadCache.has(0)).toBe(true);
      const cached = viewerState.preloadCache.get(0);
      expect(cached.img.tagName).toBe('VIDEO');
      expect(cached.img.autoplay).toBe(true);
      expect(cached.img.loop).toBe(true);
      expect(cached.img.muted).toBe(true);
      expect(cached.img.tabIndex).toBe(-1);
      expect(cached.img.src).toContain('token=sec_token_98765');
      expect(cached.img.src).toContain('http://localhost:54321/');
    });

    it('should create an <img> element when currentImagePath is a static image', async () => {
      const { loadImage } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      const imagePath = 'C:\\images\\illustration.png';
      viewerState.currentImagePath = imagePath;
      viewerState.currentIndex = 1;
      viewerState.totalImages = 2;
      viewerState.paths = ['C:\\media\\animation.mp4', imagePath];
      viewerState.preloadCache.clear();

      await loadImage();

      expect(viewerState.preloadCache.has(1)).toBe(true);
      const cached = viewerState.preloadCache.get(1);
      expect(cached.img.tagName).toBe('IMG');
      expect(cached.img.decoding).toBe('async');
    });

    it('should invalidate cache and re-create <video> if cache incorrectly holds an IMG element for video', async () => {
      const { loadImage } = await import('../src/viewer/viewer.js');
      const { viewerState } = await import('../src/viewer/viewer-state.js');

      const videoPath = 'C:\\media\\sample.mp4';
      viewerState.currentImagePath = videoPath;
      viewerState.currentIndex = 0;
      viewerState.totalImages = 1;
      viewerState.paths = [videoPath];

      // 過去の不具合（IMGで誤キャッシュされた状態）を意図的に挿入
      const brokenImg = document.createElement('img');
      brokenImg.src = 'http://localhost:54321/?path=broken&token=test';
      viewerState.preloadCache.set(0, { img: brokenImg, path: videoPath });

      await loadImage();

      // 不整合が検知され、新しく VIDEO 要素に置き換わっていること
      const cached = viewerState.preloadCache.get(0);
      expect(cached.img.tagName).toBe('VIDEO');
    });
  });
});
