use crate::models::ViewerImageResult;
use crate::state::AppState;
use crate::utils::get_veloce_data_dir;
use tauri::Manager;

#[tauri::command]
pub fn get_viewer_image(
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Option<ViewerImageResult> {
    let label = window.label();
    if let Ok(viewer_paths) = state.viewer_paths.lock() {
        if let Some(paths) = viewer_paths.get(label) {
            if let Some(path) = paths.get(index) {
                let chunk_start = index.saturating_sub(32);
                let chunk_end = std::cmp::min(paths.len(), index + 33);
                let chunk = paths[chunk_start..chunk_end].to_vec();
                return Some(ViewerImageResult {
                    path: path.clone(),
                    total: paths.len(),
                    index,
                    chunk_start,
                    chunk,
                });
            }
        }
    }
    None
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
        if let Ok(paths) = state.image_paths.lock() {
            let (target, resolved_idx) = if let Some(ref fp) = file_path {
                if paths.get(current_index).map(|p| p == fp).unwrap_or(false) {
                    (Some(fp.clone()), current_index)
                } else {
                    // O(1) 逆引きインデックスを活用して即座にインデックスを解決（O(N) 線形探索を排除）
                    let idx = if let Ok(idx_map) = state.path_to_filtered_idx.lock() {
                        idx_map.get(fp).copied().unwrap_or(current_index)
                    } else {
                        current_index
                    };
                    (Some(fp.clone()), idx)
                }
            } else {
                (paths.get(current_index).cloned(), current_index)
            };
            (target, resolved_idx, std::sync::Arc::clone(&paths))
        } else {
            (file_path.clone(), current_index, std::sync::Arc::new(Vec::new()))
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

    let hash_str = get_viewer_hash_str(target_path.as_ref());

    // 既に同じ画像（ハッシュ値が一致）のビューアーが開いている場合は、フォーカスを当てるだけで終了
    let mut found_existing = false;
    if let Ok(hashes) = state.viewer_hashes.lock() {
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

    // viewer_pool_0 が非表示であればそれを再利用する
    if let Some(pool_win) = app.get_window("viewer_pool_0") {
        if !pool_win.is_visible().unwrap_or(false) {
            if let Ok(mut viewer_paths) = state.viewer_paths.lock() {
                viewer_paths.insert("viewer_pool_0".to_string(), current_paths.clone());
            }
            if let Ok(mut hashes) = state.viewer_hashes.lock() {
                hashes.insert("viewer_pool_0".to_string(), hash_str.clone());
            }

            // JS側に新しい画像のロードを指示
            #[derive(Clone, serde::Serialize)]
            struct ViewerInitSessionPayload {
                index: usize,
                path: Option<String>,
                total: usize,
            }

            let _ = pool_win.emit(
                "viewer-init-session",
                ViewerInitSessionPayload {
                    index: resolved_index,
                    path: target_path.clone(),
                    total: current_paths.len(),
                },
            );
            
            let _ = pool_win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: win_width,
                height: win_height,
            }));
            let _ = pool_win.center();
            let _ = pool_win.show();
            let _ = pool_win.set_focus();
            return Ok(());
        }
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
    let _ = window.show();
    let _ = window.set_focus();
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
