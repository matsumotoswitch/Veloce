const invoke = window.__TAURI__.invoke || (window.__TAURI__.tauri && window.__TAURI__.tauri.invoke) || (window.__TAURI__.core && window.__TAURI__.core.invoke);
const convertFileSrc = window.__TAURI__.convertFileSrc || (window.__TAURI__.tauri && window.__TAURI__.tauri.convertFileSrc) || (window.__TAURI__.core && window.__TAURI__.core.convertFileSrc);
const listen = (window.__TAURI__.event && window.__TAURI__.event.listen) || (window.__TAURI__.tauri && window.__TAURI__.tauri.listen) || (window.__TAURI__.core && window.__TAURI__.core.listen);
const tauriWindow = window.__TAURI__.window || {};
const appWindow = tauriWindow.appWindow || (tauriWindow.getCurrentWindow ? tauriWindow.getCurrentWindow() : null);
const { LogicalSize, LogicalPosition } = tauriWindow;

/**
 * @typedef {Object} VeloceAPI
 * @property {() => Promise<string[]>} getDrives
 * @property {() => Promise<object|null>} selectDirectory
 * @property {(path: string) => Promise<{path: string, imageFiles: import('./renderer-state.js').ImageFile[]}>} loadDirectory
 * @property {(dirPath: string) => Promise<Array<{name: string, path: string}>>} getFolders
 * @property {(filePaths: string[]) => Promise<any[]>} getFullMetadataBatch
 * @property {(filePath: string) => Promise<string>} getThumbnail
 * @property {(filePath: string) => Promise<any>} parseMetadata
 * @property {(index: number) => Promise<{path: string, total: number}>} getViewerImage
 * @property {(data: {currentIndex: number, width: number, height: number, monitorWidth: number, monitorHeight: number}) => Promise<void>} openViewer
 * @property {() => Promise<boolean>} isViewerMaximized
 * @property {() => Promise<boolean>} isViewerFullscreen
 * @property {() => Promise<void>} toggleViewerFullscreen
 * @property {() => Promise<void>} minimizeViewer
 * @property {() => Promise<void>} maximizeViewer
 * @property {(width: number, height: number) => Promise<void>} resizeViewerWindow
 * @property {(width: number, height: number) => Promise<void>} setWindowSize
 * @property {() => Promise<void>} startViewerDragging
 * @property {(x: number, y: number) => Promise<void>} moveViewerWindow
 * @property {(filePath: string) => Promise<void>} copyImageToClipboard
 * @property {(filePath: string) => Promise<boolean>} trashFile
 * @property {(callback: (payload: any) => void) => void} onFileChanged
 * @property {(callback: (payload: string) => void) => void} onFileRemoved
 * @property {(callback: () => void) => void} onDirectoryChanged
 * @property {(parentDir: string, folderName: string) => Promise<{success: boolean, path?: string, error?: string}>} createFolder
 * @property {(oldPath: string, newName: string) => Promise<{success: boolean, path?: string, error?: string}>} renameFolder
 * @property {(oldPath: string, newName: string) => Promise<{success: boolean, path?: string, error?: string}>} renameFile
 * @property {(folderPath: string) => Promise<{success: boolean, error?: string}>} trashFolder
 * @property {(sourcePath: string, targetDir: string) => Promise<{success: boolean, action: string, reason: string|null}>} moveOrCopyFile
 * @property {(filePath: string) => string} convertFileSrc
 * @property {() => void} toggleDevtools
 * @property {() => void} closeWindow
 * @property {() => Promise<void>} arrangeViewers
 * @property {(paths: string[]) => Promise<void>} syncImagePaths
 * @property {() => Promise<string>} getLicenseText
 * @property {() => Promise<void>} openThumbnailCache
 * @property {() => Promise<void>} clearThumbnailCache
 * @property {() => Promise<{path: string, fileCount: number, totalSizeBytes: number}>} getThumbnailCacheInfo
 */
/**
 * @description
 * フロントエンド（Webページ）とTauriバックエンド（Rust）間の通信を確立します。
 * @type {VeloceAPI}
 */
