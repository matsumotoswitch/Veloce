/**
 * Veloce - Context Menu Management Module (renderer-context-menu.js)
 * 
 * 責務:
 * 1. コンテキストメニュー（#context-menu）のライフサイクル管理（登録、生成、表示、非表示）
 * 2. 宣言的なメニュー定義（アイテム、セパレータ、サブメニュー、表示条件、有効条件）の管理
 * 3. セパレータ自動正規化（先頭・末尾・連続セパレータの自動除外）
 * 4. DOM Pool パターンによる DOM 要素の再利用と replaceChildren による高速アタッチ
 * 5. 画面境界判定・アニメーション表示（showMenuWithAnimation）
 */

/**
 * メニュー要素を画面境界内に収まるよう座標補正し、アニメーション付きで表示する
 * @param {HTMLElement} menuElement - 表示対象のコンテキストメニューまたはドロップダウン
 * @param {number} startX - クリック位置のX座標
 * @param {number} startY - クリック位置のY座標
 * @param {boolean} [isDropdown=false] - ドロップダウン形式フラグ (右端マージン調整用)
 */
export function showMenuWithAnimation(menuElement, startX, startY, isDropdown = false) {
  if (!menuElement) return;

  // 1. サイズ計算のため、一旦 show クラスを付与（scale(1) の正確な寸法を取得）
  menuElement.classList.add('show');
  const rect = menuElement.getBoundingClientRect();

  let x = startX;
  let y = startY;
  let originX = 'left';
  let originY = 'top';

  // 画面右端・下端のはみ出し防止補正
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - (isDropdown ? 5 : 0);
    originX = 'right';
  }
  if (y + rect.height > window.innerHeight) {
    y = window.innerHeight - rect.height;
    originY = 'bottom';
  }

  // 位置とスケールアニメーションの起点を設定
  menuElement.style.transformOrigin = `${originY} ${originX}`;
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;

  // 2. トランジションを無効化し、初期状態（非表示・縮小）へ同期的にスナップ
  menuElement.style.transition = 'none';
  menuElement.classList.remove('show');

  // 3. ブラウザのスタイル・レイアウト再計算を同期実行させ、初期状態を確定
  void menuElement.offsetWidth;

  // 4. トランジションを復元し、show クラスの再付与でフェード＆スケールインを開始
  menuElement.style.transition = '';
  menuElement.classList.add('show');
}

/**
 * アイコン付きメニュー項目の DOM 要素を生成する
 * @param {string} label - 表示ラベル
 * @param {string} [iconSvg=''] - アイコンSVGマークアップ
 * @param {Function} [onClick=null] - クリック時コールバック
 * @param {boolean} [isDanger=false] - 危険アクションフラグ
 * @param {string} [shortcut=''] - ショートカットキー表示文字列
 * @returns {HTMLDivElement} メニュー項目の要素
 */
export function createMenuItem(label, iconSvg, onClick, isDanger = false, shortcut = '') {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  if (isDanger) item.classList.add('danger');

  item.innerHTML = `
    ${iconSvg || '<div class="menu-icon-placeholder"></div>'}
    <span class="menu-label">${label}</span>
    <span class="menu-shortcut">${shortcut || ''}</span>
    <div></div>
  `;

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = item.closest('#context-menu') || document.getElementById('context-menu');
    if (menu) menu.classList.remove('show');
    if (onClick) onClick(e);
  });
  return item;
}

/**
 * メニューセパレーターの DOM 要素を生成する
 * @returns {HTMLDivElement} セパレーター要素
 */
export function createMenuSeparator() {
  const separator = document.createElement('div');
  separator.className = 'menu-separator';
  return separator;
}

/**
 * コンテキストメニュー項目の配列を正規化する
 * - visible(ctx) が false の項目を除外
 * - 先頭のセパレータを除外
 * - 連続するセパレータを1つに統合
 * - 末尾のセパレータを除外
 * 
 * @param {Array<Object>} items - 項目定義配列
 * @param {Object} [ctx={}] - 評価コンテキスト
 * @returns {Array<Object>} 正規化された項目定義配列
 */
export function normalizeMenuItems(items, ctx = {}) {
  if (!Array.isArray(items)) return [];

  // 1. visible 条件を評価して表示候補を抽出
  const candidateItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.type === 'separator') {
      candidateItems.push(item);
    } else {
      const isVisible = typeof item.visible === 'function' ? item.visible(ctx) : (item.visible !== false);
      if (isVisible) {
        candidateItems.push(item);
      }
    }
  }

  // 2. セパレータの連続・先頭・末尾の除外
  const normalized = [];
  let prevWasSeparator = true; // 先頭のセパレータを弾くため初期値を true とする

  for (let i = 0; i < candidateItems.length; i++) {
    const item = candidateItems[i];
    if (item.type === 'separator') {
      if (!prevWasSeparator) {
        normalized.push(item);
        prevWasSeparator = true;
      }
    } else {
      normalized.push(item);
      prevWasSeparator = false;
    }
  }

  // 末尾がセパレータの場合は除外
  if (normalized.length > 0 && normalized[normalized.length - 1].type === 'separator') {
    normalized.pop();
  }

  return normalized;
}

