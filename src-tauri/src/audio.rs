//! # Veloce - Audio Metadata & Cover Art Module (audio.rs)
//!
//! 本モジュールは、音声ファイル（現在は MP3）に対する拡張子判定、Content-Type 解決、
//! および `lofty` クレートを用いたメタデータ（タイトル・アーティスト・再生時間・埋め込みカバー画像）の
//! 安全な抽出処理を提供する。
//! 将来的な音声形式（FLAC/WAV 等）の追加を見据え、拡張子判定と解析ロジックを本モジュールに集約している。

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::id3::v2::{Frame, Id3v2Tag};
use lofty::mpeg::MpegFile;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, TagExt};
use std::io::BufReader;
use std::path::Path;

/// 音声ファイルから抽出したメタデータ情報
#[derive(Debug, Clone, Default)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub lyrics: Option<String>,
    pub comment: Option<String>,
    pub recording_date: Option<String>,
    pub duration_secs: Option<f64>,
    pub has_tags: bool,
    pub cover_bytes: Option<Vec<u8>>,
}

/// 拡張子（小文字、ドットなし）がサポート対象の音声形式かどうかを判定する
/// 現時点では `mp3` のみを対象とし、将来の形式拡張時はこの判定テーブルへ追加する
#[inline]
pub fn is_audio_extension(ext_lower: &str) -> bool {
    matches!(ext_lower, "mp3")
}

/// ファイルパスがサポート対象の音声ファイルかどうかを判定する
#[inline]
pub fn is_audio_path(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    is_audio_extension(&ext)
}

/// 音声拡張子に対応する HTTP Content-Type を返す
#[inline]
pub fn audio_content_type(ext_lower: &str) -> &'static str {
    match ext_lower {
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// 秒数を `m:ss` または `h:mm:ss` 形式に整形する
pub fn format_duration(secs: f64) -> String {
    if !secs.is_finite() || secs <= 0.0 {
        return "0:00".to_string();
    }
    let total = secs.round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{}:{:02}:{:02}", hours, minutes, seconds)
    } else {
        format!("{}:{:02}", minutes, seconds)
    }
}

/// バイト列の先頭マジックバイトから JPEG / PNG 画像かどうかを判定する
fn is_supported_cover_bytes(data: &[u8]) -> bool {
    if data.len() < 4 {
        return false;
    }
    // JPEG (SOI: FF D8 FF)
    if data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
        return true;
    }
    // PNG (\x89PNG\r\n\x1a\n)
    if data.len() >= 8 && &data[0..8] == b"\x89PNG\r\n\x1a\n" {
        return true;
    }
    false
}

/// Picture が JPEG / PNG カバー画像として利用可能かを判定する
fn is_supported_picture(pic: &Picture) -> bool {
    match pic.mime_type() {
        Some(MimeType::Jpeg) | Some(MimeType::Png) => !pic.data().is_empty(),
        None | Some(MimeType::Unknown(_)) => is_supported_cover_bytes(pic.data()),
        _ => false,
    }
}

/// 優先度付き（CoverFront を最優先、次点で先頭の JPEG/PNG）で埋め込みカバー画像を抽出する
fn pick_cover_art<'a, I>(tags: I) -> Option<Vec<u8>>
where
    I: Iterator<Item = &'a lofty::tag::Tag> + Clone,
{
    for tag in tags.clone() {
        for pic in tag.pictures() {
            if pic.pic_type() == PictureType::CoverFront && is_supported_picture(pic) {
                return Some(pic.data().to_vec());
            }
        }
    }
    for tag in tags {
        for pic in tag.pictures() {
            if is_supported_picture(pic) {
                return Some(pic.data().to_vec());
            }
        }
    }
    None
}

/// `lofty` でファイルを開き、メタデータ・再生時間・埋め込みカバー画像を安全に解析する。
/// タグ欠落・破損・途中切断ファイルに対しても panic せず空のメタデータとして継続する。
pub fn parse_audio_metadata(path: &str) -> AudioMetadata {
    parse_audio_metadata_internal(path, true, true)
}

