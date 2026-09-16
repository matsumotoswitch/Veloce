//! # Veloce - State Management (state.rs)
//!
//! アプリケーション全体のメモリ内状態（Source of Truth）および
//! O(1) 逆引きインデックスを管理する `AppState` 構造体の定義。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::models::{DbMsg, ImageFile, SmartFolderRule, SortConfig};
use crate::utils::{normalize_unc_path, strip_unc_prefix};

pub struct AppState {
    pub image_paths: Mutex<Arc<Vec<String>>>,
    pub current_dir: Mutex<String>,
    pub viewer_paths: Mutex<HashMap<String, Arc<Vec<String>>>>,
    pub viewer_hashes: Mutex<HashMap<String, String>>,
    // Source of Truth: 全ファイルとフィルタリング済みファイルをRust側で保持
    pub all_files: Mutex<Vec<Arc<ImageFile>>>,
    pub filtered_files: Mutex<Vec<Arc<ImageFile>>>,
    // O(1) 高速逆引きインデックス
    pub path_to_all_idx: Mutex<HashMap<String, usize>>,
    pub path_to_filtered_idx: Mutex<HashMap<String, usize>>,
    pub path_to_mtime: Mutex<HashMap<String, u64>>,
    pub sort_config: Mutex<SortConfig>,
    pub search_query: Mutex<String>,
    pub ratings: Mutex<HashMap<String, u8>>,
    pub rating_filter_val: Mutex<u8>,
    pub rating_filter_op: Mutex<String>,
    pub db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub smart_folders: Mutex<Vec<SmartFolderRule>>,
    pub db_tx: tokio::sync::mpsc::Sender<DbMsg>,
    pub video_server_port: u16,
}

impl AppState {
    pub fn new(
        db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
        db_tx: tokio::sync::mpsc::Sender<DbMsg>,
        video_server_port: u16,
    ) -> Self {
        Self {
            image_paths: Mutex::new(Arc::new(Vec::new())),
            current_dir: Mutex::new(String::new()),
            viewer_paths: Mutex::new(HashMap::new()),
            viewer_hashes: Mutex::new(HashMap::new()),
            all_files: Mutex::new(Vec::new()),
            filtered_files: Mutex::new(Vec::new()),
            path_to_all_idx: Mutex::new(HashMap::new()),
            path_to_filtered_idx: Mutex::new(HashMap::new()),
            path_to_mtime: Mutex::new(HashMap::new()),
            sort_config: Mutex::new(SortConfig {
                key: "name".to_string(),
                asc: true,
            }),
            search_query: Mutex::new(String::new()),
            ratings: Mutex::new(HashMap::new()),
            rating_filter_val: Mutex::new(0),
            rating_filter_op: Mutex::new("gte".to_string()),
            db_conn,
            smart_folders: Mutex::new(Vec::new()),
            db_tx,
            video_server_port,
        }
    }

    /// all_files と filtered_files が同一の場合、1回の走査で全インデックス（all, filtered, mtime）を同時に構築する
    pub fn rebuild_all_and_filtered_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut all_map = HashMap::with_capacity(cap);
        let mut mtime_map = HashMap::with_capacity(cap);

        for (i, f) in files.iter().enumerate() {
            all_map.insert(f.path.clone(), i);
            let norm = normalize_unc_path(&f.path);
            if norm != f.path {
                let norm_str = norm.into_owned();
                all_map.insert(norm_str.clone(), i);
                mtime_map.insert(norm_str, f.mtime);
            }
            mtime_map.insert(f.path.clone(), f.mtime);
        }

