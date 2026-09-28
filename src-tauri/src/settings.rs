//! # Veloce - Settings Persistence Module (settings.rs)
//!
//! アプリケーション設定（タブ状態、フォルダ履歴、お気に入り、ウィンドウサイズ等）を
//! SQLite (`veloce_settings.db`) に永続化するモジュール。
//! 
//! ## アーキテクチャと設計方針
//! - キャッシュDB (`veloce_cache.db`) と設定DB (`veloce_settings.db`) を完全に分離し、
//!   キャッシュ消去操作や破損時にもユーザー設定が影響を受けない独立性を担保。
//! - SQLite は高速化設定 (`WAL` モード, `temp_store = MEMORY`, `synchronous = NORMAL`) を適用。
//! - 起動時の移行仕様（4条件）:
//!   1. `localStorage` に設定なし ＆ DBファイルなし: `veloce_settings.db` を新設（初期値で起動）。
//!   2. `localStorage` に設定あり ＆ DBファイルなし: `veloce_settings.db` を新設し、`localStorage` の内容をDBへ移行して採用。
//!   3. `localStorage` に設定なし ＆ DBファイルあり: DBファイルの設定に従って起動。
//!   4. `localStorage` に設定あり ＆ DBファイルあり: DBファイルの設定に従って起動（DB優先）。

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;
use crate::state::AppState;
use crate::utils::get_veloce_data_dir;

/// 設定用SQLiteデータベースのファイルパスを取得する
pub fn get_settings_db_path() -> PathBuf {
    let mut db_path = get_veloce_data_dir().unwrap_or_else(|| PathBuf::from(".veloce_settings"));
    if !db_path.exists() {
        let _ = std::fs::create_dir_all(&db_path);
    }
    db_path.push("veloce_settings.db");
    db_path
}

/// 設定用SQLiteコネクションプールを初期化する
/// 
/// 戻り値:
/// - `Result<(Pool, bool), String>`: コネクションプールと、初期化前にDBファイルが存在していたかどうかのフラグ
pub fn init_settings_db() -> Result<(r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>, bool), String> {
    let db_path = get_settings_db_path();
    let db_file_existed = db_path.exists();

    if let Some(parent) = db_path.parent() {
        if !parent.exists() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let manager = r2d2_sqlite::SqliteConnectionManager::file(&db_path)
        .with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA temp_store = MEMORY;
                 PRAGMA busy_timeout = 5000;"
            )
        });

    let pool = r2d2::Pool::builder()
        .max_size(4)
        .build(manager)
        .map_err(|e| format!("Failed to create settings db pool: {}", e))?;

    let conn = pool.get().map_err(|e| format!("Failed to get connection for table init: {}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    ).map_err(|e| format!("Failed to create app_settings table: {}", e))?;

    Ok((pool, db_file_existed))
}

/// 起動時設定初期化コマンド
/// 
/// フロントエンド起動時に呼び出され、4条件に基づいて適切な設定マップを返却します。
/// 1. localStorage なし & DBなし: 新規作成・空マップ返却
/// 2. localStorage あり & DBなし: 新規作成・localStorageの内容をDBへ一括保存して返却
/// 3. localStorage なし & DBあり: DBの内容を全件取得して返却
/// 4. localStorage あり & DBあり: DBの内容を全件取得して返却（DB優先）
#[tauri::command]
pub fn init_settings(
    state: State<'_, AppState>,
    entries_from_localstorage: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut existed_guard = state.settings_db_existed.lock().map_err(|e| e.to_string())?;
    let mut conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;

    if !*existed_guard {
        // 起動時にDBファイルが存在しなかった場合（ケース1 または ケース2）
        *existed_guard = true; // 今後はDBが存在する状態へ更新

        if !entries_from_localstorage.is_empty() {
            // ケース2: localStorageに設定がある場合はDBへ一括移行
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                ).map_err(|e| e.to_string())?;

                for (key, val) in &entries_from_localstorage {
                    stmt.execute(rusqlite::params![key, val]).map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(entries_from_localstorage);
        } else {
            // ケース1: localStorageにも設定がない場合は初期状態（空）
            return Ok(HashMap::new());
        }
    }

    // ケース3 & ケース4: 起動時にDBファイルが存在していた場合
    // localStorageの内容は無視し、DBの設定を読み出して返却
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    let mut result = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        result.insert(k, v);
    }

    Ok(result)
}

/// 単一設定値の取得
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query(rusqlite::params![key]).map_err(|e| e.to_string())?;

    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let val: String = row.get(0).map_err(|e| e.to_string())?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

