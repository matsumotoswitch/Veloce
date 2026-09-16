/**
 * @typedef {Object} ImageFile
 * @property {string} name - ファイル名
 * @property {string} ext - 拡張子
 * @property {string} path - フルパス
 * @property {number} size - ファイルサイズ(bytes)
 * @property {number} mtime - 最終更新日時
 * @property {number} [ctime] - 作成日時
 * @property {number} [width] - 画像の幅
 * @property {number} [height] - 画像の高さ
 * @property {string} [prompt] - 生成プロンプト
 * @property {string} [negativePrompt] - ネガティブプロンプト
 * @property {string} [source] - 生成元モデル
 * @property {Array<string|Object>} [charPrompts] - キャラクタープロンプト
 * @property {boolean} [metaLoaded] - メタデータが読み込み済みかどうか
 * @property {boolean} [hasThumbnailCache] - サムネイルキャッシュが存在するかどうか
 * @property {boolean} [hasMetadataCache] - メタデータキャッシュが存在するかどうか
 */

const DEFAULT_SMART_FOLDERS = [
  { id: 'fav_5', name: 'お気に入り (星5)', icon: 'FAV_STAR', color: 'orange', matchType: 'all', conditions: [{ type: 'rating', operator: '>=', value: '5' }] },
  { id: 'fav_4_plus', name: '高評価 (星4以上)', icon: 'FAV_STAR', color: 'yellow', matchType: 'all', conditions: [{ type: 'rating', operator: '>=', value: '4' }] }
];

export const SmartFolderStore = {
  _cache: null,
  _storageKey: 'smartFolders',

  load() {
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(this._storageKey);
      this._cache = raw ? JSON.parse(raw) : DEFAULT_SMART_FOLDERS;
    } catch (e) {
      console.error("Smart Folder Parse Error:", e);
      this._cache = DEFAULT_SMART_FOLDERS;
    }
    if (!localStorage.getItem(this._storageKey)) {
      localStorage.setItem(this._storageKey, JSON.stringify(this._cache));
    }
    return this._cache;
  },

  async save(foldersArray) {
    this._cache = foldersArray;
    localStorage.setItem(this._storageKey, JSON.stringify(foldersArray));
    try {
      if (window.veloceAPI && window.veloceAPI.updateSmartFolders) {
        await window.veloceAPI.updateSmartFolders(foldersArray);
      }
    } catch (e) {
      console.error("Rust Sync Failed:", e);
    }
  },

  async upsertFolder(newFolder) {
    const folders = this.load();
    const index = folders.findIndex(f => f.id === newFolder.id);
    if (index >= 0) {
      folders[index] = newFolder;
    } else {
      folders.push(newFolder);
    }
    await this.save(folders);
    return folders;
  },

  async deleteFolder(id) {
    let folders = this.load();
    folders = folders.filter(f => f.id !== id);
    await this.save(folders);
    return folders;
  }
};

/**
 * ドラッグ＆ドロップ操作の局所状態
 */
export const dndState = {
  paths: [],
  indices: [],
  cachedRoot: null,
  isAppDragging: false,
  pendingRefresh: false,
  reset() {
    this.paths = [];
    this.indices = [];
    this.cachedRoot = null;
    this.isAppDragging = false;
  }
};

/**
 * ファイル操作および Undo スタックの局所状態
 */
export const fileOpsState = {
  undoStack: [],
  push(action) {
    this.undoStack.push(action);
  },
  pop() {
    return this.undoStack.pop();
  },
  clear() {
    this.undoStack.length = 0;
  }
};

/**
 * ウィンドウペイン分割およびレイアウト設定の局所状態
 */
export const layoutState = {
  leftWidth: 200,             // 左ペインの幅(px)
  rightWidth: 300,            // 右ペインの幅(px)
  leftVisible: true,          // 左ペインの表示状態
  rightVisible: true,         // 右ペインの表示状態
  leftTopHeight: parseInt(localStorage.getItem('leftTopHeight') || '150', 10),
  leftTopVisible: localStorage.getItem('leftTopVisible') !== 'false',
  rightTopHeight: parseInt(localStorage.getItem('rightTopHeight') || '200', 10),
  rightTopVisible: localStorage.getItem('rightTopVisible') !== 'false'
};

/**
 * サムネイル生成キュー・進捗・URLキャッシュの局所状態
 */
export const thumbnailState = {
  urls: new Map(),
  visiblePathSet: new Set(),
  preloadCursor: 0,
  isPreloadRunning: false,
  isFetchingPreload: false,
  currentMetaBatchId: 0,
  currentRenderId: 0,
  progress: {
    totalRequested: 0,
    completed: 0,
    counted: new Set(),
    toastTimeout: null,
    lastToastTime: 0
  },
  metadataProgress: {
    targetCount: 0,
    completed: 0
  },
  resetProgress() {
    this.progress.totalRequested = 0;
    this.progress.completed = 0;
    this.progress.counted.clear();
    if (this.progress.toastTimeout) {
      clearTimeout(this.progress.toastTimeout);
      this.progress.toastTimeout = null;
    }
    this.progress.lastToastTime = 0;
  }
};

/**
 * メイン画面のアプリケーション全体の状態とデータを管理するクラス
 */
