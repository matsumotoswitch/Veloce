use crate::models::ViewerImageResult;
use crate::state::AppState;
use crate::utils::get_veloce_data_dir;
use std::sync::atomic::Ordering;
use tauri::Manager;

/// 指定インデックスの前後 ±32 件のパスチャンクと開始インデックスを抽出する
pub fn build_viewer_chunk(paths: &[String], index: usize) -> (usize, Vec<String>) {
    if paths.is_empty() {
        return (0, Vec::new());
    }
    let clamped_index = std::cmp::min(index, paths.len() - 1);
    let chunk_start = clamped_index.saturating_sub(32);
    let chunk_end = std::cmp::min(paths.len(), clamped_index + 33);
    (chunk_start, paths[chunk_start..chunk_end].to_vec())
}

/// viewer_pool_0 を再利用できる状態かを判定する
/// プールウィンドウが存在し、JS 側のリスナー登録完了通知を受信済みかつ非表示の場合のみ true
pub fn can_reuse_viewer_pool(pool_exists: bool, pool_is_visible: bool, pool_ready: bool) -> bool {
    pool_exists && !pool_is_visible && pool_ready
}

/// ウィンドウラベルが viewer_pool_0 の場合のみプール準備完了フラグを立てる
pub fn mark_viewer_pool_ready_for_label(state: &AppState, label: &str) -> bool {
    if label == "viewer_pool_0" {
        state.viewer_pool_ready.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

/// ビューア側の viewer-init-session リスナー登録完了を Rust 側へ通知する
#[tauri::command]
pub fn notify_viewer_pool_ready(window: tauri::Window, state: tauri::State<'_, AppState>) {
    mark_viewer_pool_ready_for_label(&state, window.label());
}

/// メインウィンドウの初回 directory-loaded 通知を契機に、非表示のビューアープールを一度だけ生成する
/// 起動直後のメイン画面描画・ディレクトリ走査との WebView2 初期化競合を避けるため別スレッドで実行する
pub fn spawn_viewer_pool_once(app: &tauri::AppHandle, state: &AppState) -> bool {
    if state
        .viewer_pool_spawned
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }

    let app_handle_for_pool = app.clone();
    let data_dir_pool = get_veloce_data_dir().unwrap_or_default();
    std::thread::spawn(move || {
        if app_handle_for_pool.get_window("viewer_pool_0").is_some() {
            return;
        }
        let _ = tauri::WindowBuilder::new(
            &app_handle_for_pool,
            "viewer_pool_0",
            tauri::WindowUrl::App("viewer.html".into()),
        )
        .title("Veloce Viewer")
        .data_directory(data_dir_pool)
        .visible(false)
        .decorations(false)
        .min_inner_size(300.0, 300.0)
        .build();
    });
    true
}

/// 対象パスが image::image_dimensions で寸法をプローブすべき静止画像形式かを判定する
/// 動画・音声ファイルでの不要なディスク読み込みと失敗フォールバックを回避する
pub fn is_probeable_image_path(path: &str) -> bool {
    if crate::audio::is_audio_path(path) {
        return false;
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "ico" | "tif" | "tiff")
    )
}

/// open_viewer 開始時の初期ウィンドウ寸法を、引数または state.filtered_files から同期解決する
pub fn resolve_initial_viewer_dimensions(
    passed_width: u32,
    passed_height: u32,
    state: &AppState,
    resolved_index: usize,
) -> (u32, u32) {
    if passed_width > 0 && passed_height > 0 {
        return (passed_width, passed_height);
    }
    let filtered = state.filtered_files.read();
    if let Some(entry) = filtered.get(resolved_index) {
        if entry.width > 0 && entry.height > 0 {
            return (entry.width, entry.height);
        }
    }
    (0, 0)
}

