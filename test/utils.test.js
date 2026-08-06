import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { debounce, escapeHtml, applyGlowEffect, blockDevtoolsShortcuts, getStreamUrl } from '../src/utils.js';

describe('Utils', () => {
  describe('debounce', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should delay function execution until wait time has passed', () => {
      const mockFn = vi.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn();
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      debouncedFn();
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(99);
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1); // total 100ms since last call
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should pass arguments to the original function', () => {
      const mockFn = vi.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn('arg1', 'arg2');
      vi.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      expect(escapeHtml('<div>&"Test"</div>')).toBe('&lt;div&gt;&amp;&quot;Test&quot;&lt;/div&gt;');
    });

    it('should handle non-string inputs gracefully', () => {
      expect(escapeHtml(123)).toBe('123');
      expect(escapeHtml(null)).toBe('null');
      expect(escapeHtml(undefined)).toBe('undefined');
    });
  });

  describe('applyGlowEffect', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      
      // Mock requestAnimationFrame
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
        setTimeout(cb, 16);
        return 1;
      });
    });
    
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should create a flash element and remove it after animation', () => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ top: 10, left: 20, width: 100, height: 50 });
      document.body.appendChild(el);

      applyGlowEffect(el);

      const flashes = document.querySelectorAll('div[style*="fixed"]');
      expect(flashes.length).toBe(1);
      
      const flash = flashes[0];
      expect(flash.style.top).toBe('10px');
      expect(flash.style.left).toBe('20px');
      expect(flash.style.width).toBe('100px');
      expect(flash.style.height).toBe('50px');
      expect(flash.style.backgroundColor).toBe('rgba(255, 255, 255, 0.4)');

      // Advance past requestAnimationFrames and timeout
      vi.advanceTimersByTime(1000);

      expect(document.querySelectorAll('div[style*="fixed"]').length).toBe(0);
    });

    it('should do nothing if el is null', () => {
      applyGlowEffect(null);
      expect(document.body.children.length).toBe(0);
    });
  });

  describe('blockDevtoolsShortcuts', () => {
    it('should prevent default on F12 or Ctrl+Shift+I', () => {
      blockDevtoolsShortcuts();
      
      const f12Event = new KeyboardEvent('keydown', { key: 'F12', cancelable: true });
      const preventDefaultSpy1 = vi.spyOn(f12Event, 'preventDefault');
      document.dispatchEvent(f12Event);
      expect(preventDefaultSpy1).toHaveBeenCalled();

      const ctrlShiftIEvent = new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true, cancelable: true });
      const preventDefaultSpy2 = vi.spyOn(ctrlShiftIEvent, 'preventDefault');
      document.dispatchEvent(ctrlShiftIEvent);
      expect(preventDefaultSpy2).toHaveBeenCalled();

      // Normal key should not be prevented
      const aEvent = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
      const preventDefaultSpy3 = vi.spyOn(aEvent, 'preventDefault');
      document.dispatchEvent(aEvent);
      expect(preventDefaultSpy3).not.toHaveBeenCalled();
    });
  });

  describe('getStreamUrl', () => {
    afterEach(() => {
      delete window.videoServerPort;
    });

    it('should return localhost url if videoServerPort is defined for mp4', () => {
      window.videoServerPort = '8080';
      const result = getStreamUrl('C:\\videos\\test.mp4', 'asset://localhost/C:/videos/test.mp4');
      expect(result).toBe('http://localhost:8080/?path=C%3A%5Cvideos%5Ctest.mp4');
    });

    it('should return fallback url if videoServerPort is missing for mp4', () => {
      const result = getStreamUrl('C:\\videos\\test.mp4', 'asset://localhost/C:/videos/test.mp4');
      expect(result).toBe('asset://stream.localhost/?path=C%3A%5Cvideos%5Ctest.mp4');
    });

    it('should return baseSrc for non-mp4 files', () => {
      const result = getStreamUrl('C:\\images\\test.png', 'asset://localhost/C:/images/test.png');
      expect(result).toBe('asset://localhost/C:/images/test.png');
    });
  });
});
