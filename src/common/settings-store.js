/**
 * @file settings-store.js
 * @description
 * アプリケーション設定（タブ状態、最後に開いたフォルダ、お気に入り、ウィンドウサイズ等）を
 * SQLite (`veloce_settings.db`) を Single Source of Truth として一元管理するストア。
 * 
 * ## アーキテクチャ
 * - 起動時に SQLite (`veloce_settings.db`) から全設定をメモリ内キャッシュ (`_cache`) へ一括展開し、
 *   UI側からの読み込みを同期的かつ O(1) で即座に提供。
 * - 変更時は即座にメモリ内キャッシュおよび localStorage を更新し、100msデバウンスにより
 *   SQLite への書き込みトランザクションをバッチ処理してディスクI/O負荷を最小化。
 * - 起動時の調停仕様（4条件）:
 *   1. localStorage なし & DBなし: 新規作成・空設定で初期化
 *   2. localStorage あり & DBなし: 新規作成・localStorage の設定をDBへ移行して採用
 *   3. localStorage なし & DBあり: DBの設定に従って起動
 *   4. localStorage あり & DBあり: DBの設定に従って起動（DB優先、localStorage をDB内容で同期）
 */

(function (global) {
  'use strict';

  class SettingsStoreClass {
    constructor() {
      this._cache = {};
      this._initialized = false;
      this._pendingWrites = new Map();
      this._debounceTimer = null;
      this._api = null;
    }

    /**
     * 設定ストアの初期化
     * 起動時に localStorage 内のエントリを収集し、Rust側の initSettings を通じて
     * 4条件に基づく調停・移行・ロードを行い、メモリ内キャッシュと localStorage を最新化します。
     * @param {Object} [api] - veloceAPI オブジェクト（省略時は window.veloceAPI を使用）
     * @returns {Promise<Object<string, string>>}
     */
    async init(api) {
      if (this._initialized) {
        return this._cache;
      }
      this._api = api || (typeof window !== 'undefined' ? window.veloceAPI : null);

      // 1. localStorage からプロセス間通信用の一時キーを除外した全設定を収集
      const localEntries = {};
      try {
        const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : (global.localStorage || null);
        if (storage) {
          const len = storage.length || 0;
          for (let i = 0; i < len; i++) {
            const k = storage.key(i);
            if (k && !k.startsWith('viewerPaths') && !k.startsWith('viewerStartIndex') && !k.startsWith('viewerInitialData')) {
              const v = storage.getItem(k);
              if (v !== null && v !== undefined) {
                localEntries[k] = String(v);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[SettingsStore] Failed to read localStorage:', e);
      }

      // 2. Rust側の init_settings を呼び出して4条件の調停を実施
      let loadedSettings = {};
      try {
        if (this._api && typeof this._api.initSettings === 'function') {
          loadedSettings = await this._api.initSettings(localEntries);
        } else if (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.invoke) {
          loadedSettings = await window.__TAURI__.invoke('init_settings', { entriesFromLocalstorage: localEntries });
        } else {
          // テスト環境やTauri外でのフォールバック
          loadedSettings = localEntries;
        }
      } catch (e) {
        console.error('[SettingsStore] Failed to init settings from DB, falling back to local entries:', e);
        loadedSettings = localEntries;
      }

      // 3. メモリ内キャッシュへ格納
      this._cache = Object.assign({}, loadedSettings);
      this._initialized = true;

      // 4. localStorage も DB の内容で最新化（ケース3・4で localStorage を DB の真実の内容に同期）
      try {
        const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : (global.localStorage || null);
        if (storage) {
          // 一時キーを退避
          const tempPaths = storage.getItem('viewerPaths');
          const tempIndex = storage.getItem('viewerStartIndex');
          const tempData = storage.getItem('viewerInitialData');

          if (typeof storage.clear === 'function') {
            storage.clear();
          }

          for (const k of Object.keys(this._cache)) {
            storage.setItem(k, this._cache[k]);
          }

          if (tempPaths !== null && tempPaths !== undefined) storage.setItem('viewerPaths', tempPaths);
          if (tempIndex !== null && tempIndex !== undefined) storage.setItem('viewerStartIndex', tempIndex);
          if (tempData !== null && tempData !== undefined) storage.setItem('viewerInitialData', tempData);
        }
      } catch (e) {
        console.warn('[SettingsStore] Failed to sync localStorage with DB settings:', e);
      }

      return this._cache;
    }

    /**
     * 設定値の同期的取得 (O(1))
     * @param {string} key - 設定キー
     * @param {string|null} [defaultValue=null] - 未設定時のデフォルト値
     * @returns {string|null}
     */
    getItem(key, defaultValue = null) {
      if (Object.prototype.hasOwnProperty.call(this._cache, key)) {
        return this._cache[key];
      }
      // 初期化前などの安全策として localStorage をフォールバック参照
      try {
        const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : (global.localStorage || null);
        if (storage) {
          const v = storage.getItem(key);
          if (v !== null && v !== undefined) {
            return v;
          }
        }
      } catch (_) {}
      return defaultValue;
    }

    /**
     * 設定値の同期的書き込みおよび非同期永続化
     * @param {string} key - 設定キー
     * @param {any} value - 保存する値（内部で文字列化）
     */
    setItem(key, value) {
      const strVal = String(value);
      this._cache[key] = strVal;

      try {
        const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : (global.localStorage || null);
        if (storage) {
          storage.setItem(key, strVal);
        }
      } catch (_) {}

      this._queueSave(key, strVal);
    }

    /**
     * 設定項目の削除
     * @param {string} key - 設定キー
     */
    removeItem(key) {
      delete this._cache[key];
      this._pendingWrites.delete(key);

      try {
        const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : (global.localStorage || null);
        if (storage) {
          storage.removeItem(key);
        }
      } catch (_) {}

      if (this._api && typeof this._api.deleteSetting === 'function') {
        this._api.deleteSetting(key).catch(err => console.error('[SettingsStore] deleteSetting failed:', err));
      } else if (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke('delete_setting', { key }).catch(err => console.error('[SettingsStore] deleteSetting failed:', err));
      }
    }

    /**
     * 非同期バッチ保存のキューイング（100msデバウンス）
     * @private
     */
    _queueSave(key, value) {
      this._pendingWrites.set(key, value);
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this.flush();
      }, 100);
    }

    /**
     * 保留中の保存キューを即座に SQLite に書き込む
     * @returns {Promise<void>}
     */
    async flush() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (this._pendingWrites.size === 0) {
        return;
      }

      const entries = {};
      this._pendingWrites.forEach((v, k) => {
        entries[k] = v;
      });
      this._pendingWrites.clear();

      try {
        if (this._api && typeof this._api.setSettingsBatch === 'function') {
          await this._api.setSettingsBatch(entries);
        } else if (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.invoke) {
          await window.__TAURI__.invoke('set_settings_batch', { settings: entries });
        }
      } catch (e) {
        console.error('[SettingsStore] Failed to save settings batch to DB:', e);
      }
    }

    /**
     * 現在の全設定のスナップショットを取得
     * @returns {Object<string, string>}
     */
    getAll() {
      return Object.assign({}, this._cache);
    }

    /**
     * テスト環境等で内部状態をリセットする
     */
    resetForTesting() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._cache = {};
      this._pendingWrites.clear();
      this._initialized = false;
      this._api = null;
    }
  }

  const SettingsStore = new SettingsStoreClass();

  /**
   * 設定値を取得する（SettingsStore優先、フォールバックとしてlocalStorage）
   * @param {string} key
   * @param {string|null} [defaultValue=null]
   * @returns {string|null}
   */
  function getSetting(key, defaultValue = null) {
    if (SettingsStore) {
      return SettingsStore.getItem(key, defaultValue);
    }
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(key);
      return v !== null ? v : defaultValue;
    }
    return defaultValue;
  }

  /**
   * 設定値を保存する（SettingsStore経由でSQLite永続化およびlocalStorage同期）
   * @param {string} key
   * @param {any} value
   */
  function setSetting(key, value) {
    if (SettingsStore) {
      SettingsStore.setItem(key, value);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, String(value));
    }
  }

  // グローバルおよびモジュールへの公開
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SettingsStore, SettingsStoreClass, getSetting, setSetting };
  }
  if (typeof window !== 'undefined') {
    window.SettingsStore = SettingsStore;
    window.getSetting = getSetting;
    window.setSetting = setSetting;
  }
  if (typeof global !== 'undefined') {
    global.SettingsStore = SettingsStore;
    global.getSetting = getSetting;
    global.setSetting = setSetting;
  }
})(typeof window !== 'undefined' ? window : globalThis);

export const SettingsStore = typeof window !== 'undefined' && window.SettingsStore ? window.SettingsStore : (typeof global !== 'undefined' && global.SettingsStore ? global.SettingsStore : null);
export const SettingsStoreClass = typeof window !== 'undefined' && window.SettingsStoreClass ? window.SettingsStoreClass : (typeof global !== 'undefined' && global.SettingsStoreClass ? global.SettingsStoreClass : null);
export const getSetting = typeof window !== 'undefined' && window.getSetting ? window.getSetting : (typeof global !== 'undefined' && global.getSetting ? global.getSetting : function(k, d = null) { return d; });
export const setSetting = typeof window !== 'undefined' && window.setSetting ? window.setSetting : (typeof global !== 'undefined' && global.setSetting ? global.setSetting : function() {});