/// 埋め込みカバー画像のバイト列のみを高速抽出する（ビューアー表示・HTTP配信向け）。
/// プロパティ計算（フレーム走査）を抑制してタグ領域のみを解析する。
pub fn extract_audio_cover(path: &str) -> Option<Vec<u8>> {
    parse_audio_metadata_internal(path, false, true).cover_bytes
}

fn assign_if_nonempty(slot: &mut Option<String>, value: Option<&str>) {
    if slot.is_some() {
        return;
    }
    if let Some(raw) = value {
        // ID3v2.4 では複数値区切り等として '\0' が混入する場合があるため正規化する
        let cleaned = if raw.contains('\0') {
            raw.split('\0')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            raw.trim().to_string()
        };
        if !cleaned.is_empty() {
            *slot = Some(cleaned);
        }
    }
}

/// `lofty` の汎用 `TaggedFile` 変換（`SplitTag`）では 4 文字記述の `TXXX` フレーム
/// （例: FFmpeg 等が出力する `TXXX: USLT`）が除外され、`TXXX: comment` も
/// `ItemKey::Comment` へ写像されないため、生の `Id3v2Tag` フレームを直接補完する。
fn fill_from_raw_id3v2(id3v2: &Id3v2Tag, meta: &mut AudioMetadata) {
    assign_if_nonempty(&mut meta.title, id3v2.title().as_deref());
    assign_if_nonempty(&mut meta.artist, id3v2.artist().as_deref());
    assign_if_nonempty(&mut meta.album, id3v2.album().as_deref());

    for uslt in id3v2.unsync_text() {
        assign_if_nonempty(&mut meta.lyrics, Some(uslt.content.as_str()));
        if meta.lyrics.is_some() {
            break;
        }
    }

    for comm in id3v2.comments() {
        assign_if_nonempty(&mut meta.comment, Some(comm.content.as_str()));
        if meta.comment.is_some() {
            break;
        }
    }
    if meta.comment.is_none() {
        for frame in id3v2 {
            if let Frame::Comment(comm) = frame {
                let desc_lower = comm.description.trim().to_ascii_lowercase();
                if desc_lower.starts_with("itun") {
                    continue;
                }
                assign_if_nonempty(&mut meta.comment, Some(comm.content.as_str()));
                if meta.comment.is_some() {
                    break;
                }
            }
        }
    }

    if meta.recording_date.is_none() {
        for frame in id3v2 {
            if frame.id_str() == "TDRC" {
                match frame {
                    Frame::Timestamp(ts) => {
                        let formatted = ts.timestamp.to_string();
                        assign_if_nonempty(&mut meta.recording_date, Some(formatted.as_str()));
                    }
                    Frame::Text(tf) => {
                        assign_if_nonempty(&mut meta.recording_date, Some(tf.value.as_str()));
                    }
                    _ => {}
                }
                if meta.recording_date.is_some() {
                    break;
                }
            }
        }
    }
    if meta.recording_date.is_none() {
        if let Some(y) = id3v2.year() {
            meta.recording_date = Some(y.to_string());
        }
    }

    for frame in id3v2 {
        if let Frame::UserText(ut) = frame {
            let desc_lower = ut.description.trim().to_ascii_lowercase();
            match desc_lower.as_str() {
                "uslt" | "lyrics" | "unsyncedlyrics" | "unsynced_lyrics" | "lyric" => {
                    assign_if_nonempty(&mut meta.lyrics, Some(ut.content.as_str()));
                }
                "comment" | "comments" | "comm" | "description" => {
                    assign_if_nonempty(&mut meta.comment, Some(ut.content.as_str()));
                }
                "tdrc" | "recordingdate" | "recording_date" | "date" | "year" => {
                    assign_if_nonempty(&mut meta.recording_date, Some(ut.content.as_str()));
                }
                "tit2" | "title" => {
                    assign_if_nonempty(&mut meta.title, Some(ut.content.as_str()));
                }
                "tpe1" | "artist" => {
                    assign_if_nonempty(&mut meta.artist, Some(ut.content.as_str()));
                }
                "talb" | "album" => {
                    assign_if_nonempty(&mut meta.album, Some(ut.content.as_str()));
                }
                _ => {}
            }
        }
    }
}

