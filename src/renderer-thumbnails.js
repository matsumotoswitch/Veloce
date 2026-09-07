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
import { UIManager, uiManager, BROKEN_MP4_FALLBACK_URL } from './renderer-ui.js';
import { getStreamUrl, debounce } from './utils.js';

/**
 * Blob から安全にヘッダーバイト列を取得するヘルパー関数
 * Node/jsdom テスト環境および Chromium/WebView2 の両方に対応
 * @param {Blob} blob
 * @param {number} maxBytes
 * @returns {Promise<ArrayBuffer>}
 */
async function readBlobHeaderBuffer(blob, maxBytes = 512) {
  if (!blob) return new ArrayBuffer(0);
  const slice = blob.slice ? blob.slice(0, maxBytes) : blob;
  if (typeof slice.arrayBuffer === 'function') {
    try {
      return await slice.arrayBuffer();
    } catch (e) {}
  }
  if (typeof blob.arrayBuffer === 'function') {
    try {
      const full = await blob.arrayBuffer();
      return full.slice(0, maxBytes);
    } catch (e) {}
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(new ArrayBuffer(0)), 500);
      const reader = new FileReader();
      reader.onloadend = () => {
        clearTimeout(timer);
        resolve(reader.result || new ArrayBuffer(0));
      };
      reader.onerror = () => {
        clearTimeout(timer);
        resolve(new ArrayBuffer(0));
      };
      reader.readAsArrayBuffer(slice);
    });
  }
  return new ArrayBuffer(0);
}

/**
 * 画像 Blob の先頭バイナリから幅と高さをミリ秒未満（0.01ms）で高速抽出する
 * PNG, WebP, JPEG のヘッダーを解析し、デコード前に寸法を特定して
 * createImageBitmap のネイティブダウンサンプリングを可能にする
 * @param {Blob} blob
 * @returns {Promise<{width: number, height: number}|null>}
 */
export async function getImageDimensionsFromBlob(blob) {
  try {
    const buffer = await readBlobHeaderBuffer(blob, 512);
    if (!buffer || buffer.byteLength === 0) return null;
    const view = new DataView(buffer);
    const len = buffer.byteLength;

    // 1. PNG (89 50 4E 47 0D 0A 1A 0A)
    if (len >= 24 && view.getUint32(0, false) === 0x89504E47 && view.getUint32(4, false) === 0x0D0A1A0A) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) return { width, height };
    }

    // 2. WebP (RIFF .... WEBP)
    if (len >= 30 && view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57454250) {
      const chunkType = view.getUint32(12, false);
      // VP8X (Extended format: "VP8X" = 0x56503858)
      if (chunkType === 0x56503858 && len >= 30) {
        const width = (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1;
        const height = (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1;
        if (width > 0 && height > 0) return { width, height };
      }
      // VP8L (Lossless format: "VP8L" = 0x5650384C)
      if (chunkType === 0x5650384C && len >= 25 && view.getUint8(20) === 0x2F) {
        const b0 = view.getUint8(21);
        const b1 = view.getUint8(22);
        const b2 = view.getUint8(23);
        const b3 = view.getUint8(24);
        const width = 1 + (((b1 & 0x3F) << 8) | b0);
        const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      }
      // VP8 (Lossy format: "VP8 " = 0x56503820)
      if (chunkType === 0x56503820 && len >= 30) {
        if (view.getUint8(23) === 0x9D && view.getUint8(24) === 0x01 && view.getUint8(25) === 0x2A) {
          const width = view.getUint16(26, true) & 0x3FFF;
          const height = view.getUint16(28, true) & 0x3FFF;
          if (width > 0 && height > 0) return { width, height };
        }
      }
    }

    // 3. JPEG (FF D8)
    if (len >= 2 && view.getUint16(0, false) === 0xFFD8) {
      let offset = 2;
      while (offset + 9 <= len) {
        if (view.getUint8(offset) !== 0xFF) break;
        const marker = view.getUint8(offset + 1);
        const isSOF = (marker >= 0xC0 && marker <= 0xC3) ||
                      (marker >= 0xC5 && marker <= 0xC7) ||
                      (marker >= 0xC9 && marker <= 0xCB) ||
                      (marker >= 0xCD && marker <= 0xCF);
        if (isSOF && offset + 8 < len) {
          const height = view.getUint16(offset + 5, false);
          const width = view.getUint16(offset + 7, false);
          if (width > 0 && height > 0) return { width, height };
        }
        if (offset + 4 > len) break;
        const segmentLength = view.getUint16(offset + 2, false);
        if (segmentLength < 2) break;
        offset += 2 + segmentLength;
      }
    }
  } catch (e) {
    // Binary header parse error fallback
  }
  return null;
}

