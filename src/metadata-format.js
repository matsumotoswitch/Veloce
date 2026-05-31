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

export function formatRequestType(reqType) {
  if (!reqType) return null;
  const types = {
    'PromptGenerateRequest': 'Text to Image',
    'NativeInfillingRequest': 'Inpainting',
    'ImageToImageRequest': 'Image to Image',
    'Img2ImgRequest': 'Image to Image',
    'VibeTransferRequest': 'Vibe Transfer'
  };
  return types[reqType] || reqType;
}

/**
 * 画像ファイルとメタデータからインスペクター/Diff共通の構造を抽出します。
 * @param {object} file
 * @param {object} meta
 * @returns {object}
 */
export function extractMetadataFields(file, meta = {}) {
  const p = meta.params || {};
  let requestType = p.request_type || null;

  if (Array.isArray(p.reference_information_extracted_multiple) && p.reference_information_extracted_multiple.length > 0) {
    requestType = 'VibeTransferRequest';
  } else if (Array.isArray(p.reference_image_multiple) && p.reference_image_multiple.length > 0) {
    requestType = 'VibeTransferRequest';
  }

  // --- ComfyUI 解析 ---
  if (Array.isArray(p.nodes) && Array.isArray(p.links)) {
    return parseComfyUI(file, meta, p);
  }
  // --- A1111 / Forge 解析 ---
  let a1111Candidate = p.rawParameters || p.Description || p.prompt || file.prompt || meta.prompt;
  if (typeof a1111Candidate === 'string') {
    // EXIFのUTF-16LE文字列がUTF-8としてパースされた際に混入するNULL文字（\0）を除去し、先頭の識別子（UNICODEなど）を消す
    a1111Candidate = a1111Candidate.replace(/\0/g, '').replace(/^(?:[^<A-Za-z0-9]*UNICODE[^<A-Za-z0-9]*)?/i, '').trim();
    if (a1111Candidate.includes('Steps:') && a1111Candidate.includes('Sampler:')) {
      const a1111P = { ...p, rawParameters: a1111Candidate };
      return parseA1111(file, meta, a1111P);
    }
  }
  const data = {
    name: file.name,
    source: meta.source || file.source || null,
    requestType: requestType,
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
    { title: 'モデル / バージョン', value: data.source, isParam: true, subLabel: data.requestType ? formatRequestType(data.requestType) : null }
  ];

  sections.push(
    { title: 'プロンプト', value: data.prompt },
    { title: '除外したい要素', value: data.negativePrompt }
  );

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
    { title: '生成パラメータ (Raw)', value: data.params.rawParameters, isRaw: true }
  );

  return sections;
}

/**
 * ComfyUIのメタデータを解析して標準のデータ構造にマッピングします。
 */
