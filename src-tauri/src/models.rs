//! # Veloce - Models and Data Types (models.rs)
//!
//! 本モジュールは、Rust バックエンドとフロントエンド (WebView2) の間で
//! 交換されるデータ構造、IPC ペイロード、およびエンティティを定義する。

use serde::{Deserialize, Serialize};

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
    pub ext: String,
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
    pub hash_key: String,
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