/**
 * サムネイル生成ワーカープール
 * 画像のフェッチ、Chromium ネイティブダウンサンプリング、Canvas縮小（最大384x384）、Blob URL生成、Base64シリアライズを担当
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
        
        // ヘッダーから元画像サイズを軽量抽出してダウンサンプリング目標寸法を算出
        const dims = await getImageDimensionsFromBlob(blob);
        let targetWidth = 0;
        let targetHeight = 0;
        let originalWidth = (dims && dims.width > 0) ? dims.width : 0;
        let originalHeight = (dims && dims.height > 0) ? dims.height : 0;

        if (dims && dims.width > 0 && dims.height > 0) {
          if (dims.width > 384 || dims.height > 384) {
            const ratio = Math.min(384 / dims.width, 384 / dims.height);
            targetWidth = Math.max(1, Math.round(dims.width * ratio));
            targetHeight = Math.max(1, Math.round(dims.height * ratio));
          } else {
            targetWidth = dims.width;
            targetHeight = dims.height;
          }
        }

        // Chromium 109環境の安全レース制御
        const decodeRace = (promise) => Promise.race([
          promise,
          new Promise((_, r) => setTimeout(() => r(new Error("createImageBitmap timed out")), 4000))
        ]);

        // ネイティブダウンサンプリング: Chromium デコーダーが 384px 枠内に直接デコードするため
        // 巨大な等倍バッファ（数十MB）のメモリ展開とGC負荷を根絶し、デコード時間を極小化
        let sourceElement;
        if (targetWidth > 0 && targetHeight > 0) {
          try {
            sourceElement = await decodeRace(createImageBitmap(blob, {
              resizeWidth: targetWidth,
              resizeHeight: targetHeight,
              resizeQuality: 'medium'
            }));
          } catch (optErr) {
            sourceElement = await decodeRace(createImageBitmap(blob));
          }
        } else {
          sourceElement = await decodeRace(createImageBitmap(blob));
        }

        if (sourceElement instanceof Error) throw sourceElement;
        if (originalWidth === 0 && originalHeight === 0 && sourceElement) {
          originalWidth = sourceElement.width;
          originalHeight = sourceElement.height;
        }

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
        // 等倍またはすでに縮小済みのため、補間品質は medium で最高速化
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
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
        resolve({ url: blobUrl, base64Promise, width: originalWidth, height: originalHeight });
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

const THUMBNAIL_BATCH_SIZE = 8;

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

  enqueuePriority(filePath, skipDbCheck = false) {
    if (!this.activeTasks.has(filePath) && !appState.thumbnailUrls.has(filePath)) {
      // SetでO(1)重複チェック（旧: findIndex O(N) + splice O(N)）
      if (!this.priorityQueueSet.has(filePath)) {
        this.priorityQueueSet.add(filePath);
        this.priorityQueue.unshift({ filePath, skipDbCheck });
      }
      this.processNext();
    }
  }

  enqueuePriorityBatch(filePaths, skipDbCheck = false) {
    let added = false;
    for (const item of filePaths) {
      const filePath = typeof item === 'string' ? item : item.filePath;
      const skip = typeof item === 'object' && item.skipDbCheck !== undefined ? item.skipDbCheck : skipDbCheck;
      if (!this.activeTasks.has(filePath) && !appState.thumbnailUrls.has(filePath)) {
        if (!this.priorityQueueSet.has(filePath)) {
          this.priorityQueueSet.add(filePath);
          this.priorityQueue.push({ filePath, skipDbCheck: skip });
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
        let targetSkipDbCheck = false;

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
          const bgLimit = Math.max(2, this.concurrency - 4);
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
          targetSkipDbCheck = !!req.skipDbCheck;
        }
        // 2. Preload Fetching
        else if (this.preloadQueue.length === 0 && appState.preloadCursor < appState.totalCount) {
          appState.isPreloadRunning = true;
          if (!appState.isFetchingPreload) {
            appState.isFetchingPreload = true;
            if (typeof window.veloceAPI?.getItems === 'function') {
              const fetchPromise = window.veloceAPI.getItems(appState.preloadCursor, 50);
              if (fetchPromise && typeof fetchPromise.then === 'function') {
                fetchPromise.then(items => {
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
              } else {
                appState.isFetchingPreload = false;
              }
            } else {
              appState.isFetchingPreload = false;
            }
          }
          break; // wait for fetch
        }
        // 3. Preload Queue
        else if (this.preloadQueue.length > 0) {
          const bgLimit = Math.max(2, this.concurrency - 4);
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
        this.runTask(targetFile, targetSkipDbCheck);
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

  async runTask(filePath, skipDbCheck = false) {
    const signal = this.abortController.signal;
    let fallbackToSvg = false;

    try {
      // 1. Rust からキャッシュ取得試行（未キャッシュ確定時は不要なIPCラウンドトリップをスキップ）
      let url = null;
      if (!skipDbCheck) {
        url = await window.veloceAPI.getThumbnail(filePath);
      }
      
      if (signal.aborted) return;
      if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
        throw new Error('Task invalidated by file-changed');
      }

      // 2. キャッシュがない場合、非同期に生成
      if (!url) {
        const assetUrl = getStreamUrl(filePath, window.veloceAPI.convertFileSrc(filePath));
        const { url: blobUrl, base64Promise, width, height } = await thumbnailWorkerPool.generate(filePath, assetUrl, signal);
        
        if (signal.aborted) return;
        if (this._dirtyTasks && this._dirtyTasks.has(filePath)) {
          URL.revokeObjectURL(blobUrl);
          throw new Error('Task invalidated by file-changed');
        }
        
        appState.thumbnailUrls.set(filePath, blobUrl);
        evictThumbnailCache();
        this.updateDOM(filePath, blobUrl);

        if (width > 0 && height > 0) {
          const uiMgr = window.uiManager || (typeof uiManager !== 'undefined' ? uiManager : null);
          if (uiMgr && typeof uiMgr.updateFileDimensions === 'function') {
            uiMgr.updateFileDimensions(filePath, width, height);
          }
          if (window.veloceAPI && typeof window.veloceAPI.updateFileDimensions === 'function') {
            window.veloceAPI.updateFileDimensions(filePath, width, height);
          }
        }

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
          const fallbackUrl = BROKEN_MP4_FALLBACK_URL;
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
