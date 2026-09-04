import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AGENTS.md & PLAN.md Compliance and Regression Guard', () => {
  const srcDir = path.resolve(__dirname, '../src');
  const jsFiles = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ name: f, content: fs.readFileSync(path.join(srcDir, f), 'utf-8') }));

  const htmlFiles = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.html'))
    .map(f => ({ name: f, content: fs.readFileSync(path.join(srcDir, f), 'utf-8') }));

  const cssPath = path.join(srcDir, 'style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  describe('1. No Emoji Compliance (AGENTS.md Sec 2)', () => {
    // Windows 8.1 で豆腐化する Unicode 絵文字・特殊記号（⭐, ★, 🚀, ❌, 👍 等）の混入を禁止
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

    it('should not contain emojis in any JavaScript source file', () => {
      for (const file of jsFiles) {
        const matches = file.content.match(emojiRegex);
        expect(matches, `Emoji detected in src/${file.name}: ${matches ? matches[0] : ''}`).toBeNull();
      }
    });

    it('should not contain emojis in any HTML file in src/', () => {
      for (const file of htmlFiles) {
        const matches = file.content.match(emojiRegex);
        expect(matches, `Emoji detected in src/${file.name}: ${matches ? matches[0] : ''}`).toBeNull();
      }
    });

    it('should not contain emojis in style.css', () => {
      const matches = cssContent.match(emojiRegex);
      expect(matches, `Emoji detected in style.css: ${matches ? matches[0] : ''}`).toBeNull();
    });
  });

  describe('2. Chromium 109 Compatibility (AGENTS.md Sec 1 & PLAN.md Sec 1.2)', () => {
    // Chromium 110 以降で導入された新しい配列操作メソッドの利用を禁止
    const bannedMethods = [
      'toSorted',
      'toReversed',
      'toSpliced',
      'with',
      'findLast',
      'findLastIndex'
    ];

    it('should not use post-Chromium-109 Array methods in JavaScript sources', () => {
      for (const file of jsFiles) {
        for (const method of bannedMethods) {
          const regex = new RegExp(`\\.${method}\\s*\\(`, 'g');
          const matches = file.content.match(regex);
          expect(matches, `Banned ECMAScript method '.${method}()' found in src/${file.name} (Chromium 109 incompatible)`).toBeNull();
        }
      }
    });
  });

  describe('3. Objective Terminology Guard (AGENTS.md Sec 2 & Sec 4)', () => {
    // UIテキストやコメントにおける過度な誇張表現の混入を防止
    const exaggeratedTerms = ['神速', '爆速'];

    it('should not contain exaggerated marketing buzzwords in JavaScript sources', () => {
      for (const file of jsFiles) {
        for (const term of exaggeratedTerms) {
          const regex = new RegExp(term, 'g');
          const matches = file.content.match(regex);
          expect(matches, `Exaggerated term "${term}" found in src/${file.name}`).toBeNull();
        }
      }
    });
  });

  describe('4. Modal and Dialog Header Consistency (AGENTS.md Sec 2)', () => {
    it('should not have border-bottom on modal headers in style.css', () => {
      const modalHeaderMatch = cssContent.match(/\.modal-header\s*\{[^}]*\}/g) || [];
      for (const block of modalHeaderMatch) {
        expect(block).not.toMatch(/border-bottom:\s*(?!none\b)[^;]+;/);
      }
    });

    it('should use SVG close button in modal headers across HTML templates', () => {
      for (const file of htmlFiles) {
        if (file.content.includes('modal-header')) {
          expect(file.content).toContain('modal-close-btn');
          expect(file.content).toContain('<svg');
        }
      }
    });
  });
});