class AppState {
  constructor() {
    /** @type {number} Rust側のフィルタリング済みファイルの総件数 */
    this.totalCount = 0;

    /** @type {{key: string, asc: boolean}} 現在のソート設定 */
    this.sortConfig = { key: 'name', asc: true };
    /** @type {string} 検索クエリ文字列 */
    this.searchQuery = '';
    /** @type {number} 現在アクティブな選択アイテムのインデックス */
    this.selectedIndex = -1;
    /** @type {'grid' | 'table'} 現在アクティブな中央ペイン ('grid' | 'table') */
    this.activeCenterPane = 'grid';
    /** @type {Set<number>} 複数選択されているアイテムのインデックス集合 */
    this.selection = new Set();
    /** @type {string} 現在表示中のディレクトリパス */
    this.currentDirectory = '';
    /** @type {Array<{id: string, name: string, path: string, icon: string}>} お気に入りリスト */
    this.favorites = JSON.parse(localStorage.getItem('favorites') || '[]');

    /** @type {Array<{id: string, name: string, icon: string, color: string, matchType: string, conditions: Array<any>}>} スマートフォルダリスト */
    this.smartFolders = SmartFolderStore.load();
    
    /** @type {Object<string, number>} レーティング一覧 (path -> rating) */
    this.ratings = {};
    this.ratingFilterVal = 0;
    this.ratingFilterOp = 'gte';

    // 履歴管理
    this.isNavigatingHistory = false; // 履歴操作による遷移中のフラグ
  }

  // --- 後方互換性ファサード (Subdomain Proxies) ---

  // 1. D&D 状態プロキシ
  get dragState() {
    return dndState;
  }
  set dragState(val) {
    if (val && typeof val === 'object') {
      dndState.paths = val.paths || [];
      dndState.indices = val.indices || [];
      dndState.cachedRoot = val.cachedRoot !== undefined ? val.cachedRoot : null;
      dndState.isAppDragging = !!val.isAppDragging;
      dndState.pendingRefresh = !!val.pendingRefresh;
    }
  }

  // 2. ファイル操作・Undoスタックプロキシ
  get undoStack() {
    return fileOpsState.undoStack;
  }
  set undoStack(val) {
    fileOpsState.undoStack = Array.isArray(val) ? val : [];
  }

  // 3. レイアウト状態プロキシ
  get layout() {
    return layoutState;
  }
  set layout(val) {
    if (val && typeof val === 'object') {
      Object.assign(layoutState, val);
    }
  }

  // 4. サムネイル・パイプライン進捗プロキシ
  get thumbnailUrls() { return thumbnailState.urls; }
  set thumbnailUrls(val) { thumbnailState.urls = val; }

  get visiblePathSet() { return thumbnailState.visiblePathSet; }
  set visiblePathSet(val) { thumbnailState.visiblePathSet = val; }

  get preloadCursor() { return thumbnailState.preloadCursor; }
  set preloadCursor(val) { thumbnailState.preloadCursor = val; }

  get isPreloadRunning() { return thumbnailState.isPreloadRunning; }
  set isPreloadRunning(val) { thumbnailState.isPreloadRunning = val; }

  get isFetchingPreload() { return thumbnailState.isFetchingPreload; }
  set isFetchingPreload(val) { thumbnailState.isFetchingPreload = val; }

  get currentMetaBatchId() { return thumbnailState.currentMetaBatchId; }
  set currentMetaBatchId(val) { thumbnailState.currentMetaBatchId = val; }

  get currentRenderId() { return thumbnailState.currentRenderId; }
  set currentRenderId(val) { thumbnailState.currentRenderId = val; }

  get thumbnailTotalRequested() { return thumbnailState.progress.totalRequested; }
  set thumbnailTotalRequested(val) { thumbnailState.progress.totalRequested = val; }

  get thumbnailCompleted() { return thumbnailState.progress.completed; }
  set thumbnailCompleted(val) { thumbnailState.progress.completed = val; }

  get thumbnailToastTimeout() { return thumbnailState.progress.toastTimeout; }
  set thumbnailToastTimeout(val) { thumbnailState.progress.toastTimeout = val; }

  get thumbnailCounted() { return thumbnailState.progress.counted; }
  set thumbnailCounted(val) { thumbnailState.progress.counted = val; }

  get lastThumbnailToastTime() { return thumbnailState.progress.lastToastTime; }
  set lastThumbnailToastTime(val) { thumbnailState.progress.lastToastTime = val; }

  get metadataTargetCount() { return thumbnailState.metadataProgress.targetCount; }
  set metadataTargetCount(val) { thumbnailState.metadataProgress.targetCount = val; }

  get metadataCompleted() { return thumbnailState.metadataProgress.completed; }
  set metadataCompleted(val) { thumbnailState.metadataProgress.completed = val; }

  /**
   * Rust側のSource of Truthにソート・検索条件を送信し、フィルタリング後の件数を取得します。
   * @returns {Promise<number>} フィルタリング後の件数
   */
  async setViewParams() {
    if (window.veloceAPI && window.veloceAPI.setViewParams) {
      try {
        const totalCount = await window.veloceAPI.setViewParams(
          this.sortConfig.key, this.sortConfig.asc, this.searchQuery,
          this.ratingFilterVal, this.ratingFilterOp
        );
        this.totalCount = totalCount;
      } catch (err) {
        console.error('Failed to set view params:', err);
      }
    }
    return this.totalCount;
  }

  getActiveTab() {
    return this.tabs && this.tabs[this.activeTabIndex];
  }

  pushHistory(path) {
    const tab = this.getActiveTab();
    if (!tab || this.isNavigatingHistory) return;
    if (!tab.history) {
      tab.history = [path];
      tab.historyIndex = 0;
      return;
    }
    if (tab.history[tab.historyIndex] === path) return;
    // 現在のインデックスより先の履歴（進む履歴）を破棄
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(path);
    tab.historyIndex++;
  }
}

export const appState = new AppState();