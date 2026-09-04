// ============================================================================
// Veloce - Thumbnail Processing & Queue Pipeline (renderer-thumbnails.js)
// ============================================================================
// 本モジュールは、大量の画像ファイルに対するサムネイル生成・キャッシュ管理・
// キューイング制御およびエラー自己修復を担う。
//
// 主な機能とアーキテクチャ:
// 1. ThumbnailWorkerPool:
//    メインスレッドのUI描画を妨げずに並列で画像デコード・OffscreenCanvas縮小処理を実施。
//    Chromium 109環境のハングアップを防ぐ5秒間の絶対タイムアウトと4秒のデコードレース制御。
// 2. 即時描画（Blob URL）と非同期保存の分離:
//    デコード完了後、即座にメモリ効率の高い Blob URL でDOMへ表示し、
//    SQLiteへの永続化（Base64変換とRust IPC）はバックグラウンドPromiseで遅延実行。
// 3. ThumbnailQueueManager:
//    画面内表示アイテム（優先キュー）と画面外アイテム（プリロードキュー）を分離し、
//    最大並行数（8枠）のうち表示中アイテムに常時即応枠（4枠）を確保。
// 4. キューの即時破棄（AbortController）:
//    フォルダ切り替えやソート変更時に実行中タスクへ中断シグナルを発行し、不要処理を排除。
// 5. 自己修復（Self-Healing）ウォッチドッグ:
//    5秒間隔で可視DOMを巡回し、読み込みスタック状態の要素を自動検知して再キュー。
// ============================================================================

import { appState } from './renderer-state.js';
import { UIManager, uiManager } from './renderer-ui.js';
import { getStreamUrl, debounce } from './utils.js';

/**
 * サムネイル生成ワーカープール
 * 画像のフェッチ、Canvas縮小（最大384x384）、Blob URL生成、Base64シリアライズを担当
 */
class ThumbnailWorkerPool {
  constructor() {
    this.initialized = true;
  }

  /**
   * 単一画像のサムネイルを非同期生成する
   * @param {string} filePath - 対象の画像ファイルパス
   * @param {string} assetUrl - Tauriカスタムアセットプロトコル等の元画像URL
   * @param {AbortSignal} [abortSignal] - フォルダ切り替え時の中断シグナル
   * @returns {Promise<{ url: string, base64Promise: Promise<string> }>}
   */
  async generate(filePath, assetUrl, abortSignal) {
    return new Promise(async (resolve, reject) => {
      // 5秒間の絶対タイムアウト制御
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("Thumbnail generation timed out (5s)"));
      }, 5000);

      const onGlobalAbort = () => {
        controller.abort();
        clearTimeout(timeoutId);
        reject(new Error("Aborted by folder switch"));
      };

      if (abortSignal) {
        if (abortSignal.aborted) return onGlobalAbort();
        abortSignal.addEventListener('abort', onGlobalAbort);
      }

      try {
        const urlWithBuster = assetUrl.includes('?') ? assetUrl + '&_t=' + Date.now() : assetUrl + '?_t=' + Date.now();
        const response = await fetch(urlWithBuster, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error("Fetch failed: " + response.status);
        const blob = await response.blob();
        
        // Chromium 109環境で破損画像等により createImageBitmap が永久ハングする問題を防ぐため、4秒タイムアウトで競合
        const sourceElement = await Promise.race([
          createImageBitmap(blob),
          new Promise((_, r) => setTimeout(() => r(new Error("createImageBitmap timed out")), 4000))
        ]);
        
        if (sourceElement instanceof Error) throw sourceElement;
        let width = sourceElement.width;
        let height = sourceElement.height;
        if (width > 384 || height > 384) {
          const ratio = Math.min(384 / width, 384 / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        width = Math.max(1, width);
        height = Math.max(1, height);
        
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(sourceElement, 0, 0, width, height);
        
        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        sourceElement.close();
        
        const blobUrl = URL.createObjectURL(outBlob);
        
        const base64Promise = new Promise((resolveB64, rejectB64) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            resolveB64(reader.result);
          };
          reader.onerror = () => {
            rejectB64(new Error("FileReader failed"));
          };
          reader.readAsDataURL(outBlob);
        });

        clearTimeout(timeoutId);
        resolve({ url: blobUrl, base64Promise });
      } catch (err) {
        reject(err);
      } finally {
        if (abortSignal) abortSignal.removeEventListener('abort', onGlobalAbort);
      }
    });
  }
}

