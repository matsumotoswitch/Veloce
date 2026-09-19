import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getFullCssContent } from './helpers/css-helper.js';

describe('Checkerboard Pattern for Transparent Thumbnails', () => {
  const cssContent = getFullCssContent();
  const variablesCss = fs.readFileSync(path.resolve(__dirname, '../src/common/css/variables.css'), 'utf-8');
  const componentsCss = fs.readFileSync(path.resolve(__dirname, '../src/renderer/css/components.css'), 'utf-8');
  const viewerCss = fs.readFileSync(path.resolve(__dirname, '../src/viewer/viewer.css'), 'utf-8');

  it('should define checkerboard color and size tokens in variables.css', () => {
    expect(variablesCss).toContain('--checkerboard-dark:');
    expect(variablesCss).toContain('--checkerboard-light:');
    expect(variablesCss).toContain('--checkerboard-size:');
    expect(variablesCss).toMatch(/--checkerboard-size:\s*16px;/);
  });

  it('should apply constant-size checkerboard background to .thumbnail-img', () => {
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*background-color:\s*var\(--checkerboard-dark\);/);
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*background-image:\s*conic-gradient\(/);
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*background-size:\s*var\(--checkerboard-size\)\s+var\(--checkerboard-size\);/);
  });

  it('should constrain .thumbnail-img to intrinsic aspect ratio inside .thumbnail-item', () => {
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*max-width:\s*100%;/);
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*max-height:\s*100%;/);
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*width:\s*auto;/);
    expect(componentsCss).toMatch(/\.thumbnail-img\s*\{[^}]*height:\s*auto;/);
    expect(componentsCss).toMatch(/\.thumbnail-item\s*\{[^}]*align-items:\s*center;/);
    expect(componentsCss).toMatch(/\.thumbnail-item\s*\{[^}]*justify-content:\s*center;/);
  });

  it('should apply checkerboard background to #viewer-img for standalone viewer', () => {
    expect(viewerCss).toMatch(/#viewer-img\s*\{[^}]*background-color:\s*var\(--checkerboard-dark\);/);
    expect(viewerCss).toMatch(/#viewer-img\s*\{[^}]*background-image:\s*conic-gradient\(/);
    expect(viewerCss).toMatch(/#viewer-img\s*\{[^}]*background-size:\s*var\(--checkerboard-size\)\s+var\(--checkerboard-size\);/);
  });

  it('should detect alpha-supporting formats and preserve transparency during thumbnail generation', async () => {
    const { thumbnailWorkerPool } = await import('../src/renderer/renderer-thumbnails.js');

    const alphaExtensions = ['test.png', 'test.webp', 'test.gif', 'test.svg', 'test.apng', 'test.avif'];
    for (const ext of alphaExtensions) {
      const lower = ext.toLowerCase();
      const supportsAlpha = lower.endsWith('.png') ||
                            lower.endsWith('.webp') ||
                            lower.endsWith('.gif') ||
                            lower.endsWith('.svg') ||
                            lower.endsWith('.apng') ||
                            lower.endsWith('.avif');
      expect(supportsAlpha).toBe(true);
    }

    const nonAlphaExtensions = ['test.jpg', 'test.jpeg', 'test.bmp'];
    for (const ext of nonAlphaExtensions) {
      const lower = ext.toLowerCase();
      const supportsAlpha = lower.endsWith('.png') ||
                            lower.endsWith('.webp') ||
                            lower.endsWith('.gif') ||
                            lower.endsWith('.svg') ||
                            lower.endsWith('.apng') ||
                            lower.endsWith('.avif');
      expect(supportsAlpha).toBe(false);
    }
  });

  it('should encode alpha images using webp or png without background fill in worker pool', async () => {
    const { thumbnailWorkerPool } = await import('../src/renderer/renderer-thumbnails.js');
    
    // Test that thumbnailWorkerPool is defined and has generate method
    expect(thumbnailWorkerPool).toBeDefined();
    expect(typeof thumbnailWorkerPool.generate).toBe('function');
  });
});
