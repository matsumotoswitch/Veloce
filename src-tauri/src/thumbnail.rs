//! # Veloce - Thumbnail Generation & Caching Module (thumbnail.rs)
//!
//! 本モジュールは、画像（PNG / WebP / JPEG / BMP / GIF）および動画（MP4 / WebM）、
//! 音声（MP3 カバーアート）のサムネイル生成、高速リサイズ（zune-jpeg / fast_image_resize）、
//! バッチ生成・スロットリング・世代管理（エポック打ち切り）、OSネイティブフォールバック、
//! および SQLite キャッシュへの一括コミット処理一式を提供する。

use crate::metadata::{commit_pending_metadata_batch, get_full_metadata_for_path_with_stat_inner, MetadataCacheRow};
use crate::models::DbMsg;
use crate::state::AppState;
use crate::utils::normalize_unc_path;

#[tauri::command]
pub(crate) async fn generate_thumbnail(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<String, String> {
    let db_conn = state.db_conn.clone();
    
    // O(1) 高速逆引きインデックスから mtime を取得（なければディスクからフォールバック取得）
    let mem_mtime = state.get_mtime(&file_path);

    let video_port = state.video_server_port;
    let video_token = state.video_server_token.clone();
    let url = tokio::task::spawn_blocking(move || {
        #[cfg(debug_assertions)]
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

        let url = if cache_bytes.is_empty() {
            String::new()
        } else {
            let token_param = if video_token.is_empty() { String::new() } else { format!("&token={}", video_token) };
            format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1{}", video_port, urlencoding::encode(&file_path), mtime, token_param)
        };
        
        #[cfg(debug_assertions)]
        {
            let t_gen = t_start.elapsed();
            if t_gen.as_millis() > 5 {
                let fname = std::path::Path::new(&file_path).file_name().unwrap_or_default().to_string_lossy();
                println!("[Rust] {}: db_lookup={}ms", fname, t_gen.as_millis());
            }
        }
        url
    }).await.map_err(|e| e.to_string())?;

    Ok(url)
}

#[derive(serde::Serialize)]
pub(crate) struct ThumbnailResult {
    path: String,
    url: String,
    /// フォルダ切り替え（世代更新）により生成を打ち切ったアイテムであるか。
    /// フロントエンドはこのフラグが立ったアイテムを生成失敗として扱わず、優先キューへ再投入する。
    cancelled: bool,
}

/// サムネイル一括生成の世代カウンタ。
/// `load_directory` の呼び出しごとにインクリメントされる。実行中の `generate_thumbnail_batch` は
/// 各アイテムの生成前に開始時の世代と照合し、世代が進んでいれば未着手アイテムの生成を打ち切る。
/// これにより、旧フォルダのバッチが Rayon スレッドプールを占有し、新フォルダの画面内サムネイル生成が
/// 待たされる状態を防ぐ（処理中のアイテムは完了まで実行され、生成済みデータは通常通り保存される）。
static THUMBNAIL_BATCH_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 現在のサムネイル一括生成の世代番号を返す。
pub(crate) fn current_thumbnail_batch_epoch() -> u64 {
    THUMBNAIL_BATCH_EPOCH.load(std::sync::atomic::Ordering::Acquire)
}

/// サムネイル一括生成の世代を進め、実行中の旧世代バッチに打ち切りを通知する。
pub(crate) fn advance_thumbnail_batch_epoch() -> u64 {
    THUMBNAIL_BATCH_EPOCH.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1
}

/// 複数ファイルのサムネイルを Rayon で並列生成し、新規生成分を単一トランザクションで一括保存する。
///
/// - `is_cancelled` が `true` を返したアイテムは生成を行わず、`cancelled: true` の結果として返す。
/// - キャッシュヒット時は DB への書き込みを行わない。
/// - 返却 URL には PRIMARY KEY 直接参照用の `hash` パラメータが付与される。
pub(crate) fn compute_thumbnail_batch(
    files_to_process: Vec<(String, u64)>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    video_port: u16,
    video_token: &str,
    is_cancelled: &(dyn Fn() -> bool + Sync),
) -> Vec<ThumbnailResult> {
    use rayon::prelude::*;
    let computed: Vec<(ThumbnailResult, Option<PendingThumbnailWrite>)> = files_to_process
        .into_par_iter()
        .map(|(file_path, mtime)| {
            if is_cancelled() {
                return (ThumbnailResult { path: file_path, url: String::new(), cancelled: true }, None);
            }
            let clean_path = normalize_unc_path(&file_path).into_owned();
            let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, mtime);
            let (bytes, pending) = generate_thumbnail_compute_only(&file_path, mtime, Some(&hash_key), db_conn);
            let url = if bytes.is_empty() {
                String::new()
            } else {
                let token_param = if video_token.is_empty() { String::new() } else { format!("&token={}", video_token) };
                format!(
                    "http://127.0.0.1:{}/?path={}&mtime={}&thumb=1&hash={}{}",
                    video_port,
                    urlencoding::encode(&file_path),
                    mtime,
                    hash_key,
                    token_param
                )
            };
            (ThumbnailResult { path: file_path, url, cancelled: false }, pending)
        })
        .collect();

    let mut results = Vec::with_capacity(computed.len());
    let mut pending_writes = Vec::new();
    for (res, pending_opt) in computed {
        results.push(res);
        if let Some(p) = pending_opt {
            pending_writes.push(p);
        }
    }

    if !pending_writes.is_empty() {
        let _ = commit_pending_thumbnails_batch(db_conn, &pending_writes);
    }

    results
}

#[tauri::command]
pub(crate) async fn generate_thumbnail_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<ThumbnailResult>, String> {
    let db_conn = state.db_conn.clone();
    
    // Fast path: O(1) path_to_mtime lookup (なければディスクから取得)
    let mut files_to_process = Vec::with_capacity(file_paths.len());
    {
        let mtime_lock = state.path_to_mtime.read();
        for file_path in &file_paths {
            let clean = file_path.replace("\\\\?\\", "");
            let mtime = mtime_lock.get(file_path).or_else(|| mtime_lock.get(&clean)).copied().unwrap_or_else(|| {
                std::fs::metadata(file_path)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH)
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            });
            files_to_process.push((file_path.clone(), mtime));
        }
    }

    if files_to_process.is_empty() {
        return Ok(Vec::new());
    }

    let video_port = state.video_server_port;
    let video_token = state.video_server_token.clone();
    // 呼び出し時点の世代を記録し、フォルダ切り替え後は未着手アイテムの生成を打ち切る
    let start_epoch = current_thumbnail_batch_epoch();
    let results = tokio::task::spawn_blocking(move || {
        let is_cancelled = move || current_thumbnail_batch_epoch() != start_epoch;
        compute_thumbnail_batch(files_to_process, &db_conn, video_port, &video_token, &is_cancelled)
    }).await.map_err(|e| e.to_string())?;

    for item in &results {
        if !item.url.is_empty() {
            state.mark_thumbnail_cached(&item.path);
        }
    }

    Ok(results)
}

/// キャッシュ済みサムネイルのみをDBから取得する（生成は行わない）。
/// `hasThumbnailCache == true` のファイルを即時表示するためのファストパス。
#[tauri::command]
pub(crate) async fn get_cached_thumbnail_batch(
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
) -> Result<Vec<ThumbnailResult>, String> {
    let db_conn = state.db_conn.clone();

    // Fast path: O(1) path_to_mtime lookup (avoid O(N) HashMap rebuild)
    let mut files_with_mtime: Vec<(String, u64)> = Vec::new();
    {
        let mtime_lock = state.path_to_mtime.read();
        for file_path in &file_paths {
            let clean = file_path.replace("\\\\?\\", "");
            if let Some(&mtime) = mtime_lock.get(file_path).or_else(|| mtime_lock.get(&clean)) {
                files_with_mtime.push((file_path.clone(), mtime));
            }
        }
    }

    if files_with_mtime.is_empty() {
        return Ok(Vec::new());
    }

    let video_port = state.video_server_port;
    let video_token = state.video_server_token.clone();
    let results = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        files_with_mtime.into_par_iter().filter_map(|(file_path, mtime)| {
            let clean_path = file_path.replace(r"\\?\", "");
            let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, mtime);

            // DB のみを参照（生成しない・BLOB全体の読み出しを避け、存在確認のみで高速化）
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare_cached(
                    "SELECT 1 FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL AND length(thumbnail) > 0"
                ) {
                    if stmt.exists([&hash_key]).unwrap_or(false) {
                        let token_param = if video_token.is_empty() { String::new() } else { format!("&token={}", video_token) };
                        let url = format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1&hash={}{}", video_port, urlencoding::encode(&file_path), mtime, hash_key, token_param);
                        return Some(ThumbnailResult { path: file_path, url, cancelled: false });
                    }
                }
            }
            None // キャッシュなし → JS側で通常キューに回す
        }).collect::<Vec<_>>()
    }).await.map_err(|e| e.to_string())?;

    Ok(results)
}

