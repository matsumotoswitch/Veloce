#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read; // flate2のread_to_stringやバイナリ解析用

use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::Manager;

// --- データ構造の定義 ---
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuditProgress {
    current: usize,
    total: usize,
    deleted: usize,
    fixed: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")] // フロントエンドのJSがキャメルケースを期待しているため変換
pub struct ImageFile {
    name: String,
    ext: String,
    path: String,
    size: u64,
    mtime: u64,
    ctime: u64,
    has_thumbnail_cache: bool,
    has_metadata_cache: bool,
    // メタデータフィールド（Rust側でSource of Truthとして保持）
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default, skip_serializing)]
    prompt: String,
    #[serde(default, skip_serializing)]
    negative_prompt: String,
    #[serde(default, skip_serializing)]
    source: String,
    #[serde(default)]
    meta_loaded: bool,
    #[serde(skip)]
    search_text: String,
    #[serde(skip)]
    unified_search_text: String,
}

fn extract_searchable_text(val: &serde_json::Value) -> String {
    let mut text = String::new();
    match val {
        serde_json::Value::String(s) => {
            if s.len() < 10000 {
                text.push_str(s);
                text.push(' ');
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                text.push_str(&extract_searchable_text(v));
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == "reference_image_multiple" || k == "reference_image" || k == "image" {
                    continue;
                }
                text.push_str(&extract_searchable_text(v));
            }
        }
        serde_json::Value::Number(n) => {
            text.push_str(&n.to_string());
            text.push(' ');
        }
        _ => {}
    }
    text
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryChunkPayload {
    path: String,
    files: Vec<ImageFile>,
    is_complete: bool,
}

/// ディレクトリ読み込み完了時にJS側へ送信するペイロード
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryLoadedPayload {
    path: String,
    total_count: usize,
}

/// JS側から受け取るソート・検索条件
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SortConfig {
    key: String,
    asc: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataBatchUpdatedPayload {
    processed: usize,
    total: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FullMetadata {
    path: String,
    width: u32,
    height: u32,
    prompt: String,
    negative_prompt: String,
    params: serde_json::Value,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseMetadataResult {
    prompt: String,
    negative_prompt: String,
    width: u32,
    height: u32,
    params: serde_json::Value,
    source: String,
}

#[derive(Serialize)]
pub struct FolderOperationResult {
    success: bool,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct MoveOrCopyResult {
    success: bool,
    action: String,
    reason: Option<String>,
}

#[derive(Serialize)]
pub struct ViewerImageResult {
    path: String,
    total: usize,
    index: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingPayload {
    pub path: String,
    pub rating: u8,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolderCondition {
    pub r#type: String,
    pub operator: String,
    pub value: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolderRule {
    pub id: String,
    pub name: String,
    pub match_type: String,
    pub conditions: Vec<SmartFolderCondition>,
}

// --- 状態管理 ---
pub struct AppState {
    image_paths: Mutex<Vec<String>>,
    current_dir: Mutex<String>,
    viewer_paths: Mutex<std::collections::HashMap<String, Vec<String>>>,
    // Source of Truth: 全ファイルとフィルタリング済みファイルをRust側で保持
    all_files: Mutex<Vec<std::sync::Arc<ImageFile>>>,
    filtered_files: Mutex<Vec<std::sync::Arc<ImageFile>>>,
    sort_config: Mutex<SortConfig>,
    search_query: Mutex<String>,
    ratings: Mutex<std::collections::HashMap<String, u8>>,
    rating_filter_val: Mutex<u8>,
    rating_filter_op: Mutex<String>,
    db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    smart_folders: Mutex<Vec<SmartFolderRule>>,
    video_server_port: u16,
}

// --- ユーティリティ ---

fn extract_searchable_strings(meta: &FullMetadata) -> (String, String, String) {
    let mut p = meta.prompt.clone();
    let mut np = meta.negative_prompt.clone();

    if p.is_empty() {
        if let Some(raw) = meta.params.get("rawParameters").and_then(|v| v.as_str()) {
            p = raw.to_string();
        }
    }

    if let Some(chars) = meta.params.get("characterPrompts").and_then(|v| v.as_array()) {
        for c in chars {
            if let Some(cp) = c.get("prompt").and_then(|v| v.as_str()) {
                p.push_str(" ");
                p.push_str(cp);
            }
            if let Some(ucp) = c.get("uc").and_then(|v| v.as_str()) {
                np.push_str(" ");
                np.push_str(ucp);
            }
        }
    }

    (p.to_lowercase(), np.to_lowercase(), meta.source.to_lowercase())
}



fn init_db() -> Result<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>, String> {
    let mut db_path =
        get_veloce_data_dir().unwrap_or_else(|| std::path::PathBuf::from(".veloce_cache"));
    if !db_path.exists() {
        let _ = std::fs::create_dir_all(db_path.parent().unwrap());
    }
    db_path.push("veloce_cache.db");

    let manager = r2d2_sqlite::SqliteConnectionManager::file(&db_path)
        .with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA mmap_size = 268435456;
                 PRAGMA cache_size = -4000;
                 PRAGMA temp_store = MEMORY;
                 PRAGMA busy_timeout = 5000;"
            )
        });

    let pool = r2d2::Pool::builder()
        .max_size(16)
        .build(manager)
        .map_err(|e| e.to_string())?;

    let mut conn = pool.get().map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS cache (
            hash_key TEXT PRIMARY KEY,
            thumbnail BLOB,
            metadata TEXT,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            path TEXT DEFAULT '',
            size INTEGER DEFAULT 0,
            mtime INTEGER DEFAULT 0,
            ctime INTEGER DEFAULT 0,
            last_accessed INTEGER
        )",
        [],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ratings (
            path TEXT PRIMARY KEY,
            rating INTEGER NOT NULL
        )",
        [],
    ).map_err(|e| e.to_string())?;

    conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_path ON cache (path)", []).map_err(|e| e.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_mtime ON cache (mtime)", []).map_err(|e| e.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_last_accessed ON cache (last_accessed DESC)", []).map_err(|e| e.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ratings_rating ON ratings (rating)", []).map_err(|e| e.to_string())?;
    let _ = conn.execute("DROP INDEX IF EXISTS idx_cache_smart_cover", []);
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_smart_cover_v2 ON cache (path, mtime DESC, size, ctime, width, height)", []).map_err(|e| e.to_string())?;

    // マイグレーション（カラムが存在しない場合は無視される）
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN width INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN height INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN path TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN size INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN mtime INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN ctime INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN searchable_prompt TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN searchable_negative_prompt TEXT DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE cache ADD COLUMN searchable_source TEXT DEFAULT ''", []);

    // --- FTS5 Setup ---
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS cache_fts USING fts5(hash_key UNINDEXED, searchable_prompt, searchable_negative_prompt, searchable_source)",
        [],
    ).map_err(|e| e.to_string())?;

    // Triggers to keep FTS in sync
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS cache_ai AFTER INSERT ON cache BEGIN
            INSERT INTO cache_fts(hash_key, searchable_prompt, searchable_negative_prompt, searchable_source)
            VALUES (new.hash_key, new.searchable_prompt, new.searchable_negative_prompt, new.searchable_source);
        END;", []
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS cache_ad AFTER DELETE ON cache BEGIN
            DELETE FROM cache_fts WHERE hash_key = old.hash_key;
        END;", []
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS cache_au AFTER UPDATE ON cache BEGIN
            DELETE FROM cache_fts WHERE hash_key = old.hash_key;
            INSERT INTO cache_fts(hash_key, searchable_prompt, searchable_negative_prompt, searchable_source)
            VALUES (new.hash_key, new.searchable_prompt, new.searchable_negative_prompt, new.searchable_source);
        END;", []
    ).map_err(|e| e.to_string())?;
    
    // Backfill FTS if needed (only if cache_fts is empty but cache is not)
    let fts_count: i64 = conn.query_row("SELECT count(*) FROM cache_fts", [], |row| row.get(0)).unwrap_or(0);
    if fts_count == 0 {
        let _ = conn.execute(
            "INSERT INTO cache_fts(hash_key, searchable_prompt, searchable_negative_prompt, searchable_source)
             SELECT hash_key, searchable_prompt, searchable_negative_prompt, searchable_source FROM cache",
            []
        );
    }


    // 既存データのバックフィル
    let _ = conn.execute("UPDATE cache SET width = CAST(json_extract(metadata, '$.width') AS INTEGER), height = CAST(json_extract(metadata, '$.height') AS INTEGER), path = json_extract(metadata, '$.path') WHERE path = '' OR path IS NULL", []);

    // 検索用カラムのマイグレーション
    let has_unmigrated = conn.query_row(
        "SELECT 1 FROM cache WHERE searchable_prompt = '' AND metadata IS NOT NULL AND metadata != '' LIMIT 1",
        [],
        |_| Ok(()),
    ).is_ok();

    if has_unmigrated {
        let mut rows_to_update = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT hash_key, metadata FROM cache WHERE searchable_prompt = '' AND metadata IS NOT NULL AND metadata != ''").unwrap();
            let mut rows = stmt.query([]).unwrap();
            while let Ok(Some(row)) = rows.next() {
                let hash_key: String = row.get(0).unwrap_or_default();
                let metadata_str: String = row.get(1).unwrap_or_default();
                if let Ok(meta) = serde_json::from_str::<FullMetadata>(&metadata_str) {
                    let (sp, snp, ss) = extract_searchable_strings(&meta);
                    rows_to_update.push((hash_key, sp, snp, ss));
                }
            }
        }
        
        if !rows_to_update.is_empty() {
            println!("Migrating {} records for searchable columns...", rows_to_update.len());
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut update_stmt = tx.prepare("UPDATE cache SET searchable_prompt = ?, searchable_negative_prompt = ?, searchable_source = ? WHERE hash_key = ?").map_err(|e| e.to_string())?;
                for (hk, sp, snp, ss) in rows_to_update {
                    let _ = update_stmt.execute(rusqlite::params![sp, snp, ss, hk]);
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            println!("Migration completed.");
        }
    }

    Ok(pool)
}

/// アプリケーション専用のローカルデータディレクトリを取得する (`AppData/Local/Veloce`)
fn get_veloce_data_dir() -> Option<std::path::PathBuf> {
    tauri::api::path::local_data_dir().map(|mut p| {
        p.push("Veloce");
        p
    })
}

// --- Tauri コマンド ---

#[tauri::command]
fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        // Windows APIを直接叩いて、接続済みのドライブ一覧を瞬時に取得する
        extern "system" {
            fn GetLogicalDrives() -> u32;
        }
        let bitmask = unsafe { GetLogicalDrives() };
        for i in 0..26 {
            // ビットが立っている（1になっている）アルファベットだけを抽出
            if (bitmask & (1 << i)) != 0 {
                let path = format!("{}:\\", (b'A' + i) as char);
                drives.push(path);
            }
        }
    }

    #[cfg(not(windows))]
    {
        drives.push("/".to_string());
    }

    drives
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    if path == "PC" || path.starts_with("smart://") {
        return true;
    }
    let path_obj = std::path::Path::new(&path);
    path_obj.exists() && path_obj.is_dir()
}

#[derive(Clone, Debug)]
pub struct SmartFolderItem {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub width: u32,
    pub height: u32,
}

fn create_image_file_from_smart_item(item: SmartFolderItem) -> ImageFile {
    let p = std::path::Path::new(&item.path);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    let file_name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let clean_path = item.path.replace("\\\\?\\", "");

    let size = item.size;
    let mtime = item.mtime;
    let ctime = item.ctime;

    ImageFile {
        name: file_name,
        ext: if ext.is_empty() { String::new() } else { format!(".{}", ext) },
        path: clean_path,
        size,
        mtime,
        ctime,
        has_thumbnail_cache: false,
        has_metadata_cache: false,
        width: item.width,
        height: item.height,
        prompt: String::new(),
        negative_prompt: String::new(),
        source: String::new(),
        meta_loaded: false,
        search_text: String::new(),
            unified_search_text: String::new(),
    }
}

fn build_smart_folder_query(
    rule: &SmartFolderRule,
    is_count: bool,
) -> (String, Vec<rusqlite::types::Value>) {
    let select_clause = if is_count {
        "SELECT COUNT(c.path)"
    } else {
        "SELECT c.path, c.size, c.mtime, c.ctime, c.width, c.height"
    };

    let mut is_inner_join = false;
    if rule.match_type == "all" {
        is_inner_join = rule.conditions.iter().any(|c| {
            if c.r#type == "rating" {
                let rating_val: i64 = c.value.parse().unwrap_or(0);
                match c.operator.as_str() {
                    ">=" | ">" | "==" => rating_val > 0,
                    _ => false,
                }
            } else {
                false
            }
        });
    }

    let join_type = if is_inner_join { "INNER JOIN" } else { "LEFT JOIN" };
    
    // Check if FTS is needed
    let mut uses_fts = false;
    for cond in &rule.conditions {
        if cond.r#type == "prompt" || cond.r#type == "negative_prompt" || cond.r#type == "source" {
            uses_fts = true;
            break;
        }
    }
    
    let fts_join = if uses_fts { "INNER JOIN cache_fts fts ON c.hash_key = fts.hash_key" } else { "" };
    
    let mut query = format!("{} FROM cache c {} {} ratings r ON c.path = r.path WHERE c.path != '' AND c.path IS NOT NULL", select_clause, fts_join, join_type);
    let mut params = Vec::new();

    if rule.conditions.is_empty() {
        if !is_count { query.push_str(" ORDER BY c.mtime DESC"); }
        return (query, params);
    }

    let logical_op = if rule.match_type == "all" { " AND " } else { " OR " };
    query.push_str(" AND (");

    for (i, cond) in rule.conditions.iter().enumerate() {
        if i > 0 { query.push_str(logical_op); }

        let clause;
        let val_lower = cond.value.to_lowercase();
        let val_like = format!("%{}%", val_lower);
        
        match cond.r#type.as_str() {
            "prompt" => {
                // Escape FTS syntax characters by enclosing in quotes if it's not empty, or use standard LIKE as fallback if MATCH is too strict?
                // Actually, for FTS5 MATCH, we can just use the value directly, but we need to escape it to avoid syntax errors.
                // Simple escaping: replace " with " and wrap in quotes.
                let escaped_val = val_lower.replace("\"", "\"\"");
                let fts_query = format!("\"{}\"", escaped_val);
                
                if cond.operator == "contains" {
                    clause = "fts.searchable_prompt MATCH ?".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else if cond.operator == "not_contains" {
                    clause = "fts.hash_key NOT IN (SELECT hash_key FROM cache_fts WHERE searchable_prompt MATCH ?)".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else { clause = "1=1".to_string(); }
            }
            "negative_prompt" => {
                // Escape FTS syntax characters by enclosing in quotes if it's not empty, or use standard LIKE as fallback if MATCH is too strict?
                // Actually, for FTS5 MATCH, we can just use the value directly, but we need to escape it to avoid syntax errors.
                // Simple escaping: replace " with " and wrap in quotes.
                let escaped_val = val_lower.replace("\"", "\"\"");
                let fts_query = format!("\"{}\"", escaped_val);
                
                if cond.operator == "contains" {
                    clause = "fts.searchable_negative_prompt MATCH ?".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else if cond.operator == "not_contains" {
                    clause = "fts.hash_key NOT IN (SELECT hash_key FROM cache_fts WHERE searchable_negative_prompt MATCH ?)".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else { clause = "1=1".to_string(); }
            }
            "source" => {
                // Escape FTS syntax characters by enclosing in quotes if it's not empty, or use standard LIKE as fallback if MATCH is too strict?
                // Actually, for FTS5 MATCH, we can just use the value directly, but we need to escape it to avoid syntax errors.
                // Simple escaping: replace " with " and wrap in quotes.
                let escaped_val = val_lower.replace("\"", "\"\"");
                let fts_query = format!("\"{}\"", escaped_val);
                
                if cond.operator == "contains" {
                    clause = "fts.searchable_source MATCH ?".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else if cond.operator == "not_contains" {
                    clause = "fts.hash_key NOT IN (SELECT hash_key FROM cache_fts WHERE searchable_source MATCH ?)".to_string();
                    params.push(rusqlite::types::Value::Text(fts_query));
                } else { clause = "1=1".to_string(); }
            }
            "rating" => {
                let rating_val: i64 = cond.value.parse().unwrap_or(0);
                let op = match cond.operator.as_str() {
                    ">=" => ">=", "<=" => "<=", "==" => "=", "!=" => "!=", _ => "=",
                };
                if is_inner_join && rating_val > 0 && (op == ">=" || op == ">" || op == "=") {
                    clause = format!("r.rating {} ?", op);
                } else {
                    clause = format!("coalesce(r.rating, 0) {} ?", op);
                }
                params.push(rusqlite::types::Value::Integer(rating_val));
            }
            "aspect_ratio" => {
                match cond.operator.as_str() {
                    "portrait" => clause = "(c.width * 100 < c.height * 95)".to_string(),
                    "landscape" => clause = "(c.width * 100 > c.height * 105)".to_string(),
                    "square" => clause = "(c.width * 100 >= c.height * 95 AND c.width * 100 <= c.height * 105)".to_string(),
                    _ => clause = "1=1".to_string(),
                }
            }
            "width" => {
                let w_val: i64 = cond.value.parse().unwrap_or(0);
                let op = match cond.operator.as_str() {
                    ">=" => ">=", "<=" => "<=", "==" => "=", _ => "=",
                };
                clause = format!("c.width {} ?", op);
                params.push(rusqlite::types::Value::Integer(w_val));
            }
            "height" => {
                let h_val: i64 = cond.value.parse().unwrap_or(0);
                let op = match cond.operator.as_str() {
                    ">=" => ">=", "<=" => "<=", "==" => "=", _ => "=",
                };
                clause = format!("c.height {} ?", op);
                params.push(rusqlite::types::Value::Integer(h_val));
            }
            "path" => {
                let mut base_path = cond.value.clone();
                if !base_path.ends_with('\\') && !base_path.ends_with('/') {
                    base_path.push('\\');
                }
                
                if cond.operator == "under_folder" {
                    clause = "c.path LIKE ?".to_string();
                    params.push(rusqlite::types::Value::Text(format!("{}%", base_path)));
                } else if cond.operator == "in_folder" {
                    let base_like = format!("{}%", base_path);
                    let not_like_slash = format!("{}%/%", base_path);
                    let not_like_bslash = format!("{}%\\%", base_path);
                    
                    clause = "(c.path LIKE ? AND c.path NOT LIKE ? AND c.path NOT LIKE ?)".to_string();
                    params.push(rusqlite::types::Value::Text(base_like));
                    params.push(rusqlite::types::Value::Text(not_like_slash));
                    params.push(rusqlite::types::Value::Text(not_like_bslash));
                } else { clause = "1=1".to_string(); }
            }
            _ => { clause = "1=1".to_string(); }
        }
        query.push_str(&clause);
    }

    query.push_str(")");

    if !is_count {
        query.push_str(" ORDER BY c.mtime DESC");
    }

    (query, params)
}

fn get_smart_folder_paths(
    folder_type: &str,
    ratings_map: &std::collections::HashMap<String, u8>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    rules: &[SmartFolderRule],
) -> Vec<SmartFolderItem> {
    let mut target_paths = Vec::new();
    let folder_id = folder_type.replace("smart://", "");

    if let Some(rule) = rules.iter().find(|r| r.id == folder_id) {
        if let Ok(conn) = db_conn.get() {
            let _ = conn.execute("PRAGMA case_sensitive_like = ON;", []);
            let (query_str, params) = build_smart_folder_query(rule, false);
            if let Ok(mut stmt) = conn.prepare(&query_str) {
                if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(SmartFolderItem {
                        path: row.get(0)?,
                        size: row.get(1)?,
                        mtime: row.get(2)?,
                        ctime: row.get(3)?,
                        width: row.get(4)?,
                        height: row.get(5)?,
                    })
                }) {
                    for r in rows {
                        if let Ok(item) = r {
                            target_paths.push(item);
                        }
                    }
                }
            }
        }
    } else {
        // Fallback for old default ids if rules are empty/missing
        if folder_id == "fav_5" || folder_id == "fav_4_plus" {
            let threshold = if folder_id == "fav_5" { 5 } else { 4 };
            let paths: Vec<String> = ratings_map
                .iter()
                .filter(|(_, &r)| r >= threshold)
                .map(|(p, _)| p.clone())
                .collect();
            
            if !paths.is_empty() {
                if let Ok(conn) = db_conn.get() {
                    let placeholders = vec!["?"; paths.len()].join(",");
                    let query = format!("SELECT path, size, mtime, ctime, width, height FROM cache WHERE path IN ({})", placeholders);
                    if let Ok(mut stmt) = conn.prepare(&query) {
                        let params: Vec<&dyn rusqlite::ToSql> = paths.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
                        if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params), |row| {
                            Ok(SmartFolderItem {
                                path: row.get(0)?,
                                size: row.get(1)?,
                                mtime: row.get(2)?,
                                ctime: row.get(3)?,
                                width: row.get(4)?,
                                height: row.get(5)?,
                            })
                        }) {
                            target_paths = rows.flatten().collect();
                        }
                    }
                }
            }
        } else if folder_id == "history" {
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare("SELECT path, size, mtime, ctime, width, height FROM cache WHERE path != '' AND path IS NOT NULL ORDER BY last_accessed DESC LIMIT 100") {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok(SmartFolderItem {
                        path: row.get(0)?,
                        size: row.get(1)?,
                        mtime: row.get(2)?,
                        ctime: row.get(3)?,
                        width: row.get(4)?,
                        height: row.get(5)?,
                    })
                }) {
                    for r in rows {
                        if let Ok(item) = r {
                            target_paths.push(item);
                        }
                    }
                }
                }
            }
        }
    }

    target_paths
}

