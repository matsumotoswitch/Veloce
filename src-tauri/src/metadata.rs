//! # Veloce - Metadata Extraction Module (metadata.rs)
//!
//! 本モジュールは、画像（PNG / WebP / JPEG）および動画・音声ファイルに対する
//! メタデータ解析（PNG tEXt/zTXt/iTXt、EXIF、XMP、Stealth PNGInfo アルファチャンネル解析、
//! NovelAI / A1111 / ComfyUI プロンプト抽出・正規化、およびアルファオーバーレイ可視化）一式を提供する。

use crate::models::{FullMetadata, ParseMetadataResult};
use crate::state::AppState;
use crate::utils::extract_searchable_strings;

#[tauri::command]
pub(crate) async fn get_full_metadata_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<FullMetadata>, String> {
    // rayonによるスレッドプール占有を防ぐため、通常のイテレータを使用する。
    // I/Oバウンドな処理であり、フロントエンド側で既にチャンク化（100件ずつ等）
    // されているため、Rust側では直列処理でも十分に高速かつ安全に動作します。
    let db_conn_clone = state.db_conn.clone();
    Ok(tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        let results: Vec<(FullMetadata, Option<MetadataCacheRow>)> = file_paths
            .into_par_iter()
            .map(|path| get_full_metadata_for_path_compute_only(&path, &db_conn_clone))
            .collect();
        let mut pending_rows = Vec::new();
        let mut metas = Vec::with_capacity(results.len());
        for (meta, opt_row) in results {
            if let Some(row) = opt_row {
                pending_rows.push(row);
            }
            metas.push(meta);
        }
        let _ = commit_pending_metadata_batch(&db_conn_clone, &pending_rows);
        metas
    })
    .await
    .unwrap_or_default())
}

// --- バイナリ解析パーサー群 (JSの実装をRustへ移植) ---

pub(crate) fn decode_metadata_string(bytes: &[u8]) -> String {
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

pub(crate) fn parse_mp4_dimensions(path: &str) -> Option<(u32, u32)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = [0u8; 8];
    let file_len = file.metadata().ok()?.len();
    
    let mut pos = 0u64;
    const MAX_MP4_BOX_STEPS: usize = 4096;
    for _ in 0..MAX_MP4_BOX_STEPS {
        if pos + 8 > file_len {
            break;
        }
        if file.seek(SeekFrom::Start(pos)).is_err() { break; }
        if file.read_exact(&mut buffer).is_err() { break; }
        let size32 = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as u64;
        let box_type = [buffer[4], buffer[5], buffer[6], buffer[7]];

        let (header_size, box_size) = if size32 == 1 {
            let mut large_size_buf = [0u8; 8];
            if file.read_exact(&mut large_size_buf).is_err() { break; }
            let large_size = u64::from_be_bytes(large_size_buf);
            if large_size < 16 { break; }
            (16u64, large_size)
        } else if size32 == 0 {
            let remaining = file_len.saturating_sub(pos);
            if remaining < 8 { break; }
            (8u64, remaining)
        } else if size32 >= 8 {
            (8u64, size32)
        } else {
            break;
        };

        if &box_type == b"moov" || &box_type == b"trak" {
            pos = pos.saturating_add(header_size);
            continue;
        } else if &box_type == b"tkhd" {
            let content_pos = pos.saturating_add(header_size);
            let content_size = box_size.saturating_sub(header_size);
            // 悪意ある巨大サイズ（最大4GB）によるOOMを防ぐため、解像度解析に必要な上限256バイトでバッファをクランプ。
            // またファイル末尾を超えて read_exact が失敗しないよう実残バイト数でもクランプする。
            let remaining_file_bytes = file_len.saturating_sub(content_pos);
            let target_read = std::cmp::min(content_size, remaining_file_bytes);
            let read_len = std::cmp::min(target_read, 256) as usize;
            let mut tkhd_data = vec![0u8; read_len];
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
            pos = pos.saturating_add(box_size);
        } else {
            pos = pos.saturating_add(box_size);
        }
    }
    None
}

/// 対象画像ファイルの完全なメタデータ（プロンプト、解像度、生成パラメータ等）を取得する
/// SQLite キャッシュ DB に存在すればそれを即座にデシリアライズして返し、
/// 未キャッシュの場合はバイナリから PNG/WebP チャンクを直接パースしてキャッシュへ登録する
pub(crate) fn get_full_metadata_for_path(
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
    get_full_metadata_for_path_with_stat(file_path, mtime_millis, ctime_millis, file_size, db_conn)
}

