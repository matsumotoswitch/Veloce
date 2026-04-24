#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use std::io::Read; // flate2のread_to_stringやバイナリ解析用
use std::sync::Mutex;
use std::hash::{Hash, Hasher};
use rayon::prelude::*;
use tauri::Manager;
use notify::{Watcher, RecursiveMode, EventKind};

// --- データ構造の定義 ---
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")] // フロントエンドのJSがキャメルケースを期待しているため変換
pub struct ImageFile {
    name: String,
    ext: String,
    path: String,
    size: u64,
    mtime: u64,
    has_thumbnail_cache: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDirectoryResult {
    path: String,
    image_files: Vec<ImageFile>,
}

#[derive(Serialize)]
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
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

// --- ユーティリティ ---

/// アプリケーション専用のローカルデータディレクトリを取得する (`AppData/Local/Veloce`)
fn get_veloce_data_dir() -> Option<std::path::PathBuf> {
    tauri::api::path::local_data_dir().map(|mut p| {
        p.push("Veloce");
        p
    })
}

/// 指定されたパスがサポート対象の画像であれば、ImageFile構造体を生成して返す
fn create_image_file(path: &Path, cache_dir: &Option<std::path::PathBuf>) -> Option<ImageFile> {
    if !path.is_file() {
        return None;
    }
    let ext_os = path.extension()?;
    let ext = format!(".{}", ext_os.to_string_lossy().to_lowercase());
    let supported = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
    if !supported.contains(&ext.as_str()) {
        return None;
    }

    // Windows固有の長いパス修飾子プレフィックスを除去
    let clean_path = path.to_string_lossy().replace("\\\\?\\", "");
    let mut size = 0;
    let mut mtime = 0;
    if let Ok(metadata) = std::fs::metadata(path) {
        size = metadata.len();
        mtime = metadata.modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
    }

    let has_thumbnail_cache = if let Some(dir) = cache_dir {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        format!("{}_{}", &clean_path, mtime).hash(&mut hasher);
        let hash = hasher.finish();
        let cache_path = dir.join(format!("{}.jpg", hash));
        cache_path.exists()
    } else {
        false
    };

    Some(ImageFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        ext,
        path: clean_path,
        size,
        mtime,
        has_thumbnail_cache,
    })
}

// --- Tauri コマンド ---

