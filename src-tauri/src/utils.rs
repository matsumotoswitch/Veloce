//! # Veloce - Utilities (utils.rs)
//!
//! 本モジュールは、自然順ソート (Natural Sort)、UNC パス正規化、
//! メタデータ文字列抽出、および汎用 Tauri コマンドを提供する。

use std::borrow::Cow;
use std::cmp::Ordering;
use crate::models::FullMetadata;

/// 数値を解釈する自然なソート（Natural Sort）の比較関数
pub fn natural_cmp(s1: &str, s2: &str) -> Ordering {
    let mut it1 = s1.chars().peekable();
    let mut it2 = s2.chars().peekable();

    loop {
        match (it1.peek(), it2.peek()) {
            (Some(&c1), Some(&c2)) => {
                if c1.is_ascii_digit() && c2.is_ascii_digit() {
                    let mut n1 = 0u64;
                    let mut n2 = 0u64;
                    while let Some(&c) = it1.peek() {
                        if c.is_ascii_digit() {
                            n1 = n1
                                .saturating_mul(10)
                                .saturating_add((c as u8 - b'0') as u64);
                            it1.next();
                        } else {
                            break;
                        }
                    }
                    while let Some(&c) = it2.peek() {
                        if c.is_ascii_digit() {
                            n2 = n2
                                .saturating_mul(10)
                                .saturating_add((c as u8 - b'0') as u64);
                            it2.next();
                        } else {
                            break;
                        }
                    }
                    if n1 != n2 {
                        return n1.cmp(&n2);
                    }
                } else {
                    let cmp = c1.to_ascii_lowercase().cmp(&c2.to_ascii_lowercase());
                    if cmp != Ordering::Equal {
                        return cmp;
                    }
                    it1.next();
                    it2.next();
                }
            }
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (None, None) => return Ordering::Equal,
        }
    }
}

/// 文字列から最初に出現する連続した数値シーケンスを抽出し u64 として返却する
/// （オーバーフロー時は u64::MAX に飽和）
pub fn extract_first_number(s: &str) -> Option<u64> {
    let mut num_str = String::new();
    let mut in_number = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            in_number = true;
            num_str.push(c);
        } else if in_number {
            break;
        }
    }
    if num_str.is_empty() {
        None
    } else {
        match num_str.parse::<u64>() {
            Ok(n) => Some(n),
            Err(_) => Some(u64::MAX),
        }
    }
}

/// UNC プレフィックス (`\\?\`) を除去したスライスを返却する
#[inline]
pub fn strip_unc_prefix(path: &str) -> Option<&str> {
    if path.starts_with(r"\\?\") {
        Some(&path[4..])
    } else {
        None
    }
}

/// UNC パス表記の一貫性を正規化する
#[inline]
pub fn normalize_unc_path(p: &str) -> Cow<'_, str> {
    if p.starts_with(r"\\?\UNC\") {
        let mut s = String::with_capacity(p.len() - 6);
        s.push_str(r"\\");
        s.push_str(&p[8..]);
        Cow::Owned(s)
    } else if p.starts_with(r"\\?\") {
        Cow::Borrowed(&p[4..])
    } else {
        Cow::Borrowed(p)
    }
}

/// JSON 値から全文検索用のテキストを抽出する
pub fn extract_searchable_text(val: &serde_json::Value) -> String {
    let mut text = String::new();
    match val {
        serde_json::Value::String(s) => {
            if s.len() < 10000 {
                text.push_str(s);
                text.push(' ');
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                text.push_str(&extract_searchable_text(v));
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == "reference_image_multiple" || k == "reference_image" || k == "image" {
                    continue;
                }
                text.push_str(&extract_searchable_text(v));
            }
        }
        serde_json::Value::Number(n) => {
            text.push_str(&n.to_string());
            text.push(' ');
        }
        _ => {}
    }
    text
}

/// メタデータから検索対象文字列（prompt, negative_prompt, source）を抽出する
pub fn extract_searchable_strings(meta: &FullMetadata) -> (String, String, String) {
    let mut p = meta.prompt.clone();
    let mut np = meta.negative_prompt.clone();

    if p.is_empty() {
        if let Some(raw) = meta.params.get("rawParameters").and_then(|v| v.as_str()) {
            p = raw.to_string();
        }
    }

    if let Some(chars) = meta.params.get("characterPrompts").and_then(|v| v.as_array()) {
        for c in chars {
            if let Some(cp) = c.get("prompt").and_then(|v| v.as_str()) {
                p.push_str(" ");
                p.push_str(cp);
            }
            if let Some(ucp) = c.get("uc").and_then(|v| v.as_str()) {
                np.push_str(" ");
                np.push_str(ucp);
            }
        }
    }

    (p.to_lowercase(), np.to_lowercase(), meta.source.to_lowercase())
}

/// アプリケーション専用のローカルデータディレクトリを取得する (`AppData/Local/Veloce`)
pub fn get_veloce_data_dir() -> Option<std::path::PathBuf> {
    tauri::api::path::local_data_dir().map(|mut p| {
        p.push("Veloce");
        p
    })
}

/// フロントエンドからのデバッグログを出力する
#[tauri::command]
pub fn debug_log(msg: String) {
    println!("[JS DEBUG] {}", msg);
}

/// アプリケーションのライセンステキストを取得する
#[tauri::command]
pub fn get_license_text() -> String {
    include_str!("../../LICENSE.md").to_string()
}
