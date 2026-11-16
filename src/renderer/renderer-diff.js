// ============================================================================
// Veloce - Metadata Diff Modal Controller (renderer-diff.js)
// ============================================================================
// 本モジュールは、2つの画像/メディアファイルのメタデータ（Prompt, Negative Prompt,
// パラメータ、キャラクター位置情報など）の差分比較モーダル表示を担当する。
// ============================================================================

import { escapeHtml, isAudioFile, getAudioCoverUrl, AUDIO_PLACEHOLDER_URL } from '../common/utils.js';
import { extractMetadataFields, parsePromptTags, formatRequestType } from '../common/metadata-format.js';
import { UIManager, uiManager } from './renderer-ui.js';

/**
 * 2つの画像/メディアファイルのメタデータ差分比較モーダルを表示します。
 * @param {Object} file1 1つ目のファイル情報
 * @param {Object} file2 2つ目のファイル情報
 * @param {Object} [meta1={}] 1つ目のメタデータ
 * @param {Object} [meta2={}] 2つ目のメタデータ
 * @param {UIManager} [uiInstance=null] UIManagerインスタンス
 */
export function showDiffModal(file1, file2, meta1 = {}, meta2 = {}, uiInstance = null) {
  const ui = uiInstance || this || uiManager;
  const modal = document.getElementById('diff-modal');
  const container = document.getElementById('diff-container');
  if (!modal || !container) return;

  const parse = parsePromptTags;

  const d1 = extractMetadataFields(file1, meta1);
  const d2 = extractMetadataFields(file2, meta2);

  const renderSideBySideSection = (title, text1, text2, isParam = false, subLabel1 = null, subLabel2 = null) => {
    const v1 = text1 ?? '-';
    const v2 = text2 ?? '-';
    if (v1 === '-' && v2 === '-') return ''; 

    const tags1 = isParam ? [String(v1)] : parse(String(v1));
    const tags2 = isParam ? [String(v2)] : parse(String(v2));
    const set1 = new Set(tags1);
    const set2 = new Set(tags2);

    // 単純な文字列比較ではなく、パース・整理されたタグ配列の中身で比較する
    // これにより「末尾のスペース」や「余分なカンマ」だけの違いを無視できます
    const hasDiff = tags1.join(',') !== tags2.join(',');
    const titleClass = hasDiff ? 'has-diff' : '';

    const renderTags = (tags, otherSet, mode) => {
      if (tags.length === 0 || tags[0] === '-') return '<span class="diff-tag-empty">なし</span>';
      return tags.map(t => {
        let className = 'common';
        if (mode === 'left' && !otherSet.has(t)) className = 'removed';
        if (mode === 'right' && !otherSet.has(t)) className = 'added';
        return `<span class="diff-tag ${className}">${escapeHtml(t)}</span>`;
      }).join('');
    };

    const boxClass = isParam ? "prompt-look param-box" : "prompt-look";

    const isCopyable = title === 'プロンプト' ||
                       title === '除外したい要素' ||
                       title.endsWith('プロンプト') ||
                       title.endsWith('除外したい要素');
    const copyBtn1Html = isCopyable && v1 !== '-' ? UIManager.createCopyButtonHTML(v1) : '';
    const copyBtn2Html = isCopyable && v2 !== '-' ? UIManager.createCopyButtonHTML(v2) : '';

    let body1Html = '';
    let body2Html = '';

    if (isParam) {
      const renderParamText = (val, mode) => {
        if (val === '-') return '<span class="diff-tag-empty">なし</span>';
        if (!hasDiff) return `<span class="diff-param-text">${escapeHtml(val)}</span>`;
        const diffClass = mode === 'left' ? 'removed' : 'added';
        return `<span class="diff-param-text ${diffClass}">${escapeHtml(val)}</span>`;
      };
      body1Html = renderParamText(v1, 'left');
      body2Html = renderParamText(v2, 'right');
    } else {
      body1Html = renderTags(tags1, set2, 'left');
      body2Html = renderTags(tags2, set1, 'right');
    }

    const getSubLabelHtml = (sub) => {
      if (!sub || sub === 'Text to Image') return '';
      const labels = sub.split(' + ');
      const spans = labels.map(lbl => {
        let modifier = '';
        if (lbl.includes('Inpainting')) {
          modifier = ' sublabel-tag--inpainting';
        } else if (lbl.includes('Vibe Transfer')) {
          modifier = ' sublabel-tag--vibe';
        } else if (lbl.includes('Character Reference')) {
          modifier = ' sublabel-tag--char-ref';
        } else if (lbl.includes('Image to Image') || lbl.includes('Img2Img')) {
          modifier = ' sublabel-tag--img2img';
        } else if (lbl === 'Alpha Channel') {
          modifier = ' sublabel-tag--alpha-channel';
        } else {
          modifier = ' sublabel-tag--muted';
        }
        return `<span class="sublabel-tag${modifier}">[${escapeHtml(lbl)}]</span>`;
      });
      return `<span class="sublabel-tags-wrapper">${spans.join('')}</span>`;
    };

    let sub1Html = getSubLabelHtml(subLabel1);
    let sub2Html = getSubLabelHtml(subLabel2);

    return `
      <div class="diff-columns">
        <div class="diff-column">
          <div class="diff-section">
            <h3 class="${titleClass}">
              <span>
                <span>${title}</span>
                ${sub1Html}
              </span>
              ${copyBtn1Html}
            </h3>
            <div class="${boxClass}">${body1Html}</div>
          </div>
        </div>
        <div class="diff-column">
          <div class="diff-section">
            <h3 class="${titleClass}">
              <span>
                <span>${title}</span>
                ${sub2Html}
              </span>
              ${copyBtn2Html}
            </h3>
            <div class="${boxClass}">${body2Html}</div>
          </div>
        </div>
      </div>
    `;
  };

  let contentHtml = '';
  contentHtml += renderSideBySideSection(
    'モデル / バージョン', 
    d1.source, 
    d2.source, 
    true,
    d1.requestType ? formatRequestType(d1.requestType) : null,
    d2.requestType ? formatRequestType(d2.requestType) : null
  );
  
  contentHtml += renderSideBySideSection('プロンプト', d1.prompt, d2.prompt);
  if (d1.adoptedPrompt || d2.adoptedPrompt) {
    contentHtml += renderSideBySideSection('採用プロンプト', d1.adoptedPrompt, d2.adoptedPrompt);
  }
  contentHtml += renderSideBySideSection('除外したい要素', d1.negativePrompt, d2.negativePrompt);
  if (d1.adoptedNegativePrompt || d2.adoptedNegativePrompt) {
    contentHtml += renderSideBySideSection('採用除外したい要素', d1.adoptedNegativePrompt, d2.adoptedNegativePrompt);
  }

  const maxChars = Math.max(d1.chars.length, d2.chars.length);
  for (let i = 0; i < maxChars; i++) {
    const c1 = d1.chars[i] || { prompt: '', uc: '' };
    const c2 = d2.chars[i] || { prompt: '', uc: '' };
    contentHtml += renderSideBySideSection(`キャラクター ${i + 1} プロンプト`, c1.prompt, c2.prompt);
    if (c1.adoptedPrompt || c2.adoptedPrompt) {
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} 採用プロンプト`, c1.adoptedPrompt, c2.adoptedPrompt);
    }
    contentHtml += renderSideBySideSection(`キャラクター ${i + 1} 除外したい要素`, c1.uc, c2.uc);
    if (c1.adoptedUc || c2.adoptedUc) {
      contentHtml += renderSideBySideSection(`キャラクター ${i + 1} 採用除外したい要素`, c1.adoptedUc, c2.adoptedUc);
    }
  }

  contentHtml += renderSideBySideSection('画像サイズ', d1.params.resolution, d2.params.resolution, true);
  contentHtml += renderSideBySideSection('シード値', d1.params.seed, d2.params.seed, true);
  contentHtml += renderSideBySideSection('ステップ', d1.params.steps, d2.params.steps, true);
  contentHtml += renderSideBySideSection('サンプラー', d1.params.sampler, d2.params.sampler, true);
  contentHtml += renderSideBySideSection('プロンプトガイダンス', d1.params.scale, d2.params.scale, true);
  contentHtml += renderSideBySideSection('プロンプトガイダンスの再調整', d1.params.cfg_rescale, d2.params.cfg_rescale, true);
  contentHtml += renderSideBySideSection('除外したい要素の強さ', d1.params.uncond_scale, d2.params.uncond_scale, true);
  contentHtml += renderSideBySideSection('生成パラメータ (Raw)', d1.params.rawParameters, d2.params.rawParameters);

  const src1 = window.veloceAPI.convertFileSrc(file1.path);
  const src2 = window.veloceAPI.convertFileSrc(file2.path);

  // キャラクター位置指定データが存在する場合、「位置」セクションを末尾に追加
  const hasPositions1 = !!(d1.charPositions && d1.charPositions.length > 0);
  const hasPositions2 = !!(d2.charPositions && d2.charPositions.length > 0);

  if (hasPositions1 || hasPositions2) {
    const renderPositionBlock = (d, src) => {
      if (!d.charPositions || d.charPositions.length === 0) {
        return {
          html: '<div class="prompt-look param-box"><span class="diff-tag-empty">なし</span></div>',
          copyText: '-'
        };
      }

      const isAuto = d.useCoords === false;
      const modeText = isAuto ? 'AIにおまかせ' : 'カスタム';
      const modeModifier = isAuto ? 'inspector-position-mode--auto' : 'inspector-position-mode--custom';

      // 「AIにおまかせ」の場合はその旨のみ表示し、画像や座標情報は表示しない
      if (isAuto) {
        const blockHtml = `
          <div class="prompt-look inspector-position-block">
            <div class="inspector-position-mode-row">
              <span class="inspector-position-mode-text ${modeModifier}">${modeText}</span>
            </div>
          </div>
        `;
        return {
          html: blockHtml,
          copyText: `モード: ${modeText}`
        };
      }

      const imgWidth = d.width;
      const imgHeight = d.height;
      const aspectAttr = (imgWidth && imgHeight) ? `data-aspect-ratio="${imgWidth} / ${imgHeight}"` : '';

      let markersHtml = '';
      let coordsHtml = '';
      const copyLines = [`モード: ${modeText}`];

      d.charPositions.forEach(cp => {
        const charNum = cp.index;
        const markerIndex = ((charNum - 1) % 8) + 1;
        const colorClass = `char-marker-${markerIndex}`;

        cp.centers.forEach(center => {
          const leftPct = (center.x * 100).toFixed(2);
          const topPct = (center.y * 100).toFixed(2);
          markersHtml += `<div class="inspector-position-marker ${colorClass}" data-x="${leftPct}" data-y="${topPct}">${charNum}</div>`;

          const xPct = (center.x * 100).toFixed(1);
          const yPct = (center.y * 100).toFixed(1);
          coordsHtml += `
            <div class="inspector-coord-item">
              <span class="inspector-coord-badge ${colorClass}">${charNum}</span>
              <span class="inspector-coord-text">X: ${xPct}%, Y: ${yPct}% (${center.x.toFixed(3)}, ${center.y.toFixed(3)})</span>
            </div>
          `;

          copyLines.push(`キャラ ${charNum}: X: ${center.x.toFixed(3)}, Y: ${center.y.toFixed(3)} (${xPct}%, ${yPct}%)`);
        });
      });

      const blockHtml = `
        <div class="prompt-look inspector-position-block">
          <div class="inspector-position-mode-row">
            <span class="inspector-position-mode-text ${modeModifier}">${modeText}</span>
          </div>
          <div class="inspector-position-map-wrapper">
            <div class="inspector-position-map" ${aspectAttr}>
              <img src="${src}" class="inspector-position-bg-img" decoding="async">
              ${markersHtml}
            </div>
          </div>
          <div class="inspector-position-coords">
            ${coordsHtml}
          </div>
        </div>
      `;

      return {
        html: blockHtml,
        copyText: copyLines.join('\n')
      };
    };

    let hasDiff = false;
    if (hasPositions1 !== hasPositions2) {
      hasDiff = true;
    } else {
      const mode1 = d1.useCoords === false ? 'AIにおまかせ' : 'カスタム';
      const mode2 = d2.useCoords === false ? 'AIにおまかせ' : 'カスタム';
      if (mode1 !== mode2) {
        hasDiff = true;
      } else if (d1.useCoords !== false) {
        // 両方とも「カスタム」の場合のみ座標の差分を比較
        const normalizePositions = (positions) => {
          return positions.map(cp => ({
            index: cp.index,
            centers: cp.centers.map(c => ({
              x: Number(c.x.toFixed(4)),
              y: Number(c.y.toFixed(4))
            }))
          }));
        };
        if (JSON.stringify(normalizePositions(d1.charPositions)) !== JSON.stringify(normalizePositions(d2.charPositions))) {
          hasDiff = true;
        }
      }
    }

    const titleClass = hasDiff ? 'has-diff' : '';
    const block1 = renderPositionBlock(d1, src1);
    const block2 = renderPositionBlock(d2, src2);

    contentHtml += `
      <div class="diff-columns">
        <div class="diff-column">
          <div class="diff-section">
            <h3 class="${titleClass}">
              <span>位置</span>
            </h3>
            ${block1.html}
          </div>
        </div>
        <div class="diff-column">
          <div class="diff-section">
            <h3 class="${titleClass}">
              <span>位置</span>
            </h3>
            ${block2.html}
          </div>
        </div>
      </div>
    `;
  }

  const getMediaHtml = (path, src) => {
    if (path.toLowerCase().endsWith('.mp4')) {
      return `<video src="${src}" class="diff-thumbnail" autoplay loop muted playsinline></video>`;
    }
    if (isAudioFile(path)) {
      const coverSrc = getAudioCoverUrl(path) || AUDIO_PLACEHOLDER_URL;
      return `<img src="${coverSrc}" class="diff-thumbnail" decoding="async" onerror="this.src='${AUDIO_PLACEHOLDER_URL}'">`;
    }
    return `<img src="${src}" class="diff-thumbnail" decoding="async">`;
  };

  const headerHtml = `
    <div class="diff-pane-container">
      <div class="diff-pane-col">
        <div class="diff-thumbnail-container diff-thumbnail-box">
          ${getMediaHtml(file1.path, src1)}
        </div>
      </div>
      <div class="diff-pane-col">
        <div class="diff-thumbnail-container diff-thumbnail-box">
          ${getMediaHtml(file2.path, src2)}
        </div>
      </div>
    </div>
  `;

  container.innerHTML = headerHtml + contentHtml;

  // 位置情報マーカーとアスペクト比をDOMプロパティとして設定（HTMLインラインスタイル属性を排除）
  container.querySelectorAll('.inspector-position-map[data-aspect-ratio]').forEach(map => {
    const ar = map.getAttribute('data-aspect-ratio');
    if (ar) map.style.aspectRatio = ar;
  });
  container.querySelectorAll('.inspector-position-marker[data-x]').forEach(marker => {
    const x = marker.getAttribute('data-x');
    const y = marker.getAttribute('data-y');
    if (x) marker.style.left = `${x}%`;
    if (y) marker.style.top = `${y}%`;
  });

  container.querySelectorAll('.diff-copy-btn').forEach(btn => {
    if (ui && typeof ui.bindTooltip === 'function') {
      ui.bindTooltip(btn, 'コピー');
    }
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      const text = target.getAttribute('data-copy-text');
      if (text && text !== '-') {
        try {
          await navigator.clipboard.writeText(text);
          if (ui && typeof ui.showToast === 'function') {
            ui.showToast("クリップボードにコピーしました", 3000, null, 'success');
          }
          if (ui && typeof ui.applyGlowEffect === 'function') {
            ui.applyGlowEffect(target);
          }
          if (ui && typeof ui.hideCustomTooltip === 'function') {
            ui.hideCustomTooltip();
          }
        } catch (err) {}
      }
    });
  });

  /**
   * Diff画面のドラッグ選択コピー時のフォーマット調整:
   * タグ単位で視覚的に分割されているテキストを選択してコピーする際、
   * クリップボードには自動的にカンマ区切りの文字列として格納します。
   * これによりプロンプトとしての再利用性を確保します。
   */
  container.querySelectorAll('.prompt-look').forEach(lookDiv => {
    lookDiv.addEventListener('copy', (e) => {
      const selection = window.getSelection();
      if (selection.isCollapsed) return;

      const clone = selection.getRangeAt(0).cloneContents();
      const tempDiv = document.createElement('div');
      tempDiv.appendChild(clone);

      const tags = tempDiv.querySelectorAll('.diff-tag');
      tags.forEach(tag => {
        tag.textContent = tag.textContent + ", ";
      });

      let copiedText = tempDiv.textContent;
      copiedText = copiedText.replace(/,\s*$/, '').trim();

      e.clipboardData.setData('text/plain', copiedText);
      e.preventDefault();
    });
  });

  modal.classList.add('show');

  // モーダルが表示されてレイアウトが計算された後にスクロールをリセットする
  requestAnimationFrame(() => {
    if (container.parentElement) {
      container.parentElement.scrollTop = 0;
    }
    container.scrollTop = 0;
    
    const diffModal = document.getElementById('diff-modal');
    if (diffModal) diffModal.scrollTop = 0;
  });
}