/// 事前に取得した mtime / ctime / ファイルサイズを渡し、ファイルIOを最小限に抑えてメタデータを取得する
pub(crate) fn get_full_metadata_for_path_with_stat(
    file_path: &str,
    mtime_millis: u64,
    ctime_millis: u64,
    file_size: u64,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> (FullMetadata, u64, u64) {
    let (meta, mt, sz, _) = get_full_metadata_for_path_with_stat_inner(file_path, mtime_millis, ctime_millis, file_size, db_conn, true);
    (meta, mt, sz)
}

/// DB書き込みを行わずにメタデータ解析結果と未コミット行（MetadataCacheRow）を返す並列バッチ向けヘルパー
pub(crate) fn get_full_metadata_for_path_compute_only(
    file_path: &str,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> (FullMetadata, Option<MetadataCacheRow>) {
    let (mtime_millis, ctime_millis, file_size) = std::fs::metadata(file_path)
        .map(|m| {
            let mt = m.modified().unwrap_or(std::time::UNIX_EPOCH).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            let ct = m.created().unwrap_or(std::time::UNIX_EPOCH).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            let s = m.len();
            (mt, ct, s)
        })
        .unwrap_or((0, 0, 0));
    let (meta, _, _, row) = get_full_metadata_for_path_with_stat_inner(
        file_path,
        mtime_millis,
        ctime_millis,
        file_size,
        db_conn,
        false,
    );
    (meta, row)
}

/// 複数の新規解析メタデータ行を単一のSQLiteトランザクションで一括保存する。
/// 並列解析スレッドからの個別オートコミットによるWriterロック競合を排除する。
pub(crate) fn commit_pending_metadata_batch(
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pending_rows: &[MetadataCacheRow],
) -> Result<usize, rusqlite::Error> {
    if pending_rows.is_empty() {
        return Ok(0);
    }
    let mut conn = db_conn.get().map_err(|_| rusqlite::Error::InvalidQuery)?;
    if pending_rows.len() == 1 {
        let r = &pending_rows[0];
        conn.execute(
            "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, searchable_prompt, searchable_negative_prompt, searchable_source, metadata_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET metadata=excluded.metadata, width=excluded.width, height=excluded.height, path=excluded.path, size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, last_accessed=excluded.last_accessed, searchable_prompt=excluded.searchable_prompt, searchable_negative_prompt=excluded.searchable_negative_prompt, searchable_source=excluded.searchable_source, metadata_source=excluded.metadata_source",
            rusqlite::params![
                &r.hash_key,
                &r.json_str,
                r.width,
                r.height,
                &r.path,
                r.file_size,
                r.mtime,
                r.ctime,
                r.now,
                &r.sp,
                &r.snp,
                &r.ss,
                &r.metadata_source,
            ],
        )?;
        return Ok(1);
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, searchable_prompt, searchable_negative_prompt, searchable_source, metadata_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET metadata=excluded.metadata, width=excluded.width, height=excluded.height, path=excluded.path, size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, last_accessed=excluded.last_accessed, searchable_prompt=excluded.searchable_prompt, searchable_negative_prompt=excluded.searchable_negative_prompt, searchable_source=excluded.searchable_source, metadata_source=excluded.metadata_source",
        )?;
        for r in pending_rows {
            stmt.execute(rusqlite::params![
                &r.hash_key,
                &r.json_str,
                r.width,
                r.height,
                &r.path,
                r.file_size,
                r.mtime,
                r.ctime,
                r.now,
                &r.sp,
                &r.snp,
                &r.ss,
                &r.metadata_source,
            ])?;
        }
    }
    tx.commit()?;
    Ok(pending_rows.len())
}

/// Stealth 抽出仕様バージョン。抽出ロジック・対応仕様を変更した場合はこの値をインクリメントして過去キャッシュを自己修復させる。
pub(crate) const STEALTH_SCHEMA_VERSION: u64 = 1;
/// JPEG メタデータ抽出仕様バージョン（COMセグメント・JSON直接検出対応）。過去キャッシュを自己修復させる。
pub(crate) const JPEG_SCHEMA_VERSION: u64 = 1;

pub(crate) fn get_full_metadata_for_path_with_stat_inner(
    file_path: &str,
    mtime_millis: u64,
    ctime_millis: u64,
    file_size: u64,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    auto_save: bool,
) -> (FullMetadata, u64, u64, Option<MetadataCacheRow>) {
    // mtime または file_size が未取得（0）の場合のみ実ファイルからミリ秒単位の stat を補完する
    let (mtime_millis, ctime_millis, file_size) = if mtime_millis == 0 || file_size == 0 {
        std::fs::metadata(file_path)
            .map(|m| {
                let mt = m
                    .modified()
                    .unwrap_or(std::time::UNIX_EPOCH)
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let ct = m
                    .created()
                    .unwrap_or(std::time::UNIX_EPOCH)
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let s = m.len();
                (
                    if mtime_millis == 0 { mt } else { mtime_millis },
                    if ctime_millis == 0 { ct } else { ctime_millis },
                    if file_size == 0 { s } else { file_size },
                )
            })
            .unwrap_or((mtime_millis, ctime_millis, file_size))
    } else {
        (mtime_millis, ctime_millis, file_size)
    };

    let hash_key = crate::utils::hash_path_mtime_hex(file_path, mtime_millis);

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
                        // DBに情報ソースが保存されている場合はキャッシュから即座に返却
                        // 新しい統一形式（PNG Chunks, Alpha Channel, WebP EXIF, JPEG EXIF, None）以外（過去データ等）の場合は
                        // 早期リターンせず、最新の仕様で再解析を行ってDBを更新・保存する
                        let is_valid_source = matches!(
                            cached_meta.metadata_source.as_str(),
                            "PNG Chunks" | "Alpha Channel" | "WebP EXIF" | "JPEG EXIF" | "Audio Tags" | "None"
                        );
                        let lower_path = file_path.to_lowercase();
                        let can_have_alpha_stealth = lower_path.ends_with(".png") || lower_path.ends_with(".webp");
                        // 過去の解析でアルファチャンネルからの抽出に失敗し "None" かつプロンプト空でキャッシュされた場合、
                        // 最新のデコード仕様で再抽出を試みるため早期リターンをスキップ（セルフヒーリング）
                        let needs_stealth_retry = cached_meta.metadata_source == "None"
                            && cached_meta.prompt.is_empty()
                            && can_have_alpha_stealth
                            && cached_meta.params.get("stealthSchema").and_then(|v| v.as_u64()) != Some(STEALTH_SCHEMA_VERSION);
                        // 過去の解析で JPEG のプロンプト（COMセグメント・JSON直接検出等）の抽出が空のままキャッシュされた場合、
                        // 最新の抽出仕様で再抽出を試みるため早期リターンをスキップ（セルフヒーリング）
                        let is_jpeg = lower_path.ends_with(".jpg") || lower_path.ends_with(".jpeg");
                        let needs_jpeg_retry = is_jpeg
                            && cached_meta.prompt.is_empty()
                            && cached_meta.params.get("jpegSchema").and_then(|v| v.as_u64()) != Some(JPEG_SCHEMA_VERSION);
                        // 旧バージョンの音声タグ解析（拡張タグ・TXXX 未対応時）のキャッシュをオンデマンドで最新化する
                        let needs_audio_reparse = crate::audio::is_audio_path(file_path)
                            && cached_meta.params.get("tagSchema").and_then(|v| v.as_u64()) != Some(2);
                        if is_valid_source && !needs_stealth_retry && !needs_jpeg_retry && !needs_audio_reparse {
                            return (cached_meta, mtime_millis, file_size, None);
                        }
                    }
                }
            }
        }
    }

    if crate::audio::is_audio_path(file_path) {
        let meta = build_audio_full_metadata(file_path);
        let row = build_metadata_cache_row(
            file_path,
            file_size,
            mtime_millis,
            ctime_millis,
            &meta,
        );
        save_metadata_cache_row_if_needed(auto_save, &row, db_conn);
        return (meta, mtime_millis, file_size, row);
    }

    let lower_path = file_path.to_lowercase();
    let is_png = lower_path.ends_with(".png");
    let mut png_color_type = 0u8;
    let mut detected_source = String::new();
    let (raw_description, mut raw_comment, raw_parameters, mut source, width, height): (String, String, String, String, u32, u32) = if is_png {
        let (chunks, _chunk_types, w, h, ct) = parse_png_chunks_with_dimensions_and_types(file_path);
        png_color_type = ct;
        let desc = chunks
            .get("Description")
            .or(chunks.get("ImageDescription"))
            .cloned()
            .unwrap_or_default();
        let mut comment = chunks.get("Comment").cloned().unwrap_or_default();
        let mut params = chunks
            .get("parameters")
            .or(chunks.get("Parameters"))
            .cloned()
            .unwrap_or_default();
        let src = chunks
            .get("Source")
            .or(chunks.get("Software"))
            .cloned()
            .unwrap_or_default();

        let mut has_chunk_metadata = false;

        if !comment.trim().is_empty() || !params.trim().is_empty() {
            has_chunk_metadata = true;
        }

        // ComfyUI metadata fallback
        if let Some(workflow) = chunks.get("workflow") {
            if comment.is_empty() {
                comment = workflow.clone();
                has_chunk_metadata = true;
            } else if params.is_empty() {
                params = workflow.clone();
            }
        } else if let Some(prompt_json) = chunks.get("prompt") {
            if comment.is_empty() {
                comment = prompt_json.clone();
                has_chunk_metadata = true;
            } else if params.is_empty() {
                params = prompt_json.clone();
            }
        }

        if !desc.trim().is_empty() {
            has_chunk_metadata = true;
        }

        if has_chunk_metadata {
            detected_source = "PNG Chunks".to_string();
        }

        (desc, comment, params, src, w, h)
    } else {
        let (mut w, mut h) = image::image_dimensions(file_path).unwrap_or((0, 0));
        if w == 0 && h == 0 && lower_path.ends_with(".mp4") {
            if let Some((vw, vh)) = parse_mp4_dimensions(file_path) {
                w = vw;
                h = vh;
            }
        }

        let is_webp = lower_path.ends_with(".webp");
        let exif_data = if is_webp {
            parse_webp_exif(file_path)
        } else {
            parse_jpeg_exif(file_path)
        };

        let mut desc = String::new();
        let mut comment = String::new();
        let mut src = String::new();

        if let Some(d) = exif_data.get("ImageDescription") {
            desc = decode_metadata_string(d)
                .trim_end_matches('\0')
                .to_string();
        }
        if let Some(c) = exif_data.get("UserComment") {
            let mut content = c.as_slice();
            if content.starts_with(b"UNICODE\0") || content.starts_with(b"ASCII\0\0\0") {
                content = &content[8..];
            }
            comment = decode_metadata_string(content)
                .trim_end_matches('\0')
                .trim()
                .to_string();
        }
        if let Some(c) = exif_data.get("Comment") {
            let com_str = decode_metadata_string(c)
                .trim_end_matches('\0')
                .trim()
                .to_string();
            if !com_str.is_empty() {
                if comment.is_empty() {
                    comment = com_str;
                } else if !comment.contains(&com_str) {
                    comment.push_str("\n");
                    comment.push_str(&com_str);
                }
            }
        }
        if let Some(sw) = exif_data.get("Software") {
            src = decode_metadata_string(sw)
                .trim_end_matches('\0')
                .to_string();
        }
        if let Some(make) = exif_data.get("Make") {
            let make_str = decode_metadata_string(make)
                .trim_end_matches('\0')
                .trim()
                .to_string();
            if !make_str.is_empty() {
                if !comment.is_empty() {
                    comment.push_str("\n");
                }
                comment.push_str(&make_str);
            }
        }

        let is_jpeg = lower_path.ends_with(".jpg") || lower_path.ends_with(".jpeg");
        if is_jpeg && !comment.contains('{') && !desc.contains('{') {
            if let Ok(file) = std::fs::File::open(file_path) {
                if let Ok(mmap) = unsafe { memmap2::MmapOptions::new().map(&file) } {
                    let buf = &mmap[..];
                    let search_limit = std::cmp::min(buf.len(), 2 * 1024 * 1024);
                    let search_buf = &buf[..search_limit];
                    if let Some(pos) = search_buf.windows(9).position(|w| w == b"{\"prompt\"" || w == b"{\"v4_pro") {
                        let candidate_bytes = &search_buf[pos..];
                        let candidate_str = decode_metadata_string(candidate_bytes);
                        if comment.is_empty() {
                            comment = candidate_str;
                        } else {
                            comment.push('\n');
                            comment.push_str(&candidate_str);
                        }
                    }
                }
            }
        }

        let prefix = if is_webp { "WebP" } else { "JPEG" };
        if !comment.trim().is_empty() || !desc.trim().is_empty() {
            detected_source = format!("{} EXIF", prefix);
        }

        (desc, comment, String::new(), src, w, h)
    };

    // EXIF等でプロンプトが見つからなかった場合、またはWebP等のEXIFに単なるソフトウェア名等（非JSONテキスト）しか含まれず
    // プロンプトが未取得の場合、Stealthメタデータ（アルファチャンネル）を試行
    // PNGの場合、アルファチャンネルを持たないカラータイプ（RGB=2, Grayscale=0, Palette=3等）は
    // アルファ最下位ビットを使用するStealth PNGInfoが存在し得ないため、フルデコードを完全スキップ
    let needs_stealth = (raw_comment.trim().is_empty() && raw_description.trim().is_empty())
        || (!raw_comment.contains('{') && !raw_description.contains('{') && !raw_parameters.contains('{'));

    if needs_stealth {
        let can_have_stealth = if is_png {
            png_color_type == 6 || png_color_type == 4
        } else {
            lower_path.ends_with(".webp")
        };

        if can_have_stealth {
            if let Some((stealth, _)) = extract_stealth_pnginfo_with_type(file_path) {
                raw_comment = stealth;
                detected_source = "Alpha Channel".to_string();
            }
        }
    }

    let metadata_source = if !detected_source.is_empty() {
        detected_source
    } else {
        "None".to_string()
    };

    let mut prompt = raw_description.clone();
    let mut negative_prompt = String::new();
    let mut params = serde_json::Value::Object(serde_json::Map::new());
    let comment_string = raw_comment.trim();

    let desc_string = raw_description.trim();
    let target_strings = [comment_string, desc_string];
    let mut extracted_jsons: Vec<serde_json::Value> = Vec::new();

    for s in target_strings.iter() {
        let mut idx = 0;
        while idx < s.len() {
            if let Some(start) = s[idx..].find('{').map(|i| idx + i) {
                let candidate_str = &s[start..];
                let mut iter = serde_json::Deserializer::from_str(candidate_str).into_iter::<serde_json::Value>();
                if let Some(Ok(parsed)) = iter.next() {
                    extracted_jsons.push(parsed);
                    idx = start + iter.byte_offset();
                    continue;
                }
                idx = start + 1;
            } else {
                break;
            }
        }
    }

    if !extracted_jsons.is_empty() {
        let mut merged_map = serde_json::Map::new();
        for obj in extracted_jsons {
            if let serde_json::Value::Object(mut map) = obj {
                if map.len() == 1 {
                    if let Some(gen_data) = map.remove("generation_data") {
                        if let serde_json::Value::Object(gen_map) = gen_data {
                            for (k, v) in gen_map {
                                merged_map.insert(k, v);
                            }
                            continue;
                        } else {
                            merged_map.insert("generation_data".to_string(), gen_data);
                            continue;
                        }
                    }
                }
                for (k, v) in map {
                    merged_map.insert(k, v);
                }
            }
        }
        let mut comment_obj = serde_json::Value::Object(merged_map);
        {
            let _ = 1; // Dummy block to match the original indentation level!
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

            // 通常のJSON直下のSource / model_name / model も取得
            if json_source.is_none() {
                if let Some(s) = comment_obj.get("Source").and_then(|v| v.as_str()) {
                    json_source = Some(s.to_string());
                } else if let Some(m) = comment_obj.get("model_name").and_then(|v| v.as_str()) {
                    json_source = Some(m.to_string());
                } else if let Some(m) = comment_obj.get("model").and_then(|v| v.as_str()) {
                    json_source = Some(m.to_string());
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

            let actual_prompts_obj = comment_obj.get("actual_prompts").cloned();

            // 1. ベースプロンプト (prompt) の抽出と採用プロンプト (adoptedPrompt) 判定
            let ap_prompt_base = actual_prompts_obj.as_ref().and_then(|ap| {
                ap.pointer("/prompt/base_caption").and_then(|v| v.as_str())
                    .or_else(|| ap.get("prompt").and_then(|v| v.as_str()))
            });
            let comment_prompt = comment_obj.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());

            if prompt.is_empty() {
                if let Some(p) = comment_prompt.as_deref().or(ap_prompt_base) {
                    prompt = p.to_string();
                }
            }

            let candidate_adopted_prompt = ap_prompt_base.map(|s| s.to_string())
                .or_else(|| comment_prompt.clone());
            if let Some(cp) = candidate_adopted_prompt {
                let is_different = prompt.trim() != cp.trim() || prompt.contains("||");
                if is_different {
                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        map.insert("adoptedPrompt".to_string(), serde_json::Value::String(cp.clone()));
                        map.insert("adopted_prompt".to_string(), serde_json::Value::String(cp));
                    }
                } else if let serde_json::Value::Object(ref mut map) = comment_obj {
                    map.remove("prompt");
                }
            }

            // 2. ベース除外要素 (negative_prompt / uc) の抽出と採用除外要素 (adoptedNegativePrompt) 判定
            let ap_uc_base = actual_prompts_obj.as_ref().and_then(|ap| {
                ap.pointer("/negative_prompt/base_caption").and_then(|v| v.as_str())
                    .or_else(|| ap.get("negative_prompt").and_then(|v| v.as_str()))
            });
            let candidate_adopted_uc = ap_uc_base.map(|s| s.to_string());
            if let Some(auc) = candidate_adopted_uc {
                let is_different = negative_prompt.trim() != auc.trim() || negative_prompt.contains("||");
                if is_different {
                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        map.insert("adoptedNegativePrompt".to_string(), serde_json::Value::String(auc.clone()));
                        map.insert("adopted_negative_prompt".to_string(), serde_json::Value::String(auc));
                    }
                }
            }

            // 3. NovelAI V4プロンプト対応
            if let Some(v4_prompt) = comment_obj.get("v4_prompt").cloned() {
                // base_caption による採用プロンプト補完
                if let Some(base_cap) = v4_prompt.pointer("/caption/base_caption").and_then(|v| v.as_str()) {
                    if prompt.is_empty() {
                        prompt = base_cap.to_string();
                    } else if (prompt.trim() != base_cap.trim() || prompt.contains("||")) && comment_obj.get("adoptedPrompt").is_none() {
                        if let serde_json::Value::Object(ref mut map) = comment_obj {
                            map.insert("adoptedPrompt".to_string(), serde_json::Value::String(base_cap.to_string()));
                            map.insert("adopted_prompt".to_string(), serde_json::Value::String(base_cap.to_string()));
                        }
                    }
                }
                let v4_use_coords = v4_prompt.get("use_coords").and_then(|v| v.as_bool());
                if let Some(char_captions) = v4_prompt
                    .pointer("/caption/char_captions")
                    .and_then(|v| v.as_array())
                {
                    let mut char_prompts_arr = Vec::new();
                    let ucs = comment_obj
                        .pointer("/v4_negative_prompt/caption/char_captions")
                        .and_then(|v| v.as_array());

                    let ap_char_prompts = actual_prompts_obj.as_ref()
                        .and_then(|ap| ap.pointer("/prompt/char_captions"))
                        .and_then(|v| v.as_array());
                    let ap_char_ucs = actual_prompts_obj.as_ref()
                        .and_then(|ap| ap.pointer("/negative_prompt/char_captions"))
                        .and_then(|v| v.as_array());

                    for (i, p) in char_captions.iter().enumerate() {
                        let mut char_obj = serde_json::Map::new();
                        let cap_str = p.get("char_caption").and_then(|v| v.as_str()).unwrap_or_default();
                        char_obj.insert(
                            "prompt".to_string(),
                            serde_json::Value::String(cap_str.to_string()),
                        );

                        // キャラクター採用プロンプト判定
                        if let Some(ap_char_item) = ap_char_prompts.and_then(|arr| arr.get(i)) {
                            if let Some(ap_cap) = ap_char_item.get("char_caption").and_then(|v| v.as_str()) {
                                if cap_str.trim() != ap_cap.trim() || cap_str.contains("||") {
                                    char_obj.insert("adoptedPrompt".to_string(), serde_json::Value::String(ap_cap.to_string()));
                                    char_obj.insert("adopted_prompt".to_string(), serde_json::Value::String(ap_cap.to_string()));
                                }
                            }
                        }

                        let mut uc_str = "";
                        if let Some(uc_arr) = ucs {
                            if let Some(uc_item) = uc_arr.get(i) {
                                if let Some(uc_cap) =
                                    uc_item.get("char_caption").and_then(|v| v.as_str())
                                {
                                    uc_str = uc_cap;
                                    char_obj.insert(
                                        "uc".to_string(),
                                        serde_json::Value::String(uc_cap.to_string()),
                                    );
                                }
                            }
                        }

                        // キャラクター採用除外要素判定
                        if let Some(ap_uc_item) = ap_char_ucs.and_then(|arr| arr.get(i)) {
                            if let Some(ap_uc_cap) = ap_uc_item.get("char_caption").and_then(|v| v.as_str()) {
                                if uc_str.trim() != ap_uc_cap.trim() || uc_str.contains("||") {
                                    char_obj.insert("adoptedUc".to_string(), serde_json::Value::String(ap_uc_cap.to_string()));
                                    char_obj.insert("adopted_uc".to_string(), serde_json::Value::String(ap_uc_cap.to_string()));
                                }
                            }
                        }

                        // キャラクター位置座標 (centers / center) の抽出
                        if let Some(centers) = p.get("centers") {
                            char_obj.insert("centers".to_string(), centers.clone());
                        } else if let Some(center) = p.get("center") {
                            char_obj.insert(
                                "centers".to_string(),
                                serde_json::Value::Array(vec![center.clone()]),
                            );
                        }
                        char_prompts_arr.push(serde_json::Value::Object(char_obj));
                    }

                    if let serde_json::Value::Object(ref mut map) = comment_obj {
                        map.insert(
                            "characterPrompts".to_string(),
                            serde_json::Value::Array(char_prompts_arr),
                        );
                        if let Some(use_coords) = v4_use_coords {
                            map.insert("use_coords".to_string(), serde_json::Value::Bool(use_coords));
                        }
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

    let is_png_or_webp = lower_path.ends_with(".png") || lower_path.ends_with(".webp");
    if is_png_or_webp && metadata_source == "None" && prompt.trim().is_empty() {
        if let serde_json::Value::Object(ref mut map) = params {
            map.insert("stealthSchema".to_string(), serde_json::json!(STEALTH_SCHEMA_VERSION));
        }
    }

    let is_jpeg = lower_path.ends_with(".jpg") || lower_path.ends_with(".jpeg");
    if is_jpeg {
        if let serde_json::Value::Object(ref mut map) = params {
            map.insert("jpegSchema".to_string(), serde_json::json!(JPEG_SCHEMA_VERSION));
        }
    }

    let meta = FullMetadata {
        path: file_path.to_string(),
        prompt,
        negative_prompt,
        width,
        height,
        params,
        source: source.clone(),
        metadata_source: metadata_source.clone(),
    };

    let row = build_metadata_cache_row(
        file_path,
        file_size,
        mtime_millis,
        ctime_millis,
        &meta,
    );

    save_metadata_cache_row_if_needed(auto_save, &row, db_conn);

    (meta, mtime_millis, file_size, row)
}

/// 音声ファイル向けの FullMetadata を構築する（タグなし・破損時は metadata_source="None" で安全継続）
pub(crate) fn build_audio_full_metadata(file_path: &str) -> FullMetadata {
    let audio_meta = crate::audio::parse_audio_metadata(file_path);
    let mut map = serde_json::Map::new();
    let mut insert_opt = |key: &str, val: Option<&String>| {
        if let Some(s) = val {
            map.insert(key.to_string(), serde_json::Value::String(s.clone()));
        }
    };
    insert_opt("title", audio_meta.title.as_ref());
    insert_opt("artist", audio_meta.artist.as_ref());
    insert_opt("album", audio_meta.album.as_ref());
    insert_opt("lyrics", audio_meta.lyrics.as_ref());
    insert_opt("comment", audio_meta.comment.as_ref());
    insert_opt("recordingDate", audio_meta.recording_date.as_ref());
    map.insert("tagSchema".to_string(), serde_json::json!(2));
    if let Some(dur) = audio_meta.duration_secs {
        map.insert("durationSecs".to_string(), serde_json::json!(dur));
        map.insert(
            "duration".to_string(),
            serde_json::Value::String(crate::audio::format_duration(dur)),
        );
    }

    let metadata_source = if audio_meta.has_tags {
        "Audio Tags".to_string()
    } else {
        "None".to_string()
    };

    let (width, height) = audio_meta
        .cover_bytes
        .as_deref()
        .and_then(|bytes| {
            image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .ok()
                .and_then(|r| r.into_dimensions().ok())
        })
        .unwrap_or((0, 0));

    FullMetadata {
        path: file_path.to_string(),
        prompt: String::new(),
        negative_prompt: String::new(),
        width,
        height,
        params: serde_json::Value::Object(map),
        source: String::new(),
        metadata_source,
    }
}

/// 解析済みメタデータ行を必要に応じて SQLite キャッシュへ UPSERT する
pub(crate) fn save_metadata_cache_row_if_needed(
    auto_save: bool,
    row: &Option<MetadataCacheRow>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) {
    if !auto_save {
        return;
    }
    if let Some(ref r) = row {
        if let Ok(conn) = db_conn.get() {
            let _ = conn.execute(
                "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, searchable_prompt, searchable_negative_prompt, searchable_source, metadata_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(hash_key) DO UPDATE SET metadata=excluded.metadata, width=excluded.width, height=excluded.height, path=excluded.path, size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, last_accessed=excluded.last_accessed, searchable_prompt=excluded.searchable_prompt, searchable_negative_prompt=excluded.searchable_negative_prompt, searchable_source=excluded.searchable_source, metadata_source=excluded.metadata_source",
                rusqlite::params![&r.hash_key, &r.json_str, r.width, r.height, &r.path, r.file_size, r.mtime, r.ctime, r.now, &r.sp, &r.snp, &r.ss, &r.metadata_source]
            );
        }
    }
}

pub(crate) struct MetadataCacheRow {
    pub(crate) hash_key: String,
    pub(crate) json_str: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) path: String,
    pub(crate) file_size: u64,
    pub(crate) mtime: u64,
    pub(crate) ctime: u64,
    pub(crate) now: i64,
    pub(crate) sp: String,
    pub(crate) snp: String,
    pub(crate) ss: String,
    pub(crate) metadata_source: String,
}

pub(crate) fn build_metadata_cache_row(
    file_path: &str,
    file_size: u64,
    mtime: u64,
    ctime: u64,
    meta: &FullMetadata,
) -> Option<MetadataCacheRow> {
    if let Ok(json_str) = serde_json::to_string(&meta) {
        let (sp, snp, ss) = extract_searchable_strings(&meta);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let hash_key = crate::utils::hash_path_mtime_hex(file_path, mtime);

        Some(MetadataCacheRow {
            hash_key,
            json_str,
            width: meta.width,
            height: meta.height,
            path: meta.path.clone(),
            file_size,
            mtime,
            ctime,
            now,
            sp,
            snp,
            ss,
            metadata_source: meta.metadata_source.clone(),
        })
    } else {
        None
    }
}

pub(crate) fn parse_png_chunks_with_dimensions_and_types(
    path: &str,
) -> (
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, &'static str>,
    u32,
    u32,
    u8,
) {
    let mut chunks = std::collections::HashMap::new();
    let mut chunk_types = std::collections::HashMap::new();
    let mut width = 0;
    let mut height = 0;
    let mut color_type = 0u8;
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(mmap) = unsafe { memmap2::MmapOptions::new().map(&file) } {
            let buffer = &mmap[..];
            if buffer.len() >= 8 && buffer[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
                let mut offset = 8;
                while offset + 8 <= buffer.len() {
                    let len = u32::from_be_bytes(
                        buffer[offset..offset + 4]
                            .try_into()
                            .unwrap_or_default(),
                    ) as usize;
                    if len > 100_000_000 || offset + 8 + len + 4 > buffer.len() {
                        break;
                    }

                    let chunk_type = &buffer[offset + 4..offset + 8];
                    let data = &buffer[offset + 8..offset + 8 + len];

                    if chunk_type == b"IHDR" && len >= 8 {
                        width = u32::from_be_bytes(data[0..4].try_into().unwrap_or_default());
                        height = u32::from_be_bytes(data[4..8].try_into().unwrap_or_default());
                        if len >= 10 {
                            color_type = data[9];
                        }
                    } else if chunk_type == b"tEXt" {
                        if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                            let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                            let text = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                            chunk_types.insert(keyword.clone(), "tEXt");
                            chunks.insert(keyword, text);
                        }
                    } else if chunk_type == b"zTXt" {
                        if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                            let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                            if null_idx + 2 <= data.len() && data[null_idx + 1] == 0 {
                                use std::io::Read;
                                let compressed_data = &data[null_idx + 2..];
                                let decoder = flate2::read::ZlibDecoder::new(compressed_data);
                                let mut limited = decoder.take(10 * 1024 * 1024);
                                let mut decompressed = Vec::new();
                                if limited.read_to_end(&mut decompressed).is_ok() && !decompressed.is_empty() {
                                    let text = String::from_utf8_lossy(&decompressed).to_string();
                                    chunk_types.insert(keyword.clone(), "zTXt");
                                    chunks.insert(keyword, text);
                                }
                            }
                        }
                    } else if chunk_type == b"iTXt" {
                        if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                            let keyword = String::from_utf8_lossy(&data[..null_idx]).to_string();
                            let mut off = null_idx + 1;
                            if off + 2 <= data.len() {
                                 let comp_flag = data[off];
                                off += 2;
                                if let Some(n1) = data[off..].iter().position(|&b| b == 0) {
                                    off += n1 + 1; // skip lang tag
                                    if let Some(n2) = data[off..].iter().position(|&b| b == 0) {
                                        off += n2 + 1; // skip trans keyword
                                        let text_data = &data[off..];
                                        let text = if comp_flag == 1 {
                                            use std::io::Read;
                                            let decoder = flate2::read::ZlibDecoder::new(text_data);
                                            let mut limited = decoder.take(10 * 1024 * 1024);
                                            let mut s = String::new();
                                            limited.read_to_string(&mut s).unwrap_or_default();
                                            s
                                        } else {
                                            String::from_utf8_lossy(text_data).to_string()
                                        };
                                        chunk_types.insert(keyword.clone(), "iTXt");
                                        chunks.insert(keyword, text);
                                    }
                                }
                            }
                        }
                    } else if chunk_type == b"IEND" {
                        break;
                    }

                    offset += 8 + len + 4; // 4 (len) + 4 (type) + len (data) + 4 (crc)
                }
            }
        }
    }
    (chunks, chunk_types, width, height, color_type)
}