export const thumbnailWorkerPool = new ThumbnailWorkerPool();

// Phase 4: Context Cleanup Strictness
export function cleanupContext() {
  if (appState && appState.thumbnailUrls) {
    appState.thumbnailUrls.forEach(url => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    appState.thumbnailUrls.clear();
  }
  if (window.thumbnailManager) window.thumbnailManager.clear();
  
  // フォルダ切り替え時に古いマッピングを残さない
  const uiMgr = window.uiManager;
  if (uiMgr && uiMgr._domByPath) uiMgr._domByPath.clear();
}


export const evictThumbnailCache = debounce((maxSize = 2000) => {
  if (!appState || !appState.thumbnailUrls || appState.thumbnailUrls.size <= maxSize) return;
  const toDelete = appState.thumbnailUrls.size - maxSize;
  let i = 0;
  for (const [key, val] of appState.thumbnailUrls) {
    // 表示中のアイテムはスキップ
    if (appState.visiblePathSet && appState.visiblePathSet.has(key)) continue;
    
    if (val && val.startsWith('blob:')) {
      URL.revokeObjectURL(val);
    }
    appState.thumbnailUrls.delete(key);
    if (++i >= toDelete) break;
  }
}, 100);
window.evictThumbnailCache = evictThumbnailCache;

const THUMBNAIL_BATCH_SIZE = 4;

export function resetThumbnailPreloader() {
  if (window.thumbnailManager) window.thumbnailManager.resetPreload();
  appState.preloadCursor = 0;
}

window.markThumbnailCompleted = function markThumbnailCompleted(filePath) {
  if (filePath && !appState.thumbnailCounted.has(filePath)) {
    appState.thumbnailCounted.add(filePath);
    appState.thumbnailCompleted++;
    window.updateThumbnailToast();
  }
};

window.updateThumbnailToast = function updateThumbnailToast() {
  if (appState.thumbnailTotalRequested === 0) return;

  const now = Date.now();
  const THROTTLE_DELAY = 50; // 50msに1回まで更新を許可

  // 最後の更新から十分な時間が経過したか、または最後の1件の時のみUIを更新
  if (now - appState.lastThumbnailToastTime > THROTTLE_DELAY || appState.thumbnailCompleted >= appState.thumbnailTotalRequested) {
    appState.lastThumbnailToastTime = now;

    if (appState.thumbnailCompleted < appState.thumbnailTotalRequested) {
      uiManager.showToast(`サムネイル読込中 (${appState.thumbnailCompleted}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress', 'info');
      
      // フォールバック: 3秒間進捗がなければ強制的にトーストを消去（スタック防止）
      clearTimeout(appState.thumbnailToastTimeout);
      appState.thumbnailToastTimeout = setTimeout(() => {
        const t = document.getElementById('toast-thumbnail-progress');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
        appState.thumbnailTotalRequested = 0;
        appState.thumbnailCompleted = 0;
        appState.lastThumbnailToastTime = 0;
      }, 3000);
    } else {
      uiManager.showToast(`サムネイル読込完了 (${appState.thumbnailTotalRequested}/${appState.thumbnailTotalRequested})`, 0, 'thumbnail-progress');
      clearTimeout(appState.thumbnailToastTimeout);
      appState.thumbnailToastTimeout = setTimeout(() => {
        const t = document.getElementById('toast-thumbnail-progress');
        if (t) {
          t.classList.remove('show');
          setTimeout(() => { if (t.parentElement) t.remove(); }, 300);
        }
        appState.thumbnailTotalRequested = 0;
        appState.thumbnailCompleted = 0;
        appState.lastThumbnailToastTime = 0;
      }, 1000);
    }
  }
}

// 個別タスクのタイムアウト付きサムネイル取得
function fetchThumbnailWithTimeout(filePath, timeoutMs = 10000) {
  return Promise.race([
    window.veloceAPI.getThumbnail(filePath),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Thumbnail timeout')), timeoutMs))
  ]);
}

export class ThumbnailQueueManager {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.activeTasks = new Set();
    // priorityQueue: 重複チェックをO(1)にするため Set＋配列のペアで管理
    this.priorityQueue = [];
    this.priorityQueueSet = new Set();
    this.preloadQueue = [];
    this.isProcessing = false;
    this.abortController = new AbortController();
  }

  enqueuePriority(filePath) {
    if (!this.activeTasks.has(filePath) && !appState.thumbnailUrls.has(filePath)) {
      // SetでO(1)重複チェック（旧: findIndex O(N) + splice O(N)）
      if (!this.priorityQueueSet.has(filePath)) {
        this.priorityQueueSet.add(filePath);
        this.priorityQueue.unshift({ filePath });
      }
      this.processNext();
    }
  }

  enqueuePriorityBatch(filePaths) {
    let added = false;
    for (const filePath of filePaths) {
      if (!this.activeTasks.has(filePath) && !appState.thumbnailUrls.has(filePath)) {
        if (!this.priorityQueueSet.has(filePath)) {
          this.priorityQueueSet.add(filePath);
          this.priorityQueue.push({ filePath });
          added = true;
        }
      }
    }
    if (added) {
      this.processNext();
    }
  }

  resetPreload() {
    this.preloadQueue = [];
  }

  clear() {
    this.priorityQueue = [];
    this.priorityQueueSet.clear();
    this.preloadQueue = [];
    
    // 現在実行中のタスクを強制キャンセルし、新しいコンテキストを開始する
    this.abortController.abort();
    this.abortController = new AbortController();
    
    this.activeTasks.clear();
    if (this._dirtyTasks) this._dirtyTasks.clear();
    if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
      window.debouncedUpdateSmartFolderCounts();
    }
  }

  unshiftPreload(paths) {
    const toAdd = paths.filter(p => !this.activeTasks.has(p) && !appState.thumbnailUrls.has(p));
    this.preloadQueue.unshift(...toAdd);
    this.processNext();
  }

  remove(filePath) {
    this.priorityQueue = this.priorityQueue.filter(req => req.filePath !== filePath);
    this.priorityQueueSet.delete(filePath);
    this.preloadQueue = this.preloadQueue.filter(p => p !== filePath);

    // リトライカウントをリセット（書き込み完了後の新規ファイルを正しく処理するため）
    if (this._retryMap) {
      this._retryMap.delete(filePath);
    }

    // 実行中のタスクがある場合、dirty フラグを立てて完了後に再キューさせる
    if (this.activeTasks.has(filePath)) {
      if (!this._dirtyTasks) this._dirtyTasks = new Set();
      this._dirtyTasks.add(filePath);
    }
  }

  async processNext() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // updateVirtualGrid() で同期した appState.visiblePathSet を参照する（querySelectorAll O(N) を排除）
      const visiblePaths = appState.visiblePathSet || new Set();

      while (this.activeTasks.size < this.concurrency) {
        let targetFile = null;

        // 1. Priority Queue
        if (this.priorityQueue.length > 0) {
          appState.isPreloadRunning = false;
          let targetIndex = this.priorityQueue.findIndex(req => visiblePaths.has(req.filePath));
          let isVisible = true;
          
          if (targetIndex === -1) {
            targetIndex = 0;
            isVisible = false;
          }

          // 表示中ではないアイテム（スクロールで通り過ぎたアイテム等）の処理時は、
          // バックグラウンド枠（全体-4枠）を超えないように制限し、常に表示中アイテムのために即応枠を確保する
          const bgLimit = Math.max(1, this.concurrency - 4);
          if (!isVisible && this.activeTasks.size >= bgLimit) {
            break;
          }

          const req = this.priorityQueue.splice(targetIndex, 1)[0];
          this.priorityQueueSet.delete(req.filePath); // Set との整合性を維持
          
          if (appState.thumbnailUrls.has(req.filePath)) {
            if (typeof window.markThumbnailCompleted === 'function') window.markThumbnailCompleted(req.filePath);
            continue;
          }
          targetFile = req.filePath;
        }
        // 2. Preload Fetching
        else if (this.preloadQueue.length === 0 && appState.preloadCursor < appState.totalCount) {
          appState.isPreloadRunning = true;
          if (!appState.isFetchingPreload) {
            appState.isFetchingPreload = true;
            window.veloceAPI.getItems(appState.preloadCursor, 50).then(items => {
              if (items && items.length > 0) {
                appState.preloadCursor += items.length;
                this.preloadQueue.push(...items.map(f => f.path));
              } else {
                appState.preloadCursor += 50;
              }
            }).catch(err => {
              console.warn("Preload getItems failed:", err);
              appState.preloadCursor += 50;
            }).finally(() => {
              appState.isFetchingPreload = false;
              this.processNext();
            });
          }
          break; // wait for fetch
        }
        // 3. Preload Queue
        else if (this.preloadQueue.length > 0) {
          const bgLimit = Math.max(1, this.concurrency - 4);
          if (this.activeTasks.size >= bgLimit) {
            break; // プリロードもバックグラウンド枠上限までとする
          }
          appState.isPreloadRunning = true;
          let found = false;
          while (this.preloadQueue.length > 0) {
            const p = this.preloadQueue.shift();
            if (appState.thumbnailUrls.has(p)) {
              if (typeof window.markThumbnailCompleted === 'function') window.markThumbnailCompleted(p);
            } else if (!this.activeTasks.has(p)) {
              targetFile = p;
              found = true;
              break;
            }
          }
          if (!found) {
            if (appState.preloadCursor >= appState.totalCount) {
              appState.isPreloadRunning = false;
            }
            continue;
          }
        }

        if (!targetFile) break;

        this.activeTasks.add(targetFile);
        // 個別タスクを非同期で起動（完了次第 updateDOM → processNext を呼ぶ）
        this.runTask(targetFile);
      }
      
      // キューが完全に空になり、かつ全件のフェッチも終了していれば「完了」とみなして件数を同期
      if (this.priorityQueue.length === 0 && 
          this.preloadQueue.length === 0 && 
          this.activeTasks.size === 0 && 
          appState.preloadCursor >= appState.totalCount) {
        if (typeof window.debouncedUpdateSmartFolderCounts === 'function') {
          window.debouncedUpdateSmartFolderCounts();
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async runTask(filePath) {
    const signal = this.abortController.signal;
    let fallbackToSvg = false;

    try {
      // 1. Rust からキャッシュ取得試行
      let url = await window.veloceAPI.getThumbnail(filePath);
      
      if (signal.aborted) return;
      if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
        throw new Error('Task invalidated by file-changed');
      }

      // 2. キャッシュがない場合、非同期に生成
      if (!url) {
        const assetUrl = getStreamUrl(filePath, window.veloceAPI.convertFileSrc(filePath));
        const { url: blobUrl, base64Promise } = await thumbnailWorkerPool.generate(filePath, assetUrl, signal);
        
        if (signal.aborted) return;
        if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
          URL.revokeObjectURL(blobUrl);
          throw new Error('Task invalidated by file-changed');
        }
        
        appState.thumbnailUrls.set(filePath, blobUrl);
        evictThumbnailCache();
        this.updateDOM(filePath, blobUrl);

        // バックグラウンドでBase64変換しRustに保存。
        base64Promise.then(base64Url => {
          if (signal.aborted) return;
          window.veloceAPI.saveThumbnail(filePath, base64Url).then((savedUrl) => {
            if (signal.aborted) return;
            const lightUrl = savedUrl || blobUrl;
            if (lightUrl && lightUrl !== blobUrl && appState.thumbnailUrls.get(filePath) === blobUrl) {
              appState.thumbnailUrls.set(filePath, lightUrl);
              if (window.evictThumbnailCache) window.evictThumbnailCache();
            }
          }).catch(err => console.warn('Cache save error:', err));
        }).catch(err => console.warn('Base64 conversion error:', err));
        
        return; // 早期リターン
      }

      appState.thumbnailUrls.set(filePath, url);
      evictThumbnailCache();
      this.updateDOM(filePath, url);
    } catch (err) {
      if (signal.aborted) return;

      if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
        // file-changed による中断。finally で再キューされるためリトライカウントは進めない。
        console.info(`[Thumbnail] Task for ${filePath.split('\\').pop()} was dirtied by file-changed.`);
      } else {
        console.warn(`[Thumbnail] ${filePath.split('\\').pop()} error:`, err);

        // 書き込み中のファイルに対するレースコンディション対策:
        // リトライカウントを管理し、最大3回まで遅延リトライする (1s, 2s, 3s)
        const retryCount = (this._retryMap ? this._retryMap.get(filePath) : 0) || 0;
        if (retryCount < 3) {
          if (!this._retryMap) this._retryMap = new Map();
          this._retryMap.set(filePath, retryCount + 1);
          const delay = 1000 * (retryCount + 1);
          console.info(`[Thumbnail] Retry ${retryCount + 1}/3 for ${filePath.split('\\').pop()} in ${delay}ms`);
          setTimeout(() => {
            if (!signal.aborted) {
              this.enqueuePriority(filePath);
            }
          }, delay);
        } else {
          fallbackToSvg = true;
        }
      }
    } finally {
      if (!signal.aborted) {
        this.activeTasks.delete(filePath);

        if (fallbackToSvg) {
          // 3回失敗: SVGフォールバックを表示し、thumbnailUrlsにもセットして無限リトライを防ぐ
          const BROKEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
          const fallbackUrl = 'data:image/svg+xml;base64,' + btoa(BROKEN_SVG);
          appState.thumbnailUrls.set(filePath, fallbackUrl);
          if (window.evictThumbnailCache) window.evictThumbnailCache();
          this.updateDOM(filePath, fallbackUrl);
          if (this._retryMap) this._retryMap.delete(filePath);
          console.warn(`[Thumbnail] Gave up after 3 retries: ${filePath.split('\\').pop()}`);
        }

        if (typeof window.markThumbnailCompleted === 'function') {
          window.markThumbnailCompleted(filePath);
        }

        if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
          this._dirtyTasks.delete(filePath);
          // file-changed が来ていたので即座に再キュー
          this.enqueuePriority(filePath);
        } else {
          this.processNext();
        }
      }
    }
  }

  updateDOM(filePath, url) {
    // uiManager._domByPath (Map) から O(1) で要素を取得する
    const uiMgr = window.uiManager || uiManager;
    const wrapper = (uiMgr && uiMgr._domByPath) ? uiMgr._domByPath.get(filePath) : null;
    if (wrapper) {
      const img = wrapper.children[0]; // .thumbnail-img
      if (img) {
        img.src = url;
        if (img.complete) {
          img.classList.remove('loading');
        } else {
          img.onload = function () { this.classList.remove('loading'); };
          img.onerror = function () {
            this.classList.remove('loading');
            const fallback = window.veloceAPI.convertFileSrc(filePath);
            if (this.src !== fallback && !this.src.startsWith('asset://')) {
              if (window.appState && window.appState.thumbnailUrls) {
                window.appState.thumbnailUrls.set(filePath, fallback);
              }
              this.src = fallback;
            }
          };
        }
      }
      return;
    }
    // _domByPath に存在しない場合（スクロールで仮想化された範囲外）はスキップ
    // スクロール後に updateVirtualGrid が再レンダリングする際に thumbnailUrls から引かれる
  }
}

window.thumbnailManager = new ThumbnailQueueManager(THUMBNAIL_BATCH_SIZE);
window.processNextTask = () => window.thumbnailManager.processNext();


window.resetThumbnailPreloader = resetThumbnailPreloader;

// サムネイルの自己修復（Self-healing）監視プロセス
// 画面に表示されている要素（_domByPath）を定期的に検査し、ロード中のままスタックしているか、
// SVGフォールバックのエラー状態のまま放置されているサムネイルを検知して自動的に再キューする。
setInterval(() => {
  if (window.appState && window.appState.dragState && window.appState.dragState.isAppDragging) return;
  if (!window.uiManager || !window.uiManager._domByPath) return;
  if (!window.thumbnailManager) return;
  
  let retryCount = 0;
  for (const [path, wrapper] of window.uiManager._domByPath.entries()) {
    const img = wrapper.children[0];
    if (!img) continue;
    
    const isStuckLoading = img.classList.contains('loading');
    const isSvgFallback = img.src && img.src.startsWith('data:image/svg+xml');
    
    if (isStuckLoading || isSvgFallback) {
      if (!window.thumbnailManager.activeTasks.has(path)) {
        if (window.appState && window.appState.thumbnailUrls) {
          window.appState.thumbnailUrls.delete(path);
        }
        window.thumbnailManager.enqueuePriority(path);
        retryCount++;
      }
    }
  }
  
  if (retryCount > 0 && typeof window.processNextTask === 'function') {
    window.processNextTask();
    console.info(`[Self-Healing] Automatically retried ${retryCount} missing/broken thumbnails on screen.`);
  }
}, 5000);