fn read_mpeg_with_fallback(path: &str, mut options: ParseOptions, read_properties: bool) -> Option<MpegFile> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    match MpegFile::read_from(&mut reader, options) {
        Ok(mf) => Some(mf),
        Err(_) if read_properties => {
            // 音声フレーム同期や Xing ヘッダが途中切断されている場合でも ID3v2 タグとカバー画像を救助する
            let file2 = std::fs::File::open(path).ok()?;
            let mut reader2 = BufReader::new(file2);
            MpegFile::read_from(&mut reader2, options.read_properties(false)).ok()
        }
        Err(_) => None,
    }
}

fn parse_audio_metadata_internal(
    path: &str,
    read_properties: bool,
    read_cover: bool,
) -> AudioMetadata {
    let mut meta = AudioMetadata::default();
    if !is_audio_path(path) {
        return meta;
    }

    let options = ParseOptions::new()
        .parsing_mode(ParsingMode::Relaxed)
        .read_properties(read_properties)
        .read_cover_art(read_cover);

    let mut raw_id3v2_fallback = AudioMetadata::default();
    let mut has_raw_id3v2 = false;

    let tagged_file: TaggedFile = if let Some(mpeg_file) = read_mpeg_with_fallback(path, options, read_properties) {
        if let Some(id3v2) = mpeg_file.id3v2() {
            has_raw_id3v2 = !id3v2.is_empty();
            fill_from_raw_id3v2(id3v2, &mut raw_id3v2_fallback);
        }
        mpeg_file.into()
    } else {
        let probe = match Probe::open(path) {
            Ok(p) => p,
            Err(_) => return meta,
        };
        match probe.options(options).read() {
            Ok(tf) => tf,
            Err(_) => return meta,
        }
    };

    if read_properties {
        let dur = tagged_file.properties().duration();
        let secs = dur.as_secs_f64();
        if secs.is_finite() && secs > 0.0 {
            meta.duration_secs = Some(secs);
        }
    }

    let mut ordered_tags: Vec<&lofty::tag::Tag> = Vec::new();
    if let Some(primary) = tagged_file.primary_tag() {
        ordered_tags.push(primary);
    }
    for tag in tagged_file.tags() {
        if tagged_file
            .primary_tag()
            .map_or(true, |p| !std::ptr::eq(p, tag))
        {
            ordered_tags.push(tag);
        }
    }

    for tag in &ordered_tags {
        assign_if_nonempty(&mut meta.title, tag.title().as_deref());
        assign_if_nonempty(&mut meta.artist, tag.artist().as_deref());
        assign_if_nonempty(&mut meta.album, tag.album().as_deref());
        assign_if_nonempty(&mut meta.lyrics, tag.get_string(&ItemKey::Lyrics));
        assign_if_nonempty(&mut meta.comment, tag.comment().as_deref());
        assign_if_nonempty(
            &mut meta.recording_date,
            tag.get_string(&ItemKey::RecordingDate)
                .or_else(|| tag.get_string(&ItemKey::Year)),
        );
        if meta.recording_date.is_none() {
            if let Some(y) = tag.year() {
                meta.recording_date = Some(y.to_string());
            }
        }
    }

    // 汎用 TaggedFile で取得できなかった項目を ID3v2 生フレーム（TXXX: USLT / TXXX: comment 等）で補完する
    if has_raw_id3v2 {
        assign_if_nonempty(&mut meta.title, raw_id3v2_fallback.title.as_deref());
        assign_if_nonempty(&mut meta.artist, raw_id3v2_fallback.artist.as_deref());
        assign_if_nonempty(&mut meta.album, raw_id3v2_fallback.album.as_deref());
        assign_if_nonempty(&mut meta.lyrics, raw_id3v2_fallback.lyrics.as_deref());
        assign_if_nonempty(&mut meta.comment, raw_id3v2_fallback.comment.as_deref());
        assign_if_nonempty(
            &mut meta.recording_date,
            raw_id3v2_fallback.recording_date.as_deref(),
        );
    }

    if read_cover {
        meta.cover_bytes = pick_cover_art(ordered_tags.iter().copied());
    }

    meta.has_tags = (!ordered_tags.is_empty() || has_raw_id3v2)
        && (meta.title.is_some()
            || meta.artist.is_some()
            || meta.album.is_some()
            || meta.lyrics.is_some()
            || meta.comment.is_some()
            || meta.recording_date.is_some()
            || meta.cover_bytes.is_some());

    meta
}

