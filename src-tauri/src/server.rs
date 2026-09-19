use crate::models::DbMsg;
use crate::state::AppState;
use crate::utils::normalize_unc_path;

#[tauri::command]
pub fn get_video_server_port(state: tauri::State<'_, AppState>) -> u16 {
    state.video_server_port
}

pub fn start_local_video_server(
    db_tx: tokio::sync::mpsc::Sender<DbMsg>,
    app_handle_slot: std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
    db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> u16 {
    use std::net::TcpListener;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::fs::File;

    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind local video server");
    let port = listener.local_addr().unwrap().port();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let db_tx = db_tx.clone();
                let app_handle_slot = app_handle_slot.clone();
                let db_conn = db_conn.clone();
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
                        loop {
                            let mut header_line = String::new();
                            if reader.read_line(&mut header_line).is_err() { break; }
                            if header_line.trim().is_empty() { break; }
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
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.flush();
                        return;
                    }

                    // POST /save-thumbnail?path=...[&mtime=...]
                    // 生のバイナリBlobを直接受け取り、Base64デコードのオーバーヘッドなしでSQLiteへ非同期投入する
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
                            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                            return;
                        }

                        let mut content_length: usize = 0;
                        loop {
                            let mut header_line = String::new();
                            if reader.read_line(&mut header_line).is_err() { break; }
                            let trimmed = header_line.trim();
                            if trimmed.is_empty() { break; }
                            let lower = trimmed.to_lowercase();
                            if lower.starts_with("content-length:") {
                                content_length = lower["content-length:".len()..].trim().parse().unwrap_or(0);
                            }
                        }

                        // サムネイルバイナリは最大10MBを上限として安全確認
                        if content_length == 0 || content_length > 10 * 1024 * 1024 {
                            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                            return;
                        }

                        let mut body = vec![0u8; content_length];
                        if reader.read_exact(&mut body).is_err() {
                            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                            return;
                        }

                        if mtime == 0 {
                            use tauri::Manager;
                            if let Ok(handle_guard) = app_handle_slot.lock() {
                                if let Some(app_handle) = handle_guard.as_ref() {
                                    let state = app_handle.state::<AppState>();
                                    mtime = state.get_mtime(&path_str).unwrap_or(0);
                                }
                            }
                            if mtime == 0 {
                                mtime = std::fs::metadata(&path_str)
                                    .and_then(|m| m.modified())
                                    .unwrap_or(std::time::UNIX_EPOCH)
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64;
                            }
                        }

                        let clean_path = path_str.replace("\\\\?\\", "");
                        let digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", clean_path, mtime).as_bytes());
                        let hash_key = format!("{:016x}", digest);

                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                        let _ = db_tx.blocking_send(DbMsg::SaveThumbnail {
                            hash_key,
                            path: clean_path.clone(),
                            mtime,
                            bytes: body,
                            now,
                        });

                        // AppState のメモリ上キャッシュフラグを即時反映
                        use tauri::Manager;
                        if let Ok(handle_guard) = app_handle_slot.lock() {
                            if let Some(app_handle) = handle_guard.as_ref() {
                                let state = app_handle.state::<AppState>();
                                state.mark_thumbnail_cached(&path_str);
                            }
                        }

                        let saved_url = format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1", port, urlencoding::encode(&path_str), mtime);
                        let mut resp = String::new();
                        resp.push_str("HTTP/1.1 200 OK\r\n");
                        resp.push_str("Content-Type: text/plain; charset=utf-8\r\n");
                        resp.push_str("Access-Control-Allow-Origin: *\r\n");
                        resp.push_str(&format!("Content-Length: {}\r\n", saved_url.len()));
                        resp.push_str("Connection: close\r\n\r\n");
                        resp.push_str(&saved_url);
                        let _ = stream.write_all(resp.as_bytes());
                        return;
                    }

                    let mut path_str = String::new();
                    let mut is_thumb = false;
                    let mut mtime: u64 = 0;
                    let mut hash_param = String::new();
                    if let Some(query) = uri.split('?').nth(1) {
                        for pair in query.split('&') {
                            if pair.starts_with("path=") {
                                path_str = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                            } else if pair.starts_with("thumb=1") {
                                is_thumb = true;
                            } else if pair.starts_with("mtime=") {
                                mtime = pair[6..].parse().unwrap_or(0);
                            } else if pair.starts_with("hash=") {
                                hash_param = urlencoding::decode(&pair[5..]).unwrap_or(std::borrow::Cow::Borrowed("")).into_owned();
                            }
                        }
                    }

                    if path_str.is_empty() && hash_param.is_empty() {
                        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                        return;
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
                                let hash_norm = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(format!("{}_{}", norm_unc, mtime).as_bytes()));
                                let hash_strip = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(format!("{}_{}", stripped, mtime).as_bytes()));
                                let hash_raw = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(format!("{}_{}", path_str, mtime).as_bytes()));

                                if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE (hash_key = ? OR hash_key = ? OR hash_key = ?) AND thumbnail IS NOT NULL LIMIT 1") {
                                    if let Ok(thumb) = stmt.query_row([&hash_norm, &hash_strip, &hash_raw], |row| row.get::<_, Vec<u8>>(0)) {
                                        cache_bytes = thumb;
                                    }
                                }
                            }

                            // 3. パス直接一致でのフォールバック
                            if cache_bytes.is_empty() && !path_str.is_empty() {
                                let norm_unc = normalize_unc_path(&path_str).into_owned();
                                let norm_back = norm_unc.replace('/', "\\");
                                let norm_fwd = norm_unc.replace('\\', "/");
                                if let Ok(mut stmt) = conn.prepare_cached(
                                    "SELECT thumbnail FROM cache WHERE (path = ? OR path = ? OR path = ? OR path = ?) AND thumbnail IS NOT NULL ORDER BY last_accessed DESC LIMIT 1"
                                ) {
                                    if let Ok(thumb) = stmt.query_row([&path_str, &norm_unc, &norm_back, &norm_fwd], |row| row.get::<_, Vec<u8>>(0)) {
                                        cache_bytes = thumb;
                                    }
                                }
                            }
                        }

                        // 未キャッシュの場合、同期生成でHTTPスレッドをブロックせず即座に404を返す。
                        // フロントエンド側の img.onerror から通常の OffscreenCanvas Web Worker へ安全にフォールバックされる
                        if !cache_bytes.is_empty() {
                            let mimetype = if cache_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                                "image/png"
                            } else if cache_bytes.starts_with(b"RIFF") && cache_bytes.len() >= 12 && &cache_bytes[8..12] == b"WEBP" {
                                "image/webp"
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
                            if let Some(range) = range_header {
                                if range.starts_with("bytes=") {
                                    let parts: Vec<&str> = range["bytes=".len()..].split('-').collect();
                                    if parts.len() == 2 && parts[0].is_empty() && !parts[1].is_empty() {
                                        // Suffix byte range: e.g. "bytes=-500"
                                        let suffix_len = parts[1].parse::<u64>().unwrap_or(0);
                                        start = file_size.saturating_sub(suffix_len);
                                        end = file_size.saturating_sub(1);
                                    } else {
                                        if !parts.is_empty() && !parts[0].is_empty() {
                                            start = parts[0].parse::<u64>().unwrap_or(0);
                                        }
                                        if parts.len() > 1 && !parts[1].is_empty() {
                                            end = parts[1].parse::<u64>().unwrap_or(end);
                                        }
                                    }
                                }
                            }

                            let max_chunk: u64 = 2 * 1024 * 1024;
                            let chunk_size = std::cmp::min(end.saturating_sub(start) + 1, max_chunk);

                            let mut headers = String::new();
                            // Always return 206 Partial Content to safely limit memory to chunk_size
                            headers.push_str("HTTP/1.1 206 Partial Content\r\n");
                            headers.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, start + chunk_size - 1, file_size));
                            let ext = std::path::Path::new(&path_str).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                            let content_type = match ext.as_str() {
                                "webm" => "video/webm",
                                "gif" => "image/gif",
                                _ => "video/mp4",
                            };
                            headers.push_str(&format!("Content-Type: {}\r\n", content_type));
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
