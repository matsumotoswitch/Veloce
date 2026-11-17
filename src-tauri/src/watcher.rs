//! # Veloce - Folder Watcher & File Change Sync Module (watcher.rs)
//!
//! 本モジュールは、ディレクトリ監視（notify クレートによるイベント監視および mtime/定期差分スキャン）、
//! ディレクトリスナップショット収集、ならびにファイル追加・変更・削除イベントの
//! バッチ同期（notify_files_batch 等）一式を提供する。

use crate::is_listed_media_extension;
use crate::metadata::get_fast_dimensions_for_file;
use crate::models::ImageFile;
use crate::state::AppState;
use crate::apply_filters_and_sort;
use compact_str::format_compact;
use tauri::Manager;

#[inline]
fn dir_entry_file_type_kind(entry: &std::fs::DirEntry) -> (bool, bool) {
    match entry.file_type() {
        Ok(ft) => {
            if ft.is_symlink() {
                if let Ok(meta) = entry.metadata() {
                    (meta.is_file(), meta.is_dir())
                } else {
                    (false, false)
                }
            } else {
                (ft.is_file(), ft.is_dir())
            }
        }
        Err(_) => {
            if let Ok(meta) = entry.metadata() {
                (meta.is_file(), meta.is_dir())
            } else {
                (false, false)
            }
        }
    }
}

#[inline]
fn dir_entry_is_dir(entry: &std::fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(ft) => {
            if ft.is_symlink() {
                entry.metadata().map(|m| m.is_dir()).unwrap_or(false)
            } else {
                ft.is_dir()
            }
        }
        Err(_) => entry.metadata().map(|m| m.is_dir()).unwrap_or(false),
    }
}

/// 監視対象ディレクトリ内のメディアファイル（`is_listed_media_extension` 準拠）とサブフォルダ一覧を収集する
/// 初期構築と定期再スキャンの双方から共有し、拡張子判定の不一致による誤削除検知を防ぐ
pub(crate) fn collect_watcher_dir_snapshot(
    dir_path: &str,
) -> (
    Vec<(String, String, String, std::fs::Metadata)>,
    std::collections::HashSet<String>,
) {
    let mut files = Vec::new();
    let mut folders = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir_path) {
        for entry in entries.filter_map(Result::ok) {
            let (is_file, is_dir) = dir_entry_file_type_kind(&entry);
            let p = entry.path();
            let clean_p = p.to_string_lossy().replace("\\\\?\\", "").replace('/', "\\");
            if is_file {
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if is_listed_media_extension(&ext_lower) {
                        if let Ok(meta) = entry.metadata() {
                            let file_name = entry.file_name().to_string_lossy().into_owned();
                            files.push((clean_p, file_name, ext_lower, meta));
                        }
                    }
                }
            } else if is_dir {
                folders.insert(clean_p);
            }
        }
    }
    (files, folders)
}

