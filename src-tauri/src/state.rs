//! # Veloce - State Management (state.rs)
//!
//! アプリケーション全体のメモリ内状態（Source of Truth）および
//! O(1) 逆引きインデックスを管理する `AppState` 構造体の定義。

use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::{Mutex, RwLock};
use crate::models::{DbMsg, ImageFile, SmartFolderRule, SortConfig};
use crate::utils::{normalize_unc_path, strip_unc_prefix};

/// 高速な非暗号学的ハッシュ（xxh3_64）を用いた内部マップ用型エイリアス
pub type FastHashMap<K, V> = HashMap<K, V, xxhash_rust::xxh3::Xxh3Builder>;

pub struct AppState {
    pub image_paths: RwLock<Arc<Vec<String>>>,
    pub current_dir: RwLock<String>,
    pub viewer_paths: RwLock<HashMap<String, Arc<Vec<String>>>>,
    pub viewer_hashes: RwLock<HashMap<String, String>>,
    // Source of Truth: 全ファイルとフィルタリング済みファイルをRust側で保持
    pub all_files: RwLock<Vec<Arc<ImageFile>>>,
    pub filtered_files: RwLock<Vec<Arc<ImageFile>>>,
    // O(1) 高速逆引きインデックス（xxh3ハッシャーによる高速キー探索）
    pub path_to_all_idx: RwLock<FastHashMap<String, usize>>,
    pub path_to_filtered_idx: RwLock<FastHashMap<String, usize>>,
    pub path_to_mtime: RwLock<FastHashMap<String, u64>>,
    pub sort_config: RwLock<SortConfig>,
    pub search_query: RwLock<String>,
    pub ratings: RwLock<HashMap<String, u8>>,
    pub rating_filter_val: Mutex<u8>,
    pub rating_filter_op: Mutex<String>,
    pub db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub settings_db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub settings_db_existed: Mutex<bool>,
    pub smart_folders: RwLock<Vec<SmartFolderRule>>,
    pub db_tx: tokio::sync::mpsc::Sender<DbMsg>,
    pub video_server_port: u16,
}

impl AppState {
    pub fn new(
        db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
        settings_db_conn: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
        settings_db_existed: bool,
        db_tx: tokio::sync::mpsc::Sender<DbMsg>,
        video_server_port: u16,
    ) -> Self {
        Self {
            image_paths: RwLock::new(Arc::new(Vec::new())),
            current_dir: RwLock::new(String::new()),
            viewer_paths: RwLock::new(HashMap::new()),
            viewer_hashes: RwLock::new(HashMap::new()),
            all_files: RwLock::new(Vec::new()),
            filtered_files: RwLock::new(Vec::new()),
            path_to_all_idx: RwLock::new(FastHashMap::default()),
            path_to_filtered_idx: RwLock::new(FastHashMap::default()),
            path_to_mtime: RwLock::new(FastHashMap::default()),
            sort_config: RwLock::new(SortConfig {
                key: "name".to_string(),
                asc: true,
            }),
            search_query: RwLock::new(String::new()),
            ratings: RwLock::new(HashMap::new()),
            rating_filter_val: Mutex::new(0),
            rating_filter_op: Mutex::new("gte".to_string()),
            db_conn,
            settings_db_conn,
            settings_db_existed: Mutex::new(settings_db_existed),
            smart_folders: RwLock::new(Vec::new()),
            db_tx,
            video_server_port,
        }
    }

    /// all_files と filtered_files が同一の場合、1回の走査で全インデックス（all, filtered, mtime）を同時に構築する
    pub fn rebuild_all_and_filtered_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut all_map = FastHashMap::with_capacity_and_hasher(cap, xxhash_rust::xxh3::Xxh3Builder::new());
        let mut mtime_map = FastHashMap::with_capacity_and_hasher(cap, xxhash_rust::xxh3::Xxh3Builder::new());

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