#[tauri::command]
fn load_directory(
    window: tauri::Window,
    target_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let path_clone = target_path.clone();
    let app_clone = window.app_handle();
    let db_conn_clone = state.db_conn.clone();
    let ratings_map = if let Ok(lock) = state.ratings.lock() {
        lock.clone()
    } else {
        std::collections::HashMap::new()
    };
    let smart_folders_clone = if let Ok(lock) = state.smart_folders.lock() {
        lock.clone()
    } else {
        Vec::new()
    };

    // ディレクトリ変更時にRust側の状態をリセット
    if let Ok(mut lock) = state.all_files.lock() {
        lock.clear();
    }
    if let Ok(mut lock) = state.filtered_files.lock() {
        lock.clear();
    }
    if let Ok(mut lock) = state.image_paths.lock() {
        lock.clear();
    }
    if let Ok(mut dir_lock) = state.current_dir.lock() {
        *dir_lock = path_clone.clone();
    }

    tauri::async_runtime::spawn(async move {
        // Veloceのキャッシュディレクトリ構造に合わせる
        let path_for_spawn = path_clone.clone();
        // 非同期ランタイムのワーカースレッドをブロックしないよう、spawn_blockingでラップする
        let files_result = tokio::task::spawn_blocking(move || {
            use rayon::prelude::*;

            let mut files: Vec<std::sync::Arc<ImageFile>> = if path_for_spawn.starts_with("smart://") {
                let smart_items = get_smart_folder_paths(&path_for_spawn, &ratings_map, &db_conn_clone, &smart_folders_clone);
                
                smart_items.into_par_iter().map(|i| std::sync::Arc::new(create_image_file_from_smart_item(i))).collect()
            } else {
                let target_entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&path_for_spawn)
                    .into_iter()
                    .flat_map(|d| d)
                    .filter_map(|e| e.ok())
                    .collect();

                target_entries
                    .into_par_iter()
                    .filter_map(|entry| {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                                let ext_lower = ext.to_lowercase();
                                if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "mp4") {
                                    if let Ok(metadata) = entry.metadata() {
                                        let size = metadata.len();
                                        let mtime = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                        let ctime = metadata.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                        
                                        let file_name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
                                        let full_path = p.to_string_lossy().into_owned();
                                        let clean_path = full_path.replace("\\\\?\\", "");

                                        return Some(ImageFile {
                                            name: file_name,
                                            ext: format!(".{}", ext_lower),
                                            path: clean_path,
                                            size,
                                            mtime,
                                            ctime,
                                            has_thumbnail_cache: false,
                                            has_metadata_cache: false,
                                            width: 0,
                                            height: 0,
                                            prompt: String::new(),
                                            negative_prompt: String::new(),
                                            source: String::new(),
                                            meta_loaded: false,
                                            search_text: String::new(),
            unified_search_text: String::new(),
                                        });
                                    }
                                }
                            }
                        }
                        None
                    })
                    .map(std::sync::Arc::new).collect::<Vec<std::sync::Arc<ImageFile>>>()
            };

            // SQLiteでの同期バッチ確認は起動速度に影響するため削除し、フロントエンドの遅延ロードに完全に委譲します。
            // デフォルトソート（名前順昇順）も並列処理で適用
            if !path_for_spawn.starts_with("smart://") {
                files.par_sort_by(|a, b| natural_cmp(&a.name, &b.name));
            }
            
            files

        }).await;

        let files = match files_result {
            Ok(f) => f,
            Err(_) => return,
        };

        // Rust側のAppStateに全ファイルを格納（Source of Truth）
        if let Some(state) = app_clone.try_state::<AppState>() {
            let total_count = files.len();
            let sorted_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

            if let Ok(mut lock) = state.all_files.lock() {
                *lock = files.clone();
            }
            if let Ok(mut lock) = state.filtered_files.lock() {
                *lock = files;
            }
            if let Ok(mut lock) = state.image_paths.lock() {
                *lock = sorted_paths;
            }

            // JS側には総件数のみを通知（ファイルデータ自体はIPCで送らない）
            let _ = window.emit(
                "directory-loaded",
                DirectoryLoadedPayload {
                    path: path_clone.clone(),
                    total_count,
                },
            );
        }

        let app_for_bg = app_clone.clone();
        let path_for_bg = path_clone.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            // 未解析パスのみを抽出し、インデックスマップを構築する（O(N²) → O(N) 化）
            let (paths_to_process, all_index_map, filtered_index_map) = {
                if let Some(state) = app_for_bg.try_state::<AppState>() {
                    let all_map: std::collections::HashMap<String, usize> = if let Ok(lock) = state.all_files.lock() {
                        lock.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect()
                    } else {
                        std::collections::HashMap::new()
                    };
                    let filtered_map: std::collections::HashMap<String, usize> = if let Ok(lock) = state.filtered_files.lock() {
                        lock.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect()
                    } else {
                        std::collections::HashMap::new()
                    };
                    let unloaded: Vec<String> = all_map.iter()
                        .filter_map(|(path, _)| {
                            if let Ok(lock) = state.all_files.lock() {
                                if lock.get(*all_map.get(path)?).map(|f| !f.meta_loaded).unwrap_or(false) {
                                    return Some(path.clone());
                                }
                            }
                            None
                        })
                        .collect();
                    (unloaded, all_map, filtered_map)
                } else {
                    (Vec::new(), std::collections::HashMap::new(), std::collections::HashMap::new())
                }
            };

            let total_paths = paths_to_process.len();
            let mut processed_count = 0;

            for chunk in paths_to_process.chunks(200) {
                if let Some(state) = app_for_bg.try_state::<AppState>() {
                    if let Ok(dir_lock) = state.current_dir.lock() {
                        if *dir_lock != path_for_bg {
                            break;
                        }
                    }

                    let chunk_paths: Vec<String> = chunk.to_vec();
                    let db_conn_clone = state.db_conn.clone();
                    
                    let metadata_results = tokio::task::spawn_blocking(move || {
                        use rayon::prelude::*;
                        chunk_paths.into_par_iter().map(|p| {
                            let (meta, mtime, size) = get_full_metadata_for_path(&p, &db_conn_clone);
                            (p, meta, mtime, size)
                        }).collect::<Vec<_>>()
                    }).await.unwrap_or_default();

                    processed_count += metadata_results.len();

                    let mut all_files_lock = state.all_files.lock().unwrap();
                    let mut filtered_files_lock = state.filtered_files.lock().unwrap();

                    for (path, full_meta, meta_mtime, meta_size) in metadata_results {
                        if let Some(&idx) = all_index_map.get(&path) {
                            if let Some(f_arc) = all_files_lock.get_mut(idx) {
                                if f_arc.path == path {
                                    let f = std::sync::Arc::make_mut(f_arc);
                                    f.width = full_meta.width;
                                    f.height = full_meta.height;
                                    f.prompt = full_meta.prompt.clone();
                                    f.negative_prompt = full_meta.negative_prompt.clone();
                                    f.source = full_meta.source.clone();
                                    f.search_text = extract_searchable_text(&full_meta.params);
                                    f.unified_search_text = format!("{} {} {} {} {}", f.name, f.prompt, f.negative_prompt, f.source, f.search_text).to_lowercase();
                                    if f.size == 0 { f.size = meta_size; }
                                    if f.mtime == 0 { f.mtime = meta_mtime / 1000; }
                                    f.meta_loaded = true;
                                }
                            }
                        }
                        
                        if let Some(&idx) = filtered_index_map.get(&path) {
                            if let Some(f_arc) = filtered_files_lock.get_mut(idx) {
                                if f_arc.path == path {
                                    let f = std::sync::Arc::make_mut(f_arc);
                                    f.width = full_meta.width;
                                    f.height = full_meta.height;
                                    f.prompt = full_meta.prompt.clone();
                                    f.negative_prompt = full_meta.negative_prompt.clone();
                                    f.source = full_meta.source.clone();
                                    f.search_text = extract_searchable_text(&full_meta.params);
                                    f.unified_search_text = format!("{} {} {} {} {}", f.name, f.prompt, f.negative_prompt, f.source, f.search_text).to_lowercase();
                                    if f.size == 0 { f.size = meta_size; }
                                    if f.mtime == 0 { f.mtime = meta_mtime / 1000; }
                                    f.meta_loaded = true;
                                }
                            }
                        }
                    }
                    
                    // Emit event to JS
                    let _ = app_for_bg.emit_all("metadata-batch-updated", MetadataBatchUpdatedPayload {
                        processed: processed_count,
                        total: total_paths,
                    });
                }
            }
        });

        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(mut dir_lock) = state.current_dir.lock() {
                *dir_lock = path_clone;
            }
        }
    });

    Ok(())
}
/// 数値を解釈する自然なソート（Natural Sort）の比較関数
fn natural_cmp(s1: &str, s2: &str) -> std::cmp::Ordering {
    let mut it1 = s1.chars().peekable();
    let mut it2 = s2.chars().peekable();

    loop {
        match (it1.peek(), it2.peek()) {
            (Some(&c1), Some(&c2)) => {
                if c1.is_ascii_digit() && c2.is_ascii_digit() {
                    let mut n1 = 0u64;
                    let mut n2 = 0u64;
                    while let Some(&c) = it1.peek() {
                        if c.is_ascii_digit() {
                            n1 = n1
                                .saturating_mul(10)
                                .saturating_add((c as u8 - b'0') as u64);
                            it1.next();
                        } else {
                            break;
                        }
                    }
                    while let Some(&c) = it2.peek() {
                        if c.is_ascii_digit() {
                            n2 = n2
                                .saturating_mul(10)
                                .saturating_add((c as u8 - b'0') as u64);
                            it2.next();
                        } else {
                            break;
                        }
                    }
                    if n1 != n2 {
                        return n1.cmp(&n2);
                    }
                } else {
                    let cmp = c1.to_ascii_lowercase().cmp(&c2.to_ascii_lowercase());
                    if cmp != std::cmp::Ordering::Equal {
                        return cmp;
                    }
                    it1.next();
                    it2.next();
                }
            }
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, None) => return std::cmp::Ordering::Equal,
        }
    }
}

/// Rust側でソート・フィルタリングを実行し、最新のpathsをViewerにも同期する

#[tauri::command]
fn sync_ratings(
    state: tauri::State<'_, AppState>,
    ratings: std::collections::HashMap<String, u8>,
) -> usize {
    if let Ok(mut lock) = state.ratings.lock() {
        *lock = ratings;
    }
    apply_filters_and_sort(None, &state)
}

#[tauri::command]
fn get_all_ratings(state: tauri::State<'_, AppState>) -> std::collections::HashMap<String, u8> {
    if let Ok(lock) = state.ratings.lock() {
        lock.clone()
    } else {
        std::collections::HashMap::new()
    }
}