pub(crate) fn parse_png_chunks_with_dimensions(path: &str) -> (std::collections::HashMap<String, String>, u32, u32, u8) {
    let (chunks, _, width, height, color_type) = parse_png_chunks_with_dimensions_and_types(path);
    (chunks, width, height, color_type)
}

#[allow(dead_code)]
pub(crate) fn parse_png_chunks(path: &str) -> std::collections::HashMap<String, String> {
    parse_png_chunks_with_dimensions(path).0
}

/// PNGファイルの先頭24バイト（シグネチャ8B + IHDRチャンクヘッダ8B + 幅4B・高さ4B）のみを
/// スタックバッファに読み取り、全チャンク走査やテキスト解凍を行わずに寸法を取得する。
pub(crate) fn read_png_dimensions_fast(path: &str) -> (u32, u32) {
    use std::io::Read;
    if let Ok(mut file) = std::fs::File::open(path) {
        let mut header = [0u8; 24];
        if file.read_exact(&mut header).is_ok() {
            if &header[0..8] == &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
                && &header[12..16] == b"IHDR"
            {
                let w = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);
                let h = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);
                if w > 0 && h > 0 {
                    return (w, h);
                }
            }
        }
    }
    image::image_dimensions(path).unwrap_or((0, 0))
}

/// 画像・動画ファイルから軽量ヘッダー解析によりミリ秒未満で寸法(width, height)を取得する
pub(crate) fn get_fast_dimensions_for_file(path: &str, ext_lower: &str) -> (u32, u32) {
    if crate::audio::is_audio_extension(ext_lower) {
        (0, 0)
    } else if ext_lower == "png" {
        read_png_dimensions_fast(path)
    } else if ext_lower == "mp4" {
        parse_mp4_dimensions(path).unwrap_or((0, 0))
    } else {
        image::image_dimensions(path).unwrap_or((0, 0))
    }
}

pub(crate) fn parse_tiff_ifd(exif_data: &[u8]) -> std::collections::HashMap<String, Vec<u8>> {
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
                } else if tag == 0x010F && typ == 2 {
                    // Make
                    results.insert("Make".to_string(), data[..byte_count].to_vec());
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

/// 8bit PNG を `zune_png::PngDecoder` でデコードし、`image::open().into_rgba8()` と同一の
/// RGBA8 連続バッファ（幅・高さ・`width * height * 4` バイト）として返す。
/// 非対応カラー空間やデコード失敗時は `None` を返し、呼び出し元で `image::open` へフォールバックさせる。
pub(crate) fn decode_png_rgba8_with_zune(path: &str) -> Option<(usize, usize, Vec<u8>)> {
    let file_bytes = std::fs::read(path).ok()?;
    let options = zune_core::options::DecoderOptions::default().png_set_strip_to_8bit(true);
    let mut decoder = zune_png::PngDecoder::new_with_options(&file_bytes, options);
    let raw_pixels = decoder.decode_raw().ok()?;
    let (width, height) = decoder.get_dimensions()?;
    let pixel_count = width.checked_mul(height)?;
    let expected_rgba_len = pixel_count.checked_mul(4)?;

    match decoder.get_colorspace() {
        Some(zune_core::colorspace::ColorSpace::RGBA) => {
            if raw_pixels.len() == expected_rgba_len {
                Some((width, height, raw_pixels))
            } else {
                None
            }
        }
        Some(zune_core::colorspace::ColorSpace::LumaA) => {
            if raw_pixels.len() == pixel_count.checked_mul(2)? {
                let mut rgba = Vec::with_capacity(expected_rgba_len);
                for px in raw_pixels.chunks_exact(2) {
                    rgba.push(px[0]);
                    rgba.push(px[0]);
                    rgba.push(px[0]);
                    rgba.push(px[1]);
                }
                Some((width, height, rgba))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(crate) fn extract_stealth_pnginfo_with_type(path: &str) -> Option<(String, &'static str)> {
    let lower_path = path.to_lowercase();
    let is_png = lower_path.ends_with(".png");
    let is_webp = lower_path.ends_with(".webp");
    if !is_png && !is_webp {
        return None;
    }

    // 1. PNGヘッダーの事前検査:
    // IHDRチャンクの bit_depth と color_type を先頭30バイトのみ読み込んで判定。
    // アルファチャンネルを持たないカラータイプ（RGB=2, Grayscale=0, Palette=3等）は
    // Stealth PNGInfoの埋め込み対象外のため、フルデコードを即座にスキップする。
    let mut png_is_8bit = false;
    if is_png {
        if let Ok(mut file) = std::fs::File::open(path) {
            use std::io::Read;
            let mut header = [0u8; 30];
            if let Ok(n) = file.read(&mut header) {
                if n >= 26 && &header[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
                    if &header[12..16] == b"IHDR" {
                        let bit_depth = header[24];
                        let color_type = header[25];
                        if color_type != 6 && color_type != 4 {
                            return None;
                        }
                        png_is_8bit = bit_depth == 8;
                    }
                }
            }
        }
    }

    // 2. WebPヘッダーの事前検査:
    // RIFFチャンクヘッダーを読み込み、アルファチャンネルを持たないVP8 lossy画像やアルファフラグのないVP8Xを除外
    if is_webp {
        if let Ok(mut file) = std::fs::File::open(path) {
            use std::io::Read;
            let mut header = [0u8; 25];
            if let Ok(n) = file.read(&mut header) {
                if n >= 16 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
                    let chunk_type = &header[12..16];
                    if chunk_type == b"VP8 " {
                        return None;
                    } else if chunk_type == b"VP8X" && n >= 21 {
                        let flags = header[20];
                        if (flags & 0x10) == 0 {
                            return None;
                        }
                    }
                }
            }
        }
    }

    use flate2::read::GzDecoder;
    use std::io::Read;

    // 8bit PNG の場合は SIMD 最適化された zune-png を優先し、失敗時および非 8bit PNG / WebP は image::open へフォールバック
    let (width, height, raw) = if is_png && png_is_8bit {
        if let Some(decoded) = decode_png_rgba8_with_zune(path) {
            decoded
        } else {
            let img = image::open(path).ok()?.into_rgba8();
            let w = img.width() as usize;
            let h = img.height() as usize;
            (w, h, img.into_raw())
        }
    } else {
        let img = image::open(path).ok()?.into_rgba8();
        let w = img.width() as usize;
        let h = img.height() as usize;
        (w, h, img.into_raw())
    };
    let total_pixels = width * height;

    // 署名（15バイト）+ 長さ（4バイト）= 19バイト = 152ビット
    if total_pixels < 152 || raw.len() < total_pixels * 4 {
        return None;
    }

    // 1. 先頭19バイト（152ピクセル）を走査してシグネチャを早期判定
    // 通常のプロンプトなし画像の場合、全画素の走査ループと巨大ベクタ割り当てを完全にスキップ
    let mut header_bytes = [0u8; 19];
    let mut bit_idx = 0;
    'header_loop: for x in 0..width {
        for y in 0..height {
            let idx = (y * width + x) * 4 + 3;
            let bit = raw[idx] & 1;
            let byte_pos = bit_idx / 8;
            let bit_pos = 7 - (bit_idx % 8);
            header_bytes[byte_pos] |= bit << bit_pos;
            bit_idx += 1;
            if bit_idx >= 152 {
                break 'header_loop;
            }
        }
    }

    let is_comp = &header_bytes[0..15] == b"stealth_pngcomp";
    let is_raw = &header_bytes[0..15] == b"stealth_pnginfo";
    if !is_comp && !is_raw {
        // 通常の画像は即座に早期リターン
        return None;
    }

    // 2. ペイロード長を取得し、必要なビット数のみを走査
    let len_bytes: [u8; 4] = header_bytes[15..19].try_into().ok()?;
    let raw_length = u32::from_be_bytes(len_bytes) as usize;

    // ヘルパー: 指定されたペイロードビット長に基づきLSBを走査してデコードを試行
    // （末尾の画像画素ビット混入を排除し、厳密なバイト数で切り出して解凍/UTF-8デコード）
    let try_extract = |payload_bits: usize| -> Option<String> {
        if payload_bits == 0 {
            return None;
        }
        let total_needed_bits = 152 + payload_bits;
        if total_pixels < total_needed_bits {
            return None;
        }

        let target_payload_bytes = (payload_bits + 7) / 8;
        let mut payload_bytes = Vec::with_capacity(target_payload_bytes);

        let mut current_byte = 0u8;
        let mut current_bit_count = 0;
        let mut current_bit_idx = 0;

        'payload_loop: for x in 0..width {
            for y in 0..height {
                if current_bit_idx < 152 {
                    current_bit_idx += 1;
                    continue;
                }
                if current_bit_idx >= total_needed_bits {
                    break 'payload_loop;
                }
                let idx = (y * width + x) * 4 + 3;
                let bit = raw[idx] & 1;
                current_byte |= bit << (7 - current_bit_count);
                current_bit_count += 1;
                current_bit_idx += 1;

                if current_bit_count == 8 {
                    payload_bytes.push(current_byte);
                    current_byte = 0;
                    current_bit_count = 0;
                }
            }
        }

        if current_bit_count > 0 && payload_bytes.len() < target_payload_bytes {
            payload_bytes.push(current_byte);
        }

        if payload_bytes.len() < target_payload_bytes {
            return None;
        }

        if is_comp {
            let decoder = GzDecoder::new(&payload_bytes[..]);
            let mut limited = decoder.take(10 * 1024 * 1024);
            let mut decompressed = String::new();
            if limited.read_to_string(&mut decompressed).is_ok() {
                return Some(decompressed);
            }
        } else if is_raw {
            if let Ok(text) = String::from_utf8(payload_bytes) {
                return Some(text);
            }
        }
        None
    };

    // 案A: Stealth PNGInfo 標準仕様（ヘッダーの長さフィールドはペイロードの「ビット数（bits）」）
    if let Some(text) = try_extract(raw_length) {
        let type_name = if is_comp {
            "Stealth PNGInfo (Compressed)"
        } else {
            "Stealth PNGInfo (Raw)"
        };
        return Some((text, type_name));
    }

    // 案B: 互換性フォールバック（ヘッダーの長さフィールドが「バイト数」で格納されている場合）
    if let Some(bits_from_bytes) = raw_length.checked_mul(8) {
        if bits_from_bytes != raw_length {
            if let Some(text) = try_extract(bits_from_bytes) {
                let type_name = if is_comp {
                    "Stealth PNGInfo (Compressed)"
                } else {
                    "Stealth PNGInfo (Raw)"
                };
                return Some((text, type_name));
            }
        }
    }

    None
}

#[allow(dead_code)]
pub(crate) fn extract_stealth_pnginfo(path: &str) -> Option<String> {
    extract_stealth_pnginfo_with_type(path).map(|(s, _)| s)
}

/// アルファチャンネルのメタデータ領域オーバーレイ生成結果
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct AlphaOverlayResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub header_bytes: usize,
    pub payload_bytes: usize,
    pub total_bytes: usize,
    pub total_pixels: usize,
    pub image_total_pixels: usize,
    pub coverage_percent: f64,
    pub occupied_columns: usize,
}

/// 画像から Stealth PNGInfo のメタデータ領域（列優先走査）を検出し、
/// アルファチャンネルのLSBビット（砂嵐パターン）と元画像を半透明ブレンドした
/// ハイブリッドオーバーレイ画像を生成して返却します。
pub(crate) fn generate_alpha_overlay_image(path: &str) -> Result<AlphaOverlayResult, String> {
    let lower_path = path.to_lowercase();
    let is_png = lower_path.ends_with(".png");
    let is_webp = lower_path.ends_with(".webp");
    if !is_png && !is_webp {
        return Err("Unsupported file format for alpha metadata overlay".into());
    }

    // 1. PNGヘッダーの事前検査
    if is_png {
        if let Ok(mut file) = std::fs::File::open(path) {
            use std::io::Read;
            let mut header = [0u8; 30];
            if let Ok(n) = file.read(&mut header) {
                if n >= 26 && &header[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
                    if &header[12..16] == b"IHDR" {
                        let color_type = header[25];
                        if color_type != 6 && color_type != 4 {
                            return Err("Image does not have an alpha channel".into());
                        }
                    }
                }
            }
        }
    }

    // 2. WebPヘッダーの事前検査
    if is_webp {
        if let Ok(mut file) = std::fs::File::open(path) {
            use std::io::Read;
            let mut header = [0u8; 25];
            if let Ok(n) = file.read(&mut header) {
                if n >= 16 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
                    let chunk_type = &header[12..16];
                    if chunk_type == b"VP8 " {
                        return Err("Image does not have an alpha channel".into());
                    } else if chunk_type == b"VP8X" && n >= 21 {
                        let flags = header[20];
                        if (flags & 0x10) == 0 {
                            return Err("Image does not have an alpha channel".into());
                        }
                    }
                }
            }
        }
    }

    let mut img = image::open(path)
        .map_err(|e| format!("Failed to open image: {}", e))?
        .into_rgba8();

    let width = img.width() as usize;
    let height = img.height() as usize;
    let image_total_pixels = width * height;

    // 署名（15バイト）+ 長さ（4バイト）= 19バイト = 152ビット
    if image_total_pixels < 152 {
        return Err("Image too small for alpha metadata".into());
    }

    let raw: &mut [u8] = img.as_mut();

    // 先頭19バイト（152ピクセル）のシグネチャと長さを早期判定（列優先走査）
    let mut header_bytes = [0u8; 19];
    let mut bit_idx = 0;
    'header_loop: for x in 0..width {
        for y in 0..height {
            let idx = (y * width + x) * 4 + 3;
            let bit = raw[idx] & 1;
            let byte_pos = bit_idx / 8;
            let bit_pos = 7 - (bit_idx % 8);
            header_bytes[byte_pos] |= bit << bit_pos;
            bit_idx += 1;
            if bit_idx >= 152 {
                break 'header_loop;
            }
        }
    }

    let is_comp = &header_bytes[0..15] == b"stealth_pngcomp";
    let is_raw = &header_bytes[0..15] == b"stealth_pnginfo";
    if !is_comp && !is_raw {
        return Err("No stealth metadata signature found in alpha channel".into());
    }

    let len_bytes: [u8; 4] = header_bytes[15..19]
        .try_into()
        .map_err(|_| "Failed to parse payload length".to_string())?;
    let raw_length = u32::from_be_bytes(len_bytes) as usize;

    // Stealth PNGInfo 仕様: ヘッダーの長さフィールドはペイロードの「ビット数（bits）」
    // （※フォーク版等でバイト数で格納されている場合を考慮し、もしビット数が全画素数を大幅に超えるような異常値の場合はバイト数とみなすセーフガードを適用）
    let payload_bits = if raw_length <= image_total_pixels.saturating_sub(152) {
        raw_length
    } else {
        raw_length.checked_mul(8).unwrap_or(raw_length)
    };

    let total_pixels = (152 + payload_bits).min(image_total_pixels);
    let payload_bytes = (payload_bits + 7) / 8;
    let total_bytes = 19 + payload_bytes;

    // 案1（LSB白黒砂嵐）と案2（半透明オーバーレイ）のハイブリッドブレンド:
    // ヘッダー領域（152px）: 赤系半透明（ビット値に応じて明暗差）
    // ペイロード領域（total_pixelsまで）: アルファLSBのビット値に応じた白黒砂嵐を元画像に半透明ブレンド
    let mut current_pixel_idx = 0;
    'overlay_loop: for x in 0..width {
        for y in 0..height {
            if current_pixel_idx >= total_pixels {
                break 'overlay_loop;
            }

            let idx = (y * width + x) * 4;
            let bit = raw[idx + 3] & 1;

            let (target_r, target_g, target_b, blend_alpha) = if current_pixel_idx < 152 {
                if bit == 1 {
                    (255u32, 110u32, 110u32, 130u32) // 明るい赤
                } else {
                    (70u32, 0u32, 0u32, 130u32)       // 暗い赤
                }
            } else {
                if bit == 1 {
                    (255u32, 255u32, 255u32, 115u32) // 白（ビット1）
                } else {
                    (0u32, 0u32, 0u32, 115u32)       // 黒（ビット0）
                }
            };

            let inv_alpha = 255 - blend_alpha;
            let orig_r = raw[idx] as u32;
            let orig_g = raw[idx + 1] as u32;
            let orig_b = raw[idx + 2] as u32;

            raw[idx] = ((orig_r * inv_alpha + target_r * blend_alpha) / 255) as u8;
            raw[idx + 1] = ((orig_g * inv_alpha + target_g * blend_alpha) / 255) as u8;
            raw[idx + 2] = ((orig_b * inv_alpha + target_b * blend_alpha) / 255) as u8;
            raw[idx + 3] = raw[idx + 3].max(blend_alpha as u8).max(220);

            current_pixel_idx += 1;
        }
    }

    let mut png_bytes = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_bytes);
    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode overlay PNG: {}", e))?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let data_url = format!("data:image/png;base64,{}", b64);

    let occupied_columns = (total_pixels + height - 1) / height;
    let coverage_percent = (total_pixels as f64 / image_total_pixels as f64) * 100.0;

    Ok(AlphaOverlayResult {
        data_url,
        width: width as u32,
        height: height as u32,
        header_bytes: 19,
        payload_bytes,
        total_bytes,
        total_pixels,
        image_total_pixels,
        coverage_percent,
        occupied_columns,
    })
}

