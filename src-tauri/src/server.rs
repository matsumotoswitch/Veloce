use crate::models::DbMsg;
use crate::state::AppState;
use crate::utils::normalize_unc_path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeSpec {
    EmptyFile,
    NotSatisfiable,
    Satisfiable {
        start: u64,
        end: u64,
        chunk_size: u64,
        is_partial: bool,
    },
}

/// HTTP Range ヘッダーとファイルサイズに基づき、配信すべきバイト範囲とチャンク長を算出します。
/// - クライアント要求の end をファイル末尾（file_size - 1）で厳格にクランプし、クライアントの待機フリーズを防止。
/// - 開始位置がファイル長を超える場合は 416 Not Satisfiable を返却。
/// - 空ファイル（file_size == 0）および Range 指定なし時の 2MB 部分配信（206 Partial Content）に対応。
pub fn calculate_range(range_header: Option<&str>, file_size: u64, max_chunk: u64) -> RangeSpec {
    if file_size == 0 {
        return RangeSpec::EmptyFile;
    }

    let mut start: u64 = 0;
    let mut end: u64 = file_size - 1;
    let mut is_partial = false;

    if let Some(range) = range_header {
        let trimmed = range.trim();
        if trimmed.starts_with("bytes=") {
            let bytes_spec = &trimmed["bytes=".len()..];
            let parts: Vec<&str> = bytes_spec.split('-').collect();
            if parts.len() == 2 {
                if parts[0].is_empty() && !parts[1].is_empty() {
                    // Suffix byte range: e.g. "bytes=-500"
                    if let Ok(suffix_len) = parts[1].trim().parse::<u64>() {
                        if suffix_len == 0 {
                            return RangeSpec::NotSatisfiable;
                        }
                        start = file_size.saturating_sub(suffix_len);
                        end = file_size - 1;
                        is_partial = true;
                    } else {
                        return RangeSpec::NotSatisfiable;
                    }
                } else if !parts[0].is_empty() {
                    if let Ok(s) = parts[0].trim().parse::<u64>() {
                        if s >= file_size {
                            return RangeSpec::NotSatisfiable;
                        }
                        start = s;
                        if !parts[1].is_empty() {
                            if let Ok(e) = parts[1].trim().parse::<u64>() {
                                end = std::cmp::min(e, file_size - 1);
                            } else {
                                return RangeSpec::NotSatisfiable;
                            }
                        } else {
                            end = file_size - 1;
                        }
                        if start > end {
                            return RangeSpec::NotSatisfiable;
                        }
                        is_partial = true;
                    } else {
                        return RangeSpec::NotSatisfiable;
                    }
                }
            }
        }
    }

    let available = end.saturating_sub(start) + 1;
    let chunk_size = std::cmp::min(available, max_chunk);
    let actual_end = start + chunk_size - 1;

    // chunk_size がファイル全体より小さい場合は 2MB メモリ保護のため 206 Partial Content として配信
    if chunk_size < file_size {
        is_partial = true;
    }

    RangeSpec::Satisfiable {
        start,
        end: actual_end,
        chunk_size,
        is_partial,
    }
}

/// タイミング攻撃を防ぐため、一定時間でバイト列を比較します。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut res = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        res |= x ^ y;
    }
    res == 0
}

/// 改行を含まない巨大データによるメモリ枯渇を防ぐため、1行あたりの最大バイト数を制限して読み取ります。
pub fn read_line_bounded<R: std::io::BufRead>(
    reader: &mut R,
    buf: &mut String,
    max_bytes: u64,
) -> std::io::Result<usize> {
    use std::io::{BufRead, Read};
    reader.take(max_bytes).read_line(buf)
}

#[tauri::command]
pub fn get_video_server_port(state: tauri::State<'_, AppState>) -> u16 {
    state.video_server_port
}

#[tauri::command]
pub fn get_video_server_token(state: tauri::State<'_, AppState>) -> String {
    state.video_server_token.clone()
}

/// `hash=` パラメータの有無に応じて GET メディア応答の `Cache-Control` ヘッダ値を決定する。
/// `hash=` 付き URL は path+mtime 依存で内容不変のため `immutable` を付与する。
pub(crate) fn select_media_cache_control(has_hash: bool) -> &'static str {
    if has_hash {
        "public, max-age=86400, immutable"
    } else {
        "public, max-age=3600"
    }
}