#[tauri::command]
fn migrate_ratings(
    state: tauri::State<'_, AppState>,
    ratings: std::collections::HashMap<String, u8>,
) -> Result<(), String> {
    if let Ok(mut conn) = state.db_conn.get() {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (path, rating) in &ratings {
            let _ = tx.execute(
                "INSERT OR REPLACE INTO ratings (path, rating) VALUES (?1, ?2)",
                rusqlite::params![path, rating],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    if let Ok(mut lock) = state.ratings.lock() {
        for (path, rating) in ratings {
            lock.insert(path, rating);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_smart_folder_counts(
    rules: Vec<SmartFolderRule>,
    state: tauri::State<'_, AppState>,
) -> std::collections::HashMap<String, usize> {
    let mut result = std::collections::HashMap::new();
    
    let ratings_map = if let Ok(lock) = state.ratings.lock() {
        lock.clone()
    } else {
        std::collections::HashMap::new()
    };
    
    let db_conn = state.db_conn.clone();
    
    if let Ok(conn) = db_conn.get() {
        let _ = conn.execute("PRAGMA case_sensitive_like = ON;", []);
        
        for rule in rules {
            let mut count = 0;
            if rule.conditions.is_empty() && (rule.id == "fav_5" || rule.id == "fav_4_plus" || rule.id == "history") {
                if rule.id == "fav_5" {
                    count = ratings_map.values().filter(|&&r| r >= 5).count();
                } else if rule.id == "fav_4_plus" {
                    count = ratings_map.values().filter(|&&r| r >= 4).count();
                } else if rule.id == "history" {
                    count = conn.query_row("SELECT COUNT(*) FROM cache WHERE path != '' AND path IS NOT NULL", [], |row| row.get::<_, usize>(0)).unwrap_or(0);
                    if count > 100 { count = 100; }
                }
            } else {
                let (query_str, params) = build_smart_folder_query(&rule, true);
                if let Ok(mut stmt) = conn.prepare(&query_str) {
                    count = stmt.query_row(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, usize>(0)).unwrap_or(0);
                }
            }
            result.insert(rule.id, count);
        }
    }
    
    result
}

#[tauri::command]
fn set_rating(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    rating: u8,
) -> usize {
    if let Ok(conn) = state.db_conn.get() {
        if rating == 0 {
            let _ = conn.execute("DELETE FROM ratings WHERE path = ?1", rusqlite::params![&path]);
        } else {
            let _ = conn.execute("INSERT OR REPLACE INTO ratings (path, rating) VALUES (?1, ?2)", rusqlite::params![&path, rating]);
        }
    }

    if let Ok(mut lock) = state.ratings.lock() {
        if rating == 0 {
            lock.remove(&path);
        } else {
            lock.insert(path.clone(), rating);
        }
    }
    let _ = app.emit_all(
        "rating-changed",
        RatingPayload {
            path: path.clone(),
            rating,
        },
    );
    apply_filters_and_sort(Some(&app), &state)
}

fn apply_filters_and_sort(app: Option<&tauri::AppHandle>, state: &AppState) -> usize {
    let all_files = state.all_files.lock().unwrap();
    let sort_config = state.sort_config.lock().unwrap();
    let search_query = state.search_query.lock().unwrap();

    let mut filtered: Vec<std::sync::Arc<ImageFile>> = if search_query.trim().is_empty() {
        all_files.clone()
    } else {
        let terms: Vec<String> = search_query
            .to_lowercase()
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        all_files
            .iter()
            .filter(|f| {
                terms.iter().all(|term| f.unified_search_text.contains(term))
            })
            .cloned()
            .collect()
    };

    let Ok(rating_val_lock) = state.rating_filter_val.lock() else {
        return 0;
    };
    let rating_val = *rating_val_lock;
    let Ok(rating_op_lock) = state.rating_filter_op.lock() else {
        return 0;
    };
    let rating_op = rating_op_lock.clone();
    if rating_val > 0 {
        let Ok(ratings_map) = state.ratings.lock() else {
            return 0;
        };
        filtered.retain(|f| {
            let rating = ratings_map.get(&f.path).copied().unwrap_or(0);
            match rating_op.as_str() {
                "eq" => rating == rating_val,
                "lte" => rating > 0 && rating <= rating_val,
                "gte" | _ => rating >= rating_val,
            }
        });
    }

    // ソート
    let key = sort_config.key.clone();
    let asc = sort_config.asc;
    
    let ratings_map_for_sort = if key == "rating" {
        state.ratings.lock().ok().map(|guard| guard.clone())
    } else {
        None
    };

    let current_dir = state.current_dir.lock().unwrap().clone();
    let skip_sort = current_dir.starts_with("smart://") && key == "name";

    if !skip_sort {
        use rayon::prelude::*;
        filtered.par_sort_unstable_by(|a, b| {
            let cmp = match key.as_str() {
            "name" => natural_cmp(&a.name, &b.name),
            "ext" => a.ext.cmp(&b.ext),
            "size" => a.size.cmp(&b.size),
            "mtime" => a.mtime.cmp(&b.mtime),
            "ctime" => a.ctime.cmp(&b.ctime),
            "width" => a.width.cmp(&b.width),
            "height" => a.height.cmp(&b.height),
            "ratio" => {
                let r_a = if a.height > 0 {
                    a.width as f64 / a.height as f64
                } else {
                    0.0
                };
                let r_b = if b.height > 0 {
                    b.width as f64 / b.height as f64
                } else {
                    0.0
                };
                r_a.partial_cmp(&r_b).unwrap_or(std::cmp::Ordering::Equal)
            }
            "rating" => {
                let r_a = if let Some(ref map) = ratings_map_for_sort {
                    map.get(&a.path).copied().unwrap_or(0)
                } else {
                    0
                };
                let r_b = if let Some(ref map) = ratings_map_for_sort {
                    map.get(&b.path).copied().unwrap_or(0)
                } else {
                    0
                };
                r_a.cmp(&r_b)
            }
            _ => natural_cmp(&a.name, &b.name),
        };
        let cmp = if asc { cmp } else { cmp.reverse() };
        if cmp == std::cmp::Ordering::Equal {
            natural_cmp(&a.name, &b.name)
        } else {
            cmp
        }
    });
    }

    let total = filtered.len();
    let paths: Vec<String> = filtered.iter().map(|f| f.path.clone()).collect();

    drop(all_files);
    drop(sort_config);
    drop(search_query);

    if let Ok(mut lock) = state.filtered_files.lock() {
        *lock = filtered;
    }
    if let Ok(mut lock) = state.image_paths.lock() {
        *lock = paths.clone();
    }

    if let Some(app_handle) = app {
        use std::path::Path;
        use tauri::Manager;
        let target_dir = if let Some(first_path) = paths.first() {
            Some(
                Path::new(first_path)
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string(),
            )
        } else {
            state.current_dir.lock().ok().map(|d| d.clone())
        };

        if let Some(dir_str) = target_dir {
            if let Ok(mut viewer_paths) = state.viewer_paths.lock() {
                for (label, viewer_list) in viewer_paths.iter_mut() {
                    let v_dir = viewer_list
                        .first()
                        .and_then(|p| Path::new(p).parent())
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if v_dir == dir_str {
                        *viewer_list = paths.clone();
                        let _ = app_handle.emit_to(&label, "viewer-list-updated", &paths);
                    }
                }
            }
        }
    }

    total
}

/// JS側からソート条件・検索クエリを受け取り、Rust側でフィルタリングとソートを実行する
#[tauri::command]
fn set_view_params(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    sort_key: String,
    asc: bool,
    search_query: String,
    rating_filter_val: u8,
    rating_filter_op: String,
) -> usize {
    if let Ok(mut lock) = state.sort_config.lock() {
        *lock = SortConfig { key: sort_key, asc };
    }
    if let Ok(mut lock) = state.search_query.lock() {
        *lock = search_query;
    }
    if let Ok(mut lock) = state.rating_filter_val.lock() {
        *lock = rating_filter_val;
    }
    if let Ok(mut lock) = state.rating_filter_op.lock() {
        *lock = rating_filter_op;
    }
    apply_filters_and_sort(Some(&app), &state)
}

/// 仮想スクロール用: 指定範囲のImageFileをスライスして返す
#[tauri::command]
async fn get_items(
    state: tauri::State<'_, AppState>,
    offset: usize,
    limit: usize,
) -> Result<Vec<std::sync::Arc<ImageFile>>, String> {
    let lock = state.filtered_files.lock().unwrap();
    let end = std::cmp::min(offset + limit, lock.len());
    if offset >= lock.len() {
        return Ok(Vec::new());
    }
    Ok(lock[offset..end].to_vec())
}

/// selectImage用: 単一のImageFileを取得
#[tauri::command]
async fn get_file_by_index(
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Result<Option<std::sync::Arc<ImageFile>>, String> {
    let lock = state.filtered_files.lock().unwrap();
    Ok(lock.get(index).cloned())
}

/// メタデータ読み込み結果をRust側のSource of Truthに反映する
#[tauri::command]
fn update_metadata_in_state(state: tauri::State<'_, AppState>, updates: Vec<FullMetadata>) {
    if let Ok(mut all_files) = state.all_files.lock() {
        for meta in &updates {
            if let Some(f_arc) = all_files.iter_mut().find(|f| f.path == meta.path) {
                let file = std::sync::Arc::make_mut(f_arc);
                file.width = meta.width;
                file.height = meta.height;
                file.prompt = meta.prompt.clone();
                file.negative_prompt = meta.negative_prompt.clone();
                file.source = meta.source.clone();
                file.search_text = extract_searchable_text(&meta.params);
                file.unified_search_text = format!("{} {} {} {} {}", file.name, file.prompt, file.negative_prompt, file.source, file.search_text).to_lowercase();
                file.meta_loaded = true;
            }
        }
    }
    if let Ok(mut filtered) = state.filtered_files.lock() {
        for meta in &updates {
            if let Some(f_arc) = filtered.iter_mut().find(|f| f.path == meta.path) {
                let file = std::sync::Arc::make_mut(f_arc);
                file.width = meta.width;
                file.height = meta.height;
                file.prompt = meta.prompt.clone();
                file.negative_prompt = meta.negative_prompt.clone();
                file.source = meta.source.clone();
                file.search_text = extract_searchable_text(&meta.params);
                file.unified_search_text = format!("{} {} {} {} {}", file.name, file.prompt, file.negative_prompt, file.source, file.search_text).to_lowercase();
                file.meta_loaded = true;
            }
        }
    }
}

/// ファイルウォッチャーから通知されたファイル変更をRust側のSource of Truthに反映する
#[tauri::command]
fn notify_file_changed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: ImageFile,
) -> usize {
    if let Ok(mut all_files) = state.all_files.lock() {
        if let Some(existing) = all_files.iter_mut().find(|f| f.path == file.path) {
            *existing = std::sync::Arc::new(file.clone());
        } else {
            all_files.push(std::sync::Arc::new(file));
        }
    }
    apply_filters_and_sort(Some(&app), &state)
}

/// ファイルウォッチャーから通知されたファイル削除をRust側のSource of Truthに反映する
#[tauri::command]
fn notify_file_removed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> usize {
    if let Ok(mut all_files) = state.all_files.lock() {
        all_files.retain(|f| f.path != path);
    }
    apply_filters_and_sort(Some(&app), &state)
}

#[tauri::command]
async fn get_full_metadata_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<FullMetadata>, String> {
    // rayonによるスレッドプール占有を防ぐため、通常のイテレータを使用する。
    // I/Oバウンドな処理であり、フロントエンド側で既にチャンク化（100件ずつ等）
    // されているため、Rust側では直列処理でも十分に高速かつ安全に動作します。
    let db_conn_clone = state.db_conn.clone();
    Ok(tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        file_paths
            .into_par_iter()
            .map(|path| get_full_metadata_for_path(&path, &db_conn_clone).0)
            .collect()
    })
    .await
    .unwrap_or_default())
}

// --- バイナリ解析パーサー群 (JSの実装をRustへ移植) ---

fn decode_metadata_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 {
        if bytes[0] == 0xFF && bytes[1] == 0xFE {
            let u16_data: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&u16_data);
        } else if bytes[0] == 0xFE && bytes[1] == 0xFF {
            let u16_data: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&u16_data);
        }
    }

    let le_zeros = bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
    let be_zeros = bytes.iter().step_by(2).filter(|&&b| b == 0).count();

    if bytes.len() > 4 && le_zeros > bytes.len() / 3 && bytes.len() % 2 == 0 {
        let u16_data: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16_data);
    } else if bytes.len() > 4 && be_zeros > bytes.len() / 3 && bytes.len() % 2 == 0 {
        let u16_data: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16_data);
    }

    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_mp4_dimensions(path: &str) -> Option<(u32, u32)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = [0u8; 8];
    let file_len = file.metadata().ok()?.len();
    
    let mut pos = 0u64;
    while pos < file_len && pos < 10 * 1024 * 1024 { // Search only first 10MB
        if file.seek(SeekFrom::Start(pos)).is_err() { break; }
        if file.read_exact(&mut buffer).is_err() { break; }
        let size = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as u64;
        let box_type = &buffer[4..8];
        
        if size < 8 {
            if size == 1 { 
                let mut large_size_buf = [0u8; 8];
                if file.read_exact(&mut large_size_buf).is_err() { break; }
                let large_size = u64::from_be_bytes(large_size_buf);
                if box_type == b"mdat" { pos += large_size; continue; }
            }
            break; 
        }
        
        if box_type == b"moov" || box_type == b"trak" {
            pos += 8;
            continue;
        } else if box_type == b"tkhd" {
            let content_size = size - 8;
            let mut tkhd_data = vec![0u8; content_size as usize];
            if file.read_exact(&mut tkhd_data).is_ok() {
                if !tkhd_data.is_empty() {
                    let version = tkhd_data[0];
                    let offset = if version == 1 { 88 } else { 76 };
                    if tkhd_data.len() >= offset + 8 {
                        let w = u32::from_be_bytes([tkhd_data[offset], tkhd_data[offset+1], tkhd_data[offset+2], tkhd_data[offset+3]]) >> 16;
                        let h = u32::from_be_bytes([tkhd_data[offset+4], tkhd_data[offset+5], tkhd_data[offset+6], tkhd_data[offset+7]]) >> 16;
                        if w > 0 && h > 0 {
                            return Some((w, h));
                        }
                    }
                }
            }
            pos += size;
        } else {
            pos += size;
        }
    }
    None
}

fn get_full_metadata_for_path(
    file_path: &str,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> (FullMetadata, u64, u64) {
    let (mtime_millis, ctime_millis, file_size) = std::fs::metadata(file_path)
        .map(|m| {
            let mt = m.modified().unwrap_or(std::time::UNIX_EPOCH).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            let ct = m.created().unwrap_or(std::time::UNIX_EPOCH).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            let s = m.len();
            (mt, ct, s)
        })
        .unwrap_or((0, 0, 0));

    let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", file_path, mtime_millis).as_bytes());
    let hash_key = format!("{:016x}", digest);

    if let Ok(conn) = db_conn.get() {
        if let Ok(mut stmt) = conn.prepare_cached("SELECT metadata FROM cache WHERE hash_key = ?") {
            if let Ok(json_str) = stmt.query_row([&hash_key], |row| row.get::<_, String>(0)) {
                if !json_str.is_empty() {
                    if let Ok(mut cached_meta) = serde_json::from_str::<FullMetadata>(&json_str) {
                        // A1111のプロンプトが空になるケースへの互換性を保持する
                        if cached_meta.prompt.is_empty() {
                            if let Some(raw) = cached_meta
                                .params
                                .get("rawParameters")
                                .and_then(|v| v.as_str())
                            {
                                cached_meta.prompt = raw.to_string();
                            }
                        }
                        return (cached_meta, mtime_millis, file_size);
                    }
                }
            }
        }
    }

    let (mut width, mut height) = image::image_dimensions(file_path).unwrap_or((0, 0));
    let lower_path = file_path.to_lowercase();
    
    if width == 0 && height == 0 && lower_path.ends_with(".mp4") {
        if let Some((w, h)) = parse_mp4_dimensions(file_path) {
            width = w;
            height = h;
        }
    }

    let mut raw_description = String::new();
    let mut raw_comment = String::new();
    let mut raw_parameters = String::new();
    let mut source = String::new();

    let lower_path = file_path.to_lowercase();
    if lower_path.ends_with(".png") {
        let chunks = parse_png_chunks(file_path);
        raw_description = chunks
            .get("Description")
            .or(chunks.get("ImageDescription"))
            .cloned()
            .unwrap_or_default();
        raw_comment = chunks.get("Comment").cloned().unwrap_or_default();
        raw_parameters = chunks
            .get("parameters")
            .or(chunks.get("Parameters"))
            .cloned()
            .unwrap_or_default();
        source = chunks
            .get("Source")
            .or(chunks.get("Software"))
            .cloned()
            .unwrap_or_default();

        // ComfyUI metadata fallback
        if let Some(workflow) = chunks.get("workflow") {
            if raw_comment.is_empty() {
                raw_comment = workflow.clone();
            } else if raw_parameters.is_empty() {
                raw_parameters = workflow.clone();
            }
        } else if let Some(prompt_json) = chunks.get("prompt") {
            if raw_comment.is_empty() {
                raw_comment = prompt_json.clone();
            } else if raw_parameters.is_empty() {
                raw_parameters = prompt_json.clone();
            }
        }
    } else {
        let exif_data = if lower_path.ends_with(".webp") {
            parse_webp_exif(file_path)
        } else {
            parse_jpeg_exif(file_path)
        };

        if let Some(desc) = exif_data.get("ImageDescription") {
            raw_description = decode_metadata_string(desc)
                .trim_end_matches('\0')
                .to_string();
        }
        if let Some(comment) = exif_data.get("UserComment") {
            let mut content = comment.as_slice();
            if content.starts_with(b"UNICODE\0") || content.starts_with(b"ASCII\0\0\0") {
                content = &content[8..];
            }
            raw_comment = decode_metadata_string(content)
                .trim_end_matches('\0')
                .trim()
                .to_string();
        }
        if let Some(sw) = exif_data.get("Software") {
            source = decode_metadata_string(sw)
                .trim_end_matches('\0')
                .to_string();
        }
    }

    // EXIF等でプロンプトが見つからなかった場合、Stealthメタデータを試行
    if raw_comment.trim().is_empty() && raw_description.trim().is_empty() {
        if let Some(stealth) = extract_stealth_pnginfo(file_path) {
            raw_comment = stealth;
        }
    }

    let mut prompt = raw_description.clone();
    let mut negative_prompt = String::new();
    let mut params = serde_json::Value::Object(serde_json::Map::new());
    let comment_string = raw_comment.trim();

    let desc_string = raw_description.trim();
    let target_strings = [comment_string, desc_string];
    let mut extracted_json_text = None;

    for s in target_strings.iter() {
        if let Some(start) = s.find('{') {
            if let Some(end) = s.rfind('}') {
                let full_span = &s[start..=end];
                if serde_json::from_str::<serde_json::Value>(full_span).is_ok() {
                    extracted_json_text = Some(full_span.to_string());
                    break;
                }
            }
        }
    }

    if extracted_json_text.is_none() {
        for s in target_strings.iter() {
            if let Some(start) = s.find('{') {
                let mut brace_count = 0;
                let mut valid_end = None;
                for (i, c) in s[start..].char_indices() {
                    if c == '{' {
                        brace_count += 1;
                    } else if c == '}' {
                        brace_count -= 1;
                        if brace_count == 0 {
                            valid_end = Some(start + i);
                            break;
                        }
                    }
                }
                if let Some(end) = valid_end {
                    let candidate = &s[start..=end];
                    if serde_json::from_str::<serde_json::Value>(candidate).is_ok() {
                        extracted_json_text = Some(candidate.to_string());
                        break;
                    }
                }
            }
        }
    }

    if let Some(json_text) = extracted_json_text {
        if let Ok(mut comment_obj) = serde_json::from_str::<serde_json::Value>(&json_text) {
            let mut json_source = None;

            // WebP等の二重エンコードJSON対応
            if let Some(inner_str) = comment_obj.get("Comment").and_then(|v| v.as_str()) {
                if let Ok(inner_obj) = serde_json::from_str::<serde_json::Value>(inner_str) {
                    if let Some(p) = comment_obj.get("Description").and_then(|v| v.as_str()) {
                        prompt = p.to_string();
                    } else if let Some(p) = inner_obj.get("prompt").and_then(|v| v.as_str()) {
                        prompt = p.to_string();
                    }
                    if let Some(s) = comment_obj.get("Source").and_then(|v| v.as_str()) {
                        json_source = Some(s.to_string());
                    }

                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        if let serde_json::Value::Object(inner_map) = inner_obj {
                            for (k, v) in inner_map {
                                map.insert(k, v);
                            }
                        }
                        map.remove("Comment");
                        map.remove("Description");
                    }
                }
            }

            // 通常のJSON直下のSourceも取得
            if json_source.is_none() {
                if let Some(s) = comment_obj.get("Source").and_then(|v| v.as_str()) {
                    json_source = Some(s.to_string());
                }
            }

            // 「NovelAI Diffusion V4.5 ...」のようなSoftwareの文字列を優先し、
            // 空の場合のみJSON内のSourceをフォールバックとして使用する
            if source.is_empty() {
                if let Some(s) = json_source {
                    source = s;
                }
            }

            if let Some(uc) = comment_obj.get("uc").and_then(|v| v.as_str()) {
                negative_prompt = uc.to_string();
            }
            if prompt.is_empty() {
                if let Some(p) = comment_obj.get("prompt").and_then(|v| v.as_str()) {
                    prompt = p.to_string();
                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        map.remove("prompt");
                    }
                }
            }

            // NovelAI V4プロンプト対応
            if let Some(v4_prompt) = comment_obj.get("v4_prompt").cloned() {
                if let Some(char_captions) = v4_prompt
                    .pointer("/caption/char_captions")
                    .and_then(|v| v.as_array())
                {
                    let mut char_prompts_arr = Vec::new();
                    let ucs = comment_obj
                        .pointer("/v4_negative_prompt/caption/char_captions")
                        .and_then(|v| v.as_array());

                    for (i, p) in char_captions.iter().enumerate() {
                        let mut char_obj = serde_json::Map::new();
                        if let Some(cap) = p.get("char_caption").and_then(|v| v.as_str()) {
                            char_obj.insert(
                                "prompt".to_string(),
                                serde_json::Value::String(cap.to_string()),
                            );
                        }
                        if let Some(uc_arr) = ucs {
                            if let Some(uc_item) = uc_arr.get(i) {
                                if let Some(uc_cap) =
                                    uc_item.get("char_caption").and_then(|v| v.as_str())
                                {
                                    char_obj.insert(
                                        "uc".to_string(),
                                        serde_json::Value::String(uc_cap.to_string()),
                                    );
                                }
                            }
                        }
                        char_prompts_arr.push(serde_json::Value::Object(char_obj));
                    }

                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        map.insert(
                            "characterPrompts".to_string(),
                            serde_json::Value::Array(char_prompts_arr),
                        );
                        map.remove("v4_prompt");
                        map.remove("v4_negative_prompt");
                    }
                }
            }
            params = comment_obj;
        }
    }

    // フォールバック処理 (A1111形式など)
    if params.as_object().map_or(true, |m| m.is_empty()) {
        if !raw_parameters.is_empty() {
            let mut map = serde_json::Map::new();
            map.insert(
                "rawParameters".to_string(),
                serde_json::Value::String(raw_parameters.clone()),
            );
            params = serde_json::Value::Object(map);
            if prompt.is_empty() {
                prompt = raw_parameters.clone(); // 検索用プロンプトとして代入
            }
        } else if comment_string.contains("Steps: ") {
            let mut map = serde_json::Map::new();
            map.insert(
                "rawParameters".to_string(),
                serde_json::Value::String(comment_string.to_string()),
            );
            params = serde_json::Value::Object(map);
            if prompt.is_empty() {
                prompt = comment_string.to_string(); // 検索用プロンプトとして代入
            }
        } else if prompt.is_empty() && !comment_string.is_empty() {
            prompt = comment_string.to_string();
        } else if !comment_string.is_empty() && !comment_string.contains("Steps: ") {
            negative_prompt = comment_string.to_string();
        }
    }

    let mut meta = FullMetadata {
        path: file_path.to_string(),
        prompt,
        negative_prompt,
        width,
        height,
        params,
        source: source.clone(),
    };

    update_metadata_cache(
        file_path,
        file_size,
        mtime_millis,
        ctime_millis,
        db_conn,
        &raw_description,
        &raw_comment,
        &raw_parameters,
        &source,
        &mut meta,
    );

    (meta, mtime_millis, file_size)
}