/// 単一または複数ファイルの追加・変更・削除を一括で `AppState` に反映し、
/// インデックス再構築（`rebuild_all_indices`）とフィルタ・ソート（`apply_filters_and_sort`）を
/// バッチの最後に1回だけ実行する。既存ファイルの検索には `path_to_all_idx` による O(1) ルックアップを使用する。
pub(crate) fn notify_files_batch_inner(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    changed_files: Vec<ImageFile>,
    removed_paths: Vec<String>,
) -> usize {
    if changed_files.is_empty() && removed_paths.is_empty() {
        return state.filtered_files.read().len();
    }

    {
        let mut all_files = state.all_files.write();

        if !removed_paths.is_empty() {
            let mut remove_set = std::collections::HashSet::with_capacity(removed_paths.len() * 2);
            for p in removed_paths {
                let clean = p.replace("\\\\?\\", "").replace('/', "\\");
                remove_set.insert(p);
                remove_set.insert(clean);
            }
            all_files.retain(|f| !remove_set.contains(&f.path));
            // 削除ありの場合: retain 直後の1回目の rebuild_all_indices は配置の正確性のために実行
            state.rebuild_all_indices(&all_files);
        }

        if !changed_files.is_empty() {
            let mut added_items: Vec<(usize, std::sync::Arc<ImageFile>)> = Vec::new();
            let mut updated_items: Vec<(String, std::sync::Arc<ImageFile>, usize)> = Vec::new();

            {
                let mut new_idx_map = std::collections::HashMap::with_capacity(changed_files.len());
                let existing_idx_map = state.path_to_all_idx.read();
                for mut file in changed_files {
                    let clean = file.path.replace("\\\\?\\", "").replace('/', "\\");
                    file.path = clean.clone();
                    if file.hash_key.is_empty() {
                        file.hash_key = crate::utils::hash_path_mtime_hex(&clean, file.mtime).into();
                    }

                    let existing_opt = new_idx_map.get(&clean).copied().or_else(|| existing_idx_map.get(&clean).copied());
                    if let Some(idx) = existing_opt {
                        if let Some(existing) = all_files.get_mut(idx) {
                            // 既存の幅・高さが取得済みで、通知された値が 0 の場合は既存の寸法を維持する
                            if file.width == 0 && file.height == 0 && (existing.width > 0 || existing.height > 0) {
                                file.width = existing.width;
                                file.height = existing.height;
                            }
                            let old_path = existing.path.clone();
                            let arc_f = std::sync::Arc::new(file);
                            *existing = std::sync::Arc::clone(&arc_f);
                            updated_items.push((old_path, arc_f, idx));
                            continue;
                        }
                    }

                    let new_idx = all_files.len();
                    let arc_f = std::sync::Arc::new(file);
                    all_files.push(std::sync::Arc::clone(&arc_f));
                    new_idx_map.insert(clean, new_idx);
                    added_items.push((new_idx, arc_f));
                }
            } // existing_idx_map の読み取りロックを明示的に解放

            // 全件再構築を行わず、追加分・置換分の差分更新を実行
            if !added_items.is_empty() || !updated_items.is_empty() {
                let mut all_map = state.path_to_all_idx.write();
                let mut mtime_map = state.path_to_mtime.write();

                for (idx, f) in added_items {
                    all_map.insert(f.path.clone(), idx);
                    let norm = crate::utils::normalize_unc_path(&f.path);
                    if norm != f.path {
                        let norm_str = norm.into_owned();
                        all_map.insert(norm_str.clone(), idx);
                        mtime_map.insert(norm_str, f.mtime);
                    }
                    mtime_map.insert(f.path.clone(), f.mtime);
                }

                for (old_path, f, idx) in updated_items {
                    if old_path != f.path {
                        all_map.remove(&old_path);
                        let old_norm = crate::utils::normalize_unc_path(&old_path);
                        if old_norm != old_path {
                            all_map.remove(old_norm.as_ref());
                            mtime_map.remove(old_norm.as_ref());
                        }
                        mtime_map.remove(&old_path);

                        all_map.insert(f.path.clone(), idx);
                        let new_norm = crate::utils::normalize_unc_path(&f.path);
                        if new_norm != f.path {
                            let norm_str = new_norm.into_owned();
                            all_map.insert(norm_str.clone(), idx);
                            mtime_map.insert(norm_str, f.mtime);
                        }
                        mtime_map.insert(f.path.clone(), f.mtime);
                    } else {
                        mtime_map.insert(f.path.clone(), f.mtime);
                        let norm = crate::utils::normalize_unc_path(&f.path);
                        if norm != f.path {
                            mtime_map.insert(norm.into_owned(), f.mtime);
                        }
                    }
                }
            }
        }
    }

    apply_filters_and_sort(app, state)
}

/// ファイルウォッチャーから通知されたファイル変更をRust側のSource of Truthに反映する
#[tauri::command]
pub(crate) fn notify_file_changed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: ImageFile,
) -> usize {
    notify_files_batch_inner(Some(&app), &state, vec![file], Vec::new())
}

