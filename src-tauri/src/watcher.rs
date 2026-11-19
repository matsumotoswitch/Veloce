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

    let mut unparsed_paths = Vec::new();
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

            // 外部削除されたパスの ratings を state.ratings から除去
            {
                let mut ratings_map = state.ratings.write();
                for p in &remove_set {
                    ratings_map.remove(p);
                }
            }

            // path_to_mtime からも削除
            {
                let mut mtime_map = state.path_to_mtime.write();
                for p in &remove_set {
                    mtime_map.remove(p);
                }
            }
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
                    let expected_hash = crate::utils::hash_path_mtime_hex(&clean, file.mtime);
                    if file.hash_key.as_str() != expected_hash {
                        file.hash_key = expected_hash.into();
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
                            if !arc_f.meta_loaded {
                                unparsed_paths.push(arc_f.path.clone());
                            }
                            *existing = std::sync::Arc::clone(&arc_f);
                            updated_items.push((old_path, arc_f, idx));
                            continue;
                        }
                    }

                    let new_idx = all_files.len();
                    let arc_f = std::sync::Arc::new(file);
                    if !arc_f.meta_loaded {
                        unparsed_paths.push(arc_f.path.clone());
                    }
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

    if !unparsed_paths.is_empty() {
        if let Some(app_handle) = app {
            let app_clone = app_handle.clone();
            let current_epoch = crate::current_metadata_bg_epoch();
            let target_dir = state.current_dir.read().clone();
            tauri::async_runtime::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    if let Some(state) = app_clone.try_state::<AppState>() {
                        process_unloaded_metadata_batch(&state, unparsed_paths, current_epoch, &target_dir);
                    }
                })
                .await
                .ok();
            });
        }
    }

    apply_filters_and_sort(app, state)
}

/// notify_files_batch で追加・変更された未解析のファイルについて、
/// 世代管理とカレントディレクトリの検証を維持しつつバックグラウンドでメタデータを解析し、
/// SQLite キャッシュ DB とインメモリ state（all_files / filtered_files）を更新する。
pub(crate) fn process_unloaded_metadata_batch(
    state: &AppState,
    paths: Vec<String>,
    task_epoch: u64,
    target_dir: &str,
) -> usize {
    if paths.is_empty() {
        return 0;
    }
    {
        let cur_dir = state.current_dir.read();
        if !crate::should_continue_metadata_bg_task(
            task_epoch,
            crate::current_metadata_bg_epoch(),
            &cur_dir,
            target_dir,
        ) {
            return 0;
        }
    }

    let paths_to_process: Vec<(usize, String, u64, u64, u64)> = {
        let all_map = state.path_to_all_idx.read();
        let all_files = state.all_files.read();
        paths
            .into_iter()
            .filter_map(|p| {
                let clean = crate::utils::normalize_unc_path(&p);
                let idx_opt = all_map.get(&p).or_else(|| all_map.get(clean.as_ref())).copied();
                if let Some(idx) = idx_opt {
                    if let Some(f) = all_files.get(idx) {
                        if !f.meta_loaded {
                            return Some((idx, f.path.clone(), f.mtime, f.ctime, f.size));
                        }
                    }
                }
                None
            })
            .collect()
    };

    if paths_to_process.is_empty() {
        return 0;
    }

    let mut processed_count = 0;
    const METADATA_CHUNK_SIZE: usize = 200;

    for chunk in paths_to_process.chunks(METADATA_CHUNK_SIZE) {
        {
            let cur_dir = state.current_dir.read();
            if !crate::should_continue_metadata_bg_task(
                task_epoch,
                crate::current_metadata_bg_epoch(),
                &cur_dir,
                target_dir,
            ) {
                break;
            }
        }

        let mut pending_rows = Vec::new();
        let mut results = Vec::with_capacity(chunk.len());

        for &(idx, ref p, mtime, ctime, size) in chunk {
            let (meta, fetched_mtime, fetched_size, row) =
                crate::metadata::get_full_metadata_for_path_with_stat_inner(
                    p,
                    mtime,
                    ctime,
                    size,
                    &state.db_conn,
                    false,
                );
            if let Some(r) = row {
                pending_rows.push(r);
            }
            results.push((idx, p.clone(), meta, fetched_mtime, fetched_size));
        }

        if crate::current_metadata_bg_epoch() != task_epoch {
            break;
        }

        let _ = crate::metadata::commit_pending_metadata_batch(&state.db_conn, &pending_rows);

        {
            let mut all_files_lock = state.all_files.write();
            let mut filtered_updates = Vec::with_capacity(results.len());

            for (idx, path, full_meta, meta_mtime, meta_size) in results {
                if let Some(f_arc) = all_files_lock.get_mut(idx) {
                    if f_arc.path == path {
                        let f = std::sync::Arc::make_mut(f_arc);
                        f.width = full_meta.width;
                        f.height = full_meta.height;
                        f.prompt = full_meta.prompt.clone();
                        f.negative_prompt = full_meta.negative_prompt.clone();
                        f.source = full_meta.source.clone();
                        f.search_text = crate::utils::extract_searchable_text(&full_meta.params);
                        f.unified_search_text = format!(
                            "{} {} {} {} {}",
                            f.name, f.prompt, f.negative_prompt, f.source, f.search_text
                        )
                        .to_lowercase();
                        if f.size == 0 {
                            f.size = meta_size;
                        }
                        if f.mtime == 0 {
                            f.mtime = meta_mtime / 1000;
                        }
                        f.meta_loaded = true;
                        filtered_updates.push((path, f_arc.clone()));
                        processed_count += 1;
                    }
                }
            }
            drop(all_files_lock);

            if !filtered_updates.is_empty() {
                let filt_idx_lock = state.path_to_filtered_idx.read();
                let mut filtered_files_lock = state.filtered_files.write();
                for (path, arc) in filtered_updates {
                    let clean = path.replace("\\\\?\\", "");
                    if let Some(&filt_idx) = filt_idx_lock.get(&path).or_else(|| filt_idx_lock.get(&clean)) {
                        if let Some(f_arc) = filtered_files_lock.get_mut(filt_idx) {
                            *f_arc = arc;
                        }
                    }
                }
            }
        }
    }

    processed_count
}