#[cfg(test)]
pub(crate) mod test_fixtures {
    /// 1x1 赤ピクセルの有効な PNG バイト列（カバー画像フィクスチャ用）
    pub(crate) const SAMPLE_PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR len + type
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB + CRC
        0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT len + type
        0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00,
        0x18, 0xDD, 0x8D, 0xB0, // IDAT data + CRC
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
        0xAE, 0x42, 0x60, 0x82,
    ];

    fn to_synchsafe(val: u32) -> [u8; 4] {
        [
            ((val >> 21) & 0x7F) as u8,
            ((val >> 14) & 0x7F) as u8,
            ((val >> 7) & 0x7F) as u8,
            (val & 0x7F) as u8,
        ]
    }

    fn build_id3v23_text_frame(frame_id: &[u8; 4], text: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x03); // UTF-8 encoding
        payload.extend_from_slice(text.as_bytes());
        let mut frame = Vec::new();
        frame.extend_from_slice(frame_id);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&[0x00, 0x00]); // flags
        frame.extend_from_slice(&payload);
        frame
    }

    fn build_id3v23_apic_frame(mime: &str, pic_type: u8, image_bytes: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x00); // ISO-8859-1
        payload.extend_from_slice(mime.as_bytes());
        payload.push(0x00); // MIME null terminator
        payload.push(pic_type); // Picture type (0x03 = Cover front)
        payload.push(0x00); // Empty description null terminator
        payload.extend_from_slice(image_bytes);
        let mut frame = Vec::new();
        frame.extend_from_slice(b"APIC");
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&[0x00, 0x00]);
        frame.extend_from_slice(&payload);
        frame
    }

    /// MPEG-1 Layer III (128kbps, 44100Hz, padding=0, frame=417 bytes, 1152 samples ~= 26.122ms/frame)
    pub(crate) fn build_mpeg_frames(frame_count: usize) -> Vec<u8> {
        const FRAME_SIZE: usize = 417;
        let mut out = Vec::with_capacity(frame_count * FRAME_SIZE);
        for _ in 0..frame_count {
            let mut frame = vec![0u8; FRAME_SIZE];
            frame[0] = 0xFF;
            frame[1] = 0xFB; // MPEG-1, Layer III, no CRC
            frame[2] = 0x90; // 128 kbps (0x9), 44100 Hz (0x0), no padding
            frame[3] = 0x00; // Stereo
            out.extend_from_slice(&frame);
        }
        out
    }

    fn build_id3v23_lang_text_frame(frame_id: &[u8; 4], description: &str, text: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x03); // UTF-8 encoding
        payload.extend_from_slice(b"eng"); // ISO-639-2 language
        payload.extend_from_slice(description.as_bytes());
        payload.push(0x00); // null terminator for description
        payload.extend_from_slice(text.as_bytes());
        let mut frame = Vec::new();
        frame.extend_from_slice(frame_id);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&[0x00, 0x00]); // flags
        frame.extend_from_slice(&payload);
        frame
    }

    pub(crate) fn build_mp3_with_tags(
        title: &str,
        artist: &str,
        cover_png: &[u8],
        mpeg_frames: usize,
    ) -> Vec<u8> {
        build_mp3_with_extended_tags(title, artist, None, None, None, None, Some(cover_png), mpeg_frames)
    }

    pub(crate) fn build_mp3_with_extended_tags(
        title: &str,
        artist: &str,
        album: Option<&str>,
        lyrics: Option<&str>,
        comment: Option<&str>,
        year_and_ddmm: Option<(&str, &str)>,
        cover_png: Option<&[u8]>,
        mpeg_frames: usize,
    ) -> Vec<u8> {
        let mut frames = Vec::new();
        frames.extend_from_slice(&build_id3v23_text_frame(b"TIT2", title));
        frames.extend_from_slice(&build_id3v23_text_frame(b"TPE1", artist));
        if let Some(a) = album {
            frames.extend_from_slice(&build_id3v23_text_frame(b"TALB", a));
        }
        if let Some(l) = lyrics {
            frames.extend_from_slice(&build_id3v23_lang_text_frame(b"USLT", "", l));
        }
        if let Some(c) = comment {
            frames.extend_from_slice(&build_id3v23_lang_text_frame(b"COMM", "", c));
        }
        if let Some((year, ddmm)) = year_and_ddmm {
            frames.extend_from_slice(&build_id3v23_text_frame(b"TYER", year));
            if !ddmm.is_empty() {
                frames.extend_from_slice(&build_id3v23_text_frame(b"TDAT", ddmm));
            }
        }
        if let Some(cover) = cover_png {
            frames.extend_from_slice(&build_id3v23_apic_frame("image/png", 0x03, cover));
        }

        let mut mp3 = Vec::new();
        mp3.extend_from_slice(b"ID3");
        mp3.extend_from_slice(&[0x03, 0x00, 0x00]); // v2.3.0, flags=0
        mp3.extend_from_slice(&to_synchsafe(frames.len() as u32));
        mp3.extend_from_slice(&frames);
        mp3.extend_from_slice(&build_mpeg_frames(mpeg_frames));
        mp3
    }

    fn build_id3v24_frame(frame_id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(10 + payload.len());
        frame.extend_from_slice(frame_id);
        frame.extend_from_slice(&to_synchsafe(payload.len() as u32));
        frame.extend_from_slice(&[0x00, 0x00]); // flags
        frame.extend_from_slice(payload);
        frame
    }

    fn build_id3v24_text_frame(frame_id: &[u8; 4], text: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x03); // UTF-8
        payload.extend_from_slice(text.as_bytes());
        build_id3v24_frame(frame_id, &payload)
    }

    fn build_id3v24_txxx_frame(description: &str, content: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x03); // UTF-8
        payload.extend_from_slice(description.as_bytes());
        payload.push(0x00); // null terminator for description
        payload.extend_from_slice(content.as_bytes());
        build_id3v24_frame(b"TXXX", &payload)
    }

    fn build_id3v24_apic_frame(mime: &str, pic_type: u8, data: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(0x00); // Latin1 for mime + empty description
        payload.extend_from_slice(mime.as_bytes());
        payload.push(0x00);
        payload.push(pic_type);
        payload.push(0x00);
        payload.extend_from_slice(data);
        build_id3v24_frame(b"APIC", &payload)
    }

    /// FFmpeg 等が出力する ID3v2.4 + TDRC + TIT2/TPE1/TALB + TXXX(USLT) + TXXX(comment) + APIC 構成の MP3 を生成する
    pub(crate) fn build_id3v24_mp3_with_txxx_tags(
        recording_date: &str,
        title: &str,
        artist: &str,
        album: &str,
        txxx_uslt: &str,
        txxx_comment: &str,
        cover_png: &[u8],
        mpeg_frames: usize,
    ) -> Vec<u8> {
        let mut frames = Vec::new();
        frames.extend_from_slice(&build_id3v24_text_frame(b"TDRC", recording_date));
        frames.extend_from_slice(&build_id3v24_text_frame(b"TIT2", title));
        frames.extend_from_slice(&build_id3v24_text_frame(b"TPE1", artist));
        frames.extend_from_slice(&build_id3v24_text_frame(b"TALB", album));
        frames.extend_from_slice(&build_id3v24_txxx_frame("USLT", txxx_uslt));
        frames.extend_from_slice(&build_id3v24_txxx_frame("comment", txxx_comment));
        frames.extend_from_slice(&build_id3v24_text_frame(b"TSSE", "Lavf62.12.102"));
        frames.extend_from_slice(&build_id3v24_apic_frame("image/png", 0x03, cover_png));

        let mut mp3 = Vec::new();
        mp3.extend_from_slice(b"ID3");
        mp3.extend_from_slice(&[0x04, 0x00, 0x00]); // v2.4.0, flags=0
        mp3.extend_from_slice(&to_synchsafe(frames.len() as u32));
        mp3.extend_from_slice(&frames);
        mp3.extend_from_slice(&build_mpeg_frames(mpeg_frames));
        mp3
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::*;
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_audio_extension_and_content_type() {
        assert!(is_audio_extension("mp3"));
        assert!(!is_audio_extension("mp4"));
        assert!(!is_audio_extension("wav"));
        assert!(!is_audio_extension("flac"));
        assert!(is_audio_path("C:\\music\\Track01.MP3"));
        assert!(is_audio_path("/home/user/song.mp3"));
        assert!(!is_audio_path("C:\\music\\clip.mp4"));
        assert_eq!(audio_content_type("mp3"), "audio/mpeg");
    }

    #[test]
    fn test_parse_mp3_with_tags_cover_and_duration() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("tagged_track.mp3");
        // 40 frames * ~26.122ms ≈ 1.045 seconds
        let bytes = build_mp3_with_tags("Test Song Title", "Test Artist Name", SAMPLE_PNG_1X1, 40);
        fs::write(&file_path, &bytes).unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let meta = parse_audio_metadata(&path_str);

        assert!(meta.has_tags, "タグ付きMP3は has_tags=true になること");
        assert_eq!(meta.title.as_deref(), Some("Test Song Title"));
        assert_eq!(meta.artist.as_deref(), Some("Test Artist Name"));
        assert!(meta.album.is_none());
        assert!(meta.lyrics.is_none());
        assert!(meta.comment.is_none());
        assert!(meta.recording_date.is_none());
        assert_eq!(meta.cover_bytes.as_deref(), Some(SAMPLE_PNG_1X1));

        let dur = meta.duration_secs.expect("再生時間が取得できること");
        assert!(dur > 0.8 && dur < 1.5, "再生時間がおおよそ1秒前後であること: {}", dur);

        // extract_audio_cover 単独呼び出しでも同じカバー画像が得られること
        let cover_only = extract_audio_cover(&path_str);
        assert_eq!(cover_only.as_deref(), Some(SAMPLE_PNG_1X1));
    }

    #[test]
    fn test_parse_mp3_extended_tags_album_lyrics_comment_and_recording_date() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("extended_tags.mp3");
        // ID3v2.3 TYER ("2026") + TDAT ("0511" -> 11月05日 -> lofty TDRC "2026-11-05")
        let bytes = build_mp3_with_extended_tags(
            "Night Drive",
            "Synth Quartet",
            Some("Midnight Sessions"),
            Some("Line 1\nLine 2"),
            Some("Recorded live in studio"),
            Some(("2026", "0511")),
            None,
            20,
        );
        fs::write(&file_path, &bytes).unwrap();

        let meta = parse_audio_metadata(&file_path.to_string_lossy());
        assert!(meta.has_tags);
        assert_eq!(meta.album.as_deref(), Some("Midnight Sessions"));
        assert_eq!(meta.lyrics.as_deref(), Some("Line 1\nLine 2"));
        assert_eq!(meta.comment.as_deref(), Some("Recorded live in studio"));
        assert_eq!(meta.recording_date.as_deref(), Some("2026-11-05"));
    }

    #[test]
    fn test_parse_ffmpeg_id3v24_txxx_uslt_and_comment() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("ffmpeg_v24_txxx.mp3");
        let bytes = build_id3v24_mp3_with_txxx_tags(
            "2026-11-14T15:46:20",
            "自己紹介",
            "赤城",
            "全員挨拶セット",
            "歌詞テキスト本文",
            "コメントテキスト本文",
            SAMPLE_PNG_1X1,
            30,
        );
        fs::write(&file_path, &bytes).unwrap();

        let meta = parse_audio_metadata(&file_path.to_string_lossy());
        assert!(meta.has_tags);
        assert_eq!(meta.recording_date.as_deref(), Some("2026-11-14T15:46:20"));
        assert_eq!(meta.title.as_deref(), Some("自己紹介"));
        assert_eq!(meta.artist.as_deref(), Some("赤城"));
        assert_eq!(meta.album.as_deref(), Some("全員挨拶セット"));
        assert_eq!(meta.lyrics.as_deref(), Some("歌詞テキスト本文"));
        assert_eq!(meta.comment.as_deref(), Some("コメントテキスト本文"));
        assert_eq!(meta.cover_bytes.as_deref(), Some(SAMPLE_PNG_1X1));
        assert!(meta.duration_secs.unwrap_or(0.0) > 0.3);
    }

    #[test]
    fn test_parse_tagless_mp3_returns_no_tags_with_duration() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("tagless.mp3");
        let bytes = build_mpeg_frames(50);
        fs::write(&file_path, &bytes).unwrap();

        let meta = parse_audio_metadata(&file_path.to_string_lossy());
        assert!(!meta.has_tags);
        assert!(meta.title.is_none());
        assert!(meta.artist.is_none());
        assert!(meta.cover_bytes.is_none());
        assert!(meta.duration_secs.unwrap_or(0.0) > 0.5);
    }

    #[test]
    fn test_parse_truncated_or_corrupted_mp3_does_not_panic() {
        let dir = tempdir().unwrap();

        // 1. ヘッダ途中で切断された ID3v2
        let truncated_id3 = dir.path().join("truncated_id3.mp3");
        fs::write(&truncated_id3, b"ID3\x03\x00\x00\x00\x00\x10\x00TIT2\x00\x00").unwrap();
        let m1 = parse_audio_metadata(&truncated_id3.to_string_lossy());
        assert!(m1.title.is_none());

        // 2. ランダム/破損データ
        let corrupt = dir.path().join("corrupt.mp3");
        fs::write(&corrupt, b"NOT_AN_MP3_FILE_0123456789").unwrap();
        let m2 = parse_audio_metadata(&corrupt.to_string_lossy());
        assert!(!m2.has_tags);
        assert!(m2.cover_bytes.is_none());

        // 3. 空ファイル
        let empty = dir.path().join("empty.mp3");
        fs::write(&empty, &[]).unwrap();
        let m3 = parse_audio_metadata(&empty.to_string_lossy());
        assert!(!m3.has_tags);
    }

    #[test]
    fn test_format_duration_strings() {
        assert_eq!(format_duration(0.0), "0:00");
        assert_eq!(format_duration(9.2), "0:09");
        assert_eq!(format_duration(125.4), "2:05");
        assert_eq!(format_duration(3661.0), "1:01:01");
    }
}