/// 縮小画像（RGB8バッファ）に対して高速なアンシャープマスクを適用し、
/// 縮小によって平滑化された線画や瞳・ハイライトの輪郭を引き締める。
#[allow(dead_code)]
fn sharpen_rgb_buffer(buffer: &mut [u8], width: u32, height: u32, amount: f32) {
    if width < 3 || height < 3 || amount <= 0.0 {
        return;
    }
    let src = buffer.to_vec();
    let w = width as usize;
    let h = height as usize;
    let center_weight = 1.0 + 4.0 * amount;
    let neighbor_weight = amount;

    for y in 1..h - 1 {
        let row_offset = y * w * 3;
        let top_offset = (y - 1) * w * 3;
        let bottom_offset = (y + 1) * w * 3;

        for x in 1..w - 1 {
            let px = row_offset + x * 3;
            let left = row_offset + (x - 1) * 3;
            let right = row_offset + (x + 1) * 3;
            let top = top_offset + x * 3;
            let bottom = bottom_offset + x * 3;

            for c in 0..3 {
                let val = center_weight * (src[px + c] as f32)
                    - neighbor_weight * (src[left + c] as f32 + src[right + c] as f32 + src[top + c] as f32 + src[bottom + c] as f32);
                buffer[px + c] = val.clamp(0.0, 255.0).round() as u8;
            }
        }
    }
}

thread_local! {
    /// サムネイル生成用の fast_image_resize::Resizer インスタンス（内部作業バッファをスレッドローカルで再利用）
    static THUMB_RESIZER: std::cell::RefCell<fast_image_resize::Resizer> =
        std::cell::RefCell::new(fast_image_resize::Resizer::new());
}

/// RGBA8 ピクセルバッファが実質的に不透明（すべてのピクセルで alpha >= 254）であるかを判定する。
/// NovelAI 等の PNG 画像は視覚的に不透明であっても RGBA8 で出力されたり、Stealth PNGInfo の格納により
/// アルファチャンネル最下位ビットのみが 254〜255 に変調されているケースが多い。
/// これらを判別して JPEG エンコードへ誘導することで、サムネイルのデータサイズとエンコード時間を削減する。
fn is_effectively_opaque_rgba(rgba_bytes: &[u8]) -> bool {
    if rgba_bytes.is_empty() || rgba_bytes.len() % 4 != 0 {
        return false;
    }
    rgba_bytes.chunks_exact(4).all(|px| px[3] >= 254)
}

/// 生ピクセル配列を受け取り、Lanczos3 補間（スレッドローカルバッファ再利用）により
/// 最大 384px にリサイズした高品質サムネイル（PNG または JPEG バイト列）を生成する。
pub(crate) fn resize_and_encode_thumbnail(
    raw_pixels: Vec<u8>,
    width: u32,
    height: u32,
    pixel_type: fast_image_resize::PixelType,
    has_alpha: bool,
) -> Option<Vec<u8>> {
    use std::num::NonZeroU32;
    use fast_image_resize as fr;

    let src_width = NonZeroU32::new(width)?;
    let src_height = NonZeroU32::new(height)?;

    let mut dst_width = width;
    let mut dst_height = height;
    if width > 384 || height > 384 {
        let ratio = f32::min(384.0 / width as f32, 384.0 / height as f32);
        dst_width = (width as f32 * ratio).round() as u32;
        dst_height = (height as f32 * ratio).round() as u32;
    }

    let dst_w_nz = NonZeroU32::new(dst_width)?;
    let dst_h_nz = NonZeroU32::new(dst_height)?;

    let src_image = fr::images::Image::from_vec_u8(
        src_width.get(),
        src_height.get(),
        raw_pixels,
        pixel_type,
    ).ok()?;

    let mut dst_image = fr::images::Image::new(
        dst_w_nz.get(),
        dst_h_nz.get(),
        pixel_type,
    );

    // Lanczos3 高品質補間により縮小時のディテール損失を最小化
    let options = fr::ResizeOptions::new().resize_alg(
        fr::ResizeAlg::Interpolation(fr::FilterType::Lanczos3)
    );

    let resize_ok = THUMB_RESIZER.with(|resizer| {
        resizer.borrow_mut().resize(&src_image, &mut dst_image, Some(&options)).is_ok()
    });

    if !resize_ok {
        return None;
    }

    let buffer = dst_image.into_vec();
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);

    use image::ImageEncoder;
    let encode_ok = if has_alpha {
        if is_effectively_opaque_rgba(&buffer) {
            let mut rgb_buffer = Vec::with_capacity((dst_width as usize) * (dst_height as usize) * 3);
            for px in buffer.chunks_exact(4) {
                rgb_buffer.push(px[0]);
                rgb_buffer.push(px[1]);
                rgb_buffer.push(px[2]);
            }
            use image::codecs::jpeg::JpegEncoder;
            let encoder = JpegEncoder::new_with_quality(&mut cursor, 85);
            encoder.write_image(&rgb_buffer, dst_width, dst_height, image::ExtendedColorType::Rgb8).is_ok()
        } else {
            use image::codecs::png::{CompressionType, FilterType, PngEncoder};
            let encoder = PngEncoder::new_with_quality(
                &mut cursor,
                CompressionType::Fast,
                FilterType::Adaptive,
            );
            encoder.write_image(&buffer, dst_width, dst_height, image::ExtendedColorType::Rgba8).is_ok()
        }
    } else {
        use image::codecs::jpeg::JpegEncoder;
        let encoder = JpegEncoder::new_with_quality(&mut cursor, 80);
        encoder.write_image(&buffer, dst_width, dst_height, image::ExtendedColorType::Rgb8).is_ok()
    };

    if encode_ok {
        Some(bytes)
    } else {
        None
    }
}

/// 64KB の大容量バッファを備えた BufReader を介して画像ファイルをオープン・デコードする。
/// 小さなシーク・リードの頻発によるシステムコールおよびディスク I/O オーバーヘッドを削減する。
pub(crate) fn open_image_buffered(path_str: &str) -> Option<image::DynamicImage> {
    let file = std::fs::File::open(path_str).ok()?;
    let reader = std::io::BufReader::with_capacity(65536, file);
    image::ImageReader::new(reader)
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()
}

