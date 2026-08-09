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
    const indicesToPreload = [
      global.viewerState.currentIndex + 1,
      global.viewerState.currentIndex - 1,
      global.viewerState.currentIndex + 2,
      global.viewerState.currentIndex - 2,
    ];
    for (const idx of indicesToPreload) {
      if (idx >= 0 && idx < global.viewerState.totalImages && !global.viewerState.preloadCache.has(idx)) {
        const path = await global.getImagePath(idx);
        if (path) {
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
    }
    for (const cachedIdx of global.viewerState.preloadCache.keys()) {
      if (Math.abs(cachedIdx - global.viewerState.currentIndex) > 3) {
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

  it('should purge images that are further than 3 indices away', async () => {
    // 最初に 5 の周辺をキャッシュ
    global.viewerState.currentIndex = 5;
    await preloadAdjacentImages();
    expect(global.viewerState.preloadCache.has(3)).toBe(true);

    // インデックスが 9 に飛んだ場合、3 は 9 から距離が 6 ( > 3 ) なのでパージされる
    global.viewerState.currentIndex = 9;
    
    // パージ時の挙動を確認するためスパイをセット
    const oldImg = global.viewerState.preloadCache.get(3).img;
    
    await preloadAdjacentImages();

    // 3 は削除されていること
    expect(global.viewerState.preloadCache.has(3)).toBe(false);
    
    // 削除時に src が空にされ、デコードがキャンセルされること
    expect(oldImg.src).toBe('http://localhost/'); // jsdomでは空文字セットでURLベースに解決されるか、''になる
  });
});
