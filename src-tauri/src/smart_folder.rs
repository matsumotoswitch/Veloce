//! # Veloce - Smart Folder Module (smart_folder.rs)
//!
//! 本モジュールは、スマートフォルダの SQL クエリ構築（FTS5 全文検索、メタデータ・メディア種別・
//! パス・レーティング・サイズ・アスペクト比等の条件評価）、高速単一パスロード、
//! およびスマートフォルダ件数取得・ルール更新処理を提供する。

use compact_str::{format_compact, CompactString};
use crate::models::{ImageFile, SmartFolderItem, SmartFolderRule};
use crate::state::AppState;
use crate::utils::normalize_unc_path;

/// スマートフォルダの全件バックグラウンドパージの最小実行間隔（24時間相当 = 86,400,000ms）
pub const SMART_PURGE_MIN_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// スマートフォルダの全件バックグラウンドパージを実行すべきかを判定する純粋関数
///
/// - `last_run_ms`: 前回完了時の Unix タイムスタンプ（ミリ秒）。None の場合は初回実行とみなす。
/// - `current_time_ms`: 現在の Unix タイムスタンプ（ミリ秒）。
/// - `min_interval_ms`: パージ実行の最小インターバル（ミリ秒）。
pub fn should_run_smart_purge(
    last_run_ms: Option<u64>,
    current_time_ms: u64,
    min_interval_ms: u64,
) -> bool {
    match last_run_ms {
        None => true,
        Some(last) => {
            if current_time_ms < last {
                // システム時計の巻き戻り等が発生した場合は安全側に倒して実行
                true
            } else {
                current_time_ms - last >= min_interval_ms
            }
        }
    }
}

pub(crate) fn create_image_file_from_smart_item(item: SmartFolderItem) -> ImageFile {
    let p = std::path::Path::new(&item.path);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    let file_name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let clean_path = item.path.replace("\\\\?\\", "");

    let size = item.size;
    let mtime = item.mtime;
    let ctime = item.ctime;

    let has_searchable = !item.searchable_prompt.is_empty()
        || !item.searchable_negative_prompt.is_empty()
        || !item.searchable_source.is_empty();
    let meta_loaded = item.metadata.is_some() || (item.has_metadata && has_searchable);

    let search_text = if let Some(meta_str) = &item.metadata {
        format!("{} {}", item.path, meta_str).to_lowercase()
    } else {
        item.path.to_lowercase()
    };
    let unified_search_text = if has_searchable || item.has_metadata {
        format!(
            "{} {} {} {}",
            file_name.to_lowercase(),
            item.searchable_prompt,
            item.searchable_negative_prompt,
            item.searchable_source
        )
    } else {
        search_text.clone()
    };

    ImageFile {
        name: file_name,
        ext: if ext.is_empty() { CompactString::default() } else { format_compact!(".{}", ext) },
        path: clean_path,
        size,
        mtime,
        ctime,
        has_thumbnail_cache: item.has_thumbnail,
        width: item.width,
        height: item.height,
        prompt: item.searchable_prompt,
        negative_prompt: item.searchable_negative_prompt,
        source: item.searchable_source,
        meta_loaded,
        search_text,
        unified_search_text,
        hash_key: if item.hash_key.is_empty() {
            CompactString::default()
        } else {
            CompactString::from(item.hash_key)
        },
    }
}

pub(crate) fn build_safe_fts_query(input: &str) -> String {
    let terms: Vec<&str> = input.split(|c| c == ',' || c == '、' || c == '\n' || c == '\r')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();

    if terms.is_empty() {
        return String::new();
    }

    let mut fts_parts = Vec::new();
    for term in terms {
        let safe_term = term.replace("\"", "\"\"");
        fts_parts.push(format!("\"{}\"", safe_term));
    }

    fts_parts.join(" AND ")
}

/// スマートフォルダ条件の比較演算子を SQL 用の安全な演算子文字列に正規化する
pub(crate) fn normalize_comparison_operator(op: &str) -> &'static str {
    match op.trim() {
        ">=" => ">=",
        "<=" => "<=",
        ">" => ">",
        "<" => "<",
        "!=" | "<>" => "!=",
        "==" | "=" => "=",
        _ => "=",
    }
}

/// SQLite の `LIKE ... ESCAPE '\'` 句向けに、ワイルドカード文字（`\`, `%`, `_`）をエスケープする
pub(crate) fn escape_sql_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// 前方一致の範囲比較（`c.path >= ? AND c.path < ?`）に用いる上限文字列を算出する。
/// `base` の最終文字（通常は `\` または `/`）を Unicode スカラー値で 1 つ進めた文字列を返す
/// （`\` → `]`、`/` → `0`）。空文字列または進められない文字の場合は `None` を返す。
pub(crate) fn prefix_upper_bound(base: &str) -> Option<String> {
    let mut chars = base.chars();
    let last = chars.next_back()?;
    let next_char = char::from_u32((last as u32).checked_add(1)?)?;
    let mut upper = String::with_capacity(base.len() + 4);
    upper.push_str(chars.as_str());
    upper.push(next_char);
    Some(upper)
}

