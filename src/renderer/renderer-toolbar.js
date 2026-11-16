// ============================================================================
// Veloce - Toolbar & Header Controls Controller (renderer-toolbar.js)
// ============================================================================
// 本モジュールは、ツールバー上の各種コントロール（サムネイルサイズ変更スライダー、
// 検索バー入力・IME制御・クリアボタン連携）のイベント処理と状態反映を担当する。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';
import { debounce } from '../common/utils.js';
import { setSetting } from '../common/settings-store.js';

const DEFAULT_SEARCH_DELAY = 300;

/**
 * サムネイルサイズスライダーの値をもとにCSS変数とツールチップを同期更新する
 */
export function updateThumbnailSize() {
  const slider = uiManager?.elements?.thumbnailSizeSlider;
  if (!slider) return;
  const size = parseFloat(slider.value) || 120;
  document.body.style.setProperty('--thumbnail-size', `${size}px`);

  const tooltip = document.getElementById('thumbnail-slider-tooltip');
  if (tooltip && slider) {
    const min = parseFloat(slider.min) || 100;
    const max = parseFloat(slider.max) || 500;
    const percent = (size - min) / (max - min);
    const thumbWidth = 12;
    // thumb is offset by percent across the track width
    const offset = percent * ((slider.offsetWidth || 100) - thumbWidth) + (thumbWidth / 2);
    tooltip.textContent = `${Math.round(size)}px`;
    tooltip.style.left = `${offset}px`;
  }
}

/**
 * サムネイルサイズ変更スライダーのイベントリスナーを設定します。
 * スライダーのドラッグ中、CSS変数更新とツールチップ追従は即座に同期的反映しつつ、
 * 仮想グリッド全体の再計算（updateVirtualGrid）を requestAnimationFrame でスロットリングし、
 * 連続ドラッグ時の描画負荷スパイクとカクつきを防止します。
 * @param {HTMLInputElement} slider - スライダー要素
 * @param {Object} [options={}] - コールバックおよび設定オプション
 * @returns {{ cleanup: () => void, triggerPendingUpdate: () => void }}
 */
export function setupThumbnailSliderEvents(slider, options = {}) {
  if (!slider || typeof slider.addEventListener !== 'function') {
    return { cleanup: () => {}, triggerPendingUpdate: () => {} };
  }

  const onUpdateSize = options.onUpdateSize || updateThumbnailSize;
  const onUpdateGrid = options.onUpdateGrid || (() => {
    if (typeof uiManager?.updateVirtualGrid === 'function') {
      uiManager.updateVirtualGrid(true);
    }
  });
  const onSaveSetting = options.onSaveSetting || ((val) => {
    setSetting('thumbnailScale', val);
  });

  let sliderRafId = null;

  const onInput = () => {
    // 1. CSS変数およびツールチップ位置の更新は即座に同期実行（追従性確保）
    onUpdateSize();

    // 2. 仮想グリッド全体の再計算は rAF でスロットリング（1フレーム1回）
    if (sliderRafId === null) {
      sliderRafId = requestAnimationFrame(() => {
        sliderRafId = null;
        onUpdateGrid();
      });
    }
  };

  const onChange = (e) => {
    // ドラッグ完了時、未処理の rAF があればキャンセルして即時確定
    if (sliderRafId !== null) {
      cancelAnimationFrame(sliderRafId);
      sliderRafId = null;
      onUpdateGrid();
    }
    const val = (e && e.target && e.target.value !== undefined) ? e.target.value : slider.value;
    onSaveSetting(val);
  };

  slider.addEventListener('input', onInput);
  slider.addEventListener('change', onChange);

  return {
    cleanup: () => {
      if (sliderRafId !== null) {
        cancelAnimationFrame(sliderRafId);
        sliderRafId = null;
      }
      slider.removeEventListener('input', onInput);
      slider.removeEventListener('change', onChange);
    },
    triggerPendingUpdate: () => {
      if (sliderRafId !== null) {
        cancelAnimationFrame(sliderRafId);
        sliderRafId = null;
        onUpdateGrid();
      }
    }
  };
}

/**
 * 検索バーのイベントリスナーを設定します。
 * 日本語IME入力（全角/漢字変換）中の未確定文字列による不要な検索トリガーを保留し、
 * 変換確定時（compositionend）または非IME入力のデバウンス完了時にスマートに検索を実行します。
 * @param {HTMLInputElement} searchBar - 検索入力要素
 * @param {Object} [options={}] - コールバックおよび設定オプション
 * @returns {{ isComposing: () => boolean, cleanup: () => void }}
 */
export function setupSearchBarEvents(searchBar, options = {}) {
  if (!searchBar) return { isComposing: () => false, cleanup: () => {} };

  const searchDelay = typeof options.searchDelay === 'number' ? options.searchDelay : DEFAULT_SEARCH_DELAY;
  const onSearch = options.onSearch || ((query) => {
    appState.searchQuery = query;
    if (typeof options.scheduleRefresh === 'function') {
      options.scheduleRefresh(true);
    }
  });
  const updateIndicator = options.updateIndicator || (() => {});
  const clearBtn = options.clearBtn || (uiManager?.elements?.searchClearBtn);

  let isComposing = false;

  const onCompositionStart = () => {
    isComposing = true;
  };

  const onCompositionEnd = (e) => {
    isComposing = false;
    updateIndicator();
    const query = (e.target && typeof e.target.value === 'string') ? e.target.value : searchBar.value;
    onSearch(query);
  };

  const onInputImmediate = () => {
    updateIndicator();
  };

  const debouncedSearch = debounce((e) => {
    // IME変換確定前（未確定のかな入力や変換候補選択中）は検索を保留
    if (isComposing) return;
    const query = (e.target && typeof e.target.value === 'string') ? e.target.value : searchBar.value;
    onSearch(query);
  }, searchDelay);

  const onKeydown = (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      if (clearBtn) {
        clearBtn.click();
      }
      searchBar.blur();
    }
  };

  searchBar.addEventListener('compositionstart', onCompositionStart);
  searchBar.addEventListener('compositionend', onCompositionEnd);
  searchBar.addEventListener('input', onInputImmediate);
  searchBar.addEventListener('input', debouncedSearch);
  searchBar.addEventListener('keydown', onKeydown);

  return {
    isComposing: () => isComposing,
    cleanup: () => {
      searchBar.removeEventListener('compositionstart', onCompositionStart);
      searchBar.removeEventListener('compositionend', onCompositionEnd);
      searchBar.removeEventListener('input', onInputImmediate);
      searchBar.removeEventListener('input', debouncedSearch);
      searchBar.removeEventListener('keydown', onKeydown);
    }
  };
}

