import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { applySharpenFilter } from '../src/renderer-thumbnails.js';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Thumbnail Sharpness Optimizations (Lanczos3, High Quality, Unsharp Mask, CSS Contrast)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const thumbnailsJsPath = path.join(rootDir, 'src', 'renderer-thumbnails.js');
  const mainRsPath = path.join(rootDir, 'src-tauri', 'src', 'main.rs');

  describe('1. applySharpenFilter algorithm test', () => {
    it('preserves flat color areas without distortion or luminance shift', () => {
      // 5x5 の単色グレー画像 (RGBA)
      const width = 5;
      const height = 5;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 128;     // R
        data[i + 1] = 128; // G
        data[i + 2] = 128; // B
        data[i + 3] = 255; // A
      }

      const mockCtx = {
        getImageData: () => ({ data: new Uint8ClampedArray(data) }),
        putImageData: (imgData) => {
          data.set(imgData.data);
        }
      };

      applySharpenFilter(mockCtx, width, height, 0.22);

      // 中心ピクセル (2, 2) の値が 128 のまま維持されること
      const centerIdx = (2 * width + 2) * 4;
      expect(data[centerIdx]).toBe(128);
      expect(data[centerIdx + 1]).toBe(128);
      expect(data[centerIdx + 2]).toBe(128);
      expect(data[centerIdx + 3]).toBe(255);
    });

    it('enhances edge contrast across boundaries', () => {
      // 5x5 のステップエッジ画像（左が暗く 50、右が明るく 200）
      const width = 5;
      const height = 5;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const val = x < 2 ? 50 : 200;
          data[idx] = val;
          data[idx + 1] = val;
          data[idx + 2] = val;
          data[idx + 3] = 255;
        }
      }

      const mockCtx = {
        getImageData: () => ({ data: new Uint8ClampedArray(data) }),
        putImageData: (imgData) => {
          data.set(imgData.data);
        }
      };

      applySharpenFilter(mockCtx, width, height, 0.22);

      // エッジの境界直前 (x = 1): 明るい隣接画素に引っ張られて、より暗く（< 50）引き締まる
      const edgeDarkIdx = (2 * width + 1) * 4;
      expect(data[edgeDarkIdx]).toBeLessThan(50);

      // エッジの境界直後 (x = 2): 暗い隣接画素との対比で、より明るく（> 200）際立つ
      const edgeBrightIdx = (2 * width + 2) * 4;
      expect(data[edgeBrightIdx]).toBeGreaterThan(200);
    });

    it('safely clamps pixel values within 0-255 without overflow', () => {
      const width = 3;
      const height = 3;
      const data = new Uint8ClampedArray(width * height * 4);
      // すべて 250、中心のみ 255
      data.fill(250);
      const centerIdx = (1 * width + 1) * 4;
      data[centerIdx] = 255;
      data[centerIdx + 1] = 255;
      data[centerIdx + 2] = 255;

      const mockCtx = {
        getImageData: () => ({ data: new Uint8ClampedArray(data) }),
        putImageData: (imgData) => {
          data.set(imgData.data);
        }
      };

      applySharpenFilter(mockCtx, width, height, 0.5);

      expect(data[centerIdx]).toBeLessThanOrEqual(255);
      expect(data[centerIdx]).toBeGreaterThanOrEqual(0);
    });
  });

  describe('2. Frontend configuration test', () => {
    it('uses high resizeQuality and high imageSmoothingQuality in renderer-thumbnails.js', () => {
      const code = fs.readFileSync(thumbnailsJsPath, 'utf-8');
      expect(code).toContain("resizeQuality: 'high'");
      expect(code).toContain("ctx.imageSmoothingQuality = 'high'");
      expect(code).toContain('applySharpenFilter(ctx, width, height, 0.22)');
      expect(code).toContain("type: 'image/jpeg', quality: 0.90");
    });

    it('sets image-rendering: -webkit-optimize-contrast on .thumbnail-img in CSS', () => {
      const css = getFullCssContent();
      expect(css).toMatch(/\.thumbnail-img\s*\{[^}]*image-rendering:\s*-webkit-optimize-contrast;/);
    });
  });

  describe('3. Rust backend configuration test', () => {
    it('uses FilterType::Lanczos3 and sharpen_rgb_buffer in main.rs', () => {
      const rustCode = fs.readFileSync(mainRsPath, 'utf-8');
      expect(rustCode).toContain('FilterType::Lanczos3');
      expect(rustCode).toContain('sharpen_rgb_buffer(&mut buffer, dst_width, dst_height, 0.22)');
    });
  });
});