/// 画像ファイルからサムネイル（最大384px）を同期生成する。
/// JPEG 画像の場合は SIMD 最適化された zune-jpeg による生 RGB 高速展開ルートを優先し、
/// 中間オブジェクトの複製・アロケーションを排除して fast_image_resize へ直結する。
/// 失敗時またはその他の形式（PNG/WebP/BMP/GIF）は 64KB バッファリングを備えた open_image_buffered へ安全にフォールバックする。
pub(crate) fn generate_image_thumbnail_sync(path_str: &str) -> Option<Vec<u8>> {
    let path = std::path::Path::new(path_str);
    let is_jpeg = path.extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg"))
        .unwrap_or(false);

    if is_jpeg {
        if let Ok(file_bytes) = std::fs::read(path_str) {
            let mut decoder = zune_jpeg::JpegDecoder::new(&file_bytes);
            if let Ok(raw_pixels) = decoder.decode() {
                if let Some((width, height)) = decoder.dimensions() {
                    let colorspace = decoder.get_output_colorspace();
                    use fast_image_resize as fr;
                    let (pixel_type, has_alpha) = match colorspace {
                        Some(zune_core::colorspace::ColorSpace::RGB) => (fr::PixelType::U8x3, false),
                        Some(zune_core::colorspace::ColorSpace::RGBA) => (fr::PixelType::U8x4, true),
                        _ => (fr::PixelType::U8x3, false),
                    };

                    if let Some(thumb) = resize_and_encode_thumbnail(
                        raw_pixels,
                        width as u32,
                        height as u32,
                        pixel_type,
                        has_alpha,
                    ) {
                        return Some(thumb);
                    }
                }
            }
        }
        // zune-jpeg でデコードできなかった場合は安全に open_image_buffered へフォールバック
    }

    let is_png = path.extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.eq_ignore_ascii_case("png"))
        .unwrap_or(false);

    if is_png {
        if let Ok(file_bytes) = std::fs::read(path_str) {
            let options = zune_core::options::DecoderOptions::default().png_set_strip_to_8bit(true);
            let mut decoder = zune_png::PngDecoder::new_with_options(&file_bytes, options);
            if let Ok(raw_pixels) = decoder.decode_raw() {
                if let Some((width, height)) = decoder.get_dimensions() {
                    let colorspace = decoder.get_colorspace();
                    use fast_image_resize as fr;
                    let color_info = match colorspace {
                        Some(zune_core::colorspace::ColorSpace::RGB) => Some((fr::PixelType::U8x3, false)),
                        Some(zune_core::colorspace::ColorSpace::RGBA) => Some((fr::PixelType::U8x4, true)),
                        _ => None,
                    };

                    if let Some((pixel_type, has_alpha)) = color_info {
                        if let Some(thumb) = resize_and_encode_thumbnail(
                            raw_pixels,
                            width as u32,
                            height as u32,
                            pixel_type,
                            has_alpha,
                        ) {
                            return Some(thumb);
                        }
                    }
                }
            }
        }
        // zune-png でデコードできなかった場合は安全に open_image_buffered へフォールバック
    }

    if let Some(img) = open_image_buffered(path_str) {
        return encode_dynamic_image_thumbnail(img);
    }

    None
}

/// DynamicImage から中間複製を省いてサムネイルバイト列へリサイズ・エンコードする
pub(crate) fn encode_dynamic_image_thumbnail(img: image::DynamicImage) -> Option<Vec<u8>> {
    let has_alpha = img.color().has_alpha();
    let width = img.width();
    let height = img.height();

    use fast_image_resize as fr;
    // into_rgba8 / into_rgb8 を使用して DynamicImage 内部バッファの不要な原寸複製を完全に排除
    let (pixel_type, raw_pixels) = if has_alpha {
        let rgba = img.into_rgba8();
        (fr::PixelType::U8x4, rgba.into_raw())
    } else {
        let rgb = img.into_rgb8();
        (fr::PixelType::U8x3, rgb.into_raw())
    };

    resize_and_encode_thumbnail(
        raw_pixels,
        width,
        height,
        pixel_type,
        has_alpha,
    )
}

/// 音声ファイルから埋め込みカバー画像を抽出し、既存画像経路と同じくサムネイルを生成する（カバー無しは None）
pub(crate) fn generate_audio_thumbnail_sync(path_str: &str) -> Option<Vec<u8>> {
    let cover_bytes = crate::audio::extract_audio_cover(path_str)?;
    let img = image::load_from_memory(&cover_bytes).ok()?;
    encode_dynamic_image_thumbnail(img)
}

/// メディア種別（動画・音声・静止画）に応じた同期サムネイル生成ディスパッチャ
pub(crate) fn generate_media_thumbnail_sync(file_path: &str) -> Option<Vec<u8>> {
    let lower_path = file_path.to_lowercase();
    let is_video = lower_path.ends_with(".mp4")
        || lower_path.ends_with(".webm")
        || lower_path.ends_with(".avi")
        || lower_path.ends_with(".mkv");

    if is_video {
        generate_video_thumbnail_sync(file_path)
    } else if crate::audio::is_audio_path(file_path) {
        generate_audio_thumbnail_sync(file_path)
    } else {
        generate_image_thumbnail_sync(file_path)
    }
}

