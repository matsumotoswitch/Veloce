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
    expect(css).toContain('--text-rgb: 205, 219, 224;');
    expect(css).toContain('--bg-darker-rgb: 30, 30, 30;');

    // 230, 199, 98 の出現回数が定義の1回のみであること
    const goldRgbMatches = css.match(/230,\s*199,\s*98/g);
    expect(goldRgbMatches).not.toBeNull();
    expect(goldRgbMatches.length).toBe(1);

    // 224, 82, 99 の出現回数が定義の1回のみであること
    const dangerRgbMatches = css.match(/224,\s*82,\s*99/g);
    expect(dangerRgbMatches).not.toBeNull();
    expect(dangerRgbMatches.length).toBe(1);

    // 205, 219, 224 の出現回数が定義の1回のみであること
    const textRgbMatches = css.match(/205,\s*219,\s*224/g);
    expect(textRgbMatches).not.toBeNull();
    expect(textRgbMatches.length).toBe(1);

    // 30, 30, 30 の出現回数が定義の1回のみであること
    const bgDarkerRgbMatches = css.match(/30,\s*30,\s*30/g);
    expect(bgDarkerRgbMatches).not.toBeNull();
    expect(bgDarkerRgbMatches.length).toBe(1);

    // ハードコードされたフォールバック色の排除
    expect(css).not.toContain('var(--text-color, #cddbe0)');
    expect(css).not.toContain('var(--accent-color, #257e8c)');

    // 追加されたヘルパークラスが正しく存在すること
    expect(css).toContain('.diff-tag-empty {');
    expect(css).toContain('.menu-item-icon {');
    expect(css).toContain('.menu-item-text {');
    expect(css).toContain('.render-error-box {');
    expect(css).toContain('.btn-browse-path {');
    expect(css).toContain('.cond-path-input {');
    expect(css).toContain('.resizer-toggle-horizontal {');
    expect(css).toContain('.resizer-toggle-vertical {');

    // リサイザートグルがホバー時にも中央揃え translate(-50%, -50%) を維持すること（右下へのズレ防止）
    expect(css).toMatch(/\.resizer-toggle:hover\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)\s*scale\(1\.05\);/);
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

  it('verifies renderer-ui.js uses diff-tag-empty class and optimized height guards', () => {
    const code = fs.readFileSync(rendererUiJsPath, 'utf-8');

    // diff-tag-empty クラスが使用されていること
    expect(code).toContain('<span class="diff-tag-empty">なし</span>');

    // 仮想スクロールスペーサーとファイル行で数値キャッシュ比較ガードが使用されていること
    expect(code).toContain('topSpacer._cachedHeight !== topSpacerHeight');
    expect(code).toContain('bottomSpacer._cachedHeight !== bottomSpacerHeight');
    expect(code).toContain('tr._cachedRowHeight !== rowHeight');

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

    // リサイザートグルがインラインCSSではなくクラスで指定されていること
    expect(code).toContain('resizer-toggle ${isHorizontal ? \'resizer-toggle-horizontal\' : \'resizer-toggle-vertical\'}');
    expect(code).not.toContain('btn.style.cssText =');

    // 余計な「メタデータが含まれていないか、読み取れませんでした。」の警告テキストが削除されていること
    expect(code).not.toContain('メタデータが含まれていないか、読み取れませんでした。');
  });

  it('verifies index.html maintains inspector-empty element for empty folders', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    expect(html).toContain('id="inspector-empty"');
    expect(html).toContain('画像を選択してタグを表示');
  });
});