/// バイナリメディア（サムネイル / カバー画像）の HTTP GET 応答バイト列（ヘッダ＋本文）を単一バッファに構築する。
pub(crate) fn build_media_get_response(
    mimetype: &str,
    cache_control: &str,
    close_connection: bool,
    body: &[u8],
) -> Vec<u8> {
    use std::fmt::Write;
    let mut header = String::with_capacity(192);
    header.push_str("HTTP/1.1 200 OK\r\n");
    header.push_str("Content-Type: ");
    header.push_str(mimetype);
    header.push_str("\r\n");
    header.push_str("Access-Control-Allow-Origin: *\r\n");
    header.push_str("Cache-Control: ");
    header.push_str(cache_control);
    header.push_str("\r\n");
    if close_connection {
        header.push_str("Connection: close\r\n");
    }
    let _ = write!(header, "Content-Length: {}\r\n\r\n", body.len());

    let mut response = Vec::with_capacity(header.len() + body.len());
    response.extend_from_slice(header.as_bytes());
    response.extend_from_slice(body);
    response
}

/// POST /save-thumbnail において実ファイルの stat を優先し、AppState のキャッシュと同期した最新の mtime を解決する。
pub(crate) fn resolve_save_thumbnail_mtime_with_state(
    state_opt: Option<&AppState>,
    path_str: &str,
    input_mtime: u64,
) -> u64 {
    if input_mtime != 0 {
        return input_mtime;
    }
    if let Some(state) = state_opt {
        if let Some(mt) = crate::thumbnail::resolve_and_sync_file_mtime(state, path_str) {
            return mt;
        }
    }
    let clean = crate::utils::normalize_unc_path(path_str);
    std::fs::metadata(path_str)
        .or_else(|_| std::fs::metadata(clean.as_ref()))
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn start_local_video_server(
    db_tx: tokio::sync::mpsc::Sender<DbMsg>,
    app_handle_slot: std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
    db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    token: String,
) -> u16 {
    use std::fs::File;
    use std::io::{BufReader, Read, Seek, SeekFrom, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind local video server");
    let port = listener.local_addr().unwrap().port();

    // 高速スクロール時のキャッシュ済みサムネイル配信や動画チャンク配信で、
    // リクエストごとのOSスレッド生成・破棄オーバーヘッドを排除するための専用ワーカースレッドプール
    let http_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(8)
        .thread_name(|i| format!("veloce-http-{}", i))
        .build()
        .expect("Failed to build local HTTP server thread pool");

    let token = std::sync::Arc::new(token);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
                let db_tx = db_tx.clone();
                let app_handle_slot = app_handle_slot.clone();
                let db_conn = db_conn.clone();
                let token = token.clone();
                http_pool.spawn(move || {
                    const MAX_HEADER_LINE_BYTES: u64 = 8192;
                    const MAX_HEADER_LINES: usize = 64;
                    const MAX_KEEP_ALIVE_REQUESTS: usize = 100;

                    let mut reader = BufReader::new(stream);
                    let mut request_count: usize = 0;

                    loop {
                        if request_count > 0 {
                            // 2リクエスト目以降の待機ではアイドルタイムアウトを3秒に短縮し、スレッドプール長期占有を防ぐ
                            let _ = reader.get_mut().set_read_timeout(Some(std::time::Duration::from_secs(3)));
                        }
                        request_count += 1;

                        let mut request_line = String::new();
                        if read_line_bounded(&mut reader, &mut request_line, MAX_HEADER_LINE_BYTES).is_err()
                            || request_line.is_empty()
                        {
                            return;
                        }

                        let parts: Vec<&str> = request_line.split_whitespace().collect();
                        if parts.len() < 2 {
                            return;
                        }
                        let method = parts[0];
                        let uri = parts[1];

                        if method == "OPTIONS" {
                            for _ in 0..MAX_HEADER_LINES {
                                let mut header_line = String::new();
                                if read_line_bounded(&mut reader, &mut header_line, MAX_HEADER_LINE_BYTES).is_err() {
                                    break;
                                }
                                if header_line.trim().is_empty() {
                                    break;
                                }
                            }
                            let mut headers = String::new();
                            headers.push_str("HTTP/1.1 200 OK\r\n");
                            headers.push_str("Access-Control-Allow-Origin: *\r\n");
                            headers.push_str("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
                            headers.push_str("Access-Control-Allow-Headers: Range, Content-Type, Content-Length, Access-Control-Request-Private-Network\r\n");
                            headers.push_str("Access-Control-Allow-Private-Network: true\r\n");
                            headers.push_str("Access-Control-Max-Age: 86400\r\n");
                            headers.push_str("Content-Length: 0\r\n");
                            headers.push_str("Connection: close\r\n\r\n");
                            let _ = reader.get_mut().write_all(headers.as_bytes());
                            let _ = reader.get_mut().flush();
                            return;
                        }

                        // トークン認証: 外部Webサイトや他プロセスからの不正リクエストをリクエストごとに毎回遮断する
                        if !token.is_empty() {
                            let mut req_token = "";
                            if let Some(query) = uri.split('?').nth(1) {
                                for pair in query.split('&') {
                                    if pair.starts_with("token=") {
                                        req_token = &pair[6..];
                                    }
                                }
                            }
                            if !constant_time_eq(req_token.as_bytes(), token.as_bytes()) {
                                let resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden";
                                let _ = reader.get_mut().write_all(resp.as_bytes());
                                return;
                            }
                        }

                        // POST /save-thumbnail?path=...[&mtime=...]
                        // 生のバイナリBlobを直接受け取り、Base64デコードのオーバーヘッドなしでSQLiteへ非同期投入する（1リクエストで終了）
                        if method == "POST" && uri.starts_with("/save-thumbnail") {
                            let mut path_str = String::new();
                            let mut mtime: u64 = 0;
                            if let Some(query) = uri.split('?').nth(1) {
                                for pair in query.split('&') {
                                    if pair.starts_with("path=") {
                                        path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                                    } else if pair.starts_with("mtime=") {
                                        mtime = pair[6..].parse().unwrap_or(0);
                                    }
                                }
                            }

                            if path_str.is_empty() {
                                let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                return;
                            }

                            let mut content_length: usize = 0;
                            for _ in 0..MAX_HEADER_LINES {
                                let mut header_line = String::new();
                                if read_line_bounded(&mut reader, &mut header_line, MAX_HEADER_LINE_BYTES).is_err() {
                                    break;
                                }
                                let trimmed = header_line.trim();
                                if trimmed.is_empty() {
                                    break;
                                }
                                let lower = trimmed.to_lowercase();
                                if lower.starts_with("content-length:") {
                                    content_length = lower["content-length:".len()..].trim().parse().unwrap_or(0);
                                }
                            }

                            // サムネイルバイナリは最大10MBを上限として安全確認
                            if content_length == 0 || content_length > 10 * 1024 * 1024 {
                                let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                return;
                            }

                            let mut body = vec![0u8; content_length];
                            if reader.read_exact(&mut body).is_err() {
                                let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                return;
                            }

                            if mtime == 0 {
                                use tauri::Manager;
                                if let Ok(handle_guard) = app_handle_slot.lock() {
                                    if let Some(app_handle) = handle_guard.as_ref() {
                                        let state = app_handle.state::<AppState>();
                                        mtime = resolve_save_thumbnail_mtime_with_state(Some(&state), &path_str, mtime);
                                    } else {
                                        mtime = resolve_save_thumbnail_mtime_with_state(None, &path_str, mtime);
                                    }
                                } else {
                                    mtime = resolve_save_thumbnail_mtime_with_state(None, &path_str, mtime);
                                }
                            }

                            let clean_path = crate::utils::normalize_unc_path(&path_str).into_owned();
                            let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, mtime);
                            let hash_key_for_url = hash_key.clone();

                            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                            if db_tx
                                .try_send(DbMsg::SaveThumbnail {
                                    hash_key,
                                    path: clean_path.clone(),
                                    mtime,
                                    bytes: body,
                                    now,
                                })
                                .is_err()
                            {
                                // チャネル満杯・切断時はブロックせず 503 を返し、フロントエンド側の IPC フォールバック保存へ委譲する
                                let resp = "HTTP/1.1 503 Service Unavailable\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                let _ = reader.get_mut().write_all(resp.as_bytes());
                                let _ = reader.get_mut().flush();
                                return;
                            }

                            // AppState のメモリ上キャッシュフラグを即時反映（キューへの投入が成功した場合のみ）
                            {
                                use tauri::Manager;
                                if let Ok(handle_guard) = app_handle_slot.lock() {
                                    if let Some(app_handle) = handle_guard.as_ref() {
                                        let state = app_handle.state::<AppState>();
                                        state.mark_thumbnail_cached(&path_str);
                                    }
                                }
                            }

                            let token_param = if token.is_empty() { String::new() } else { format!("&token={}", *token) };
                            let saved_url = format!(
                                "http://127.0.0.1:{}/?path={}&mtime={}&thumb=1&hash={}{}",
                                port,
                                urlencoding::encode(&path_str),
                                mtime,
                                hash_key_for_url,
                                token_param
                            );
                            let mut resp = String::new();
                            resp.push_str("HTTP/1.1 200 OK\r\n");
                            resp.push_str("Content-Type: text/plain; charset=utf-8\r\n");
                            resp.push_str("Access-Control-Allow-Origin: *\r\n");
                            resp.push_str(&format!("Content-Length: {}\r\n", saved_url.len()));
                            resp.push_str("Connection: close\r\n\r\n");
                            resp.push_str(&saved_url);
                            let _ = reader.get_mut().write_all(resp.as_bytes());
                            let _ = reader.get_mut().flush();
                            return;
                        }

                        let mut path_str = String::new();
                        let mut is_thumb = false;
                        let mut is_cover = false;
                        let mut mtime: u64 = 0;
                        let mut hash_param = String::new();
                        if let Some(query) = uri.split('?').nth(1) {
                            for pair in query.split('&') {
                                if pair.starts_with("path=") {
                                    path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                                } else if pair.starts_with("thumb=1") {
                                    is_thumb = true;
                                } else if pair.starts_with("cover=1") {
                                    is_cover = true;
                                } else if pair.starts_with("mtime=") {
                                    mtime = pair[6..].parse().unwrap_or(0);
                                } else if pair.starts_with("hash=") {
                                    hash_param = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                                }
                            }
                        }

                        if path_str.is_empty() && hash_param.is_empty() {
                            let _ = reader.get_mut().write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            return;
                        }

                        let mut range_header = None;
                        let mut client_wants_close = false;
                        for _ in 0..MAX_HEADER_LINES {
                            let mut header_line = String::new();
                            if read_line_bounded(&mut reader, &mut header_line, MAX_HEADER_LINE_BYTES).is_err() {
                                return;
                            }
                            let trimmed = header_line.trim();
                            if trimmed.is_empty() {
                                break;
                            }
                            let lower = trimmed.to_ascii_lowercase();
                            if lower.starts_with("connection:")
                                && lower["connection:".len()..].split(',').any(|v| v.trim() == "close")
                            {
                                client_wants_close = true;
                            } else if !is_cover && !is_thumb && lower.starts_with("range:") {
                                range_header = Some(trimmed[6..].trim().to_string());
                            }
                        }

                        let close_connection = client_wants_close || request_count >= MAX_KEEP_ALIVE_REQUESTS;

                        if is_cover {
                            if !crate::audio::is_audio_path(&path_str) {
                                let _ = reader.get_mut().write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                return;
                            }

                            let write_ok = if let Some(cover_bytes) = crate::audio::extract_audio_cover_cached(&path_str) {
                                let mimetype = if cover_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                                    "image/png"
                                } else {
                                    "image/jpeg"
                                };
                                let cache_control = select_media_cache_control(!hash_param.is_empty());
                                let response = build_media_get_response(mimetype, cache_control, close_connection, &cover_bytes);
                                reader.get_mut().write_all(&response).is_ok() && reader.get_mut().flush().is_ok()
                            } else {
                                let not_found = if close_connection {
                                    "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                                } else {
                                    "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n"
                                };
                                reader.get_mut().write_all(not_found.as_bytes()).is_ok() && reader.get_mut().flush().is_ok()
                            };

                            if !write_ok || close_connection {
                                return;
                            }
                            continue;
                        }

                        if is_thumb {
                            let mut cache_bytes = Vec::new();
                            if let Ok(conn) = db_conn.get() {
                                // 1. hash_param が指定されていれば PRIMARY KEY (hash_key) で O(1) 直撃取得（最速パス）
                                if !hash_param.is_empty() {
                                    if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL") {
                                        if let Ok(thumb) = stmt.query_row([&hash_param], |row| row.get::<_, Vec<u8>>(0)) {
                                            cache_bytes = thumb;
                                        }
                                    }
                                }

                                // 2. hash_param 未指定またはミス時は、正規化された UNC パス等から算出した複数ハッシュキー候補で検索
                                if cache_bytes.is_empty() && !path_str.is_empty() {
                                    let norm_unc = normalize_unc_path(&path_str).into_owned();
                                    let stripped = if path_str.starts_with(r"\\?\") { &path_str[4..] } else { path_str.as_str() };
                                    let hash_norm = crate::utils::hash_path_mtime_hex(&norm_unc, mtime);
                                    let hash_strip = crate::utils::hash_path_mtime_hex(stripped, mtime);
                                    let hash_raw = crate::utils::hash_path_mtime_hex(&path_str, mtime);

                                    if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE (hash_key = ? OR hash_key = ? OR hash_key = ?) AND thumbnail IS NOT NULL LIMIT 1") {
                                        if let Ok(thumb) = stmt.query_row([&hash_norm, &hash_strip, &hash_raw], |row| row.get::<_, Vec<u8>>(0)) {
                                            cache_bytes = thumb;
                                        }
                                    }
                                }
                            }

                            // 未キャッシュの場合、同期生成でHTTPスレッドをブロックせず即座に404を返す。
                            // フロントエンド側の img.onerror から通常の OffscreenCanvas Web Worker へ安全にフォールバックされる
                            let write_ok = if !cache_bytes.is_empty() {
                                let mimetype = if cache_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                                    "image/png"
                                } else if cache_bytes.starts_with(b"RIFF") && cache_bytes.len() >= 12 && &cache_bytes[8..12] == b"WEBP" {
                                    "image/webp"
                                } else if cache_bytes.starts_with(&[0x3C, 0x3F, 0x78, 0x6D, 0x6C]) || cache_bytes.starts_with(&[0x3C, 0x73, 0x76, 0x67]) {
                                    "image/svg+xml"
                                } else {
                                    "image/jpeg"
                                };

                                let cache_control = select_media_cache_control(!hash_param.is_empty());
                                let response = build_media_get_response(mimetype, cache_control, close_connection, &cache_bytes);
                                reader.get_mut().write_all(&response).is_ok() && reader.get_mut().flush().is_ok()
                            } else {
                                let not_found = if close_connection {
                                    "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                                } else {
                                    "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n"
                                };
                                reader.get_mut().write_all(not_found.as_bytes()).is_ok() && reader.get_mut().flush().is_ok()
                            };

                            if !write_ok || close_connection {
                                return;
                            }
                            continue;
                        }

                        let ext = std::path::Path::new(&path_str).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        // 動画・アニメーション・音声配信対象の拡張子ホワイトリスト検証
                        let is_audio = crate::audio::is_audio_extension(&ext);
                        if !is_audio && !matches!(ext.as_str(), "mp4" | "webm" | "gif" | "avi" | "mkv" | "mov") {
                            let _ = reader.get_mut().write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            return;
                        }

                        let mut stream = reader.into_inner();
                        if let Ok(mut file) = File::open(&path_str) {
                            if let Ok(metadata) = file.metadata() {
                                let file_size = metadata.len();
                                let max_chunk: u64 = 2 * 1024 * 1024;
                                let content_type = if is_audio {
                                    crate::audio::audio_content_type(&ext)
                                } else {
                                    match ext.as_str() {
                                        "webm" => "video/webm",
                                        "gif" => "image/gif",
                                        _ => "video/mp4",
                                    }
                                };

                                match calculate_range(range_header.as_deref(), file_size, max_chunk) {
                                    RangeSpec::EmptyFile => {
                                        let mut headers = String::new();
                                        headers.push_str("HTTP/1.1 200 OK\r\n");
                                        headers.push_str(&format!("Content-Type: {}\r\n", content_type));
                                        headers.push_str("Content-Length: 0\r\n");
                                        headers.push_str("Accept-Ranges: bytes\r\n");
                                        headers.push_str("Access-Control-Allow-Origin: *\r\n");
                                        headers.push_str("Connection: close\r\n\r\n");
                                        let _ = stream.write_all(headers.as_bytes());
                                        return;
                                    }
                                    RangeSpec::NotSatisfiable => {
                                        let mut headers = String::new();
                                        headers.push_str("HTTP/1.1 416 Range Not Satisfiable\r\n");
                                        headers.push_str(&format!("Content-Range: bytes */{}\r\n", file_size));
                                        headers.push_str("Content-Length: 0\r\n");
                                        headers.push_str("Access-Control-Allow-Origin: *\r\n");
                                        headers.push_str("Connection: close\r\n\r\n");
                                        let _ = stream.write_all(headers.as_bytes());
                                        return;
                                    }
                                    RangeSpec::Satisfiable { start, end, chunk_size, is_partial } => {
                                        let mut headers = String::new();
                                        if is_partial {
                                            headers.push_str("HTTP/1.1 206 Partial Content\r\n");
                                            headers.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, end, file_size));
                                        } else {
                                            headers.push_str("HTTP/1.1 200 OK\r\n");
                                        }
                                        headers.push_str(&format!("Content-Type: {}\r\n", content_type));
                                        headers.push_str("Accept-Ranges: bytes\r\n");
                                        headers.push_str("Access-Control-Allow-Origin: *\r\n");
                                        headers.push_str(&format!("Content-Length: {}\r\n", chunk_size));
                                        headers.push_str("Connection: close\r\n\r\n");

                                        if stream.write_all(headers.as_bytes()).is_ok() {
                                            if file.seek(SeekFrom::Start(start)).is_ok() {
                                                let mut handle = file.take(chunk_size);
                                                let _ = std::io::copy(&mut handle, &mut stream);
                                            }
                                        }
                                        return;
                                    }
                                }
                            }
                        }
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    }
                });
            }
        }
    });

    port
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_range_empty_file() {
        let res = calculate_range(None, 0, 2 * 1024 * 1024);
        assert_eq!(res, RangeSpec::EmptyFile);

        let res_with_header = calculate_range(Some("bytes=0-100"), 0, 2 * 1024 * 1024);
        assert_eq!(res_with_header, RangeSpec::EmptyFile);
    }

    #[test]
    fn test_calculate_range_no_header_small_file() {
        let res = calculate_range(None, 500, 2 * 1024 * 1024);
        assert_eq!(
            res,
            RangeSpec::Satisfiable {
                start: 0,
                end: 499,
                chunk_size: 500,
                is_partial: false,
            }
        );
    }

    #[test]
    fn test_calculate_range_no_header_large_file() {
        let max_chunk = 2 * 1024 * 1024;
        let file_size = 10 * 1024 * 1024;
        let res = calculate_range(None, file_size, max_chunk);
        assert_eq!(
            res,
            RangeSpec::Satisfiable {
                start: 0,
                end: max_chunk - 1,
                chunk_size: max_chunk,
                is_partial: true,
            }
        );
    }

    #[test]
    fn test_calculate_range_clamped_end() {
        let file_size = 100;
        let res = calculate_range(Some("bytes=0-9999"), file_size, 2 * 1024 * 1024);
        assert_eq!(
            res,
            RangeSpec::Satisfiable {
                start: 0,
                end: 99,
                chunk_size: 100,
                is_partial: true,
            }
        );
    }

    #[test]
    fn test_calculate_range_out_of_bounds_start() {
        let file_size = 100;
        let res = calculate_range(Some("bytes=500-600"), file_size, 2 * 1024 * 1024);
        assert_eq!(res, RangeSpec::NotSatisfiable);

        let res_exact = calculate_range(Some("bytes=100-"), file_size, 2 * 1024 * 1024);
        assert_eq!(res_exact, RangeSpec::NotSatisfiable);
    }

    #[test]
    fn test_calculate_range_reversed_range() {
        let file_size = 100;
        let res = calculate_range(Some("bytes=50-20"), file_size, 2 * 1024 * 1024);
        assert_eq!(res, RangeSpec::NotSatisfiable);
    }

    #[test]
    fn test_calculate_range_suffix() {
        let file_size = 1000;
        let res = calculate_range(Some("bytes=-200"), file_size, 2 * 1024 * 1024);
        assert_eq!(
            res,
            RangeSpec::Satisfiable {
                start: 800,
                end: 999,
                chunk_size: 200,
                is_partial: true,
            }
        );

        let res_zero = calculate_range(Some("bytes=-0"), file_size, 2 * 1024 * 1024);
        assert_eq!(res_zero, RangeSpec::NotSatisfiable);
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"token_12345", b"token_12345"));
        assert!(!constant_time_eq(b"token_12345", b"token_12346"));
        assert!(!constant_time_eq(b"token_12345", b"token_1234"));
        assert!(!constant_time_eq(b"token_1234", b"token_12345"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn test_read_line_bounded_truncates_long_line() {
        use std::io::Cursor;

        // 1. 上限以内の通常の行は改行まで読み取られること
        let mut short_reader =
            Cursor::new(b"GET /?path=test.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\n".to_vec());
        let mut line1 = String::new();
        let n1 = read_line_bounded(&mut short_reader, &mut line1, 8192).unwrap();
        assert_eq!(line1, "GET /?path=test.mp4 HTTP/1.1\r\n");
        assert_eq!(n1, line1.len());

        // 2. 改行を含まない巨大なデータ（20,000バイト）でも max_bytes (8192) で打ち切られること
        let oversized = vec![b'A'; 20_000];
        let mut long_reader = Cursor::new(oversized);
        let mut line2 = String::new();
        let n2 = read_line_bounded(&mut long_reader, &mut line2, 8192).unwrap();
        assert_eq!(n2, 8192);
        assert_eq!(line2.len(), 8192);
    }

    #[test]
    fn test_save_thumbnail_mtime_resolution_and_path_normalization() {
        let temp_dir = tempfile::tempdir().unwrap();
        let test_file = temp_dir.path().join("save_thumb_test.png");
        std::fs::write(&test_file, b"test content").unwrap();

        let real_mtime = std::fs::metadata(&test_file)
            .and_then(|m| m.modified())
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let state = crate::create_test_app_state(temp_dir.path().to_str().unwrap());
        let file_path_str = test_file.to_str().unwrap().to_string();

        // 1. path_to_mtime に実ファイルとは異なる古い値 (1000) を格納しておく
        {
            let mut mtime_map = state.path_to_mtime.write();
            mtime_map.insert(file_path_str.clone(), 1000);
        }

        // 2. 表記揺れ（\\?\ プレフィックス付き）のパス文字列で mtime 解決を呼ぶ
        let raw_path = format!("\\\\?\\{}", file_path_str);
        let resolved_mtime = resolve_save_thumbnail_mtime_with_state(Some(&state), &raw_path, 0);

        // 古いメモリ値 (1000) ではなく実ファイルの mtime が優先解決されること
        assert_eq!(resolved_mtime, real_mtime, "古いメモリ値ではなく実ファイルの最新 mtime が返ること");

        // state.path_to_mtime も最新の mtime に同期されていること
        assert_eq!(state.get_mtime(&file_path_str), Some(real_mtime));

        // 3. 正規化パスで hash_key を算出した際、期待通りのハッシュキーが得られること
        let clean_path = crate::utils::normalize_unc_path(&raw_path).into_owned();
        assert_eq!(clean_path, file_path_str, "normalize_unc_path により \\\\?\\ が除去されて正規化されること");

        let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, resolved_mtime);
        let expected_hash = crate::utils::hash_path_mtime_hex(&file_path_str, real_mtime);
        assert_eq!(hash_key, expected_hash, "正規化されたパスと最新 mtime からのハッシュキーが一致すること");
    }

    #[test]
    fn test_build_media_get_response_matches_legacy_bytes() {
        let thumb_body = b"\xFF\xD8\xFF\xE0TEST_THUMB";
        let actual_thumb = build_media_get_response("image/jpeg", "public, max-age=3600", true, thumb_body);
        let mut expected_thumb = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: public, max-age=3600\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            thumb_body.len()
        )
        .into_bytes();
        expected_thumb.extend_from_slice(thumb_body);
        assert_eq!(actual_thumb, expected_thumb, "サムネイルGET応答バイト列が変更前と完全一致すること");

        let cover_body = b"\x89PNG\r\n\x1A\nCOVER";
        let actual_cover = build_media_get_response("image/png", "public, max-age=3600", true, cover_body);
        let mut expected_cover = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: public, max-age=3600\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            cover_body.len()
        )
        .into_bytes();
        expected_cover.extend_from_slice(cover_body);
        assert_eq!(actual_cover, expected_cover, "カバーGET応答バイト列が変更前と完全一致すること");
    }

    #[test]
    fn test_hash_query_cache_control_immutable_header() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        assert_eq!(select_media_cache_control(true), "public, max-age=86400, immutable");
        assert_eq!(select_media_cache_control(false), "public, max-age=3600");

        let (db_tx, _db_rx) = tokio::sync::mpsc::channel::<DbMsg>(16);
        let state = crate::create_test_app_state("C:\\");
        let app_handle_slot = std::sync::Arc::new(std::sync::Mutex::new(None));
        let token = "cache_hdr_tok";

        let path_str = "C:\\test\\cache_header_check.png";
        let mtime = 12345u64;
        let hash_key = crate::utils::hash_path_mtime_hex(path_str, mtime);
        let dummy_jpeg: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46, 0xFF, 0xD9];
        {
            let conn = state.db_conn.get().unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, path, mtime) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![&hash_key, &dummy_jpeg, path_str, mtime],
            )
            .unwrap();
        }

        let port = start_local_video_server(db_tx, app_handle_slot, state.db_conn.clone(), token.to_string());

        // 1. hash= 付き GET -> Cache-Control: public, max-age=86400, immutable
        let mut s_with_hash = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s_with_hash.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let req_with_hash = format!(
            "GET /?path={}&mtime={}&thumb=1&hash={}&token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            urlencoding::encode(path_str),
            mtime,
            hash_key,
            token,
            port
        );
        s_with_hash.write_all(req_with_hash.as_bytes()).unwrap();
        let mut resp_with_hash = Vec::new();
        s_with_hash.read_to_end(&mut resp_with_hash).unwrap();
        let resp_str_hash = String::from_utf8_lossy(&resp_with_hash);
        assert!(resp_str_hash.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(
            resp_str_hash.contains("Cache-Control: public, max-age=86400, immutable\r\n"),
            "hash付きGETの応答ヘッダに max-age=86400, immutable が含まれること: {}",
            resp_str_hash
        );

        // 2. hash= 無し GET -> 従来の Cache-Control: public, max-age=3600
        let mut s_no_hash = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s_no_hash.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let req_no_hash = format!(
            "GET /?path={}&mtime={}&thumb=1&token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            urlencoding::encode(path_str),
            mtime,
            token,
            port
        );
        s_no_hash.write_all(req_no_hash.as_bytes()).unwrap();
        let mut resp_no_hash = Vec::new();
        s_no_hash.read_to_end(&mut resp_no_hash).unwrap();
        let resp_str_no_hash = String::from_utf8_lossy(&resp_no_hash);
        assert!(resp_str_no_hash.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(
            resp_str_no_hash.contains("Cache-Control: public, max-age=3600\r\n"),
            "hash無しGETの応答ヘッダが従来どおり max-age=3600 であること: {}",
            resp_str_no_hash
        );
        assert!(!resp_str_no_hash.contains("immutable"));
    }

    #[test]
    fn test_keep_alive_multiple_gets_and_post_closes_connection() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let (db_tx, _db_rx) = tokio::sync::mpsc::channel::<DbMsg>(16);
        let state = crate::create_test_app_state("C:\\");
        let app_handle_slot = std::sync::Arc::new(std::sync::Mutex::new(None));
        let token = "keepalive_tok";

        let path1 = "C:\\test\\ka_1.png";
        let path2 = "C:\\test\\ka_2.png";
        let mtime = 55555u64;
        let hash1 = crate::utils::hash_path_mtime_hex(path1, mtime);
        let hash2 = crate::utils::hash_path_mtime_hex(path2, mtime);
        let body1: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x01, 0x02, 0xFF, 0xD9];
        let body2: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01];
        {
            let conn = state.db_conn.get().unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, path, mtime) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![&hash1, &body1, path1, mtime],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, path, mtime) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![&hash2, &body2, path2, mtime],
            )
            .unwrap();
        }

        let port = start_local_video_server(db_tx, app_handle_slot, state.db_conn.clone(), token.to_string());

        // 1. 1つの接続で GET を2回続けて送り、両方とも正しい応答が返ること（2回目には Connection: close を指定して閉じる）
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut reader = BufReader::new(stream);

        let read_get_response = |reader: &mut BufReader<TcpStream>| -> (String, usize, bool, Vec<u8>) {
            let mut status = String::new();
            reader.read_line(&mut status).unwrap();
            let mut content_len = 0usize;
            let mut has_close = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    break;
                }
                let lower = trimmed.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_len = lower["content-length:".len()..].trim().parse().unwrap();
                } else if lower.starts_with("connection:") && lower.contains("close") {
                    has_close = true;
                }
            }
            let mut resp_body = vec![0u8; content_len];
            reader.read_exact(&mut resp_body).unwrap();
            (status, content_len, has_close, resp_body)
        };

        let req1 = format!(
            "GET /?path={}&mtime={}&thumb=1&hash={}&token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            urlencoding::encode(path1),
            mtime,
            hash1,
            token,
            port
        );
        reader.get_mut().write_all(req1.as_bytes()).unwrap();
        let (st1, len1, close1, got1) = read_get_response(&mut reader);
        assert!(st1.starts_with("HTTP/1.1 200 OK"));
        assert!(!close1, "継続応答では Connection: close ヘッダを付けないこと");
        assert_eq!(len1, body1.len());
        assert_eq!(got1, body1);

        let req2 = format!(
            "GET /?path={}&mtime={}&thumb=1&hash={}&token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            urlencoding::encode(path2),
            mtime,
            hash2,
            token,
            port
        );
        reader.get_mut().write_all(req2.as_bytes()).unwrap();
        let (st2, len2, close2, got2) = read_get_response(&mut reader);
        assert!(st2.starts_with("HTTP/1.1 200 OK"));
        assert!(close2, "Connection: close 指定時は応答にも Connection: close が付くこと");
        assert_eq!(len2, body2.len());
        assert_eq!(got2, body2);

        let mut eof_buf = [0u8; 1];
        assert_eq!(reader.read(&mut eof_buf).unwrap_or(0), 0, "Connection: close 応答後は接続が閉じること");

        // 2. POST /save-thumbnail は従来どおり動作し、1リクエストで接続が閉じること
        let post_stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        post_stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut post_reader = BufReader::new(post_stream);
        let post_payload = b"SAVED_BYTES";
        let post_req = format!(
            "POST /save-thumbnail?path={}&mtime={}&token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n\r\n",
            urlencoding::encode("C:\\test\\ka_post.png"),
            mtime,
            token,
            port,
            post_payload.len()
        );
        post_reader.get_mut().write_all(post_req.as_bytes()).unwrap();
        post_reader.get_mut().write_all(post_payload).unwrap();

        let (pst, plen, pclose, pbody) = read_get_response(&mut post_reader);
        assert!(pst.starts_with("HTTP/1.1 200 OK"));
        assert!(pclose, "POST /save-thumbnail は Connection: close を返すこと");
        assert!(plen > 0 && String::from_utf8_lossy(&pbody).contains("thumb=1"));
        assert_eq!(post_reader.read(&mut eof_buf).unwrap_or(0), 0, "POST /save-thumbnail 後に接続が閉じること");
    }
}