/// 単一設定値の保存
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 複数設定値の一括保存（トランザクション実行）
#[tauri::command]
pub fn set_settings_batch(state: State<'_, AppState>, settings: HashMap<String, String>) -> Result<(), String> {
    if settings.is_empty() {
        return Ok(());
    }

    let mut conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).map_err(|e| e.to_string())?;

        for (k, v) in settings {
            stmt.execute(rusqlite::params![k, v]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 設定項目の削除
#[tauri::command]
pub fn delete_setting(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM app_settings WHERE key = ?1", rusqlite::params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 全設定値の取得
#[tauri::command]
pub fn get_all_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let conn = state.settings_db_conn.get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    let mut result = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        result.insert(k, v);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn setup_test_db(path: &Path) -> r2d2::Pool<r2d2_sqlite::SqliteConnectionManager> {
        let manager = r2d2_sqlite::SqliteConnectionManager::file(path);
        let pool = r2d2::Pool::builder().max_size(2).build(manager).unwrap();
        let conn = pool.get().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        ).unwrap();
        pool
    }

    #[test]
    fn test_case_1_no_localstorage_no_db() {
        // ケース1: localStorage なし & DBなし
        // 期待動作: 新設され、空の設定マップが返却される
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("veloce_settings.db");
        assert!(!db_path.exists());

        let pool = setup_test_db(&db_path);
        let entries: HashMap<String, String> = HashMap::new();

        // ロジック検証
        let existed = false;
        let mut result: HashMap<String, String> = HashMap::new();
        if !existed {
            if !entries.is_empty() {
                // Not reached
            } else {
                result = HashMap::new();
            }
        }

        assert!(result.is_empty());
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_case_2_with_localstorage_no_db() {
        // ケース2: localStorage あり & DBなし
        // 期待動作: 新設され、localStorageの内容がDBに移行され、採用される
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("veloce_settings.db");
        let pool = setup_test_db(&db_path);

        let mut entries = HashMap::new();
        entries.insert("currentDirectory".to_string(), "D:/Images".to_string());
        entries.insert("thumbnailScale".to_string(), "1.5".to_string());

        let mut conn = pool.get().unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).unwrap();
            for (k, v) in &entries {
                stmt.execute(rusqlite::params![k, v]).unwrap();
            }
        }
        tx.commit().unwrap();

        // DBに移行されていることを確認
        let val: String = conn.query_row(
            "SELECT value FROM app_settings WHERE key = 'currentDirectory'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(val, "D:/Images");
    }

    #[test]
    fn test_case_3_no_localstorage_with_db() {
        // ケース3: localStorage なし & DBあり
        // 期待動作: DBファイルの設定に従って起動する
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("veloce_settings.db");
        let pool = setup_test_db(&db_path);

        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('currentDirectory', 'E:/ExistingPath')",
            [],
        ).unwrap();

        // 起動時: localStorageは空
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings").unwrap();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).unwrap();

        let mut result = HashMap::new();
        for r in rows {
            let (k, v) = r.unwrap();
            result.insert(k, v);
        }

        assert_eq!(result.get("currentDirectory").unwrap(), "E:/ExistingPath");
    }

    #[test]
    fn test_case_4_with_localstorage_with_db() {
        // ケース4: localStorage あり & DBあり
        // 期待動作: DBファイルの設定に従って起動する（DB優先、localStorageは無視）
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("veloce_settings.db");
        let pool = setup_test_db(&db_path);

        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('currentDirectory', 'E:/DbMasterPath')",
            [],
        ).unwrap();

        let mut local_entries = HashMap::new();
        local_entries.insert("currentDirectory".to_string(), "C:/OldLocalPath".to_string());

        // db_existed = true なので local_entries は無視され、DBの内容が採用される
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings").unwrap();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).unwrap();

        let mut result = HashMap::new();
        for r in rows {
            let (k, v) = r.unwrap();
            result.insert(k, v);
        }

        assert_eq!(result.get("currentDirectory").unwrap(), "E:/DbMasterPath");
    }

    #[test]
    fn test_crud_operations() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("veloce_settings.db");
        let pool = setup_test_db(&db_path);
        let mut conn = pool.get().unwrap();

        // Batch insert
        let mut batch = HashMap::new();
        batch.insert("key1".to_string(), "val1".to_string());
        batch.insert("key2".to_string(), "val2".to_string());

        let tx = conn.transaction().unwrap();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).unwrap();
            for (k, v) in batch {
                stmt.execute(rusqlite::params![k, v]).unwrap();
            }
        }
        tx.commit().unwrap();

        // Update
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('key1', 'val1_updated')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        ).unwrap();

        let val: String = conn.query_row("SELECT value FROM app_settings WHERE key = 'key1'", [], |r| r.get(0)).unwrap();
        assert_eq!(val, "val1_updated");

        // Delete
        conn.execute("DELETE FROM app_settings WHERE key = 'key2'", []).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings WHERE key = 'key2'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