        *self.path_to_filtered_idx.write() = all_map.clone();
        *self.path_to_all_idx.write() = all_map;
        *self.path_to_mtime.write() = mtime_map;
    }

    /// all_files のインデックスと mtime の逆引きマップを再構築する
    pub fn rebuild_all_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut all_map = FastHashMap::with_capacity_and_hasher(cap, xxhash_rust::xxh3::Xxh3Builder::new());
        let mut mtime_map = FastHashMap::with_capacity_and_hasher(cap, xxhash_rust::xxh3::Xxh3Builder::new());
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
        *self.path_to_all_idx.write() = all_map;
        *self.path_to_mtime.write() = mtime_map;
    }

    /// filtered_files のインデックス逆引きマップを再構築する
    pub fn rebuild_filtered_indices(&self, files: &[Arc<ImageFile>]) {
        let has_unc = files.iter().take(20).any(|f| f.path.starts_with(r"\\?\"));
        let cap = if has_unc { files.len() * 2 } else { files.len() + 16 };
        let mut filtered_map = FastHashMap::with_capacity_and_hasher(cap, xxhash_rust::xxh3::Xxh3Builder::new());
        for (i, f) in files.iter().enumerate() {
            filtered_map.insert(f.path.clone(), i);
            let norm = normalize_unc_path(&f.path);
            if norm != f.path {
                filtered_map.insert(norm.into_owned(), i);
            }
        }
        *self.path_to_filtered_idx.write() = filtered_map;
    }

    /// パスから mtime を O(1) で取得する（並行読み取り対応）
    pub fn get_mtime(&self, path: &str) -> Option<u64> {
        let lock = self.path_to_mtime.read();
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
        let idx_opt = {
            let all_idx_lock = self.path_to_all_idx.read();
            all_idx_lock.get(path).copied().or_else(|| {
                let clean = strip_unc_prefix(path).unwrap_or(path);
                all_idx_lock.get(clean).copied().or_else(|| {
                    let norm_back = clean.replace('/', "\\");
                    all_idx_lock.get(&norm_back).copied().or_else(|| {
                        let norm_fwd = clean.replace('\\', "/");
                        all_idx_lock.get(&norm_fwd).copied()
                    })
                })
            })
        };

        if let Some(idx) = idx_opt {
            let mut lock = self.all_files.write();
            if let Some(f) = lock.get_mut(idx) {
                if !f.has_thumbnail_cache {
                    Arc::make_mut(f).has_thumbnail_cache = true;
                }
            }
        }

        let filt_idx_opt = {
            let filt_idx_lock = self.path_to_filtered_idx.read();
            filt_idx_lock.get(path).copied().or_else(|| {
                let clean = strip_unc_prefix(path).unwrap_or(path);
                filt_idx_lock.get(clean).copied().or_else(|| {
                    let norm_back = clean.replace('/', "\\");
                    filt_idx_lock.get(&norm_back).copied().or_else(|| {
                        let norm_fwd = clean.replace('\\', "/");
                        filt_idx_lock.get(&norm_fwd).copied()
                    })
                })
            })
        };

        if let Some(idx) = filt_idx_opt {
            let mut lock = self.filtered_files.write();
            if let Some(f) = lock.get_mut(idx) {
                if !f.has_thumbnail_cache {
                    Arc::make_mut(f).has_thumbnail_cache = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    fn create_test_file(path: &str, mtime: u64) -> Arc<ImageFile> {
        Arc::new(ImageFile {
            name: path.split(&['/', '\\'][..]).last().unwrap_or("").to_string(),
            ext: ".png".to_string(),
            path: path.to_string(),
            size: 1024,
            mtime,
            ctime: mtime,
            has_thumbnail_cache: false,
            has_metadata_cache: false,
            width: 512,
            height: 512,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key: String::new(),
        })
    }

    #[test]
    fn test_rebuild_and_lookup_unc() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let state = AppState::new(pool.clone(), pool, false, tx, 0);

        let files = vec![
            create_test_file(r"C:\test\img1.png", 100),
            create_test_file(r"\\?\C:\test\img2.png", 200),
            create_test_file("C:/test/img3.png", 300),
        ];

        state.rebuild_all_and_filtered_indices(&files);

        // 正引き・逆引きの検証
        assert_eq!(state.get_mtime(r"C:\test\img1.png"), Some(100));
        assert_eq!(state.get_mtime(r"C:/test/img1.png"), Some(100));
        assert_eq!(state.get_mtime(r"\\?\C:\test\img2.png"), Some(200));
        assert_eq!(state.get_mtime(r"C:\test\img2.png"), Some(200));
        assert_eq!(state.get_mtime("C:/test/img3.png"), Some(300));
        assert_eq!(state.get_mtime(r"C:\test\img3.png"), Some(300));
        assert_eq!(state.get_mtime(r"C:\test\not_found.png"), None);
    }

    #[test]
    fn test_concurrent_read_write() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let state = Arc::new(AppState::new(pool.clone(), pool, false, tx, 0));

        let initial_files: Vec<Arc<ImageFile>> = (0..100)
            .map(|i| create_test_file(&format!(r"C:\test\img_{}.png", i), 1000 + i as u64))
            .collect();
        state.rebuild_all_and_filtered_indices(&initial_files);

        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        // 4本の読み込み（Read）スレッド: get_mtime を高頻度で実行
        for thread_id in 0..4 {
            let state_clone = Arc::clone(&state);
            let stop_clone = Arc::clone(&stop);
            handles.push(thread::spawn(move || {
                let mut count = 0;
                while !stop_clone.load(Ordering::Relaxed) {
                    let idx = (count + thread_id) % 100;
                    let path = format!(r"C:\test\img_{}.png", idx);
                    let _ = state_clone.get_mtime(&path);
                    count += 1;
                }
                count
            }));
        }

        // 1本の書き込み（Write）スレッド: rebuild を繰り返し実行
        let state_write = Arc::clone(&state);
        let stop_write = Arc::clone(&stop);
        let write_handle = thread::spawn(move || {
            let mut iter = 0;
            while !stop_write.load(Ordering::Relaxed) && iter < 50 {
                let updated_files: Vec<Arc<ImageFile>> = (0..100)
                    .map(|i| create_test_file(&format!(r"C:\test\img_{}.png", i), (1000 + i + iter) as u64))
                    .collect();
                state_write.rebuild_all_and_filtered_indices(&updated_files);
                iter += 1;
                thread::sleep(Duration::from_millis(1));
            }
        });

        // 100ms並行実行させた後に停止シグナル
        thread::sleep(Duration::from_millis(100));
        stop.store(true, Ordering::Relaxed);

        write_handle.join().unwrap();
        for h in handles {
            let count = h.join().unwrap();
            assert!(count > 0, "並行読み取りスレッドが正常に処理を実行できたこと");
        }
    }

    #[test]
    fn test_mark_thumbnail_cached_concurrent() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let state = Arc::new(AppState::new(pool.clone(), pool, false, tx, 0));

        let files: Vec<Arc<ImageFile>> = (0..50)
            .map(|i| create_test_file(&format!(r"C:\test\img_{}.png", i), 1000))
            .collect();
        *state.all_files.write() = files.clone();
        *state.filtered_files.write() = files.clone();
        state.rebuild_all_and_filtered_indices(&files);

        let mut handles = Vec::new();
        for i in 0..50 {
            let state_clone = Arc::clone(&state);
            handles.push(thread::spawn(move || {
                let path = format!(r"C:\test\img_{}.png", i);
                state_clone.mark_thumbnail_cached(&path);
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // 全件キャッシュフラグが true に更新されていること
        let all_files = state.all_files.read();
        for f in all_files.iter() {
            assert!(f.has_thumbnail_cache, "サムネイルキャッシュフラグが true に更新されていること: {}", f.path);
        }
    }

    #[test]
    fn test_xxh3_path_lookup() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let state = AppState::new(pool.clone(), pool, false, tx, 0);

        let files = vec![
            create_test_file(r"C:\images\standard.png", 1001),
            create_test_file(r"\\?\C:\images\unc_path.png", 2002),
            create_test_file("C:/images/forward_slash.png", 3003),
            create_test_file(r"\\?\C:/images/unc_forward.png", 4004),
        ];

        *state.all_files.write() = files.clone();
        *state.filtered_files.write() = files.clone();
        state.rebuild_all_and_filtered_indices(&files);

        // 1. 通常パスの探索検証
        assert_eq!(state.path_to_all_idx.read().get(r"C:\images\standard.png").copied(), Some(0));
        assert_eq!(state.path_to_filtered_idx.read().get(r"C:\images\standard.png").copied(), Some(0));
        assert_eq!(state.get_mtime(r"C:\images\standard.png"), Some(1001));

        // 2. UNCプレフィックス付きパスの探索（UNC除去後パスでも探索可能であること）
        assert_eq!(state.path_to_all_idx.read().get(r"\\?\C:\images\unc_path.png").copied(), Some(1));
        assert_eq!(state.path_to_all_idx.read().get(r"C:\images\unc_path.png").copied(), Some(1));
        assert_eq!(state.get_mtime(r"\\?\C:\images\unc_path.png"), Some(2002));
        assert_eq!(state.get_mtime(r"C:\images\unc_path.png"), Some(2002));

        // 3. スラッシュ・バックスラッシュ正規化フォールバックの探索
        assert_eq!(state.get_mtime("C:/images/forward_slash.png"), Some(3003));
        assert_eq!(state.get_mtime(r"C:\images\forward_slash.png"), Some(3003));

        // 4. UNCかつスラッシュ混在パスの探索
        assert_eq!(state.get_mtime(r"\\?\C:/images/unc_forward.png"), Some(4004));
        assert_eq!(state.get_mtime("C:/images/unc_forward.png"), Some(4004));
        assert_eq!(state.get_mtime(r"C:\images\unc_forward.png"), Some(4004));

        // 5. 存在しないパスは None を返すこと
        assert_eq!(state.path_to_all_idx.read().get(r"C:\images\non_existent.png"), None);
        assert_eq!(state.get_mtime(r"C:\images\non_existent.png"), None);
    }
}
