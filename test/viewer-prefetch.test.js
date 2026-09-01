import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

describe('Viewer Prefetch Logic (Phase 1)', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    global.viewerState = {
      paths: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg', '8.jpg', '9.jpg'],
      currentIndex: 5,
      totalImages: 10,
      preloadCache: new Map()
    };

    global.getImagePath = async (idx) => global.viewerState.paths[idx];
    global.getStreamUrl = (path) => `stream://${path}`;
    
    global.window.veloceAPI = {
      convertFileSrc: (p) => p
    };

    // モック用の img.decode() 
    global.window.HTMLImageElement.prototype.decode = vi.fn().mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // viewer.js の preloadAdjacentImages のロジックをシミュレート
  async function preloadAdjacentImages() {
    const total = global.viewerState.totalImages;
    if (total <= 1) return;

    const deltas = [1, -1, 2, -2];
    const indicesToPreload = [];
    for (const delta of deltas) {
      const targetIdx = ((global.viewerState.currentIndex + delta) % total + total) % total;
      if (!indicesToPreload.includes(targetIdx)) {
        indicesToPreload.push(targetIdx);
      }
    }

    await Promise.all(indicesToPreload.map(async (idx) => {
      if (!global.viewerState.preloadCache.has(idx)) {
        const path = await global.getImagePath(idx);
        if (path && !global.viewerState.preloadCache.has(idx)) {
          const url = global.getStreamUrl(path);
          let img = global.document.createElement('img');
          img.decoding = 'async';
          img.src = url;
          global.viewerState.preloadCache.set(idx, { img: img, path: path });

          if (img.tagName === 'IMG') {
            img.decode().catch(e => {});
          }
        }
      }
    }));

    for (const cachedIdx of global.viewerState.preloadCache.keys()) {
      let diff = Math.abs(cachedIdx - global.viewerState.currentIndex);
      if (diff > total / 2) {
        diff = total - diff;
      }
      if (diff > 3) {
        const cached = global.viewerState.preloadCache.get(cachedIdx);
        if (cached && cached.img) {
          cached.img.src = '';
          if (cached.img.remove) cached.img.remove();
        }
        global.viewerState.preloadCache.delete(cachedIdx);
      }
    }
  }

  it('should cache adjacent images and call decode()', async () => {
    global.viewerState.currentIndex = 5;
    await preloadAdjacentImages();

    // ±2のインデックス（3, 4, 6, 7）がキャッシュされていること
    expect(global.viewerState.preloadCache.has(3)).toBe(true);
    expect(global.viewerState.preloadCache.has(4)).toBe(true);
    expect(global.viewerState.preloadCache.has(6)).toBe(true);
    expect(global.viewerState.preloadCache.has(7)).toBe(true);

    const cachedImg = global.viewerState.preloadCache.get(6).img;
    expect(cachedImg.src).toBe('stream://6.jpg');
    expect(cachedImg.decoding).toBe('async');
    expect(cachedImg.decode).toHaveBeenCalled();
  });

  it('should prefetch wrap-around images at boundaries (index 0)', async () => {
    global.viewerState.currentIndex = 0;
    global.viewerState.totalImages = 10;
    await preloadAdjacentImages();

    // インデックス0の境界では +1=1, +2=2, -1=9(末尾), -2=8 がプリロードされること
    expect(global.viewerState.preloadCache.has(1)).toBe(true);
    expect(global.viewerState.preloadCache.has(2)).toBe(true);
    expect(global.viewerState.preloadCache.has(9)).toBe(true);
    expect(global.viewerState.preloadCache.has(8)).toBe(true);
  });

  it('should purge images that are further than 3 circular distance away', async () => {
    global.viewerState.currentIndex = 5;
    await preloadAdjacentImages();
    expect(global.viewerState.preloadCache.has(3)).toBe(true);

    // インデックスが 9 に移動した場合、3 は円周距離 4 (> 3) なのでパージされる
    global.viewerState.currentIndex = 9;
    const oldImg = global.viewerState.preloadCache.get(3).img;
    
    await preloadAdjacentImages();

    expect(global.viewerState.preloadCache.has(3)).toBe(false);
    expect(oldImg.src).toBe('http://localhost/');
  });

  it('should populate viewerState.paths from chunked getViewerImage response', async () => {
    global.viewerState.paths = new Array(10).fill(null);
    global.window.veloceAPI.getViewerImage = vi.fn().mockResolvedValue({
      path: '4.jpg',
      total: 10,
      index: 4,
      chunkStart: 2,
      chunk: ['2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg']
    });

    const getImagePath = async (index) => {
      if (global.viewerState.paths && global.viewerState.paths[index]) {
        return global.viewerState.paths[index];
      }
      const result = await global.window.veloceAPI.getViewerImage(index);
      if (result) {
        if (!global.viewerState.paths || global.viewerState.paths.length !== result.total) {
          global.viewerState.paths = new Array(result.total).fill(null);
        }
        if (result.chunk && typeof result.chunkStart === 'number') {
          for (let i = 0; i < result.chunk.length; i++) {
            global.viewerState.paths[result.chunkStart + i] = result.chunk[i];
          }
        }
        global.viewerState.paths[index] = result.path;
        return result.path;
      }
      return null;
    };

    const path = await getImagePath(4);
    expect(path).toBe('4.jpg');
    expect(global.viewerState.paths[2]).toBe('2.jpg');
    expect(global.viewerState.paths[3]).toBe('3.jpg');
    expect(global.viewerState.paths[4]).toBe('4.jpg');
    expect(global.viewerState.paths[5]).toBe('5.jpg');
    expect(global.viewerState.paths[6]).toBe('6.jpg');

    // チャンクでキャッシュされたインデックスはAPIを呼ばずに即座に返ること
    global.window.veloceAPI.getViewerImage.mockClear();
    const cachedPath = await getImagePath(3);
    expect(cachedPath).toBe('3.jpg');
    expect(global.window.veloceAPI.getViewerImage).not.toHaveBeenCalled();
  });
});