/**
 * 宣言的コンテキストメニュー管理マネージャ
 */
export class ContextMenuManager {
  /**
   * @param {HTMLElement} [menuElement=null] - コンテキストメニューのコンテナ要素
   */
  constructor(menuElement = null) {
    this.menuElement = menuElement || document.getElementById('context-menu');
    if (!this.menuElement) {
      this.menuElement = document.createElement('div');
      this.menuElement.id = 'context-menu';
      document.body.appendChild(this.menuElement);
    }

    /** @type {Map<string, Array<Object>>} コンテキスト種別ごとの項目定義 */
    this.definitions = new Map();

    /** @type {Map<string, HTMLElement>} IDベースのDOM Pool */
    this.itemPool = new Map();

    /** @type {Array<HTMLElement>} セパレータのDOM Pool */
    this.separatorPool = [];

    /** @type {Object|null} 現在開いているメニューのコンテキストデータ */
    this.activeContext = null;
  }

  /**
   * コンテキストメニュー定義を登録する
   * @param {string} type - コンテキスト種別キー（例: 'folder-tree', 'thumbnail-item' 等）
   * @param {Array<Object>} items - 項目定義配列
   */
  register(type, items) {
    this.definitions.set(type, items);
  }

  /**
   * IDに対応するアイテム要素をプールから取得、または生成する
   * @param {Object} item - 項目定義
   * @returns {HTMLElement}
   */
  getItemElement(item) {
    if (item.element) {
      return item.element;
    }

    if (!item.id) {
      // ID未指定の場合は都度生成
      return createMenuItem(
        item.label,
        item.icon,
        () => { if (typeof item.action === 'function') item.action(this.activeContext); },
        item.danger,
        item.shortcut
      );
    }

    let el = this.itemPool.get(item.id);
    if (!el) {
      el = createMenuItem(
        item.label,
        item.icon,
        () => {
          if (typeof item.action === 'function') {
            item.action(this.activeContext);
          }
        },
        item.danger,
        item.shortcut
      );
      this.itemPool.set(item.id, el);
    }
    return el;
  }

  /**
   * セパレータ要素をプールから取得する（必要に応じてプール拡張）
   * @param {number} index - 使用インデックス
   * @returns {HTMLElement}
   */
  getSeparatorElement(index) {
    while (this.separatorPool.length <= index) {
      this.separatorPool.push(createMenuSeparator());
    }
    return this.separatorPool[index];
  }

  /**
   * コンテキストメニューを宣言的定義に基づいて構築・表示する
   * @param {string} type - 登録されたコンテキスト種別キー
   * @param {Object} [ctx={}] - 状態・ターゲットデータ
   * @param {number} clientX - 表示基準X座標
   * @param {number} clientY - 表示基準Y座標
   */
  show(type, ctx = {}, clientX = 0, clientY = 0) {
    const items = this.definitions.get(type);
    if (!items || items.length === 0) return;

    this.activeContext = ctx;

    // 互換性のため menuElement 自体にコンテキストプロパティを反映
    Object.assign(this.menuElement, {
      targetFolder: null,
      targetFolderElement: null,
      targetTabIndex: undefined,
      targetFavoriteId: null,
      targetFavoritePath: null,
      targetSmartFolderId: null,
      isRoot: false,
      ...ctx
    });

    // 1. セパレータと可視性の正規化
    const normalizedItems = normalizeMenuItems(items, ctx);
    if (normalizedItems.length === 0) {
      this.hide();
      return;
    }

    // 2. DOM Pool から要素を取得し、enabled 状態・フックを適用
    const elementsToAppend = [];
    let separatorCount = 0;

    for (let i = 0; i < normalizedItems.length; i++) {
      const itemDef = normalizedItems[i];

      if (itemDef.type === 'separator') {
        const sepEl = this.getSeparatorElement(separatorCount++);
        elementsToAppend.push(sepEl);
      } else {
        const el = this.getItemElement(itemDef);

        // enabled 状態（有効/無効）の適用
        const isEnabled = typeof itemDef.enabled === 'function' ? itemDef.enabled(ctx) : (itemDef.enabled !== false);
        if (isEnabled) {
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
          el.disabled = false;
          el.classList.remove('disabled');
        } else {
          el.style.opacity = '0.5';
          el.style.pointerEvents = 'none';
          el.disabled = true;
          el.classList.add('disabled');
        }

        // 表示直前フック（サブメニューの更新や動的ラベル変更用）
        if (typeof itemDef.beforeShow === 'function') {
          itemDef.beforeShow(el, ctx);
        }

        elementsToAppend.push(el);
      }
    }

    // 3. DOM の一括高速更新 (replaceChildren)
    this.menuElement.replaceChildren(...elementsToAppend);

    // 4. アニメーション表示
    showMenuWithAnimation(this.menuElement, clientX, clientY);
  }

  /**
   * コンテキストメニューを非表示にする
   */
  hide() {
    this.menuElement.classList.remove('show');
    this.activeContext = null;
  }
}
