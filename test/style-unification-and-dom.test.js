import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Style Unification and DOM Optimization Tests', () => {
  const rootDir = path.resolve(__dirname, '..');
  const styleCssPath = path.join(rootDir, 'src', 'style.css');
  const indexHtmlPath = path.join(rootDir, 'src', 'index.html');
  const rendererJsPath = path.join(rootDir, 'src', 'renderer.js');
  const rendererUiJsPath = path.join(rootDir, 'src', 'renderer-ui.js');

  it('verifies style.css color token definitions and zero hardcoded RGB values', () => {
    const css = fs.readFileSync(styleCssPath, 'utf-8');

    // --glow-gold-rgb が :root に定義されていること
    expect(css).toContain('--glow-gold-rgb: 230, 199, 98;');

    // 230, 199, 98 の出現回数が定義の1回のみであること
    const goldRgbMatches = css.match(/230,\s*199,\s*98/g);
    expect(goldRgbMatches).not.toBeNull();
    expect(goldRgbMatches.length).toBe(1);

    // 224, 82, 99 の出現回数が定義の1回のみであること
    const dangerRgbMatches = css.match(/224,\s*82,\s*99/g);
    expect(dangerRgbMatches).not.toBeNull();
    expect(dangerRgbMatches.length).toBe(1);

    // 追加されたヘルパークラスが正しく存在すること
    expect(css).toContain('.diff-tag-empty {');
    expect(css).toContain('.menu-item-icon {');
    expect(css).toContain('.menu-item-text {');
    expect(css).toContain('.render-error-box {');
    expect(css).toContain('.btn-browse-path {');
    expect(css).toContain('.cond-path-input {');
  });

  it('verifies index.html has zero inline style attributes', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');

    // style="..." 属性が一切存在しないこと
    const inlineStyleMatches = html.match(/\bstyle\s*=\s*["'][^"']*["']/gi);
    expect(inlineStyleMatches).toBeNull();

    // 必須要素が存在すること
    expect(html).toContain('id="border-overlay"');
    expect(html).toContain('id="bookmark-overflow-btn"');
    expect(html).toContain('id="inspector-header-path"');
  });

  it('verifies renderer-ui.js uses diff-tag-empty class instead of inline styles', () => {
    const code = fs.readFileSync(rendererUiJsPath, 'utf-8');

    // diff-tag-empty クラスが使用されていること
    expect(code).toContain('<span class="diff-tag-empty">なし</span>');

    // style="..." が存在しないこと
    const inlineStyleMatches = code.match(/\bstyle\s*=\s*["'][^"']*["']/gi);
    expect(inlineStyleMatches).toBeNull();
  });

  it('verifies renderer.js has zero inline style attributes and uses optimized DOM access', () => {
    const code = fs.readFileSync(rendererJsPath, 'utf-8');

    // style="..." 属性が一切存在しないこと
    const inlineStyleMatches = code.match(/\bstyle\s*=\s*["'][^"']*["']/gi);
    expect(inlineStyleMatches).toBeNull();

    // インスペクターコピーボタンで O(1) firstElementChild が使用されていること
    expect(code).toContain('secEl.copyBtn = secEl.copyWrapper.firstElementChild;');

    // エラー表示で render-error-box クラスが使用されていること
    expect(code).toContain('<div class="render-error-box">');

    // スマートフォルダ条件入力UIで適切なCSSクラスが使用されていること
    expect(code).toContain('cond-value-input dialog-input flex-1');
    expect(code).toContain('btn-browse-path dialog-btn');
    expect(code).toContain('cond-path-input flex-1');
  });
});
