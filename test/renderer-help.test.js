/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseLicenseMarkdown, toggleHelpOverlay, showLicenseDialog } from '../src/renderer-help.js';

describe('renderer-help.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      cb();
      return 1;
    });
  });

  afterEach(() => {
    const licenseOverlay = document.getElementById('license-overlay');
    if (licenseOverlay) {
      const closeBtn = licenseOverlay.querySelector('#license-close-btn');
      if (closeBtn) closeBtn.click();
      else licenseOverlay.remove();
    }
    const helpOverlay = document.getElementById('help-overlay');
    if (helpOverlay) {
      helpOverlay.remove();
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('parseLicenseMarkdown', () => {
    it('should return empty string for null or empty input', () => {
      expect(parseLicenseMarkdown('')).toBe('');
      expect(parseLicenseMarkdown(null)).toBe('');
    });

    it('should convert headers to corresponding HTML tags', () => {
      const input = '# Header 1\n## Header 2\n### Header 3';
      const result = parseLicenseMarkdown(input);
      expect(result).toContain('<h1>Header 1</h1>');
      expect(result).toContain('<h2>Header 2</h2>');
      expect(result).toContain('<h3>Header 3</h3>');
    });

    it('should convert markdown lists into ul/li elements', () => {
      const input = '* Item 1\n* Item 2';
      const result = parseLicenseMarkdown(input);
      expect(result).toContain('<ul class="md-list">');
      expect(result).toContain('<li class="md-list-item">Item 1</li>');
      expect(result).toContain('<li class="md-list-item">Item 2</li>');
    });

    it('should convert blockquotes into blockquote elements', () => {
      const input = '> This is a quote';
      const result = parseLicenseMarkdown(input);
      expect(result).toContain('<blockquote class="md-blockquote">This is a quote</blockquote>');
    });

    it('should wrap bare URLs in anchor tags', () => {
      const input = 'Check out https://github.com/matsumotoswitch/Veloce for info';
      const result = parseLicenseMarkdown(input);
      expect(result).toContain('<a href="https://github.com/matsumotoswitch/Veloce">https://github.com/matsumotoswitch/Veloce</a>');
    });
  });

  describe('toggleHelpOverlay', () => {
    it('should create and show help-overlay in the document body', () => {
      toggleHelpOverlay(true);
      const overlay = document.getElementById('help-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay.classList.contains('show')).toBe(true);

      const mainTab = overlay.querySelector('.help-tab[data-target="help-main"]');
      const viewerTab = overlay.querySelector('.help-tab[data-target="help-viewer"]');
      expect(mainTab).not.toBeNull();
      expect(viewerTab).not.toBeNull();
      expect(mainTab.classList.contains('active')).toBe(true);
    });

    it('should switch tabs when clicking tab buttons', () => {
      toggleHelpOverlay(true);
      const overlay = document.getElementById('help-overlay');
      const mainTab = overlay.querySelector('.help-tab[data-target="help-main"]');
      const viewerTab = overlay.querySelector('.help-tab[data-target="help-viewer"]');
      const mainContent = overlay.querySelector('#help-main');
      const viewerContent = overlay.querySelector('#help-viewer');

      viewerTab.click();
      expect(viewerTab.classList.contains('active')).toBe(true);
      expect(mainTab.classList.contains('active')).toBe(false);
      expect(viewerContent.classList.contains('active')).toBe(true);
      expect(mainContent.classList.contains('active')).toBe(false);
    });

    it('should remove overlay when close button is clicked', () => {
      toggleHelpOverlay(true);
      const overlay = document.getElementById('help-overlay');
      const closeBtn = overlay.querySelector('#help-close-btn');

      vi.useFakeTimers();
      closeBtn.click();
      expect(overlay.classList.contains('show')).toBe(false);
      vi.advanceTimersByTime(250);
      expect(document.getElementById('help-overlay')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('showLicenseDialog', () => {
    it('should create license-overlay and render parsed license text', async () => {
      window.__TAURI__.invoke.mockResolvedValue('# Test Licenses\n* Lib A (MIT)');

      await showLicenseDialog();
      const overlay = document.getElementById('license-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay.innerHTML).toContain('<h1>Test Licenses</h1>');
      expect(overlay.innerHTML).toContain('Lib A (MIT)');

      const closeBtn = overlay.querySelector('#license-close-btn');
      if (closeBtn) closeBtn.click();
    });

    it('should cleanup license-overlay when close button is clicked', async () => {
      window.__TAURI__.invoke.mockResolvedValue('License Info');

      await showLicenseDialog();
      const overlay = document.getElementById('license-overlay');
      expect(overlay).not.toBeNull();

      const closeBtn = overlay.querySelector('#license-close-btn');
      expect(closeBtn).not.toBeNull();
      closeBtn.click();

      expect(document.getElementById('license-overlay')).toBeNull();
    });

    it('should cleanup license-overlay on Escape key', async () => {
      window.__TAURI__.invoke.mockResolvedValue('License Info');

      await showLicenseDialog();
      const overlay = document.getElementById('license-overlay');
      expect(overlay).not.toBeNull();

      const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(event);

      expect(document.getElementById('license-overlay')).toBeNull();
    });
  });
});
