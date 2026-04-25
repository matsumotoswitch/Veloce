class UIManager {
  static ICONS = {
    DRIVE: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#a0a0a0" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`,
    FOLDER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="#ebc06d" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    CHEVRON_LEFT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
    CHEVRON_RIGHT: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
    CHEVRON_UP: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
    CHEVRON_DOWN: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="#888" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
    SORT_ASC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
    SORT_DESC: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 4px; vertical-align: middle;"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
    ERASER: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>`
  };

  constructor(state) {
    this.state = state;
    // 頻繁に操作するDOM要素はここで取得しておく
    this.thumbnailGrid = document.getElementById('center-bottom');
    this.fileListBody = document.getElementById('file-list-body');
    this.toastContainer = document.getElementById('toast-container');
  }

  // --- トースト通知の表示 ---
  showToast(message, duration = 3000, id = null, type = 'info') {
    if (!this.toastContainer) {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
      this.toastContainer = container;
    }

    let toast = id ? document.getElementById(`toast-${id}`) : null;

    if (toast) {
      toast.textContent = message;
      // Reset type classes
      toast.classList.remove('success', 'error', 'warning');
    } else {
      toast = document.createElement('div');
      toast.className = 'toast-message';
      if (id) toast.id = `toast-${id}`;
      toast.textContent = message;
      this.toastContainer.appendChild(toast);
    }

    if (type !== 'info') {
      toast.classList.add(type);
    }

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    if (toast.timeoutId) {
      clearTimeout(toast.timeoutId);
    }

    if (duration > 0) {
      toast.timeoutId = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          if (toast.parentElement) toast.remove();
        }, 300);
      }, duration);
    }
  }

  // --- 選択状態のUIを一括更新 ---
  updateSelectionUI() {
    if (!this.fileListBody || !this.thumbnailGrid) {
      this.fileListBody = document.getElementById('file-list-body');
      this.thumbnailGrid = document.getElementById('center-bottom');
      if (!this.fileListBody || !this.thumbnailGrid) return;
    }

    // 全要素をループするのではなく、既に選択されている要素のクラスを外す
    const currentSelectedRows = this.fileListBody.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedRows.length; i++) currentSelectedRows[i].classList.remove('selected');
    
    const currentSelectedThumbs = this.thumbnailGrid.querySelectorAll('.selected');
    for (let i = 0; i < currentSelectedThumbs.length; i++) currentSelectedThumbs[i].classList.remove('selected');

    // 新たに選択された要素のみにクラスを付与する
    const rows = this.fileListBody.children;
    const thumbs = this.thumbnailGrid.children;
    for (const i of this.state.selection) {
      if (rows[i]) rows[i].classList.add('selected');
      if (thumbs[i]) thumbs[i].classList.add('selected');
    }
  }

  // パネルの表示・非表示や幅を CSS 変数に反映する
  applyLayout() {
    const root = document.documentElement;
    const lWidth = this.state.layout.leftVisible ? `${this.state.layout.leftWidth}px` : '0px';
    const rWidth = this.state.layout.rightVisible ? `${this.state.layout.rightWidth}px` : '0px';
    
    root.style.setProperty('--left-width', lWidth);
    root.style.setProperty('--right-width', rWidth);

    const leftPane = document.getElementById('left-pane');
    if (leftPane) leftPane.style.display = this.state.layout.leftVisible ? 'flex' : 'none';
    const rightPane = document.getElementById('right-pane');
    if (rightPane) rightPane.style.display = this.state.layout.rightVisible ? 'flex' : 'none';
  }

  // --- サムネイルとファイルリストの描画 ---
  async renderAll() {
    if (!this.fileListBody || !this.thumbnailGrid) {
      this.fileListBody = document.getElementById('file-list-body');
      this.thumbnailGrid = document.getElementById('center-bottom');
    }

    const renderId = ++this.state.currentRenderId;

    // 既存の画像の監視をすべて停止
    if (this.state.thumbnailObserver) {
        this.state.thumbnailObserver.disconnect();
    }

    // 本当に新規作成が必要なサムネイルの枚数を計算
    const cachedCount = this.state.filteredFiles.filter(f => this.state.thumbnailUrls.has(f.path) || f.hasThumbnailCache).length;
    this.state.thumbnailTotalRequested = this.state.filteredFiles.length - cachedCount;
    this.state.thumbnailCompleted = 0;
    
    // 初期進捗の反映
    if (this.state.thumbnailTotalRequested > 0 && this.state.thumbnailCompleted < this.state.thumbnailTotalRequested) {
      if (typeof updateThumbnailToast === 'function') updateThumbnailToast();
    }

    if (this.fileListBody) this.fileListBody.innerHTML = '';
    if (this.thumbnailGrid) this.thumbnailGrid.innerHTML = '';

    if (this.thumbnailGrid) {
      this.thumbnailGrid.style.display = 'flex';
      this.thumbnailGrid.style.flexWrap = 'wrap';
      this.thumbnailGrid.style.gap = '8px';
      this.thumbnailGrid.style.justifyContent = 'flex-start';
      this.thumbnailGrid.style.alignContent = 'flex-start';
    }

    const fileListContainer = document.getElementById('center-top');
    if (fileListContainer) fileListContainer.scrollTop = 0;
    if (this.thumbnailGrid) this.thumbnailGrid.scrollTop = 0;

    if (this.state.filteredFiles.length === 0 && this.thumbnailGrid) {
      const emptyMessage = document.createElement('div');
      emptyMessage.style.width = '100%';
      emptyMessage.style.textAlign = 'center';
      emptyMessage.style.color = '#888';
      emptyMessage.style.marginTop = '40px';
      emptyMessage.textContent = '表示対象の画像がありません';
      this.thumbnailGrid.appendChild(emptyMessage);
    }

    const CHUNK_SIZE = 100;

    for (let i = 0; i < this.state.filteredFiles.length; i += CHUNK_SIZE) {
      if (renderId !== this.state.currentRenderId) return;

      const chunk = this.state.filteredFiles.slice(i, i + CHUNK_SIZE);
      const tableFragment = document.createDocumentFragment();
      const gridFragment = document.createDocumentFragment();

      chunk.forEach((file, chunkIndex) => {
        const index = i + chunkIndex;
        const isSelected = this.state.selection.has(index);

        // --- テーブル行の作成 ---
        const tr = document.createElement('tr');
        if (isSelected) tr.classList.add('selected');
        tr.dataset.index = index;
        tr.innerHTML = `
          <td>${file.name}</td>
          <td>${file.ext}</td>
          <td style="text-align: right;">${file.width ? file.width.toLocaleString() : '-'}</td>
          <td style="text-align: right;">${file.height ? file.height.toLocaleString() : '-'}</td>
          <td style="text-align: right;">${file.size ? (typeof formatSize === 'function' ? formatSize(file.size) : file.size.toLocaleString()) : '-'}</td>
          <td>${file.mtime ? (typeof formatDate === 'function' ? formatDate(file.mtime) : file.mtime) : '-'}</td>
        `;
        
        tr.draggable = true;
        tableFragment.appendChild(tr);

        // --- サムネイルの作成 ---
        const img = document.createElement('img');
        if (isSelected) img.classList.add('selected');
        img.decoding = "async";
        img.dataset.filepath = file.path;
        img.dataset.index = index;
        img.className = 'thumbnail-item';
        img.style.objectFit = 'contain';
        img.style.width = 'var(--thumbnail-size)';
        img.style.height = 'var(--thumbnail-size)';
        
        img.draggable = true;
        gridFragment.appendChild(img);
        if (this.state.thumbnailObserver) {
          this.state.thumbnailObserver.observe(img);
        }
      });

      if (this.fileListBody) this.fileListBody.appendChild(tableFragment);
      if (this.thumbnailGrid) this.thumbnailGrid.appendChild(gridFragment);

      // メインスレッドのブロック回避
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // バックグラウンド生成の再スタート
    if (!this.state.isPreloadRunning) {
      this.state.isPreloadRunning = true;
      if (typeof processIdleThumbnails === 'function') {
        requestIdleCallback(processIdleThumbnails);
      }
    }
  }
}

// グローバルにインスタンスを一つだけ公開する
window.uiManager = new UIManager(window.appState);
