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

/**
 * メイン画面のアプリケーション全体の状態とデータを管理するクラス
 */
class AppState {
  constructor() {
    /** @type {number} Rust側のフィルタリング済みファイルの総件数 */
    this.totalCount = 0;
    /** @type {string[]} Rust側のフィルタリング済みファイルのパス一覧 */
    this.currentPaths = [];
    /** @type {{key: string, asc: boolean}} 現在のソート設定 */
    this.sortConfig = { key: 'name', asc: true };
    /** @type {string} 検索クエリ文字列 */
    this.searchQuery = '';
    /** @type {number} 現在アクティブな選択アイテムのインデックス */
    this.selectedIndex = -1;
    /** @type {Set<number>} 複数選択されているアイテムのインデックス集合 */
    this.selection = new Set();
    /** @type {string} 現在表示中のディレクトリパス */
    this.currentDirectory = '';
    /** @type {Array<{id: string, name: string, path: string, icon: string}>} お気に入りリスト */
    this.favorites = JSON.parse(localStorage.getItem('favorites') || '[]');

    // レイアウト状態の管理
    this.layout = {
      leftWidth: 200,             // 左ペインの幅(px)
      rightWidth: 300,            // 右ペインの幅(px)
      leftVisible: true,          // 左ペインの表示状態
      rightVisible: true,         // 右ペインの表示状態
      leftTopHeight: parseInt(localStorage.getItem('leftTopHeight') || '150', 10),
      leftTopVisible: localStorage.getItem('leftTopVisible') !== 'false',
      rightTopHeight: parseInt(localStorage.getItem('rightTopHeight') || '200', 10),
      rightTopVisible: localStorage.getItem('rightTopVisible') !== 'false'
    };

    // ドラッグ状態の管理
    this.dragState = {
      paths: [],                  // ドラッグ中のファイルパスのリスト
      isAppDragging: false,       // アプリ内からのドラッグかどうか
      pendingRefresh: false       // ドラッグ終了後にリスト更新が必要かどうか
    };

    // システム状態・サムネイル管理
    this.currentMetaBatchId = 0;     // メタデータ一括読み込みのバッチID（非同期キャンセル用）
    this.currentMetaRequestId = 0;   // メタデータ個別読み込みのリクエストID
    this.currentRenderId = 0;        // リスト描画のリクエストID
    this.thumbnailUrls = new Map();  // サムネイル画像のURLキャッシュ（パス -> URL）
    this.pendingThumbnails = new Set(); // サムネイル取得待ちのファイルパス集合
    this.activeThumbnailTasks = 0;   // 現在実行中のサムネイル取得タスク数
    this.thumbnailRequestQueue = []; // サムネイル取得リクエストのキュー
    this.preloadCursor = 0;          // バックグラウンドプリロードの現在のインデックス
    this.isPreloadRunning = false;   // プリロード処理が実行中かどうか

    // トースト通知状態管理
    this.thumbnailTotalRequested = 0; // サムネイル生成リクエストの総数
    this.thumbnailCompleted = 0;      // サムネイル生成完了数
    this.thumbnailToastTimeout = null; // トースト通知を消すためのタイマー
    this.thumbnailCounted = new Set(); // 完了済みとしてカウントしたファイルのセット
    this.lastThumbnailToastTime = 0;  // 最後にトースト通知を更新した時刻
    this.metadataTargetCount = 0;     // メタデータ取得リクエストの総数
    this.metadataCompleted = 0;       // メタデータ取得完了数

    // 履歴管理
    this.isNavigatingHistory = false; // 履歴操作による遷移中のフラグ
  }

  /**
   * Rust側のSource of Truthにソート・検索条件を送信し、フィルタリング後の件数を取得します。
   * @returns {Promise<number>} フィルタリング後の件数
   */
  async setViewParams() {
    if (window.veloceAPI && window.veloceAPI.setViewParams) {
      try {
        const [totalCount, paths] = await window.veloceAPI.setViewParams(
          this.sortConfig.key, this.sortConfig.asc, this.searchQuery
        );
        this.totalCount = totalCount;
        this.currentPaths = paths;
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