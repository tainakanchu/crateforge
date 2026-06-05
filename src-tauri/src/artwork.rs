//! 音声ファイルに埋め込まれたジャケット画像 (embedded picture) を取り出す。
//!
//! iTunes XML はアートワークを含まないため、トラックの実ファイルに埋め込まれた
//! 先頭の picture を読む。`artwork://localhost/<percent-encoded path>` のカスタム
//! URI スキーム経由でフロントの `<img>` から遅延ロードされる (lib.rs で登録)。

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::Tag;

/// 指定ファイルの先頭埋め込み画像を `(バイト列, MIME)` で返す。無ければ `None`。
pub fn extract_picture(path: &str) -> Option<(Vec<u8>, String)> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some((pic.data().to_vec(), mime))
}

/// 画像バイト列のマジックから MIME を判定する (PNG / JPEG のみ。既定 JPEG)。
fn detect_mime(data: &[u8]) -> MimeType {
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        MimeType::Png
    } else {
        MimeType::Jpeg
    }
}

/// 指定ファイルのカバーアートを差し替える (既存の CoverFront を消して新規追加)。
pub fn set_picture(path: &str, data: Vec<u8>) -> Result<(), String> {
    if data.len() < 4 {
        return Err("Empty image data".to_string());
    }
    let mut tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;

    if tagged.primary_tag_mut().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("no primary tag")?;

    let mime = detect_mime(&data);
    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(Picture::new_unchecked(
        PictureType::CoverFront,
        Some(mime),
        None,
        data,
    ));

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("save artwork failed: {e}"))?;
    Ok(())
}