/// ファイルウォッチャーから通知されたファイル変更をRust側のSource of Truthに反映する
#[tauri::command]
pub(crate) async fn notify_file_changed(
    app: tauri::AppHandle,
    file: ImageFile,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        notify_files_batch_inner(Some(&app), &state, vec![file], Vec::new())
    })
    .await
    .map_err(|e| e.to_string())
}

/// ファイルウォッチャーから通知されたファイル削除をRust側のSource of Truthに反映する
#[tauri::command]
pub(crate) async fn notify_file_removed(
    app: tauri::AppHandle,
    path: String,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        notify_files_batch_inner(Some(&app), &state, Vec::new(), vec![path])
    })
    .await
    .map_err(|e| e.to_string())
}

/// ファイルウォッチャーから通知された複数のファイル追加・変更・削除を一括で反映する
#[tauri::command]
pub(crate) async fn notify_files_batch(
    app: tauri::AppHandle,
    changed_files: Vec<ImageFile>,
    removed_paths: Vec<String>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        notify_files_batch_inner(Some(&app), &state, changed_files, removed_paths)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 既知のフォルダ集合（`known_folders`）と、新たにスキャンされたフォルダ集合（`current_folders`）を比較し、
/// フォルダの追加・削除・名前変更等の変化が存在するかを判定する純粋関数。
pub(crate) fn detect_folder_changes(
    known_folders: &std::collections::HashSet<String>,
    current_folders: &std::collections::HashSet<String>,
) -> bool {
    if known_folders.len() != current_folders.len() {
        return true;
    }
    known_folders.iter().any(|f| !current_folders.contains(f))
}

/// 親ディレクトリ配下のサブフォルダ一覧を走査・収集する純粋関数
pub(crate) fn collect_parent_subfolders(parent_dir: &str) -> std::collections::HashSet<String> {
    let mut folders = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(parent_dir) {
        for entry in entries.filter_map(Result::ok) {
            if dir_entry_is_dir(&entry) {
                let clean_p = entry.path().to_string_lossy().replace("\\\\?\\", "").replace('/', "\\");
                folders.insert(clean_p);
            }
        }
    }
    folders
}

/// カレントディレクトリの存在状態にかかわらず、親ディレクトリのサブフォルダおよびカレント配下フォルダの
/// 変更を検知する。カレントディレクトリが存在しない場合でも、親フォルダが健在であればサブフォルダの増減・
/// リネームを確実に検出し `folder_changed = true` を返す。
pub(crate) fn check_folder_changes_with_optional_current(
    current_exists: bool,
    snapshot_folders: std::collections::HashSet<String>,
    parent_folders: std::collections::HashSet<String>,
    known_folders: &std::collections::HashSet<String>,
) -> (bool, std::collections::HashSet<String>) {
    let mut current_folders = std::collections::HashSet::with_capacity(
        snapshot_folders.len() + parent_folders.len()
    );
    if current_exists {
        current_folders.extend(snapshot_folders);
    }
    current_folders.extend(parent_folders);

    let changed = detect_folder_changes(known_folders, &current_folders);
    (changed, current_folders)
}

/// アイドル時の安全網となる定期差分スキャンを発火させる `idle_cycles` 閾値。
/// `poll_timeout_ms` は先頭2サイクルが 500ms、以降が 1000ms のため、15 で約 15 秒間隔となる。
pub(crate) const WATCHER_PERIODIC_SCAN_IDLE_CYCLES: u32 = 15;

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
                let current_exists = current_path.exists();

                let parent_dir = current_path
                    .parent()
                    .map(|p| p.to_string_lossy().replace("\\\\?\\", "").replace('/', "\\"));

                let parent_watch = parent_dir.clone().unwrap_or_default();
                let parent_exists = !parent_watch.is_empty() && std::path::Path::new(&parent_watch).exists();

                // カレントフォルダも親フォルダも存在しない場合は監視スキップ
                if !current_exists && !parent_exists {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    continue;
                }

                let mut dir_changed = false;
                if clean_current_dir != current_watched_dir || parent_watch != current_watched_parent {
                    if let Some(watcher) = &mut watcher_opt {
                        if !current_watched_dir.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_dir));
                            current_watched_dir.clear();
                        }
                        if !current_watched_parent.is_empty() {
                            let _ = watcher.unwatch(std::path::Path::new(&current_watched_parent));
                            current_watched_parent.clear();
                        }
                        if current_exists {
                            let _ = watcher.watch(current_path, RecursiveMode::NonRecursive);
                            current_watched_dir = clean_current_dir.clone();
                        }
                        if parent_exists {
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
                if current_exists {
                    if let Ok(meta) = std::fs::metadata(&clean_current_dir) {
                        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                        if mtime != last_dir_mtime && last_dir_mtime != 0 {
                            rx_ready = true;
                        }
                        last_dir_mtime = mtime;
                    }
                }

                if parent_exists {
                    if let Some(ref parent) = parent_dir {
                        if let Ok(meta) = std::fs::metadata(parent) {
                            let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                            if mtime != last_parent_mtime && last_parent_mtime != 0 {
                                rx_ready = true;
                            }
                            last_parent_mtime = mtime;
                        }
                    }
                }

                // Windows NTFS ではディレクトリ mtime が更新されず、かつ notify のイベントが欠落する場合があるため、
                // リアルタイムイベント・mtime 変化がない状態が続いた場合の安全網として約15秒ごとに定期差分検査を実行する。
                let is_periodic_scan = idle_cycles >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES;

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
                let current_exists = current_path.exists();

                let parent_dir = current_path
                    .parent()
                    .map(|p| p.to_string_lossy().replace("\\\\?\\", "").replace('/', "\\"));
                let parent_exists = parent_dir.as_ref().map(|p| std::path::Path::new(p).exists()).unwrap_or(false);

                if !current_exists && !parent_exists {
                    continue;
                }

                if clean_current_dir != last_dir {
                    last_dir = clean_current_dir.clone();
                    known_files.clear();
                    known_folders.clear();

                    if current_exists {
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
                    }
                    if parent_exists {
                        if let Some(ref parent) = parent_dir {
                            known_folders.extend(collect_parent_subfolders(parent));
                        }
                    }
                    continue;
                }

                let mut current_files: std::collections::HashMap<String, (u64, u64)> =
                    std::collections::HashMap::new();

                let snapshot_folders = if current_exists {
                    let (snapshot_files, snap_folders) =
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

                    for path_str in known_files.keys() {
                        if !current_files.contains_key(path_str) {
                            let _ = app_handle.emit_all("file-removed", path_str.clone());
                        }
                    }
                    known_files = current_files;

                    snap_folders
                } else {
                    // 現在のフォルダが存在しない場合: ファイル単位スナップショット走査と file-removed emit はスキップする
                    std::collections::HashSet::new()
                };

                let parent_subfolders = if parent_exists {
                    if let Some(ref parent) = parent_dir {
                        collect_parent_subfolders(parent)
                    } else {
                        std::collections::HashSet::new()
                    }
                } else {
                    std::collections::HashSet::new()
                };

                let (folder_changed, new_known_folders) = check_folder_changes_with_optional_current(
                    current_exists,
                    snapshot_folders,
                    parent_subfolders,
                    &known_folders,
                );

                if folder_changed {
                    let _ = app_handle.emit_all("directory-changed", ());
                }

                known_folders = new_known_folders;
            }
        });

}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::create_test_app_state;

    #[test]
    fn test_file_watcher_periodic_scan_and_path_normalization() {
        // 1. idle_cycles フォールバック判定ロジックの検証（約15秒間隔）
        assert_eq!(WATCHER_PERIODIC_SCAN_IDLE_CYCLES, 15);
        assert_eq!(0u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES, false);
        assert_eq!(1u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES, false);
        assert_eq!(2u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES, false);
        assert_eq!(14u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES, false);
        assert_eq!(
            15u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES,
            true,
            "idle_cycles が閾値（約15秒相当）に達した時点で定期スキャンが発火すること"
        );
        assert_eq!(20u32 >= WATCHER_PERIODIC_SCAN_IDLE_CYCLES, true);

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

    #[test]
    fn test_notify_files_process_unloaded_metadata_batch_updates_db_and_state() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_dir_str = temp_dir.path().to_str().unwrap();
        let test_png = temp_dir.path().join("watcher_unloaded.png");

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
        text_data.extend_from_slice(b"Description\0starry sky, deep blue");
        png_bytes.extend_from_slice(&(text_data.len() as u32).to_be_bytes());
        png_bytes.extend_from_slice(b"tEXt");
        png_bytes.extend_from_slice(&text_data);
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        png_bytes.extend_from_slice(&0u32.to_be_bytes());
        png_bytes.extend_from_slice(b"IEND");
        png_bytes.extend_from_slice(&[0, 0, 0, 0]);

        std::fs::write(&test_png, &png_bytes).unwrap();
        let png_path = test_png.to_str().unwrap().to_string();

        let state = crate::create_test_app_state(temp_dir_str);
        let unparsed_file = ImageFile {
            name: "watcher_unloaded.png".to_string(),
            ext: ".png".into(),
            path: png_path.clone(),
            size: png_bytes.len() as u64,
            mtime: 1700000000,
            ctime: 1700000000,
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

        // notify 経由で未解析ファイルを追加
        notify_files_batch_inner(None, &state, vec![unparsed_file], Vec::new());

        // 追加直後は meta_loaded: false
        {
            let all_files = state.all_files.read();
            assert_eq!(all_files.len(), 1);
            assert!(!all_files[0].meta_loaded);
            assert_eq!(all_files[0].width, 0);
            assert_eq!(all_files[0].height, 0);
        }

        // 切り出された同期実行処理を呼び出す
        let current_epoch = crate::current_metadata_bg_epoch();
        let processed = process_unloaded_metadata_batch(&state, vec![png_path.clone()], current_epoch, temp_dir_str);
        assert_eq!(processed, 1, "未解析ファイルが1件処理されること");

        // 1. state の更新検証: meta_loaded, width, height, unified_search_text が反映されていること
        {
            let all_files = state.all_files.read();
            assert!(all_files[0].meta_loaded, "state の meta_loaded が true に更新されること");
            assert_eq!(all_files[0].width, 64);
            assert_eq!(all_files[0].height, 128);
            assert_eq!(all_files[0].prompt, "starry sky, deep blue");
            assert!(
                all_files[0].unified_search_text.contains("starry sky"),
                "unified_search_text にメタデータのプロンプトが格納されること"
            );
        }

        // 2. DB の更新検証: cache テーブルに該当ファイルのメタデータ行が保存されていること
        {
            let conn = state.db_conn.get().unwrap();
            let clean = crate::utils::normalize_unc_path(&png_path);
            let (db_w, db_h): (u32, u32) = conn
                .query_row(
                    "SELECT width, height FROM cache WHERE path = ?1 COLLATE NOCASE OR path = ?2 COLLATE NOCASE",
                    rusqlite::params![&png_path, clean.as_ref()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("cache テーブルに行が存在すること");
            assert_eq!(db_w, 64, "DB の width が更新されていること");
            assert_eq!(db_h, 128, "DB の height が更新されていること");
        }
    }

    #[test]
    fn test_parent_folder_diff_detection_when_current_missing() {
        use std::collections::HashSet;

        // 1. 直前の既知フォルダ一覧（カレントフォルダ C:\photos\album と兄弟フォルダ C:\photos\other）
        let mut known = HashSet::new();
        known.insert("C:\\photos\\album".to_string());
        known.insert("C:\\photos\\other".to_string());

        // 2. 外部で C:\photos\album が C:\photos\album_renamed に変更され、
        // カレントディレクトリが存在しなくなった（current_exists = false）状況を模擬
        let mut parent_folders = HashSet::new();
        parent_folders.insert("C:\\photos\\album_renamed".to_string());
        parent_folders.insert("C:\\photos\\other".to_string());

        let (changed, new_known) = check_folder_changes_with_optional_current(
            false,
            HashSet::new(),
            parent_folders,
            &known,
        );

        // カレントフォルダが存在しなくても親フォルダの差分から変化が検知されること
        assert!(changed, "カレントフォルダ非存在時でも親フォルダ差分からフォルダ変化が検知されること");
        assert!(new_known.contains("C:\\photos\\album_renamed"));
        assert!(!new_known.contains("C:\\photos\\album"));
        assert!(new_known.contains("C:\\photos\\other"));

        // 3. 変化がない場合は changed = false となること
        let (unchanged, _) = check_folder_changes_with_optional_current(
            false,
            HashSet::new(),
            new_known.clone(),
            &new_known,
        );
        assert!(!unchanged, "同一フォルダ構成であれば変化なしと判定されること");
    }

    #[test]
    fn test_notify_files_batch_removes_from_ratings() {
        use std::sync::Arc;
        let state = create_test_app_state("C:\\test");

        let p1 = "C:\\test\\file1.png".to_string();
        let p2 = "C:\\test\\file2.png".to_string();

        let f1 = Arc::new(ImageFile {
            name: "file1.png".to_string(),
            ext: ".png".into(),
            path: p1.clone(),
            size: 100,
            mtime: 1234,
            ctime: 1234,
            has_thumbnail_cache: false,
            width: 100,
            height: 100,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: true,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: "h1".into(),
        });

        let f2 = Arc::new(ImageFile {
            name: "file2.png".to_string(),
            ext: ".png".into(),
            path: p2.clone(),
            size: 200,
            mtime: 5678,
            ctime: 5678,
            has_thumbnail_cache: false,
            width: 100,
            height: 100,
            prompt: "".to_string(),
            negative_prompt: "".to_string(),
            source: "".to_string(),
            meta_loaded: true,
            search_text: "".to_string(),
            unified_search_text: "".to_string(),
            hash_key: "h2".into(),
        });

        {
            let mut all_files = state.all_files.write();
            all_files.push(f1);
            all_files.push(f2);
        }
        state.rebuild_all_indices(&state.all_files.read());

        {
            let mut ratings = state.ratings.write();
            ratings.insert(p1.clone(), 5);
            ratings.insert(p2.clone(), 3);
        }

        // ウォッチャー経由で p1 の外部削除を通知
        notify_files_batch_inner(None, &state, Vec::new(), vec![p1.clone()]);

        // state.ratings から p1 が削除され、p2 は維持されていること
        {
            let ratings = state.ratings.read();
            assert_eq!(ratings.get(&p1), None, "削除されたファイルのレーティングが除去されていること");
            assert_eq!(ratings.get(&p2), Some(&3), "他のファイルのレーティングが維持されていること");
        }

        // path_to_mtime からも p1 が削除され、p2 は維持されていること
        {
            let mtimes = state.path_to_mtime.read();
            assert_eq!(mtimes.get(&p1), None, "削除されたファイルの mtime が除去されていること");
            assert_eq!(mtimes.get(&p2), Some(&5678), "他のファイルの mtime が維持されていること");
        }
    }
}
