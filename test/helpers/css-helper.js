import fs from 'fs';
import path from 'path';

/**
 * style.css および @import 先の全サブCSSモジュールを結合して取得するテストヘルパー
 * @returns {string} 結合されたCSS文字列
 */
export function getFullCssContent() {
  const entryPath = path.resolve(__dirname, '../../src/style.css');
  const entryContent = fs.readFileSync(entryPath, 'utf-8');

  const importRegex = /@import\s+['"](.+?)['"];/g;
  let match;
  let combined = '';

  while ((match = importRegex.exec(entryContent)) !== null) {
    const importPath = path.resolve(path.dirname(entryPath), match[1]);
    if (fs.existsSync(importPath)) {
      combined += fs.readFileSync(importPath, 'utf-8') + '\n';
    }
  }

  return combined || entryContent;
}