/// 利用可能なドライブ文字（Windows）またはルートディレクトリ（Unix）のリストを取得する
#[tauri::command]
fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    
    #[cfg(windows)]
    {
        for c in b'A'..=b'Z' {
            let path = format!("{}:\\", c as char);
            if Path::new(&path).exists() {
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
async fn load_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target_path: String,
) -> Result<Option<LoadDirectoryResult>, String> {
    let dir_path = target_path.clone();

    let res = tokio::task::spawn_blocking(move || {
        let mut path_str = dir_path;
        if path_str.is_empty() || path_str.to_uppercase() == "PC" {
            path_str = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| "/".to_string());
        }

        let path = Path::new(&path_str);
        if !path.exists() {
            return None;
        }

        let actual_dir = if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        };

        let cache_dir = get_veloce_data_dir().map(|mut p| {
            p.push("Thumbnails");
            p
        });

        let mut image_files = Vec::new();
        let mut paths = Vec::new();

        if let Ok(read_dir) = fs::read_dir(&actual_dir) {
            let entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
            
            // create_image_file はI/Oを含むため、rayonで並列化して高速化する
            let mut results: Vec<_> = entries.into_par_iter().filter_map(|entry| {
                create_image_file(&entry.path(), &cache_dir)
            }).collect();

            // ファイル名の順番を安定させるためソート
            results.sort_by(|a, b| a.path.cmp(&b.path));

            for file in results {
                paths.push(file.path.clone());
                image_files.push(file);
            }
        }
        Some((actual_dir, image_files, paths))
    }).await.unwrap_or(None);

    if let Some((actual_dir, image_files, paths)) = res {
        // 確実にロックを取得し、パスのリストを更新する
        let mut lock = state.image_paths.lock().unwrap();
        *lock = paths;

        if let Ok(mut dir_lock) = state.current_dir.lock() {
            *dir_lock = actual_dir.to_string_lossy().to_string();
        }

        // --- フォルダ監視 (File Watching) の設定 ---
        if let Ok(mut watcher_lock) = state.watcher.lock() {
            let app_handle = app.clone();
            *watcher_lock = None; // 別のフォルダに移動した際、古いウォッチャーを破棄する
            
            let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    let cache_dir = get_veloce_data_dir().map(|mut p| {
                        p.push("Thumbnails");
                        p
                    });

                    match &event.kind {
                        EventKind::Access(_) => {
                            // ファイル/フォルダへのアクセスイベントは大量に発生するため無視する
                        },
                        _ => { // それ以外のすべてのイベント (Create, Modify, Remove, Renameなど)
                            let mut dir_changed = false;
                            for path in &event.paths {
                                // is_dir() は削除されたディレクトリにはfalseを返すため、拡張子がない場合もディレクトリ変更と見なす
                                if path.is_dir() || path.extension().is_none() {
                                    dir_changed = true;
                                    break;
                                }
                            }

                            if dir_changed {
                                let _ = app_handle.emit_all("directory-changed", ());
                            } else {
                                for path in event.paths {
                                    if let EventKind::Remove(_) = &event.kind {
                                        let clean_path = path.to_string_lossy().replace("\\\\?\\", "");
                                        let _ = app_handle.emit_all("file-removed", clean_path);
                                    } else if let Some(img_file) = create_image_file(&path, &cache_dir) {
                                        let _ = app_handle.emit_all("file-changed", img_file);
                                    }
                                }
                            }
                        }
                    }
                }
            }).ok();

            if let Some(w) = watcher.as_mut() {
                let _ = w.watch(actual_dir.as_path(), RecursiveMode::NonRecursive);
            }
            *watcher_lock = watcher;
        }
        // --- 監視設定ここまで ---

        Ok(Some(LoadDirectoryResult {
            path: actual_dir.to_string_lossy().to_string(),
            image_files,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn get_full_metadata_batch(file_paths: Vec<String>) -> Result<Vec<FullMetadata>, String> {
    Ok(tokio::task::spawn_blocking(move || {
        file_paths.into_par_iter().map(|path| {
            get_full_metadata_for_path(&path)
        }).collect()
    }).await.unwrap_or_default())
}

// --- バイナリ解析パーサー群 (JSの実装をRustへ移植) ---

fn get_full_metadata_for_path(file_path: &str) -> FullMetadata {
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

    let mut prompt = raw_description.clone();
    let mut negative_prompt = String::new();
    let mut params = serde_json::Value::Object(serde_json::Map::new());
    let comment_string = raw_comment.trim();

    if let Some(start) = comment_string.find('{') {
        if let Some(end) = comment_string.rfind('}') {
            let json_text = &comment_string[start..=end];
            if let Ok(mut comment_obj) = serde_json::from_str::<serde_json::Value>(json_text) {
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

    FullMetadata { path: file_path.to_string(), prompt, negative_prompt, width, height, params, source }
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

            let mut data = vec![0; len];
            if f.read_exact(&mut data).is_err() { break; }

            let mut crc = [0; 4];
            if f.read_exact(&mut crc).is_err() { break; }

            if &chunk_type == b"tEXt" {
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                    let text = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                    chunks.insert(keyword, text);
                }
            } else if &chunk_type == b"iTXt" {
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
            }
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
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Option<ViewerImageResult> {
    if let Ok(paths) = state.image_paths.lock() {
        if let Some(path) = paths.get(index) {
            return Some(ViewerImageResult {
                path: path.clone(),
                total: paths.len(),
            });
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
    let target_path = {
        if let Ok(paths) = state.image_paths.lock() {
            paths.get(current_index).cloned()
        } else {
            None
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

    let label = format!("viewer_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());

    let data_dir = get_veloce_data_dir().unwrap_or_default();

    tauri::WindowBuilder::new(&app, label, tauri::WindowUrl::App(format!("/viewer.html?index={}", current_index).into()))
        .title("Veloce Viewer")
        .inner_size(win_width as f64, win_height as f64)
        .data_directory(data_dir)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
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
            let current_trim = current_dir.trim_end_matches(&['/', '\\'][..]).to_lowercase();
            let parent_trim = parent_dir.trim_end_matches(&['/', '\\'][..]).to_lowercase();
            if current_trim != parent_trim {
                return Err("Cancelled".to_string());
            }
        }
    }

    let cache_dir = get_veloce_data_dir().map(|mut p| {
        p.push("Thumbnails");
        p
    });

    tokio::task::spawn_blocking(move || {
        let mtime = std::fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let cache_file_path = if let Some(dir) = &cache_dir {
            let _ = std::fs::create_dir_all(dir);
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            format!("{}_{}", file_path, mtime).hash(&mut hasher);
            let hash = hasher.finish();
            Some(dir.join(format!("{}.jpg", hash)))
        } else {
            None
        };

        if let Some(cache_path) = &cache_file_path {
            if cache_path.exists() {
                // キャッシュが既に存在する場合は、I/Oをスキップしてパスのみを即座に返す
                return Ok(cache_path.to_string_lossy().to_string());
            }
        }

        #[cfg(windows)]
        {
            use windows::core::HSTRING;
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
            use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_THUMBNAILONLY};
            use windows::Win32::Graphics::Gdi::{
                DeleteObject, GetObjectW, GetDIBits, CreateCompatibleDC, DeleteDC,
                BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, RGBQUAD
            };
            use windows::Win32::Foundation::SIZE;

            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                
                let result: Option<Vec<u8>> = (|| -> windows::core::Result<Vec<u8>> {
                    let path_hstring = HSTRING::from(&file_path);
                    let item: IShellItemImageFactory = SHCreateItemFromParsingName(&path_hstring, None)?;
                    
                    let size = SIZE { cx: 512, cy: 512 };
                    let hbitmap = item.GetImage(size, SIIGBF_THUMBNAILONLY)?;

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
                        if std::fs::write(cache_path, &bytes).is_ok() {
                            return Ok(cache_path.to_string_lossy().to_string());
                        }
                    }
                    return Ok(file_path.clone());
                }
            }
        }

        // --- フォールバック: 既存の image::open 処理 ---
        let img = image::open(&file_path).map_err(|e| e.to_string())?;
        
        let (src_width_val, src_height_val, src_raw, pixel_type) = match img {
            image::DynamicImage::ImageRgb8(rgb) => {
                let (w, h) = rgb.dimensions();
                (w, h, rgb.into_raw(), fast_image_resize::PixelType::U8x3)
            },
            image::DynamicImage::ImageRgba8(rgba) => {
                let (w, h) = rgba.dimensions();
                (w, h, rgba.into_raw(), fast_image_resize::PixelType::U8x4)
            },
            _ => {
                let rgba = img.into_rgba8();
                let (w, h) = rgba.dimensions();
                (w, h, rgba.into_raw(), fast_image_resize::PixelType::U8x4)
            }
        };

        let src_width = std::num::NonZeroU32::new(src_width_val).unwrap_or(std::num::NonZeroU32::new(1).unwrap());
        let src_height = std::num::NonZeroU32::new(src_height_val).unwrap_or(std::num::NonZeroU32::new(1).unwrap());

        let src_image = fast_image_resize::Image::from_vec_u8(src_width, src_height, src_raw, pixel_type).map_err(|e| e.to_string())?;

        let max_dim: f32 = 512.0;
        let ratio = (max_dim / src_width.get() as f32).min(max_dim / src_height.get() as f32).min(1.0_f32);
        let dst_width = std::num::NonZeroU32::new((src_width.get() as f32 * ratio).max(1.0) as u32).unwrap();
        let dst_height = std::num::NonZeroU32::new((src_height.get() as f32 * ratio).max(1.0) as u32).unwrap();

        let mut dst_image = fast_image_resize::Image::new(dst_width, dst_height, pixel_type);
        let mut resizer = fast_image_resize::Resizer::new(fast_image_resize::ResizeAlg::Nearest);
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).map_err(|e| e.to_string())?;

        let thumb = match pixel_type {
            fast_image_resize::PixelType::U8x3 => image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(dst_width.get(), dst_height.get(), dst_image.into_vec()).unwrap()),
            _ => image::DynamicImage::ImageRgba8(image::RgbaImage::from_raw(dst_width.get(), dst_height.get(), dst_image.into_vec()).unwrap()),
        };

        let mut buf = std::io::Cursor::new(Vec::with_capacity(65_536));
        thumb.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        let bytes = buf.into_inner();

        if let Some(cache_path) = &cache_file_path {
            if std::fs::write(cache_path, &bytes).is_ok() {
                return Ok(cache_path.to_string_lossy().to_string());
            }
        }

        Ok(file_path)
    }).await.unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
fn arrange_viewers(app: tauri::AppHandle) {
    let windows = app.windows();
    let mut viewers: Vec<_> = windows
        .into_values()
        .filter(|w| w.label().starts_with("viewer_"))
        .collect();

    let count = viewers.len();
    if count == 0 { return; }

    // ラベル名のタイムスタンプ（作成順）でソートして、左から古い順に並べる
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

                let _ = window.unmaximize(); // 最大化されていると移動できないため解除
                let _ = window.set_always_on_top(true); // タスクバーより前面に表示するために最前面に設定
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: target_width, height: target_height }));
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            }
        }
    }
}