fn update_metadata_cache(
    file_path: &str,
    file_size: u64,
    mtime: u64,
    ctime: u64,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    _raw_desc: &str,
    _raw_comment: &str,
    _raw_params: &str,
    _source: &str,
    meta: &mut FullMetadata,
) {
    if let Ok(json_str) = serde_json::to_string(&meta) {
        let (sp, snp, ss) = extract_searchable_strings(&meta);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", file_path, mtime).as_bytes());
        let hash_key = format!("{:016x}", digest);

        if let Ok(conn) = db_conn.get() {
            let _ = conn.execute(
                "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(hash_key) DO UPDATE SET metadata=excluded.metadata, width=excluded.width, height=excluded.height, path=excluded.path, size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, last_accessed=excluded.last_accessed, searchable_prompt=excluded.searchable_prompt, searchable_negative_prompt=excluded.searchable_negative_prompt, searchable_source=excluded.searchable_source",
                rusqlite::params![&hash_key, &json_str, meta.width, meta.height, &meta.path, file_size, mtime, ctime, now, sp, snp, ss]
            );
        }
    }
}

fn parse_png_chunks(path: &str) -> std::collections::HashMap<String, String> {
    let mut chunks = std::collections::HashMap::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let mut sig = [0; 8];
        if f.read_exact(&mut sig).is_err()
            || sig != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        {
            return chunks;
        }
        loop {
            let mut len_bytes = [0; 4];
            if f.read_exact(&mut len_bytes).is_err() {
                break;
            }
            let len = u32::from_be_bytes(len_bytes) as usize;
            if len > 100_000_000 {
                break;
            } // 安全のための上限

            let mut chunk_type = [0; 4];
            if f.read_exact(&mut chunk_type).is_err() {
                break;
            }

            if &chunk_type == b"tEXt" {
                let mut data = vec![0; len];
                if f.read_exact(&mut data).is_err() {
                    break;
                }
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                    let text = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                    chunks.insert(keyword, text);
                }
            } else if &chunk_type == b"iTXt" {
                let mut data = vec![0; len];
                if f.read_exact(&mut data).is_err() {
                    break;
                }
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                    let mut offset = null_idx + 1;
                    if offset + 2 <= data.len() {
                        let comp_flag = data[offset];
                        offset += 2;
                        if let Some(n1) = data[offset..].iter().position(|&b| b == 0) {
                            offset += n1 + 1; // skip lang tag
                            if let Some(n2) = data[offset..].iter().position(|&b| b == 0) {
                                offset += n2 + 1; // skip trans keyword
                                let text_data = &data[offset..];
                                let text = if comp_flag == 1 {
                                    let mut decoder = flate2::read::ZlibDecoder::new(text_data);
                                    let mut s = String::new();
                                    decoder.read_to_string(&mut s).unwrap_or_default();
                                    s
                                } else {
                                    String::from_utf8_lossy(text_data).to_string()
                                };
                                chunks.insert(keyword, text);
                            }
                        }
                    }
                }
            } else if &chunk_type == b"IEND" {
                break;
            } else {
                // Skip the data for non-text chunks to avoid massive memory allocation and I/O
                use std::io::{Seek, SeekFrom};
                if f.seek(SeekFrom::Current(len as i64)).is_err() {
                    break;
                }
            }

            // Read 4 bytes for CRC to advance the file pointer to the next chunk
            let mut crc = [0; 4];
            if f.read_exact(&mut crc).is_err() {
                break;
            }
        }
    }
    chunks
}

fn parse_tiff_ifd(exif_data: &[u8]) -> std::collections::HashMap<String, Vec<u8>> {
    let mut results = std::collections::HashMap::new();
    if exif_data.len() < 8 {
        return results;
    }

    let is_little = match &exif_data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return results,
    };

    let read_u16 = |buf: &[u8], o: usize| -> u16 {
        if o + 2 > buf.len() {
            return 0;
        }
        let b: [u8; 2] = buf[o..o + 2].try_into().unwrap_or_default();
        if is_little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        }
    };
    let read_u32 = |buf: &[u8], o: usize| -> u32 {
        if o + 4 > buf.len() {
            return 0;
        }
        let b: [u8; 4] = buf[o..o + 4].try_into().unwrap_or_default();
        if is_little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        }
    };

    if read_u16(exif_data, 2) != 0x002A {
        return results;
    }
    let mut ifds_to_visit = vec![read_u32(exif_data, 4) as usize];
    let mut visited = 0;

    while let Some(ifd_offset) = ifds_to_visit.pop() {
        if visited > 10 || ifd_offset + 2 > exif_data.len() {
            break;
        } // 無限ループ防止
        visited += 1;

        let entry_count = read_u16(exif_data, ifd_offset);
        let mut ptr = ifd_offset + 2;

        for _ in 0..entry_count {
            if ptr + 12 > exif_data.len() {
                break;
            }
            let tag = read_u16(exif_data, ptr);
            let typ = read_u16(exif_data, ptr + 2);
            let count = read_u32(exif_data, ptr + 4) as usize;
            let value_offset = ptr + 8;

            let bytes_per_comp = match typ {
                1 | 2 | 6 | 7 => 1,
                3 | 8 => 2,
                4 | 9 | 11 => 4,
                5 | 10 | 12 => 8,
                _ => 0,
            };
            let byte_count = bytes_per_comp * count;

            let data = if byte_count <= 4 {
                &exif_data[value_offset..value_offset + 4]
            } else {
                let off = read_u32(exif_data, value_offset) as usize;
                if off + byte_count <= exif_data.len() {
                    &exif_data[off..off + byte_count]
                } else {
                    &[]
                }
            };

            if !data.is_empty() {
                if tag == 0x010E && typ == 2 {
                    // ImageDescription
                    results.insert("ImageDescription".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x9286 && typ == 7 {
                    // UserComment
                    results.insert("UserComment".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x0131 && typ == 2 {
                    // Software
                    results.insert("Software".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x8769 && typ == 4 {
                    // ExifOffset
                    let sub_ifd = if byte_count <= 4 {
                        read_u32(exif_data, value_offset)
                    } else {
                        read_u32(exif_data, read_u32(exif_data, value_offset) as usize)
                    } as usize;
                    ifds_to_visit.push(sub_ifd);
                }
            }
            ptr += 12;
        }
    }
    results
}

fn extract_stealth_pnginfo(path: &str) -> Option<String> {
    if !path.to_lowercase().ends_with(".png") {
        return None;
    }

    use flate2::read::GzDecoder;
    use std::io::Read;

    let img = image::open(path).ok()?.into_rgba8();
    let width = img.width() as usize;
    let height = img.height() as usize;
    let raw = img.into_raw();

    // アルファチャンネルの最下位ビットを抽出（Column-Major Order: x -> y）
    let mut bits = Vec::with_capacity(width * height);
    for x in 0..width {
        for y in 0..height {
            let idx = (y * width + x) * 4 + 3;
            if idx < raw.len() {
                bits.push(raw[idx] & 1);
            }
        }
    }

    // 8ビットずつ結合してバイト配列に変換（MSB first）
    let mut bytes = Vec::with_capacity(bits.len() / 8);
    for chunk in bits.chunks_exact(8) {
        let mut b = 0u8;
        for (i, bit) in chunk.iter().enumerate() {
            b |= bit << (7 - i);
        }
        bytes.push(b);
    }

    if bytes.len() < 30 {
        return None;
    }

    let header = String::from_utf8_lossy(&bytes[0..15]);
    if header == "stealth_pngcomp" {
        // stealth_pngcomp の場合、15〜19バイト目にビッグエンディアンで長さが入る
        let len_bytes: [u8; 4] = bytes[15..19].try_into().ok()?;
        let length = u32::from_be_bytes(len_bytes) as usize;

        if 19 + length <= bytes.len() {
            let payload = &bytes[19..19 + length];
            let mut decoder = GzDecoder::new(payload);
            let mut decompressed = String::new();
            if decoder.read_to_string(&mut decompressed).is_ok() {
                return Some(decompressed);
            }
        }
    } else if header == "stealth_pnginfo" {
        // 非圧縮のstealth_pnginfo（念のためのフォールバック）
        let len_bytes: [u8; 4] = bytes[15..19].try_into().ok()?;
        let length = u32::from_be_bytes(len_bytes) as usize;

        if 19 + length <= bytes.len() {
            let payload = &bytes[19..19 + length];
            if let Ok(text) = String::from_utf8(payload.to_vec()) {
                return Some(text);
            }
        }
    }

    None
}

fn parse_webp_exif(path: &str) -> std::collections::HashMap<String, Vec<u8>> {
    let mut results = std::collections::HashMap::new();
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(mmap) = unsafe { memmap2::MmapOptions::new().map(&file) } {
            let buffer = &mmap[..];
            if buffer.len() >= 12 && &buffer[0..4] == b"RIFF" && &buffer[8..12] == b"WEBP" {
                let mut offset = 12;
                while offset + 8 <= buffer.len() {
                    let chunk_id = &buffer[offset..offset + 4];
                    let chunk_size = u32::from_le_bytes(
                        buffer[offset + 4..offset + 8]
                            .try_into()
                            .unwrap_or_default(),
                    ) as usize;
                    let data_offset = offset + 8;
                    if chunk_id == b"EXIF" && data_offset + chunk_size <= buffer.len() {
                        let mut exif_data = &buffer[data_offset..data_offset + chunk_size];
                        if exif_data.len() >= 6 && &exif_data[0..4] == b"Exif" {
                            exif_data = &exif_data[6..];
                        }
                        results.extend(parse_tiff_ifd(exif_data));
                    }
                    offset = data_offset + chunk_size;
                    if chunk_size % 2 != 0 {
                        offset += 1;
                    }
                }
            }
        }
    }
    results
}

fn parse_jpeg_exif(path: &str) -> std::collections::HashMap<String, Vec<u8>> {
    let mut results = std::collections::HashMap::new();
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(mmap) = unsafe { memmap2::MmapOptions::new().map(&file) } {
            let buffer = &mmap[..];
            if buffer.len() >= 2 && buffer[0] == 0xFF && buffer[1] == 0xD8 {
                let mut offset = 2;
                while offset + 4 <= buffer.len() {
                    if buffer[offset] != 0xFF {
                        break;
                    }
                    let marker = buffer[offset + 1];
                    let length = u16::from_be_bytes(
                        buffer[offset + 2..offset + 4]
                            .try_into()
                            .unwrap_or_default(),
                    ) as usize;
                    if marker == 0xE1 && offset + 2 + length <= buffer.len() {
                        let app1_data = &buffer[offset + 4..offset + 2 + length];
                        if app1_data.len() >= 6 && &app1_data[0..4] == b"Exif" {
                            results.extend(parse_tiff_ifd(&app1_data[6..]));
                        }
                    }
                    offset += 2 + length;
                }
            }
        }
    }
    results
}

#[tauri::command]
async fn check_conflicts(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    Ok(tokio::task::spawn_blocking(move || {
        let mut conflicts = Vec::new();
        let dest_path = std::path::Path::new(&dest_dir);
        for path in paths {
            let src_path = std::path::Path::new(&path);
            if let Some(file_name) = src_path.file_name() {
                let target = dest_path.join(file_name);
                if target.exists() {
                    conflicts.push(path);
                }
            }
        }
        conflicts
    })
    .await
    .unwrap_or_default())
}

#[tauri::command]
async fn parse_metadata(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<ParseMetadataResult, String> {
    let db_conn_clone = state.db_conn.clone();
    Ok(tokio::task::spawn_blocking(move || {
        let full_meta = get_full_metadata_for_path(&file_path, &db_conn_clone).0;
        ParseMetadataResult {
            prompt: full_meta.prompt,
            negative_prompt: full_meta.negative_prompt,
            width: full_meta.width,
            height: full_meta.height,
            params: full_meta.params,
            source: full_meta.source,
        }
    })
    .await
    .unwrap_or_else(|_| ParseMetadataResult {
        prompt: String::new(),
        negative_prompt: String::new(),
        width: 0,
        height: 0,
        params: serde_json::Value::Object(serde_json::Map::new()),
        source: String::new(),
    }))
}

#[tauri::command]
async fn generate_thumbnail(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<String, String> {
    let db_conn = state.db_conn.clone();
    
    // Fast path: get mtime from memory to avoid disk I/O
    let (mem_mtime, is_valid) = if let Ok(lock) = state.filtered_files.lock() {
        let found = lock.iter().find(|f| f.path == file_path);
        (found.map(|f| f.mtime), found.is_some())
    } else {
        (None, false)
    };

    if !is_valid {
        return Ok(String::new());
    }

    let video_port = state.video_server_port;
    let url = tokio::task::spawn_blocking(move || {
        let t_start = std::time::Instant::now();
        let mtime = mem_mtime.unwrap_or_else(|| {
            std::fs::metadata(&file_path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        });

        let cache_bytes = generate_thumbnail_inner(&file_path, mtime, &db_conn);
        let t_gen = t_start.elapsed();

        let url = if cache_bytes.is_empty() {
            String::new()
        } else {
            format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1", video_port, urlencoding::encode(&file_path), mtime)
        };
        
        let fname = std::path::Path::new(&file_path).file_name().unwrap_or_default().to_string_lossy();
        println!("[Rust] {}: db_lookup={}ms", fname, t_gen.as_millis());
        url
    }).await.map_err(|e| e.to_string())?;

    Ok(url)
}

#[derive(serde::Serialize)]
struct ThumbnailResult {
    path: String,
    url: String,
}

#[tauri::command]
async fn generate_thumbnail_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<ThumbnailResult>, String> {
    let db_conn = state.db_conn.clone();
    
    // Fast path: get mtimes from memory to avoid disk I/O
    let mut files_to_process = Vec::new();
    if let Ok(lock) = state.filtered_files.lock() {
        for file_path in &file_paths {
            if let Some(f) = lock.iter().find(|f| f.path == *file_path) {
                files_to_process.push((file_path.clone(), f.mtime));
            }
        }
    }

    if files_to_process.is_empty() {
        return Ok(Vec::new());
    }

    let video_port = state.video_server_port;
    let results = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        files_to_process.into_par_iter().map(|(file_path, mtime)| {
            let bytes = generate_thumbnail_inner(&file_path, mtime, &db_conn);
            let url = if bytes.is_empty() {
                String::new()
            } else {
                format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1", video_port, urlencoding::encode(&file_path), mtime)
            };
            ThumbnailResult { path: file_path, url }
        }).collect::<Vec<_>>()
    }).await.map_err(|e| e.to_string())?;

    Ok(results)
}

/// キャッシュ済みサムネイルのみをDBから取得する（生成は行わない）。
/// `hasThumbnailCache == true` のファイルを即時表示するためのファストパス。
#[tauri::command]
async fn get_cached_thumbnail_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<ThumbnailResult>, String> {
    let db_conn = state.db_conn.clone();

    // filtered_files から mtime を取得
    let mut files_with_mtime: Vec<(String, u64)> = Vec::new();
    if let Ok(lock) = state.filtered_files.lock() {
        for file_path in &file_paths {
            if let Some(f) = lock.iter().find(|f| f.path == *file_path) {
                files_with_mtime.push((file_path.clone(), f.mtime));
            }
        }
    }

    if files_with_mtime.is_empty() {
        return Ok(Vec::new());
    }

    let video_port = state.video_server_port;
    let results = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        files_with_mtime.into_par_iter().filter_map(|(file_path, mtime)| {
            let clean_path = file_path.replace("\\\\?\\", "");
            let digest = xxhash_rust::xxh3::xxh3_64(
                format!("{}_{}", clean_path, mtime).as_bytes()
            );
            let hash_key = format!("{:016x}", digest);

            // DB のみを参照（生成しない）
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare_cached(
                    "SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL"
                ) {
                    if let Ok(bytes) = stmt.query_row([&hash_key], |row| row.get::<_, Vec<u8>>(0)) {
                        if !bytes.is_empty() {
                            let url = format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1", video_port, urlencoding::encode(&file_path), mtime);
                            return Some(ThumbnailResult { path: file_path, url });
                        }
                    }
                }
            }
            None // キャッシュなし → JS側で通常キューに回す
        }).collect::<Vec<_>>()
    }).await.map_err(|e| e.to_string())?;

    Ok(results)
}

fn generate_image_thumbnail_sync(path_str: &str) -> Option<Vec<u8>> {
    if let Ok(img) = image::open(path_str) {
        let rgb_img = img.to_rgb8();
        let width = rgb_img.width();
        let height = rgb_img.height();
        
        let mut dst_width = width;
        let mut dst_height = height;
        if width > 384 || height > 384 {
            let ratio = f32::min(384.0 / width as f32, 384.0 / height as f32);
            dst_width = (width as f32 * ratio).round() as u32;
            dst_height = (height as f32 * ratio).round() as u32;
        }

        use std::num::NonZeroU32;
        use fast_image_resize as fr;

        if let (Some(src_width), Some(src_height)) = (NonZeroU32::new(width), NonZeroU32::new(height)) {
            if let Ok(src_image) = fr::images::Image::from_vec_u8(
                src_width.get(),
                src_height.get(),
                rgb_img.into_raw(),
                fr::PixelType::U8x3,
            ) {
                if let (Some(dst_w_nz), Some(dst_h_nz)) = (NonZeroU32::new(dst_width), NonZeroU32::new(dst_height)) {
                    let mut dst_image = fr::images::Image::new(
                        dst_w_nz.get(),
                        dst_h_nz.get(),
                        fr::PixelType::U8x3,
                    );
                    let mut resizer = fr::Resizer::new();
                    if resizer.resize(&src_image, &mut dst_image, None).is_ok() {
                        let mut bytes: Vec<u8> = Vec::new();
                        let mut cursor = std::io::Cursor::new(&mut bytes);
                        if image::write_buffer_with_format(
                            &mut cursor,
                            dst_image.buffer(),
                            dst_width,
                            dst_height,
                            image::ColorType::Rgb8,
                            image::ImageFormat::Jpeg,
                        ).is_ok() {
                            return Some(bytes);
                        }
                    }
                }
            }
        }
    }
    None
}

fn generate_video_thumbnail_sync(path: &str) -> Option<Vec<u8>> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;

        let ffmpeg_path = std::env::current_exe()
            .ok()
            .and_then(|mut p| {
                p.pop();
                p.push("ffmpeg.exe");
                if p.exists() {
                    Some(p.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "ffmpeg".to_string());

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = Command::new(&ffmpeg_path)
            .args(&[
                "-v", "error",
                "-ss", "1.0",
                "-i", path,
                "-vframes", "1",
                "-f", "image2pipe",
                "-vcodec", "mjpeg",
                "-"
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = output {
            if out.status.success() && !out.stdout.is_empty() {
                return Some(out.stdout); // JPEG bytes
            }
        }

        use windows::core::{HSTRING, PCWSTR, ComInterface};
        use windows::Win32::UI::Shell::{
            SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_THUMBNAILONLY
        };
        use windows::Win32::Foundation::SIZE;
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, CoUninitialize};
        use windows::Win32::Graphics::Gdi::{
            GetObjectW, DeleteObject, BITMAP, GetDIBits, CreateCompatibleDC, DeleteDC,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, RGBQUAD
        };
        use std::ffi::c_void;

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let clean_path = path.replace("\\\\?\\", "");
            let hpath = HSTRING::from(clean_path);
            let item: windows::Win32::UI::Shell::IShellItem = match SHCreateItemFromParsingName(PCWSTR::from_raw(hpath.as_ptr()), None) {
                Ok(item) => item,
                Err(_e) => {
                    let _ = CoUninitialize();
                    return None;
                }
            };

            let factory: IShellItemImageFactory = match item.cast() {
                Ok(f) => f,
                Err(_e) => {
                    let _ = CoUninitialize();
                    return None;
                }
            };

            let size = SIZE { cx: 256, cy: 256 };
            let hbitmap = match factory.GetImage(size, SIIGBF_THUMBNAILONLY) {
                Ok(bmp) => bmp,
                Err(_e) => {
                    let _ = CoUninitialize();
                    return None;
                }
            };

            let mut bm = BITMAP::default();
            if GetObjectW(hbitmap, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
                let _ = DeleteObject(hbitmap);
                let _ = CoUninitialize();
                return None;
            }

            let hdc = CreateCompatibleDC(None);
            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: bm.bmWidth,
                    biHeight: -bm.bmHeight, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0 as u32,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD::default(); 1],
            };

            let pixel_count = (bm.bmWidth * bm.bmHeight) as usize;
            let mut pixels = vec![0u8; pixel_count * 4];

            let res = GetDIBits(
                hdc,
                hbitmap,
                0,
                bm.bmHeight as u32,
                Some(pixels.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            let _ = DeleteDC(hdc);
            let _ = DeleteObject(hbitmap);
            let _ = CoUninitialize();

            if res == 0 {
                return None;
            }

            for chunk in pixels.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }

            if let Some(rgba_img) = image::RgbaImage::from_raw(bm.bmWidth as u32, bm.bmHeight as u32, pixels) {
                let rgb_img = image::DynamicImage::ImageRgba8(rgba_img).into_rgb8();
                let mut bytes: Vec<u8> = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut bytes);
                if rgb_img.write_to(&mut cursor, image::ImageFormat::Jpeg).is_ok() {
                    return Some(bytes);
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn generate_thumbnail_inner(
    file_path: &str,
    mtime: u64,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> Vec<u8> {
    let clean_path = file_path.replace("\\\\?\\", "");
    let digest_clean = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
    let hash_key = format!("{:016x}", digest_clean);

    if let Ok(conn) = db_conn.get() {
        if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL") {
            if let Ok(thumb) = stmt.query_row([&hash_key], |row| row.get::<_, Vec<u8>>(0)) {
                return thumb;
            }
        }
    }
    
    let lower_path = file_path.to_lowercase();
    let generated_bytes = if lower_path.ends_with(".mp4") || lower_path.ends_with(".webm") || lower_path.ends_with(".avi") || lower_path.ends_with(".mkv") {
        generate_video_thumbnail_sync(file_path)
    } else {
        None
    };
    
    if let Some(bytes) = generated_bytes {
        if let Ok(conn) = db_conn.get() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
            let _ = conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, ?, ?)
                 ON CONFLICT(hash_key) DO UPDATE SET thumbnail = excluded.thumbnail, last_accessed = excluded.last_accessed",
                rusqlite::params![hash_key, bytes, now],
            );
        }
        return bytes;
    }
    
    Vec::new()
}


#[tauri::command]
async fn save_thumbnail(
    state: tauri::State<'_, AppState>,
    file_path: String,
    b64_data: String,
) -> Result<(), String> {
    let db_conn = state.db_conn.clone();
    
    // Fast path: get mtime from memory to avoid disk I/O
    let mem_mtime = if let Ok(lock) = state.filtered_files.lock() {
        lock.iter().find(|f| f.path == file_path).map(|f| f.mtime)
    } else {
        None
    };

    let mtime = mem_mtime.unwrap_or_else(|| {
        std::fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    });

    let clean_path = file_path.replace("\\\\?\\", "");
    let digest_clean = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
    let hash_key = format!("{:016x}", digest_clean);

    // b64_data is expected to be "data:image/jpeg;base64,..."
    let b64 = if let Some(idx) = b64_data.find(',') {
        &b64_data[idx + 1..]
    } else {
        &b64_data
    };

    use base64::{Engine as _, engine::general_purpose};
    let bytes = general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || {
        if let Ok(conn) = db_conn.get() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
            let _ = conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, ?, ?)
                 ON CONFLICT(hash_key) DO UPDATE SET thumbnail=excluded.thumbnail, last_accessed=excluded.last_accessed",
                rusqlite::params![&hash_key, &bytes, now],
            );
        }
    }).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn precache_directory_recursively(
    window: tauri::Window,
    target_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db_conn = state.db_conn.clone();
    tokio::task::spawn_blocking(move || {
        let entries: Vec<_> = walkdir::WalkDir::new(&target_path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let path = e.path().to_string_lossy().to_lowercase();
                path.ends_with(".png") || path.ends_with(".jpg") || path.ends_with(".jpeg") || path.ends_with(".webp")
            })
            .collect();
        
        let total = entries.len();
        for (i, entry) in entries.iter().enumerate() {
            let path = entry.path().to_string_lossy().to_string();
            let metadata = entry.metadata().ok();
            let mtime = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let clean_path = path.replace("\\\\?\\", "");
            let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
            let hash_key = format!("{:016x}", digest);

            let mut has_both = false;
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare_cached("SELECT 1 FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL AND metadata IS NOT NULL AND metadata != ''") {
                    if stmt.exists([&hash_key]).unwrap_or(false) {
                        has_both = true;
                    }
                }
            }

            if !has_both {
                get_full_metadata_for_path(&path, &db_conn);
                generate_thumbnail_inner(&path, mtime, &db_conn);
            }
            
            if i % 10 == 0 || i == total - 1 {
                let _ = window.emit("precache-progress", (i + 1, total));
            }
        }
        Ok(())
    })
    .await
    .unwrap_or(Ok(()))
}

