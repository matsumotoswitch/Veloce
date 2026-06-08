#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;
use std::io::Read; // flate2のread_to_stringやバイナリ解析用
use std::sync::Mutex;
use tauri::Manager;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// --- データ構造の定義 ---
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
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    negative_prompt: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    meta_loaded: bool,
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
}

// --- 状態管理 ---
pub struct AppState {
    image_paths: Mutex<Vec<String>>,
    current_dir: Mutex<String>,
    viewer_paths: Mutex<std::collections::HashMap<String, Vec<String>>>,
    // Source of Truth: 全ファイルとフィルタリング済みファイルをRust側で保持
    all_files: Mutex<Vec<ImageFile>>,
    filtered_files: Mutex<Vec<ImageFile>>,
    sort_config: Mutex<SortConfig>,
    search_query: Mutex<String>,
    thumbnail_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

// --- ユーティリティ ---

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
    if path == "PC" {
        return true;
    }
    let path_obj = std::path::Path::new(&path);
    path_obj.exists() && path_obj.is_dir()
}

#[tauri::command]
fn load_directory(window: tauri::Window, target_path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path_clone = target_path.clone();
    let app_clone = window.app_handle();
    
    // ディレクトリ変更時にRust側の状態をリセット
    if let Ok(mut lock) = state.all_files.lock() { lock.clear(); }
    if let Ok(mut lock) = state.filtered_files.lock() { lock.clear(); }
    if let Ok(mut lock) = state.image_paths.lock() { lock.clear(); }
    if let Ok(mut dir_lock) = state.current_dir.lock() { *dir_lock = path_clone.clone(); }
    
    tauri::async_runtime::spawn(async move {
        // Veloceのキャッシュディレクトリ構造に合わせる
        let cache_dir_path = get_veloce_data_dir()
            .map(|p| p.join("Thumbnails"))
            .unwrap_or_else(|| std::path::PathBuf::from(".veloce_cache"));
        let meta_cache_dir_path = get_veloce_data_dir()
            .map(|p| p.join("Metadata"))
            .unwrap_or_else(|| std::path::PathBuf::from(".veloce_cache"));

        let mut files: Vec<ImageFile> = Vec::new();
        let mut all_paths = Vec::new();
        let walker = walkdir::WalkDir::new(&path_clone).max_depth(1).into_iter().filter_map(|e| e.ok());

        for entry in walker {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp") {
                        if let Ok(metadata) = std::fs::metadata(p) {
                            let size = metadata.len();
                            let mtime = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                            let ctime = metadata.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                            
                            let file_name = entry.file_name().to_string_lossy().into_owned();
                            let full_path = p.to_string_lossy().into_owned();
                            let clean_path = full_path.replace("\\\\?\\", "");

                            let cache_file_name = format!("{}_{}", clean_path, mtime);
                            let digest = md5::compute(cache_file_name.as_bytes());
                            let cache_path = cache_dir_path.join(format!("{:x}.jpg", digest));
                            let has_thumbnail_cache = cache_path.exists();
                            
                            let meta_cache_path = meta_cache_dir_path.join(format!("{:x}.json", digest));
                            let has_metadata_cache = meta_cache_path.exists();

                            all_paths.push(clean_path.clone());

                            files.push(ImageFile {
                                name: file_name,
                                ext: format!(".{}", ext_lower),
                                path: clean_path,
                                size,
                                mtime,
                                ctime,
                                has_thumbnail_cache,
                                has_metadata_cache,
                                width: 0,
                                height: 0,
                                prompt: String::new(),
                                negative_prompt: String::new(),
                                source: String::new(),
                                meta_loaded: false,
                            });
                        }
                    }
                }
            }
        }

        // Rust側のAppStateに全ファイルを格納（Source of Truth）
        if let Some(state) = app_clone.try_state::<AppState>() {
            // デフォルトソート（名前順昇順）を適用
            files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

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
            let _ = window.emit("directory-loaded", DirectoryLoadedPayload {
                path: path_clone.clone(),
                total_count,
            });
        }

        let app_for_bg = app_clone.clone();
        let path_for_bg = path_clone.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            let paths_to_process = {
                if let Some(state) = app_for_bg.try_state::<AppState>() {
                    if let Ok(lock) = state.all_files.lock() {
                        lock.iter().map(|f| f.path.clone()).collect::<Vec<String>>()
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                }
            };

            for path in paths_to_process {
                if let Some(state) = app_for_bg.try_state::<AppState>() {
                    if let Ok(dir_lock) = state.current_dir.lock() {
                        if *dir_lock != path_for_bg {
                            break;
                        }
                    }

                    let needs_parsing = if let Ok(lock) = state.all_files.lock() {
                        lock.iter().find(|f| f.path == path).map(|f| !f.meta_loaded).unwrap_or(false)
                    } else {
                        false
                    };

                    if needs_parsing {
                        let path_clone_for_blocking = path.clone();
                        let full_meta = match tokio::task::spawn_blocking(move || {
                            get_full_metadata_for_path(&path_clone_for_blocking)
                        }).await {
                            Ok(meta) => meta,
                            Err(_) => continue,
                        };

                        if let Ok(mut all_files) = state.all_files.lock() {
                            if let Some(f) = all_files.iter_mut().find(|f| f.path == path) {
                                f.width = full_meta.width;
                                f.height = full_meta.height;
                                f.prompt = full_meta.prompt.clone();
                                f.negative_prompt = full_meta.negative_prompt.clone();
                                f.source = full_meta.source.clone();
                                f.meta_loaded = true;
                            }
                        }
                        if let Ok(mut filtered) = state.filtered_files.lock() {
                            if let Some(f) = filtered.iter_mut().find(|f| f.path == path) {
                                f.width = full_meta.width;
                                f.height = full_meta.height;
                                f.prompt = full_meta.prompt.clone();
                                f.negative_prompt = full_meta.negative_prompt.clone();
                                f.source = full_meta.source.clone();
                                f.meta_loaded = true;
                            }
                        }
                    }
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
/// Rust側でソート・フィルタリングを実行するヘルパー関数
fn apply_filters_and_sort(state: &AppState) -> (usize, Vec<String>) {
    let all_files = state.all_files.lock().unwrap();
    let sort_config = state.sort_config.lock().unwrap();
    let search_query = state.search_query.lock().unwrap();

    let mut filtered: Vec<ImageFile> = if search_query.trim().is_empty() {
        all_files.clone()
    } else {
        let terms: Vec<String> = search_query.to_lowercase().split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        all_files.iter().filter(|f| {
            let text = format!("{} {} {} {}", f.name, f.prompt, f.negative_prompt, f.source).to_lowercase();
            terms.iter().all(|term| text.contains(term))
        }).cloned().collect()
    };

    // ソート
    let key = sort_config.key.as_str();
    let asc = sort_config.asc;
    filtered.sort_by(|a, b| {
        let cmp = match key {
            "name" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            "ext" => a.ext.cmp(&b.ext),
            "size" => a.size.cmp(&b.size),
            "mtime" => a.mtime.cmp(&b.mtime),
            "ctime" => a.ctime.cmp(&b.ctime),
            "width" => a.width.cmp(&b.width),
            "height" => a.height.cmp(&b.height),
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        };
        let cmp = if asc { cmp } else { cmp.reverse() };
        if cmp == std::cmp::Ordering::Equal {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else {
            cmp
        }
    });

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

    (total, paths)
}

/// JS側からソート条件・検索クエリを受け取り、Rust側でフィルタリングとソートを実行する
#[tauri::command]
fn set_view_params(
    state: tauri::State<'_, AppState>,
    sort_key: String,
    asc: bool,
    search_query: String,
) -> (usize, Vec<String>) {
    if let Ok(mut lock) = state.sort_config.lock() {
        *lock = SortConfig { key: sort_key, asc };
    }
    if let Ok(mut lock) = state.search_query.lock() {
        *lock = search_query;
    }
    apply_filters_and_sort(&state)
}

/// 仮想スクロール用: 指定範囲のImageFileをスライスして返す
#[tauri::command]
async fn get_items(state: tauri::State<'_, AppState>, offset: usize, limit: usize) -> Result<Vec<ImageFile>, String> {
    let lock = state.filtered_files.lock().unwrap();
    let end = std::cmp::min(offset + limit, lock.len());
    if offset >= lock.len() {
        return Ok(Vec::new());
    }
    Ok(lock[offset..end].to_vec())
}

/// selectImage用: 単一のImageFileを取得
#[tauri::command]
async fn get_file_by_index(state: tauri::State<'_, AppState>, index: usize) -> Result<Option<ImageFile>, String> {
    let lock = state.filtered_files.lock().unwrap();
    Ok(lock.get(index).cloned())
}

/// メタデータ読み込み結果をRust側のSource of Truthに反映する
#[tauri::command]
fn update_metadata_in_state(state: tauri::State<'_, AppState>, updates: Vec<FullMetadata>) {
    if let Ok(mut all_files) = state.all_files.lock() {
        for meta in &updates {
            if let Some(file) = all_files.iter_mut().find(|f| f.path == meta.path) {
                file.width = meta.width;
                file.height = meta.height;
                file.prompt = meta.prompt.clone();
                file.negative_prompt = meta.negative_prompt.clone();
                file.source = meta.source.clone();
                file.meta_loaded = true;
            }
        }
    }
    if let Ok(mut filtered) = state.filtered_files.lock() {
        for meta in &updates {
            if let Some(file) = filtered.iter_mut().find(|f| f.path == meta.path) {
                file.width = meta.width;
                file.height = meta.height;
                file.prompt = meta.prompt.clone();
                file.negative_prompt = meta.negative_prompt.clone();
                file.source = meta.source.clone();
                file.meta_loaded = true;
            }
        }
    }
}

/// ファイルウォッチャーから通知されたファイル変更をRust側のSource of Truthに反映する
#[tauri::command]
fn notify_file_changed(state: tauri::State<'_, AppState>, file: ImageFile) -> usize {
    if let Ok(mut all_files) = state.all_files.lock() {
        if let Some(existing) = all_files.iter_mut().find(|f| f.path == file.path) {
            *existing = file.clone();
        } else {
            all_files.push(file);
        }
    }
    apply_filters_and_sort(&state).0
}

/// ファイルウォッチャーから通知されたファイル削除をRust側のSource of Truthに反映する
#[tauri::command]
fn notify_file_removed(state: tauri::State<'_, AppState>, path: String) -> usize {
    if let Ok(mut all_files) = state.all_files.lock() {
        all_files.retain(|f| f.path != path);
    }
    apply_filters_and_sort(&state).0
}

#[tauri::command]
async fn get_full_metadata_batch(file_paths: Vec<String>) -> Result<Vec<FullMetadata>, String> {
    // rayonによるスレッドプール占有を防ぐため、通常のイテレータを使用する。
    // I/Oバウンドな処理であり、フロントエンド側で既にチャンク化（100件ずつ等）
    // されているため、Rust側では直列処理でも十分に高速かつ安全に動作します。
    Ok(tokio::task::spawn_blocking(move || {
        file_paths.into_iter().map(|path| {
            get_full_metadata_for_path(&path)
        }).collect()
    }).await.unwrap_or_default())
}

// --- バイナリ解析パーサー群 (JSの実装をRustへ移植) ---

fn get_full_metadata_for_path(file_path: &str) -> FullMetadata {
    let mtime = std::fs::metadata(file_path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let cache_dir = get_veloce_data_dir().map(|mut p| {
        p.push("Metadata");
        p
    });

    let cache_file_path = if let Some(dir) = &cache_dir {
        let _ = std::fs::create_dir_all(dir);
        let digest = md5::compute(format!("{}_{}", file_path, mtime).as_bytes());
        Some(dir.join(format!("{:x}.json", digest)))
    } else {
        None
    };

    if let Some(cache_path) = &cache_file_path {
        if cache_path.exists() {
            if let Ok(json_str) = std::fs::read_to_string(cache_path) {
                if let Ok(cached_meta) = serde_json::from_str::<FullMetadata>(&json_str) {
                    return cached_meta;
                }
            }
        }
    }

    let (width, height) = image::image_dimensions(file_path).unwrap_or((0, 0));

    let mut raw_description = String::new();
    let mut raw_comment = String::new();
    let mut raw_parameters = String::new();
    let mut source = String::new();

    let lower_path = file_path.to_lowercase();
    if lower_path.ends_with(".png") {
        let chunks = parse_png_chunks(file_path);
        raw_description = chunks.get("Description").or(chunks.get("ImageDescription")).cloned().unwrap_or_default();
        raw_comment = chunks.get("Comment").cloned().unwrap_or_default();
        raw_parameters = chunks.get("parameters").or(chunks.get("Parameters")).cloned().unwrap_or_default();
        source = chunks.get("Source").or(chunks.get("Software")).cloned().unwrap_or_default();

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
        let exif_data = if lower_path.ends_with(".webp") { parse_webp_exif(file_path) } else { parse_jpeg_exif(file_path) };

        if let Some(desc) = exif_data.get("ImageDescription") {
            raw_description = String::from_utf8_lossy(desc).trim_end_matches('\0').to_string();
        }
        if let Some(comment) = exif_data.get("UserComment") {
            let mut start = 0;
            if comment.starts_with(b"UNICODE\0") || comment.starts_with(b"ASCII\0\0\0") { start = 8; }
            raw_comment = String::from_utf8_lossy(&comment[start..]).trim_end_matches('\0').trim().to_string();
        }
        if let Some(sw) = exif_data.get("Software") {
            source = String::from_utf8_lossy(sw).trim_end_matches('\0').to_string();
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
                    if c == '{' { brace_count += 1; }
                    else if c == '}' {
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
                        if let Some(p) = comment_obj.get("Description").and_then(|v| v.as_str()) { prompt = p.to_string(); }
                        else if let Some(p) = inner_obj.get("prompt").and_then(|v| v.as_str()) { prompt = p.to_string(); }
                        if let Some(s) = comment_obj.get("Source").and_then(|v| v.as_str()) { json_source = Some(s.to_string()); }

                        if let serde_json::Value::Object(ref mut map) = comment_obj {
                            if let serde_json::Value::Object(inner_map) = inner_obj {
                                for (k, v) in inner_map { map.insert(k, v); }
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

                if let Some(uc) = comment_obj.get("uc").and_then(|v| v.as_str()) { negative_prompt = uc.to_string(); }
                if prompt.is_empty() {
                    if let Some(p) = comment_obj.get("prompt").and_then(|v| v.as_str()) {
                        prompt = p.to_string();
                        if let serde_json::Value::Object(ref mut map) = comment_obj { map.remove("prompt"); }
                    }
                }

                // NovelAI V4プロンプト対応
                if let Some(v4_prompt) = comment_obj.get("v4_prompt").cloned() {
                    if let Some(char_captions) = v4_prompt.pointer("/caption/char_captions").and_then(|v| v.as_array()) {
                        let mut char_prompts_arr = Vec::new();
                        let ucs = comment_obj.pointer("/v4_negative_prompt/caption/char_captions").and_then(|v| v.as_array());

                        for (i, p) in char_captions.iter().enumerate() {
                            let mut char_obj = serde_json::Map::new();
                            if let Some(cap) = p.get("char_caption").and_then(|v| v.as_str()) { char_obj.insert("prompt".to_string(), serde_json::Value::String(cap.to_string())); }
                            if let Some(uc_arr) = ucs {
                                if let Some(uc_item) = uc_arr.get(i) {
                                    if let Some(uc_cap) = uc_item.get("char_caption").and_then(|v| v.as_str()) { char_obj.insert("uc".to_string(), serde_json::Value::String(uc_cap.to_string())); }
                                }
                            }
                            char_prompts_arr.push(serde_json::Value::Object(char_obj));
                        }

                        if let serde_json::Value::Object(ref mut map) = comment_obj {
                            map.insert("characterPrompts".to_string(), serde_json::Value::Array(char_prompts_arr));
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
            map.insert("rawParameters".to_string(), serde_json::Value::String(raw_parameters));
            params = serde_json::Value::Object(map);
        } else if comment_string.contains("Steps: ") {
            let mut map = serde_json::Map::new();
            map.insert("rawParameters".to_string(), serde_json::Value::String(comment_string.to_string()));
            params = serde_json::Value::Object(map);
        } else if prompt.is_empty() && !comment_string.is_empty() {
            prompt = comment_string.to_string();
        } else if !comment_string.is_empty() && !comment_string.contains("Steps: ") {
            negative_prompt = comment_string.to_string();
        }
    }

    let meta = FullMetadata { path: file_path.to_string(), prompt, negative_prompt, width, height, params, source };

    if let Some(cache_path) = &cache_file_path {
        if let Ok(json_str) = serde_json::to_string(&meta) {
            let _ = std::fs::write(cache_path, json_str);
        }
    }

    meta
}

fn parse_png_chunks(path: &str) -> std::collections::HashMap<String, String> {
    let mut chunks = std::collections::HashMap::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let mut sig = [0; 8];
        if f.read_exact(&mut sig).is_err() || sig != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
            return chunks;
        }
        loop {
            let mut len_bytes = [0; 4];
            if f.read_exact(&mut len_bytes).is_err() { break; }
            let len = u32::from_be_bytes(len_bytes) as usize;
            if len > 100_000_000 { break; } // 安全のための上限

            let mut chunk_type = [0; 4];
            if f.read_exact(&mut chunk_type).is_err() { break; }

            if &chunk_type == b"tEXt" {
                let mut data = vec![0; len];
                if f.read_exact(&mut data).is_err() { break; }
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                    let text = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                    chunks.insert(keyword, text);
                }
            } else if &chunk_type == b"iTXt" {
                let mut data = vec![0; len];
                if f.read_exact(&mut data).is_err() { break; }
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
                if f.seek(SeekFrom::Current(len as i64)).is_err() { break; }
            }
            
            // Read 4 bytes for CRC to advance the file pointer to the next chunk
            let mut crc = [0; 4];
            if f.read_exact(&mut crc).is_err() { break; }
        }
    }
    chunks
}

fn parse_tiff_ifd(exif_data: &[u8]) -> std::collections::HashMap<String, Vec<u8>> {
    let mut results = std::collections::HashMap::new();
    if exif_data.len() < 8 { return results; }

    let is_little = match &exif_data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return results,
    };

    let read_u16 = |buf: &[u8], o: usize| -> u16 {
        if o + 2 > buf.len() { return 0; }
        let b: [u8; 2] = buf[o..o+2].try_into().unwrap_or_default();
        if is_little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }
    };
    let read_u32 = |buf: &[u8], o: usize| -> u32 {
        if o + 4 > buf.len() { return 0; }
        let b: [u8; 4] = buf[o..o+4].try_into().unwrap_or_default();
        if is_little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    };

    if read_u16(exif_data, 2) != 0x002A { return results; }
    let mut ifds_to_visit = vec![read_u32(exif_data, 4) as usize];
    let mut visited = 0;

    while let Some(ifd_offset) = ifds_to_visit.pop() {
        if visited > 10 || ifd_offset + 2 > exif_data.len() { break; } // 無限ループ防止
        visited += 1;

        let entry_count = read_u16(exif_data, ifd_offset);
        let mut ptr = ifd_offset + 2;

        for _ in 0..entry_count {
            if ptr + 12 > exif_data.len() { break; }
            let tag = read_u16(exif_data, ptr);
            let typ = read_u16(exif_data, ptr + 2);
            let count = read_u32(exif_data, ptr + 4) as usize;
            let value_offset = ptr + 8;

            let bytes_per_comp = match typ { 1|2|6|7 => 1, 3|8 => 2, 4|9|11 => 4, 5|10|12 => 8, _ => 0 };
            let byte_count = bytes_per_comp * count;

            let data = if byte_count <= 4 {
                &exif_data[value_offset..value_offset+4]
            } else {
                let off = read_u32(exif_data, value_offset) as usize;
                if off + byte_count <= exif_data.len() { &exif_data[off..off+byte_count] } else { &[] }
            };

            if !data.is_empty() {
                if tag == 0x010E && typ == 2 { // ImageDescription
                    results.insert("ImageDescription".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x9286 && typ == 7 { // UserComment
                    results.insert("UserComment".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x0131 && typ == 2 { // Software
                    results.insert("Software".to_string(), data[..byte_count].to_vec());
                } else if tag == 0x8769 && typ == 4 { // ExifOffset
                    let sub_ifd = if byte_count <= 4 { read_u32(exif_data, value_offset) } else { read_u32(exif_data, read_u32(exif_data, value_offset) as usize) } as usize;
                    ifds_to_visit.push(sub_ifd);
                }
            }
            ptr += 12;
        }
    }
    results
}

fn extract_stealth_pnginfo(path: &str) -> Option<String> {
    use image::GenericImageView;
    use flate2::read::GzDecoder;
    use std::io::Read;

    let img = image::open(path).ok()?;
    
    // アルファチャンネルの最下位ビットを抽出（Column-Major Order: x -> y）
    let mut bits = Vec::new();
    for x in 0..img.width() {
        for y in 0..img.height() {
            let pixel = img.get_pixel(x, y);
            bits.push(pixel.0[3] & 1);
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
    if let Ok(buffer) = std::fs::read(path) {
        if buffer.len() < 12 || &buffer[0..4] != b"RIFF" || &buffer[8..12] != b"WEBP" { return results; }
        let mut offset = 12;
        while offset + 8 <= buffer.len() {
            let chunk_id = &buffer[offset..offset+4];
            let chunk_size = u32::from_le_bytes(buffer[offset+4..offset+8].try_into().unwrap_or_default()) as usize;
            let data_offset = offset + 8;
            if chunk_id == b"EXIF" && data_offset + chunk_size <= buffer.len() {
                let mut exif_data = &buffer[data_offset..data_offset+chunk_size];
                if exif_data.len() >= 6 && &exif_data[0..4] == b"Exif" { exif_data = &exif_data[6..]; }
                results.extend(parse_tiff_ifd(exif_data));
            }
            offset = data_offset + chunk_size;
            if chunk_size % 2 != 0 { offset += 1; }
        }
    }
    results
}

fn parse_jpeg_exif(path: &str) -> std::collections::HashMap<String, Vec<u8>> {
    let mut results = std::collections::HashMap::new();
    if let Ok(buffer) = std::fs::read(path) {
        if buffer.len() < 2 || buffer[0] != 0xFF || buffer[1] != 0xD8 { return results; }
        let mut offset = 2;
        while offset + 4 <= buffer.len() {
            if buffer[offset] != 0xFF { break; }
            let marker = buffer[offset+1];
            let length = u16::from_be_bytes(buffer[offset+2..offset+4].try_into().unwrap_or_default()) as usize;
            if marker == 0xE1 && offset + 2 + length <= buffer.len() {
                let app1_data = &buffer[offset+4..offset+2+length];
                if app1_data.len() >= 6 && &app1_data[0..4] == b"Exif" {
                    results.extend(parse_tiff_ifd(&app1_data[6..]));
                }
            }
            offset += 2 + length;
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
    }).await.unwrap_or_default())
}

#[tauri::command]
async fn parse_metadata(file_path: String) -> Result<ParseMetadataResult, String> {
    Ok(tokio::task::spawn_blocking(move || {
        let full_meta = get_full_metadata_for_path(&file_path);
        ParseMetadataResult {
            prompt: full_meta.prompt,
            negative_prompt: full_meta.negative_prompt,
            width: full_meta.width,
            height: full_meta.height,
            params: full_meta.params,
            source: full_meta.source,
        }
    }).await.unwrap_or_else(|_| ParseMetadataResult {
        prompt: String::new(),
        negative_prompt: String::new(),
        width: 0,
        height: 0,
        params: serde_json::Value::Object(serde_json::Map::new()),
        source: String::new(),
    }))
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

    tauri::WindowBuilder::new(&app, label, tauri::WindowUrl::App(format!("/viewer.html?index={}", current_index).into()))
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
fn show_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
}

// --- サムネイル生成コマンド ---

#[tauri::command]
async fn get_thumbnail(state: tauri::State<'_, AppState>, file_path: String) -> Result<String, String> {
    // フォルダ移動済みの場合は無駄な処理（画像読み込み・リサイズ）をスキップする
    if let Ok(current_dir) = state.current_dir.lock() {
        let parent_dir = Path::new(&file_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        
        if !current_dir.is_empty() {
            let current_trim = current_dir.replace("\\\\?\\", "").trim_end_matches(&['/', '\\'][..]).to_lowercase();
            let parent_trim = parent_dir.replace("\\\\?\\", "").trim_end_matches(&['/', '\\'][..]).to_lowercase();
            if current_trim != parent_trim {
                return Err("Cancelled".to_string());
            }
        }
    }

    let cache_dir = get_veloce_data_dir().map(|mut p| {
        p.push("Thumbnails");
        p
    });

    let semaphore = state.thumbnail_semaphore.clone();
    let _permit = semaphore.acquire_owned().await.map_err(|_| "Semaphore closed".to_string())?;

    tokio::task::spawn_blocking(move || {
        let mtime = std::fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let cache_file_path = if let Some(dir) = &cache_dir {
            let _ = std::fs::create_dir_all(dir);
            let digest = md5::compute(format!("{}_{}", file_path, mtime).as_bytes());
            Some(dir.join(format!("{:x}.jpg", digest)))
        } else {
            None
        };

        if let Some(cache_path) = &cache_file_path {
            if cache_path.exists() {
                // キャッシュが既に存在する場合は、I/Oをスキップしてパスのみを即座に返す
                return Ok(cache_path.to_string_lossy().to_string());
            }
        }

        // Windows環境ではOS標準のAPIを使用してサムネイルを高速に取得する
        #[cfg(windows)]
        {
            use windows::core::HSTRING;
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY};
            use windows::Win32::Graphics::Gdi::{
                DeleteObject, GetObjectW, GetDIBits, CreateCompatibleDC, DeleteDC,
                BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, RGBQUAD
            };
            use windows::Win32::Foundation::SIZE;

            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                
                let result: Option<Vec<u8>> = (|| -> windows::core::Result<Vec<u8>> {
                    let path_hstring = HSTRING::from(&file_path);
                    let item: IShellItemImageFactory = SHCreateItemFromParsingName(&path_hstring, None)?;
                    
                    let size = SIZE { cx: 512, cy: 512 };
                    let hbitmap = item.GetImage(size, SIIGBF_RESIZETOFIT | SIIGBF_THUMBNAILONLY)?;

                    let mut bitmap = BITMAP::default();
                    if GetObjectW(
                        hbitmap,
                        std::mem::size_of::<BITMAP>() as i32,
                        Some(&mut bitmap as *mut _ as *mut std::ffi::c_void),
                    ) == 0 {
                        let _ = DeleteObject(hbitmap);
                        return Err(windows::core::Error::from_win32());
                    }

                    let width = bitmap.bmWidth;
                    let height = bitmap.bmHeight;
                    let mut info = BITMAPINFO {
                        bmiHeader: BITMAPINFOHEADER {
                            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                            biWidth: width,
                            biHeight: -height, // top-down
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

                    let hdc = CreateCompatibleDC(None);
                    let mut pixels = vec![0u8; (width * height * 4) as usize];
                    let res = GetDIBits(
                        hdc,
                        hbitmap,
                        0,
                        height as u32,
                        Some(pixels.as_mut_ptr() as *mut _),
                        &mut info,
                        DIB_RGB_COLORS,
                    );

                    let _ = DeleteDC(hdc);
                    let _ = DeleteObject(hbitmap);

                    if res == 0 {
                        return Err(windows::core::Error::from_win32());
                    }

                    // BGRA -> RGBA のバイトスワップ
                    for chunk in pixels.chunks_exact_mut(4) {
                        chunk.swap(0, 2);
                    }

                    if let Some(img) = image::RgbaImage::from_raw(width as u32, height as u32, pixels) {
                        let dyn_img = image::DynamicImage::ImageRgba8(img);
                        let mut buf = std::io::Cursor::new(Vec::with_capacity(65_536));
                        if dyn_img.write_to(&mut buf, image::ImageFormat::Jpeg).is_ok() {
                            return Ok(buf.into_inner());
                        }
                    }

                    Err(windows::core::Error::from_win32())
                })().ok();

                CoUninitialize();

                // WindowsAPIでの取得が成功した場合はそのまま返す
                if let Some(bytes) = result {
                    if let Some(cache_path) = &cache_file_path {
                        let _ = std::fs::write(cache_path, &bytes);
                        return Ok(cache_path.to_string_lossy().to_string());
                    }
                }
            }
        }

        // --- フォールバック: 既存の image::open 処理 ---
        // Mutex を使用して、フォールバックの画像デコードを同時に1つだけに制限することで、
        // 巨大な画像を複数スレッドでデコードしようとしてOOMになるのを防ぎます。
        static FALLBACK_DECODE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = match FALLBACK_DECODE_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        
        let img = image::open(&file_path).map_err(|e| format!("image::open failed: {}", e))?;
        let thumbnail = img.thumbnail(512, 512);
        
        let mut buf = std::io::Cursor::new(Vec::with_capacity(65_536));
        thumbnail.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        
        let bytes = buf.into_inner();
        if let Some(cache_path) = &cache_file_path {
            let _ = std::fs::write(cache_path, &bytes);
            return Ok(cache_path.to_string_lossy().to_string());
        }
        
        Err("Could not save thumbnail cache".to_string())
    }).await.unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
fn arrange_viewers(app: tauri::AppHandle, caller_window: tauri::Window) {
    let windows = app.windows();
    let mut viewers: Vec<_> = windows
        .into_values()
        .filter(|w| w.label().starts_with("viewer_"))
        .collect();

    let count = viewers.len();
    if count == 0 { return; }

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
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: target_width, height: target_height }));
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
                
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
                    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE};
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

#[tauri::command]
fn sync_image_paths(app: tauri::AppHandle, state: tauri::State<'_, AppState>, paths: Vec<String>) {
    if let Ok(mut lock) = state.image_paths.lock() {
        *lock = paths.clone();
    }

    let target_dir = if let Some(first_path) = paths.first() {
        Some(Path::new(first_path).parent().unwrap_or(Path::new("")).to_string_lossy().to_string())
    } else {
        state.current_dir.lock().ok().map(|d| d.clone())
    };

    if let Some(dir_str) = target_dir {
        if let Ok(mut viewer_paths) = state.viewer_paths.lock() {
            for (label, viewer_list) in viewer_paths.iter_mut() {
                let v_dir = viewer_list.first()
                    .and_then(|p| Path::new(p).parent())
                    .map(|p| p.to_string_lossy().to_string());
                
                if v_dir == Some(dir_str.clone()) {
                    *viewer_list = paths.clone();
                    let _ = app.emit_to(label, "viewer-list-updated", paths.clone());
                }
            }
        }
    }
}

// --- ファイル・システム操作コマンド ---

fn collect_cache_paths_to_remove(target_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut cache_paths = Vec::new();
    if let Some(mut cache_dir) = get_veloce_data_dir() {
        if target_path.is_file() {
            collect_single_file_cache(target_path, &mut cache_dir, &mut cache_paths);
        } else if target_path.is_dir() {
            for entry in walkdir::WalkDir::new(target_path).into_iter().filter_map(|e| e.ok()) {
                if entry.path().is_file() {
                    collect_single_file_cache(entry.path(), &mut cache_dir, &mut cache_paths);
                }
            }
        }
    }
    cache_paths
}

fn collect_single_file_cache(path: &std::path::Path, cache_dir: &mut std::path::PathBuf, cache_paths: &mut Vec<std::path::PathBuf>) {
    if let Ok(metadata) = std::fs::metadata(path) {
        let mtime = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let clean_path = path.to_string_lossy().to_string().replace("\\\\?\\", "");
        let cache_file_name = format!("{}_{}", clean_path, mtime);
        let digest = md5::compute(cache_file_name.as_bytes());

        cache_dir.push("Thumbnails");
        cache_paths.push(cache_dir.join(format!("{:x}.jpg", digest)));
        cache_dir.pop();
        
        cache_dir.push("Metadata");
        cache_paths.push(cache_dir.join(format!("{:x}.json", digest)));
        cache_dir.pop();
    }
}

fn remove_collected_caches(cache_paths: Vec<std::path::PathBuf>) {
    for path in cache_paths {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
fn clear_metadata_cache(file_paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut messages = Vec::new();
    if let Some(base_dir) = get_veloce_data_dir() {
        let meta_dir = base_dir.join("Metadata");
        let thumb_dir = base_dir.join("Thumbnails");
        
        for file_path in file_paths {
            let mtime = std::fs::metadata(&file_path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            
            let clean_path = file_path.replace("\\\\?\\", "");
            
            // Raw path digest
            let digest_raw = md5::compute(format!("{}_{}", file_path, mtime).as_bytes());
            let json_raw = meta_dir.join(format!("{:x}.json", digest_raw));
            let jpg_raw = thumb_dir.join(format!("{:x}.jpg", digest_raw));
            
            // Clean path digest
            let digest_clean = md5::compute(format!("{}_{}", clean_path, mtime).as_bytes());
            let json_clean = meta_dir.join(format!("{:x}.json", digest_clean));
            let jpg_clean = thumb_dir.join(format!("{:x}.jpg", digest_clean));

            for cache_file in [json_raw, jpg_raw, json_clean, jpg_clean] {
                if cache_file.exists() {
                    if let Err(e) = std::fs::remove_file(&cache_file) {
                        messages.push(format!("Failed: {}: {}", cache_file.display(), e));
                    } else {
                        messages.push(format!("Deleted: {}", cache_file.display()));
                    }
                }
            }
        }
    }
    Ok(messages)
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
    }).await.unwrap_or(false))
}

#[tauri::command]
async fn trash_folder(folder_path: String) -> Result<FolderOperationResult, String> {
    Ok(tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&folder_path);
        let cache_paths = collect_cache_paths_to_remove(path);

        match trash::delete(&folder_path) {
            Ok(_) => {
                remove_collected_caches(cache_paths);
                FolderOperationResult { success: true, path: None, error: None }
            },
            Err(e) => FolderOperationResult { success: false, path: None, error: Some(e.to_string()) },
        }
    }).await.unwrap_or_else(|e| FolderOperationResult { success: false, path: None, error: Some(e.to_string()) }))
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
    }).await.unwrap_or(());
    Ok(())
}

#[tauri::command]
fn toggle_devtools(_window: tauri::Window) {
    #[cfg(debug_assertions)]
    {
        if _window.is_devtools_open() {
            _window.close_devtools();
        } else {
            _window.open_devtools();
        }
    }
}

#[tauri::command]
fn get_license_text() -> String {
    include_str!("../../LICENSE.md").to_string()
}

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
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
        },
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn rename_folder(old_path: String, new_name: String) -> Result<String, String> {
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
        },
        Err(e) => Err(e.to_string()),
    }
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
fn clear_cache() -> Result<(), String> {
    if let Some(mut path) = get_veloce_data_dir() {
        // Clear Thumbnails
        path.push("Thumbnails");
        if path.exists() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        }
        
        // Clear Metadata
        path.pop();
        path.push("Metadata");
        if path.exists() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        Err("Could not resolve local data directory".to_string())
    }
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = std::path::Path::new(&path);
    if !path_obj.exists() {
        return Err("Path does not exist".to_string());
    }
    
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(path).spawn();

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
fn get_cache_info() -> CacheInfo {
    let mut path_str = String::new();
    let mut file_count = 0;
    let mut total_size_bytes = 0;

    if let Some(mut path) = get_veloce_data_dir() {
        path_str = path.to_string_lossy().to_string(); // 親ディレクトリ(Veloce)のパスを保持

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

        // メタデータキャッシュの情報も合算する
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
}

fn main() {
    let mut context = tauri::generate_context!();
    
    // tauri.conf.json で定義されているメインウィンドウの設定を退避させて、自動生成をキャンセルする
    let window_configs = context.config_mut().tauri.windows.clone();
    context.config_mut().tauri.windows.clear();

    tauri::Builder::default()
        .manage(AppState { 
            image_paths: Mutex::new(Vec::new()),
            current_dir: Mutex::new(String::new()),
            viewer_paths: Mutex::new(std::collections::HashMap::new()),
            all_files: Mutex::new(Vec::new()),
            filtered_files: Mutex::new(Vec::new()),
            sort_config: Mutex::new(SortConfig { key: "name".to_string(), asc: true }),
            search_query: Mutex::new(String::new()),
            thumbnail_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(16)),
        })
        .setup(move |app| {
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
                                let target_time = metadata.accessed().unwrap_or_else(|_| metadata.modified().unwrap_or(now));
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
                let mut last_dir = String::new();
                let mut known_files: std::collections::HashMap<String, (u64, u64)> = std::collections::HashMap::new();
                let mut known_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    
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
                                        if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp") {
                                            if let Ok(meta) = entry.metadata() {
                                                let size = meta.len();
                                                let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                                known_files.insert(p.to_string_lossy().to_string(), (size, mtime));
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

                    let mut current_files: std::collections::HashMap<String, (u64, u64)> = std::collections::HashMap::new();
                    let mut current_folders: std::collections::HashSet<String> = std::collections::HashSet::new();
                    let mut folder_changed = false;

                    if let Ok(entries) = std::fs::read_dir(&current_dir) {
                        for entry in entries.filter_map(Result::ok) {
                            let p = entry.path();
                            if p.is_file() {
                                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                                    let ext_lower = ext.to_lowercase();
                                    if matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp") {
                                        if let Ok(meta) = entry.metadata() {
                                            let size = meta.len();
                                            let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                            let path_str = p.to_string_lossy().to_string();
                                            current_files.insert(path_str.clone(), (size, mtime));

                                            if let Some(&(old_size, old_mtime)) = known_files.get(&path_str) {
                                                if old_size != size || old_mtime != mtime {
                                                    let ctime = meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                                    let file_name = entry.file_name().to_string_lossy().into_owned();
                                                    let img_file = ImageFile { name: file_name, ext: format!(".{}", ext_lower), path: path_str.clone(), size, mtime, ctime, has_thumbnail_cache: false, has_metadata_cache: false, width: 0, height: 0, prompt: String::new(), negative_prompt: String::new(), source: String::new(), meta_loaded: false };
                                                    let _ = app_handle.emit_all("file-changed", img_file);
                                                }
                                            } else {
                                                let ctime = meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                                                let file_name = entry.file_name().to_string_lossy().into_owned();
                                                let img_file = ImageFile { name: file_name, ext: format!(".{}", ext_lower), path: path_str.clone(), size, mtime, ctime, has_thumbnail_cache: false, has_metadata_cache: false, width: 0, height: 0, prompt: String::new(), negative_prompt: String::new(), source: String::new(), meta_loaded: false };
                                                let _ = app_handle.emit_all("file-changed", img_file);
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
                                let digest = md5::compute(cache_file_name.as_bytes());

                                let thumb_path = data_dir.join("Thumbnails").join(format!("{:x}.jpg", digest));
                                let meta_path = data_dir.join("Metadata").join(format!("{:x}.json", digest));

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
        .invoke_handler(tauri::generate_handler![
            get_drives,
            path_exists,
            load_directory,
            set_view_params,
            get_items,
            get_file_by_index,
            update_metadata_in_state,
            notify_file_changed,
            notify_file_removed,
            get_full_metadata_batch,
            parse_metadata,
            get_viewer_image,
            open_viewer,
            show_window,
            get_thumbnail,
            arrange_viewers,
            sync_image_paths,
            trash_file,
            trash_folder,
            copy_image_to_clipboard,
            toggle_devtools,
            get_license_text,
            rename_file,
            rename_folder,
            open_cache_folder,
            clear_cache,
            get_cache_info,
            open_in_explorer,
            check_conflicts,
            clear_metadata_cache
        ])
        .run(context)
        .expect("error while running tauri application");
}
