/**
 * メイン画面のアプリケーション全体の状態とデータを管理するクラス
 */
class AppState {
  constructor() {
    this.files = [];              // 読み込まれたすべての画像ファイルリスト
    this.filteredFiles = [];      // 検索・ソート適用後のファイルリスト
    this.sortConfig = { key: 'name', asc: true }; // 現在のソート設定
    this.searchQuery = '';        // 検索クエリ文字列
    this.selectedIndex = -1;      // 現在アクティブな選択アイテムのインデックス
    this.selection = new Set();   // 複数選択されているアイテムのインデックス集合
    this.currentDirectory = '';   // 現在表示中のディレクトリパス

    // レイアウト状態の管理
    this.layout = {
      leftWidth: 200,             // 左ペインの幅(px)
      rightWidth: 300,            // 右ペインの幅(px)
      leftVisible: true,          // 左ペインの表示状態
      rightVisible: true          // 右ペインの表示状態
    };

    // ドラッグ状態の管理
    this.dragState = {
      paths: [],                  // ドラッグ中のファイルパスのリスト
      isAppDragging: false,       // アプリ内からのドラッグかどうか
      pendingRefresh: false       // ドラッグ終了後にリスト更新が必要かどうか
    };

    // システム状態・サムネイル管理
    this.thumbnailObserver = null;   // サムネイルの遅延読み込み用IntersectionObserver
    this.currentMetaBatchId = 0;     // メタデータ一括読み込みのバッチID（非同期キャンセル用）
    this.currentMetaRequestId = 0;   // メタデータ個別読み込みのリクエストID
    this.currentRenderId = 0;        // リスト描画のリクエストID
    this.thumbnailUrls = new Map();  // サムネイル画像のURLキャッシュ（パス -> URL）
    this.pendingThumbnails = new Set(); // サムネイル取得待ちのファイルパス集合
    this.activeThumbnailTasks = 0;   // 現在実行中のサムネイル取得タスク数
    this.thumbnailRequestQueue = []; // サムネイル取得リクエストのキュー
    this.preloadCursor = 0;          // バックグラウンドプリロードの現在のインデックス
    this.isPreloadRunning = false;   // プリロード処理が実行中かどうか
    this.searchTimeout = null;       // 検索入力のデバウンス用タイマー

    // トースト通知状態管理
    this.thumbnailTotalRequested = 0; // サムネイル生成リクエストの総数
    this.thumbnailCompleted = 0;      // サムネイル生成完了数
    this.thumbnailToastTimeout = null; // トースト通知を消すためのタイマー
    this.lastThumbnailToastTime = 0;  // 最後にトースト通知を更新した時刻
  }

  /**
   * 現在のファイルリストに対して、検索クエリによるフィルタリングと、
   * 設定されたソート条件による並び替えを適用し、結果を filteredFiles に格納します。
   * また、選択状態の維持も行います。
   */
  applyFiltersAndSort() {
    // ソート後も選択状態を維持するためにパスを記録
    const selectedPath = this.selectedIndex > -1 && this.filteredFiles[this.selectedIndex] ? this.filteredFiles[this.selectedIndex].path : null;
    const selectedPaths = new Set(Array.from(this.selection).map(i => this.filteredFiles[i] ? this.filteredFiles[i].path : null).filter(Boolean));

    let files = this.files;

    if (this.searchQuery.trim() !== '') {
      const terms = this.searchQuery.toLowerCase().split(',').map(t => t.trim()).filter(t => t);
      
      files = files.filter(f => {
        const charPromptsText = f.charPrompts ? JSON.stringify(f.charPrompts) : '';
        const textToSearch = [f.name, f.prompt, f.negativePrompt, f.source, charPromptsText].filter(Boolean).join(' ').toLowerCase();
        return terms.every(term => textToSearch.includes(term));
      });
    }

    files.sort((a, b) => {
      let valA = a[this.sortConfig.key] !== undefined ? a[this.sortConfig.key] : 0;
      let valB = b[this.sortConfig.key] !== undefined ? b[this.sortConfig.key] : 0;
      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();
      if (valA < valB) return this.sortConfig.asc ? -1 : 1;
      if (valA > valB) return this.sortConfig.asc ? 1 : -1;
      return 0;
    });

    this.filteredFiles = files;

    this.selection.clear();
    this.selectedIndex = -1;
    this.filteredFiles.forEach((f, i) => {
      if (selectedPaths.has(f.path)) this.selection.add(i);
      if (f.path === selectedPath) this.selectedIndex = i;
    });

    if (window.veloceAPI && window.veloceAPI.syncImagePaths) {
      const sortedPaths = this.filteredFiles.map(f => f.path);
      window.veloceAPI.syncImagePaths(sortedPaths);
    }
  }
}

export const appState = new AppState();