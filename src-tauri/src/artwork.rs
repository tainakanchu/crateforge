//! 音声ファイルに埋め込まれたジャケット画像 (embedded picture) を取り出す。
//!
//! iTunes XML はアートワークを含まないため、トラックの実ファイルに埋め込まれた
//! 先頭の picture を読む。`artwork://localhost/<percent-encoded path>` のカスタム
//! URI スキーム経由でフロントの `<img>` から遅延ロードされる (lib.rs で登録)。
//! `?s=<px>` 付きの要求は [`thumb`] が縮小済みサムネイルをディスクキャッシュして返す。
//!
//! 縮小 + 再エンコード ([`resize_encode`] ほか) はデスクトップの `artwork://` と
//! 内蔵 API (`GET /api/tracks/{id}/artwork?size=`、モバイルのサムネ) で共有する。

pub mod thumb;

use image::DynamicImage;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::Tag;

/// 指定ファイルの先頭埋め込み画像を `(バイト列, MIME)` で返す。無ければ `None`。
pub fn extract_picture(path: &str) -> Option<(Vec<u8>, String)> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    // CoverFront を優先（複数枚や型ゆらぎに強くする）。無ければ先頭。
    let pic = tag
        .pictures()
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some((pic.data().to_vec(), mime))
}

/// 縮小後の出力フォーマット。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbFormat {
    /// webp (image-webp による VP8L ロスレス, C ライブラリ不要)。アルファを保持できる。
    /// image 0.25 の webp エンコーダはロスレスのみ。
    WebpLossless,
    /// JPEG (引数は品質 1..=100)。アルファは捨てて RGB8 に落とす。
    Jpeg(u8),
}

/// 画像バイト列をデコードする (形式はマジックバイトから推定)。失敗時は `None`。
pub fn decode_image(bytes: &[u8]) -> Option<DynamicImage> {
    image::load_from_memory(bytes).ok()
}

/// アスペクト比を維持して最大辺 ≤ edge に縮小する。元画像の方が小さければ拡大せずそのまま返す。
pub fn shrink_to(img: DynamicImage, edge: u32) -> DynamicImage {
    let edge = edge.max(1);
    if img.width().max(img.height()) > edge {
        img.thumbnail(edge, edge)
    } else {
        img
    }
}

/// 画像を指定フォーマットでエンコードして `(バイト列, MIME)` を返す。失敗時は `None`。
pub fn encode_image(img: &DynamicImage, format: ThumbFormat) -> Option<(Vec<u8>, &'static str)> {
    let mut out = std::io::Cursor::new(Vec::new());
    match format {
        ThumbFormat::Jpeg(quality) => {
            // JPEG はアルファ / 16bit 非対応なので、RGB8 / L8 以外は RGB8 に揃えてから渡す。
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
            match img {
                DynamicImage::ImageRgb8(_) | DynamicImage::ImageLuma8(_) => {
                    img.write_with_encoder(encoder).ok()?
                }
                _ => DynamicImage::ImageRgb8(img.to_rgb8())
                    .write_with_encoder(encoder)
                    .ok()?,
            }
            Some((out.into_inner(), "image/jpeg"))
        }
        ThumbFormat::WebpLossless => {
            // write_to が ImageFormat::WebP に対し WebPEncoder::new_lossless を選び、
            // 必要な色変換 (Rgb8/Rgba8 へ) も自動で行う。
            img.write_to(&mut out, image::ImageFormat::WebP).ok()?;
            Some((out.into_inner(), "image/webp"))
        }
    }
}

/// 原本バイトをデコード → 最大辺 ≤ edge に縮小 → 指定フォーマットで再エンコードする。
/// デコード/エンコードに失敗したら `None` (呼び出し側で原本へフォールバックする想定)。
pub fn resize_encode(
    bytes: &[u8],
    edge: u32,
    format: ThumbFormat,
) -> Option<(Vec<u8>, &'static str)> {
    let img = shrink_to(decode_image(bytes)?, edge);
    encode_image(&img, format)
}

/// 外から拾った画像 (zip 内のジャケットなど) を埋め込み用に整えたときの既定の最大辺 (px)。
pub const EMBED_MAX_EDGE: u32 = 1400;

/// 外から拾った画像を埋め込み用に整える: デコード → 最大辺 ≤ `edge` に縮小 (拡大はしない)
/// → エンコードして `(バイト列, 拡張子)` を返す。デコードできなければ `None`。
///
/// - アルファ付きの PNG は透過を保つため PNG のまま (縮小時は PNG で再エンコード)。
/// - それ以外は JPEG (品質 90)。ただし元が JPEG で縮小不要なら再圧縮による劣化を避けて原本を使う。
/// - 巨大な寸法の画像 (展開すると数 GB になるもの) は image の上限でデコードを拒否する。
pub fn prepare_for_embed(bytes: &[u8], edge: u32) -> Option<(Vec<u8>, &'static str)> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    if !matches!(format, image::ImageFormat::Jpeg | image::ImageFormat::Png) {
        return None;
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let needs_shrink = img.width().max(img.height()) > edge.max(1);

    if format == image::ImageFormat::Png && img.color().has_alpha() {
        if !needs_shrink {
            return Some((bytes.to_vec(), "png"));
        }
        let mut out = std::io::Cursor::new(Vec::new());
        shrink_to(img, edge)
            .write_to(&mut out, image::ImageFormat::Png)
            .ok()?;
        return Some((out.into_inner(), "png"));
    }
    if format == image::ImageFormat::Jpeg && !needs_shrink {
        return Some((bytes.to_vec(), "jpg"));
    }
    let (data, _) = encode_image(&shrink_to(img, edge), ThumbFormat::Jpeg(90))?;
    Some((data, "jpg"))
}