window.veloceAPI = {
  /**
   * 利用可能なドライブ文字（またはルートディレクトリ）のリストを取得します。
   * @returns {Promise<Array<string>>} ドライブパスの配列
   */
  getDrives: () => invoke('get_drives'),
  /**
   * [非推奨] ディレクトリ選択ダイアログを開き、選択されたディレクトリの情報を返します。
   * @returns {Promise<object|null>} 選択されたディレクトリのパスと画像ファイルのリスト。キャンセルされた場合はnull。
   */
  selectDirectory: () => invoke('select_directory'),
  /**
   * 指定されたパスのディレクトリを読み込み、画像ファイルのリストを返します。
   * @param {string} path - 読み込むディレクトリのパス。
   * @returns {Promise<object>} ディレクトリのパスと画像ファイルのリスト。
   */
  loadDirectory: (path) => invoke('load_directory', { targetPath: path }),
  /**
   * 指定されたパス内のサブフォルダのリストを取得します。
   * @param {string} path - 調査するディレクトリのパス。
   * @returns {Promise<Array<object>>} サブフォルダ情報のリスト。
   */
  getFolders: async (dirPath) => {
    const { fs } = window.__TAURI__;
    try {
      const entries = await fs.readDir(dirPath);
      // Tauri v1では、ディレクトリの場合のみ children プロパティが（空でも）付与されます
      return entries
        .filter(entry => entry.children !== undefined)
        .map(entry => ({ name: entry.name, path: entry.path }));
    } catch (error) {
      console.warn("Failed to get folders:", error);
      return [];
    }
  },
  /**
   * 複数の画像ファイルのメタデータ（プロンプト、幅・高さなど）を一括で取得します。
   * @param {string[]} filePaths - 解析する画像ファイルパスの配列。
   * @returns {Promise<Array<object>>} 各ファイルのパスとメタデータ（幅・高さなど）を含むオブジェクトの配列。
   */
  getFullMetadataBatch: (filePaths) => invoke('get_full_metadata_batch', { filePaths }),
  /**
   * 指定された画像パスから軽量なサムネイル画像を生成して取得します。
   * @param {string} filePath - オリジナル画像のパス。
   * @returns {Promise<string>} サムネイル画像（またはフォールバック画像）のローカルAsset URL。
   */
  getThumbnail: async (filePath) => {
    try {
      const thumbnailPath = await invoke('get_thumbnail', { filePath });
      return convertFileSrc(thumbnailPath);
    } catch (error) {
      console.warn("Failed to generate thumbnail:", error);
      return convertFileSrc(filePath);
    }
  },
  /**
   * 画像ファイルからプロンプトなどのメタデータを解析します。
   * @param {string} filePath - 解析する画像ファイルのパス。
   * @returns {Promise<object>} 抽出されたメタデータ。
   */
  parseMetadata: (filePath) => invoke('parse_metadata', { filePath }),
  /**
   * Rust側のStateから現在選択されている画像情報を取得します。
   * @param {number} index - 画像のインデックス
   * @returns {Promise<object>} { path: string, total: number }
   */
  getViewerImage: (index) => invoke('get_viewer_image', { index }),
  /**
   * 画像ビューアウィンドウを開くようメインプロセスに要求します。
   * @param {object} data - { currentIndex: number, width: number, height: number }
   */
  openViewer: (data) => invoke('open_viewer', data),
  /**
   * 現在のウィンドウが最大化されているかを取得します。
   */
  isViewerMaximized: () => appWindow.isMaximized(),
  /**
   * 現在のウィンドウがフルスクリーンかを取得します。
   */
  isViewerFullscreen: () => appWindow.isFullscreen(),
  /**
   * ビューアウィンドウのフルスクリーン状態をトグルするようメインプロセスに要求します。
   */
  toggleViewerFullscreen: async () => {
    const isFs = await appWindow.isFullscreen();
    return appWindow.setFullscreen(!isFs);
  },
  /**
   * ビューアウィンドウを最小化するようメインプロセスに要求します。
   */
  minimizeViewer: () => appWindow.minimize(),
  /**
   * ビューアウィンドウを最大化するようメインプロセスに要求します。
   */
  maximizeViewer: () => appWindow.toggleMaximize(),
  /**
   * ビューアウィンドウのサイズを変更するようメインプロセスに要求します。
   * @param {number} width - 変更後の幅。
   * @param {number} height - 変更後の高さ。
   */
  resizeViewerWindow: (width, height) => appWindow.setSize(new LogicalSize(width, height)),
  /**
   * ビューアウィンドウのサイズを変更するようメインプロセスに要求します。
   * @param {number} width - 変更後の幅。
   * @param {number} height - 変更後の高さ。
   */
  setWindowSize: async (width, height) => {
    if (window.__TAURI__ && window.__TAURI__.window) {
      const { appWindow, LogicalSize } = window.__TAURI__.window;
      await appWindow.setSize(new LogicalSize(width, height));
    }
  },
  /**
   * ビューアウィンドウのドラッグ移動をOSネイティブに委譲します。
   */
  startViewerDragging: () => appWindow.startDragging(),
  /**
   * ビューアウィンドウを移動するようメインプロセスに要求します。
   * @param {number} x - 移動先の画面X座標。
   * @param {number} y - 移動先の画面Y座標。
   */
  moveViewerWindow: (x, y) => appWindow.setPosition(new LogicalPosition(x, y)),
  /**
   * 画像をクリップボードにコピーするようメインプロセスに要求します。
   * @param {string} filePath - コピーする画像ファイルのパス。
   */
  copyImageToClipboard: (filePath) => invoke('copy_image_to_clipboard', { filePath }),
  /**
   * ファイルをゴミ箱に移動するようメインプロセスに要求します。
   * @param {string} filePath - ゴミ箱に移動するファイルのパス。
   * @returns {Promise<boolean>} 成功したかどうか。
   */
  trashFile: (filePath) => invoke('trash_file', { filePath }),
  /**
   * ファイルが追加または更新されたときの通知を受け取ります。
   */
  onFileChanged: (callback) => listen('file-changed', (event) => callback(event.payload)),
  /**
   * ファイルが削除されたときの通知を受け取ります。
   */
  onFileRemoved: (callback) => listen('file-removed', (event) => callback(event.payload)),
  /**
   * ディレクトリ構造が変更された（フォルダの作成・削除・リネーム）ときの通知を受け取ります。
   */
  onDirectoryChanged: (callback) => listen('directory-changed', () => callback()),
  /**
   * フォルダを作成するようメインプロセスに要求します。
   * @param {string} parentDir - 親ディレクトリのパス。
   * @param {string} folderName - 新しいフォルダ名。
   */
  createFolder: async (parentDir, folderName) => {
    const { fs, path } = window.__TAURI__;
    try {
      const newPath = await path.join(parentDir, folderName);
      await fs.createDir(newPath);
      return { success: true, path: newPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
  /**
   * フォルダ名を変更するようメインプロセスに要求します。
   * @param {string} oldPath - 変更前のフォルダのパス。
   * @param {string} newName - 新しいフォルダ名。
   */
  renameFolder: async (oldPath, newName) => {
    try {
      const newPath = await invoke('rename_folder', { oldPath, newName });
      return { success: true, path: newPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
  /**
   * ファイル名を変更するようメインプロセスに要求します。
   * @param {string} oldPath - 変更前のファイルのパス。
   * @param {string} newName - 新しいファイル名。
   */
  renameFile: async (oldPath, newName) => {
    try {
      const newPath = await invoke('rename_file', { oldPath, newName });
      return { success: true, path: newPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
  /**
   * フォルダをゴミ箱に移動するようメインプロセスに要求します。
   * @param {string} folderPath - 削除するフォルダのパス。
   */
  trashFolder: (folderPath) => invoke('trash_folder', { folderPath }),
  /**
   * ファイルを指定ディレクトリに移動またはコピーします。
   * @param {string} sourcePath - 元のファイルパス。
   * @param {string} targetDir - ドロップ先のディレクトリパス。
   * @returns {Promise<object>} 処理結果 { success, action }。
   */
  moveOrCopyFile: async (sourcePath, targetDir) => {
    const { fs, path } = window.__TAURI__;
    try {
      const fileName = await path.basename(sourcePath);
      const targetPath = await path.join(targetDir, fileName);
      const sourceDir = await path.dirname(sourcePath);

      if (sourceDir === targetDir) {
        return { success: false, action: '', reason: 'same_directory' };
      }

      let action = 'move';
      try {
        // まず rename (移動) を試み、ドライブ跨ぎ等でOSから拒否されたら copy にフォールバックする
        await fs.renameFile(sourcePath, targetPath);
      } catch (e) {
        action = 'copy';
        await fs.copyFile(sourcePath, targetPath);
      }
      return { success: true, action, reason: null };
    } catch (error) {
      return { success: false, action: '', reason: String(error) };
    }
  },
  /**
   * ローカルファイルパスをTauriのAssetプロトコルURLに変換します。
   * @param {string} filePath - ローカルファイルのパス
   * @returns {string} 変換されたURL
   */
  convertFileSrc: (filePath) => convertFileSrc(filePath),
  /**
   * 開発者ツールをトグル表示します（デバッグビルド時のみ有効）
   */
  toggleDevtools: () => { /* 完全に無効化 */ },
  /**
   * ウィンドウを安全に閉じます。
   */
  closeWindow: () => appWindow.close(),
  /**
   * 開いているすべてのビューアーウィンドウを横一列に並べます。
   */
  arrangeViewers: () => invoke('arrange_viewers'),
  /**
   * Rust側の画像パス配列をフロントエンドのソート結果と同期します。
   * @param {string[]} paths - ソート済みの画像パス配列
   */
  syncImagePaths: (paths) => invoke('sync_image_paths', { paths }),
  /**
   * ライセンス情報を取得します。
   */
  getLicenseText: () => invoke('get_license_text'),
  /**
   * サムネイルキャッシュフォルダをエクスプローラで開きます。
   */
  openThumbnailCache: () => invoke('open_thumbnail_folder'),
  /**
   * サムネイルキャッシュをすべて削除します。
   */
  clearThumbnailCache: () => invoke('clear_thumbnail_cache'),
  /**
   * サムネイルキャッシュの情報を取得します。
   */
  getThumbnailCacheInfo: () => invoke('get_thumbnail_cache_info')
};