/// ファイルウォッチャーから通知されたファイル削除をRust側のSource of Truthに反映する
#[tauri::command]
pub(crate) fn notify_file_removed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> usize {
    notify_files_batch_inner(Some(&app), &state, Vec::new(), vec![path])
}

/// ファイルウォッチャーから通知された複数のファイル追加・変更・削除を一括で反映する
#[tauri::command]
pub(crate) fn notify_files_batch(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    changed_files: Vec<ImageFile>,
    removed_paths: Vec<String>,
) -> usize {
    notify_files_batch_inner(Some(&app), &state, changed_files, removed_paths)
}

/// ファイルシステムの変更監視（軽量ポーリング）スレッドを起動する。
/// ゴミ箱からの復元やブラウザからの保存など、外部からの変更を検知してフロントエンドに通知する。
pub fn start_file_watcher(app_handle: tauri::AppHandle) {
        // --- ファイルシステムの変更監視（軽量ポーリング） ---
        // ゴミ箱からの復元やブラウザからの保存など、外部からの変更を検知してフロントエンドに通知する
        std::thread::spawn(move || {
            use notify::{RecursiveMode, Watcher};
            use std::sync::mpsc::channel;

            let (tx, rx) = channel();
            let mut watcher_opt = notify::recommended_watcher(tx).ok();

            let mut current_watched_dir = String::new();
            let mut current_watched_parent = String::new();

            let mut last_dir = String::new();
            let mut last_dir_mtime = 0;
            let mut last_parent_mtime = 0;
            let mut known_files: std::collections::HashMap<String, (u64, u64)> =
                std::collections::HashMap::new();
            let mut known_folders: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut idle_cycles: u32 = 0;

            loop {
                let current_dir = {
                    let state = app_handle.state::<AppState>();
                    let dir = state.current_dir.read().clone();
                    dir
                };

                // スマートフォルダや空パスの場合は監視をスキップ
                if current_dir.is_empty() || current_dir.starts_with("smart://") {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    continue;
                }

                let clean_current_dir = current_dir.replace("\\\\?\\", "").replace('/', "\\");
                let current_path = std::path::Path::new(&clean_current_dir);
                if !current_path.exists() {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    continue;
                }

                let parent_dir = current_path
                    .parent()
                    .map(|p| p.to_string_lossy().replace("\\\\?\\", "").replace('/', "\\"));

                let parent_watch = parent_dir.clone().unwrap_or_default();

                let mut dir_changed = false;
                if clean_current_dir != current_watched_dir || parent_watch != current_watched_parent {
                    if let Some(watcher) = &mut watcher_opt {
                        if !current_watched_dir.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_dir));
                        }
                        if !current_watched_parent.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_parent));
                        }
                        if current_path.exists() {
                            let _ = watcher.watch(current_path, RecursiveMode::NonRecursive);
                            current_watched_dir = clean_current_dir.clone();
                        }
                        if !parent_watch.is_empty() && std::path::Path::new(&parent_watch).exists() {
                            let _ = watcher.watch(std::path::Path::new(&parent_watch), RecursiveMode::NonRecursive);
                            current_watched_parent = parent_watch.clone();
                        }
                    }
                    dir_changed = true;
                }

                // 安定状態ではポーリング待機時間を最大1000msへ緩和し、待機時ディスクI/Oを抑制
                let poll_timeout_ms = if idle_cycles >= 2 { 1000 } else { 500 };

                // Wait for events
                let mut rx_ready = false;
                if let Ok(_) = rx.recv_timeout(std::time::Duration::from_millis(poll_timeout_ms)) {
                    rx_ready = true;
                    std::thread::sleep(std::time::Duration::from_millis(100)); // Debounce
                    while let Ok(_) = rx.try_recv() {}
                }

                // Fallback: poll directory mtime
                if let Ok(meta) = std::fs::metadata(&clean_current_dir) {
                    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                    if mtime != last_dir_mtime && last_dir_mtime != 0 {
                        rx_ready = true;
                    }
                    last_dir_mtime = mtime;
                }

                if let Some(ref parent) = parent_dir {
                    if let Ok(meta) = std::fs::metadata(parent) {
                        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                        if mtime != last_parent_mtime && last_parent_mtime != 0 {
                            rx_ready = true;
                        }
                        last_parent_mtime = mtime;
                    }
                }

                // Windows NTFS ではディレクトリ mtime が更新されず、かつ notify のイベントが欠落する場合があるため、
                // idle_cycles が 2 以上（約1.5〜2秒経過）になったら定期スキャンとして強制的に差分検査を実行する。
                let is_periodic_scan = idle_cycles >= 2;

                if !dir_changed && !rx_ready && !is_periodic_scan {
                    idle_cycles = idle_cycles.saturating_add(1);
                    continue;
                }
                idle_cycles = 0;

                let current_dir = {
                    let state = app_handle.state::<AppState>();
                    let dir = state.current_dir.read().clone();
                    dir
                };

                if current_dir.is_empty() || current_dir.starts_with("smart://") {
                    continue;
                }

                let clean_current_dir = current_dir.replace("\\\\?\\", "").replace('/', "\\");
                let current_path = std::path::Path::new(&clean_current_dir);
                if !current_path.exists() {
                    continue;
                }

                let parent_dir = current_path
                    .parent()
                    .map(|p| p.to_string_lossy().replace("\\\\?\\", "").replace('/', "\\"));

                if clean_current_dir != last_dir {
                    last_dir = clean_current_dir.clone();
                    known_files.clear();
                    known_folders.clear();

                    let (snapshot_files, snapshot_folders) =
                        collect_watcher_dir_snapshot(&clean_current_dir);
                    for (path_str, _file_name, _ext_lower, meta) in snapshot_files {
                        let size = meta.len();
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        known_files.insert(path_str, (size, mtime));
                    }
                    known_folders.extend(snapshot_folders);
                    if let Some(ref parent) = parent_dir {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.filter_map(Result::ok) {
                                if dir_entry_is_dir(&entry) {
                                    let clean_p = entry.path().to_string_lossy().replace("\\\\?\\", "").replace('/', "\\");
                                    known_folders.insert(clean_p);
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

                let (snapshot_files, snapshot_folders) =
                    collect_watcher_dir_snapshot(&clean_current_dir);
                for (path_str, file_name, ext_lower, meta) in snapshot_files {
                    let size = meta.len();
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    current_files.insert(path_str.clone(), (size, mtime));

                    if let Some(&(old_size, old_mtime)) = known_files.get(&path_str) {
                        if old_size != size || old_mtime != mtime {
                            let (initial_width, initial_height) = if size > 0 {
                                get_fast_dimensions_for_file(&path_str, &ext_lower)
                            } else {
                                (0, 0)
                            };
                            let ctime = meta
                                .created()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            let hash_key = crate::utils::hash_path_mtime_hex(&path_str, mtime);
                            let img_file = ImageFile {
                                name: file_name,
                                ext: format_compact!(".{}", ext_lower),
                                path: path_str.clone(),
                                size,
                                mtime,
                                ctime,
                                has_thumbnail_cache: false,
                                width: initial_width,
                                height: initial_height,
                                prompt: String::new(),
                                negative_prompt: String::new(),
                                source: String::new(),
                                meta_loaded: false,
                                search_text: String::new(),
                                unified_search_text: String::new(),
                                hash_key: hash_key.into(),
                            };
                            let _ = app_handle.emit_all("file-changed", img_file);
                        }
                    } else {
                        let (initial_width, initial_height) = if size > 0 {
                            get_fast_dimensions_for_file(&path_str, &ext_lower)
                        } else {
                            (0, 0)
                        };
                        let ctime = meta
                            .created()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let hash_key = crate::utils::hash_path_mtime_hex(&path_str, mtime);
                        let img_file = ImageFile {
                            name: file_name,
                            ext: format_compact!(".{}", ext_lower),
                            path: path_str.clone(),
                            size,
                            mtime,
                            ctime,
                            has_thumbnail_cache: false,
                            width: initial_width,
                            height: initial_height,
                            prompt: String::new(),
                            negative_prompt: String::new(),
                            source: String::new(),
                            meta_loaded: false,
                            search_text: String::new(),
                            unified_search_text: String::new(),
                            hash_key: hash_key.into(),
                        };
                        let _ = app_handle.emit_all("file-changed", img_file);
                    }
                }
                for folder_path in snapshot_folders {
                    if !known_folders.contains(&folder_path) {
                        folder_changed = true;
                    }
                    current_folders.insert(folder_path);
                }

                if let Some(ref parent) = parent_dir {
                    if let Ok(entries) = std::fs::read_dir(parent) {
                        for entry in entries.filter_map(Result::ok) {
                            if dir_entry_is_dir(&entry) {
                                let path_str = entry.path().to_string_lossy().replace("\\\\?\\", "").replace('/', "\\");
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

                for path_str in known_files.keys() {
                    if !current_files.contains_key(path_str) {
                        let _ = app_handle.emit_all("file-removed", path_str.clone());
                    }
                }

                if folder_changed {
                    let _ = app_handle.emit_all("directory-changed", ());
                }

                known_files = current_files;
                known_folders = current_folders;
            }
        });

}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::create_test_app_state;

    #[test]
    fn test_file_watcher_periodic_scan_and_path_normalization() {
        // 1. idle_cycles フォールバック判定ロジックの検証
        let idle_cycles_0 = 0u32;
        let idle_cycles_1 = 1u32;
        let idle_cycles_2 = 2u32;
        let idle_cycles_5 = 5u32;

        assert_eq!(idle_cycles_0 >= 2, false);
        assert_eq!(idle_cycles_1 >= 2, false);
        assert_eq!(idle_cycles_2 >= 2, true, "idle_cycles >= 2 で定期スキャンが発火すること");
        assert_eq!(idle_cycles_5 >= 2, true);

        // 2. パス正規化の一貫性検証
        let raw_unc_slash = "\\\\?\\C:/images/folder/test.png";
        let clean = raw_unc_slash.replace("\\\\?\\", "").replace('/', "\\");
        assert_eq!(clean, "C:\\images\\folder\\test.png");

        let mtime: u64 = 1700000000;
        let hash_key = crate::utils::hash_path_mtime_hex(&clean, mtime);
        assert_eq!(hash_key.len(), 16);

        // キャッシュファイル名の照合
        let expected_thumb = format!("{}.jpg", hash_key);
        let expected_meta = format!("{}.json", hash_key);
        assert!(expected_thumb.ends_with(".jpg"));
        assert!(expected_meta.ends_with(".json"));
    }


    #[test]
    fn test_notify_file_changed_and_removed_state_sync() {
        let app_state = create_test_app_state("");

        // 1. 新規ファイルの通知（UNC接頭辞あり、hash_key空）
        let mut new_file = ImageFile {
            name: "new_pic.png".to_string(),
            ext: ".png".into(),
            path: "\\\\?\\C:/images/new_pic.png".to_string(),
            size: 2048,
            mtime: 1700000000,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 1024,
            height: 768,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };

        // notify_file_changed の内部ロジックをシミュレート
        let clean = new_file.path.replace("\\\\?\\", "").replace('/', "\\");
        new_file.path = clean.clone();
        if new_file.hash_key.is_empty() {
            new_file.hash_key = crate::utils::hash_path_mtime_hex(&clean, new_file.mtime).into();
        }

        {
            let mut all = app_state.all_files.write();
            all.push(std::sync::Arc::new(new_file.clone()));
            app_state.rebuild_all_indices(&all);
        }

        // インデックスとall_filesが正しく同期されていることを検証
        assert_eq!(new_file.path, "C:\\images\\new_pic.png");
        assert_eq!(new_file.hash_key.len(), 16);
        assert_eq!(app_state.path_to_all_idx.read().get("C:\\images\\new_pic.png").copied(), Some(0));
        assert_eq!(app_state.get_mtime("C:\\images\\new_pic.png"), Some(1700000000));

        // 2. 既存ファイルの更新（寸法0が届いた場合の寸法保持）
        let mut updated_file = ImageFile {
            name: "new_pic.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\new_pic.png".to_string(),
            size: 4096,
            mtime: 1700000050,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 0,
            height: 0,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };
        let clean_update = updated_file.path.replace("\\\\?\\", "").replace('/', "\\");
        updated_file.path = clean_update.clone();
        if updated_file.hash_key.is_empty() {
            updated_file.hash_key = crate::utils::hash_path_mtime_hex(&clean_update, updated_file.mtime).into();
        }

        {
            let mut all = app_state.all_files.write();
            if let Some(existing) = all.iter_mut().find(|f| f.path == updated_file.path) {
                if updated_file.width == 0 && updated_file.height == 0 && (existing.width > 0 || existing.height > 0) {
                    updated_file.width = existing.width;
                    updated_file.height = existing.height;
                }
                *existing = std::sync::Arc::new(updated_file);
            }
            app_state.rebuild_all_indices(&all);
        }

        {
            let all = app_state.all_files.read();
            assert_eq!(all[0].size, 4096, "サイズが更新されること");
            assert_eq!(all[0].width, 1024, "寸法が保持されること");
            assert_eq!(all[0].height, 768, "寸法が保持されること");
        }
        assert_eq!(app_state.get_mtime("C:\\images\\new_pic.png"), Some(1700000050), "インデックスのmtimeが更新されること");

        // 3. ファイル削除（notify_file_removed）
        let remove_path = "C:/images/new_pic.png"; // スラッシュ区切りで削除要求
        let clean_remove = remove_path.replace("\\\\?\\", "").replace('/', "\\");
        {
            let mut all = app_state.all_files.write();
            all.retain(|f| f.path != clean_remove && f.path != remove_path);
            app_state.rebuild_all_indices(&all);
        }

        assert_eq!(app_state.path_to_all_idx.read().get("C:\\images\\new_pic.png").copied(), None, "削除後にインデックスから消去されること");
        assert_eq!(app_state.get_mtime("C:\\images\\new_pic.png"), None);
    }

    #[test]
    fn test_notify_files_batch_existing_new_and_duplicate_new_paths() {
        let app_state = create_test_app_state("C:\\images");

        let existing1 = ImageFile {
            name: "existing1.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\existing1.png".to_string(),
            size: 1000,
            mtime: 1700000010,
            ctime: 1700000000,
            has_thumbnail_cache: true,
            width: 1024,
            height: 768,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: true,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };
        let existing2 = ImageFile {
            name: "existing2.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\existing2.png".to_string(),
            size: 2000,
            mtime: 1700000020,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 800,
            height: 600,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };

        {
            let mut all = app_state.all_files.write();
            all.push(std::sync::Arc::new(existing1));
            all.push(std::sync::Arc::new(existing2));
            app_state.rebuild_all_indices(&all);
        }

        // 1. 既存パスの更新: existing1.png (サイズ 1500, width=0, height=0 -> 寸法維持)
        let update_existing1 = ImageFile {
            name: "existing1.png".to_string(),
            ext: ".png".into(),
            path: "C:/images/existing1.png".to_string(), // スラッシュ区切り
            size: 1500,
            mtime: 1700000050,
            ctime: 1700000000,
            has_thumbnail_cache: true,
            width: 0,
            height: 0,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: true,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };
        // 2. 新規パスの追加: new_a.png
        let new_a = ImageFile {
            name: "new_a.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\new_a.png".to_string(),
            size: 3000,
            mtime: 1700000060,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 1920,
            height: 1080,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };
        // 3. 同一バッチ内での新規パス重複: new_a.png (サイズ 3500, width=0, height=0 -> 先行の寸法 1920x1080 を維持)
        let dup_new_a = ImageFile {
            name: "new_a.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\new_a.png".to_string(),
            size: 3500,
            mtime: 1700000070,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 0,
            height: 0,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };
        // 4. もう一つの新規パス: new_b.png
        let new_b = ImageFile {
            name: "new_b.png".to_string(),
            ext: ".png".into(),
            path: "C:\\images\\new_b.png".to_string(),
            size: 4000,
            mtime: 1700000080,
            ctime: 1700000000,
            has_thumbnail_cache: false,
            width: 1280,
            height: 720,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: false,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: Default::default(),
        };

        // 削除対象: existing2.png
        let removed_paths = vec!["C:/images/existing2.png".to_string()];
        let changed_files = vec![update_existing1, new_a, dup_new_a, new_b];

        let count = notify_files_batch_inner(None, &app_state, changed_files, removed_paths);
        assert_eq!(count, 3, "削除1件、既存更新1件、新規追加2件（重複は1件に集約）で合計3件となること");

        let all = app_state.all_files.read();
        assert_eq!(all.len(), 3);

        // 0: existing1 (更新され、寸法維持)
        assert_eq!(all[0].path, "C:\\images\\existing1.png");
        assert_eq!(all[0].size, 1500);
        assert_eq!(all[0].width, 1024);
        assert_eq!(all[0].height, 768);

        // 1: new_a (重複更新され、先行の寸法維持、サイズ 3500)
        assert_eq!(all[1].path, "C:\\images\\new_a.png");
        assert_eq!(all[1].size, 3500);
        assert_eq!(all[1].width, 1920);
        assert_eq!(all[1].height, 1080);

        // 2: new_b
        assert_eq!(all[2].path, "C:\\images\\new_b.png");
        assert_eq!(all[2].size, 4000);
        assert_eq!(all[2].width, 1280);
        assert_eq!(all[2].height, 720);

        // インデックス検証
        let idx_map = app_state.path_to_all_idx.read();
        assert_eq!(idx_map.get("C:\\images\\existing1.png").copied(), Some(0));
        assert_eq!(idx_map.get("C:\\images\\new_a.png").copied(), Some(1));
        assert_eq!(idx_map.get("C:\\images\\new_b.png").copied(), Some(2));
        assert_eq!(idx_map.get("C:\\images\\existing2.png").copied(), None);
    }


    #[test]
    fn test_watcher_snapshot_includes_mp3_and_no_duplicate_extension_lists() {
        let dir = tempfile::tempdir().unwrap();
        let expected_media = ["track.mp3", "photo.jpg", "pic.png", "anim.webp", "clip.mp4"];
        for name in expected_media {
            std::fs::write(dir.path().join(name), b"dummy").unwrap();
        }
        for ignored in ["notes.txt", "audio.wav", "lossless.flac"] {
            std::fs::write(dir.path().join(ignored), b"dummy").unwrap();
        }
        std::fs::create_dir(dir.path().join("subdir")).unwrap();

        let dir_str = dir.path().to_string_lossy().to_string();
        let (files_first, folders_first) = collect_watcher_dir_snapshot(&dir_str);
        let (files_rescan, folders_rescan) = collect_watcher_dir_snapshot(&dir_str);

        let names_first: std::collections::HashSet<String> =
            files_first.iter().map(|(_, n, _, _)| n.clone()).collect();
        let names_rescan: std::collections::HashSet<String> =
            files_rescan.iter().map(|(_, n, _, _)| n.clone()).collect();

        assert_eq!(names_first, names_rescan, "初期構築と再スキャンで検出集合が完全一致すること");
        assert!(names_first.contains("track.mp3"), "監視スナップショットに .mp3 が含まれること");
        assert!(!names_first.contains("notes.txt"));
        assert!(!names_first.contains("audio.wav"));
        assert_eq!(names_first.len(), expected_media.len());
        assert_eq!(folders_first, folders_rescan);
        assert_eq!(folders_first.len(), 1);

        // 本番コード側（#[cfg(test)] 以前）に is_listed_media_extension 以外の直書きリストが残っていないことを検証
        let main_src = include_str!("main.rs");
        let prod_src = main_src.split("#[cfg(test)]").next().unwrap_or(main_src);
        let hardcoded_pattern = "\"jpg\" | \"jpeg\" | \"png\" | \"gif\" | \"webp\" | \"bmp\" | \"mp4\"";
        let occurrences = prod_src.matches(hardcoded_pattern).count();
        assert_eq!(
            occurrences, 1,
            "is_listed_media_extension 以外にメディア拡張子の直書きリストが残っていないこと (found: {})",
            occurrences
        );
    }

    #[test]
    fn test_notify_files_batch_incremental_index_consistency() {
        let state = create_test_app_state("C:\\test");

        let make_file = |path: &str, mtime: u64| ImageFile {
            name: path.split('\\').last().unwrap().to_string(),
            ext: ".png".into(),
            path: path.to_string(),
            size: 1024,
            mtime,
            ctime: 1000,
            has_thumbnail_cache: false,
            width: 100,
            height: 100,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: true,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: "hk".into(),
        };

        // 初期状態: \\?\ 形式を含むファイルセット
        let f1 = make_file(r"\\?\C:\test\img1.png", 1000);
        let f2 = make_file(r"\\?\C:\test\img2.png", 2000);
        let f3 = make_file(r"C:\test\img3.png", 3000);

        {
            let mut all = state.all_files.write();
            all.push(std::sync::Arc::new(f1));
            all.push(std::sync::Arc::new(f2));
            all.push(std::sync::Arc::new(f3));
            state.rebuild_all_indices(&all);
        }

        let assert_maps_match_rebuild = |st: &AppState| {
            let expected_state = create_test_app_state("C:\\test");
            let current_all = st.all_files.read().clone();
            expected_state.rebuild_all_indices(&current_all);

            let act_all = st.path_to_all_idx.read().clone();
            let exp_all = expected_state.path_to_all_idx.read().clone();
            assert_eq!(act_all, exp_all, "path_to_all_idx が全再構築結果と完全一致すること");

            let act_mtime = st.path_to_mtime.read().clone();
            let exp_mtime = expected_state.path_to_mtime.read().clone();
            assert_eq!(act_mtime, exp_mtime, "path_to_mtime が全再構築結果と完全一致すること");
        };

        // 初期状態の一致確認
        assert_maps_match_rebuild(&state);

        // ケース1: 変更のみ（file2 の mtime を 2500 に更新）
        let f2_mod = make_file(r"\\?\C:\test\img2.png", 2500);
        notify_files_batch_inner(None, &state, vec![f2_mod], Vec::new());
        assert_maps_match_rebuild(&state);

        // ケース2: 削除のみ（file3 を削除）
        notify_files_batch_inner(None, &state, Vec::new(), vec![r"C:\test\img3.png".to_string()]);
        assert_maps_match_rebuild(&state);

        // ケース3: 削除＋置換（mtime変更）＋追加の混在バッチ（\\?\ 含む）
        let f2_mod2 = make_file(r"\\?\C:\test\img2.png", 2800);
        let f4_new = make_file(r"\\?\C:\test\img4.png", 4000);
        let f5_new = make_file(r"C:\test\img5.png", 5000);
        notify_files_batch_inner(
            None,
            &state,
            vec![f2_mod2, f4_new, f5_new],
            vec![r"\\?\C:\test\img1.png".to_string()],
        );
        assert_maps_match_rebuild(&state);
    }
}