/// スマートフォルダの検索条件（パス、拡張子、レーティング、サイズ、プロンプト全文検索等）から、
/// SQLite 用の実行クエリ（SELECT / COUNT）およびバインドパラメータを動的に生成する（ソート条件・リミット指定対応）
pub(crate) fn build_smart_folder_query_with_sort(
    rule: &SmartFolderRule,
    is_count: bool,
    use_fallback: bool,
    sort_key: Option<&str>,
    asc: bool,
    limit: Option<usize>,
) -> (String, Vec<rusqlite::types::Value>) {
    let select_clause = if is_count {
        "SELECT COUNT(c.path)"
    } else {
        "SELECT c.path, c.size, c.mtime, c.ctime, c.width, c.height, (c.thumbnail IS NOT NULL), c.hash_key, IFNULL(c.searchable_prompt, ''), IFNULL(c.searchable_negative_prompt, ''), IFNULL(c.searchable_source, ''), (c.metadata IS NOT NULL)"
    };

    let has_rating_cond = rule.conditions.iter().any(|c| c.r#type == "rating");

    let mut is_inner_join = false;
    if rule.match_type == "all" && has_rating_cond {
        is_inner_join = rule.conditions.iter().any(|c| {
            if c.r#type == "rating" {
                let rating_val: i64 = c.value.parse().unwrap_or(0);
                let op = normalize_comparison_operator(&c.operator);
                match op {
                    ">=" | ">" | "=" => rating_val > 0,
                    _ => false,
                }
            } else {
                false
            }
        });
    }

    let mut query = if is_inner_join {
        format!("{} FROM ratings r INNER JOIN cache c ON r.path = c.path WHERE c.path != '' AND c.path IS NOT NULL", select_clause)
    } else if has_rating_cond {
        format!("{} FROM cache c LEFT JOIN ratings r ON c.path = r.path WHERE c.path != '' AND c.path IS NOT NULL", select_clause)
    } else {
        format!("{} FROM cache c WHERE c.path != '' AND c.path IS NOT NULL", select_clause)
    };
    let mut params = Vec::new();

    let order_direction = if asc { "ASC" } else { "DESC" };
    let order_clause = match sort_key {
        Some("mtime") => format!(" ORDER BY c.mtime {}", order_direction),
        Some("ctime") => format!(" ORDER BY c.ctime {}", order_direction),
        Some("size") => format!(" ORDER BY c.size {}", order_direction),
        Some("width") => format!(" ORDER BY c.width {}", order_direction),
        Some("height") => format!(" ORDER BY c.height {}", order_direction),
        // 名前順・レーティング順・縦横比順は Rust 側で高速並列ソートを行う。
        // SQL 側ではカバリングインデックス idx_cache_smart_cover_mtime を確実に効かせるため
        // ORDER BY c.mtime DESC を維持し、主テーブルのフルスキャン（数GBのディスクI/O）を完全に回避する
        Some("name") | Some("rating") | Some("ratio") => " ORDER BY c.mtime DESC".to_string(),
        _ => " ORDER BY c.mtime DESC".to_string(),
    };

    if rule.conditions.is_empty() {
        if !is_count {
            query.push_str(&order_clause);
            if let Some(lim) = limit {
                query.push_str(&format!(" LIMIT {}", lim));
            }
        }
        return (query, params);
    }

    let logical_op = if rule.match_type == "all" { " AND " } else { " OR " };
    query.push_str(" AND (");

    for (i, cond) in rule.conditions.iter().enumerate() {
        if i > 0 { query.push_str(logical_op); }

        let clause;
        let val_lower = cond.value.to_lowercase();
        let _val_like = format!("%{}%", val_lower);
        
        match cond.r#type.as_str() {
            "prompt" => {
                if use_fallback {
                    let like_query = format!("%{}%", val_lower.replace("%", "\\%").replace("_", "\\_"));
                    if cond.operator == "contains" {
                        clause = "c.searchable_prompt LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else if cond.operator == "not_contains" {
                        clause = "c.searchable_prompt NOT LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else { clause = "1=1".to_string(); }
                } else {
                    let fts_query = build_safe_fts_query(&val_lower);
                    if fts_query.is_empty() {
                        clause = "1=1".to_string();
                    } else if cond.operator == "contains" {
                        clause = "c.rowid IN (SELECT rowid FROM cache_fts WHERE searchable_prompt MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else if cond.operator == "not_contains" {
                        clause = "c.rowid NOT IN (SELECT rowid FROM cache_fts WHERE searchable_prompt MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else { clause = "1=1".to_string(); }
                }
            }
            "negative_prompt" => {
                if use_fallback {
                    let like_query = format!("%{}%", val_lower.replace("%", "\\%").replace("_", "\\_"));
                    if cond.operator == "contains" {
                        clause = "c.searchable_negative_prompt LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else if cond.operator == "not_contains" {
                        clause = "c.searchable_negative_prompt NOT LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else { clause = "1=1".to_string(); }
                } else {
                    let fts_query = build_safe_fts_query(&val_lower);
                    if fts_query.is_empty() {
                        clause = "1=1".to_string();
                    } else if cond.operator == "contains" {
                        clause = "c.rowid IN (SELECT rowid FROM cache_fts WHERE searchable_negative_prompt MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else if cond.operator == "not_contains" {
                        clause = "c.rowid NOT IN (SELECT rowid FROM cache_fts WHERE searchable_negative_prompt MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else { clause = "1=1".to_string(); }
                }
            }
            "source" => {
                let is_pos = cond.operator == "contains" || cond.operator == "==" || cond.operator == "=";
                let is_neg = cond.operator == "not_contains" || cond.operator == "!=" || cond.operator == "<>";
                if use_fallback {
                    let like_query = format!("%{}%", val_lower.replace("%", "\\%").replace("_", "\\_"));
                    if is_pos {
                        clause = "c.searchable_source LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else if is_neg {
                        clause = "c.searchable_source NOT LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(like_query));
                    } else { clause = "1=1".to_string(); }
                } else {
                    let fts_query = build_safe_fts_query(&val_lower);
                    if fts_query.is_empty() {
                        clause = "1=1".to_string();
                    } else if is_pos {
                        clause = "c.rowid IN (SELECT rowid FROM cache_fts WHERE searchable_source MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else if is_neg {
                        clause = "c.rowid NOT IN (SELECT rowid FROM cache_fts WHERE searchable_source MATCH ?)".to_string();
                        params.push(rusqlite::types::Value::Text(fts_query));
                    } else { clause = "1=1".to_string(); }
                }
            }
            "media_type" => {
                let media_key = if val_lower.trim().is_empty() {
                    cond.operator.trim().to_lowercase()
                } else {
                    val_lower.trim().to_string()
                };
                let target_exts: &[&str] = match media_key.as_str() {
                    "image" => &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                    "video" => &["mp4"],
                    "audio" => &["mp3"],
                    _ => &[],
                };
                if target_exts.is_empty() {
                    clause = "1=1".to_string();
                } else {
                    let is_negated = normalize_comparison_operator(&cond.operator) == "!="
                        || cond.operator == "not_contains";
                    let mut parts = Vec::with_capacity(target_exts.len());
                    for ext in target_exts {
                        if is_negated {
                            parts.push("LOWER(c.path) NOT LIKE ? ESCAPE '\\'");
                        } else {
                            parts.push("LOWER(c.path) LIKE ? ESCAPE '\\'");
                        }
                        params.push(rusqlite::types::Value::Text(format!("%.{}", ext)));
                    }
                    let joiner = if is_negated { " AND " } else { " OR " };
                    clause = format!("({})", parts.join(joiner));
                }
            }
            "ext" => {
                let exts: Vec<String> = val_lower
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .map(|s| s.trim().trim_start_matches('.').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if exts.is_empty() {
                    clause = "1=1".to_string();
                } else {
                    let is_negated = normalize_comparison_operator(&cond.operator) == "!="
                        || cond.operator == "not_contains";
                    let mut parts = Vec::with_capacity(exts.len());
                    for ext in exts {
                        if is_negated {
                            parts.push("LOWER(c.path) NOT LIKE ? ESCAPE '\\'");
                        } else {
                            parts.push("LOWER(c.path) LIKE ? ESCAPE '\\'");
                        }
                        params.push(rusqlite::types::Value::Text(format!(
                            "%.{}",
                            escape_sql_like(&ext)
                        )));
                    }
                    let joiner = if is_negated { " AND " } else { " OR " };
                    clause = format!("({})", parts.join(joiner));
                }
            }
            "metadata_source" => {
                let target_source = val_lower.trim().to_string();
                if target_source.is_empty() {
                    clause = "1=1".to_string();
                } else {
                    let is_negated = normalize_comparison_operator(&cond.operator) == "!="
                        || cond.operator == "not_contains";
                    if target_source == "exif" {
                        if is_negated {
                            clause = "(LOWER(coalesce(NULLIF(c.metadata_source, ''), 'None')) != 'webp exif' AND LOWER(coalesce(NULLIF(c.metadata_source, ''), 'None')) != 'jpeg exif')".to_string();
                        } else {
                            clause = "(LOWER(coalesce(NULLIF(c.metadata_source, ''), 'None')) = 'webp exif' OR LOWER(coalesce(NULLIF(c.metadata_source, ''), 'None')) = 'jpeg exif')".to_string();
                        }
                    } else {
                        let cmp_op = if is_negated { "!=" } else { "=" };
                        clause = format!(
                            "LOWER(coalesce(NULLIF(c.metadata_source, ''), 'None')) {} ?",
                            cmp_op
                        );
                        params.push(rusqlite::types::Value::Text(target_source));
                    }
                }
            }
            "rating" => {
                let rating_val: i64 = cond.value.parse().unwrap_or(0);
                let op = normalize_comparison_operator(&cond.operator);
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
                let op = normalize_comparison_operator(&cond.operator);
                clause = format!("c.width {} ?", op);
                params.push(rusqlite::types::Value::Integer(w_val));
            }
            "height" => {
                let h_val: i64 = cond.value.parse().unwrap_or(0);
                let op = normalize_comparison_operator(&cond.operator);
                clause = format!("c.height {} ?", op);
                params.push(rusqlite::types::Value::Integer(h_val));
            }
            "path" => {
                let mut base_path = cond.value.clone();
                if !base_path.ends_with('\\') && !base_path.ends_with('/') {
                    base_path.push('\\');
                }

                if cond.operator == "under_folder" {
                    if let Some(upper) = prefix_upper_bound(&base_path) {
                        clause = "(c.path >= ? AND c.path < ?)".to_string();
                        params.push(rusqlite::types::Value::Text(base_path));
                        params.push(rusqlite::types::Value::Text(upper));
                    } else {
                        let escaped_base = escape_sql_like(&base_path);
                        clause = "c.path LIKE ? ESCAPE '\\'".to_string();
                        params.push(rusqlite::types::Value::Text(format!("{}%", escaped_base)));
                    }
                } else if cond.operator == "in_folder" {
                    let escaped_base = escape_sql_like(&base_path);
                    let not_like_slash = format!("{}%/%", escaped_base);
                    let not_like_bslash = format!("{}%\\\\%", escaped_base);

                    if let Some(upper) = prefix_upper_bound(&base_path) {
                        clause = "(c.path >= ? AND c.path < ? AND c.path NOT LIKE ? ESCAPE '\\' AND c.path NOT LIKE ? ESCAPE '\\')".to_string();
                        params.push(rusqlite::types::Value::Text(base_path));
                        params.push(rusqlite::types::Value::Text(upper));
                        params.push(rusqlite::types::Value::Text(not_like_slash));
                        params.push(rusqlite::types::Value::Text(not_like_bslash));
                    } else {
                        let base_like = format!("{}%", escaped_base);
                        clause = "(c.path LIKE ? ESCAPE '\\' AND c.path NOT LIKE ? ESCAPE '\\' AND c.path NOT LIKE ? ESCAPE '\\')".to_string();
                        params.push(rusqlite::types::Value::Text(base_like));
                        params.push(rusqlite::types::Value::Text(not_like_slash));
                        params.push(rusqlite::types::Value::Text(not_like_bslash));
                    }
                } else { clause = "1=1".to_string(); }
            }
            _ => { clause = "1=1".to_string(); }
        }
        query.push_str(&clause);
    }

    query.push_str(")");

    if !is_count {
        query.push_str(&order_clause);
        if let Some(lim) = limit {
            query.push_str(&format!(" LIMIT {}", lim));
        }
    }

    (query, params)
}

/// 既存の後方互換性を担保するラッパー関数
pub(crate) fn build_smart_folder_query(
    rule: &SmartFolderRule,
    is_count: bool,
    use_fallback: bool,
) -> (String, Vec<rusqlite::types::Value>) {
    build_smart_folder_query_with_sort(rule, is_count, use_fallback, None, false, None)
}

/// SQLite コネクションに対する `PRAGMA case_sensitive_like = ON;` をスコープ内でのみ有効化し、
/// スコープ終了時（Drop時）に確実に `OFF` にリセットしてコネクションプールへ返却する RAII ガード。
pub(crate) struct CaseSensitiveLikeGuard<'a>(pub(crate) &'a rusqlite::Connection);

impl<'a> CaseSensitiveLikeGuard<'a> {
    pub(crate) fn new(conn: &'a rusqlite::Connection) -> Self {
        let _ = conn.execute("PRAGMA case_sensitive_like = ON;", []);
        Self(conn)
    }
}

impl<'a> Drop for CaseSensitiveLikeGuard<'a> {
    fn drop(&mut self) {
        let _ = self.0.execute("PRAGMA case_sensitive_like = OFF;", []);
    }
}

/// SQLite クエリから中間オブジェクトを介さず、直接 ImageFile の Arc リストを高速生成する
pub(crate) fn query_smart_folder_image_files(
    rule: &SmartFolderRule,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    sort_key: Option<&str>,
    asc: bool,
    limit: Option<usize>,
) -> Vec<std::sync::Arc<ImageFile>> {
    let mut files = Vec::with_capacity(limit.unwrap_or(35000));
    let Ok(conn) = db_conn.get() else {
        return files;
    };
    let _like_guard = CaseSensitiveLikeGuard::new(&conn);

    let (mut query_str, mut params) = build_smart_folder_query_with_sort(rule, false, false, sort_key, asc, limit);

    let stmt_result = conn.prepare(&query_str).or_else(|_| {
        let (fallback_query, fallback_params) = build_smart_folder_query_with_sort(rule, false, true, sort_key, asc, limit);
        query_str = fallback_query;
        params = fallback_params;
        conn.prepare(&query_str)
    });

    if let Ok(mut stmt) = stmt_result {
        if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
            let raw_path: String = row.get(0)?;
            let size: u64 = row.get(1)?;
            let mtime: u64 = row.get(2)?;
            let ctime: u64 = row.get(3)?;
            let width: u32 = row.get(4)?;
            let height: u32 = row.get(5)?;
            let has_thumbnail: bool = row.get(6)?;
            let hash_key: CompactString = row.get::<_, String>(7).map(CompactString::from).unwrap_or_default();
            let sp: String = row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_default();
            let snp: String = row.get::<_, Option<String>>(9).unwrap_or_default().unwrap_or_default();
            let ss: String = row.get::<_, Option<String>>(10).unwrap_or_default().unwrap_or_default();
            let has_metadata: bool = row.get::<_, Option<bool>>(11).unwrap_or_default().unwrap_or(false);

            let clean_path = normalize_unc_path(&raw_path).replace('/', "\\");

            // 高速なファイル名・拡張子抽出（Path::new パースを回避）
            let (file_name, ext) = {
                let bytes = clean_path.as_bytes();
                let last_sep = bytes.iter().rposition(|&b| b == b'/' || b == b'\\');
                let name_slice = match last_sep {
                    Some(pos) => &clean_path[pos + 1..],
                    None => &clean_path[..],
                };
                let ext_dot = name_slice.as_bytes().iter().rposition(|&b| b == b'.');
                let ext_str = match ext_dot {
                    Some(pos) => format_compact!(".{}", name_slice[pos + 1..].to_lowercase()),
                    None => CompactString::default(),
                };
                (name_slice.to_string(), ext_str)
            };

            let name_lower = file_name.to_lowercase();
            let unified_search_text = format!("{} {} {} {}", name_lower, sp, snp, ss);
            let meta_loaded = has_metadata && (!sp.is_empty() || !snp.is_empty() || !ss.is_empty());

            Ok(std::sync::Arc::new(ImageFile {
                name: file_name,
                ext,
                path: clean_path,
                size,
                mtime,
                ctime,
                has_thumbnail_cache: has_thumbnail,
                width,
                height,
                prompt: sp,
                negative_prompt: snp,
                source: ss,
                meta_loaded,
                search_text: String::new(),
                unified_search_text,
                hash_key,
            }))
        }) {
            for r in rows.flatten() {
                files.push(r);
            }
        }
    }

    files
}

/// `cache_fts`（存在しない環境では `cache` の 900 件分割 `IN` クエリ）から、
/// 指定 `target_hashes` に一致する検索用テキスト `(searchable_prompt, searchable_negative_prompt, searchable_source)` を取得する。
pub(crate) fn fetch_smart_folder_search_texts(
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    target_hashes: &std::collections::HashSet<String>,
) -> std::collections::HashMap<String, (String, String, String)> {
    let mut map = std::collections::HashMap::new();
    if target_hashes.is_empty() {
        return map;
    }
    let Ok(conn) = db_conn.get() else {
        return map;
    };

    // 1. BLOB を一切含まない独立した FTS5 テーブル `cache_fts` を 1 パスで読み取る
    let fts_sql = "SELECT hash_key, IFNULL(searchable_prompt, ''), IFNULL(searchable_negative_prompt, ''), IFNULL(searchable_source, '') FROM cache_fts";
    if let Ok(mut stmt) = conn.prepare(fts_sql) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }) {
            for r in rows.flatten() {
                if target_hashes.contains(&r.0) {
                    map.insert(r.0, (r.1, r.2, r.3));
                }
            }
        }
        return map;
    }

    // 2. フォールバック: `cache_fts` テーブルが存在しない環境（テスト DB 等）のみ `cache` から 900 件分割で取得
    let keys: Vec<&String> = target_hashes.iter().collect();
    for chunk in keys.chunks(900) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let query = format!(
            "SELECT hash_key, IFNULL(searchable_prompt, ''), IFNULL(searchable_negative_prompt, ''), IFNULL(searchable_source, '') FROM cache WHERE hash_key IN ({})",
            placeholders
        );
        if let Ok(mut stmt) = conn.prepare(&query) {
            let params: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|s| *s as &dyn rusqlite::ToSql).collect();
            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            }) {
                for r in rows.flatten() {
                    map.insert(r.0, (r.1, r.2, r.3));
                }
            }
        }
    }

    map
}