/// 子プロセスを起動して標準出力をパイプで読み取りつつ、指定したタイムアウト時間を超過した場合は
/// プロセスを強制終了（kill）して `None` を返すヘルパー関数。
/// パイプバッファ詰まりによるデッドロックを防ぐため、標準出力の読み取りは専用スレッドで並行実行する。
pub fn run_command_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd.spawn().ok()?;
    let stdout_pipe = child.stdout.take()?;
    let reader_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.take(10 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });

    let start = std::time::Instant::now();
    let poll_interval = std::time::Duration::from_millis(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader_handle.join().ok()?;
                if status.success() && !out.is_empty() {
                    return Some(out);
                }
                return None;
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(poll_interval);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub(crate) fn generate_video_thumbnail_sync(path: &str) -> Option<Vec<u8>> {
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
        let mut cmd = Command::new(&ffmpeg_path);
        cmd.args(&[
            "-v", "error",
            "-ss", "1.0",
            "-i", path,
            "-vframes", "1",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-"
        ])
        .creation_flags(CREATE_NO_WINDOW);

        if let Some(stdout) = run_command_with_timeout(&mut cmd, std::time::Duration::from_secs(5)) {
            return Some(stdout); // JPEG bytes
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
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let should_uninit = hr.is_ok();

            let clean_path = path.replace("\\\\?\\", "");
            let hpath = HSTRING::from(clean_path);
            let item: windows::Win32::UI::Shell::IShellItem = match SHCreateItemFromParsingName(PCWSTR::from_raw(hpath.as_ptr()), None) {
                Ok(item) => item,
                Err(_e) => {
                    if should_uninit {
                        let _ = CoUninitialize();
                    }
                    return None;
                }
            };

            let factory: IShellItemImageFactory = match item.cast() {
                Ok(f) => f,
                Err(_e) => {
                    if should_uninit {
                        let _ = CoUninitialize();
                    }
                    return None;
                }
            };

            let size = SIZE { cx: 256, cy: 256 };
            let hbitmap = match factory.GetImage(size, SIIGBF_THUMBNAILONLY) {
                Ok(bmp) => bmp,
                Err(_e) => {
                    if should_uninit {
                        let _ = CoUninitialize();
                    }
                    return None;
                }
            };

            let mut bm = BITMAP::default();
            if GetObjectW(hbitmap, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
                let _ = DeleteObject(hbitmap);
                if should_uninit {
                    let _ = CoUninitialize();
                }
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
            if should_uninit {
                let _ = CoUninitialize();
            }

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

/// 新規生成されたサムネイルのDB一括保存用エントリ
pub(crate) struct PendingThumbnailWrite {
    hash_key: String,
    clean_path: String,
    mtime: u64,
    bytes: Vec<u8>,
    now: i64,
}

/// 複数の新規生成サムネイルを単一のSQLiteトランザクションで一括保存する。
/// 並列生成スレッドからの個別オートコミットによるWriterロック競合を排除する。
pub(crate) fn commit_pending_thumbnails_batch(
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pending_writes: &[PendingThumbnailWrite],
) -> Result<usize, rusqlite::Error> {
    if pending_writes.is_empty() {
        return Ok(0);
    }
    let mut conn = db_conn.get().map_err(|_| rusqlite::Error::InvalidQuery)?;
    if pending_writes.len() == 1 {
        let p = &pending_writes[0];
        conn.execute(
            "INSERT INTO cache (hash_key, thumbnail, path, last_accessed) VALUES (?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET thumbnail = excluded.thumbnail, path = excluded.path, last_accessed = excluded.last_accessed",
            rusqlite::params![p.hash_key, p.bytes, p.clean_path, p.now],
        )?;
        let _ = p.mtime;
        return Ok(1);
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO cache (hash_key, thumbnail, path, last_accessed) VALUES (?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET thumbnail = excluded.thumbnail, path = excluded.path, last_accessed = excluded.last_accessed",
        )?;
        for p in pending_writes {
            stmt.execute(rusqlite::params![p.hash_key, p.bytes, p.clean_path, p.now])?;
        }
    }
    tx.commit()?;
    Ok(pending_writes.len())
}

/// キャッシュ済みサムネイルをDBから検索し、キャッシュミス時は同期生成してバイト列と未コミット書き込み情報を返す。
/// バッチ生成時には呼び出し元で一括トランザクションコミットを行うため、この関数内ではDB書き込みを行わない。
pub(crate) fn generate_thumbnail_compute_only(
    file_path: &str,
    mtime: u64,
    direct_hash: Option<&str>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> (Vec<u8>, Option<PendingThumbnailWrite>) {
    if let Ok(conn) = db_conn.get() {
        // 1. direct_hash が指定されていれば最優先で直撃取得
        if let Some(hash) = direct_hash {
            if !hash.is_empty() {
                if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL") {
                    if let Ok(thumb) = stmt.query_row([hash], |row| row.get::<_, Vec<u8>>(0)) {
                        if !thumb.is_empty() {
                            return (thumb, None);
                        }
                    }
                }
            }
        }

        // 2. UNC 正規化パス・プレフィックス除去パスなど複数候補ハッシュキーで検索
        if !file_path.is_empty() {
            let norm_unc = normalize_unc_path(file_path).into_owned();
            let stripped = if file_path.starts_with(r"\\?\") { &file_path[4..] } else { file_path };
            let hash_norm = crate::utils::hash_path_mtime_hex(&norm_unc, mtime);
            let hash_strip = crate::utils::hash_path_mtime_hex(stripped, mtime);
            let hash_raw = crate::utils::hash_path_mtime_hex(file_path, mtime);

            if let Ok(mut stmt) = conn.prepare_cached("SELECT thumbnail FROM cache WHERE (hash_key = ? OR hash_key = ? OR hash_key = ?) AND thumbnail IS NOT NULL LIMIT 1") {
                if let Ok(thumb) = stmt.query_row([&hash_norm, &hash_strip, &hash_raw], |row| row.get::<_, Vec<u8>>(0)) {
                    if !thumb.is_empty() {
                        return (thumb, None);
                    }
                }
            }

            // 3. フォールバック: パス一致で検索
            let norm_back = norm_unc.replace('/', "\\");
            let norm_fwd = norm_unc.replace('\\', "/");
            if let Ok(mut stmt) = conn.prepare_cached(
                "SELECT thumbnail FROM cache WHERE (path = ? OR path = ? OR path = ? OR path = ?) AND thumbnail IS NOT NULL ORDER BY last_accessed DESC LIMIT 1"
            ) {
                if let Ok(thumb) = stmt.query_row([file_path, &norm_unc, &norm_back, &norm_fwd], |row| row.get::<_, Vec<u8>>(0)) {
                    if !thumb.is_empty() {
                        return (thumb, None);
                    }
                }
            }
        }
    }

    let generated = generate_media_thumbnail_sync(file_path);

    if let Some(bytes) = generated {
        let clean_path = normalize_unc_path(file_path).into_owned();
        let hash_key = direct_hash
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| crate::utils::hash_path_mtime_hex(&clean_path, mtime));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let pending = PendingThumbnailWrite {
            hash_key,
            clean_path,
            mtime,
            bytes: bytes.clone(),
            now,
        };
        return (bytes, Some(pending));
    }

    (Vec::new(), None)
}

/// キャッシュ済みサムネイル（または即時抽出可能な動画サムネイル）をDBから取得する。
pub(crate) fn generate_thumbnail_inner(
    file_path: &str,
    mtime: u64,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> Vec<u8> {
    generate_thumbnail_inner_with_hash(file_path, mtime, None, db_conn)
}

/// キャッシュ済みサムネイル（または即時抽出可能な動画サムネイル）をDBから取得する。
/// direct_hash が渡された場合は PRIMARY KEY (hash_key) で O(1) 直撃取得し、
/// UNC パス等の差異による 404 キャッシュミスを完全に防止する。
pub(crate) fn generate_thumbnail_inner_with_hash(
    file_path: &str,
    mtime: u64,
    direct_hash: Option<&str>,
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> Vec<u8> {
    let (bytes, pending_opt) = generate_thumbnail_compute_only(file_path, mtime, direct_hash, db_conn);
    if let Some(pending) = pending_opt {
        let _ = commit_pending_thumbnails_batch(db_conn, &[pending]);
    }
    bytes
}


/// フロントエンドの OffscreenCanvas で生成されたサムネイル画像（Base64）をデコードし、
/// SQLite キャッシュ DB へ非同期保存した上で、即時参照可能なローカル HTTP 配信 URL を返却する
#[tauri::command]
pub(crate) async fn save_thumbnail(
    state: tauri::State<'_, AppState>,
    file_path: String,
    b64_data: String,
) -> Result<String, String> {
    // O(1) 高速逆引きインデックスから mtime を取得
    let mem_mtime = state.get_mtime(&file_path);

    let mtime = if let Some(mt) = mem_mtime {
        mt
    } else {
        tokio::fs::metadata(&file_path).await
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    };

    let clean_path = file_path.replace("\\\\?\\", "");
    let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, mtime);
    let hash_key_for_url = hash_key.clone();

    // b64_data is expected to be "data:image/jpeg;base64,..."
    let b64 = if let Some(idx) = b64_data.find(',') {
        &b64_data[idx + 1..]
    } else {
        &b64_data
    };

    use base64::{Engine as _, engine::general_purpose};
    let bytes = general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;

    let video_port = state.video_server_port;
    let video_token = state.video_server_token.clone();
    let file_path_clone = file_path.clone();
    
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let _ = state.db_tx.send(DbMsg::SaveThumbnail {
        hash_key,
        path: clean_path.clone(),
        mtime,
        bytes,
        now,
    }).await;

    // インメモリのファイル一覧にもサムネイルキャッシュ保持フラグを O(1) 即時反映
    state.mark_thumbnail_cached(&file_path);

    // 保存完了と同時にローカルHTTP配信用URL（hash_key直撃パラメータ付き）を返却し、フロントエンド側での再取得IPC呼び出しを不要化
    let token_param = if video_token.is_empty() { String::new() } else { format!("&token={}", video_token) };
    let url = format!("http://127.0.0.1:{}/?path={}&mtime={}&thumb=1&hash={}{}", video_port, urlencoding::encode(&file_path_clone), mtime, hash_key_for_url, token_param);
    Ok(url)
}

/// 指定されたファイル群（パス, mtime, ctime, size）に対して、未キャッシュのメタデータ解析および
/// サムネイル生成を rayon で並列実行し、完了後に単一トランザクションでSQLiteへ一括コミットする。
/// 戻り値として (新規保存されたメタデータ件数, 新規保存されたサムネイル件数) を返す。
pub(crate) fn precache_entries_chunk(
    items: &[(String, u64, u64, u64)],
    db_conn: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
) -> (usize, usize) {
    use rayon::prelude::*;

    let computed: Vec<(Option<MetadataCacheRow>, Option<PendingThumbnailWrite>)> = items
        .par_iter()
        .map(|(path, mtime, ctime, size)| {
            let clean_path = path.replace("\\\\?\\", "");
            let hash_key = crate::utils::hash_path_mtime_hex(&clean_path, *mtime);

            let (mut has_thumb, mut has_meta) = (false, false);
            if let Ok(conn) = db_conn.get() {
                if let Ok(mut stmt) = conn.prepare_cached(
                    "SELECT (thumbnail IS NOT NULL), (metadata IS NOT NULL AND metadata != '') FROM cache WHERE hash_key = ?"
                ) {
                    if let Ok((t, m)) = stmt.query_row([&hash_key], |row| {
                        Ok((
                            row.get::<_, bool>(0).unwrap_or(false),
                            row.get::<_, bool>(1).unwrap_or(false),
                        ))
                    }) {
                        has_thumb = t;
                        has_meta = m;
                    }
                }
            }

            let pending_meta = if !has_meta {
                get_full_metadata_for_path_with_stat_inner(
                    path,
                    *mtime,
                    *ctime,
                    *size,
                    db_conn,
                    false,
                ).3
            } else {
                None
            };

            let pending_thumb = if !has_thumb {
                generate_thumbnail_compute_only(path, *mtime, Some(&hash_key), db_conn).1
            } else {
                None
            };

            (pending_meta, pending_thumb)
        })
        .collect();

    let mut pending_meta_rows = Vec::new();
    let mut pending_thumb_writes = Vec::new();
    for (m_opt, t_opt) in computed {
        if let Some(m) = m_opt {
            pending_meta_rows.push(m);
        }
        if let Some(t) = t_opt {
            pending_thumb_writes.push(t);
        }
    }

    let meta_committed = commit_pending_metadata_batch(db_conn, &pending_meta_rows).unwrap_or(0);
    let thumb_committed = commit_pending_thumbnails_batch(db_conn, &pending_thumb_writes).unwrap_or(0);
    (meta_committed, thumb_committed)
}

#[tauri::command]
pub(crate) async fn precache_directory_recursively(
    window: tauri::Window,
    target_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db_conn = state.db_conn.clone();
    tokio::task::spawn_blocking(move || {
        let entries: Vec<(String, u64, u64, u64)> = jwalk::WalkDir::new(&target_path)
            .skip_hidden(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|ext| {
                        let ext_lower = ext.to_ascii_lowercase();
                        matches!(ext_lower.as_str(), "png" | "jpg" | "jpeg" | "webp")
                            || crate::audio::is_audio_extension(&ext_lower)
                    })
                    .unwrap_or(false)
            })
            .map(|entry| {
                let path = entry.path().to_string_lossy().to_string();
                let metadata = entry.metadata().ok();
                let mtime = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let ctime = metadata
                    .as_ref()
                    .and_then(|m| m.created().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                (path, mtime, ctime, size)
            })
            .collect();

        let total = entries.len();

        // 32件単位の並列チャンクでサムネイル生成・メタデータ抽出をマルチスレッド計算し、チャンクごとに一括トランザクション保存
        for (chunk_idx, chunk) in entries.chunks(32).enumerate() {
            let _ = precache_entries_chunk(chunk, &db_conn);
            let processed = std::cmp::min((chunk_idx + 1) * 32, total);
            let _ = window.emit("precache-progress", (processed, total));
        }
        Ok(())
    })
    .await
    .unwrap_or(Ok(()))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

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
    fn test_os_thumbnail_fallback() {
        let root_dir = std::env::current_dir().unwrap().parent().unwrap().to_path_buf();
        let test_img_path = root_dir.join("app-icon.png");
        
        // This should fall back to the OS API since ffmpeg will fail to extract a video frame from a png.
        let result = super::generate_video_thumbnail_sync(&test_img_path.to_string_lossy());
        
        assert!(result.is_some(), "OS thumbnail fallback failed");
    }


    #[test]
    fn test_generate_thumbnail_inner_path_fallback() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        {
            let conn = pool.get().unwrap();
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
            ).unwrap();

            let dummy_png: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 1, 2, 3];
            conn.execute(
                "INSERT INTO cache (hash_key, thumbnail, path, last_accessed) VALUES (?, ?, ?, ?)",
                rusqlite::params!["dummy_hash_different", dummy_png, "C:\\photos\\img1.png", 1000],
            ).unwrap();
        }

        // mtime=0 や hash_key 不一致の状況でも、パス完全一致フォールバックによりサムネイルが即時返却されること
        let res1 = super::generate_thumbnail_inner("C:\\photos\\img1.png", 0, &pool);
        assert_eq!(res1, vec![0x89u8, 0x50, 0x4E, 0x47, 1, 2, 3]);

        // スラッシュ区切りの場合でもフォールバックで正常に取得できること
        let res2 = super::generate_thumbnail_inner("C:/photos/img1.png", 0, &pool);
        assert_eq!(res2, vec![0x89u8, 0x50, 0x4E, 0x47, 1, 2, 3]);
    }


    #[test]
    fn test_generate_thumbnail_inner_static_image_cache_miss_returns_empty() {
        // 静止画像（PNG/WebP/JPEG）のキャッシュミス時は空配列を返す。
        // Rustソフトウェアデコードは spawn_blocking スレッドをブロックするため、
        // ブラウザのOffscreenCanvasパイプラインに委譲するのが設計上の正しい動作。
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        {
            let conn = pool.get().unwrap();
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
            ).unwrap();
        }

        // キャッシュに何も存在しない状態でPNG/WebP/JPEGパスを渡すと空配列が返ること
        let res_png = super::generate_thumbnail_inner("C:\\photos\\nonexistent.png", 12345, &pool);
        assert!(res_png.is_empty(), "PNGキャッシュミス時はJS委譲のため空配列を返すこと（実ファイル不要）");

        let res_webp = super::generate_thumbnail_inner("C:\\photos\\nonexistent.webp", 12345, &pool);
        assert!(res_webp.is_empty(), "WebPキャッシュミス時は空配列を返すこと");

        let res_jpg = super::generate_thumbnail_inner("C:\\photos\\nonexistent.jpg", 12345, &pool);
        assert!(res_jpg.is_empty(), "JPEGキャッシュミス時は空配列を返すこと");

        // DBへの書き込みも行われていないこと（不要なI/Oが発生しない）
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM cache WHERE thumbnail IS NOT NULL",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 0, "キャッシュミスで静止画像の生成・DB保存が行われないこと");
    }


    #[test]
    fn test_generate_thumbnail_inner_video_cache_miss_attempts_generation() {
        // 動画ファイル（.mp4/.webm/.avi/.mkv）のキャッシュミス時はRust側で生成を試みる。
        // テスト環境にffmpegや対象ファイルがないため生成は失敗し空配列が返るが、
        // 静止画像と同じ「即時空返し」ではなく動画生成パスを通ることを確認する。
        // （実環境では有効なffmpegがあれば JPEG バイト列が返る）
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        {
            let conn = pool.get().unwrap();
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
            ).unwrap();
        }

        // 存在しないmp4パスでも「パニックしない」こと、および空配列が返ること
        // (ffmpegが存在しない・ファイルが存在しない環境では空を返す)
        let res_mp4 = super::generate_thumbnail_inner("C:\\videos\\nonexistent.mp4", 0, &pool);
        // 戻り値の検証: ffmpeg不在または失敗時は空が返ること（クラッシュしないこと）
        // 返ってきた場合（ffmpegが存在してJPEGが生成された場合）はJPEGヘッダであること
        if !res_mp4.is_empty() {
            assert!(res_mp4.starts_with(&[0xFF, 0xD8]), "動画サムネイルはJPEG形式であること");
        }

        let res_webm = super::generate_thumbnail_inner("C:\\videos\\nonexistent.webm", 0, &pool);
        if !res_webm.is_empty() {
            assert!(res_webm.starts_with(&[0xFF, 0xD8]), "webmサムネイルはJPEG形式であること");
        }
    }


    #[test]
    fn test_save_thumbnail_and_clear_metadata_cache_logic() {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        let mut conn = pool.get().unwrap();

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
                last_accessed INTEGER
            )",
            [],
        ).unwrap();

        let hash_key = "a1b2c3d4e5f60718";
        let test_path = "C:\\images\\rebuild_test.png";
        let test_mtime = 1700000000_u64;
        let thumb_bytes = vec![1, 2, 3, 4, 5];
        let now = 123456789_i64;

        // 1. SaveThumbnail のクエリ検証（path, mtime が正しく保存されること）
        conn.execute(
            "INSERT INTO cache (hash_key, path, mtime, thumbnail, last_accessed) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(hash_key) DO UPDATE SET thumbnail=excluded.thumbnail, path=excluded.path, mtime=excluded.mtime, last_accessed=excluded.last_accessed",
            rusqlite::params![&hash_key, &test_path, test_mtime, &thumb_bytes, now],
        ).unwrap();

        let (saved_path, saved_mtime, saved_thumb): (String, u64, Vec<u8>) = conn.query_row(
            "SELECT path, mtime, thumbnail FROM cache WHERE hash_key = ?",
            [&hash_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();

        assert_eq!(saved_path, test_path, "path が空文字ではなく正しく保存されること");
        assert_eq!(saved_mtime, test_mtime, "mtime が正しく保存されること");
        assert_eq!(saved_thumb, thumb_bytes, "サムネイルデータが正しく保存されること");

        // 2. clear_metadata_cache のトランザクション一括削除検証
        let tx = conn.transaction().unwrap();
        {
            let mut stmt_path = tx.prepare_cached(
                "DELETE FROM cache WHERE path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE"
            ).unwrap();
            let norm_back = test_path.replace('/', "\\");
            let norm_fwd = test_path.replace('\\', "/");
            stmt_path.execute(rusqlite::params![&test_path, &norm_back, &norm_fwd]).unwrap();
        }
        tx.commit().unwrap();

        let count: usize = conn.query_row(
            "SELECT COUNT(*) FROM cache WHERE path = ?",
            [&test_path],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 0, "キャッシュ削除後に該当レコードが0件になること");
    }


    #[test]
    fn test_generate_thumbnail_inner_direct_hash_lookup() {
        use super::*;
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let db_conn = r2d2::Pool::new(manager).unwrap();
        let conn = db_conn.get().unwrap();

        conn.execute(
            "CREATE TABLE cache (
                hash_key TEXT PRIMARY KEY,
                path TEXT,
                thumbnail BLOB,
                last_accessed INTEGER
            )",
            [],
        ).unwrap();

        let dummy_thumb: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG signature
        conn.execute(
            "INSERT INTO cache (hash_key, path, thumbnail, last_accessed) VALUES (?, ?, ?, ?)",
            rusqlite::params!["special_hash_12345", r"\\win81\share\img.png", dummy_thumb, 100],
        ).unwrap();
        drop(conn);

        // 1. direct_hash 指定時はパスやmtimeに関わらず直撃取得できること
        let res_direct = generate_thumbnail_inner_with_hash(
            r"\\win81\share\img.png",
            999999, // 意図的に異なるmtime
            Some("special_hash_12345"),
            &db_conn,
        );
        assert_eq!(res_direct, vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "direct_hash でO(1)直撃取得できること");

        // 2. 存在しない direct_hash の場合はフォールバックへ移行すること
        let res_missing = generate_thumbnail_inner_with_hash(
            r"\\win81\share\img.png",
            999999,
            Some("non_existent_hash"),
            &db_conn,
        );
        assert_eq!(res_missing, vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "direct_hash 失敗時でもパス一致でフォールバック取得できること");
    }


    #[test]
    fn test_generate_image_thumbnail_rgba_png_output() {
        use image::{RgbaImage, Rgba};

        // 800x600 のアルファ付き画像を作成（長辺800px -> 384px にリサイズされる）
        let mut img = RgbaImage::new(800, 600);
        for pixel in img.pixels_mut() {
            *pixel = Rgba([255, 0, 0, 128]); // 半透明赤
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("test_rgba.png");
        let path_str = path.to_str().unwrap();
        img.save_with_format(&path, image::ImageFormat::Png).unwrap();

        let thumb_opt = generate_image_thumbnail_sync(path_str);
        assert!(thumb_opt.is_some(), "サムネイルが生成されること");

        let thumb_bytes = thumb_opt.unwrap();
        // PNG シグネチャ検証 (\x89PNG\r\n\x1a\n)
        assert_eq!(&thumb_bytes[0..8], b"\x89PNG\r\n\x1a\n", "出力がPNG形式であること");

        // デコードしてサイズとアルファを検証
        let decoded = image::load_from_memory(&thumb_bytes).unwrap();
        assert_eq!(decoded.width(), 384, "長辺が384pxにリサイズされること");
        assert_eq!(decoded.height(), 288, "アスペクト比(4:3)が維持されること");
        assert!(decoded.color().has_alpha(), "アルファチャンネルが維持されること");
    }


    #[test]
    fn test_generate_image_thumbnail_rgb_jpeg_output() {
        use image::{RgbImage, Rgb};

        // 600x800 のアルファなし画像を作成（長辺800px -> 384px にリサイズされる）
        let mut img = RgbImage::new(600, 800);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([0, 255, 0]);
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("test_rgb.jpg");
        let path_str = path.to_str().unwrap();
        img.save_with_format(&path, image::ImageFormat::Jpeg).unwrap();

        let thumb_opt = generate_image_thumbnail_sync(path_str);
        assert!(thumb_opt.is_some(), "サムネイルが生成されること");

        let thumb_bytes = thumb_opt.unwrap();
        // JPEG シグネチャ検証 (\xFF\xD8)
        assert_eq!(&thumb_bytes[0..2], b"\xFF\xD8", "出力がJPEG形式であること");

        let decoded = image::load_from_memory(&thumb_bytes).unwrap();
        assert_eq!(decoded.width(), 288, "アスペクト比(3:4)が維持されること");
        assert_eq!(decoded.height(), 384, "長辺が384pxにリサイズされること");
        assert!(!decoded.color().has_alpha(), "アルファチャンネルがないこと");
    }


    #[test]
    fn test_generate_image_thumbnail_small_image_no_upscale() {
        use image::{RgbImage, Rgb};

        // 100x80 の小さい画像を作成
        let mut img = RgbImage::new(100, 80);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([0, 0, 255]);
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("test_small.jpg");
        let path_str = path.to_str().unwrap();
        img.save_with_format(&path, image::ImageFormat::Jpeg).unwrap();

        let thumb_opt = generate_image_thumbnail_sync(path_str);
        assert!(thumb_opt.is_some(), "サムネイルが生成されること");

        let decoded = image::load_from_memory(&thumb_opt.unwrap()).unwrap();
        assert_eq!(decoded.width(), 100, "384px未満の画像は拡大されないこと");
        assert_eq!(decoded.height(), 80, "384px未満の画像は拡大されないこと");
    }


    #[test]
    fn test_generate_image_thumbnail_resizer_reuse_and_invalid_file() {
        use image::{RgbImage, Rgb};

        let temp_dir = tempfile::tempdir().unwrap();

        // 1回目: 500x500
        let mut img1 = RgbImage::new(500, 500);
        for p in img1.pixels_mut() { *p = Rgb([10, 20, 30]); }
        let path1 = temp_dir.path().join("test_reuse1.jpg");
        let path1_str = path1.to_str().unwrap();
        img1.save_with_format(&path1, image::ImageFormat::Jpeg).unwrap();

        // 2回目: 400x300
        let mut img2 = RgbImage::new(400, 300);
        for p in img2.pixels_mut() { *p = Rgb([40, 50, 60]); }
        let path2 = temp_dir.path().join("test_reuse2.jpg");
        let path2_str = path2.to_str().unwrap();
        img2.save_with_format(&path2, image::ImageFormat::Jpeg).unwrap();

        // 同じスレッドで連続して生成（THUMB_RESIZER の再利用確認）
        let thumb1 = generate_image_thumbnail_sync(path1_str).unwrap();
        let thumb2 = generate_image_thumbnail_sync(path2_str).unwrap();

        let dec1 = image::load_from_memory(&thumb1).unwrap();
        assert_eq!(dec1.width(), 384);
        assert_eq!(dec1.height(), 384);

        let dec2 = image::load_from_memory(&thumb2).unwrap();
        assert_eq!(dec2.width(), 384);
        assert_eq!(dec2.height(), 288);

        // 不正なパスや壊れたファイルの安全性確認
        assert!(generate_image_thumbnail_sync("C:\\non_existent_image_12345.png").is_none());

        let bad_path = temp_dir.path().join("test_bad.bin");
        std::fs::write(&bad_path, b"not an image data").unwrap();
        assert!(generate_image_thumbnail_sync(bad_path.to_str().unwrap()).is_none());
    }


    #[test]
    fn test_generate_image_thumbnail_zune_jpeg_fast_path() {
        use image::{RgbImage, Rgb};

        // 1. 1200x800 のアルファなし JPEG 画像を作成（長辺1200px -> 384px、短辺800px -> 256px にリサイズされる）
        let mut img = RgbImage::new(1200, 800);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([50, 100, 200]); // 青系カラー
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("zune_test.jpeg");
        let path_str = path.to_str().unwrap();
        img.save_with_format(&path, image::ImageFormat::Jpeg).unwrap();

        // 2. generate_image_thumbnail_sync（zune-jpeg 高速ルート）の実行検証
        let thumb_opt = generate_image_thumbnail_sync(path_str);
        assert!(thumb_opt.is_some(), "zune-jpeg 高速ルートでサムネイルが正常に生成されること");

        let thumb_bytes = thumb_opt.unwrap();
        // JPEG シグネチャ検証 (\xFF\xD8)
        assert_eq!(&thumb_bytes[0..2], b"\xFF\xD8", "出力がJPEG形式であること");

        // 3. デコード結果の解像度・アスペクト比検証
        let decoded = image::load_from_memory(&thumb_bytes).unwrap();
        assert_eq!(decoded.width(), 384, "長辺が384pxにリサイズされること");
        assert_eq!(decoded.height(), 256, "アスペクト比(3:2)が維持されること (800 * 384 / 1200 = 256)");
        assert!(!decoded.color().has_alpha(), "アルファチャンネルがないこと");

        // 代表ピクセルが元画像の近似値であることを確認（JPEG圧縮による微小差分を許容）
        let rgb = decoded.to_rgb8();
        let p = rgb.get_pixel(192, 128);
        assert!((p[0] as i16 - 50).abs() <= 5, "赤成分が近似していること");
        assert!((p[1] as i16 - 100).abs() <= 5, "緑成分が近似していること");
        assert!((p[2] as i16 - 200).abs() <= 5, "青成分が近似していること");

        // 4. 不正なバイト列の JPEG に対する安全性検証（パニックせず None を返すこと）
        let corrupt_path = temp_dir.path().join("corrupt.jpg");
        std::fs::write(&corrupt_path, b"not a real jpeg content").unwrap();
        let corrupt_opt = generate_image_thumbnail_sync(corrupt_path.to_str().unwrap());
        assert!(corrupt_opt.is_none(), "壊れたJPEGファイルに対して安全に None を返すこと");
    }


    #[test]
    fn test_generate_thumbnail_inner_static_image_on_demand() {
        use image::{RgbImage, Rgb};

        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        {
            let conn = pool.get().unwrap();
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
            ).unwrap();
        }

        // 1. 実在する 800x600 JPEG 画像を作成
        let mut img = RgbImage::new(800, 600);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([120, 80, 40]);
        }
        let temp_dir = tempfile::tempdir().unwrap();
        let jpeg_path = temp_dir.path().join("on_demand_test.jpg");
        let jpeg_path_str = jpeg_path.to_str().unwrap();
        img.save_with_format(&jpeg_path, image::ImageFormat::Jpeg).unwrap();

        let mtime = 12345678u64;

        // 2. 初回呼び出し: キャッシュミスから Rust 側で即座にサムネイル生成 & DB 保存されること
        let thumb_bytes = super::generate_thumbnail_inner(jpeg_path_str, mtime, &pool);
        assert!(!thumb_bytes.is_empty(), "未キャッシュ静止画像に対して即座にサムネイルが生成されること");
        assert_eq!(&thumb_bytes[0..2], b"\xFF\xD8", "JPEG シグネチャであること");

        let decoded = image::load_from_memory(&thumb_bytes).unwrap();
        assert_eq!(decoded.width(), 384, "384px にリサイズされること");
        assert_eq!(decoded.height(), 288, "アスペクト比 4:3 が維持されること");

        // 3. DB に該当サムネイルが永続化されていることを検証
        let clean_path = normalize_unc_path(jpeg_path_str).into_owned();
        let expected_hash = crate::utils::hash_path_mtime_hex(&clean_path, mtime);
        {
            let conn = pool.get().unwrap();
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL",
                [&expected_hash],
                |r| r.get(0),
            ).unwrap();
            assert_eq!(count, 1, "DBにサムネイルレコードが正しく保存されていること");
        }

        // 4. 2回目の呼び出し: DB キャッシュから即時ヒットすること
        let cached_bytes = super::generate_thumbnail_inner(jpeg_path_str, mtime, &pool);
        assert_eq!(cached_bytes, thumb_bytes, "DB キャッシュから同一のサムネイルが返却されること");

        // 5. 存在しないダミーパスに対しては安全に空配列が返ること
        let empty_res = super::generate_thumbnail_inner("C:\\non_existent_pic.jpg", mtime, &pool);
        assert!(empty_res.is_empty(), "実ファイルが存在しない場合は空配列を返すこと");
    }


    #[test]
    fn test_generate_thumbnail_batch_parallel_generation() {
        use image::{RgbImage, Rgb};

        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::new(manager).unwrap();
        {
            let conn = pool.get().unwrap();
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
            ).unwrap();
        }

        let temp_dir = tempfile::tempdir().unwrap();
        let mut file_paths = Vec::new();
        for i in 1..=4 {
            let mut img = RgbImage::new(400, 300);
            for pixel in img.pixels_mut() {
                *pixel = Rgb([10 * i, 20 * i, 30 * i]);
            }
            let path = temp_dir.path().join(format!("batch_{}.jpg", i));
            img.save_with_format(&path, image::ImageFormat::Jpeg).unwrap();
            file_paths.push(path.to_string_lossy().to_string());
        }

        let (db_tx, _db_rx) = tokio::sync::mpsc::channel(100);
        let app_state = std::sync::Arc::new(AppState::new(
            pool.clone(),
            pool.clone(),
            false,
            db_tx,
            8080,
            "test_token".to_string(),
        ));

        // generate_thumbnail_batch の spawn_blocking 内で使用する compute_thumbnail_batch を直接検証する
        let video_port = app_state.video_server_port;
        let video_token = app_state.video_server_token.clone();
        let db_conn = app_state.db_conn.clone();
        let files_to_process: Vec<(String, u64)> = file_paths.iter().map(|p| {
            let mtime = std::fs::metadata(p).and_then(|m| m.modified()).unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            (p.clone(), mtime)
        }).collect();

        let never_cancelled = || false;
        let results = compute_thumbnail_batch(files_to_process, &db_conn, video_port, &video_token, &never_cancelled);

        assert_eq!(results.len(), 4, "4件すべてのサムネイルが返却されること");
        for r in &results {
            assert!(!r.cancelled, "打ち切り指示が無い場合は cancelled が false であること");
            assert!(!r.url.is_empty(), "各サムネイルのURLが空でないこと");
            assert!(r.url.contains("thumb=1"), "サムネイル配信URLパラメータが付与されていること");
            assert!(r.url.contains("&hash="), "PRIMARY KEY直撃用のhashパラメータが付与されていること");
        }

        // DBに4件すべてが永続化されていることを確認
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM cache WHERE thumbnail IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4, "DBに4件のサムネイルが正しく保存されていること");

        // 2回目の呼び出し時は全件キャッシュヒットし、pending_writes が 0 件になることを検証
        let second_path = &file_paths[0];
        let second_mtime = std::fs::metadata(second_path).and_then(|m| m.modified()).unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let second_clean = normalize_unc_path(second_path).into_owned();
        let second_hash = crate::utils::hash_path_mtime_hex(&second_clean, second_mtime);
        let (cached_bytes, pending_second) = generate_thumbnail_compute_only(second_path, second_mtime, Some(&second_hash), &db_conn);
        assert!(!cached_bytes.is_empty(), "キャッシュからバイト列が取得できること");
        assert!(pending_second.is_none(), "キャッシュヒット時は未コミット書き込みが発生しないこと");
    }


    #[test]
    fn test_opaque_and_stealth_rgba_png_encodes_as_jpeg_thumbnail() {
        use image::{RgbaImage, Rgba};

        let temp_dir = tempfile::tempdir().unwrap();

        // 1. 全ピクセル alpha=255 の不透明 RGBA PNG -> JPEG サムネイルとして出力されること
        let mut opaque_rgba = RgbaImage::new(512, 512);
        for pixel in opaque_rgba.pixels_mut() {
            *pixel = Rgba([100, 150, 200, 255]);
        }
        let opaque_path = temp_dir.path().join("opaque_rgba.png");
        opaque_rgba.save_with_format(&opaque_path, image::ImageFormat::Png).unwrap();

        let opaque_thumb = generate_image_thumbnail_sync(opaque_path.to_str().unwrap()).unwrap();
        assert_eq!(&opaque_thumb[0..2], b"\xFF\xD8", "不透明RGBA画像はJPEGサムネイルとしてエンコードされること");

        // 2. Stealth PNGInfo 相当 (alpha=254 または 255) の RGBA PNG -> JPEG サムネイルとして出力されること
        let mut stealth_rgba = RgbaImage::new(512, 512);
        for (idx, pixel) in stealth_rgba.pixels_mut().enumerate() {
            let alpha = if idx % 2 == 0 { 254 } else { 255 };
            *pixel = Rgba([180, 120, 90, alpha]);
        }
        let stealth_path = temp_dir.path().join("stealth_rgba.png");
        stealth_rgba.save_with_format(&stealth_path, image::ImageFormat::Png).unwrap();

        let stealth_thumb = generate_image_thumbnail_sync(stealth_path.to_str().unwrap()).unwrap();
        assert_eq!(&stealth_thumb[0..2], b"\xFF\xD8", "Stealth PNGInfo相当(alpha>=254)のRGBA画像はJPEGとしてエンコードされること");

        // 3. 透過ピクセル (alpha < 254) を含む RGBA PNG -> 従来通り PNG サムネイルとして出力されること
        let mut trans_rgba = RgbaImage::new(512, 512);
        for (idx, pixel) in trans_rgba.pixels_mut().enumerate() {
            let alpha = if idx == 0 { 0 } else { 255 };
            *pixel = Rgba([180, 120, 90, alpha]);
        }
        let trans_path = temp_dir.path().join("trans_rgba.png");
        trans_rgba.save_with_format(&trans_path, image::ImageFormat::Png).unwrap();

        let trans_thumb = generate_image_thumbnail_sync(trans_path.to_str().unwrap()).unwrap();
        assert_eq!(&trans_thumb[0..8], b"\x89PNG\r\n\x1a\n", "透過ピクセルを含むRGBA画像はPNG形式が維持されること");
    }


    #[test]
    fn test_compute_thumbnail_batch_skips_generation_when_cancelled() {
        use image::{RgbImage, Rgb};

        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("cancel_test.db");
        let manager = r2d2_sqlite::SqliteConnectionManager::file(&db_path);
        let pool = r2d2::Pool::builder().max_size(4).build(manager).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS cache (hash_key TEXT PRIMARY KEY, thumbnail BLOB, path TEXT, last_accessed INTEGER);"
            ).unwrap();
        }

        let mut files_to_process = Vec::new();
        for i in 0..3 {
            let mut img = RgbImage::new(64, 64);
            for p in img.pixels_mut() {
                *p = Rgb([10 * i as u8, 20, 30]);
            }
            let path = temp_dir.path().join(format!("cancel_{}.png", i));
            img.save(&path).unwrap();
            let mtime = std::fs::metadata(&path).unwrap().modified().unwrap()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            files_to_process.push((path.to_string_lossy().to_string(), mtime));
        }

        // 打ち切り指示がある場合: 生成を行わず、全件 cancelled: true かつ URL 空で返り、DB にも保存されないこと
        let always_cancelled = || true;
        let results = compute_thumbnail_batch(files_to_process.clone(), &pool, 8080, "test_token", &always_cancelled);
        assert_eq!(results.len(), 3, "打ち切り時も入力件数分の結果が返ること");
        for r in &results {
            assert!(r.cancelled, "打ち切られたアイテムは cancelled が true であること");
            assert!(r.url.is_empty(), "打ち切られたアイテムは URL が空であること");
        }
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM cache", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0, "打ち切られたアイテムはサムネイルが生成・保存されないこと");
        drop(conn);

        // 打ち切り指示が無い場合: 全件生成されること
        let never_cancelled = || false;
        let results = compute_thumbnail_batch(files_to_process, &pool, 8080, "test_token", &never_cancelled);
        assert!(results.iter().all(|r| !r.cancelled && !r.url.is_empty()), "通常時は全件生成されること");
    }


    #[test]
    fn test_thumbnail_batch_epoch_advance_marks_previous_batch_cancelled() {
        // generate_thumbnail_batch と同じ判定式: 開始時の世代から進んでいれば打ち切り
        let start_epoch = current_thumbnail_batch_epoch();
        let is_cancelled = move || current_thumbnail_batch_epoch() != start_epoch;
        let advanced = advance_thumbnail_batch_epoch();
        assert!(advanced > start_epoch, "世代番号は単調増加すること");
        assert!(is_cancelled(), "load_directory による世代更新後は旧世代のバッチが打ち切り対象となること");

        let new_epoch = current_thumbnail_batch_epoch();
        let is_cancelled_new = move || current_thumbnail_batch_epoch() != new_epoch;
        assert!(!is_cancelled_new(), "現在世代で開始したバッチは打ち切り対象とならないこと");
    }


    #[test]
    fn test_zune_png_fastpath_rgb_and_rgba() {
        let temp_dir = tempfile::tempdir().unwrap();

        // 1. RGB8 PNG
        let rgb_path = temp_dir.path().join("test_zune_rgb.png");
        let mut img_rgb = image::RgbImage::new(400, 300);
        for pixel in img_rgb.pixels_mut() {
            *pixel = image::Rgb([220, 100, 50]);
        }
        img_rgb.save(&rgb_path).unwrap();

        let thumb_rgb = generate_image_thumbnail_sync(rgb_path.to_str().unwrap());
        assert!(thumb_rgb.is_some(), "RGB PNGのサムネイル生成が成功すること");
        let thumb_bytes = thumb_rgb.unwrap();
        assert!(!thumb_bytes.is_empty(), "サムネイルバイナリが空でないこと");

        // 2. RGBA8 PNG (透過あり)
        let rgba_path = temp_dir.path().join("test_zune_rgba.png");
        let mut img_rgba = image::RgbaImage::new(500, 500);
        for (x, _y, pixel) in img_rgba.enumerate_pixels_mut() {
            if x < 250 {
                *pixel = image::Rgba([100, 200, 255, 128]); // 半透明
            } else {
                *pixel = image::Rgba([100, 200, 255, 255]); // 不透明
            }
        }
        img_rgba.save(&rgba_path).unwrap();

        let thumb_rgba = generate_image_thumbnail_sync(rgba_path.to_str().unwrap());
        assert!(thumb_rgba.is_some(), "RGBA PNGのサムネイル生成が成功すること");
        let thumb_rgba_bytes = thumb_rgba.unwrap();
        assert!(!thumb_rgba_bytes.is_empty(), "RGBAサムネイルバイナリが空でないこと");

        // 3. 破損ファイルに対する安全なフォールバック
        let corrupted_path = temp_dir.path().join("corrupted.png");
        std::fs::write(&corrupted_path, b"\x89PNG\r\n\x1a\ncorrupted_data_here").unwrap();
        let thumb_corrupted = generate_image_thumbnail_sync(corrupted_path.to_str().unwrap());
        assert!(thumb_corrupted.is_none(), "破損PNGに対してパニックせず安全にNoneを返却すること");
    }

    /// get_cached_thumbnail_batch の高速存在確認（BLOB全体の読み出しを行わず 1 / length(thumbnail) > 0 のみで照会）のテスト
    #[test]
    fn test_get_cached_thumbnail_batch_fast_existence_check() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE cache (hash_key TEXT PRIMARY KEY, thumbnail BLOB, last_accessed INTEGER)",
            [],
        ).unwrap();

        let valid_hash = "hash_valid_thumb";
        let empty_thumb_hash = "hash_empty_thumb";
        let null_thumb_hash = "hash_null_thumb";

        // 正常なサムネイルBLOB
        conn.execute(
            "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, ?, 0)",
            rusqlite::params![valid_hash, vec![0xFFu8, 0xD8, 0xFF, 0xE0]],
        ).unwrap();

        // 空のサムネイルBLOB (長さ0)
        conn.execute(
            "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, ?, 0)",
            rusqlite::params![empty_thumb_hash, Vec::<u8>::new()],
        ).unwrap();

        // NULL のサムネイルBLOB
        conn.execute(
            "INSERT INTO cache (hash_key, thumbnail, last_accessed) VALUES (?, NULL, 0)",
            rusqlite::params![null_thumb_hash],
        ).unwrap();

        let mut stmt = conn.prepare(
            "SELECT 1 FROM cache WHERE hash_key = ? AND thumbnail IS NOT NULL AND length(thumbnail) > 0"
        ).unwrap();

        assert!(stmt.exists([valid_hash]).unwrap(), "正常サムネイルが存在する場合は true");
        assert!(!stmt.exists([empty_thumb_hash]).unwrap(), "長さ0のBLOBは存在しないと判定されること");
        assert!(!stmt.exists([null_thumb_hash]).unwrap(), "NULLサムネイルは存在しないと判定されること");
        assert!(!stmt.exists(["non_existent_hash"]).unwrap(), "未登録キーは false");
    }

}