function parseComfyUI(file, meta, p) {
  const nodes = p.nodes || [];
  const links = p.links || [];

  const linkMap = {};
  for (const l of links) {
    if (!l) continue;
    linkMap[l[0]] = l;
  }

  const nodeMap = {};
  for (const n of nodes) {
    nodeMap[n.id] = n;
  }

  const samplers = nodes.filter(n => n.type === 'KSampler' || n.type === 'KSamplerAdvanced');
  const sampler = samplers[0];

  let positivePrompt = '';
  let negativePrompt = '';
  let width = null;
  let height = null;
  let seed = null;
  let steps = null;
  let samplerName = null;
  let cfg = null;
  let modelName = null;

  function traceLink(node, inputName) {
    if (!node || !node.inputs) return null;
    const input = node.inputs.find(i => i.name === inputName);
    if (!input || !input.link) return null;
    const link = linkMap[input.link];
    if (!link) return null;
    return nodeMap[link[1]];
  }

  function extractTextFromNode(node) {
    if (!node) return '';
    if (node.type === 'CLIPTextEncode') {
      return (node.widgets_values && node.widgets_values[0]) ? String(node.widgets_values[0]) : '';
    }
    if (node.type === 'IllustriousPromptBuilder') {
      if (node.widgets_values && node.widgets_values[0]) {
        try {
          const data = JSON.parse(node.widgets_values[0]);
          if (data && Array.isArray(data.rows)) {
            const groups = {};
            for (const row of data.rows) {
              if (row.enabled && row.prompt) {
                const cat = row.category || 'Other';
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(row.prompt.trim());
              }
            }
            let formatted = '';
            for (const cat in groups) {
              formatted += `[${cat}]\n${groups[cat].join('\n')}\n\n`;
            }
            if (formatted) return formatted.trim();
          }
        } catch (e) {
          // ignore parsing error, fallback to flat string
        }
      }
      return (node.widgets_values && node.widgets_values[1]) ? String(node.widgets_values[1]) : '';
    }
    return '';
  }

  if (sampler) {
    if (sampler.widgets_values && sampler.widgets_values.length >= 6) {
      const w = sampler.widgets_values;
      if (typeof w[0] === 'number') seed = w[0];
      for (let i = 1; i < w.length; i++) {
        if (typeof w[i] === 'number' && Number.isInteger(w[i]) && w[i] > 1) {
          steps = w[i];
          if (typeof w[i+1] === 'number') cfg = w[i+1];
          if (typeof w[i+2] === 'string') samplerName = w[i+2];
          if (typeof w[i+3] === 'string') samplerName += ' ' + w[i+3];
          break;
        }
      }
    }

    const posNode = traceLink(sampler, 'positive');
    positivePrompt = extractTextFromNode(posNode);
    
    const negNode = traceLink(sampler, 'negative');
    negativePrompt = extractTextFromNode(negNode);

    let latentNode = traceLink(sampler, 'latent_image');
    if (latentNode && latentNode.type === 'EmptyLatentImage') {
      if (latentNode.widgets_values && latentNode.widgets_values.length >= 2) {
        width = latentNode.widgets_values[0];
        height = latentNode.widgets_values[1];
      }
    }
  }

  if (!width || !height) {
    const latent = nodes.find(n => n.type === 'EmptyLatentImage');
    if (latent && latent.widgets_values) {
      width = latent.widgets_values[0];
      height = latent.widgets_values[1];
    }
  }
  
  if (!positivePrompt && !negativePrompt) {
    const clips = nodes.filter(n => n.type === 'CLIPTextEncode');
    if (clips.length > 0) {
      positivePrompt = clips[0].widgets_values ? clips[0].widgets_values[0] : '';
      if (clips.length > 1) {
        negativePrompt = clips[1].widgets_values ? clips[1].widgets_values[0] : '';
      }
    }
  }

  const w = width || meta.width;
  const h = height || meta.height;
  const res = (w && h) ? `x` : null;

  return {
    name: file.name,
    source: "ComfyUI",
    requestType: null,
    prompt: positivePrompt || '',
    negativePrompt: negativePrompt || '',
    chars: [],
    params: {
      resolution: res,
      seed: seed,
      steps: steps ? formatMetadataNumber(steps) : null,
      sampler: samplerName,
      cfg_rescale: cfg,
      scale: cfg,
      uncond_scale: null,
      rawParameters: JSON.stringify(p, null, 2)
    }
  };
}

/**
 * A1111 / Forge のメタデータを解析して標準のデータ構造にマッピングします。
 */
function parseA1111(file, meta, p) {
  const raw = p.rawParameters || '';
  
  let positivePrompt = '';
  let negativePrompt = '';
  const parsedParams = {};

  // "Steps:" が現れる最後の行を探す
  const lines = raw.split('\n');
  let paramLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('Steps:')) {
      paramLineIndex = i;
      break;
    }
  }

  if (paramLineIndex !== -1) {
    const paramLine = lines[paramLineIndex];
    // パラメータ行をパース (Key: Value形式)
    // 括弧付きの値やカンマが含まれる値もあるため、単純なsplit(',')ではダメな場合があるが、
    // 基本的な抽出は正規表現で行う
    const kvRegex = /([a-zA-Z0-9\s]+):\s*([^,]+(?:,\s*"[^"]+")[^,]*|[^,]+)/g;
    let match;
    while ((match = kvRegex.exec(paramLine)) !== null) {
      const key = match[1].trim();
      const val = match[2].trim();
      parsedParams[key] = val;
    }

    // ネガティブプロンプトとポジティブプロンプトの抽出
    let textBeforeParams = lines.slice(0, paramLineIndex).join('\n').trim();
    
    // "Negative prompt: " で分割
    const negIndex = textBeforeParams.indexOf('Negative prompt:');
    if (negIndex !== -1) {
      positivePrompt = textBeforeParams.substring(0, negIndex).trim();
      negativePrompt = textBeforeParams.substring(negIndex + 'Negative prompt:'.length).trim();
    } else {
      positivePrompt = textBeforeParams;
    }
  }

  let source = "A1111 / Forge";
  if (parsedParams['Model']) {
    source += ` (${parsedParams['Model']})`;
  }

  return {
    name: file.name,
    source: source,
    requestType: null,
    prompt: positivePrompt || '',
    negativePrompt: negativePrompt || '',
    chars: [],
    params: {
      resolution: parsedParams['Size'] || null,
      seed: parsedParams['Seed'] || null,
      steps: parsedParams['Steps'] ? formatMetadataNumber(parsedParams['Steps']) : null,
      sampler: parsedParams['Sampler'] || null,
      cfg_rescale: null,
      scale: parsedParams['CFG scale'] || null,
      uncond_scale: null,
      rawParameters: raw
    }
  };
}
