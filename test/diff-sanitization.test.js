import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState } from '../src/renderer/renderer-state.js';

describe('Diff Modal XSS Sanitization', () => {
  let uiManager;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="diff-modal" class="modal-backdrop">
        <div id="diff-container"></div>
      </div>
    `;
    window.veloceAPI = {
      convertFileSrc: (path) => `asset://localhost/${encodeURIComponent(path)}`
    };

    const { UIManager } = await import('../src/renderer/renderer-ui.js');
    uiManager = new UIManager(appState);
  });

  it('should safely escape malicious HTML tags in prompt and negativePrompt', () => {
    const file1 = { name: 'safe.png', path: 'safe.png' };
    const file2 = { name: 'malicious.png', path: 'malicious.png' };

    const meta1 = {
      prompt: 'masterpiece, 1girl, smiling',
      negativePrompt: 'low quality, blurry'
    };
    const meta2 = {
      prompt: '<img src=x onerror=alert("xss")>, <script>alert(1)</script>, 1girl',
      negativePrompt: '<svg/onload=alert("negative_xss")>, worst quality'
    };

    uiManager.showDiffModal(file1, file2, meta1, meta2);

    const container = document.getElementById('diff-container');
    expect(container).not.toBeNull();

    // Dangerous executable elements should not exist in DOM
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('svg[onload]')).toBeNull();

    // Verify content is escaped in diff tags
    const diffTags = Array.from(container.querySelectorAll('.diff-tag'));
    const tagTexts = diffTags.map(t => t.textContent);
    expect(tagTexts).toContain('<img src=x onerror=alert("xss")>');
    expect(tagTexts).toContain('<script>alert(1)</script>');
    expect(tagTexts).toContain('<svg/onload=alert("negative_xss")>');

    // Container innerHTML must contain escaped entity representations, not raw elements
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(');
    expect(container.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(container.innerHTML).toContain('&lt;svg/onload=alert(');
  });

  it('should safely escape malicious HTML tags in parameter values (sampler, seed, etc.)', () => {
    const file1 = { name: 'f1.png', path: 'f1.png' };
    const file2 = { name: 'f2.png', path: 'f2.png' };

    const meta1 = {
      params: {
        sampler: 'Euler a',
        seed: '12345678'
      }
    };
    const meta2 = {
      params: {
        sampler: '<iframe src="javascript:alert(1)"></iframe>',
        seed: '<b onclick="evil()">click</b>'
      }
    };

    uiManager.showDiffModal(file1, file2, meta1, meta2);

    const container = document.getElementById('diff-container');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('b[onclick]')).toBeNull();

    expect(container.innerHTML).toContain('&lt;iframe src=');
    expect(container.innerHTML).toContain('&lt;b onclick=');
  });

  it('should safely escape malicious HTML tags in sublabels', () => {
    const file1 = { name: 'f1.png', path: 'f1.png' };
    const file2 = { name: 'f2.png', path: 'f2.png' };

    const meta1 = {
      source: 'NovelAI',
      params: {
        request_type: 'NativeInfillingRequest'
      }
    };
    const meta2 = {
      source: 'NovelAI',
      params: {
        request_type: 'NativeInfillingRequest + <img src=x onerror=exploit()>'
      }
    };

    uiManager.showDiffModal(file1, file2, meta1, meta2);

    const container = document.getElementById('diff-container');
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img src=x onerror=exploit()&gt;');
  });
});
