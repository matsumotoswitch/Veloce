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
            if let Some(adopted_cp) = c.get("adoptedPrompt").or_else(|| c.get("adopted_prompt")).and_then(|v| v.as_str()) {
                p.push_str(" ");
                p.push_str(adopted_cp);
            }
            if let Some(ucp) = c.get("uc").and_then(|v| v.as_str()) {
                np.push_str(" ");
                np.push_str(ucp);
            }
            if let Some(adopted_ucp) = c.get("adoptedUc").or_else(|| c.get("adopted_uc")).and_then(|v| v.as_str()) {
                np.push_str(" ");
                np.push_str(adopted_ucp);
            }
        }
    }

    if let Some(adopted) = meta.params.get("adoptedPrompt")
        .or_else(|| meta.params.get("adopted_prompt"))
        .or_else(|| meta.params.get("prompt"))
        .and_then(|v| v.as_str())
    {
        let trimmed = adopted.trim();
        if !trimmed.is_empty() && trimmed != meta.prompt.trim() {
            p.push_str(" ");
            p.push_str(trimmed);
        }
    }

    if let Some(adopted_np) = meta.params.get("adoptedNegativePrompt")
        .or_else(|| meta.params.get("adopted_negative_prompt"))
        .and_then(|v| v.as_str())
    {
        let trimmed = adopted_np.trim();
        if !trimmed.is_empty() && trimmed != meta.negative_prompt.trim() {
            np.push_str(" ");
            np.push_str(trimmed);
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

/// パス文字列と mtime (更新日時) から xxHash (xxh3_64) を中間ヒープアロケーションなしで高速計算する
///
/// 入力バイト列: `"{path}_{mtime}"` の UTF-8 バイト列（旧実装と 100% 互換）
/// スタック上の固定バッファに mtime をフォーマットし、ストリーミングハッシャーに逐次投入することで
/// `format!("{}_{}", path, mtime)` によるヒープアロケーション（String割り当て）を排除する。
pub fn hash_path_mtime<T: std::fmt::Display>(path: &str, mtime: T) -> u64 {
    use std::io::Write;
    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
    hasher.update(path.as_bytes());
    hasher.update(b"_");
    let mut num_buf = [0u8; 32];
    let mut cursor = std::io::Cursor::new(&mut num_buf[..]);
    let _ = write!(cursor, "{}", mtime);
    let written = cursor.position() as usize;
    hasher.update(&num_buf[..written]);
    hasher.digest()
}

/// パスと mtime から 16文字の16進数キャッシュキー (`{:016x}`) を生成する
pub fn hash_path_mtime_hex<T: std::fmt::Display>(path: &str, mtime: T) -> String {
    format!("{:016x}", hash_path_mtime(path, mtime))
}

/// OSのCSPRNGが使用できない環境向けのフォールバックトークン生成。
/// 標準ライブラリの `RandomState`（OS乱数シードで初期化される独立したハッシャー状態）を
/// 前半64bit・後半64bitそれぞれに別個に混合し、128ビット全体が独立したエントロピーを持つようにする。
fn generate_fallback_token(seed_addr: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();

    let mut hasher1 = RandomState::new().build_hasher();
    hasher1.write_u128(nanos);
    hasher1.write_u32(pid);
    hasher1.write_usize(seed_addr);
    let r1 = hasher1.finish();

    let mut hasher2 = RandomState::new().build_hasher();
    hasher2.write_u64(r1);
    hasher2.write_u128(nanos.wrapping_add(1));
    hasher2.write_usize(seed_addr.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let r2 = hasher2.finish();

    let mut mix1 = [0u8; 24];
    mix1[..16].copy_from_slice(&nanos.to_le_bytes());
    mix1[16..].copy_from_slice(&r1.to_le_bytes());
    let h1 = xxhash_rust::xxh3::xxh3_64(&mix1);

    let mut mix2 = [0u8; 24];
    mix2[..8].copy_from_slice(&h1.to_le_bytes());
    mix2[8..16].copy_from_slice(&r2.to_le_bytes());
    mix2[16..].copy_from_slice(&(seed_addr as u64).to_le_bytes());
    let h2 = xxhash_rust::xxh3::xxh3_64(&mix2);

    format!("{:016x}{:016x}", h1, h2)
}

/// 暗号学的に安全な疑似乱数生成器（CSPRNG）を用いて128ビット（32文字hex）のセッショントークンを生成します。
pub fn generate_secure_token() -> String {
    let mut random_bytes = [0u8; 16];
    #[cfg(target_os = "windows")]
    {
        #[link(name = "advapi32")]
        extern "system" {
            #[link_name = "SystemFunction036"]
            fn RtlGenRandom(pb_buffer: *mut u8, cb_buffer: u32) -> u8;
        }
        let success = unsafe { RtlGenRandom(random_bytes.as_mut_ptr(), random_bytes.len() as u32) != 0 };
        if success {
            return random_bytes.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    // 非Windows環境または万が一のOS乱数生成失敗時のフォールバック
    generate_fallback_token(random_bytes.as_ptr() as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_secure_token_length_and_uniqueness() {
        let token1 = generate_secure_token();
        let token2 = generate_secure_token();
        assert_eq!(token1.len(), 32);
        assert_eq!(token2.len(), 32);
        assert_ne!(token1, token2, "2回生成したトークンが一意であること");
        assert!(token1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_generate_fallback_token_independent_entropy() {
        let fb1 = generate_fallback_token(0x12345678);
        let fb2 = generate_fallback_token(0x12345678);
        assert_eq!(fb1.len(), 32);
        assert_eq!(fb2.len(), 32);
        assert_ne!(fb1, fb2, "同一アドレス引数でも RandomState により異なるトークンが生成されること");

        let h1 = u64::from_str_radix(&fb1[..16], 16).unwrap();
        let deterministic_h2 = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(&h1.to_le_bytes()));
        assert_ne!(
            &fb1[16..],
            deterministic_h2,
            "後半64bitが前半64bitからの単純な決定論的ハッシュではないこと"
        );
    }

    #[test]
    fn test_hash_path_mtime_matches_legacy_format() {
        let u64_cases = [
            ("C:\\images\\photo.png", 1700000000u64),
            ("D:/novelai/generation_001.webp", 1712345678901u64),
            ("\\\\?\\UNC\\server\\share\\art.png", 0u64),
            ("日本語パス/テスト_画像.png", 999999999999u64),
        ];

        for (path, mtime) in u64_cases {
            let legacy_digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", path, mtime).as_bytes());
            let optimized_digest = hash_path_mtime(path, mtime);
            assert_eq!(
                legacy_digest, optimized_digest,
                "Hash mismatch for path '{}' and mtime '{}'",
                path, mtime
            );

            let legacy_hex = format!("{:016x}", legacy_digest);
            let optimized_hex = hash_path_mtime_hex(path, mtime);
            assert_eq!(legacy_hex, optimized_hex);
        }

        let i64_cases = [
            ("C:\\images\\photo.png", 1700000000i64),
            ("D:/novelai/generation_001.webp", 1712345678901i64),
            ("\\\\?\\UNC\\server\\share\\art.png", 0i64),
            ("日本語パス/テスト_画像.png", 999999999999i64),
        ];

        for (path, mtime) in i64_cases {
            let legacy_digest = xxhash_rust::xxh3::xxh3_64(format!("{}_{}", path, mtime).as_bytes());
            let optimized_digest = hash_path_mtime(path, mtime);
            assert_eq!(legacy_digest, optimized_digest);

            let legacy_hex = format!("{:016x}", legacy_digest);
            let optimized_hex = hash_path_mtime_hex(path, mtime);
            assert_eq!(legacy_hex, optimized_hex);
        }
    }
}