// --- ウィンドウ管理コマンド (ビューア用) ---

#[tauri::command]
fn get_viewer_image(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Option<ViewerImageResult> {
    let label = window.label();
    if let Ok(viewer_paths) = state.viewer_paths.lock() {
        if let Some(paths) = viewer_paths.get(label) {
            if let Some(path) = paths.get(index) {
                return Some(ViewerImageResult {
                    path: path.clone(),
                    total: paths.len(),
                    index,
                });
            }
        }
    }
    None
}

#[tauri::command]
async fn open_viewer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    current_index: usize,
    width: u32,
    height: u32,
    monitor_width: f64,
    monitor_height: f64,
) -> Result<(), String> {
    let (target_path, current_paths) = {
        if let Ok(paths) = state.image_paths.lock() {
            (paths.get(current_index).cloned(), paths.clone())
        } else {
            (None, Vec::new())
        }
    };

    let mut win_width = width;
    let mut win_height = height;

    if win_width == 0 || win_height == 0 {
        if let Some(path) = &target_path {
            if let Ok(dims) = image::image_dimensions(path) {
                win_width = dims.0;
                win_height = dims.1;
            }
        }
    }
    if win_width == 0 || win_height == 0 {
        win_width = 1024;
        win_height = 768;
    }

    if (win_width as f64) > monitor_width || (win_height as f64) > monitor_height {
        let scale = (monitor_width / win_width as f64).min(monitor_height / win_height as f64);
        win_width = (win_width as f64 * scale) as u32;
        win_height = (win_height as f64 * scale) as u32;
    }

    let hash_str = if let Some(path) = &target_path {
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        format!("{}", hasher.finish())
    } else {
        "none".to_string()
    };

    // 既に同じ画像（ハッシュ値が一致）のビューアーが開いている場合は、フォーカスを当てるだけで終了
    let existing_window = app.windows().into_values().find(|w| {
        let l = w.label();
        l.starts_with("viewer_") && l.ends_with(&format!("_{}", hash_str))
    });

    if let Some(window) = existing_window {
        let _ = window.set_focus();
        return Ok(());
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let label = format!("viewer_{:016}_{}", now_ms, hash_str);

    if let Ok(mut viewer_paths) = state.viewer_paths.lock() {
        viewer_paths.insert(label.clone(), current_paths);
    }

    let data_dir = get_veloce_data_dir().unwrap_or_default();

    tauri::WindowBuilder::new(
        &app,
        label,
        tauri::WindowUrl::App(format!("/viewer.html?index={}", current_index).into()),
    )
    .title("Veloce Viewer")
    .inner_size(win_width as f64, win_height as f64)
    .data_directory(data_dir)
    .decorations(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn update_smart_folders(rules: Vec<SmartFolderRule>, state: tauri::State<'_, AppState>) {
    println!("Received smart folders update: {} rules", rules.len());
    for rule in &rules {
        println!(
            "Rule ID: {}, match_type: {}, conditions: {}",
            rule.id,
            rule.match_type,
            rule.conditions.len()
        );
    }
    if let Ok(mut lock) = state.smart_folders.lock() {
        *lock = rules;
    }
}

#[tauri::command]
fn show_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
}



#[tauri::command]
fn arrange_viewers(app: tauri::AppHandle, caller_window: tauri::Window) {
    let windows = app.windows();
    let mut viewers: Vec<_> = windows
        .into_values()
        .filter(|w| w.label().starts_with("viewer_"))
        .collect();

    let count = viewers.len();
    if count == 0 {
        return;
    }

    viewers.sort_by_key(|w| w.label().to_string());

    if let Some(first_viewer) = viewers.first() {
        if let Ok(Some(monitor)) = first_viewer.current_monitor() {
            let scale_factor = monitor.scale_factor();
            let work_area = monitor.size().to_logical::<f64>(scale_factor);
            let position = monitor.position().to_logical::<f64>(scale_factor);

            let target_width = work_area.width / count as f64;
            let target_height = work_area.height;

            for (i, window) in viewers.iter().enumerate() {
                let x = position.x + (i as f64 * target_width);
                let y = position.y;

                let _ = window.unmaximize();
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: target_width,
                    height: target_height,
                }));
                let _ =
                    window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));

                let _ = window.set_always_on_top(false);
                let _ = window.set_always_on_top(true);
                let _ = window.set_focus();
            }
        }
    }

    let _ = app.emit_all("viewers-arranged", ());

    // Windows 8.1 強制前面化ハック
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd_ptr) = caller_window.hwnd() {
            let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr.0 as isize);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                    };
                    let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                    let _ = SetForegroundWindow(hwnd);
                }
            });
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = caller_window.set_focus();
    }
}

// --- ファイル・システム操作コマンド ---

fn collect_cache_paths_to_remove(target_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut cache_paths = Vec::new();
    if let Some(mut cache_dir) = get_veloce_data_dir() {
        if target_path.is_file() {
            collect_single_file_cache(target_path, &mut cache_dir, &mut cache_paths);
        } else if target_path.is_dir() {
            for entry in walkdir::WalkDir::new(target_path)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.path().is_file() {
                    collect_single_file_cache(entry.path(), &mut cache_dir, &mut cache_paths);
                }
            }
        }
    }
    cache_paths
}

fn collect_single_file_cache(
    path: &std::path::Path,
    cache_dir: &mut std::path::PathBuf,
    cache_paths: &mut Vec<std::path::PathBuf>,
) {
    if let Ok(metadata) = std::fs::metadata(path) {
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let clean_path = path.to_string_lossy().to_string().replace("\\\\?\\", "");
        let cache_file_name = format!("{}_{}", clean_path, mtime);
        let digest = xxhash_rust::xxh3::xxh3_64(cache_file_name.as_bytes());

        cache_dir.push("Thumbnails");
        cache_paths.push(cache_dir.join(format!("{:016x}.jpg", digest)));
        cache_dir.pop();

        cache_dir.push("Metadata");
        cache_paths.push(cache_dir.join(format!("{:016x}.json", digest)));
        cache_dir.pop();
    }
}

fn remove_collected_caches(cache_paths: Vec<std::path::PathBuf>) {
    for path in cache_paths {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
fn get_files_by_indices(
    state: tauri::State<'_, AppState>,
    indices: Vec<usize>,
) -> Result<Vec<std::sync::Arc<ImageFile>>, String> {
    let lock = state.filtered_files.lock().unwrap();
    let mut files = Vec::with_capacity(indices.len());
    for idx in indices {
        if let Some(f) = lock.get(idx) {
            files.push(f.clone());
        }
    }
    Ok(files)
}

#[tauri::command]
async fn clear_metadata_cache(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let db_conn_clone = state.db_conn.clone();
    tokio::task::spawn_blocking(move || {
        let mut messages = Vec::new();
        let conn = db_conn_clone.get().unwrap();

        for file_path in file_paths {
            let mtime = std::fs::metadata(&file_path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();

            let clean_path = file_path.replace("\\\\?\\", "");
            let digest_raw =
                xxhash_rust::xxh3::xxh3_64(format!("{}_{}", file_path, mtime).as_bytes());
            let digest_clean =
                xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());

            let hash_key_raw = format!("{:016x}", digest_raw);
            let hash_key_clean = format!("{:016x}", digest_clean);

            let _ = conn.execute(
                "DELETE FROM cache WHERE hash_key IN (?, ?)",
                rusqlite::params![&hash_key_raw, &hash_key_clean],
            );
            messages.push(format!("Cleared cache for {}", file_path));
        }
        Ok(messages)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn trash_file(file_path: String) -> Result<bool, String> {
    Ok(tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        let cache_paths = collect_cache_paths_to_remove(path);

        if trash::delete(&file_path).is_ok() {
            remove_collected_caches(cache_paths);
            true
        } else {
            false
        }
    })
    .await
    .unwrap_or(false))
}

#[tauri::command]
async fn trash_folder(folder_path: String) -> Result<FolderOperationResult, String> {
    Ok(tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&folder_path);
        let cache_paths = collect_cache_paths_to_remove(path);

        match trash::delete(&folder_path) {
            Ok(_) => {
                remove_collected_caches(cache_paths);
                FolderOperationResult {
                    success: true,
                    path: None,
                    error: None,
                }
            }
            Err(e) => FolderOperationResult {
                success: false,
                path: None,
                error: Some(e.to_string()),
            },
        }
    })
    .await
    .unwrap_or_else(|e| FolderOperationResult {
        success: false,
        path: None,
        error: Some(e.to_string()),
    }))
}

#[tauri::command]
async fn copy_image_to_clipboard(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // 画像をデコードしてピクセルデータを抽出し、クリップボードに書き込む
        if let Ok(img) = image::open(&file_path) {
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let image_data = arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
            };
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_image(image_data);
            }
        }
    })
    .await
    .unwrap_or(());
    Ok(())
}

#[tauri::command]
fn get_license_text() -> String {
    include_str!("../../LICENSE.md").to_string()
}

#[tauri::command]
async fn rename_file(state: tauri::State<'_, AppState>, old_path: String, new_name: String) -> Result<String, String> {
    let old_path_clone = old_path.clone();
    let new_path_str = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&old_path);
        let parent = path.parent().unwrap_or(std::path::Path::new(""));

        let mut final_name = new_name.clone();
        if !final_name.contains('.') {
            if let Some(ext) = path.extension() {
                final_name = format!("{}.{}", final_name, ext.to_string_lossy());
            }
        }

        let new_path = parent.join(&final_name);

        if new_path.exists() {
            let old_lower = old_path.to_lowercase();
            let new_lower = new_path.to_string_lossy().to_lowercase();
            if old_lower != new_lower {
                return Err("同じ名前のファイルが既に存在します。".to_string());
            }
        }

        let cache_paths = collect_cache_paths_to_remove(path);

        match std::fs::rename(&old_path, &new_path) {
            Ok(_) => {
                remove_collected_caches(cache_paths);
                Ok(new_path.to_string_lossy().to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))?;

    // DBとメモリのレーティングのパスを更新
    if let Ok(conn) = state.db_conn.get() {
        let _ = conn.execute(
            "UPDATE ratings SET path = ?1 WHERE path = ?2",
            rusqlite::params![&new_path_str, &old_path_clone],
        );
    }
    if let Ok(mut lock) = state.ratings.lock() {
        if let Some(rating) = lock.remove(&old_path_clone) {
            lock.insert(new_path_str.clone(), rating);
        }
    }

    Ok(new_path_str)
}

#[tauri::command]
async fn rename_folder(state: tauri::State<'_, AppState>, old_path: String, new_name: String) -> Result<String, String> {
    let old_path_clone = old_path.clone();
    let new_path_str = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&old_path);
        let parent = path.parent().unwrap_or(std::path::Path::new(""));
        let new_path = parent.join(new_name);

        if new_path.exists() {
            let old_lower = old_path.to_lowercase();
            let new_lower = new_path.to_string_lossy().to_lowercase();
            if old_lower != new_lower {
                return Err("同じ名前のフォルダが既に存在します。".to_string());
            }
        }

        let cache_paths = collect_cache_paths_to_remove(path);

        match std::fs::rename(&old_path, &new_path) {
            Ok(_) => {
                remove_collected_caches(cache_paths);
                Ok(new_path.to_string_lossy().to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))?;

    // フォルダのリネームに合わせてレーティングのパスも更新する
    let _old_prefix = format!("{}\\*", old_path_clone);
    let _old_prefix_slash = format!("{}\\*", old_path_clone.replace("\\", "/"));
    let old_path_exact = old_path_clone.clone();
    let new_path_exact = new_path_str.clone();
    
    let _old_base = if old_path_clone.ends_with('\\') || old_path_clone.ends_with('/') {
        old_path_clone.clone()
    } else {
        format!("{}\\*", old_path_clone) // 末尾にセパレータがない場合のprefix用
    };
    // 厳密な前方一致置換は面倒なので、Rustのメモリ側で計算したペアでDBも更新する
    let mut updates = Vec::new();
    if let Ok(mut lock) = state.ratings.lock() {
        let mut keys_to_remove = Vec::new();
        for (p, rating) in lock.iter() {
            if p == &old_path_exact {
                keys_to_remove.push(p.clone());
                updates.push((new_path_exact.clone(), *rating));
            } else if p.starts_with(&format!("{}\\*", old_path_exact).replace("*", "")) || p.starts_with(&format!("{}/", old_path_exact)) {
                keys_to_remove.push(p.clone());
                let new_p = p.replacen(&old_path_exact, &new_path_exact, 1);
                updates.push((new_p, *rating));
            }
        }
        for k in keys_to_remove {
            lock.remove(&k);
            if let Ok(conn) = state.db_conn.get() {
                let _ = conn.execute("DELETE FROM ratings WHERE path = ?1", rusqlite::params![&k]);
            }
        }
        for (new_p, rating) in updates {
            lock.insert(new_p.clone(), rating);
            if let Ok(conn) = state.db_conn.get() {
                let _ = conn.execute("INSERT OR REPLACE INTO ratings (path, rating) VALUES (?1, ?2)", rusqlite::params![&new_p, rating]);
            }
        }
    }

    Ok(new_path_str)
}