#[tauri::command]
fn sync_image_paths(state: tauri::State<'_, AppState>, paths: Vec<String>) {
    if let Ok(mut lock) = state.image_paths.lock() {
        *lock = paths;
    }
}

// --- ファイル・システム操作コマンド ---

#[tauri::command]
async fn trash_file(file_path: String) -> Result<bool, String> {
    Ok(tokio::task::spawn_blocking(move || {
        if trash::delete(&file_path).is_ok() {
            true
        } else {
            false
        }
    }).await.unwrap_or(false))
}

#[tauri::command]
async fn trash_folder(folder_path: String) -> Result<FolderOperationResult, String> {
    Ok(tokio::task::spawn_blocking(move || {
        match trash::delete(&folder_path) {
            Ok(_) => FolderOperationResult { success: true, path: None, error: None },
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
    let new_path = parent.join(new_name);

    if new_path.exists() {
        let old_lower = old_path.to_lowercase();
        let new_lower = new_path.to_string_lossy().to_lowercase();
        if old_lower != new_lower {
            return Err("同じ名前のファイルが既に存在します。".to_string());
        }
    }

    match std::fs::rename(&old_path, &new_path) {
        Ok(_) => Ok(new_path.to_string_lossy().to_string()),
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

    match std::fs::rename(&old_path, &new_path) {
        Ok(_) => Ok(new_path.to_string_lossy().to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn open_thumbnail_folder() -> Result<(), String> {
    if let Some(mut path) = get_veloce_data_dir() {
        path.push("Thumbnails");
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
fn clear_thumbnail_cache() -> Result<(), String> {
    if let Some(mut path) = get_veloce_data_dir() {
        path.push("Thumbnails");
        if path.exists() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        Err("Could not resolve local data directory".to_string())
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
            watcher: Mutex::new(None),
        })
        .setup(move |app| {
            let data_dir = get_veloce_data_dir().unwrap_or_default();

            // 退避させた設定と、指定したデータディレクトリを使って自分でウィンドウを作成する
            for config in window_configs {
                tauri::WindowBuilder::from_config(app, config)
                    .data_directory(data_dir.clone())
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

            Ok(())
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event.event() {
                if event.window().label() == "main" {
                    std::process::exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_drives,
            load_directory,
            get_full_metadata_batch,
            parse_metadata,
            get_viewer_image,
            open_viewer,
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
            open_thumbnail_folder,
            clear_thumbnail_cache
        ])
        .run(context)
        .expect("error while running tauri application");
}