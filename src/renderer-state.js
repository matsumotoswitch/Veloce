class AppState {
  constructor() {
    this.files = [];             // 旧 currentFiles
    this.filteredFiles = [];     // 旧 filteredFiles
    this.sortConfig = { key: 'name', asc: true }; // 旧 currentSort
    this.searchQuery = '';       // 旧 searchQuery
    this.selectedIndex = -1;     // 旧 selectedIndex
    this.selection = new Set();  // 旧 selectedIndices
    this.currentDirectory = '';  // 旧 currentDirectory

    // レイアウト状態の管理
    this.layout = {
      leftWidth: 200,
      rightWidth: 300,
      leftVisible: true,
      rightVisible: true
    };

    // ドラッグ状態の管理
    this.dragState = {
      paths: [],
      isAppDragging: false,
      pendingRefresh: false
    };

    // 追加：システム状態・サムネイル管理
    this.thumbnailObserver = null;
    this.currentMetaBatchId = 0;
    this.currentMetaRequestId = 0;
    this.currentRenderId = 0;
    this.thumbnailUrls = new Map();
    this.pendingThumbnails = new Set();
    this.activeThumbnailTasks = 0;
    this.thumbnailRequestQueue = [];
    this.preloadCursor = 0;
    this.isPreloadRunning = false;
    this.searchTimeout = null;

    // 追加：トースト通知状態管理
    this.thumbnailTotalRequested = 0;
    this.thumbnailCompleted = 0;
    this.thumbnailToastTimeout = null;
    this.lastThumbnailToastTime = 0;
  }

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

// グローバルにインスタンスを一つだけ公開する
window.appState = new AppState();