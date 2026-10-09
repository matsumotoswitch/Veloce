//! # Veloce - Models and Data Types (models.rs)
//!
//! 本モジュールは、Rust バックエンドとフロントエンド (WebView2) の間で
//! 交換されるデータ構造、IPC ペイロード、およびエンティティを定義する。

use serde::{Deserialize, Serialize};
pub use compact_str::{CompactString, format_compact};

/// キャッシュ監査・整合性チェックの進捗ペイロード
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditProgress {
    pub current: usize,
    pub total: usize,
    pub deleted: usize,
    pub fixed: usize,
}

/// 画像ファイルエンティティ（Rust 側の Source of Truth）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub name: String,
    pub ext: CompactString,
    pub path: String,
    pub size: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub has_thumbnail_cache: bool,
    pub has_metadata_cache: bool,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default, skip_serializing)]
    pub prompt: String,
    #[serde(default, skip_serializing)]
    pub negative_prompt: String,
    #[serde(default, skip_serializing)]
    pub source: String,
    #[serde(default)]
    pub meta_loaded: bool,
    #[serde(skip)]
    pub search_text: String,
    #[serde(skip)]
    pub unified_search_text: String,
    #[serde(default)]
    pub hash_key: CompactString,
}

/// ディレクトリ読み込み中のチャンク分割配信ペイロード
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryChunkPayload {
    pub path: String,
    pub files: Vec<ImageFile>,
    pub is_complete: bool,
}

/// ディレクトリ読み込み完了時にJS側へ送信するペイロード
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryLoadedPayload {
    pub path: String,
    pub total_count: usize,
    pub initial_chunk: Option<Vec<ImageFile>>,
}

/// JS側から受け取るソート・検索設定
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SortConfig {
    pub key: String,
    pub asc: bool,
}

/// メタデータ一括解析進捗ペイロード
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetadataBatchUpdatedPayload {
    pub processed: usize,
    pub total: usize,
}

/// フルメタデータ構造体
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FullMetadata {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub prompt: String,
    pub negative_prompt: String,
    pub params: serde_json::Value,
    pub source: String,
    #[serde(default)]
    pub metadata_source: String,
}

/// 単一画像のメタデータ解析結果
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParseMetadataResult {
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub params: serde_json::Value,
    pub source: String,
    #[serde(default)]
    pub metadata_source: String,
}

/// フォルダ操作結果
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FolderOperationResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// ファイル移動・コピー操作結果
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MoveOrCopyResult {
    pub success: bool,
    pub action: String,
    pub reason: Option<String>,
}

/// ビューアーウィンドウ初期表示用レスポンス
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ViewerImageResult {
    pub path: String,
    pub total: usize,
    pub index: usize,
    pub chunk_start: usize,
    pub chunk: Vec<String>,
}

/// レーティング同期ペイロード
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RatingPayload {
    pub path: String,
    pub rating: u8,
}

/// スマートフォルダの個別マッチ条件
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolderCondition {
    pub r#type: String,
    pub operator: String,
    pub value: String,
}

/// スマートフォルダのルール定義
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolderRule {
    pub id: String,
    pub name: String,
    pub match_type: String,
    pub conditions: Vec<SmartFolderCondition>,
}

/// スマートフォルダクエリの中間アイテム
#[derive(Clone, Debug)]
pub struct SmartFolderItem {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub width: u32,
    pub height: u32,
    pub metadata: Option<String>,
    pub has_thumbnail: bool,
}

/// キャッシュサイズ・統計情報
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub path: String,
    pub file_count: usize,
    pub total_size_bytes: u64,
}

/// DB非同期書き込みメッセージ
pub enum DbMsg {
    SaveThumbnail {
        hash_key: String,
        path: String,
        mtime: u64,
        bytes: Vec<u8>,
        now: i64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_image_file_compact_fields_inline() {
        let ext = CompactString::new(".png");
        let hash_key = CompactString::new("0123456789abcdef");

        // 24バイト以内の文字列はヒープ割り当てされずにインライン格納されることを保証
        assert!(!ext.is_heap_allocated(), "ext (.png) はインライン格納されること");
        assert!(!hash_key.is_heap_allocated(), "hash_key (16桁HEX) はインライン格納されること");

        let file = ImageFile {
            name: "sample.png".to_string(),
            ext,
            path: "C:\\images\\sample.png".to_string(),
            size: 1024,
            mtime: 123456,
            ctime: 123456,
            has_thumbnail_cache: true,
            has_metadata_cache: false,
            width: 832,
            height: 1216,
            prompt: String::new(),
            negative_prompt: String::new(),
            source: String::new(),
            meta_loaded: false,
            search_text: String::new(),
            unified_search_text: String::new(),
            hash_key,
        };

        assert!(!file.ext.is_heap_allocated());
        assert!(!file.hash_key.is_heap_allocated());
        assert_eq!(file.ext.as_str(), ".png");
        assert_eq!(file.hash_key.as_str(), "0123456789abcdef");
    }

    #[test]
    fn test_image_file_serde_compat() {
        let file = ImageFile {
            name: "test.webp".to_string(),
            ext: CompactString::new(".webp"),
            path: "C:\\test\\test.webp".to_string(),
            size: 2048,
            mtime: 78910,
            ctime: 78910,
            has_thumbnail_cache: false,
            has_metadata_cache: true,
            width: 1024,
            height: 1024,
            prompt: "1girl".to_string(),
            negative_prompt: "lowres".to_string(),
            source: "novelai".to_string(),
            meta_loaded: true,
            search_text: "test".to_string(),
            unified_search_text: "test".to_string(),
            hash_key: CompactString::new("fedcba9876543210"),
        };

        // JSONシリアライズ結果の互換性検証（camelCase, hashKey など）
        let json_str = serde_json::to_string(&file).expect("JSON serialization failed");
        assert!(json_str.contains("\"ext\":\".webp\""), "ext が正しくシリアライズされること");
        assert!(json_str.contains("\"hashKey\":\"fedcba9876543210\""), "hashKey が正しく camelCase でシリアライズされること");

        // デシリアライズ検証
        let deserialized: ImageFile = serde_json::from_str(&json_str).expect("JSON deserialization failed");
        assert_eq!(deserialized.ext, ".webp");
        assert_eq!(deserialized.hash_key, "fedcba9876543210");
        assert!(!deserialized.ext.is_heap_allocated());
        assert!(!deserialized.hash_key.is_heap_allocated());
    }
}