/// 埋め込み用に画像を PNG/JPEG へ正規化して `(バイト列, MIME)` を返す。
/// - PNG / JPEG はそのまま（再エンコードしない）。
/// - それ以外（WebP/GIF/BMP 等）は decode して JPEG(品質90) に変換する。
///   埋め込みカバーは MP4(covr) 等が JPEG/PNG しか確実に表示できないため。
fn normalize_for_embed(data: Vec<u8>) -> Result<(Vec<u8>, MimeType), String> {
    // PNG マジック
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Ok((data, MimeType::Png));
    }
    // JPEG マジック (FF D8 FF)
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok((data, MimeType::Jpeg));
    }
    // それ以外は image でデコード → JPEG 再エンコード（JPEG はアルファ非対応なので RGB8 に落とす）。
    let img = image::ImageReader::new(std::io::Cursor::new(&data))
        .with_guessed_format()
        .map_err(|e| format!("image format guess failed: {e}"))?
        .decode()
        .map_err(|e| format!("image decode failed: {e}"))?;
    let rgb = img.to_rgb8();
    let mut out: Vec<u8> = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&rgb)
        .map_err(|e| format!("jpeg encode failed: {e}"))?;
    Ok((out, MimeType::Jpeg))
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

    let (data, mime) = normalize_for_embed(data)?;
    // 既存カバー（形式により CoverFront/Other 等まちまち）を取りこぼさないよう全削除してから追加。
    for i in (0..tag.pictures().len()).rev() {
        tag.remove_picture(i);
    }
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

/// 指定ファイルの埋め込みカバー(front)を削除する（新規画像は追加しない）。
/// カバーが無い場合は何もせず Ok（無駄な mtime 更新を避ける）。
pub fn remove_cover(path: &str) -> Result<(), String> {
    let mut tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;

    let Some(tag) = tagged.primary_tag_mut() else {
        return Ok(()); // タグ無し = カバー無し
    };

    // ピクチャが無ければ書き換えない（mtime を無駄に更新しない）。
    if tag.pictures().is_empty() {
        return Ok(());
    }
    // 形式による型ゆらぎに取りこぼさないよう全カバーを削除する。
    for i in (0..tag.pictures().len()).rev() {
        tag.remove_picture(i);
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("save artwork failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn png_bytes(img: DynamicImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb([200, 10, 10])));
        encode_image(&img, ThumbFormat::Jpeg(90)).unwrap().0
    }

    #[test]
    fn prepare_for_embed_downscales_large_images_to_jpeg() {
        let src = png_bytes(DynamicImage::ImageRgb8(RgbImage::from_pixel(
            3000,
            1500,
            Rgb([1, 2, 3]),
        )));
        let (out, ext) = prepare_for_embed(&src, EMBED_MAX_EDGE).unwrap();
        assert_eq!(ext, "jpg");
        let img = decode_image(&out).unwrap();
        assert_eq!((img.width(), img.height()), (1400, 700));
    }

    #[test]
    fn prepare_for_embed_never_upscales_and_keeps_small_jpeg_as_is() {
        let src = jpeg_bytes(300, 200);
        let (out, ext) = prepare_for_embed(&src, EMBED_MAX_EDGE).unwrap();
        assert_eq!(ext, "jpg");
        assert_eq!(out, src);

        let big = jpeg_bytes(2000, 2000);
        let (out, _) = prepare_for_embed(&big, EMBED_MAX_EDGE).unwrap();
        let img = decode_image(&out).unwrap();
        assert_eq!((img.width(), img.height()), (1400, 1400));
    }

    #[test]
    fn prepare_for_embed_keeps_png_with_alpha_as_png() {
        let src = png_bytes(DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            1600,
            800,
            Rgba([0, 0, 0, 10]),
        )));
        let (out, ext) = prepare_for_embed(&src, EMBED_MAX_EDGE).unwrap();
        assert_eq!(ext, "png");
        let img = decode_image(&out).unwrap();
        assert_eq!((img.width(), img.height()), (1400, 700));
        assert!(img.color().has_alpha());

        // アルファ無しの PNG は JPEG にする (小さくても)。
        let opaque = png_bytes(DynamicImage::ImageRgb8(RgbImage::from_pixel(
            10,
            10,
            Rgb([1, 2, 3]),
        )));
        assert_eq!(prepare_for_embed(&opaque, EMBED_MAX_EDGE).unwrap().1, "jpg");
    }

    #[test]
    fn prepare_for_embed_rejects_non_images() {
        assert!(prepare_for_embed(b"not an image", EMBED_MAX_EDGE).is_none());
    }
}