/// 指定した `ImageFile` スライスに対して、`cache_fts`（またはフォールバック `cache`）から
/// `prompt` / `negative_prompt` / `source` / `unified_search_text` / `meta_loaded` を復元する。
pub(crate) fn hydrate_smart_folder_search_text(
    files: &mut [std::sync::Arc<ImageFile>],
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> usize {
    let target_hashes: std::collections::HashSet<String> = files
        .iter()
        .filter(|f| !f.hash_key.is_empty())
        .map(|f| f.hash_key.to_string())
        .collect();
    if target_hashes.is_empty() {
        return 0;
    }

    let search_map = fetch_smart_folder_search_texts(db_conn, &target_hashes);
    if search_map.is_empty() {
        return 0;
    }

    let mut updated = 0usize;
    for f_arc in files.iter_mut() {
        if let Some((sp, snp, ss)) = search_map.get(f_arc.hash_key.as_str()) {
            let f = std::sync::Arc::make_mut(f_arc);
            let name_lower = f.name.to_lowercase();
            f.unified_search_text = format!("{} {} {} {}", name_lower, sp, snp, ss);
            f.meta_loaded = !sp.is_empty() || !snp.is_empty() || !ss.is_empty();
            f.prompt = sp.clone();
            f.negative_prompt = snp.clone();
            f.source = ss.clone();
            updated += 1;
        }
    }

    updated
}

/// `AppState` 上の表示中スマートフォルダに対して検索用テキストを充填する。
/// `expected_epoch_and_dir` が指定された場合は、DB 読み取り前後で世代番号とカレントディレクトリを検証し、
/// フォルダ移動・タブ切替で世代が変わっていれば適用せずに打ち切る。
/// 戻り値は `Some(更新件数)`（適用完了）または `None`（世代不一致による打ち切り）。
pub(crate) fn hydrate_smart_folder_search_text_for_state(
    state: &AppState,
    expected_epoch_and_dir: Option<(u64, &str)>,
) -> Option<usize> {
    let check_epoch = || -> bool {
        if let Some((expected_epoch, expected_dir)) = expected_epoch_and_dir {
            let cur_dir = state.current_dir.read();
            crate::should_continue_metadata_bg_task(
                expected_epoch,
                crate::current_metadata_bg_epoch(),
                &cur_dir,
                expected_dir,
            )
        } else {
            state.current_dir.read().starts_with("smart://")
        }
    };

    if !check_epoch() {
        return None;
    }

    // 1. 短時間の読み取りロックで対象 hash_key 集合だけ抽出して即座にロックを解放
    let target_hashes: std::collections::HashSet<String> = {
        let all_files = state.all_files.read();
        all_files
            .iter()
            .filter(|f| !f.hash_key.is_empty())
            .map(|f| f.hash_key.to_string())
            .collect()
    };

    // 2. ロックを保持せずに DB（cache_fts 優先）から検索テキストを一括取得
    let search_map = fetch_smart_folder_search_texts(&state.db_conn, &target_hashes);

    // 3. DB 読み取り後に世代・カレントディレクトリを再検証（移動済みなら適用せず打ち切り）
    if !check_epoch() {
        return None;
    }

    if search_map.is_empty() {
        state.smart_search_hydrated.store(true, std::sync::atomic::Ordering::Release);
        return Some(0);
    }

    // 4. all_files を更新し、更新済み Arc を記録してから filtered_files へ同期（AB-BA デッドロック回避）
    let mut updated_by_hash: std::collections::HashMap<String, std::sync::Arc<ImageFile>> =
        std::collections::HashMap::with_capacity(search_map.len());
    {
        let mut all_files = state.all_files.write();
        if !check_epoch() {
            return None;
        }
        for f_arc in all_files.iter_mut() {
            if let Some((sp, snp, ss)) = search_map.get(f_arc.hash_key.as_str()) {
                let f = std::sync::Arc::make_mut(f_arc);
                let name_lower = f.name.to_lowercase();
                f.unified_search_text = format!("{} {} {} {}", name_lower, sp, snp, ss);
                f.meta_loaded = !sp.is_empty() || !snp.is_empty() || !ss.is_empty();
                f.prompt = sp.clone();
                f.negative_prompt = snp.clone();
                f.source = ss.clone();
                updated_by_hash.insert(f.hash_key.to_string(), std::sync::Arc::clone(f_arc));
            }
        }
    }

    if !updated_by_hash.is_empty() {
        let mut filtered_files = state.filtered_files.write();
        if !check_epoch() {
            return None;
        }
        for f_arc in filtered_files.iter_mut() {
            if let Some(updated_arc) = updated_by_hash.get(f_arc.hash_key.as_str()) {
                *f_arc = std::sync::Arc::clone(updated_arc);
            }
        }
    }

    state.smart_search_hydrated.store(true, std::sync::atomic::Ordering::Release);
    Some(updated_by_hash.len())
}

pub(crate) fn get_smart_folder_paths(
    folder_type: &str,
    ratings_map: &std::collections::HashMap<String, u8>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    rules: &[SmartFolderRule],
) -> Vec<SmartFolderItem> {
    let mut target_paths = Vec::new();
    let folder_id = folder_type.replace("smart://", "");

    if let Some(rule) = rules.iter().find(|r| r.id == folder_id) {
        if let Ok(conn) = db_conn.get() {
            let _like_guard = CaseSensitiveLikeGuard::new(&conn);
            
            let (mut query_str, mut params) = build_smart_folder_query(rule, false, false);

            let stmt_result = conn.prepare(&query_str).or_else(|_| {
                let (fallback_query, fallback_params) = build_smart_folder_query(rule, false, true);
                query_str = fallback_query;
                params = fallback_params;
                conn.prepare(&query_str)
            });

            if let Ok(mut stmt) = stmt_result {
                if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(SmartFolderItem {
                        path: row.get(0)?,
                        size: row.get(1)?,
                        mtime: row.get(2)?,
                        ctime: row.get(3)?,
                        width: row.get(4)?,
                        height: row.get(5)?,
                        metadata: None,
                        has_thumbnail: row.get(6)?,
                        hash_key: row.get::<_, Option<String>>(7).unwrap_or_default().unwrap_or_default(),
                        searchable_prompt: row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_default(),
                        searchable_negative_prompt: row.get::<_, Option<String>>(9).unwrap_or_default().unwrap_or_default(),
                        searchable_source: row.get::<_, Option<String>>(10).unwrap_or_default().unwrap_or_default(),
                        has_metadata: row.get::<_, Option<bool>>(11).unwrap_or_default().unwrap_or(false),
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
                    for chunk in paths.chunks(900) {
                        let placeholders = vec!["?"; chunk.len()].join(",");
                        let query = format!("SELECT path, size, mtime, ctime, width, height, (thumbnail IS NOT NULL), IFNULL(hash_key, ''), IFNULL(searchable_prompt, ''), IFNULL(searchable_negative_prompt, ''), IFNULL(searchable_source, ''), (metadata IS NOT NULL) FROM cache WHERE path IN ({})", placeholders);
                        if let Ok(mut stmt) = conn.prepare(&query) {
                            let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
                            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params), |row| {
                                Ok(SmartFolderItem {
                                    path: row.get(0)?,
                                    size: row.get(1)?,
                                    mtime: row.get(2)?,
                                    ctime: row.get(3)?,
                                    width: row.get(4)?,
                                    height: row.get(5)?,
                                    metadata: None,
                                    has_thumbnail: row.get(6)?,
                                    hash_key: row.get::<_, Option<String>>(7).unwrap_or_default().unwrap_or_default(),
                                    searchable_prompt: row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_default(),
                                    searchable_negative_prompt: row.get::<_, Option<String>>(9).unwrap_or_default().unwrap_or_default(),
                                    searchable_source: row.get::<_, Option<String>>(10).unwrap_or_default().unwrap_or_default(),
                                    has_metadata: row.get::<_, Option<bool>>(11).unwrap_or_default().unwrap_or(false),
                                })
                            }) {
                                target_paths.extend(rows.flatten());
                            }
                        }
                    }
                }
            }
        } else if folder_id == "history" {
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare("SELECT path, size, mtime, ctime, width, height, (thumbnail IS NOT NULL), IFNULL(hash_key, ''), IFNULL(searchable_prompt, ''), IFNULL(searchable_negative_prompt, ''), IFNULL(searchable_source, ''), (metadata IS NOT NULL) FROM cache WHERE path != '' AND path IS NOT NULL ORDER BY last_accessed DESC LIMIT 100") {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok(SmartFolderItem {
                        path: row.get(0)?,
                        size: row.get(1)?,
                        mtime: row.get(2)?,
                        ctime: row.get(3)?,
                        width: row.get(4)?,
                        height: row.get(5)?,
                        metadata: None,
                        has_thumbnail: row.get(6)?,
                        hash_key: row.get::<_, Option<String>>(7).unwrap_or_default().unwrap_or_default(),
                        searchable_prompt: row.get::<_, Option<String>>(8).unwrap_or_default().unwrap_or_default(),
                        searchable_negative_prompt: row.get::<_, Option<String>>(9).unwrap_or_default().unwrap_or_default(),
                        searchable_source: row.get::<_, Option<String>>(10).unwrap_or_default().unwrap_or_default(),
                        has_metadata: row.get::<_, Option<bool>>(11).unwrap_or_default().unwrap_or(false),
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

pub(crate) fn get_smart_folder_counts_inner(
    rules: Vec<SmartFolderRule>,
    state: &AppState,
) -> std::collections::HashMap<String, usize> {
    let mut result = std::collections::HashMap::new();

    let has_rating_rule = rules.iter().any(|r| {
        (r.conditions.is_empty() && (r.id == "fav_5" || r.id == "fav_4_plus"))
            || r.conditions.iter().any(|c| c.r#type == "rating")
    });
    let ratings_map = if has_rating_rule {
        Some(state.ratings.read().clone())
    } else {
        None
    };

    let db_conn = state.db_conn.clone();

    if let Ok(conn) = db_conn.get() {
        let _like_guard = CaseSensitiveLikeGuard::new(&conn);

        for rule in rules {
            let mut count = 0;
            if rule.conditions.is_empty() && (rule.id == "fav_5" || rule.id == "fav_4_plus" || rule.id == "history") {
                if rule.id == "fav_5" {
                    if let Some(ref map) = ratings_map {
                        count = map.values().filter(|&&r| r >= 5).count();
                    }
                } else if rule.id == "fav_4_plus" {
                    if let Some(ref map) = ratings_map {
                        count = map.values().filter(|&&r| r >= 4).count();
                    }
                } else if rule.id == "history" {
                    count = conn.query_row("SELECT COUNT(*) FROM cache WHERE path != '' AND path IS NOT NULL", [], |row| row.get::<_, usize>(0)).unwrap_or(0);
                    if count > 100 { count = 100; }
                }
            } else {
                let (mut query_str, mut params) = build_smart_folder_query(&rule, true, false);

                let stmt_result = conn.prepare(&query_str).or_else(|_| {
                    let (fallback_query, fallback_params) = build_smart_folder_query(&rule, true, true);
                    query_str = fallback_query;
                    params = fallback_params;
                    conn.prepare(&query_str)
                });

                if let Ok(mut stmt) = stmt_result {
                    count = stmt.query_row(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, usize>(0)).unwrap_or(0);
                }
            }
            result.insert(rule.id, count);
        }
    }

    result
}

#[tauri::command]
pub(crate) async fn get_smart_folder_counts(
    app: tauri::AppHandle,
    rules: Vec<SmartFolderRule>,
) -> Result<std::collections::HashMap<String, usize>, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        get_smart_folder_counts_inner(rules, &state)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn update_smart_folders(rules: Vec<SmartFolderRule>, state: tauri::State<'_, AppState>) {
    *state.smart_folders.write() = rules;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{FullMetadata, SmartFolderCondition, SmartFolderRule};

    #[test]
    fn test_build_smart_folder_query() {
        use super::SmartFolderRule;
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
        
        let (query, params) = build_smart_folder_query(&rule, false, false);
        // FTS5 MATCH 方式に更新済み: LIKE ではなく MATCH を使う
        let expected_query = "SELECT c.path, c.size, c.mtime, c.ctime, c.width, c.height, (c.thumbnail IS NOT NULL), c.hash_key, IFNULL(c.searchable_prompt, ''), IFNULL(c.searchable_negative_prompt, ''), IFNULL(c.searchable_source, ''), (c.metadata IS NOT NULL) FROM cache c WHERE c.path != '' AND c.path IS NOT NULL AND (c.rowid IN (SELECT rowid FROM cache_fts WHERE searchable_prompt MATCH ?) AND c.rowid NOT IN (SELECT rowid FROM cache_fts WHERE searchable_negative_prompt MATCH ?)) ORDER BY c.mtime DESC";
        assert!(query.contains(expected_query), "prompt の contains 条件は FTS5 IN サブクエリを使うべき。実際のクエリ: {}", query);
        // not_contains は NOT IN (SELECT ... MATCH ?) 形式
        assert!(
            query.contains("searchable_negative_prompt MATCH ?"),
            "negative_prompt の not_contains 条件は MATCH を含むサブクエリを使うべき。実際のクエリ: {}", query
        );
        // FTS JOIN が含まれていること
        assert!(query.contains("cache_fts"), "FTS JOIN が含まれるべき");
        // パラメータは2つ（prompt用 + negative_prompt用）
        assert_eq!(params.len(), 2);
        // パラメータはFTS5のクォートされた形式 ("girl", "bad") になっていること
        if let rusqlite::types::Value::Text(ref v) = params[0] {
            assert_eq!(v, "\"girl\"", "FTS5クエリはダブルクォートで囲まれるべき");
        } else {
            panic!("params[0] は Text 型であるべき");
        }
        if let rusqlite::types::Value::Text(ref v) = params[1] {
            assert_eq!(v, "\"bad\"", "FTS5クエリはダブルクォートで囲まれるべき");
        } else {
            panic!("params[1] は Text 型であるべき");
        }
    }

    #[test]
    fn test_case_sensitive_like_guard_restores_off() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // SQLite の LIKE 演算子の大文字小文字区別をクエリ結果で直接検証
        // デフォルト (case_sensitive_like = OFF) では 'abc' LIKE 'ABC' は 1 (true)
        let initial: i32 = conn.query_row("SELECT 'abc' LIKE 'ABC';", [], |row| row.get(0)).unwrap();
        assert_eq!(initial, 1, "デフォルトでは大文字小文字を区別せず一致 (1)");

        {
            let _guard = CaseSensitiveLikeGuard::new(&conn);
            let active: i32 = conn.query_row("SELECT 'abc' LIKE 'ABC';", [], |row| row.get(0)).unwrap();
            assert_eq!(active, 0, "ガード有効時は case_sensitive_like = ON となり不一致 (0)");
        }

        let restored: i32 = conn.query_row("SELECT 'abc' LIKE 'ABC';", [], |row| row.get(0)).unwrap();
        assert_eq!(restored, 1, "ガード破棄後は case_sensitive_like = OFF に確実に復元され一致 (1)");
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

            let meta1 = FullMetadata {
                path: "C:\\fake\\path1.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
                metadata_source: String::new(),
            };
            let meta2 = FullMetadata {
                path: "C:\\fake\\path2.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
                metadata_source: String::new(),
            };
            let meta3 = FullMetadata {
                path: "C:\\fake\\path3.png".to_string(),
                prompt: "".to_string(),
                negative_prompt: "".to_string(),
                width: 0,
                height: 0,
                params: serde_json::Value::Null,
                source: "".to_string(),
                metadata_source: String::new(),
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

        let fav5 = get_smart_folder_paths("smart://fav_5", &ratings, &db_conn, &[]);
        assert_eq!(fav5.len(), 1);
        assert_eq!(fav5[0].path, "C:\\fake\\path1.png");

        let fav4 = get_smart_folder_paths("smart://fav_4_plus", &ratings, &db_conn, &[]);
        assert_eq!(fav4.len(), 2);

        let history = get_smart_folder_paths("smart://history", &ratings, &db_conn, &[]);
        assert_eq!(history.len(), 3);
        let history_paths: Vec<_> = history.iter().map(|p| p.path.as_str()).collect();
        assert!(history_paths.contains(&"C:\\fake\\path1.png"));
        assert!(history_paths.contains(&"C:\\fake\\path2.png"));
        assert!(history_paths.contains(&"C:\\fake\\path3.png"));
    }

    #[test]
    fn test_get_smart_folder_counts_logic() {
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
    fn test_smart_folder_bypasses_is_file() {
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
        let item = SmartFolderItem {
            path: file_path.to_string_lossy().to_string(),
            size: 0,
            mtime: 0,
            ctime: 0,
            width: 0,
            height: 0,
            metadata: None,
            has_thumbnail: true,
            ..Default::default()
        };

        let img = create_image_file_from_smart_item(item);

        // パフォーマンス上の理由から、size や mtime が 0 の場合でも同期的にはファイルシステムから補完されないこと（遅延読み込みで対応）
        assert_eq!(img.size, 0);
        assert_eq!(img.mtime, 0);
        assert!(img.has_thumbnail_cache);
        assert!(!img.meta_loaded);

        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn test_smart_folder_aspect_ratio_bounds() {
        // 1. portrait (縦長: width * 100 < height * 95)
        let rule_portrait = SmartFolderRule {
            id: "aspect_portrait".to_string(),
            name: "縦長".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "aspect_ratio".to_string(),
                    operator: "portrait".to_string(),
                    value: "".to_string(),
                },
            ],
        };
        let (q_port, _) = build_smart_folder_query(&rule_portrait, false, false);
        assert!(q_port.contains("(c.width * 100 < c.height * 95)"), "portrait 条件が含まれるべき: {}", q_port);

        // 2. landscape (横長: width * 100 > height * 105)
        let rule_landscape = SmartFolderRule {
            id: "aspect_landscape".to_string(),
            name: "横長".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "aspect_ratio".to_string(),
                    operator: "landscape".to_string(),
                    value: "".to_string(),
                },
            ],
        };
        let (q_land, _) = build_smart_folder_query(&rule_landscape, false, false);
        assert!(q_land.contains("(c.width * 100 > c.height * 105)"), "landscape 条件が含まれるべき: {}", q_land);

        // 3. square (正方形: 95% 〜 105%)
        let rule_square = SmartFolderRule {
            id: "aspect_square".to_string(),
            name: "正方形".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "aspect_ratio".to_string(),
                    operator: "square".to_string(),
                    value: "".to_string(),
                },
            ],
        };
        let (q_sq, _) = build_smart_folder_query(&rule_square, false, false);
        assert!(q_sq.contains("(c.width * 100 >= c.height * 95 AND c.width * 100 <= c.height * 105)"), "square 条件が含まれるべき: {}", q_sq);
    }

    /// PLAN.md Sec 5.2: パス条件（in_folder, under_folder）のSQL生成およびパラメータバインドテスト
    #[test]
    fn test_smart_folder_path_operators() {
        // in_folder: 直下のみ (範囲条件 + サブフォルダ除外 NOT LIKE)
        let rule_in = SmartFolderRule {
            id: "path_in".to_string(),
            name: "直下".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "path".to_string(),
                    operator: "in_folder".to_string(),
                    value: "C:\\photos".to_string(),
                },
            ],
        };
        let (q_in, p_in) = build_smart_folder_query(&rule_in, false, false);
        assert!(
            q_in.contains("(c.path >= ? AND c.path < ? AND c.path NOT LIKE ? ESCAPE '\\' AND c.path NOT LIKE ? ESCAPE '\\')"),
            "直下パス判定の範囲条件+NOT LIKE構文が含まれるべき: {}",
            q_in
        );
        assert_eq!(p_in.len(), 4, "in_folder は4つのバインドパラメータを持つべき");
        assert_eq!(p_in[0], rusqlite::types::Value::Text("C:\\photos\\".to_string()));
        assert_eq!(p_in[1], rusqlite::types::Value::Text("C:\\photos]".to_string()));
        assert_eq!(p_in[2], rusqlite::types::Value::Text("C:\\\\photos\\\\%/%".to_string()));
        assert_eq!(p_in[3], rusqlite::types::Value::Text("C:\\\\photos\\\\%\\\\%".to_string()));

        // under_folder: 配下すべて (サブフォルダ含む範囲条件)
        let rule_under = SmartFolderRule {
            id: "path_under".to_string(),
            name: "配下すべて".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "path".to_string(),
                    operator: "under_folder".to_string(),
                    value: "C:\\photos".to_string(),
                },
            ],
        };
        let (q_under, p_under) = build_smart_folder_query(&rule_under, false, false);
        assert!(
            q_under.contains("(c.path >= ? AND c.path < ?)"),
            "under_folder 範囲条件が含まれるべき: {}",
            q_under
        );
        assert_eq!(p_under.len(), 2, "under_folder は2つのバインドパラメータを持つべき");
        assert_eq!(p_under[0], rusqlite::types::Value::Text("C:\\photos\\".to_string()));
        assert_eq!(p_under[1], rusqlite::types::Value::Text("C:\\photos]".to_string()));
    }

    #[test]
    fn test_prefix_upper_bound() {
        assert_eq!(prefix_upper_bound("e:\\pixiv\\"), Some("e:\\pixiv]".to_string()));
        assert_eq!(prefix_upper_bound("e:\\"), Some("e:]".to_string()));
        assert_eq!(prefix_upper_bound("e:/pixiv/"), Some("e:/pixiv0".to_string()));
        assert_eq!(prefix_upper_bound("/"), Some("0".to_string()));
        assert_eq!(prefix_upper_bound(""), None);
    }

    #[test]
    fn test_smart_folder_path_range_behavior_equivalence() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::builder().max_size(1).build(manager).unwrap();

        {
            let conn = db_conn.get().unwrap();
            conn.execute(
                "CREATE TABLE cache (
                    hash_key TEXT PRIMARY KEY,
                    path TEXT,
                    metadata TEXT,
                    thumbnail BLOB,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    size INTEGER DEFAULT 0,
                    mtime INTEGER DEFAULT 0,
                    ctime INTEGER DEFAULT 0,
                    last_accessed INTEGER,
                    searchable_prompt TEXT DEFAULT '',
                    searchable_negative_prompt TEXT DEFAULT '',
                    searchable_source TEXT DEFAULT '',
                    metadata_source TEXT DEFAULT ''
                )",
                [],
            )
            .unwrap();

            let rows = [
                ("h1", "e:\\pixiv\\direct1.png", 100),
                ("h2", "e:\\pixiv\\direct2.jpg", 200),
                ("h3", "e:\\pixiv\\sub\\nested1.png", 300),
                ("h4", "e:\\pixiv\\sub\\deep\\nested2.png", 400),
                // 前方一致が重なる兄弟フォルダ
                ("h5", "e:\\pixiv2\\sibling.png", 500),
                // 大小文字違い
                ("h6", "E:\\PIXIV\\upper.png", 600),
                ("h7", "e:\\Pixiv\\mixed.png", 700),
                // LIKE ワイルドカード文字（%、_）を含むフォルダ配下と、ワイルドカード誤一致検証用の別フォルダ
                ("h8", "e:\\art_100%\\direct_wc.png", 800),
                ("h9", "e:\\art_100%\\sub\\nested_wc.png", 900),
                ("h10", "e:\\artX100ZZZ\\deceptive.png", 1000),
            ];
            for (h, p, mt) in rows {
                conn.execute(
                    "INSERT INTO cache (hash_key, path, mtime) VALUES (?1, ?2, ?3)",
                    rusqlite::params![h, p, mt],
                )
                .unwrap();
            }
        }

        let run_paths = |op: &str, val: &str| -> Vec<String> {
            let rule = SmartFolderRule {
                id: "equiv".to_string(),
                name: "Equiv".to_string(),
                match_type: "all".to_string(),
                conditions: vec![SmartFolderCondition {
                    r#type: "path".to_string(),
                    operator: op.to_string(),
                    value: val.to_string(),
                }],
            };
            let mut got: Vec<String> = query_smart_folder_image_files(&rule, &db_conn, Some("mtime"), false, None)
                .into_iter()
                .map(|f| f.path.clone())
                .collect();
            got.sort();
            got
        };

        // 1. under_folder ("e:\pixiv"): 直下 + 孫のみ。兄弟 e:\pixiv2\ や大小文字違いは除外
        assert_eq!(
            run_paths("under_folder", "e:\\pixiv"),
            vec![
                "e:\\pixiv\\direct1.png",
                "e:\\pixiv\\direct2.jpg",
                "e:\\pixiv\\sub\\deep\\nested2.png",
                "e:\\pixiv\\sub\\nested1.png",
            ]
        );

        // 2. in_folder ("e:\pixiv"): 直下のみ。孫・兄弟・大小文字違いは除外
        assert_eq!(
            run_paths("in_folder", "e:\\pixiv"),
            vec![
                "e:\\pixiv\\direct1.png",
                "e:\\pixiv\\direct2.jpg",
            ]
        );

        // 3. ワイルドカード文字（%, _）を含むフォルダでの under_folder / in_folder
        assert_eq!(
            run_paths("under_folder", "e:\\art_100%"),
            vec![
                "e:\\art_100%\\direct_wc.png",
                "e:\\art_100%\\sub\\nested_wc.png",
            ]
        );
        assert_eq!(
            run_paths("in_folder", "e:\\art_100%"),
            vec![
                "e:\\art_100%\\direct_wc.png",
            ]
        );
    }

    #[test]
    fn test_smart_folder_under_folder_explain_query_plan() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::builder().max_size(1).build(manager).unwrap();

        {
            let mut conn = db_conn.get().unwrap();
            conn.execute_batch(
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
                    searchable_source TEXT DEFAULT '',
                    metadata_source TEXT DEFAULT ''
                );
                CREATE INDEX idx_cache_path ON cache (path);
                CREATE INDEX idx_cache_mtime ON cache (mtime);
                CREATE INDEX idx_cache_smart_cover_mtime ON cache (mtime DESC, path, size, ctime, width, height, hash_key);
                CREATE INDEX idx_cache_smart_cover_mtime_v3 ON cache (mtime DESC, path, size, ctime, width, height, hash_key, (thumbnail IS NOT NULL));
                CREATE INDEX idx_cache_last_accessed ON cache (last_accessed DESC);
                CREATE INDEX idx_cache_smart_cover_v2 ON cache (path, mtime DESC, size, ctime, width, height);",
            )
            .unwrap();

            let tx = conn.transaction().unwrap();
            {
                let mut stmt = tx
                    .prepare("INSERT INTO cache (hash_key, path, mtime, size, ctime, width, height) VALUES (?1, ?2, ?3, 1024, ?3, 832, 1216)")
                    .unwrap();
                for i in 0..20_000usize {
                    let hk = format!("filler_{:05}", i);
                    let path = format!("d:\\archive\\batch_{:02}\\img_{:05}.png", i % 50, i);
                    stmt.execute(rusqlite::params![hk, path, i as i64]).unwrap();
                }
                for i in 0..3usize {
                    let hk = format!("target_{}", i);
                    let path = format!("e:\\pixiv\\target_{}.png", i);
                    stmt.execute(rusqlite::params![hk, path, 30_000 + i as i64]).unwrap();
                }
            }
            tx.commit().unwrap();
        }

        let rule = SmartFolderRule {
            id: "eqp_under".to_string(),
            name: "EQP Under".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "path".to_string(),
                operator: "under_folder".to_string(),
                value: "e:\\pixiv".to_string(),
            }],
        };

        let (query_str, params) = build_smart_folder_query_with_sort(&rule, false, false, Some("mtime"), false, None);
        let conn = db_conn.get().unwrap();
        let _like_guard = CaseSensitiveLikeGuard::new(&conn);
        let eqp_sql = format!("EXPLAIN QUERY PLAN {}", query_str);
        let mut stmt = conn.prepare(&eqp_sql).unwrap();
        let details: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, String>(3))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        println!("[EQP under_folder mtime DESC] {:?}", details);
        assert!(
            details.iter().any(|d| d.contains("SEARCH") && d.contains("path>") && d.contains("path<")),
            "path 範囲による SEARCH が実行計画に現れるべき: {:?}",
            details
        );
    }

    /// PLAN.md Sec 5.2: 幅・高さ条件（>=, <=, ==）のSQL生成テスト
    #[test]
    fn test_smart_folder_width_height_operators() {
        let rule_wh = SmartFolderRule {
            id: "size_test".to_string(),
            name: "サイズテスト".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "width".to_string(),
                    operator: ">=".to_string(),
                    value: "1920".to_string(),
                },
                SmartFolderCondition {
                    r#type: "height".to_string(),
                    operator: "<=".to_string(),
                    value: "1080".to_string(),
                },
            ],
        };
        let (q, params) = build_smart_folder_query(&rule_wh, false, false);
        assert!(q.contains("c.width >= ?"), "width 条件が含まれるべき: {}", q);
        assert!(q.contains("c.height <= ?"), "height 条件が含まれるべき: {}", q);
        assert_eq!(params.len(), 2);

        // >, <, != 演算子が = にフォールバックせず正しく SQL に反映されることを検証
        let rule_strict = SmartFolderRule {
            id: "strict_cmp_test".to_string(),
            name: "比較演算子網羅テスト".to_string(),
            match_type: "all".to_string(),
            conditions: vec![
                SmartFolderCondition {
                    r#type: "rating".to_string(),
                    operator: ">".to_string(),
                    value: "3".to_string(),
                },
                SmartFolderCondition {
                    r#type: "width".to_string(),
                    operator: "<".to_string(),
                    value: "1200".to_string(),
                },
                SmartFolderCondition {
                    r#type: "height".to_string(),
                    operator: "!=".to_string(),
                    value: "720".to_string(),
                },
            ],
        };
        let (q_strict, params_strict) = build_smart_folder_query(&rule_strict, false, false);
        assert!(q_strict.contains("r.rating > ?"), "rating > ? が生成されること: {}", q_strict);
        assert!(q_strict.contains("c.width < ?"), "c.width < ? が生成されること: {}", q_strict);
        assert!(q_strict.contains("c.height != ?"), "c.height != ? が生成されること: {}", q_strict);
        assert_eq!(params_strict.len(), 3);

        let rule_rating_lt = SmartFolderRule {
            id: "rating_lt_test".to_string(),
            name: "レーティング未満テスト".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "rating".to_string(),
                operator: "<".to_string(),
                value: "2".to_string(),
            }],
        };
        let (q_lt, _) = build_smart_folder_query(&rule_rating_lt, false, false);
        assert!(q_lt.contains("coalesce(r.rating, 0) < ?"), "coalesce(r.rating, 0) < ? が生成されること: {}", q_lt);
    }

    /// PLAN.md Sec 5.3: メディア種別 (media_type)・拡張子 (ext)・メタデータ出処 (metadata_source) 条件のSQL生成および実DB評価テスト
    #[test]
    fn test_smart_folder_media_type_ext_and_metadata_source() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE cache (
                hash_key TEXT PRIMARY KEY,
                path TEXT,
                size INTEGER DEFAULT 0,
                mtime INTEGER DEFAULT 0,
                ctime INTEGER DEFAULT 0,
                width INTEGER DEFAULT 0,
                height INTEGER DEFAULT 0,
                thumbnail BLOB,
                metadata_source TEXT DEFAULT ''
            )",
            [],
        )
        .unwrap();

        let sample_rows = [
            ("h1", "C:\\media\\illust1.png", "Alpha Channel"),
            ("h2", "C:\\media\\illust2.PNG", "PNG Chunks"),
            ("h3", "C:\\media\\photo.jpg", "JPEG EXIF"),
            ("h4", "C:\\media\\art.webp", "WebP EXIF"),
            ("h5", "C:\\media\\movie.MP4", "None"),
            ("h6", "C:\\media\\track.MP3", "Audio Tags"),
            ("h7", "C:\\media\\plain.png", ""),
        ];
        for (hk, p, ms) in &sample_rows {
            conn.execute(
                "INSERT INTO cache (hash_key, path, metadata_source) VALUES (?, ?, ?)",
                rusqlite::params![hk, p, ms],
            )
            .unwrap();
        }

        // CaseSensitiveLikeGuard が有効な状態でも大文字拡張子 (.PNG / .MP3 / .MP4) が正しくヒットすることを確認
        let _guard = CaseSensitiveLikeGuard::new(&conn);

        let eval_count = |rule: &SmartFolderRule| -> usize {
            let (q, params) = build_smart_folder_query(rule, true, false);
            let mut stmt = conn.prepare(&q).unwrap();
            stmt.query_row(rusqlite::params_from_iter(params.iter()), |row| row.get::<_, usize>(0))
                .unwrap()
        };

        // 1. media_type == audio -> track.MP3 (1件)
        let rule_audio = SmartFolderRule {
            id: "mt_audio".to_string(),
            name: "Audio Only".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "media_type".to_string(),
                operator: "==".to_string(),
                value: "audio".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_audio), 1);

        // 2. media_type == video -> movie.MP4 (1件)
        let rule_video = SmartFolderRule {
            id: "mt_video".to_string(),
            name: "Video Only".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "media_type".to_string(),
                operator: "==".to_string(),
                value: "video".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_video), 1);

        // 3. media_type == image -> illust1.png, illust2.PNG, photo.jpg, art.webp, plain.png (5件)
        let rule_image = SmartFolderRule {
            id: "mt_image".to_string(),
            name: "Image Only".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "media_type".to_string(),
                operator: "==".to_string(),
                value: "image".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_image), 5);

        // 4. media_type != image -> movie.MP4, track.MP3 (2件)
        let rule_not_image = SmartFolderRule {
            id: "mt_not_image".to_string(),
            name: "Not Image".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "media_type".to_string(),
                operator: "!=".to_string(),
                value: "image".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_not_image), 2);

        // 5. ext == ".png, webp" -> illust1.png, illust2.PNG, art.webp, plain.png (4件)
        let rule_ext = SmartFolderRule {
            id: "ext_png_webp".to_string(),
            name: "PNG or WebP".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "ext".to_string(),
                operator: "==".to_string(),
                value: ".png, webp".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_ext), 4);

        // 6. ext != "png" -> photo.jpg, art.webp, movie.MP4, track.MP3 (4件)
        let rule_ext_not = SmartFolderRule {
            id: "ext_not_png".to_string(),
            name: "Not PNG".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "ext".to_string(),
                operator: "!=".to_string(),
                value: "png".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_ext_not), 4);

        // 7. metadata_source == "Alpha Channel" -> illust1.png (1件)
        let rule_stealth = SmartFolderRule {
            id: "ms_stealth".to_string(),
            name: "Stealth Only".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "metadata_source".to_string(),
                operator: "==".to_string(),
                value: "Alpha Channel".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_stealth), 1);

        // 8. metadata_source == "None" -> movie.MP4 ("None") と plain.png ("") の両方 (2件)
        let rule_ms_none = SmartFolderRule {
            id: "ms_none".to_string(),
            name: "No Metadata".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "metadata_source".to_string(),
                operator: "==".to_string(),
                value: "None".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_ms_none), 2);

        // 9. metadata_source != "None" -> メタデータありの5件
        let rule_ms_has = SmartFolderRule {
            id: "ms_has".to_string(),
            name: "Has Metadata".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "metadata_source".to_string(),
                operator: "!=".to_string(),
                value: "None".to_string(),
            }],
        };
        assert_eq!(eval_count(&rule_ms_has), 5);
    }

    #[test]
    fn test_smart_folder_has_thumbnail_detection() {
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

        conn.execute(
            "CREATE TABLE ratings (
                path TEXT PRIMARY KEY,
                rating INTEGER NOT NULL
            )",
            [],
        ).unwrap();

        // 1. サムネイルあり画像
        let path_with_thumb = "C:\\test\\with_thumb.png";
        let dummy_bytes: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0];
        conn.execute(
            "INSERT INTO cache (hash_key, path, thumbnail, width, height, mtime) VALUES ('h_with', ?, ?, 100, 100, 1000)",
            rusqlite::params![path_with_thumb, dummy_bytes],
        ).unwrap();
        conn.execute("INSERT INTO ratings (path, rating) VALUES (?, 5)", [path_with_thumb]).unwrap();

        // 2. サムネイルなし画像（メタデータのみ）
        let path_without_thumb = "C:\\test\\without_thumb.png";
        conn.execute(
            "INSERT INTO cache (hash_key, path, thumbnail, width, height, mtime) VALUES ('h_without', ?, NULL, 200, 200, 2000)",
            rusqlite::params![path_without_thumb],
        ).unwrap();
        conn.execute("INSERT INTO ratings (path, rating) VALUES (?, 5)", [path_without_thumb]).unwrap();

        drop(conn);

        let mut ratings_map = std::collections::HashMap::new();
        ratings_map.insert(path_with_thumb.to_string(), 5);
        ratings_map.insert(path_without_thumb.to_string(), 5);

        let rule = SmartFolderRule {
            id: "fav_5".to_string(),
            name: "お気に入り (星5)".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "rating".to_string(),
                operator: ">=".to_string(),
                value: "5".to_string(),
            }],
        };

        let items = get_smart_folder_paths("smart://fav_5", &ratings_map, &db_conn, &[rule]);
        assert_eq!(items.len(), 2, "2件取得できること");

        let item_with = items.iter().find(|i| i.path == path_with_thumb).expect("with_thumbが見つかること");
        assert!(item_with.has_thumbnail, "thumbnail IS NOT NULL の画像は has_thumbnail: true であること");

        let item_without = items.iter().find(|i| i.path == path_without_thumb).expect("without_thumbが見つかること");
        assert!(!item_without.has_thumbnail, "thumbnail IS NULL の画像は has_thumbnail: false であること");

        let file_with = create_image_file_from_smart_item(item_with.clone());
        assert!(file_with.has_thumbnail_cache, "ImageFileのhas_thumbnail_cacheがtrueであること");

        let file_without = create_image_file_from_smart_item(item_without.clone());
        assert!(!file_without.has_thumbnail_cache, "ImageFileのhas_thumbnail_cacheがfalseであること");
    }

    #[test]
    fn test_smart_folder_single_pass_query() {
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

        // 300件のダミーデータを挿入（UNCパスを含む）
        for i in 1..=299 {
            conn.execute(
                "INSERT INTO cache (hash_key, path, width, height, mtime) VALUES (?, ?, 100, 100, ?)",
                rusqlite::params![format!("hash_{:04}", i), format!("C:\\test\\img_{:04}.png", i), i * 10],
            ).unwrap();
        }
        // 300件目はネットワーク共有UNCパスで挿入
        conn.execute(
            "INSERT INTO cache (hash_key, path, width, height, mtime) VALUES (?, ?, 100, 100, ?)",
            rusqlite::params!["hash_0300", r"\\?\UNC\win81-pc\share\img_0300.png", 3000],
        ).unwrap();
        drop(conn);

        let rule = SmartFolderRule {
            id: "all_images".to_string(),
            name: "All Images".to_string(),
            match_type: "all".to_string(),
            conditions: vec![],
        };

        // 1. 全件取得（単一パスロードの主要クエリ）
        let all_items = query_smart_folder_image_files(&rule, &db_conn, Some("mtime"), false, None);
        assert_eq!(all_items.len(), 300, "全件取得時は300件全件が返ること");
        assert_eq!(all_items[0].name, "img_0300.png", "mtime DESC で最新が先頭");
        assert_eq!(all_items[0].path, r"\\win81-pc\share\img_0300.png", "UNCパスが正しく標準UNC形式に正規化されること");
        assert_eq!(all_items[0].hash_key, "hash_0300", "ImageFile に hash_key が正しく設定されていること");

        // 2. 名前順ソート時の単一パス検証
        // SQL 側での重いフルテーブル ORDER BY c.path を回避し、Rust 側の高速自然順ソートで真の先頭を確定
        let mut name_sorted = query_smart_folder_image_files(&rule, &db_conn, Some("name"), true, None);
        assert_eq!(name_sorted.len(), 300);
        crate::sort_files_by_natural_name(&mut name_sorted, true);
        assert_eq!(name_sorted[0].name, "img_0001.png", "名前昇順ソート時は全フォルダ横断で img_0001.png が先頭であること");

        // 3. has_thumbnail_cache が正しく判定されること（thumbnail NULL → false）
        assert!(!all_items[0].has_thumbnail_cache, "thumbnail が NULL のアイテムは has_thumbnail_cache = false");

        // 4. 34,000件規模での性能ベンチマーク
        let mut conn = db_conn.get().unwrap();
        let tx = conn.transaction().unwrap();
        for i in 301..=34000 {
            tx.execute(
                "INSERT INTO cache (hash_key, path, width, height, mtime) VALUES (?, ?, 100, 100, ?)",
                rusqlite::params![format!("hash_{:05}", i), format!("C:\\test\\sub\\img_{:05}.png", i), i * 10],
            ).unwrap();
        }
        tx.commit().unwrap();
        drop(conn);

        let t0 = std::time::Instant::now();
        let mut items_34k = query_smart_folder_image_files(&rule, &db_conn, Some("name"), true, None);
        let t_query = t0.elapsed();
        crate::sort_files_by_natural_name(&mut items_34k, true);
        let t_total = t0.elapsed();
        println!("[BENCHMARK] 34,000 items query: {:?}, total with natural sort: {:?}", t_query, t_total);
        assert_eq!(items_34k.len(), 34000);
        assert_eq!(items_34k[0].name, "img_0001.png");
        assert!(t_total.as_millis() < 1000, "34,000件のクエリとソートは1秒未満で完了すること (実測: {}ms)", t_total.as_millis());
    }

    /// FTS5 構文エラーまたは FTS5 テーブル未存在時に、1 回目の prepare 失敗を検知して
    /// フォールバッククエリ（LIKE検索）へシームレスに切り替わり正常に取得できることの検証
    #[test]
    fn test_smart_folder_prepare_fallback_on_fts_error() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        {
            let conn = db_conn.get().unwrap();
            // FTS5 テーブルを作成せず、cache テーブルのみ作成（FTS クエリでエラーを誘発）
            conn.execute(
                "CREATE TABLE cache (
                    hash_key TEXT PRIMARY KEY,
                    path TEXT,
                    metadata TEXT,
                    thumbnail BLOB,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
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
                "INSERT INTO cache (hash_key, path, metadata, searchable_prompt) VALUES (?, ?, ?, ?)",
                rusqlite::params!["h1", "C:\\test\\fallback.png", "{\"prompt\":\"masterpiece, 1girl\"}", "masterpiece, 1girl"],
            ).unwrap();
        }

        let rule = SmartFolderRule {
            id: "fallback_test".to_string(),
            name: "Fallback Test".to_string(),
            match_type: "all".to_string(),
            conditions: vec![SmartFolderCondition {
                r#type: "prompt".to_string(),
                operator: "contains".to_string(),
                value: "1girl".to_string(),
            }],
        };

        // FTS テーブルがないため 1 回目の prepare は失敗し、フォールバッククエリへ切り替わって正常にアイテムが取得できること
        let items = query_smart_folder_image_files(&rule, &db_conn, None, true, None);
        assert_eq!(items.len(), 1, "フォールバッククエリで正常にアイテムが取得されること");
        assert_eq!(items[0].name, "fallback.png");
    }

    #[test]
    fn test_should_run_smart_purge_interval_logic() {
        let interval = SMART_PURGE_MIN_INTERVAL_MS;
        let now = 1_700_000_000_000u64;

        // 1. 記録なし (None) -> 実行
        assert!(should_run_smart_purge(None, now, interval), "記録なしの場合はパージを実行すること");

        // 2. 間隔内 -> スキップ
        assert!(!should_run_smart_purge(Some(now - 1000), now, interval), "1秒前（間隔内）はスキップすること");
        assert!(!should_run_smart_purge(Some(now - (interval - 1)), now, interval), "間隔満了直前（1ms前）はスキップすること");

        // 3. ちょうど間隔経過 -> 実行
        assert!(should_run_smart_purge(Some(now - interval), now, interval), "ちょうど間隔経過時は実行すること");

        // 4. 間隔経過 -> 実行
        assert!(should_run_smart_purge(Some(now - (interval + 1000)), now, interval), "間隔超過時は実行すること");

        // 5. 時計の巻き戻り（未来タイムスタンプ） -> 安全側に倒して実行
        assert!(should_run_smart_purge(Some(now + 10_000), now, interval), "未来時刻検知時は安全側に倒して実行すること");
    }

    #[test]
    fn test_smart_folder_populates_unified_search_text_and_meta_loaded() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::builder().max_size(1).build(manager).unwrap();

        {
            let conn = db_conn.get().unwrap();
            conn.execute(
                "CREATE TABLE cache (
                    hash_key TEXT PRIMARY KEY,
                    path TEXT,
                    metadata TEXT,
                    thumbnail BLOB,
                    width INTEGER DEFAULT 0,
                    height INTEGER DEFAULT 0,
                    size INTEGER DEFAULT 0,
                    mtime INTEGER DEFAULT 0,
                    ctime INTEGER DEFAULT 0,
                    last_accessed INTEGER,
                    searchable_prompt TEXT DEFAULT '',
                    searchable_negative_prompt TEXT DEFAULT '',
                    searchable_source TEXT DEFAULT '',
                    metadata_source TEXT DEFAULT ''
                )",
                [],
            )
            .unwrap();

            // 1. 有効なメタデータ・プロンプト・生成元を持つ行
            conn.execute(
                "INSERT INTO cache (hash_key, path, metadata, searchable_prompt, searchable_negative_prompt, searchable_source, metadata_source, mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    "h_valid",
                    r"C:\art\magical_girl.png",
                    r#"{"prompt":"1girl, magical wand"}"#,
                    "1girl, magical wand",
                    "lowres, blurry",
                    "novelai diffusion v4.5",
                    "PNG Chunks",
                    200
                ],
            )
            .unwrap();

            // 2. レガシー空キャッシュ行（metadata_source = 'None', searchable_prompt = ''）
            conn.execute(
                "INSERT INTO cache (hash_key, path, metadata, searchable_prompt, searchable_negative_prompt, searchable_source, metadata_source, mtime)
                 VALUES (?1, ?2, ?3, '', '', '', 'None', ?4)",
                rusqlite::params![
                    "h_legacy",
                    r"C:\art\legacy_empty.jpg",
                    r#"{"prompt":"","metadata_source":"None"}"#,
                    100
                ],
            )
            .unwrap();
        }

        let rule = SmartFolderRule {
            id: "all_art".to_string(),
            name: "All Art".to_string(),
            match_type: "all".to_string(),
            conditions: vec![],
        };

        let items = query_smart_folder_image_files(&rule, &db_conn, Some("mtime"), false, None);
        assert_eq!(items.len(), 2);

        let valid = &items[0];
        assert_eq!(valid.name, "magical_girl.png");
        assert!(valid.meta_loaded, "メタデータおよび searchable 文字列が存在する行は meta_loaded = true になること");
        assert_eq!(valid.prompt, "1girl, magical wand");
        assert_eq!(valid.negative_prompt, "lowres, blurry");
        assert_eq!(valid.source, "novelai diffusion v4.5");
        assert!(valid.unified_search_text.contains("magical wand"), "unified_search_text にプロンプト語が含まれること");
        assert!(valid.unified_search_text.contains("novelai diffusion v4.5"), "unified_search_text にモデル名が含まれること");

        let legacy = &items[1];
        assert_eq!(legacy.name, "legacy_empty.jpg");
        assert!(!legacy.meta_loaded, "レガシー空キャッシュ行は meta_loaded = false のまま維持されること");
    }

    #[test]
    fn test_hydrate_smart_folder_search_text_from_fts_and_fallback() {
        let make_bare_file = |name: &str, path: &str, hash_key: &str| {
            std::sync::Arc::new(ImageFile {
                name: name.to_string(),
                ext: CompactString::from(".png"),
                path: path.to_string(),
                size: 100,
                mtime: 1000,
                ctime: 1000,
                has_thumbnail_cache: true,
                width: 512,
                height: 512,
                prompt: String::new(),
                negative_prompt: String::new(),
                source: String::new(),
                meta_loaded: false,
                search_text: String::new(),
                unified_search_text: name.to_lowercase(),
                hash_key: CompactString::from(hash_key),
            })
        };

        // 1. cache_fts あり環境: FTS から prompt / negative_prompt / source / unified_search_text / meta_loaded が復元され、
        //    FTS に無いファイルは空のままであること
        let pool_fts = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        {
            let conn = pool_fts.get().unwrap();
            conn.execute(
                "CREATE VIRTUAL TABLE cache_fts USING fts5(hash_key UNINDEXED, searchable_prompt, searchable_negative_prompt, searchable_source)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cache_fts (hash_key, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["h_found", "1girl, silver hair", "lowres", "novelai v5"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cache_fts (hash_key, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (?1, '', '', '')",
                rusqlite::params!["h_empty_fts"],
            )
            .unwrap();
        }

        let mut files = vec![
            make_bare_file("Alice.png", r"C:\art\Alice.png", "h_found"),
            make_bare_file("EmptyFts.png", r"C:\art\EmptyFts.png", "h_empty_fts"),
            make_bare_file("Missing.png", r"C:\art\Missing.png", "h_missing"),
        ];

        let updated = hydrate_smart_folder_search_text(&mut files, &pool_fts);
        assert_eq!(updated, 2);

        assert_eq!(files[0].prompt, "1girl, silver hair");
        assert_eq!(files[0].negative_prompt, "lowres");
        assert_eq!(files[0].source, "novelai v5");
        assert_eq!(files[0].unified_search_text, "alice.png 1girl, silver hair lowres novelai v5");
        assert!(files[0].meta_loaded);

        assert_eq!(files[1].prompt, "");
        assert!(!files[1].meta_loaded, "searchable が全て空なら meta_loaded = false のまま");

        assert_eq!(files[2].prompt, "");
        assert_eq!(files[2].unified_search_text, "missing.png");
        assert!(!files[2].meta_loaded, "FTS に無いファイルは空のままであること");

        // 2. cache_fts テーブルが存在しない環境: cache.searchable_* フォールバックで復元されること
        let pool_fallback = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        {
            let conn = pool_fallback.get().unwrap();
            conn.execute(
                "CREATE TABLE cache (
                    hash_key TEXT PRIMARY KEY,
                    searchable_prompt TEXT DEFAULT '',
                    searchable_negative_prompt TEXT DEFAULT '',
                    searchable_source TEXT DEFAULT ''
                )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, searchable_prompt, searchable_negative_prompt, searchable_source) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["h_fb", "mecha, cockpit", "blurry", "sdxl"],
            )
            .unwrap();
        }

        let mut fb_files = vec![make_bare_file("Robot.png", r"C:\art\Robot.png", "h_fb")];
        let fb_updated = hydrate_smart_folder_search_text(&mut fb_files, &pool_fallback);
        assert_eq!(fb_updated, 1);
        assert_eq!(fb_files[0].prompt, "mecha, cockpit");
        assert_eq!(fb_files[0].negative_prompt, "blurry");
        assert_eq!(fb_files[0].source, "sdxl");
        assert_eq!(fb_files[0].unified_search_text, "robot.png mecha, cockpit blurry sdxl");
        assert!(fb_files[0].meta_loaded);
    }
}
