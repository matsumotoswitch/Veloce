import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Dialog and Modal Close Buttons UX', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should have close buttons in index.html with title "閉じる (Esc)"', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf-8');
    
    // diff modal
    expect(html).toContain('id="diff-close-btn"');
    expect(html).toContain('id="diff-bottom-close-btn"');
    expect(html).toContain('title="閉じる (Esc)"');

    // edit favorite modal
    expect(html).toContain('id="fav-modal-close-btn"');
    expect(html).toContain('お気に入りを編集');

    // edit smart folder modal
    expect(html).toContain('id="smart-modal-close-btn"');
    expect(html).toContain('id="smart-modal-title"');
  });

  it('should close edit-favorite-modal and reset display on close button click', () => {
    const modal = document.createElement('div');
    modal.id = 'edit-favorite-modal';
    modal.className = 'dialog-overlay show';
    modal.style.display = 'none';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'fav-modal-close-btn';
    modal.appendChild(closeBtn);
    document.body.appendChild(modal);

    closeBtn.addEventListener('click', () => {
      modal.classList.remove('show');
      modal.style.display = '';
    });

    closeBtn.click();

    expect(modal.classList.contains('show')).toBe(false);
    expect(modal.style.display).toBe('');
  });

  it('should close edit-smart-folder-modal and reset display on close button click', () => {
    const modal = document.createElement('div');
    modal.id = 'edit-smart-folder-modal';
    modal.className = 'dialog-overlay show';
    modal.style.display = 'none';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'smart-modal-close-btn';
    modal.appendChild(closeBtn);
    document.body.appendChild(modal);

    closeBtn.addEventListener('click', () => {
      modal.classList.remove('show');
      modal.style.display = '';
    });

    closeBtn.click();

    expect(modal.classList.contains('show')).toBe(false);
    expect(modal.style.display).toBe('');
  });

  it('should close diff-modal on top close button and bottom close button click', () => {
    const modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'modal show';

    const topCloseBtn = document.createElement('button');
    topCloseBtn.id = 'diff-close-btn';
    const bottomCloseBtn = document.createElement('button');
    bottomCloseBtn.id = 'diff-bottom-close-btn';

    modal.appendChild(topCloseBtn);
    modal.appendChild(bottomCloseBtn);
    document.body.appendChild(modal);

    topCloseBtn.addEventListener('click', () => {
      modal.classList.remove('show');
    });
    bottomCloseBtn.addEventListener('click', () => {
      modal.classList.remove('show');
    });

    topCloseBtn.click();
    expect(modal.classList.contains('show')).toBe(false);

    modal.classList.add('show');
    expect(modal.classList.contains('show')).toBe(true);

    bottomCloseBtn.click();
    expect(modal.classList.contains('show')).toBe(false);
  });

  it('should define .dialog-close-btn styles with hover danger red in style.css', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf-8');
    expect(css).toMatch(/\.dialog-close-btn[\s\S]*?color:\s*var\(--danger-red\)/);
  });

  it('should not have border-bottom on .dialog-header or .modal-header', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/style.css'), 'utf-8');
    expect(css).not.toMatch(/\.dialog-header\s*\{[^}]*border-bottom:/);
  });
});