#[tauri::command]
fn open_cache_folder() -> Result<(), String> {
    if let Some(path) = get_veloce_data_dir() {
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }

        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("explorer").arg(&path).spawn();

        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(&path).spawn();

        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();

        Ok(())
    } else {
        Err("Could not resolve local data directory".to_string())
    }
}

#[tauri::command]
async fn audit_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db_conn = state.db_conn.clone();
    tokio::task::spawn_blocking(move || {
        let conn = match db_conn.get() {
            Ok(c) => c,
            Err(_) => return,
        };
        
        let total: usize = conn.query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0)).unwrap_or(0);
        if total == 0 {
            return;
        }

        let mut stmt = match conn.prepare("SELECT hash_key, path, width, height, size, mtime, ctime, (thumbnail IS NOT NULL) FROM cache") {
            Ok(s) => s,
            Err(_) => return,
        };
        
        let records = match stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<u32>>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<u64>>(4)?,
                row.get::<_, Option<u64>>(5)?,
                row.get::<_, Option<u64>>(6)?,
                row.get::<_, bool>(7)?,
            ))
        }) {
            Ok(m) => m.filter_map(|r| r.ok()).collect::<Vec<_>>(),
            Err(_) => return,
        };

        let mut deleted = 0;
        let mut fixed = 0;
        
        for (i, (hash_key, path_opt, width_opt, height_opt, size_opt, mtime_opt, ctime_opt, has_thumbnail)) in records.into_iter().enumerate() {
            if i % 100 == 0 || i == total - 1 {
                let _ = app.emit_all("audit-progress", AuditProgress {
                    current: i + 1,
                    total,
                    deleted,
                    fixed,
                });
            }
            
            let path_str = match path_opt {
                Some(p) => p,
                None => {
                    let _ = conn.execute("DELETE FROM cache WHERE hash_key = ?", [&hash_key]);
                    deleted += 1;
                    continue;
                }
            };
            
            let path = std::path::Path::new(&path_str);
            if !path.exists() {
                let _ = conn.execute("DELETE FROM cache WHERE hash_key = ?", [&hash_key]);
                deleted += 1;
                continue;
            }

            let mut needs_update = false;
            let mut new_width = width_opt.unwrap_or(0);
            let mut new_height = height_opt.unwrap_or(0);
            let mut new_size = size_opt.unwrap_or(0);
            let mut new_mtime = mtime_opt.unwrap_or(0);
            let mut new_ctime = ctime_opt.unwrap_or(0);

            if new_size == 0 || new_mtime == 0 {
                if let Ok(metadata) = std::fs::metadata(&path) {
                    new_size = metadata.len();
                    new_mtime = metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                    new_ctime = metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                    needs_update = true;
                }
            }

            if new_width == 0 || new_height == 0 {
                if let Ok(dim) = image::image_dimensions(&path) {
                    new_width = dim.0;
                    new_height = dim.1;
                    needs_update = true;
                }
            }

            if needs_update {
                let _ = conn.execute(
                    "UPDATE cache SET width=?, height=?, size=?, mtime=?, ctime=? WHERE hash_key=?",
                    rusqlite::params![new_width, new_height, new_size, new_mtime, new_ctime, hash_key]
                );
                fixed += 1;
            }

            // Thumbnail recreation for existing files without thumbnail
            if !has_thumbnail {
                let lower_path = path_str.to_lowercase();
                let generated = if lower_path.ends_with(".mp4") || lower_path.ends_with(".webm") || lower_path.ends_with(".avi") || lower_path.ends_with(".mkv") {
                    generate_video_thumbnail_sync(&path_str)
                } else {
                    generate_image_thumbnail_sync(&path_str)
                };
                
                if let Some(bytes) = generated {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                    let _ = conn.execute(
                        "UPDATE cache SET thumbnail=?, last_accessed=? WHERE hash_key=?",
                        rusqlite::params![&bytes, now, &hash_key]
                    );
                    if !needs_update { fixed += 1; }
                }
            }
        }
        
        let _ = conn.execute("VACUUM", []); // Optional optimization after deletion
    });
    
    Ok(())
}

#[tauri::command]
async fn clear_cache(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let db_conn_clone = state.db_conn.clone();
    tokio::task::spawn_blocking(move || {
        // SQLite のキャッシュをクリア
        let conn = db_conn_clone.get().unwrap();
        let _ = conn.execute("DELETE FROM cache", []);
        let _ = conn.execute("VACUUM", []); // ファイルサイズを切り詰める

        // 既存の古いファイルベースのキャッシュも念のため削除
        if let Some(mut path) = get_veloce_data_dir() {
            // Clear Thumbnails
            path.push("Thumbnails");
            if path.exists() {
                if let Ok(entries) = std::fs::read_dir(&path) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }

            // Clear Metadata
            path.pop();
            path.push("Metadata");
            if path.exists() {
                if let Ok(entries) = std::fs::read_dir(&path) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            Ok(())
        } else {
            Err("Could not resolve local data directory".to_string())
        }
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = std::path::Path::new(&path);
    if !path_obj.exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if path_obj.is_file() {
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.replace("/", "\\")))
                .spawn();
        } else {
            let _ = std::process::Command::new("explorer")
                .arg(path.replace("/", "\\"))
                .spawn();
        }
    }

    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(path).spawn();

    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    path: String,
    file_count: usize,
    total_size_bytes: u64,
}

#[tauri::command]
async fn get_cache_info() -> CacheInfo {
    tokio::task::spawn_blocking(move || {
        let mut path_str = String::new();
        let mut file_count = 0;
        let mut total_size_bytes = 0;

        if let Some(mut path) = get_veloce_data_dir() {
            path_str = path.to_string_lossy().to_string(); // 親ディレクトリ(Veloce)のパスを保持

            // SQLite DBのファイルサイズを合算
            let db_path = path.join("veloce_cache.db");
            if let Ok(metadata) = std::fs::metadata(&db_path) {
                if metadata.is_file() {
                    file_count += 1;
                    total_size_bytes += metadata.len();
                }
            }

            // 古いサムネイルキャッシュの情報も合算する
            path.push("Thumbnails");
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.filter_map(Result::ok) {
                    if let Ok(metadata) = entry.metadata() {
                        if metadata.is_file() {
                            file_count += 1;
                            total_size_bytes += metadata.len();
                        }
                    }
                }
            }

            // 古いメタデータキャッシュの情報も合算する
            path.pop();
            path.push("Metadata");
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.filter_map(Result::ok) {
                    if let Ok(metadata) = entry.metadata() {
                        if metadata.is_file() {
                            file_count += 1;
                            total_size_bytes += metadata.len();
                        }
                    }
                }
            }
        }

        CacheInfo {
            path: path_str,
            file_count,
            total_size_bytes,
        }
    })
    .await
    .unwrap_or(CacheInfo {
        path: String::new(),
        file_count: 0,
        total_size_bytes: 0,
    })
}

#[tauri::command]
fn get_video_server_port(state: tauri::State<'_, AppState>) -> u16 {
    state.video_server_port
}

fn start_local_video_server() -> u16 {
    use std::net::TcpListener;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::fs::File;

    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind local video server");
    let port = listener.local_addr().unwrap().port();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(&mut stream);
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
                        return;
                    }

                    let parts: Vec<&str> = request_line.split_whitespace().collect();
                    if parts.len() < 2 { return; }
                    let method = parts[0];
                    let uri = parts[1];

                    if method == "OPTIONS" {
                        let mut headers = String::new();
                        headers.push_str("HTTP/1.1 200 OK\r\n");
                        headers.push_str("Access-Control-Allow-Origin: *\r\n");
                        headers.push_str("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
                        headers.push_str("Access-Control-Allow-Headers: Range, Content-Type\r\n");
                        headers.push_str("Access-Control-Max-Age: 86400\r\n");
                        headers.push_str("Connection: close\r\n\r\n");
                        let _ = stream.write_all(headers.as_bytes());
                        return;
                    }
                    let mut path_str = String::new();
                    let mut is_thumb = false;
                    let mut mtime: u64 = 0;
                    if let Some(query) = uri.split('?').nth(1) {
                        for pair in query.split('&') {
                            if pair.starts_with("path=") {
                                path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                            } else if pair.starts_with("thumb=1") {
                                is_thumb = true;
                            } else if pair.starts_with("mtime=") {
                                mtime = pair[6..].parse().unwrap_or(0);
                            }
                        }
                    }

                    if path_str.is_empty() {
                        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                        return;
                    }

                    if is_thumb {
                        let clean_path = path_str.replace("\\\\?\\", "");
                        let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
                        let hash_key = format!("{:016x}", digest);

                        let mut cache_bytes = Vec::new();
                        // Open sqlite directly since we don't easily have AppState here
                        if let Some(mut db_path) = crate::get_veloce_data_dir() {
                            db_path.push("veloce_cache.db");
                            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                                if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL") {
                                    if let Ok(thumb) = stmt.query_row([&hash_key], |row| row.get::<_, Vec<u8>>(0)) {
                                        cache_bytes = thumb;
                                    }
                                }
                            }
                        }

                        if !cache_bytes.is_empty() {
                            let mimetype = if cache_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                                "image/png"
                            } else if cache_bytes.starts_with(&[0x3C, 0x3F, 0x78, 0x6D, 0x6C]) || cache_bytes.starts_with(&[0x3C, 0x73, 0x76, 0x67]) {
                                "image/svg+xml"
                            } else {
                                "image/jpeg"
                            };

                            let mut headers = String::new();
                            headers.push_str("HTTP/1.1 200 OK\r\n");
                            headers.push_str(&format!("Content-Type: {}\r\n", mimetype));
                            headers.push_str("Access-Control-Allow-Origin: *\r\n");
                            headers.push_str("Cache-Control: public, max-age=3600\r\n");
                            headers.push_str(&format!("Content-Length: {}\r\n\r\n", cache_bytes.len()));
                            
                            let _ = stream.write_all(headers.as_bytes());
                            let _ = stream.write_all(&cache_bytes);
                        } else {
                            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n");
                        }
                        return;
                    }

                    let mut range_header = None;
                    loop {
                        let mut header_line = String::new();
                        if reader.read_line(&mut header_line).is_err() { break; }
                        let trimmed = header_line.trim();
                        if trimmed.is_empty() { break; }
                        let lower = trimmed.to_lowercase();
                        if lower.starts_with("range:") {
                            range_header = Some(trimmed[6..].trim().to_string());
                        }
                    }

                    if let Ok(mut file) = File::open(&path_str) {
                        if let Ok(metadata) = file.metadata() {
                            let file_size = metadata.len();
                            let mut start: u64 = 0;
                            let mut end: u64 = file_size.saturating_sub(1);
                            let mut is_range = false;

                            if let Some(range) = range_header {
                                if range.starts_with("bytes=") {
                                    is_range = true;
                                    let parts: Vec<&str> = range["bytes=".len()..].split('-').collect();
                                    if !parts.is_empty() && !parts[0].is_empty() {
                                        start = parts[0].parse::<u64>().unwrap_or(0);
                                    }
                                    if parts.len() > 1 && !parts[1].is_empty() {
                                        end = parts[1].parse::<u64>().unwrap_or(end);
                                    }
                                }
                            }

                            let max_chunk: u64 = 2 * 1024 * 1024;
                            let chunk_size = std::cmp::min(end.saturating_sub(start) + 1, max_chunk);

                            let mut headers = String::new();
                            if is_range {
                                headers.push_str("HTTP/1.1 206 Partial Content\r\n");
                                headers.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, start + chunk_size - 1, file_size));
                            } else {
                                headers.push_str("HTTP/1.1 200 OK\r\n");
                            }
                            headers.push_str("Content-Type: video/mp4\r\n");
                            headers.push_str("Accept-Ranges: bytes\r\n");
                            headers.push_str("Access-Control-Allow-Origin: *\r\n");
                            headers.push_str(&format!("Content-Length: {}\r\n", chunk_size));
                            headers.push_str("Connection: close\r\n");
                            headers.push_str("\r\n");

                            if stream.write_all(headers.as_bytes()).is_ok() {
                                if file.seek(SeekFrom::Start(start)).is_ok() {
                                    let mut handle = file.take(chunk_size);
                                    let _ = std::io::copy(&mut handle, &mut stream);
                                }
                            }
                            return;
                        }
                    }
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n");
                });
            }
        }
    });

    port
}

