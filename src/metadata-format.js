/**
 * メタデータの数値を表示用にフォーマットします。
 * @param {number|string|null|undefined} num
 * @returns {string|null}
 */
export function formatMetadataNumber(num) {
  if (num === null || num === undefined) return null;
  const n = Number(num);
  return !isNaN(n) ? n.toLocaleString() : num;
}

/**
 * 画像ファイルとメタデータからインスペクター/Diff共通の構造を抽出します。
 * @param {object} file
 * @param {object} meta
 * @returns {object}
 */
export function extractMetadataFields(file, meta = {}) {
  const p = meta.params || {};
  const data = {
    name: file.name,
    source: meta.source || file.source || null,
    prompt: meta.prompt || file.prompt || '',
    negativePrompt: meta.negativePrompt || file.negativePrompt || '',
    chars: [],
    params: {}
  };

  if (Array.isArray(p.characterPrompts)) {
    data.chars = p.characterPrompts.map(cp => ({ prompt: cp.prompt || '', uc: cp.uc || '' }));
  } else if (Array.isArray(file.charPrompts)) {
    data.chars = file.charPrompts.map(cp => ({
      prompt: (cp && typeof cp === 'object' && cp.prompt) ? cp.prompt : String(cp),
      uc: (cp && typeof cp === 'object' && cp.uc) ? cp.uc : ''
    }));
  }

  const w = p.width || meta.width;
  const h = p.height || meta.height;
  const res = (w && h) ? `${formatMetadataNumber(w)}x${formatMetadataNumber(h)}` : null;

  let sampler = p.sampler || file.sampler || null;
  if (sampler && sampler !== '-' && p.sm && !sampler.includes('karras')) {
    sampler += ' (karras)';
  }

  data.params = {
    resolution: res,
    seed: p.seed ?? file.seed ?? null,
    steps: formatMetadataNumber(p.steps ?? file.steps ?? null),
    sampler,
    scale: p.scale ?? file.scale ?? null,
    cfg_rescale: p.cfg_rescale ?? file.cfg_rescale ?? null,
    uncond_scale: p.uncond_scale ?? file.uncond_scale ?? null,
    rawParameters: p.rawParameters ?? file.rawParameters ?? null
  };

  return data;
}

/**
 * カンマ区切りプロンプトをタグ配列に分解します。
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function parsePromptTags(text) {
  if (!text) return [];
  return String(text).split(',').map(t => t.trim()).filter(Boolean);
}

/**
 * 検索語に一致する部分をハイライトします。
 * @param {string} text
 * @param {string[]} terms
 * @returns {string}
 */
export function highlightSearchTerms(text, terms) {
  if (!text || !terms || terms.length === 0) return text;
  const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let result = escaped;
  for (const term of terms) {
    if (!term) continue;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(re, '<mark class="search-highlight">$1</mark>');
  }
  return result;
}

/**
 * インスペクター用のセクション定義をデータから生成します。
 * @param {ReturnType<typeof extractMetadataFields>} data
 * @returns {Array<{title: string, value: *, isParam?: boolean}>}
 */
export function buildInspectorSections(data) {
  const sections = [
    { title: 'モデル / バージョン', value: data.source, isParam: true },
    { title: 'プロンプト', value: data.prompt },
    { title: '除外したい要素', value: data.negativePrompt },
  ];

  data.chars.forEach((c, i) => {
    sections.push({ title: `キャラクター ${i + 1} プロンプト`, value: c.prompt });
    sections.push({ title: `キャラクター ${i + 1} 除外したい要素`, value: c.uc });
  });

  sections.push(
    { title: '画像サイズ', value: data.params.resolution, isParam: true },
    { title: 'シード値', value: data.params.seed, isParam: true },
    { title: 'ステップ', value: data.params.steps, isParam: true },
    { title: 'サンプラー', value: data.params.sampler, isParam: true },
    { title: 'プロンプトガイダンス', value: data.params.scale, isParam: true },
    { title: 'プロンプトガイダンスの再調整', value: data.params.cfg_rescale, isParam: true },
    { title: '除外したい要素の強さ', value: data.params.uncond_scale, isParam: true },
    { title: '生成パラメータ (Raw)', value: data.params.rawParameters }
  );

  return sections;
}