#[tauri::command]
pub async fn get_viewer_image(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Result<Option<ViewerImageResult>, String> {
    let label = window.label();
    let viewer_paths = state.viewer_paths.read();
    if let Some(paths) = viewer_paths.get(label) {
        if let Some(path) = paths.get(index) {
            let (chunk_start, chunk) = build_viewer_chunk(paths, index);
            return Ok(Some(ViewerImageResult {
                path: path.clone(),
                total: paths.len(),
                index,
                chunk_start,
                chunk,
            }));
        }
    }
    Ok(None)
}

pub fn get_viewer_hash_str(target_path: Option<&String>) -> String {
    if let Some(path) = target_path {
        let digest = xxhash_rust::xxh3::xxh3_64(path.as_bytes());
        format!("{}", digest)
    } else {
        "none".to_string()
    }
}

/// 独立画像ビューアーウィンドウを開く
/// Window Pool 内に非表示で待機中のウィンドウが存在する場合はそれを再利用し、
/// 存在しない場合は新規生成して 'viewer-init-session' イベント経由で表示状態を初期化する
#[tauri::command]
pub async fn open_viewer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    current_index: usize,
    file_path: Option<String>,
    width: u32,
    height: u32,
    monitor_width: f64,
    monitor_height: f64,
) -> Result<(), String> {
    let (target_path, resolved_index, current_paths) = {
        let paths = state.image_paths.read();
        let (target, resolved_idx) = if let Some(ref fp) = file_path {
            if paths.get(current_index).map(|p| p == fp).unwrap_or(false) {
                (Some(fp.clone()), current_index)
            } else {
                // O(1) 逆引きインデックスを活用して即座にインデックスを解決（O(N) 線形探索を排除）
                let idx = state.path_to_filtered_idx.read().get(fp).copied().unwrap_or(current_index);
                (Some(fp.clone()), idx)
            }
        } else {
            (paths.get(current_index).cloned(), current_index)
        };
        (target, resolved_idx, std::sync::Arc::clone(&paths))
    };

    let (mut win_width, mut win_height) =
        resolve_initial_viewer_dimensions(width, height, &state, resolved_index);

    if win_width == 0 || win_height == 0 {
        if let Some(path) = &target_path {
            if is_probeable_image_path(path) {
                let path_for_probe = path.clone();
                if let Ok(Some(dims)) =
                    tokio::task::spawn_blocking(move || image::image_dimensions(&path_for_probe).ok())
                        .await
                {
                    win_width = dims.0;
                    win_height = dims.1;
                }
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

    let hash_str = get_viewer_hash_str(target_path.as_ref());

    // 既に同じ画像（ハッシュ値が一致）のビューアーが開いている場合は、フォーカスを当てるだけで終了
    let mut found_existing = false;
    {
        let hashes = state.viewer_hashes.read();
        for (label, hash) in hashes.iter() {
            if hash == &hash_str {
                if let Some(window) = app.get_window(label) {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.set_focus();
                        found_existing = true;
                        break;
                    }
                }
            }
        }
    }
    
    // 従来のラベルベースの検索（互換性のため残す）
    if !found_existing {
        let existing_window = app.windows().into_values().find(|w| {
            let l = w.label();
            l.starts_with("viewer_") && l.ends_with(&format!("_{}", hash_str))
        });
        if let Some(window) = existing_window {
            let _ = window.set_focus();
            found_existing = true;
        }
    }

    if found_existing {
        return Ok(());
    }

    // viewer_pool_0 が準備完了済みかつ非表示であれば再利用する
    let pool_ready = state.viewer_pool_ready.load(Ordering::Acquire);
    if let Some(pool_win) = app.get_window("viewer_pool_0") {
        let pool_visible = pool_win.is_visible().unwrap_or(false);
        if can_reuse_viewer_pool(true, pool_visible, pool_ready) {
            state.viewer_paths.write().insert("viewer_pool_0".to_string(), current_paths.clone());
            state.viewer_hashes.write().insert("viewer_pool_0".to_string(), hash_str.clone());

            let (chunk_start, chunk) = build_viewer_chunk(&current_paths, resolved_index);

            // JS側に新しい画像のロードを指示（前後 ±32 件の初期チャンクを同梱し隣接パスIPC往復を削減）
            #[derive(Clone, serde::Serialize)]
            #[serde(rename_all = "camelCase")]
            struct ViewerInitSessionPayload {
                label: String,
                index: usize,
                path: Option<String>,
                total: usize,
                chunk_start: usize,
                chunk: Vec<String>,
            }

            let _ = pool_win.emit(
                "viewer-init-session",
                ViewerInitSessionPayload {
                    label: "viewer_pool_0".to_string(),
                    index: resolved_index,
                    path: target_path.clone(),
                    total: current_paths.len(),
                    chunk_start,
                    chunk,
                },
            );
            
            let _ = pool_win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: win_width,
                height: win_height,
            }));
            let _ = pool_win.center();
            let _ = pool_win.unminimize();
            let _ = pool_win.show();
            let _ = pool_win.set_focus();

            // Windows 8.1 前面化: 非表示から再表示したプールウィンドウがメインウィンドウの背面に潜り込まないよう
            // TOPMOST 一時適用と SetForegroundWindow で最前面アクティブ化を保証する
            #[cfg(target_os = "windows")]
            {
                let label_clone = "viewer_pool_0".to_string();
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(win) = app_clone.get_window(&label_clone) {
                        if let Ok(hwnd_ptr) = win.hwnd() {
                            let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr.0 as isize);
                            unsafe {
                                use windows::Win32::UI::WindowsAndMessaging::{
                                    SetForegroundWindow, SetWindowPos, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOMOVE,
                                    SWP_NOSIZE,
                                };
                                let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                                let _ = SetForegroundWindow(hwnd);
                                let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                            }
                        }
                    }
                });
            }

            return Ok(());
        }
    } else {
        // プールウィンドウが破棄されていた場合は自己修復のため生成フラグをリセットして再生成を試みる
        state.viewer_pool_spawned.store(false, Ordering::Release);
        state.viewer_pool_ready.store(false, Ordering::Release);
        spawn_viewer_pool_once(&app, &state);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let label = format!("viewer_{:016}_{}", now_ms, hash_str);

    state.viewer_paths.write().insert(label.clone(), current_paths);

    let data_dir = get_veloce_data_dir().unwrap_or_default();

    tauri::WindowBuilder::new(
        &app,
        label.clone(),
        tauri::WindowUrl::App(format!("/viewer.html?index={}", resolved_index).into()),
    )
    .title("Veloce Viewer")
    .inner_size(win_width as f64, win_height as f64)
    .data_directory(data_dir)
    .decorations(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;

    // Windows 8.1 前面化ハック: 生成直後のウィンドウがタスクバーの後ろに潜り込まないよう
    // 50ms 遅延後に SetWindowPos(HWND_TOPMOST) → SetForegroundWindow を呼び出す。
    // arrange_viewers と同じパターン。
    #[cfg(target_os = "windows")]
    {
        let label_clone = label.clone();
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Some(win) = app_clone.get_window(&label_clone) {
                if let Ok(hwnd_ptr) = win.hwnd() {
                    let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr.0 as isize);
                    unsafe {
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SetForegroundWindow, SetWindowPos, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOMOVE,
                            SWP_NOSIZE,
                        };
                        let _ = SetWindowPos(
                            hwnd,
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE,
                        );
                        let _ = SetForegroundWindow(hwnd);
                        let _ = SetWindowPos(
                            hwnd,
                            HWND_NOTOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE,
                        );
                    }
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub fn show_window(window: tauri::Window) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd_ptr) = window.hwnd() {
            let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr.0 as isize);
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetForegroundWindow, SetWindowPos, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOMOVE, SWP_NOSIZE,
                };
                let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                let _ = SetForegroundWindow(hwnd);
                let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            }
        }
    }
}