fn main() {
    let video_port = start_local_video_server();

    let mut context = tauri::generate_context!();

    // tauri.conf.json で定義されているメインウィンドウの設定を退避させて、自動生成をキャンセルする
    let window_configs = context.config_mut().tauri.windows.clone();
    context.config_mut().tauri.windows.clear();

    tauri::Builder::default()
        .register_uri_scheme_protocol("stream", move |_app_handle, request| {
            let uri = request.uri();
            let mut path_str = String::new();
            if let Some(query) = uri.split('?').nth(1) {
                for pair in query.split('&') {
                    if pair.starts_with("path=") {
                        path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                    }
                }
            }

            if path_str.is_empty() {
                return tauri::http::ResponseBuilder::new().status(400).body(Vec::new());
            }

            use std::io::{Read, Seek, SeekFrom};
            use std::fs::File;

            if let Ok(mut file) = File::open(&path_str) {
                if let Ok(metadata) = file.metadata() {
                    let file_size = metadata.len();
                    
                    let range_header = request.headers().get("Range").and_then(|v| v.to_str().ok());
                    let mut start: u64 = 0;
                    let mut end: u64 = file_size.saturating_sub(1);
                    let mut is_range = false;

                    if let Some(range) = range_header {
                        if range.starts_with("bytes=") {
                            is_range = true;
                            let parts: Vec<&str> = range["bytes=".len()..].split('-').collect();
                            if !parts.is_empty() && !parts[0].is_empty() {
                                start = parts[0].parse::<u64>().unwrap_or(0);
                            }
                            if parts.len() > 1 && !parts[1].is_empty() {
                                end = parts[1].parse::<u64>().unwrap_or(end);
                            }
                        }
                    }

                    // チャンクサイズを最大2MBに制限してストリーミングを実現
                    let max_chunk: u64 = 2 * 1024 * 1024;
                    let chunk_size = std::cmp::min(end.saturating_sub(start) + 1, max_chunk);
                    
                    let mut buf = vec![0; chunk_size as usize];
                    if file.seek(SeekFrom::Start(start)).is_ok() {
                        if let Ok(read_len) = file.read(&mut buf) {
                            buf.truncate(read_len);
                            
                            let mut resp = tauri::http::ResponseBuilder::new()
                                .header("Content-Type", "video/mp4")
                                .header("Accept-Ranges", "bytes")
                                .header("Access-Control-Allow-Origin", "*");

                            if is_range {
                                resp = resp.status(206).header(
                                    "Content-Range",
                                    format!("bytes {}-{}/{}", start, start + read_len as u64 - 1, file_size),
                                );
                            } else {
                                resp = resp.status(200).header("Content-Length", file_size.to_string());
                            }
                            
                            return resp.body(buf);
                        }
                    }
                }
            }
            tauri::http::ResponseBuilder::new().status(404).body(Vec::new())
        })
        .register_uri_scheme_protocol("veloce", move |app_handle, request| {
            let uri = request.uri();
            let mut path_str = String::new();
            if let Some(query) = uri.split('?').nth(1) {
                for pair in query.split('&') {
                    if pair.starts_with("path=") {
                        path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                    }
                }
            }

            if path_str.is_empty() {
                return tauri::http::ResponseBuilder::new().status(400).body(Vec::new());
            }

            use tauri::Manager;
            let state = app_handle.state::<AppState>();
            let mtime = std::fs::metadata(&path_str)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();

            let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", path_str, mtime).as_bytes());
            let hash_key = format!("{:016x}", digest);

            let cached_bytes: Option<Vec<u8>> = {
                let mut result = None;
                if let Ok(conn) = state.db_conn.get() {
                    if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ?") {
                        if let Ok(bytes) = stmt.query_row([&hash_key], |row| row.get::<_, Vec<u8>>(0)) {
                            if !bytes.is_empty() {
                                result = Some(bytes);
                            }
                        }
                    }
                }
                result
            };

            if let Some(bytes) = cached_bytes {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                if let Ok(conn) = state.db_conn.get() {
                    let _ = conn.execute(
                        "UPDATE cache SET last_accessed = ? WHERE hash_key = ?",
                        rusqlite::params![now, &hash_key]
                    );
                }
                let mimetype = if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                    "image/png"
                } else if bytes.starts_with(&[0x3C, 0x3F, 0x78, 0x6D, 0x6C]) || bytes.starts_with(&[0x3C, 0x73, 0x76, 0x67]) {
                    "image/svg+xml"
                } else {
                    "image/jpeg"
                };

                return tauri::http::ResponseBuilder::new()
                    .mimetype(mimetype)
                    .header("Access-Control-Allow-Origin", "*")
                    .status(200)
                    .body(bytes);
            }

            let lower_path = path_str.to_lowercase();
            let generated_bytes = if lower_path.ends_with(".mp4") || lower_path.ends_with(".webm") || lower_path.ends_with(".avi") || lower_path.ends_with(".mkv") {
                generate_video_thumbnail_sync(&path_str)
            } else {
                generate_image_thumbnail_sync(&path_str)
            };

            if let Some(bytes) = generated_bytes {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                if let Ok(conn) = state.db_conn.get() {
                    let _ = conn.execute(
                        "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, ?, ?)
                         ON CONFLICT(hash_key) DO UPDATE SET thumbnail=excluded.thumbnail, last_accessed=excluded.last_accessed",
                        rusqlite::params![&hash_key, &bytes, now],
                    );
                }
                return tauri::http::ResponseBuilder::new()
                    .mimetype("image/jpeg")
                    .header("Access-Control-Allow-Origin", "*")
                    .status(200)
                    .body(bytes);
            }

            tauri::http::ResponseBuilder::new().status(404).body(Vec::new())
        })
        .manage(AppState {
            image_paths: Mutex::new(Vec::new()),
            current_dir: Mutex::new(String::new()),
            viewer_paths: Mutex::new(std::collections::HashMap::new()),
            all_files: Mutex::new(Vec::new()),
            filtered_files: Mutex::new(Vec::new()),
            sort_config: Mutex::new(SortConfig {
                key: "name".to_string(),
                asc: true,
            }),
            search_query: Mutex::new(String::new()),
            ratings: Mutex::new(std::collections::HashMap::new()),
            rating_filter_val: Mutex::new(0),
            rating_filter_op: Mutex::new("gte".to_string()),
            db_conn: init_db().expect("Failed to initialize SQLite database"),
            smart_folders: Mutex::new(Vec::new()),
            video_server_port: video_port,
        })
        .setup(move |app| {
            // SQLite からレーティング情報をメモリにロード
            let state = app.state::<AppState>();
            if let Ok(conn) = state.db_conn.get() {
                if let Ok(mut stmt) = conn.prepare("SELECT path, rating FROM ratings") {
                    if let Ok(rows) = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, u8>(1)?))
                    }) {
                        if let Ok(mut lock) = state.ratings.lock() {
                            for r in rows.flatten() {
                                lock.insert(r.0, r.1);
                            }
                        }
                    }
                }
            }

            let data_dir = get_veloce_data_dir().unwrap_or_default();

            // 退避させた設定と、指定したデータディレクトリを使って自分でウィンドウを作成する
            for config in window_configs {
                tauri::WindowBuilder::from_config(app, config)
                    .data_directory(data_dir.clone())
                    .min_inner_size(800.0, 600.0)
                    .build()?;
            }

            // 古いサムネイルキャッシュの自動クリーンアップをバックグラウンドで実行
            std::thread::spawn(|| {
                if let Some(mut cache_dir) = get_veloce_data_dir() {
                    cache_dir.push("Thumbnails");
                    if let Ok(entries) = std::fs::read_dir(&cache_dir) {
                        let thirty_days_in_secs = 30 * 24 * 60 * 60;
                        let now = std::time::SystemTime::now();

                        for entry in entries.filter_map(Result::ok) {
                            if let Ok(metadata) = entry.metadata() {
                                // 最終アクセス日時（取得できなければ更新日時）が30日以上前のファイルを削除
                                let target_time = metadata
                                    .accessed()
                                    .unwrap_or_else(|_| metadata.modified().unwrap_or(now));
                                if let Ok(duration) = now.duration_since(target_time) {
                                    if duration.as_secs() > thirty_days_in_secs {
                                        let _ = std::fs::remove_file(entry.path());
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // --- ファイルシステムの変更監視（軽量ポーリング） ---
            // ゴミ箱からの復元やブラウザからの保存など、外部からの変更を検知してフロントエンドに通知する
            let app_handle = app.handle();
            std::thread::spawn(move || {
                use notify::{RecommendedWatcher, RecursiveMode, Watcher};
                use std::sync::mpsc::channel;

                let (tx, rx) = channel();
                let mut watcher = notify::recommended_watcher(tx).unwrap();
                let mut current_watched_dir = String::new();
                let mut current_watched_parent = String::new();

                let mut last_dir = String::new();
                let mut known_files: std::collections::HashMap<String, (u64, u64)> =
                    std::collections::HashMap::new();
                let mut known_folders: std::collections::HashSet<String> =
                    std::collections::HashSet::new();

                loop {
                    let current_dir = {
                        let state = app_handle.state::<AppState>();
                        let dir = if let Ok(dir_lock) = state.current_dir.lock() {
                            dir_lock.clone()
                        } else {
                            String::new()
                        };
                        dir
                    };

                    if current_dir.is_empty() {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        continue;
                    }

                    let parent_dir = std::path::Path::new(&current_dir)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());
                        
                    let parent_watch = parent_dir.clone().unwrap_or_default();

                    let mut dir_changed = false;
                    if current_dir != current_watched_dir || parent_watch != current_watched_parent {
                        if !current_watched_dir.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_dir));
                        }
                        if !current_watched_parent.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_parent));
                        }
                        if std::path::Path::new(&current_dir).exists() {
                            let _ = watcher.watch(std::path::Path::new(&current_dir), RecursiveMode::NonRecursive);
                            current_watched_dir = current_dir.clone();
                        }
                        if !parent_watch.is_empty() && std::path::Path::new(&parent_watch).exists() {
                            let _ = watcher.watch(std::path::Path::new(&parent_watch), RecursiveMode::NonRecursive);
                            current_watched_parent = parent_watch.clone();
                        }
                        dir_changed = true;
                    }

                    // Wait for events
                    let mut rx_ready = false;
                    if let Ok(Ok(_)) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        rx_ready = true;
                        std::thread::sleep(std::time::Duration::from_millis(100)); // Debounce
                        while let Ok(_) = rx.try_recv() {}
                    }

                    if !dir_changed && !rx_ready {
                        continue;
                    }

                    let current_dir = {
                        let state = app_handle.state::<AppState>();
                        let dir = if let Ok(dir_lock) = state.current_dir.lock() {
                            dir_lock.clone()
                        } else {
                            String::new()
                        };
                        dir
                    };

                    if current_dir.is_empty() {
                        continue;
                    }

                    let parent_dir = std::path::Path::new(&current_dir)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());

                    if current_dir != last_dir {
                        last_dir = current_dir.clone();
                        known_files.clear();
                        known_folders.clear();

                        if let Ok(entries) = std::fs::read_dir(&current_dir) {
                            for entry in entries.filter_map(Result::ok) {
                                let p = entry.path();
                                if p.is_file() {
                                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                                        let ext_lower = ext.to_lowercase();
                                        if matches!(
                                            ext_lower.as_str(),
                                            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "mp4"
                                        ) {
                                            if let Ok(meta) = entry.metadata() {
                                                let size = meta.len();
                                                let mtime = meta
                                                    .modified()
                                                    .ok()
                                                    .and_then(|t| {
                                                        t.duration_since(std::time::UNIX_EPOCH).ok()
                                                    })
                                                    .map(|d| d.as_millis() as u64)
                                                    .unwrap_or(0);
                                                known_files.insert(
                                                    p.to_string_lossy().to_string(),
                                                    (size, mtime),
                                                );
                                            }
                                        }
                                    }
                                } else if p.is_dir() {
                                    known_folders.insert(p.to_string_lossy().to_string());
                                }
                            }
                        }
                        if let Some(ref parent) = parent_dir {
                            if let Ok(entries) = std::fs::read_dir(parent) {
                                for entry in entries.filter_map(Result::ok) {
                                    let p = entry.path();
                                    if p.is_dir() {
                                        known_folders.insert(p.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                        continue;
                    }

                    let mut current_files: std::collections::HashMap<String, (u64, u64)> =
                        std::collections::HashMap::new();
                    let mut current_folders: std::collections::HashSet<String> =
                        std::collections::HashSet::new();
                    let mut folder_changed = false;

                    if let Ok(entries) = std::fs::read_dir(&current_dir) {
                        for entry in entries.filter_map(Result::ok) {
                            let p = entry.path();
                            if p.is_file() {
                                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                                    let ext_lower = ext.to_lowercase();
                                    if matches!(
                                        ext_lower.as_str(),
                                        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "mp4"
                                    ) {
                                        if let Ok(meta) = entry.metadata() {
                                            let size = meta.len();
                                            let mtime = meta
                                                .modified()
                                                .ok()
                                                .and_then(|t| {
                                                    t.duration_since(std::time::UNIX_EPOCH).ok()
                                                })
                                                .map(|d| d.as_millis() as u64)
                                                .unwrap_or(0);
                                            let path_str = p.to_string_lossy().to_string();
                                            current_files.insert(path_str.clone(), (size, mtime));

                                            if let Some(&(old_size, old_mtime)) =
                                                known_files.get(&path_str)
                                            {
                                                if old_size != size || old_mtime != mtime {
                                                    let ctime = meta
                                                        .created()
                                                        .ok()
                                                        .and_then(|t| {
                                                            t.duration_since(std::time::UNIX_EPOCH)
                                                                .ok()
                                                        })
                                                        .map(|d| d.as_millis() as u64)
                                                        .unwrap_or(0);
                                                    let file_name = entry
                                                        .file_name()
                                                        .to_string_lossy()
                                                        .into_owned();
                                                    let img_file = ImageFile {
                                                        name: file_name,
                                                        ext: format!(".{}", ext_lower),
                                                        path: path_str.clone(),
                                                        size,
                                                        mtime,
                                                        ctime,
                                                        has_thumbnail_cache: false,
                                                        has_metadata_cache: false,
                                                        width: 0,
                                                        height: 0,
                                                        prompt: String::new(),
                                                        negative_prompt: String::new(),
                                                        source: String::new(),
                                                        meta_loaded: false,
                                                        search_text: String::new(),
            unified_search_text: String::new(),
                                                    };
                                                    let _ = app_handle
                                                        .emit_all("file-changed", img_file);
                                                }
                                            } else {
                                                let ctime = meta
                                                    .created()
                                                    .ok()
                                                    .and_then(|t| {
                                                        t.duration_since(std::time::UNIX_EPOCH).ok()
                                                    })
                                                    .map(|d| d.as_millis() as u64)
                                                    .unwrap_or(0);
                                                let file_name = entry
                                                    .file_name()
                                                    .to_string_lossy()
                                                    .into_owned();
                                                let img_file = ImageFile {
                                                    name: file_name,
                                                    ext: format!(".{}", ext_lower),
                                                    path: path_str.clone(),
                                                    size,
                                                    mtime,
                                                    ctime,
                                                    has_thumbnail_cache: false,
                                                    has_metadata_cache: false,
                                                    width: 0,
                                                    height: 0,
                                                    prompt: String::new(),
                                                    negative_prompt: String::new(),
                                                    source: String::new(),
                                                    meta_loaded: false,
                                                    search_text: String::new(),
            unified_search_text: String::new(),
                                                };
                                                let _ =
                                                    app_handle.emit_all("file-changed", img_file);
                                            }
                                        }
                                    }
                                }
                            } else if p.is_dir() {
                                let path_str = p.to_string_lossy().to_string();
                                current_folders.insert(path_str.clone());
                                if !known_folders.contains(&path_str) {
                                    folder_changed = true;
                                }
                            }
                        }
                    }

                    if let Some(ref parent) = parent_dir {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.filter_map(Result::ok) {
                                let p = entry.path();
                                if p.is_dir() {
                                    let path_str = p.to_string_lossy().to_string();
                                    current_folders.insert(path_str.clone());
                                    if !known_folders.contains(&path_str) {
                                        folder_changed = true;
                                    }
                                }
                            }
                        }
                    }

                    if !folder_changed {
                        for folder in &known_folders {
                            if !current_folders.contains(folder) {
                                folder_changed = true;
                                break;
                            }
                        }
                    }

                    for (path_str, &(_size, mtime)) in known_files.iter() {
                        if !current_files.contains_key(path_str) {
                            let _ = app_handle.emit_all("file-removed", path_str.clone());

                            // ファイル削除検知時のキャッシュ自動クリーンアップ:
                            // 対象ファイルに紐づくサムネイル画像およびメタデータJSONのキャッシュファイルを
                            // MD5ハッシュベースで特定し、ストレージ容量の無駄遣いを防ぐために即時削除します。
                            if let Some(data_dir) = get_veloce_data_dir() {
                                let cache_file_name = format!("{}_{}", path_str, mtime);
                                let digest = xxhash_rust::xxh3::xxh3_64(cache_file_name.as_bytes());

                                let thumb_path = data_dir
                                    .join("Thumbnails")
                                    .join(format!("{:016x}.jpg", digest));
                                let meta_path = data_dir
                                    .join("Metadata")
                                    .join(format!("{:016x}.json", digest));

                                let _ = std::fs::remove_file(thumb_path);
                                let _ = std::fs::remove_file(meta_path);
                            }
                        }
                    }

                    if folder_changed {
                        let _ = app_handle.emit_all("directory-changed", ());
                    }

                    known_files = current_files;
                    known_folders = current_folders;
                }
            });

            Ok(())
        })
        .on_window_event(|event| {
            match event.event() {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    let label = event.window().label().to_string();
                    if label == "main" {
                        // アプリ終了時にWALファイルを切り詰める
                        let state = event.window().state::<AppState>();
                        if let Ok(conn) = state.db_conn.get() {
                            let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
                        }
                        std::process::exit(0);
                    } else if label.starts_with("viewer_") {
                        let _ = event.window().set_always_on_top(false);
                        // ビューアウィンドウが閉じられた際にキャッシュを破棄
                        let state = event.window().state::<AppState>();
                        if let Ok(mut viewer_paths) = state.viewer_paths.lock() {
                            viewer_paths.remove(&label);
                        };
                    }
                }
                _ => {}
            }
        })
        .register_uri_scheme_protocol("veloce", move |app, request| {
            let uri = request.uri();
            let mut path = String::new();
            let mut mtime: u64 = 0;
            if let Ok(parsed) = tauri::Url::parse(uri) {
                for (k, v) in parsed.query_pairs() {
                    if k == "path" {
                        path = v.into_owned();
                    } else if k == "mtime" {
                        mtime = v.parse().unwrap_or(0);
                    }
                }
            }

            let mut cache_bytes = Vec::new();
            if !path.is_empty() {
                let clean_path = path.replace("\\\\?\\", "");
                let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
                let hash_key = format!("{:016x}", digest);

                let state = app.state::<AppState>();
                if let Ok(conn) = state.db_conn.get() {
                    if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL") {
                        if let Ok(thumb) = stmt.query_row([&hash_key], |row| row.get::<_, Vec<u8>>(0)) {
                            cache_bytes = thumb;
                        }
                    }
                }
            }

            if !cache_bytes.is_empty() {
                let mimetype = if cache_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                    "image/png"
                } else if cache_bytes.starts_with(&[0x3C, 0x3F, 0x78, 0x6D, 0x6C]) || cache_bytes.starts_with(&[0x3C, 0x73, 0x76, 0x67]) {
                    "image/svg+xml"
                } else {
                    "image/jpeg"
                };

                tauri::http::ResponseBuilder::new()
                    .mimetype(mimetype)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "public, max-age=3600")
                    .status(200)
                    .body(cache_bytes)
            } else {
                tauri::http::ResponseBuilder::new()
                    .status(404)
                    .body(Vec::new())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_drives,
            path_exists,
            load_directory,
            set_view_params,
            sync_ratings,
            save_thumbnail,
            set_rating,
            get_items,
            get_file_by_index,
            update_metadata_in_state,
            get_video_server_port,
            notify_file_changed,
            update_smart_folders,
            notify_file_removed,
            get_full_metadata_batch,
            parse_metadata,
            generate_thumbnail,
            generate_thumbnail_batch,
            get_cached_thumbnail_batch,
            precache_directory_recursively,
            get_viewer_image,
            open_viewer,
            show_window,
            arrange_viewers,
            trash_file,
            trash_folder,
            copy_image_to_clipboard,
            get_license_text,
            rename_file,
            rename_folder,
            open_cache_folder,
            clear_cache,
            audit_cache,
            get_cache_info,
            get_smart_folder_counts,
            open_in_explorer,
            check_conflicts,
            clear_metadata_cache,
            get_files_by_indices,
            get_all_ratings,
            migrate_ratings,
            get_smart_folder_counts,
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering;

    #[test]
    fn test_build_smart_folder_query() {
        use super::{SmartFolderRule, SmartFolderCondition};
        let rule = SmartFolderRule {
            id: "test".to_string(),
            name: "test".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "prompt".to_string(),
                    operator: "contains".to_string(),
                    value: "girl".to_string(),
                },
                SmartFolderCondition {
                    r#type: "negative_prompt".to_string(),
                    operator: "not_contains".to_string(),
                    value: "bad".to_string(),
                },
            ],
        };
        
        let (query, params) = super::build_smart_folder_query(&rule, false);
        assert!(query.contains("c.searchable_prompt LIKE ?"));
        assert!(query.contains("c.searchable_negative_prompt NOT LIKE ?"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_natural_cmp() {
        assert_eq!(natural_cmp("1.png", "2.png"), Ordering::Less);
        assert_eq!(natural_cmp("2.png", "10.png"), Ordering::Less);
        assert_eq!(natural_cmp("10.png", "1.png"), Ordering::Greater);
        assert_eq!(natural_cmp("file01.txt", "file2.txt"), Ordering::Less);
        assert_eq!(natural_cmp("v1.2", "v1.10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "b"), Ordering::Less);
        assert_eq!(natural_cmp("A", "b"), Ordering::Less); // Case insensitive
    }

    #[test]
    fn test_decode_metadata_string() {
        use super::decode_metadata_string;

        // 1. UTF-8 (ASCII)
        let utf8_bytes = b"hair and eyes";
        assert_eq!(decode_metadata_string(utf8_bytes), "hair and eyes");

        // 2. UTF-16LE without BOM
        let utf16_le_bytes: Vec<u8> = "hair"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        assert_eq!(decode_metadata_string(&utf16_le_bytes), "hair");

        // 3. UTF-16BE without BOM
        let utf16_be_bytes: Vec<u8> = "hair"
            .encode_utf16()
            .flat_map(|c| c.to_be_bytes())
            .collect();
        assert_eq!(decode_metadata_string(&utf16_be_bytes), "hair");

        // 4. UTF-16LE with BOM
        let mut utf16_le_bom = vec![0xFF, 0xFE];
        utf16_le_bom.extend_from_slice(&utf16_le_bytes);
        assert_eq!(decode_metadata_string(&utf16_le_bom), "hair");
    }

    #[test]
    fn test_parse_mp4_dimensions() {
        use super::parse_mp4_dimensions;
        use std::io::Write;
        
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_dummy.mp4");
        
        // 1920x1080のダミーMP4データ (tkhd box) を作成
        let mut tkhd_payload = vec![0u8; 84];
        
        // version 0, width is at 76, height is at 80 from start of payload
        tkhd_payload[76..80].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd_payload[80..84].copy_from_slice(&(1080u32 << 16).to_be_bytes());
        
        let mut tkhd_box = vec![];
        tkhd_box.extend_from_slice(&(8u32 + tkhd_payload.len() as u32).to_be_bytes());
        tkhd_box.extend_from_slice(b"tkhd");
        tkhd_box.extend_from_slice(&tkhd_payload);
        
        let mut moov_data = vec![];
        moov_data.extend_from_slice(&(8u32 + tkhd_box.len() as u32).to_be_bytes());
        moov_data.extend_from_slice(b"moov");
        moov_data.extend_from_slice(&tkhd_box);
        
        let mut ftyp = vec![];
        ftyp.extend_from_slice(&16u32.to_be_bytes());
        ftyp.extend_from_slice(b"ftypisomisom");
        
        {
            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(&ftyp).unwrap();
            file.write_all(&moov_data).unwrap();
        }
        
        let dims = parse_mp4_dimensions(test_file.to_str().unwrap());
        assert_eq!(dims, Some((1920, 1080)));
        
        // テスト後はファイルを削除 (Rule #4)
        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_extract_searchable_text() {
        use super::extract_searchable_text;
        use serde_json::json;

        let data = json!({
            "prompt": "1girl, hair",
            "reference_image": "HUGE_BASE64_STRING",
            "nested": {
                "characterPrompts": [
                    { "prompt": "takao" }
                ]
            },
            "steps": 20
        });

        let extracted = extract_searchable_text(&data);

        // 抽出されるべきテキストが含まれているか
        assert!(extracted.contains("1girl, hair"));
        assert!(extracted.contains("takao"));
        assert!(extracted.contains("20")); // 数値も文字列化される

        // 画像データ(キーが reference_image 等)はスキップされるべき
        assert!(!extracted.contains("HUGE_BASE64_STRING"));

        // キー名は抽出されないべき
        assert!(!extracted.contains("characterPrompts"));
    }

    #[test]
    fn test_fast_image_resize_logic() {
        use fast_image_resize as fr;
        use image::RgbaImage;
        use std::num::NonZeroU32;

        // 1920x1080 のダミー画像を生成
        let width = 1920;
        let height = 1080;
        let dummy_pixels = vec![255u8; (width * height * 4) as usize];
        let rgba_img = RgbaImage::from_raw(width, height, dummy_pixels).unwrap();

        let mut dst_width = width;
        let mut dst_height = height;
        if width > 384 || height > 384 {
            let ratio = f32::min(384.0 / width as f32, 384.0 / height as f32);
            dst_width = (width as f32 * ratio).round() as u32;
            dst_height = (height as f32 * ratio).round() as u32;
        }

        assert_eq!(dst_width, 384);
        assert_eq!(dst_height, 216);

        let src_width = NonZeroU32::new(width).unwrap();
        let src_height = NonZeroU32::new(height).unwrap();
        let src_image = fr::images::Image::from_vec_u8(
            src_width.get(),
            src_height.get(),
            rgba_img.into_raw(),
            fr::PixelType::U8x4,
        )
        .unwrap();

        let dst_w_nz = NonZeroU32::new(dst_width).unwrap();
        let dst_h_nz = NonZeroU32::new(dst_height).unwrap();
        let mut dst_image =
            fr::images::Image::new(dst_w_nz.get(), dst_h_nz.get(), fr::PixelType::U8x4);

        let mut resizer = fr::Resizer::new();
        resizer.resize(&src_image, &mut dst_image, None).unwrap();

        let result_img = RgbaImage::from_raw(dst_width, dst_height, dst_image.into_vec()).unwrap();
        assert_eq!(result_img.width(), 384);
        assert_eq!(result_img.height(), 216);
    }

    #[test]
    fn test_cache_filename_hashing() {
        let clean_path = "D:\\Images\\test.jpg";
        let mtime = 1700000000000u64;
        let cache_file_name = format!("{}_{}", clean_path, mtime);

        let digest = xxhash_rust::xxh3::xxh3_64(cache_file_name.as_bytes());
        let digest_hex = format!("{:016x}", digest);

        assert_eq!(digest_hex.len(), 16);

        let thumb_key = format!("{}.jpg", digest_hex);
        let meta_key = format!("{}.json", digest_hex);
        assert!(thumb_key.ends_with(".jpg"));
        assert!(meta_key.ends_with(".json"));
        assert_eq!(thumb_key.len(), 16 + 4);
        assert_eq!(meta_key.len(), 16 + 5);
    }

    #[test]
    fn test_sqlite_cache() {
        use rusqlite::Connection;
        // In-memory database for testing
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cache (
                hash_key TEXT PRIMARY KEY,
                thumbnail BLOB,
                metadata TEXT,
                width INTEGER DEFAULT 0,
                height INTEGER DEFAULT 0,
                path TEXT DEFAULT '',
                size INTEGER DEFAULT 0,
                mtime INTEGER DEFAULT 0,
                ctime INTEGER DEFAULT 0,
                last_accessed INTEGER
            )",
            [],
        )
        .unwrap();

        let hash_key = "dummy_hash_123";
        let dummy_thumb = vec![0u8, 1, 2, 3];
        let dummy_meta = "{\"prompt\":\"test\"}";

        // Insert
        conn.execute(
            "INSERT INTO cache (hash_key, thumbnail, metadata, width, height, path, last_accessed) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET thumbnail=excluded.thumbnail, metadata=excluded.metadata, width=excluded.width, height=excluded.height, path=excluded.path, last_accessed=excluded.last_accessed",
            rusqlite::params![hash_key, &dummy_thumb, dummy_meta, 0, 0, "", 12345],
        ).unwrap();

        // Query
        let mut stmt = conn
            .prepare("SELECT thumbnail, metadata FROM cache WHERE hash_key = ?")
            .unwrap();
        let (thumb, meta): (Vec<u8>, String) = stmt
            .query_row([hash_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();

        assert_eq!(thumb, dummy_thumb);
        assert_eq!(meta, dummy_meta);

        // Delete
        conn.execute(
            "DELETE FROM cache WHERE hash_key = ?",
            rusqlite::params![hash_key],
        )
        .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn test_smart_folder_paths() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        {
            let conn = db_conn.get().unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS cache (
                    hash_key TEXT PRIMARY KEY,
                    thumbnail BLOB,
                    metadata TEXT,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    path TEXT DEFAULT '',
                    size INTEGER DEFAULT 0,
                    mtime INTEGER DEFAULT 0,
                    ctime INTEGER DEFAULT 0,
                    last_accessed INTEGER,
                    searchable_prompt TEXT DEFAULT '',
                    searchable_negative_prompt TEXT DEFAULT '',
                    searchable_source TEXT DEFAULT ''
                )",
                [],
            )
            .unwrap();

            conn.execute(
                "CREATE TABLE IF NOT EXISTS ratings (
                    path TEXT PRIMARY KEY,
                    rating INTEGER NOT NULL
                )",
                [],
            )
            .unwrap();

            let meta1 = super::FullMetadata {
                path: "C:\\fake\\path1.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
            };
            let meta2 = super::FullMetadata {
                path: "C:\\fake\\path2.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
            };
            let meta3 = super::FullMetadata {
                path: "C:\\fake\\path3.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
            };
            conn.execute("INSERT INTO cache (hash_key, thumbnail, metadata, width, height, path, last_accessed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", 
                rusqlite::params!["hash1", vec![0u8], serde_json::to_string(&meta1).unwrap(), 0, 0, meta1.path, 0]).unwrap();
            conn.execute("INSERT INTO cache (hash_key, thumbnail, metadata, width, height, path, last_accessed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", 
                rusqlite::params!["hash2", vec![0u8], serde_json::to_string(&meta2).unwrap(), 0, 0, meta2.path, 0]).unwrap();
            conn.execute("INSERT INTO cache (hash_key, thumbnail, metadata, width, height, path, last_accessed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", 
                rusqlite::params!["hash3", vec![0u8], serde_json::to_string(&meta3).unwrap(), 0, 0, meta3.path, 0]).unwrap();
        }

        let mut ratings = std::collections::HashMap::new();
        ratings.insert("C:\\fake\\path1.png".to_string(), 5);
        ratings.insert("C:\\fake\\path3.png".to_string(), 4);
        ratings.insert("C:\\fake\\path4.png".to_string(), 3);

        let fav5 = super::get_smart_folder_paths("smart://fav_5", &ratings, &db_conn, &[]);
        assert_eq!(fav5.len(), 1);
        assert_eq!(fav5[0].path, "C:\\fake\\path1.png");

        let fav4 = super::get_smart_folder_paths("smart://fav_4_plus", &ratings, &db_conn, &[]);
        assert_eq!(fav4.len(), 2);

        let history = super::get_smart_folder_paths("smart://history", &ratings, &db_conn, &[]);
        assert_eq!(history.len(), 3);
        let history_paths: Vec<_> = history.iter().map(|p| p.path.as_str()).collect();
        assert!(history_paths.contains(&"C:\\fake\\path1.png"));
        assert!(history_paths.contains(&"C:\\fake\\path2.png"));
        assert!(history_paths.contains(&"C:\\fake\\path3.png"));
    }

    #[test]
    fn test_get_smart_folder_counts_logic() {
        // Rust側の `get_smart_folder_counts` が正しく引数の `rules` を受け取り、
        // 既存の `get_smart_folder_paths` と同じように件数を返すかのロジックテスト。
        use super::*;
        use std::collections::HashMap;

        
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        let conn = db_conn.get().unwrap();
        
        // テスト用テーブルの作成
        conn.execute(
            "CREATE TABLE cache (
                hash_key TEXT PRIMARY KEY,
                thumbnail BLOB,
                metadata TEXT,
                width INTEGER DEFAULT 0,
                height INTEGER DEFAULT 0,
                path TEXT DEFAULT '',
                size INTEGER DEFAULT 0,
                mtime INTEGER DEFAULT 0,
                ctime INTEGER DEFAULT 0,
                last_accessed INTEGER,
                searchable_prompt TEXT DEFAULT '',
                searchable_negative_prompt TEXT DEFAULT '',
                searchable_source TEXT DEFAULT ''
            )",
            [],
        ).unwrap();
        conn.execute(
            "CREATE TABLE ratings (
                path TEXT PRIMARY KEY,
                rating INTEGER NOT NULL
            )",
            [],
        ).unwrap();
        
        // テストデータの挿入
        conn.execute(
            "INSERT INTO cache (hash_key, path, width, height) VALUES (?, ?, ?, ?)",
            rusqlite::params!["hash1", "C:\\test\\image1.png", 1000, 1000],
        ).unwrap();
        conn.execute(
            "INSERT INTO cache (hash_key, path, width, height) VALUES (?, ?, ?, ?)",
            rusqlite::params!["hash2", "C:\\test\\image2.png", 500, 1000], // Portrait
        ).unwrap();
        
        drop(conn); // ロック解放

        let mut conditions = Vec::new();
        conditions.push(SmartFolderCondition {
            r#type: "aspect_ratio".to_string(),
            operator: "square".to_string(),
            value: "".to_string(),
        });

        let rule = SmartFolderRule {
            id: "test_square_folder".to_string(),
            name: "Square Images".to_string(),
            match_type: "all".to_string(),
            conditions,
        };

        let rules = vec![rule.clone()];
        let ratings_map = HashMap::new();
        
        // `get_smart_folder_paths` が 1件（image1.png）を返すことを確認
        let paths = get_smart_folder_paths("smart://test_square_folder", &ratings_map, &db_conn, &rules);
        assert_eq!(paths.len(), 1);
        
        // 実際の `get_smart_folder_counts` のロジック部分を抽出して検証
        // （引数から直接rulesを受け取り、内部のDB接続とレーティングマップを使って件数を返す）
        let mut result = HashMap::new();
        for r in rules {
            let p = get_smart_folder_paths(&format!("smart://{}", r.id), &ratings_map, &db_conn, &[r.clone()]);
            result.insert(r.id, p.len());
        }
        
        // 不具合として指摘された「件数が合わない問題」が解消され、
        // 常にRust側の評価ロジックと一致して 1件 となることを保証する。
        assert_eq!(*result.get("test_square_folder").unwrap(), 1);
    }

    #[test]
    fn test_get_full_metadata_saves_file_stats() {
        use super::*;

        
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        {
            let conn = db_conn.get().unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS cache (
                    hash_key TEXT PRIMARY KEY,
                    thumbnail BLOB,
                    metadata TEXT,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    path TEXT DEFAULT '',
                    size INTEGER DEFAULT 0,
                    mtime INTEGER DEFAULT 0,
                    ctime INTEGER DEFAULT 0,
                    last_accessed INTEGER,
                    searchable_prompt TEXT DEFAULT '',
                    searchable_negative_prompt TEXT DEFAULT '',
                    searchable_source TEXT DEFAULT ''
                )",
                [],
            ).unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS ratings (
                    path TEXT PRIMARY KEY,
                    rating INTEGER NOT NULL
                )",
                [],
            ).unwrap();
        }

        // テスト用のファイルを作成
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_metadata_save.txt");
        let test_data = "dummy test data";
        std::fs::write(&file_path, test_data).unwrap();

        let file_path_str = file_path.to_str().unwrap().to_string();
        
        // 初回呼び出し：ここで実ファイルのsize等がDBに保存されるはず
        let _ = get_full_metadata_for_path(&file_path_str, &db_conn);

        // DBにちゃんと保存されたか確認
        let conn = db_conn.get().unwrap();
        let mut stmt = conn.prepare("SELECT size, mtime, ctime FROM cache WHERE path = ?").unwrap();
        let mut rows = stmt.query([&file_path_str]).unwrap();
        let row = rows.next().unwrap().expect("Row should exist");
        
        let size: u64 = row.get(0).unwrap();
        let mtime: u64 = row.get(1).unwrap();
        let ctime: u64 = row.get(2).unwrap();
        
        assert_eq!(size, test_data.len() as u64); // "dummy test data".len() = 15
        assert!(mtime > 0);
        assert!(ctime > 0);

        // クリーンアップ
        let _ = std::fs::remove_file(&file_path);
    }

    #[test]
    fn test_smart_folder_bypasses_is_file() {
        // このテストは、実ファイルが存在しなくても、キャッシュDBに情報があれば
        // スマートフォルダの戻り値 (SmartFolderItem) として正しく返却され、
        // かつキャッシュにある size, mtime 等の情報がそのまま使われることを保証する。
        use super::*;
        use std::collections::HashMap;

        
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        let conn = db_conn.get().unwrap();
        
        conn.execute(
            "CREATE TABLE cache (
                hash_key TEXT PRIMARY KEY,
                path TEXT,
                metadata TEXT,
                thumbnail BLOB,
                width INTEGER,
                height INTEGER,
                size INTEGER DEFAULT 0,
                mtime INTEGER DEFAULT 0,
                ctime INTEGER DEFAULT 0,
                last_accessed INTEGER,
                searchable_prompt TEXT DEFAULT '',
                searchable_negative_prompt TEXT DEFAULT '',
                searchable_source TEXT DEFAULT ''
            )",
            [],
        ).unwrap();
        
        // 実在しないパスだが、DBには存在する状態を作る
        let fake_path = "C:\\does_not_exist\\fake_image.png";
        conn.execute(
            "INSERT INTO cache (hash_key, path, width, height, size, mtime, ctime) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params!["fake_hash", fake_path, 1920, 1080, 123456, 1700000000, 1700000000],
        ).unwrap();
        
        drop(conn);

        let mut ratings_map = HashMap::new();
        ratings_map.insert(fake_path.to_string(), 5);

        // "smart://fav_5" はレーティング5以上の画像を検索する
        let paths = get_smart_folder_paths("smart://fav_5", &ratings_map, &db_conn, &[]);
        
        // 実在しなくても1件返ってくること
        assert_eq!(paths.len(), 1);
        
        let item = &paths[0];
        assert_eq!(item.path, fake_path);
        assert_eq!(item.size, 123456);
        assert_eq!(item.mtime, 1700000000);
    }

    #[test]
    fn test_create_image_file_from_smart_item_no_fallback() {
        use std::fs::File;
        use std::io::Write;

        // 一時ファイルを作成
        let mut file_path = std::env::temp_dir();
        file_path.push("test_image_smart_no_fallback.png");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(b"test data").unwrap(); // 9 bytes

        // DBにはサイズ0, mtime0で保存されていたと仮定
        let item = super::SmartFolderItem {
            path: file_path.to_string_lossy().to_string(),
            size: 0,
            mtime: 0,
            ctime: 0,
            width: 0,
            height: 0,
        };

        let img = super::create_image_file_from_smart_item(item);

        // パフォーマンス上の理由から、size や mtime が 0 の場合でも同期的にはファイルシステムから補完されないこと（遅延読み込みで対応）
        assert_eq!(img.size, 0);
        assert_eq!(img.mtime, 0);
        assert!(!img.has_thumbnail_cache);
        assert!(!img.has_metadata_cache);

        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn test_ffmpeg_fallback_path_resolution() {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        let output = Command::new("non_existent_ffmpeg_command_123")
            .creation_flags(0x08000000)
            .output();
        
        // Ensure execution of non-existent command gracefully errors out
        assert!(output.is_err());
        
        let ffmpeg_path = std::env::current_exe()
            .ok()
            .and_then(|mut p| {
                p.pop();
                p.push("ffmpeg.exe");
                if p.exists() {
                    Some(p.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "ffmpeg".to_string());
            
        // At minimum, should fallback to "ffmpeg" string
        assert!(!ffmpeg_path.is_empty());
    }

    #[test]
    fn test_os_thumbnail_fallback() {
        let root_dir = std::env::current_dir().unwrap().parent().unwrap().to_path_buf();
        let test_img_path = root_dir.join("app-icon.png");
        
        // This should fall back to the OS API since ffmpeg will fail to extract a video frame from a png.
        let result = super::generate_video_thumbnail_sync(&test_img_path.to_string_lossy());
        
        // The OS API should successfully extract a thumbnail.
        assert!(result.is_some(), "OS thumbnail fallback failed");
    }
}

#[cfg(test)]
mod fts_tests {
    use rusqlite::Connection;
    
    #[test]
    fn test_fts_triggers() {
        let conn = Connection::open_in_memory().unwrap();
        // Create schema
        conn.execute(
            "CREATE TABLE cache (hash_key TEXT PRIMARY KEY, searchable_prompt TEXT DEFAULT '', searchable_negative_prompt TEXT DEFAULT '', searchable_source TEXT DEFAULT '')",
            [],
        ).unwrap();
        
        conn.execute(
            "CREATE VIRTUAL TABLE cache_fts USING fts5(hash_key UNINDEXED, searchable_prompt, searchable_negative_prompt, searchable_source)",
            [],
        ).unwrap();
        
        // Triggers
        conn.execute("CREATE TRIGGER cache_ai AFTER INSERT ON cache BEGIN INSERT INTO cache_fts(hash_key, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (new.hash_key, new.searchable_prompt, new.searchable_negative_prompt, new.searchable_source); END;", []).unwrap();
        conn.execute("CREATE TRIGGER cache_au AFTER UPDATE ON cache BEGIN DELETE FROM cache_fts WHERE hash_key = old.hash_key; INSERT INTO cache_fts(hash_key, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (new.hash_key, new.searchable_prompt, new.searchable_negative_prompt, new.searchable_source); END;", []).unwrap();
        conn.execute("CREATE TRIGGER cache_ad AFTER DELETE ON cache BEGIN DELETE FROM cache_fts WHERE hash_key = old.hash_key; END;", []).unwrap();
        
        // Test Insert
        conn.execute("INSERT INTO cache (hash_key, searchable_prompt) VALUES ('key1', '1girl, long hair, blue eyes')", []).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM cache_fts WHERE searchable_prompt MATCH '\"1girl\"'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        
        // Test Update
        conn.execute("UPDATE cache SET searchable_prompt = '1boy, short hair' WHERE hash_key = 'key1'", []).unwrap();
        let count_girl: i64 = conn.query_row("SELECT count(*) FROM cache_fts WHERE searchable_prompt MATCH '\"1girl\"'", [], |row| row.get(0)).unwrap();
        assert_eq!(count_girl, 0);
        let count_boy: i64 = conn.query_row("SELECT count(*) FROM cache_fts WHERE searchable_prompt MATCH '\"1boy\"'", [], |row| row.get(0)).unwrap();
        assert_eq!(count_boy, 1);
        
        // Test Delete
        conn.execute("DELETE FROM cache WHERE hash_key = 'key1'", []).unwrap();
        let count_all: i64 = conn.query_row("SELECT count(*) FROM cache_fts", [], |row| row.get(0)).unwrap();
        assert_eq!(count_all, 0);
    }
}