        if let Ok(mut lock) = self.path_to_filtered_idx.lock() {
            *lock = all_map.clone();
        }
        if let Ok(mut lock) = self.path_to_all_idx.lock() {
            *lock = all_map;
        }
        if let Ok(mut lock) = self.path_to_mtime.lock() {
            *lock = mtime_map;
        }
    }

    /// all_files のインデックスと mtime の逆引きマップを再構築する
    pub fn rebuild_all_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut all_map = HashMap::with_capacity(cap);
        let mut mtime_map = HashMap::with_capacity(cap);
        for (i, f) in files.iter().enumerate() {
            all_map.insert(f.path.clone(), i);
            let norm = normalize_unc_path(&f.path);
            if norm != f.path {
                let norm_str = norm.into_owned();
                all_map.insert(norm_str.clone(), i);
                mtime_map.insert(norm_str, f.mtime);
            }
            mtime_map.insert(f.path.clone(), f.mtime);
        }
        if let Ok(mut lock) = self.path_to_all_idx.lock() {
            *lock = all_map;
        }
        if let Ok(mut lock) = self.path_to_mtime.lock() {
            *lock = mtime_map;
        }
    }

    /// filtered_files のインデックス逆引きマップを再構築する
    pub fn rebuild_filtered_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut filtered_map = HashMap::with_capacity(cap);
        for (i, f) in files.iter().enumerate() {
            filtered_map.insert(f.path.clone(), i);
            let norm = normalize_unc_path(&f.path);
            if norm != f.path {
                filtered_map.insert(norm.into_owned(), i);
            }
        }
        if let Ok(mut lock) = self.path_to_filtered_idx.lock() {
            *lock = filtered_map;
        }
    }

    /// パスから mtime を O(1) で取得する
    pub fn get_mtime(&self, path: &str) -> Option<u64> {
        let Ok(lock) = self.path_to_mtime.lock() else { return None; };
        if let Some(&m) = lock.get(path) {
            return Some(m);
        }
        let clean = strip_unc_prefix(path).unwrap_or(path);
        if let Some(&m) = lock.get(clean) {
            return Some(m);
        }
        let norm_back = clean.replace('/', "\\");
        if let Some(&m) = lock.get(&norm_back) {
            return Some(m);
        }
        let norm_fwd = clean.replace('\\', "/");
        lock.get(&norm_fwd).copied()
    }

    /// サムネイルキャッシュ保持フラグを all_files と filtered_files の両方で O(1) 更新する
    pub fn mark_thumbnail_cached(&self, path: &str) {
        if let Ok(all_idx_lock) = self.path_to_all_idx.lock() {
            let idx_opt = all_idx_lock.get(path).copied().or_else(|| {
                let clean = strip_unc_prefix(path).unwrap_or(path);
                all_idx_lock.get(clean).copied().or_else(|| {
                    let norm_back = clean.replace('/', "\\");
                    all_idx_lock.get(&norm_back).copied().or_else(|| {
                        let norm_fwd = clean.replace('\\', "/");
                        all_idx_lock.get(&norm_fwd).copied()
                    })
                })
            });

            if let Some(idx) = idx_opt {
                if let Ok(mut lock) = self.all_files.lock() {
                    if let Some(f) = lock.get_mut(idx) {
                        if !f.has_thumbnail_cache {
                            Arc::make_mut(f).has_thumbnail_cache = true;
                        }
                    }
                }
            }
        }
        if let Ok(filt_idx_lock) = self.path_to_filtered_idx.lock() {
            let idx_opt = filt_idx_lock.get(path).copied().or_else(|| {
                let clean = strip_unc_prefix(path).unwrap_or(path);
                filt_idx_lock.get(clean).copied().or_else(|| {
                    let norm_back = clean.replace('/', "\\");
                    filt_idx_lock.get(&norm_back).copied().or_else(|| {
                        let norm_fwd = clean.replace('\\', "/");
                        filt_idx_lock.get(&norm_fwd).copied()
                    })
                })
            });

            if let Some(idx) = idx_opt {
                if let Ok(mut lock) = self.filtered_files.lock() {
                    if let Some(f) = lock.get_mut(idx) {
                        if !f.has_thumbnail_cache {
                            Arc::make_mut(f).has_thumbnail_cache = true;
                        }
                    }
                }
            }
        }
    }
}