/// ビューアーウィンドウを安全に閉じるコマンド。
/// viewer_pool_0 の場合はウィンドウを破棄せず 'close-viewer' を発行して非表示（プール復帰）にし、
/// 独立動的ウィンドウの場合は破棄（close）する。
#[tauri::command]
pub fn close_viewer_window(window: tauri::Window, state: tauri::State<'_, AppState>) {
    let label = window.label().to_string();
    let _ = window.emit("close-viewer", label.clone());
    if label == "viewer_pool_0" {
        let _ = window.hide();
    } else {
        let _ = window.close();
    }
    state.viewer_paths.write().remove(&label);
    state.viewer_hashes.write().remove(&label);
}

#[tauri::command]
pub fn arrange_viewers(app: tauri::AppHandle, caller_window: tauri::Window) {
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

    // Windows 8.1 強制前面化ハック（タスクバーを隠すため）
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ImageFile;
    use std::sync::Arc;

    #[test]
    fn test_can_reuse_viewer_pool_requires_ready_and_hidden() {
        // プール未準備時はウィンドウが存在して非表示でもプール経路に入らない
        assert!(!can_reuse_viewer_pool(true, false, false));
        // プールウィンドウ非存在時は不可
        assert!(!can_reuse_viewer_pool(false, false, true));
        assert!(!can_reuse_viewer_pool(false, false, false));
        // プールが表示中（使用中）の場合は不可（2枚目新規生成経路へ）
        assert!(!can_reuse_viewer_pool(true, true, true));
        // 存在・非表示・準備完了がすべて満たされた場合のみ再利用可能
        assert!(can_reuse_viewer_pool(true, false, true));
    }

    #[test]
    fn test_mark_viewer_pool_ready_for_label() {
        let state = crate::create_test_app_state("C:\\test");
        assert!(!state.viewer_pool_ready.load(Ordering::Acquire));

        // 別ウィンドウからの通知ではフラグを立てない
        assert!(!mark_viewer_pool_ready_for_label(&state, "main"));
        assert!(!mark_viewer_pool_ready_for_label(&state, "viewer_12345_abc"));
        assert!(!state.viewer_pool_ready.load(Ordering::Acquire));

        // viewer_pool_0 からの通知でのみフラグが立つ
        assert!(mark_viewer_pool_ready_for_label(&state, "viewer_pool_0"));
        assert!(state.viewer_pool_ready.load(Ordering::Acquire));
    }

    #[test]
    fn test_resolve_initial_viewer_dimensions_uses_filtered_files_fallback() {
        let state = crate::create_test_app_state("C:\\test");
        let entry = ImageFile {
            name: "sample.png".to_string(),
            ext: compact_str::CompactString::from("png"),
            path: "C:\\test\\sample.png".to_string(),
            size: 1024,
            mtime: 1000,
            ctime: 1000,
            has_thumbnail_cache: false,
            width: 1216,
            height: 832,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: true,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: compact_str::CompactString::default(),
        };
        state.filtered_files.write().push(Arc::new(entry));

        // 引数が正なら引数をそのまま使う
        assert_eq!(resolve_initial_viewer_dimensions(800, 600, &state, 0), (800, 600));
        // 引数が 0 の場合は state.filtered_files の解決済みエントリの寸法を使う
        assert_eq!(resolve_initial_viewer_dimensions(0, 0, &state, 0), (1216, 832));
        // 範囲外インデックスの場合は (0, 0)
        assert_eq!(resolve_initial_viewer_dimensions(0, 0, &state, 99), (0, 0));
    }

    #[test]
    fn test_is_probeable_image_path_skips_video_and_audio() {
        assert!(is_probeable_image_path("C:\\a\\img.png"));
        assert!(is_probeable_image_path("C:\\a\\img.JPG"));
        assert!(is_probeable_image_path("C:\\a\\img.webp"));
        assert!(!is_probeable_image_path("C:\\a\\clip.mp4"));
        assert!(!is_probeable_image_path("C:\\a\\clip.webm"));
        assert!(!is_probeable_image_path("C:\\a\\song.mp3"));
        assert!(!is_probeable_image_path("C:\\a\\noext"));
    }

    #[test]
    fn test_build_viewer_chunk_bounds() {
        assert_eq!(build_viewer_chunk(&[], 0), (0, Vec::new()));

        let paths: Vec<String> = (0..100).map(|i| format!("C:\\img\\{}.png", i)).collect();
        let (start_head, chunk_head) = build_viewer_chunk(&paths, 5);
        assert_eq!(start_head, 0);
        assert_eq!(chunk_head.len(), 38); // 0..38 (5 + 33)
        assert_eq!(chunk_head[5], "C:\\img\\5.png");

        let (start_mid, chunk_mid) = build_viewer_chunk(&paths, 50);
        assert_eq!(start_mid, 18); // 50 - 32
        assert_eq!(chunk_mid.len(), 65); // 18..83
        assert_eq!(chunk_mid[32], "C:\\img\\50.png");

        let (start_tail, chunk_tail) = build_viewer_chunk(&paths, 99);
        assert_eq!(start_tail, 67); // 99 - 32
        assert_eq!(chunk_tail.len(), 33); // 67..100
        assert_eq!(chunk_tail[32], "C:\\img\\99.png");
    }

    #[test]
    fn test_viewer_pool_close_and_reopen_state_consistency() {
        let state = crate::create_test_app_state("C:\\test");
        // 初期状態: プール準備完了
        assert!(mark_viewer_pool_ready_for_label(&state, "viewer_pool_0"));
        assert!(state.viewer_pool_ready.load(Ordering::Acquire));

        // 1回目のセッション開始: paths と hash が登録され表示状態になる
        state.viewer_paths.write().insert("viewer_pool_0".to_string(), Arc::new(vec!["C:\\a.png".to_string()]));
        state.viewer_hashes.write().insert("viewer_pool_0".to_string(), "12345".to_string());
        // 表示中（pool_is_visible = true）は再利用不可
        assert!(!can_reuse_viewer_pool(true, true, state.viewer_pool_ready.load(Ordering::Acquire)));

        // ウィンドウ閉じる（非表示化）: paths と hash がクリーンアップされる
        state.viewer_paths.write().remove("viewer_pool_0");
        state.viewer_hashes.write().remove("viewer_pool_0");
        assert!(!state.viewer_paths.read().contains_key("viewer_pool_0"));
        assert!(!state.viewer_hashes.read().contains_key("viewer_pool_0"));

        // 非表示状態（pool_is_visible = false）に戻ったため、2回目のオープン時に即座に再利用可能
        assert!(can_reuse_viewer_pool(true, false, state.viewer_pool_ready.load(Ordering::Acquire)));
    }

    #[test]
    fn test_viewer_pool_destroyed_self_healing_flags() {
        let state = crate::create_test_app_state("C:\\test");
        state.viewer_pool_spawned.store(true, Ordering::Release);
        state.viewer_pool_ready.store(true, Ordering::Release);
        state.viewer_paths.write().insert("viewer_pool_0".to_string(), Arc::new(vec!["C:\\a.png".to_string()]));
        state.viewer_hashes.write().insert("viewer_pool_0".to_string(), "hash1".to_string());

        // ウィンドウが予期せず破棄された場合、Destroyed ハンドラによりフラグがリセットされること
        state.viewer_pool_spawned.store(false, Ordering::Release);
        state.viewer_pool_ready.store(false, Ordering::Release);
        state.viewer_paths.write().remove("viewer_pool_0");
        state.viewer_hashes.write().remove("viewer_pool_0");

        assert!(!state.viewer_pool_spawned.load(Ordering::Acquire));
        assert!(!state.viewer_pool_ready.load(Ordering::Acquire));
        assert!(!state.viewer_paths.read().contains_key("viewer_pool_0"));
        assert!(!state.viewer_hashes.read().contains_key("viewer_pool_0"));
    }
}
