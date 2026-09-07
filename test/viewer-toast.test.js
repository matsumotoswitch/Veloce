import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { showToast } from '../src/viewer.js';

describe('Viewer Toast Notification', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost'
    });
    global.window = dom.window;
    global.document = dom.window.document;

    vi.useFakeTimers();
    global.requestAnimationFrame = cb => {
      cb();
      return 1;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.window;
    delete global.document;
  });

  it('should create #toast-container and toast element when none exists', () => {
    expect(document.getElementById('toast-container')).toBeNull();

    showToast('テスト通知', 3000, 'info');

    const container = document.getElementById('toast-container');
    expect(container).not.toBeNull();

    const toast = container.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.textContent).toBe('テスト通知');
    expect(toast.classList.contains('info')).toBe(true);
    expect(toast.classList.contains('show')).toBe(true);
  });

  it('should reuse existing #toast-container for multiple toasts', () => {
    showToast('通知1', 3000, 'info');
    showToast('通知2', 3000, 'success');

    const containers = document.querySelectorAll('#toast-container');
    expect(containers.length).toBe(1);

    const toasts = containers[0].querySelectorAll('.toast-message');
    expect(toasts.length).toBe(2);
    expect(toasts[0].textContent).toBe('通知1');
    expect(toasts[1].textContent).toBe('通知2');
    expect(toasts[1].classList.contains('success')).toBe(true);
  });

  it('should support HTML content like SVG star icons for ratings', () => {
    const starSvg = '<svg class="rating-star-icon"></svg>5';
    showToast(starSvg, 3000, 'info');

    const toast = document.querySelector('.toast-message');
    expect(toast.innerHTML).toBe(starSvg);
    expect(toast.querySelector('.rating-star-icon')).not.toBeNull();
  });

  it('should remove show class and remove element from DOM after duration', () => {
    showToast('自動消去テスト', 1000, 'warning');

    const toast = document.querySelector('.toast-message');
    expect(toast).not.toBeNull();
    expect(toast.classList.contains('show')).toBe(true);

    // Advance to duration (1000ms)
    vi.advanceTimersByTime(1000);
    expect(toast.classList.contains('show')).toBe(false);

    // Advance fade-out animation time (200ms)
    vi.advanceTimersByTime(250);
    expect(document.querySelector('.toast-message')).toBeNull();
  });
});