/// アルファチャンネルに埋め込まれたメタデータ領域を検出し、
/// LSBビット情報と半透明レイヤーを元画像に重ね合わせたハイブリッド画像を返却するコマンド
#[tauri::command]
pub(crate) async fn get_alpha_overlay_image(file_path: String) -> Result<AlphaOverlayResult, String> {
    tokio::task::spawn_blocking(move || generate_alpha_overlay_image(&file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// XMP (XML) 文字列内の基本的な XML エンティティをデコードする。
pub(crate) fn unescape_xml_entities(input: &str) -> String {
    input
        .replace("&#xA;", "\n")
        .replace("&#xa;", "\n")
        .replace("&#10;", "\n")
        .replace("&#xD;", "\r")
        .replace("&#xd;", "\r")
        .replace("&#13;", "\r")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// XMP パケット文字列から指定したタグ名（要素形式 `<tag>...</tag>` または属性形式 `tag="..."`）の値を抽出する。
/// `<rdf:Alt><rdf:li ...>...</rdf:li></rdf:Alt>` 構造がネストされている場合は最内層の `<rdf:li>` のテキストを取り出す。
pub(crate) fn extract_xmp_field(xml: &str, tag_names: &[&str]) -> Option<String> {
    for &tag in tag_names {
        // 1. 要素形式: <tag ...>...</tag>
        let open_pat = format!("<{}", tag);
        let close_pat = format!("</{}>", tag);
        if let Some(open_pos) = xml.find(&open_pat) {
            let after_tag = &xml[open_pos + open_pat.len()..];
            if after_tag.starts_with('>') || after_tag.starts_with(|c: char| c.is_ascii_whitespace()) {
                if let Some(gt_offset) = after_tag.find('>') {
                    let content_start = open_pos + open_pat.len() + gt_offset + 1;
                    if let Some(close_offset) = xml[content_start..].find(&close_pat) {
                        let mut inner = &xml[content_start..content_start + close_offset];
                        if let Some(li_pos) = inner.find("<rdf:li") {
                            let after_li = &inner[li_pos + "<rdf:li".len()..];
                            if let Some(li_gt) = after_li.find('>') {
                                let li_content_start = li_pos + "<rdf:li".len() + li_gt + 1;
                                if let Some(li_close) = inner[li_content_start..].find("</rdf:li>") {
                                    inner = &inner[li_content_start..li_content_start + li_close];
                                }
                            }
                        }
                        let decoded = unescape_xml_entities(inner.trim());
                        if !decoded.is_empty() {
                            return Some(decoded);
                        }
                    }
                }
            }
        }

        // 2. 属性形式: tag="value" または tag='value'
        for quote in ['"', '\''] {
            let attr_pat = format!("{}={}", tag, quote);
            let mut search_from = 0;
            while let Some(rel_pos) = xml[search_from..].find(&attr_pat) {
                let abs_pos = search_from + rel_pos;
                let valid_boundary = abs_pos == 0 || {
                    let prev = xml.as_bytes()[abs_pos - 1];
                    prev.is_ascii_whitespace() || prev == b':'
                };
                let val_start = abs_pos + attr_pat.len();
                if valid_boundary {
                    if let Some(val_end) = xml[val_start..].find(quote) {
                        let raw_val = &xml[val_start..val_start + val_end];
                        let decoded = unescape_xml_entities(raw_val.trim());
                        if !decoded.is_empty() {
                            return Some(decoded);
                        }
                    }
                }
                search_from = val_start;
            }
        }
    }
    None
}

/// JPEG APP1 (`http://ns.adobe.com/xap/1.0/\0`) または WebP `XMP ` チャンクから
/// プロンプトやソフトウェア情報（`ImageDescription`, `UserComment`, `Software`）を抽出してマップへ補完する。
/// 既に TIFF EXIF で取得済みのキーは上書きせず、未取得のフィールドのみを補完する。
pub(crate) fn parse_xmp_metadata(xmp_bytes: &[u8], results: &mut std::collections::HashMap<String, Vec<u8>>) {
    let xml = String::from_utf8_lossy(xmp_bytes);
    if let Some(desc) = extract_xmp_field(&xml, &["dc:description", "tiff:ImageDescription", "ImageDescription"]) {
        results
            .entry("ImageDescription".to_string())
            .or_insert_with(|| desc.into_bytes());
    }
    if let Some(comment) = extract_xmp_field(&xml, &["exif:UserComment", "UserComment", "parameters", "c2pa:parameters"]) {
        results
            .entry("UserComment".to_string())
            .or_insert_with(|| comment.into_bytes());
    }
    if let Some(sw) = extract_xmp_field(&xml, &["xmp:CreatorTool", "tiff:Software", "Software"]) {
        results
            .entry("Software".to_string())
            .or_insert_with(|| sw.into_bytes());
    }
}

pub(crate) fn parse_webp_exif(path: &str) -> std::collections::HashMap<String, Vec<u8>> {
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
                    } else if chunk_id == b"XMP " && data_offset + chunk_size <= buffer.len() {
                        let xmp_data = &buffer[data_offset..data_offset + chunk_size];
                        parse_xmp_metadata(xmp_data, &mut results);
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

pub(crate) fn parse_jpeg_exif(path: &str) -> std::collections::HashMap<String, Vec<u8>> {
    const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    let mut results = std::collections::HashMap::new();
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(mmap) = unsafe { memmap2::MmapOptions::new().map(&file) } {
            let buffer = &mmap[..];
            if buffer.len() >= 2 && buffer[0] == 0xFF && buffer[1] == 0xD8 {
                let mut offset = 2;
                while offset + 2 <= buffer.len() {
                    if buffer[offset] != 0xFF {
                        break;
                    }
                    // 連続する 0xFF パディングバイトをスキップ
                    while offset < buffer.len() && buffer[offset] == 0xFF {
                        offset += 1;
                    }
                    if offset >= buffer.len() {
                        break;
                    }
                    let marker = buffer[offset];
                    offset += 1;

                    // EOI (0xD9) または SOS (0xDA: Start of Scan) 到達時はヘッダセグメント走査を終了
                    if marker == 0xD9 || marker == 0xDA {
                        break;
                    }
                    // ペイロード長を持たないスタンドアロンマーカー (RST0-RST7, SOI, TEM, 0x00)
                    if (0xD0..=0xD8).contains(&marker) || marker == 0x01 || marker == 0x00 {
                        continue;
                    }

                    if offset + 2 > buffer.len() {
                        break;
                    }
                    let length = u16::from_be_bytes([buffer[offset], buffer[offset + 1]]) as usize;
                    // JPEG セグメント長は自身の2バイトを含むため、2未満は不正データとして即座に打ち切る（スライス逆転 panic 防止）
                    if length < 2 || offset + length > buffer.len() {
                        break;
                    }
                    if marker == 0xE1 {
                        let app1_data = &buffer[offset + 2..offset + length];
                        if app1_data.len() >= 6 && &app1_data[0..4] == b"Exif" {
                            results.extend(parse_tiff_ifd(&app1_data[6..]));
                        } else if app1_data.starts_with(XMP_HEADER) {
                            parse_xmp_metadata(&app1_data[XMP_HEADER.len()..], &mut results);
                        } else if app1_data.windows(9).any(|w| w == b"\"prompt\":" || w == b"\"prompt\": ") {
                            results.entry("Comment".to_string()).or_insert_with(|| app1_data.to_vec());
                        }
                    } else if marker == 0xFE {
                        let com_data = &buffer[offset + 2..offset + length];
                        if !com_data.is_empty() {
                            if let Some(existing) = results.get_mut("Comment") {
                                if existing.ends_with(b"}") && com_data.starts_with(b"{") {
                                    existing.push(b'\n');
                                }
                                existing.extend_from_slice(com_data);
                            } else {
                                results.insert("Comment".to_string(), com_data.to_vec());
                            }
                        }
                    } else if (0xE0..=0xEF).contains(&marker) {
                        let app_data = &buffer[offset + 2..offset + length];
                        if app_data.windows(9).any(|w| w == b"\"prompt\":" || w == b"\"prompt\": ") {
                            results.entry("Comment".to_string()).or_insert_with(|| app_data.to_vec());
                        }
                    }
                    offset += length;
                }
            }
        }
    }
    results
}

/// 指定ファイルのメタデータを解析し、SQLite キャッシュ DB とインメモリ state（all_files / filtered_files）を更新する。
pub(crate) async fn parse_metadata_inner(
    state: &AppState,
    file_path: String,
) -> Result<ParseMetadataResult, String> {
    let db_conn_clone = state.db_conn.clone();
    let fp_clone = file_path.clone();
    let full_meta = tokio::task::spawn_blocking(move || {
        get_full_metadata_for_path(&fp_clone, &db_conn_clone).0
    })
    .await
    .unwrap_or_else(|_| FullMetadata {
        path: file_path.clone(),
        width: 0,
        height: 0,
        prompt: String::new(),
        negative_prompt: String::new(),
        params: serde_json::Value::Object(serde_json::Map::new()),
        source: String::new(),
        metadata_source: String::new(),
    });

    // state（all_files / filtered_files）内の対応エントリを同期更新
    crate::update_metadata_in_state_inner(state, std::slice::from_ref(&full_meta));

    Ok(ParseMetadataResult {
        prompt: full_meta.prompt,
        negative_prompt: full_meta.negative_prompt,
        width: full_meta.width,
        height: full_meta.height,
        params: full_meta.params,
        source: full_meta.source,
        metadata_source: full_meta.metadata_source,
    })
}

/// フロントエンドのインスペクター表示用に、指定ファイルのメタデータを非同期解析して返却する
#[tauri::command]
pub(crate) async fn parse_metadata(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<ParseMetadataResult, String> {
    parse_metadata_inner(&state, file_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use crate::{create_test_app_state, notify_files_batch_inner, precache_entries_chunk};

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
    fn test_parse_mp4_dimensions_oversized_tkhd_clamping() {
        use super::parse_mp4_dimensions;
        use std::io::Write;

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_oversized_tkhd.mp4");

        // 1920x1080のtkhdペイロード (version 0: offset 76)
        let mut tkhd_payload = vec![0u8; 84];
        tkhd_payload[76..80].copy_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd_payload[80..84].copy_from_slice(&(1080u32 << 16).to_be_bytes());

        let mut tkhd_box = vec![];
        // 意図的に巨大なサイズ（1GB = 0x4000_0000）を宣言
        tkhd_box.extend_from_slice(&0x4000_0000u32.to_be_bytes());
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

        // 巨大サイズが宣言されていても、256バイト上限で安全にクランプされ1920x1080が取得できること
        let dims = parse_mp4_dimensions(test_file.to_str().unwrap());
        assert_eq!(dims, Some((1920, 1080)));

        let _ = std::fs::remove_file(test_file);
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
                    searchable_source TEXT DEFAULT '',
                    metadata_source TEXT DEFAULT ''
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
    fn test_png_ihdr_dimension_extraction_logic() {
        // PNG シグネチャ + IHDR チャンク（width=1920, height=1080）
        let mut png_bytes = Vec::new();
        // PNG signature
        png_bytes.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        // IHDR chunk: len=13
        png_bytes.extend_from_slice(&13u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IHDR");
        // width=1920 (0x00000780), height=1080 (0x00000438)
        png_bytes.extend_from_slice(&1920u32.to_be_bytes());
        png_bytes.extend_from_slice(&1080u32.to_be_bytes());
        // bit_depth=8, color_type=6, comp=0, filter=0, interlace=0
        png_bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        // CRC dummy
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);
        // IEND chunk: len=0
        png_bytes.extend_from_slice(&0u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IEND");
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_veloce_ihdr_dim.png");
        std::fs::write(&test_file, &png_bytes).unwrap();

        let (chunks, w, h, color_type): (std::collections::HashMap<String, String>, u32, u32, u8) = parse_png_chunks_with_dimensions(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(w, 1920);
        assert_eq!(h, 1080);
        assert_eq!(color_type, 6, "ColorType 6 (RGBA) が正しく抽出されること");
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_memmap_png_chunks_and_metadata() {
        let mut png_bytes = Vec::new();
        // PNG Signature
        png_bytes.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

        // IHDR chunk: len=13, width=800, height=600, bit_depth=8, color_type=2, ...
        png_bytes.extend_from_slice(&13u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IHDR");
        png_bytes.extend_from_slice(&800u32.to_be_bytes());
        png_bytes.extend_from_slice(&600u32.to_be_bytes());
        png_bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]); // dummy CRC

        // tEXt chunk: keyword="Title", text="Veloce Test"
        let mut text_data = Vec::new();
        text_data.extend_from_slice(b"Title\0Veloce Test");
        png_bytes.extend_from_slice(&(text_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"tEXt");
        png_bytes.extend_from_slice(&text_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]); // dummy CRC

        // iTXt chunk (uncompressed): keyword="Description", text="NovelAI Prompt Test"
        // format: keyword + null + comp_flag(0) + comp_method(0) + lang_tag + null + trans_keyword + null + text
        let mut itxt_data = Vec::new();
        itxt_data.extend_from_slice(b"Description\0");
        itxt_data.extend_from_slice(&[0, 0]); // uncompressed
        itxt_data.extend_from_slice(b"\0"); // empty lang tag
        itxt_data.extend_from_slice(b"\0"); // empty trans keyword
        itxt_data.extend_from_slice(b"NovelAI Prompt Test");
        png_bytes.extend_from_slice(&(itxt_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"iTXt");
        png_bytes.extend_from_slice(&itxt_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]); // dummy CRC

        // IEND chunk: len=0
        png_bytes.extend_from_slice(&0u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IEND");
        png_bytes.extend_from_slice(&[0, 0, 0, 0]); // dummy CRC

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_veloce_memmap_png.png");
        std::fs::write(&test_file, &png_bytes).unwrap();

        let (chunks, w, h, _) = parse_png_chunks_with_dimensions(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(w, 800, "IHDRからwidthがゼロコピー抽出されること");
        assert_eq!(h, 600, "IHDRからheightがゼロコピー抽出されること");
        assert_eq!(chunks.get("Title").map(|s| s.as_str()), Some("Veloce Test"), "tEXtチャンクが抽出されること");
        assert_eq!(chunks.get("Description").map(|s| s.as_str()), Some("NovelAI Prompt Test"), "iTXtチャンクが抽出されること");
    }

    #[test]
    fn test_stealth_pnginfo_early_exit_on_normal_image() {
        // 通常の画像（Stealth PNGInfoを持たないRGBA画像）を作成
        let width = 20u32;
        let height = 20u32;
        let mut img = image::RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([255, 128, 64, 255]);
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_normal_no_stealth.png");
        img.save(&test_file).unwrap();

        let result = extract_stealth_pnginfo(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert!(result.is_none(), "通常の画像では早期ヘッダー判定により即座に None が返ること");
    }

    #[test]
    fn test_stealth_pnginfo_valid_payload_decompression() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let sample_prompt = "1girl, solo, masterpiece, anime style, highly detailed";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(sample_prompt.as_bytes()).unwrap();
        let compressed_payload = encoder.finish().unwrap();

        let mut payload_bytes = Vec::new();
        payload_bytes.extend_from_slice(b"stealth_pngcomp");
        payload_bytes.extend_from_slice(&(compressed_payload.len() as u32).to_be_bytes());
        payload_bytes.extend_from_slice(&compressed_payload);

        // ビット列に変換
        let mut bits = Vec::new();
        for b in payload_bytes {
            for i in 0..8 {
                bits.push((b >> (7 - i)) & 1);
            }
        }

        let width = 50u32;
        let height = 50u32;
        let mut img = image::RgbaImage::new(width, height);

        // Column-Major (x -> y) でアルファ最下位ビットに埋め込む
        let mut bit_idx = 0;
        for x in 0..width {
            for y in 0..height {
                let bit = if bit_idx < bits.len() { bits[bit_idx] } else { 0 };
                bit_idx += 1;
                img.put_pixel(x, y, image::Rgba([100, 150, 200, 254 | bit]));
            }
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_valid_stealth.png");
        img.save(&test_file).unwrap();

        let result = extract_stealth_pnginfo(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(result.as_deref(), Some(sample_prompt), "Stealth PNGInfo からプロンプトが正確に解凍・抽出されること");
    }

    #[test]
    fn test_stealth_pnginfo_8bit_rgba_png_zune_matches_image_open() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let sample_prompt = r#"{"prompt":"1girl, twilight sky, zune_png_stealth_check","steps":28}"#;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(sample_prompt.as_bytes()).unwrap();
        let compressed_payload = encoder.finish().unwrap();

        let mut payload_bytes = Vec::new();
        payload_bytes.extend_from_slice(b"stealth_pngcomp");
        payload_bytes.extend_from_slice(&((compressed_payload.len() * 8) as u32).to_be_bytes());
        payload_bytes.extend_from_slice(&compressed_payload);

        let mut bits = Vec::with_capacity(payload_bytes.len() * 8);
        for b in payload_bytes {
            for i in 0..8 {
                bits.push((b >> (7 - i)) & 1);
            }
        }

        let width = 64u32;
        let height = 64u32;
        let mut img = image::RgbaImage::new(width, height);
        let mut bit_idx = 0;
        for x in 0..width {
            for y in 0..height {
                let bit = if bit_idx < bits.len() { bits[bit_idx] } else { 0 };
                bit_idx += 1;
                img.put_pixel(x, y, image::Rgba([(x % 256) as u8, (y % 256) as u8, 180, 254 | bit]));
            }
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let test_file = temp_dir.path().join("zune_8bit_rgba_stealth.png");
        img.save(&test_file).unwrap();
        let test_path = test_file.to_string_lossy().to_string();

        // 1. zune-png のデコード結果が image::open().into_rgba8() と全画素バイト単位で完全一致すること
        let (zw, zh, zraw) = decode_png_rgba8_with_zune(&test_path)
            .expect("8bit RGBA PNG は zune-png 経路でデコードできること");
        let fallback_img = image::open(&test_path).unwrap().into_rgba8();
        assert_eq!((zw as u32, zh as u32), fallback_img.dimensions());
        assert_eq!(zraw, fallback_img.into_raw());

        // 2. 新経路を通る extract_stealth_pnginfo_with_type で同一の埋め込み文字列が抽出できること
        let extracted = extract_stealth_pnginfo_with_type(&test_path);
        assert_eq!(
            extracted,
            Some((sample_prompt.to_string(), "Stealth PNGInfo (Compressed)"))
        );
    }

    #[test]
    fn test_stealth_pnginfo_bit_length_header_decompression() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let sample_prompt = "1girl, solo, glowing_eyes, silver_hair, novelai stealth prompt";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(sample_prompt.as_bytes()).unwrap();
        let compressed_payload = encoder.finish().unwrap();

        // NovelAI / SD-WebUI 標準仕様: ヘッダー長フィールドはビット数 (payload.len() * 8)
        let payload_bits = (compressed_payload.len() * 8) as u32;

        let mut payload_bytes = Vec::new();
        payload_bytes.extend_from_slice(b"stealth_pngcomp");
        payload_bytes.extend_from_slice(&payload_bits.to_be_bytes());
        payload_bytes.extend_from_slice(&compressed_payload);

        let mut bits = Vec::new();
        for b in payload_bytes {
            for i in 0..8 {
                bits.push((b >> (7 - i)) & 1);
            }
        }

        let width = 60u32;
        let height = 60u32;
        let mut img = image::RgbaImage::new(width, height);

        let mut bit_idx = 0;
        for x in 0..width {
            for y in 0..height {
                let bit = if bit_idx < bits.len() { bits[bit_idx] } else { 0 };
                bit_idx += 1;
                img.put_pixel(x, y, image::Rgba([128, 128, 128, 254 | bit]));
            }
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_stealth_bit_length.png");
        img.save(&test_file).unwrap();

        let result = extract_stealth_pnginfo(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(
            result.as_deref(),
            Some(sample_prompt),
            "NovelAI標準のビット長ヘッダー形式からプロンプトが正確に解凍・抽出されること"
        );
    }

    #[test]
    fn test_stealth_pnginfo_raw_text_bit_length() {
        let sample_prompt = "masterpiece, highly detailed, raw stealth info";
        let payload_bits = (sample_prompt.len() * 8) as u32;

        let mut payload_bytes = Vec::new();
        payload_bytes.extend_from_slice(b"stealth_pnginfo");
        payload_bytes.extend_from_slice(&payload_bits.to_be_bytes());
        payload_bytes.extend_from_slice(sample_prompt.as_bytes());

        let mut bits = Vec::new();
        for b in payload_bytes {
            for i in 0..8 {
                bits.push((b >> (7 - i)) & 1);
            }
        }

        let width = 50u32;
        let height = 50u32;
        let mut img = image::RgbaImage::new(width, height);

        let mut bit_idx = 0;
        for x in 0..width {
            for y in 0..height {
                let bit = if bit_idx < bits.len() { bits[bit_idx] } else { 0 };
                bit_idx += 1;
                img.put_pixel(x, y, image::Rgba([200, 200, 200, 254 | bit]));
            }
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_stealth_raw_bit_length.png");
        img.save(&test_file).unwrap();

        let (extracted_text, detected_type) = extract_stealth_pnginfo_with_type(&test_file.to_string_lossy())
            .expect("非圧縮Raw形式のStealth PNGInfoが正常に抽出できること");
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(extracted_text, sample_prompt);
        assert_eq!(detected_type, "Stealth PNGInfo (Raw)");
    }

    #[test]
    fn test_novelai_v4_use_coords_preserved() {
        let v4_json = serde_json::json!({
            "prompt": "masterpiece, 2girls",
            "v4_prompt": {
                "caption": {
                    "base_caption": "masterpiece, 2girls",
                    "char_captions": [
                        {
                            "char_caption": "girl 1",
                            "centers": [{"x": 0.2, "y": 0.5}]
                        }
                    ]
                },
                "use_coords": false
            }
        });

        let mut comment_obj = v4_json;
        if let Some(v4_prompt) = comment_obj.get("v4_prompt").cloned() {
            let v4_use_coords = v4_prompt.get("use_coords").and_then(|v| v.as_bool());
            if let Some(char_captions) = v4_prompt
                .pointer("/caption/char_captions")
                .and_then(|v| v.as_array())
            {
                let mut char_prompts_arr = Vec::new();
                for p in char_captions.iter() {
                    let mut char_obj = serde_json::Map::new();
                    if let Some(cap) = p.get("char_caption").and_then(|v| v.as_str()) {
                        char_obj.insert("prompt".to_string(), serde_json::Value::String(cap.to_string()));
                    }
                    if let Some(centers) = p.get("centers") {
                        char_obj.insert("centers".to_string(), centers.clone());
                    }
                    char_prompts_arr.push(serde_json::Value::Object(char_obj));
                }

                if let serde_json::Value::Object(ref mut map) = comment_obj {
                    map.insert("characterPrompts".to_string(), serde_json::Value::Array(char_prompts_arr));
                    if let Some(use_coords) = v4_use_coords {
                        map.insert("use_coords".to_string(), serde_json::Value::Bool(use_coords));
                    }
                    map.remove("v4_prompt");
                }
            }
        }

        assert_eq!(comment_obj.get("use_coords"), Some(&serde_json::Value::Bool(false)));
        assert!(comment_obj.get("characterPrompts").is_some());
        assert!(comment_obj.get("v4_prompt").is_none());
    }

    #[test]
    fn test_novelai_randomizer_adopted_prompt() {
        let mut prompt = "1girl, ||takino tomo|kasuga ayumu||, cheerful".to_string();
        let mut comment_obj = serde_json::json!({
            "prompt": "1girl, takino tomo, cheerful",
            "steps": 28
        });

        let comment_prompt = comment_obj.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());
        if prompt.is_empty() {
            if let Some(p) = comment_prompt {
                prompt = p;
                if let serde_json::Value::Object(ref mut map) = comment_obj {
                    map.remove("prompt");
                }
            }
        } else if let Some(cp) = comment_prompt {
            let is_different = prompt.trim() != cp.trim() || prompt.contains("||");
            if let serde_json::Value::Object(ref mut map) = comment_obj {
                if is_different {
                    map.insert("adoptedPrompt".to_string(), serde_json::Value::String(cp.clone()));
                    map.insert("adopted_prompt".to_string(), serde_json::Value::String(cp));
                } else {
                    map.remove("prompt");
                }
            }
        }

        assert_eq!(prompt, "1girl, ||takino tomo|kasuga ayumu||, cheerful");
        assert_eq!(comment_obj.get("adoptedPrompt").and_then(|v| v.as_str()), Some("1girl, takino tomo, cheerful"));
        assert_eq!(comment_obj.get("adopted_prompt").and_then(|v| v.as_str()), Some("1girl, takino tomo, cheerful"));
    }

    #[test]
    fn test_novelai_actual_prompts_character_randomizer() {
        let v4_json = serde_json::json!({
            "prompt": "1girl",
            "v4_prompt": {
                "caption": {
                    "base_caption": "1girl",
                    "char_captions": [
                        {
                            "char_caption": "girl, ||takino tomo|kasuga ayumu||",
                            "centers": [{"x": 0.5, "y": 0.5}]
                        }
                    ]
                }
            },
            "actual_prompts": {
                "prompt": {
                    "base_caption": "1girl",
                    "char_captions": [
                        {
                            "char_caption": "girl, takino tomo"
                        }
                    ]
                }
            }
        });

        let mut comment_obj = v4_json;
        let actual_prompts_obj = comment_obj.get("actual_prompts").cloned();
        let ap_char_prompts = actual_prompts_obj.as_ref()
            .and_then(|ap| ap.pointer("/prompt/char_captions"))
            .and_then(|v| v.as_array());

        if let Some(v4_prompt) = comment_obj.get("v4_prompt").cloned() {
            if let Some(char_captions) = v4_prompt.pointer("/caption/char_captions").and_then(|v| v.as_array()) {
                let mut char_prompts_arr = Vec::new();
                for (i, p) in char_captions.iter().enumerate() {
                    let mut char_obj = serde_json::Map::new();
                    let cap_str = p.get("char_caption").and_then(|v| v.as_str()).unwrap_or_default();
                    char_obj.insert("prompt".to_string(), serde_json::Value::String(cap_str.to_string()));

                    if let Some(ap_char_item) = ap_char_prompts.and_then(|arr| arr.get(i)) {
                        if let Some(ap_cap) = ap_char_item.get("char_caption").and_then(|v| v.as_str()) {
                            if cap_str.trim() != ap_cap.trim() || cap_str.contains("||") {
                                char_obj.insert("adoptedPrompt".to_string(), serde_json::Value::String(ap_cap.to_string()));
                                char_obj.insert("adopted_prompt".to_string(), serde_json::Value::String(ap_cap.to_string()));
                            }
                        }
                    }
                    char_prompts_arr.push(serde_json::Value::Object(char_obj));
                }
                if let serde_json::Value::Object(ref mut map) = comment_obj {
                    map.insert("characterPrompts".to_string(), serde_json::Value::Array(char_prompts_arr));
                }
            }
        }

        let chars = comment_obj.get("characterPrompts").and_then(|v| v.as_array()).unwrap();
        assert_eq!(chars[0].get("prompt").and_then(|v| v.as_str()), Some("girl, ||takino tomo|kasuga ayumu||"));
        assert_eq!(chars[0].get("adoptedPrompt").and_then(|v| v.as_str()), Some("girl, takino tomo"));
    }

    #[test]
    fn test_novelai_no_randomizer_removes_redundant_prompt() {
        let mut prompt = "1girl, cheerful".to_string();
        let mut comment_obj = serde_json::json!({
            "prompt": "1girl, cheerful",
            "steps": 28
        });

        let comment_prompt = comment_obj.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());
        if prompt.is_empty() {
            if let Some(p) = comment_prompt {
                prompt = p;
                if let serde_json::Value::Object(ref mut map) = comment_obj {
                    map.remove("prompt");
                }
            }
        } else if let Some(cp) = comment_prompt {
            let is_different = prompt.trim() != cp.trim() || prompt.contains("||");
            if let serde_json::Value::Object(ref mut map) = comment_obj {
                if is_different {
                    map.insert("adoptedPrompt".to_string(), serde_json::Value::String(cp.clone()));
                    map.insert("adopted_prompt".to_string(), serde_json::Value::String(cp));
                } else {
                    map.remove("prompt");
                }
            }
        }

        assert_eq!(prompt, "1girl, cheerful");
        assert!(comment_obj.get("adoptedPrompt").is_none());
        assert!(comment_obj.get("prompt").is_none());
        assert_eq!(comment_obj.get("steps").and_then(|v| v.as_i64()), Some(28));
    }

    #[test]
    fn test_stealth_pnginfo_skips_non_alpha_png() {
        // アルファチャンネルを持たないRGB画像（ColorType 2）を作成
        let width = 30u32;
        let height = 30u32;
        let mut img = image::RgbImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgb([200, 100, 50]);
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_rgb_no_alpha.png");
        img.save(&test_file).unwrap();

        // 1. parse_png_chunks_with_dimensions で color_type == 2 (RGB) が検出されること
        let (chunks, w, h, color_type) = parse_png_chunks_with_dimensions(&test_file.to_string_lossy());
        assert_eq!(w, 30);
        assert_eq!(h, 30);
        assert_eq!(color_type, 2, "RGB画像のColorType 2が正しく検出されること");
        assert!(chunks.is_empty());

        // 2. extract_stealth_pnginfo がフルデコードを行わずヘッダー事前検査で即座に None を返すこと
        let result = extract_stealth_pnginfo(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert!(result.is_none(), "非アルファPNGはStealth抽出の対象外として即座にNoneが返ること");
    }

    #[test]
    fn test_stealth_pnginfo_skips_non_alpha_webp() {
        // アルファチャンネルを持たないWebP（VP8 lossyチャンク）の最小バイナリ構造を作成
        let mut webp_bytes = Vec::new();
        webp_bytes.extend_from_slice(b"RIFF");
        webp_bytes.extend_from_slice(&20u32.to_le_bytes()); // RIFF size
        webp_bytes.extend_from_slice(b"WEBP");
        webp_bytes.extend_from_slice(b"VP8 ");
        webp_bytes.extend_from_slice(&8u32.to_le_bytes()); // VP8 chunk size
        webp_bytes.extend_from_slice(&[0u8; 8]); // dummy VP8 data

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_non_alpha.webp");
        std::fs::write(&test_file, &webp_bytes).unwrap();

        let result = extract_stealth_pnginfo(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert!(result.is_none(), "VP8 lossy等の非アルファWebPは即座にNoneが返ること");
    }

    #[test]
    fn test_parse_png_metadata_source_text_comment() {
        let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let mut ihdr_data = Vec::new();
        ihdr_data.extend_from_slice(&10u32.to_be_bytes());
        ihdr_data.extend_from_slice(&10u32.to_be_bytes());
        ihdr_data.push(8);
        ihdr_data.push(6);
        ihdr_data.extend_from_slice(&[0, 0, 0]);
        png_bytes.extend_from_slice(&(ihdr_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"IHDR");
        png_bytes.extend_from_slice(&ihdr_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        let mut text_data = Vec::new();
        text_data.extend_from_slice(b"Comment\0{\"prompt\": \"1girl, solo\", \"uc\": \"lowres\"}");
        png_bytes.extend_from_slice(&(text_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"tEXt");
        png_bytes.extend_from_slice(&text_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        png_bytes.extend_from_slice(&0u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IEND");
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_veloce_source_text.png");
        std::fs::write(&test_file, &png_bytes).unwrap();

        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute("CREATE TABLE cache (hash_key TEXT PRIMARY KEY, metadata TEXT, width INTEGER, height INTEGER, path TEXT, size INTEGER, mtime INTEGER, ctime INTEGER, last_accessed INTEGER, searchable_prompt TEXT, searchable_negative_prompt TEXT, searchable_source TEXT, metadata_source TEXT)", []).unwrap();
        }

        let (meta, _, _) = get_full_metadata_for_path(&test_file.to_string_lossy(), &pool);
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(meta.metadata_source, "PNG Chunks");
        assert_eq!(meta.prompt, "1girl, solo");
        assert_eq!(meta.negative_prompt, "lowres");
    }

    #[test]
    fn test_cache_reparse_when_metadata_source_empty() {
        let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let mut ihdr_data = Vec::new();
        ihdr_data.extend_from_slice(&10u32.to_be_bytes());
        ihdr_data.extend_from_slice(&10u32.to_be_bytes());
        ihdr_data.push(8);
        ihdr_data.push(6);
        ihdr_data.extend_from_slice(&[0, 0, 0]);
        png_bytes.extend_from_slice(&(ihdr_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"IHDR");
        png_bytes.extend_from_slice(&ihdr_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        let mut text_data = Vec::new();
        text_data.extend_from_slice(b"parameters\0Steps: 20, Sampler: Euler");
        png_bytes.extend_from_slice(&(text_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"tEXt");
        png_bytes.extend_from_slice(&text_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        png_bytes.extend_from_slice(&0u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IEND");
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_veloce_source_reparse.png");
        std::fs::write(&test_file, &png_bytes).unwrap();

        let file_path = test_file.to_string_lossy().to_string();
        let mtime = 12345678u64;
        let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", file_path, mtime).as_bytes());
        let hash_key = format!("{:016x}", digest);

        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute("CREATE TABLE cache (hash_key TEXT PRIMARY KEY, metadata TEXT, width INTEGER, height INTEGER, path TEXT, size INTEGER, mtime INTEGER, ctime INTEGER, last_accessed INTEGER, searchable_prompt TEXT, searchable_negative_prompt TEXT, searchable_source TEXT, metadata_source TEXT)", []).unwrap();
            
            // 過去の古い形式のメタデータ（例: "PNG (tEXt: parameters)"）が保存されている状態
            let old_meta = FullMetadata {
                path: file_path.clone(),
                width: 10,
                height: 10,
                prompt: "old prompt".to_string(),
                negative_prompt: String::new(),
                params: serde_json::json!({}),
                source: String::new(),
                metadata_source: "PNG (tEXt: parameters)".to_string(),
            };
            let old_json = serde_json::to_string(&old_meta).unwrap();
            conn.execute("INSERT INTO cache (hash_key, metadata, path, metadata_source) VALUES (?1, ?2, ?3, 'PNG (tEXt: parameters)')", rusqlite::params![hash_key, old_json, file_path]).unwrap();
        }

        // 実行: 古い形式の metadata_source なので再解析が走り、最新の "PNG Chunks" でDBが更新される
        let (meta, _, _, _) = get_full_metadata_for_path_with_stat_inner(&file_path, mtime, 0, png_bytes.len() as u64, &pool, true);
        let _ = std::fs::remove_file(&test_file);

        assert_eq!(meta.metadata_source, "PNG Chunks", "再解析により最新の PNG Chunks が特定されること");

        let conn = pool.get().unwrap();
        let saved_source: String = conn.query_row("SELECT metadata_source FROM cache WHERE hash_key = ?1", rusqlite::params![hash_key], |r| r.get(0)).unwrap();
        assert_eq!(saved_source, "PNG Chunks", "DBのmetadata_sourceカラムが更新されていること");
    }

    #[test]
    fn test_generate_alpha_overlay_image_with_stealth() {
        let sample_payload = b"test payload metadata for hybrid alpha overlay";
        let payload_bits = (sample_payload.len() * 8) as u32;
        let mut payload_bytes = Vec::new();
        payload_bytes.extend_from_slice(b"stealth_pnginfo");
        payload_bytes.extend_from_slice(&payload_bits.to_be_bytes());
        payload_bytes.extend_from_slice(sample_payload);

        let mut bits = Vec::new();
        for b in &payload_bytes {
            for i in 0..8 {
                bits.push((b >> (7 - i)) & 1);
            }
        }

        let width = 60u32;
        let height = 40u32;
        let mut img = image::RgbaImage::new(width, height);

        let mut bit_idx = 0;
        for x in 0..width {
            for y in 0..height {
                let bit = if bit_idx < bits.len() { bits[bit_idx] } else { 0 };
                bit_idx += 1;
                img.put_pixel(x, y, image::Rgba([120, 160, 200, 254 | bit]));
            }
        }

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_hybrid_overlay_stealth.png");
        img.save(&test_file).unwrap();

        let result = generate_alpha_overlay_image(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert!(result.is_ok(), "Stealthメタデータがある画像からハイブリッドオーバーレイ画像が生成できること");
        let res = result.unwrap();
        assert!(res.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(res.width, 60);
        assert_eq!(res.height, 40);
        assert_eq!(res.header_bytes, 19);
        assert_eq!(res.payload_bytes, sample_payload.len());
        assert_eq!(res.total_bytes, 19 + sample_payload.len());
        assert_eq!(res.total_pixels, 152 + sample_payload.len() * 8);
        assert_eq!(res.image_total_pixels, (width * height) as usize);
        assert!(res.coverage_percent > 0.0 && res.coverage_percent <= 100.0);
        assert_eq!(res.occupied_columns, (res.total_pixels + (height as usize) - 1) / (height as usize));
    }

    #[test]
    fn test_generate_alpha_overlay_image_without_stealth() {
        let width = 20u32;
        let height = 20u32;
        let img = image::RgbaImage::new(width, height);

        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_overlay_no_stealth.png");
        img.save(&test_file).unwrap();

        let result = generate_alpha_overlay_image(&test_file.to_string_lossy());
        let _ = std::fs::remove_file(&test_file);

        assert!(result.is_err(), "Stealth署名がない場合はエラーを返却すること");
    }

    #[test]
    fn test_commit_pending_metadata_batch_and_precache_chunk() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test_precache_batch.db");
        let manager = r2d2_sqlite::SqliteConnectionManager::file(&db_path);
        let pool = r2d2::Pool::builder().max_size(4).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE cache (
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
                 CREATE VIRTUAL TABLE cache_fts USING fts5(hash_key UNINDEXED, searchable_prompt, searchable_negative_prompt, searchable_source);
                 CREATE TRIGGER cache_ai AFTER INSERT ON cache BEGIN
                     INSERT INTO cache_fts(rowid, hash_key, searchable_prompt, searchable_negative_prompt, searchable_source)
                     VALUES (new.rowid, new.hash_key, new.searchable_prompt, new.searchable_negative_prompt, new.searchable_source);
                 END;
                 CREATE TRIGGER cache_au AFTER UPDATE OF hash_key, searchable_prompt, searchable_negative_prompt, searchable_source ON cache BEGIN
                     UPDATE cache_fts SET
                         hash_key = new.hash_key,
                         searchable_prompt = new.searchable_prompt,
                         searchable_negative_prompt = new.searchable_negative_prompt,
                         searchable_source = new.searchable_source
                     WHERE rowid = old.rowid;
                 END;"
            ).unwrap();
        }

        let mut items = Vec::new();
        for i in 0..4 {
            let img_path = temp_dir.path().join(format!("sample_{}.png", i));
            let mut img = image::RgbImage::new(320, 240);
            for pixel in img.pixels_mut() {
                *pixel = image::Rgb([40 * i as u8, 120, 200]);
            }
            img.save(&img_path).unwrap();
            let meta = std::fs::metadata(&img_path).unwrap();
            let mtime = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            let ctime = meta.created().unwrap_or(std::time::UNIX_EPOCH).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            items.push((img_path.to_string_lossy().to_string(), mtime, ctime, meta.len()));
        }

        // 1回目: 4件すべてのメタデータとサムネイルが一括コミットされること
        let (meta_count_1, thumb_count_1) = precache_entries_chunk(&items, &pool);
        assert_eq!(meta_count_1, 4, "初回実行時は4件のメタデータが一括保存されること");
        assert_eq!(thumb_count_1, 4, "初回実行時は4件のサムネイルが一括保存されること");

        // DB内に4件ともサムネイルとメタデータが両方格納されていることを検証
        let conn = pool.get().unwrap();
        let complete_rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cache WHERE thumbnail IS NOT NULL AND metadata IS NOT NULL AND metadata != '' AND width = 320 AND height = 240",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(complete_rows, 4, "4件すべてにメタデータ（解像度含む）とサムネイルが格納されていること");

        // 2回目: すでに両方キャッシュ済みのため、再生成・再コミットが0件であること
        let (meta_count_2, thumb_count_2) = precache_entries_chunk(&items, &pool);
        assert_eq!(meta_count_2, 0, "キャッシュ済み再実行時はメタデータ再保存が0件であること");
        assert_eq!(thumb_count_2, 0, "キャッシュ済み再実行時はサムネイル再保存が0件であること");
    }

    #[test]
    fn test_parse_jpeg_exif_malformed_app1_no_panic() {
        let temp_dir = tempfile::tempdir().unwrap();

        // 1. APP1 マーカー長が 0 (FF D8 FF E1 00 00) の最小クラッシュ再現データ
        let zero_len_jpg = temp_dir.path().join("crash_len0.jpg");
        std::fs::write(&zero_len_jpg, [0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00]).unwrap();
        let res0 = parse_jpeg_exif(zero_len_jpg.to_str().unwrap());
        assert!(res0.is_empty(), "APP1 length=0 の不正JPEGでpanicせず空マップを返すこと");

        // 2. APP1 マーカー長が 1 (FF D8 FF E1 00 01) のデータ
        let one_len_jpg = temp_dir.path().join("crash_len1.jpg");
        std::fs::write(&one_len_jpg, [0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01]).unwrap();
        let res1 = parse_jpeg_exif(one_len_jpg.to_str().unwrap());
        assert!(res1.is_empty(), "APP1 length=1 の不正JPEGでpanicせず空マップを返すこと");

        // 3. SOS (0xDA) 以降に偽の APP1 (0xFF 0xE1 0x00 0x00) が含まれるデータでも SOS で走査終了すること
        let sos_jpg = temp_dir.path().join("sos_stop.jpg");
        std::fs::write(&sos_jpg, [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xE1, 0x00, 0x00]).unwrap();
        let res_sos = parse_jpeg_exif(sos_jpg.to_str().unwrap());
        assert!(res_sos.is_empty());
    }

    #[test]
    fn test_parse_mp4_dimensions_moov_after_10mb_and_ztxt_png() {
        use std::io::{Seek, SeekFrom, Write};
        let temp_dir = tempfile::tempdir().unwrap();

        // 1. 12MB の mdat ボックスの後ろ（10MB超の位置）に moov/trak/tkhd がある MP4
        let mp4_path = temp_dir.path().join("late_moov.mp4");
        {
            let mut f = std::fs::File::create(&mp4_path).unwrap();
            let mdat_size: u32 = 11 * 1024 * 1024; // 11MB (> 10MB)
            f.write_all(&mdat_size.to_be_bytes()).unwrap();
            f.write_all(b"mdat").unwrap();
            // スパースに 11MB 先へシークして moov -> trak -> tkhd を書き込む
            f.seek(SeekFrom::Start(mdat_size as u64)).unwrap();

            let tkhd_payload_len = 84usize;
            let tkhd_box_size = (8 + tkhd_payload_len) as u32;
            let trak_box_size = 8 + tkhd_box_size;
            let moov_box_size = 8 + trak_box_size;

            f.write_all(&moov_box_size.to_be_bytes()).unwrap();
            f.write_all(b"moov").unwrap();
            f.write_all(&trak_box_size.to_be_bytes()).unwrap();
            f.write_all(b"trak").unwrap();
            f.write_all(&tkhd_box_size.to_be_bytes()).unwrap();
            f.write_all(b"tkhd").unwrap();

            let mut tkhd_payload = vec![0u8; tkhd_payload_len];
            tkhd_payload[0] = 0; // version 0 -> width at 76, height at 80
            tkhd_payload[76..80].copy_from_slice(&(1920u32 << 16).to_be_bytes());
            tkhd_payload[80..84].copy_from_slice(&(1080u32 << 16).to_be_bytes());
            f.write_all(&tkhd_payload).unwrap();
        }
        let dims = parse_mp4_dimensions(mp4_path.to_str().unwrap());
        assert_eq!(dims, Some((1920, 1080)), "10MB以降にmoovがあるMP4でも正しく寸法が取得できること");

        // 2. PNG zTXt チャンクの解凍検証
        let png_path = temp_dir.path().join("ztxt_sample.png");
        {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;

            let mut png_bytes = Vec::new();
            png_bytes.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
            // IHDR (13 bytes)
            png_bytes.extend_from_slice(&13u32.to_be_bytes());
            png_bytes.extend_from_slice(b"IHDR");
            png_bytes.extend_from_slice(&512u32.to_be_bytes());
            png_bytes.extend_from_slice(&768u32.to_be_bytes());
            png_bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
            png_bytes.extend_from_slice(&0u32.to_be_bytes()); // dummy CRC

            // zTXt chunk ("parameters\0\0" + zlib compressed text)
            let mut ztxt_data = Vec::new();
            ztxt_data.extend_from_slice(b"parameters\0\0");
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(b"masterpiece, best quality, ztxt_prompt").unwrap();
            let compressed = encoder.finish().unwrap();
            ztxt_data.extend_from_slice(&compressed);

            png_bytes.extend_from_slice(&(ztxt_data.len() as u32).to_be_bytes());
            png_bytes.extend_from_slice(b"zTXt");
            png_bytes.extend_from_slice(&ztxt_data);
            png_bytes.extend_from_slice(&0u32.to_be_bytes()); // dummy CRC

            // IEND
            png_bytes.extend_from_slice(&0u32.to_be_bytes());
            png_bytes.extend_from_slice(b"IEND");
            png_bytes.extend_from_slice(&0u32.to_be_bytes());

            std::fs::write(&png_path, png_bytes).unwrap();
        }
        let (chunks, w, h, _) = parse_png_chunks_with_dimensions(png_path.to_str().unwrap());
        assert_eq!((w, h), (512, 768));
        assert_eq!(
            chunks.get("parameters").map(|s| s.as_str()),
            Some("masterpiece, best quality, ztxt_prompt"),
            "zTXtチャンクが解凍されてparametersとして取得できること"
        );
    }

    #[test]
    fn test_read_png_dimensions_fast_and_notify_files_batch() {
        let temp_dir = tempfile::tempdir().unwrap();
        let png_path = temp_dir.path().join("fast_dim.png");
        let img = image::RgbImage::new(640, 480);
        img.save(&png_path).unwrap();

        // 1. read_png_dimensions_fast が先頭24バイトから正確に寸法を返すこと
        let dims = read_png_dimensions_fast(png_path.to_str().unwrap());
        assert_eq!(dims, (640, 480));
        assert_eq!(get_fast_dimensions_for_file(png_path.to_str().unwrap(), "png"), (640, 480));

        // 2. notify_files_batch_inner が複数ファイルの追加・既存寸法保持更新・削除を一括反映すること
        let state = create_test_app_state("C:\\batch_test");
        let f1 = ImageFile {
            name: "01.png".to_string(),
            ext: ".png".into(),
            path: "C:/batch_test/01.png".to_string(),
            size: 100,
            mtime: 1000,
            ctime: 1000,
            has_thumbnail_cache: false,
            width: 800,
            height: 600,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: Default::default(),
        };
        let f2 = ImageFile {
            name: "02.png".to_string(),
            ext: ".png".into(),
            path: "C:/batch_test/02.png".to_string(),
            size: 200,
            mtime: 2000,
            ctime: 2000,
            has_thumbnail_cache: false,
            width: 1024,
            height: 1024,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: Default::default(),
        };

        let count1 = notify_files_batch_inner(None, &state, vec![f1, f2], Vec::new());
        assert_eq!(count1, 2);
        assert_eq!(state.path_to_all_idx.read().get("C:\\batch_test\\01.png"), Some(&0));
        assert_eq!(state.path_to_all_idx.read().get("C:\\batch_test\\02.png"), Some(&1));

        // 01.png の更新（width=0, height=0 で通知されても既存の 800x600 を保持）と 02.png の削除、03.png の追加を1バッチで実行
        let f1_updated = ImageFile {
            name: "01.png".to_string(),
            ext: ".png".into(),
            path: "C:\\batch_test\\01.png".to_string(),
            size: 150,
            mtime: 1500,
            ctime: 1000,
            has_thumbnail_cache: false,
            width: 0,
            height: 0,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: Default::default(),
        };
        let f3 = ImageFile {
            name: "03.png".to_string(),
            ext: ".png".into(),
            path: "C:/batch_test/03.png".to_string(),
            size: 300,
            mtime: 3000,
            ctime: 3000,
            has_thumbnail_cache: false,
            width: 512,
            height: 512,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: Default::default(),
        };

        let count2 = notify_files_batch_inner(
            None,
            &state,
            vec![f1_updated, f3],
            vec!["C:/batch_test/02.png".to_string()],
        );
        assert_eq!(count2, 2);
        let filtered = state.filtered_files.read();
        assert_eq!(filtered[0].name, "01.png");
        assert_eq!((filtered[0].width, filtered[0].height), (800, 600), "既存ファイルの寸法が保持されること");
        assert_eq!(filtered[1].name, "03.png");
    }

    /// [Phase 9-2] JPEG APP1 (`http://ns.adobe.com/xap/1.0/\0`) および WebP `XMP ` チャンクからのメタデータ抽出テスト
    #[test]
    fn test_parse_jpeg_and_webp_xmp_metadata() {
        let temp_dir = tempfile::tempdir().unwrap();

        // 1. JPEG APP1 XMP セグメント（要素形式 dc:description + 属性形式 exif:UserComment & xmp:CreatorTool）
        let jpg_path = temp_dir.path().join("xmp_sample.jpg");
        {
            let xmp_xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"
                        xmlns:exif="http://ns.adobe.com/exif/1.0/"
                        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                        exif:UserComment="{&quot;prompt&quot;:&quot;1girl, xmp_json&quot;,&quot;uc&quot;:&quot;lowres&quot;}"
                        xmp:CreatorTool="NovelAI Diffusion V4">
                        <dc:description>
                            <rdf:Alt>
                                <rdf:li xml:lang="x-default">1girl, xmp_description</rdf:li>
                            </rdf:Alt>
                        </dc:description>
                    </rdf:Description>
                </rdf:RDF>
            </x:xmpmeta>"#;

            let mut payload = Vec::from(&b"http://ns.adobe.com/xap/1.0/\0"[..]);
            payload.extend_from_slice(xmp_xml.as_bytes());
            let seg_len = (payload.len() + 2) as u16;

            let mut jpg_bytes = vec![0xFF, 0xD8, 0xFF, 0xE1];
            jpg_bytes.extend_from_slice(&seg_len.to_be_bytes());
            jpg_bytes.extend_from_slice(&payload);
            jpg_bytes.extend_from_slice(&[0xFF, 0xD9]);
            std::fs::write(&jpg_path, jpg_bytes).unwrap();
        }

        let jpg_meta = parse_jpeg_exif(jpg_path.to_str().unwrap());
        assert_eq!(
            String::from_utf8_lossy(jpg_meta.get("ImageDescription").unwrap()),
            "1girl, xmp_description"
        );
        assert_eq!(
            String::from_utf8_lossy(jpg_meta.get("UserComment").unwrap()),
            "{\"prompt\":\"1girl, xmp_json\",\"uc\":\"lowres\"}"
        );
        assert_eq!(
            String::from_utf8_lossy(jpg_meta.get("Software").unwrap()),
            "NovelAI Diffusion V4"
        );

        // 2. WebP `XMP ` チャンク（要素形式 exif:UserComment + tiff:Software）
        let webp_path = temp_dir.path().join("xmp_sample.webp");
        {
            let xmp_xml = r#"<x:xmpmeta><rdf:RDF><rdf:Description>
                <exif:UserComment>masterpiece, best quality&#xA;Steps: 28, Sampler: Euler a</exif:UserComment>
                <tiff:Software>Stable Diffusion WebUI</tiff:Software>
            </rdf:Description></rdf:RDF></x:xmpmeta>"#;
            let xmp_bytes = xmp_xml.as_bytes();
            let chunk_size = xmp_bytes.len() as u32;
            let riff_size = 4 + 8 + chunk_size + (chunk_size % 2);

            let mut webp_bytes = Vec::new();
            webp_bytes.extend_from_slice(b"RIFF");
            webp_bytes.extend_from_slice(&riff_size.to_le_bytes());
            webp_bytes.extend_from_slice(b"WEBP");
            webp_bytes.extend_from_slice(b"XMP ");
            webp_bytes.extend_from_slice(&chunk_size.to_le_bytes());
            webp_bytes.extend_from_slice(xmp_bytes);
            if chunk_size % 2 != 0 {
                webp_bytes.push(0);
            }
            std::fs::write(&webp_path, webp_bytes).unwrap();
        }

        let webp_meta = parse_webp_exif(webp_path.to_str().unwrap());
        assert_eq!(
            String::from_utf8_lossy(webp_meta.get("UserComment").unwrap()),
            "masterpiece, best quality\nSteps: 28, Sampler: Euler a"
        );
        assert_eq!(
            String::from_utf8_lossy(webp_meta.get("Software").unwrap()),
            "Stable Diffusion WebUI"
        );
    }

    #[test]
    fn test_parse_jpeg_com_segment_novelai_metadata() {
        let temp_dir = tempfile::tempdir().unwrap();
        let jpg_path = temp_dir.path().join("novelai_v5_sample.jpg");

        // ユーザー提示の NovelAI Diffusion V5 メタデータ JSON
        let json_text = r#"{"prompt": "nsfw,, black and white manga, monochrome, single panel, 1girl, 1boy, sex\nA girl bent over a table on the right. Behind her, the same man is shown twice, in two different positions.\n\n\nfrom side\n\n,,kindatsu,0.5::,na_tarapisu153 ::,,healthyman,0.8::nekomugiharu :: ,miyajima_reiji,year 2025, ,,, best quality, amazing quality, very aesthetic, highres, incredibly absurdres,::depthness::,,monochrome,1.3::,greyscale :: ,,1.4::,halftone,dithering,halftone dots, screentone, manga screentone, dot pattern, , printed manga, inked manga::, \n", "steps": 28, "height": 1024, "width": 1024, "scale": 6.0, "uncond_scale": 0.0, "cfg_rescale": 0.2, "seed": 364751580, "n_samples": 1, "noise_schedule": "karras", "legacy_v3_extend": false, "v4_prompt": {"caption": {"base_caption": "nsfw,, black and white manga, monochrome, single panel, 1girl, 1boy, sex\nA girl bent over a table on the right. Behind her, the same man is shown twice, in two different positions.\n\n\nfrom side\n\n,,kindatsu,0.5::,na_tarapisu153 ::,,healthyman,0.8::nekomugiharu :: ,miyajima_reiji,year 2025, ,,, best quality, amazing quality, very aesthetic, highres, incredibly absurdres,::depthness::,,monochrome,1.3::,greyscale :: ,,1.4::,halftone,dithering,halftone dots, screentone, manga screentone, dot pattern, , printed manga, inked manga::, \n", "char_captions": [{"char_caption": "girl, long black hair, nude, bent over, leaning on a table\n\n\n\n\n\n\n\n\n\n", "centers": [{"x": 0.632, "y": 0.562}]}, {"char_caption": "boy, nude. leaning back, his upper body tilted back, his hips far behind, his knees bent, stepping back, pulling out., his hips pushed forward close to the girl, thrusting in deeply.\n\n\n\n\n\n\n", "centers": [{"x": 0.255, "y": 0.488}]}, {"char_caption": "boy, nude, afterimage, semi-transparent. He stands away from the girl, leaning back, his upper body tilted back, his hips far behind, his knees bent, stepping back, pulling out. His head is bent forward, chin down, his face turned toward the girl, looking down at her.\n\n\n\n\n\n\n\n\n\n\n\n\n", "centers": [{"x": 0.315, "y": 0.514}]}]}, "use_coords": true, "use_order": true, "legacy_uc": false}, "v4_negative_prompt": {"caption": {"base_caption": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, {{{{rating:general}}}},,{{bkub ,text ,food,headwear,animal ear,character_doll,animal, ,}} , {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], {{,text,stamp,signature}},,text,,speach,lowres,{bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, , worst quality,,bad anatomy,jpeg artifacts,\n", "char_captions": [{"char_caption": "", "centers": [{"x": 0.632, "y": 0.562}]}, {"char_caption": "\n", "centers": [{"x": 0.255, "y": 0.488}]}, {"char_caption": "\n\n", "centers": [{"x": 0.315, "y": 0.514}]}]}, "use_coords": false, "use_order": false, "legacy_uc": false}, "sampler": "k_euler_ancestral", "version": 1, "uc": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, {{{{rating:general}}}},,{{bkub ,text ,food,headwear,animal ear,character_doll,animal, ,}} , {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], {{,text,stamp,signature}},,text,,speach,lowres,{bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, , worst quality,,bad anatomy,jpeg artifacts,\n", "request_type": "PromptGenerateRequest", "model_name": "NovelAI Diffusion V5", "model_hash": "0ADF9AB7", "signed_hash": "x7F2zd811gvqVWkBoODgNFCETl37wR96arbHbP+fhfsjTeOTGPO4WC8P50jzMVeCbsrvhIXHQIu8KYCLGvhXBQ=="}"#;

        let json_bytes = json_text.as_bytes();
        let com_seg_len = (json_bytes.len() + 2) as u16;

        // JPEG 構造の構築: SOI (FF D8) -> APP0 (JFIF) -> COM (FF FE) -> SOF0 (FF C0) -> EOI (FF D9)
        let mut jpg_bytes = Vec::new();
        jpg_bytes.extend_from_slice(&[0xFF, 0xD8]); // SOI

        // APP0 (JFIF)
        let jfif_payload = b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0";
        let jfif_len = (jfif_payload.len() + 2) as u16;
        jpg_bytes.extend_from_slice(&[0xFF, 0xE0]);
        jpg_bytes.extend_from_slice(&jfif_len.to_be_bytes());
        jpg_bytes.extend_from_slice(jfif_payload);

        // COM セグメント (FF FE)
        jpg_bytes.extend_from_slice(&[0xFF, 0xFE]);
        jpg_bytes.extend_from_slice(&com_seg_len.to_be_bytes());
        jpg_bytes.extend_from_slice(json_bytes);

        // SOF0 (Baseline DCT, 1024x1024)
        let sof0_payload = [0x08, 0x04, 0x00, 0x04, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
        let sof0_len = (sof0_payload.len() + 2) as u16;
        jpg_bytes.extend_from_slice(&[0xFF, 0xC0]);
        jpg_bytes.extend_from_slice(&sof0_len.to_be_bytes());
        jpg_bytes.extend_from_slice(&sof0_payload);

        // EOI (FF D9)
        jpg_bytes.extend_from_slice(&[0xFF, 0xD9]);

        std::fs::write(&jpg_path, jpg_bytes).unwrap();

        // 1. parse_jpeg_exif で COM セグメントが "Comment" として取得できること
        let exif_map = parse_jpeg_exif(jpg_path.to_str().unwrap());
        assert!(exif_map.contains_key("Comment"), "parse_jpeg_exif should extract COM segment as 'Comment'");
        let com_raw = exif_map.get("Comment").unwrap();
        assert_eq!(String::from_utf8_lossy(com_raw), json_text);

        // 2. get_full_metadata_for_path で完全なメタデータとしてパースできること
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute("CREATE TABLE cache (hash_key TEXT PRIMARY KEY, metadata TEXT, width INTEGER, height INTEGER, path TEXT, size INTEGER, mtime INTEGER, ctime INTEGER, last_accessed INTEGER, searchable_prompt TEXT, searchable_negative_prompt TEXT, searchable_source TEXT, metadata_source TEXT)", []).unwrap();
        }

        let (meta, mtime, _) = get_full_metadata_for_path(&jpg_path.to_string_lossy(), &pool);

        // プロンプトの抽出検証
        assert!(meta.prompt.starts_with("nsfw,, black and white manga"));
        // ネガティブプロンプト (uc) の抽出検証
        assert!(meta.negative_prompt.starts_with("blurry, lowres, error"));
        // 生成元モデル (model_name) の抽出検証
        assert_eq!(meta.source, "NovelAI Diffusion V5");
        assert_eq!(meta.metadata_source, "JPEG EXIF");

        // params 内の V4/V5 キャラクタープロンプトおよび座標情報
        let char_prompts = meta.params["characterPrompts"].as_array().expect("characterPrompts should be an array");
        assert_eq!(char_prompts.len(), 3, "3 characters should be extracted");
        assert!(char_prompts[0]["prompt"].as_str().unwrap().contains("girl, long black hair"));
        assert_eq!(meta.params["use_coords"].as_bool(), Some(true));

        // 数値パラメータの抽出検証
        assert_eq!(meta.params["steps"].as_u64(), Some(28));
        assert_eq!(meta.params["seed"].as_u64(), Some(364751580));
        assert_eq!(meta.params["sampler"].as_str(), Some("k_euler_ancestral"));
        assert_eq!(meta.params["request_type"].as_str(), Some("PromptGenerateRequest"));

        // 3. 過去バージョンでプロンプト空（None）として保存されたレガシーキャッシュの自己修復（セルフヒーリング）
        let hash_key = crate::utils::hash_path_mtime_hex(jpg_path.to_str().unwrap(), mtime);
        {
            let conn = pool.get().unwrap();
            // 古い仕様（jpegSchema 無し、プロンプト空）のレコードで cache テーブルを意図的に汚染
            let legacy_json = serde_json::json!({
                "path": jpg_path.to_str().unwrap(),
                "width": 1024,
                "height": 1024,
                "prompt": "",
                "negative_prompt": "",
                "params": {},
                "source": "",
                "metadata_source": "None"
            }).to_string();
            conn.execute(
                "UPDATE cache SET metadata = ?1, searchable_prompt = '', metadata_source = 'None' WHERE hash_key = ?2",
                rusqlite::params![legacy_json, hash_key],
            ).unwrap();
        }

        // 汚染後でも needs_jpeg_retry により早期リターンがスキップされ、ディスクから再解析されてプロンプトが復元されること
        let (repaired_meta, _, _) = get_full_metadata_for_path(&jpg_path.to_string_lossy(), &pool);
        assert!(repaired_meta.prompt.starts_with("nsfw,, black and white manga"), "レガシー空キャッシュから自動的に自己修復してプロンプトが再抽出されること");
        assert_eq!(repaired_meta.source, "NovelAI Diffusion V5");
        assert_eq!(repaired_meta.params["jpegSchema"].as_u64(), Some(1));

        // 4. マーカー長が壊れている等の異常セグメント配置でも、ファイル直接スキャンフォールバックによりプロンプトが抽出されること
        let fallback_jpg_path = temp_dir.path().join("fallback_scan.jpg");
        let mut malformed_jpg_bytes = Vec::new();
        malformed_jpg_bytes.extend_from_slice(&[0xFF, 0xD8]); // SOI
        // 不正なマーカーパディングや未知マーカー
        malformed_jpg_bytes.extend_from_slice(&[0xFF, 0xEE, 0x00, 0x04, 0x00, 0x00]);
        // 生の JSON をそのまま埋め込む
        malformed_jpg_bytes.extend_from_slice(json_bytes);
        malformed_jpg_bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        std::fs::write(&fallback_jpg_path, malformed_jpg_bytes).unwrap();

        let (fallback_meta, _, _) = get_full_metadata_for_path(&fallback_jpg_path.to_string_lossy(), &pool);
        assert!(fallback_meta.prompt.starts_with("nsfw,, black and white manga"), "直接スキャンフォールバックによりプロンプトが確実に抽出されること");
        assert_eq!(fallback_meta.source, "NovelAI Diffusion V5");
    }

    /// プロンプトを持たない PNG / WebP 画像における stealthSchema マーカー付与と
    /// 2回目以降のキャッシュ即時早期リターン、および旧レガシーキャッシュ（マーカー無し）の自己修復テスト
    #[test]
    fn test_promptless_image_stealth_schema_caching_and_repair() {
        let temp_dir = tempfile::tempdir().unwrap();
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
                    searchable_source TEXT DEFAULT '',
                    metadata_source TEXT DEFAULT ''
                )",
                [],
            )
            .unwrap();
        }

        // 1. プロンプトを持たない 1x1 PNG（metadata_source == "None"）
        let promptless_png = temp_dir.path().join("promptless.png");
        std::fs::write(&promptless_png, crate::audio::test_fixtures::SAMPLE_PNG_1X1).unwrap();
        let file_path = promptless_png.to_str().unwrap();
        let file_size = crate::audio::test_fixtures::SAMPLE_PNG_1X1.len() as u64;

        // 初回取得: キャッシュ未存在のためフル解析が実行され、stealthSchema: 1 が付与されて DB に保存される
        let (meta1, _, _, row1) = get_full_metadata_for_path_with_stat_inner(
            file_path, 1000, 1000, file_size, &db_conn, true,
        );
        assert_eq!(meta1.metadata_source, "None");
        assert!(meta1.prompt.is_empty());
        assert_eq!(
            meta1.params.get("stealthSchema").and_then(|v| v.as_u64()),
            Some(STEALTH_SCHEMA_VERSION),
            "フル解析完了時に stealthSchema が params に付与されること"
        );
        assert!(row1.is_some(), "初回は新規キャッシュ行が生成されること");

        // 2回目取得: stealthSchema == 1 が存在するため needs_stealth_retry が false となり、
        // キャッシュから即座に早期リターンされること（row == None）
        let (meta2, _, _, row2) = get_full_metadata_for_path_with_stat_inner(
            file_path, 1000, 1000, file_size, &db_conn, true,
        );
        assert_eq!(meta2.metadata_source, "None");
        assert!(meta2.prompt.is_empty());
        assert_eq!(
            meta2.params.get("stealthSchema").and_then(|v| v.as_u64()),
            Some(STEALTH_SCHEMA_VERSION)
        );
        assert!(row2.is_none(), "2回目はキャッシュから早期リターンし、再解析・再保存が行われないこと");

        // 2. stealthSchema マーカーを持たない過去のキャッシュ（自己修復が必要なレガシーキャッシュ行）のテスト
        let legacy_png = temp_dir.path().join("legacy.png");
        std::fs::write(&legacy_png, crate::audio::test_fixtures::SAMPLE_PNG_1X1).unwrap();
        let legacy_path = legacy_png.to_str().unwrap();
        let legacy_size = crate::audio::test_fixtures::SAMPLE_PNG_1X1.len() as i64;
        let legacy_hash = crate::utils::hash_path_mtime_hex(legacy_path, 2000);
        {
            let conn = db_conn.get().unwrap();
            let legacy_meta = serde_json::to_string(&FullMetadata {
                path: legacy_path.to_string(),
                width: 1,
                height: 1,
                prompt: String::new(),
                negative_prompt: String::new(),
                params: serde_json::json!({}),
                source: String::new(),
                metadata_source: "None".to_string(),
            })
            .unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, metadata_source) VALUES (?, ?, 1, 1, ?, ?, 2000, 2000, 0, 'None')",
                rusqlite::params![legacy_hash, legacy_meta, legacy_path, legacy_size],
            )
            .unwrap();
        }

        // 初回取得: stealthSchema が無いため needs_stealth_retry が true となり再解析が走る
        let (re_parsed, _, _, row_reparsed) = get_full_metadata_for_path_with_stat_inner(
            legacy_path, 2000, 2000, legacy_size as u64, &db_conn, true,
        );
        assert_eq!(
            re_parsed.params.get("stealthSchema").and_then(|v| v.as_u64()),
            Some(STEALTH_SCHEMA_VERSION),
            "再解析時に stealthSchema が自己修復で付与されること"
        );
        assert!(row_reparsed.is_some(), "再解析が行われ、キャッシュが更新されること");

        // 2回目取得: 再解析により stealthSchema: 1 が DB に保存されたため、2回目は早期リターンすること
        let (cached_repaired, _, _, row_cached) = get_full_metadata_for_path_with_stat_inner(
            legacy_path, 2000, 2000, legacy_size as u64, &db_conn, true,
        );
        assert_eq!(
            cached_repaired.params.get("stealthSchema").and_then(|v| v.as_u64()),
            Some(STEALTH_SCHEMA_VERSION)
        );
        assert!(row_cached.is_none(), "自己修復後はキャッシュから即時早期リターンすること");

        // 3. プロンプトを持つ通常の画像は従来通りキャッシュから早期リターンすること
        let prompt_png = temp_dir.path().join("has_prompt.png");
        std::fs::write(&prompt_png, crate::audio::test_fixtures::SAMPLE_PNG_1X1).unwrap();
        let prompt_path = prompt_png.to_str().unwrap();
        let prompt_hash = crate::utils::hash_path_mtime_hex(prompt_path, 3000);
        {
            let conn = db_conn.get().unwrap();
            let prompt_meta = serde_json::to_string(&FullMetadata {
                path: prompt_path.to_string(),
                width: 1,
                height: 1,
                prompt: "1girl, solo, masterpiece".to_string(),
                negative_prompt: "worst quality".to_string(),
                params: serde_json::json!({}),
                source: "NovelAI".to_string(),
                metadata_source: "PNG Chunks".to_string(),
            })
            .unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, metadata, width, height, path, size, mtime, ctime, last_accessed, metadata_source) VALUES (?, ?, 1, 1, ?, ?, 3000, 3000, 0, 'PNG Chunks')",
                rusqlite::params![prompt_hash, prompt_meta, prompt_path, legacy_size],
            )
            .unwrap();
        }

        let (meta_prompt, _, _, row_prompt) = get_full_metadata_for_path_with_stat_inner(
            prompt_path, 3000, 3000, legacy_size as u64, &db_conn, true,
        );
        assert_eq!(meta_prompt.prompt, "1girl, solo, masterpiece");
        assert!(row_prompt.is_none(), "プロンプトを持つ画像はキャッシュから即時早期リターンすること");
    }

    #[test]
    fn test_parse_metadata_updates_state_meta_loaded_and_unified_search_text() {
        tauri::async_runtime::block_on(async {
            let temp_dir = tempfile::tempdir().unwrap();
            let test_png = temp_dir.path().join("parsed_sample.png");

            let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
            let mut ihdr_data = Vec::new();
            ihdr_data.extend_from_slice(&64u32.to_be_bytes());
            ihdr_data.extend_from_slice(&128u32.to_be_bytes());
            ihdr_data.push(8);
            ihdr_data.push(6);
            ihdr_data.extend_from_slice(&[0, 0, 0]);
            png_bytes.extend_from_slice(&(ihdr_data.len() as u32).to_be_bytes());
            png_bytes.extend_from_slice(b"IHDR");
            png_bytes.extend_from_slice(&ihdr_data);
            png_bytes.extend_from_slice(&[0, 0, 0, 0]);

            let mut text_data = Vec::new();
            text_data.extend_from_slice(b"Description\0cyberpunk city, glowing neon");
            png_bytes.extend_from_slice(&(text_data.len() as u32).to_be_bytes());
            png_bytes.extend_from_slice(b"tEXt");
            png_bytes.extend_from_slice(&text_data);
            png_bytes.extend_from_slice(&[0, 0, 0, 0]);

            png_bytes.extend_from_slice(&0u32.to_be_bytes());
            png_bytes.extend_from_slice(b"IEND");
            png_bytes.extend_from_slice(&[0, 0, 0, 0]);

            std::fs::write(&test_png, &png_bytes).unwrap();
            let file_path = test_png.to_str().unwrap().to_string();

            let state = create_test_app_state(temp_dir.path().to_str().unwrap());
            let img_file = ImageFile {
                name: "parsed_sample.png".to_string(),
                ext: ".png".into(),
                path: file_path.clone(),
                size: png_bytes.len() as u64,
                mtime: 1000,
                ctime: 1000,
                has_thumbnail_cache: false,
                width: 0,
                height: 0,
                prompt: String::new(),
                negative_prompt: String::new(),
                source: String::new(),
                meta_loaded: false,
                search_text: String::new(),
                unified_search_text: String::new(),
                hash_key: Default::default(),
            };

            {
                let mut all_files = state.all_files.write();
                let mut all_idx = state.path_to_all_idx.write();
                all_files.push(std::sync::Arc::new(img_file));
                all_idx.insert(file_path.clone(), 0);
            }

            // 初期状態の検証: meta_loaded は false, unified_search_text は空
            {
                let all_files = state.all_files.read();
                assert!(!all_files[0].meta_loaded);
                assert!(all_files[0].unified_search_text.is_empty());
            }

            // parse_metadata_inner を実行
            let res = parse_metadata_inner(&state, file_path.clone()).await.unwrap();
            assert_eq!(res.width, 64);
            assert_eq!(res.height, 128);
            assert_eq!(res.prompt, "cyberpunk city, glowing neon");

            // parse_metadata 実行後の state 検証: meta_loaded が true に更新され、unified_search_text にプロンプトが含まれること
            {
                let all_files = state.all_files.read();
                assert!(all_files[0].meta_loaded, "state の meta_loaded が true に同期更新されること");
                assert_eq!(all_files[0].width, 64);
                assert_eq!(all_files[0].height, 128);
                assert_eq!(all_files[0].prompt, "cyberpunk city, glowing neon");
                assert!(
                    all_files[0].unified_search_text.contains("cyberpunk city"),
                    "unified_search_text に抽出プロンプトが含まれていること"
                );
            }
        });
    }
}
