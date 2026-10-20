//! `artwork://` 向けの縮小サムネイル + ディスクキャッシュ。
//!
//! `artwork://localhost/<percent-encoded path>?s=<px>` の `s` を固定の段階 ([`BUCKETS`])
//! に切り上げ、`<app_cache_dir>/artwork-thumbs/` に縮小済み画像を保存して再利用する。
//! 一覧の小さいタイルに数 MB / 3000px の原本を渡して WebView にデコードさせないため。
//!
//! - キャッシュキーは (パス, ファイルの mtime, ファイルサイズ, 段階) のハッシュ。
//!   カバー差し替え等でファイルが書き換わればキーが変わり、自動的に読み直す。
//! - 書き込みは一時ファイル + rename でアトミックに行う (読み手が半端なファイルを見ない)。
//! - 埋め込み画像の抽出・デコード・エンコードはセマフォで同時実行数を絞る
//!   (グリッドを高速スクロールしたときの CPU / メモリのスパイク対策)。
//!   キャッシュヒットはセマフォを待たずに返す。
//! - 「カバー無し」は (パス, mtime, サイズ) でメモリに覚え、スクロールのたびに
//!   ファイルを開き直さない (上限付き)。
//! - `s` 無しの要求は従来どおり原本をそのまま返す (後方互換)。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use super::ThumbFormat;

/// サムネイルの段階 (px, 最大辺)。フロント (`src/components/Cover.tsx`) と揃える。
/// 段階を固定してキャッシュの種類数を抑える。最大段階を超える要求は原本を返す。
pub const BUCKETS: [u32; 5] = [64, 128, 256, 512, 1024];

/// キャッシュディレクトリ名 (`<app_cache_dir>/artwork-thumbs`)。
pub const CACHE_DIR_NAME: &str = "artwork-thumbs";

/// キャッシュ形式のバージョン。エンコード方式や品質を変えたら上げる (旧エントリは使われなくなる)。
const CACHE_VERSION: u32 = 1;

/// JPEG の品質。サムネイル用途なので原本より軽さを優先する。
const JPEG_QUALITY: u8 = 85;

/// 「カバー無し」負キャッシュの上限件数。超えたら丸ごと捨てる (単純さ優先)。
const NO_ART_CAP: usize = 4096;

/// 要求サイズ (px) を段階に切り上げる。0 / 最大段階超えは `None` (= 原本)。
pub fn snap_bucket(requested: u32) -> Option<u32> {
    if requested == 0 {
        return None;
    }
    BUCKETS.iter().copied().find(|&b| b >= requested)
}

/// URI のクエリ文字列から `s=<px>` を取り出して段階に丸める。無い / 不正なら `None`。
/// (`v=<epoch>` 等のキャッシュバスト用パラメータとは共存する。)
pub fn parse_size_query(query: Option<&str>) -> Option<u32> {
    let s = query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("s="))?
        .parse::<u32>()
        .ok()?;
    snap_bucket(s)
}

/// ファイルの同一性 (mtime + サイズ)。書き換えられたら変わる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    mtime_ns: u128,
    len: u64,
}

impl FileStamp {
    /// ファイルを stat して取得する。存在しない / 読めない場合は `None`。
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() {
            return None;
        }
        // mtime が取れない FS では 0 扱い (サイズだけで判定)。
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Some(Self {
            mtime_ns,
            len: meta.len(),
        })
    }
}

/// (パス, mtime, サイズ, 段階) からキャッシュキー (sha256 の hex) を作る。
pub fn cache_key(path: &str, stamp: FileStamp, bucket: u32) -> String {
    let mut h = Sha256::new();
    h.update(
        format!(
            "v{CACHE_VERSION}\0{path}\0{}\0{}\0{bucket}",
            stamp.mtime_ns, stamp.len
        )
        .as_bytes(),
    );
    h.finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// キーに対応するキャッシュファイルのパス。1 ディレクトリにファイルが集中しないよう
/// 先頭 2 文字でシャードする (`<dir>/ab/abcdef….img`)。
pub fn cache_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(&key[..2]).join(format!("{key}.img"))
}

/// キャッシュファイルの中身から MIME を判定する (保存形式は JPEG か webp のみ)。
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// 原本画像を段階 `bucket` 以下に縮小してエンコードする。
/// 写真が大半なので通常は JPEG (lossy で軽い)。アルファ付き画像だけは透過を保つため
/// webp ロスレスにする (image 0.25 の webp エンコーダはロスレスのみ)。
pub fn make_thumb(original: &[u8], bucket: u32) -> Option<(Vec<u8>, &'static str)> {
    let img = super::shrink_to(super::decode_image(original)?, bucket);
    let fmt = if img.color().has_alpha() {
        ThumbFormat::WebpLossless
    } else {
        ThumbFormat::Jpeg(JPEG_QUALITY)
    };
    super::encode_image(&img, fmt)
}

/// 一時ファイルに書いてから rename でアトミックに置き換える。
fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target
        .parent()
        .ok_or_else(|| std::io::Error::other("cache path has no parent"))?;
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

// ===== 「カバー無し」の負キャッシュ =====

fn no_art_map() -> &'static Mutex<HashMap<String, FileStamp>> {
    static MAP: OnceLock<Mutex<HashMap<String, FileStamp>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_known_no_art(path: &str, stamp: FileStamp) -> bool {
    no_art_map()
        .lock()
        .map(|m| m.get(path) == Some(&stamp))
        .unwrap_or(false)
}

fn remember_no_art(path: &str, stamp: FileStamp) {
    if let Ok(mut m) = no_art_map().lock() {
        if m.len() >= NO_ART_CAP && !m.contains_key(path) {
            m.clear();
        }
        m.insert(path.to_string(), stamp);
    }
}

// ===== 1 リクエストの処理 =====

/// セマフォ外で行う軽い前段 (stat + 負キャッシュ + ディスクキャッシュ参照) の結果。
#[derive(Debug)]
enum Lookup {
    /// ディスクキャッシュにあった。
    Hit(Vec<u8>, &'static str),
    /// ファイルが無い / カバー無しと分かっている。
    NoArt,
    /// 抽出 (+ 縮小) が必要。
    Miss(FileStamp),
}

fn lookup(path: &str, bucket: Option<u32>, cache_dir: Option<&Path>) -> Lookup {
    let Some(stamp) = FileStamp::of(Path::new(path)) else {
        return Lookup::NoArt;
    };
    if is_known_no_art(path, stamp) {
        return Lookup::NoArt;
    }
    if let (Some(bucket), Some(dir)) = (bucket, cache_dir) {
        let file = cache_file(dir, &cache_key(path, stamp, bucket));
        if let Ok(bytes) = std::fs::read(&file) {
            if let Some(mime) = sniff_mime(&bytes) {
                return Lookup::Hit(bytes, mime);
            }
        }
    }
    Lookup::Miss(stamp)
}

/// 埋め込み画像を取り出し、`bucket` 指定があれば縮小してキャッシュに書く。
/// 縮小に失敗した (壊れた画像等) 場合は原本を返す (落とさない)。
fn produce(
    path: &str,
    stamp: FileStamp,
    bucket: Option<u32>,
    cache_dir: Option<&Path>,
) -> Option<(Vec<u8>, String)> {
    let Some((original, mime)) = super::extract_picture(path) else {
        remember_no_art(path, stamp);
        return None;
    };
    let Some(bucket) = bucket else {
        return Some((original, mime));
    };
    match make_thumb(&original, bucket) {
        Some((thumb, thumb_mime)) => {
            if let Some(dir) = cache_dir {
                let file = cache_file(dir, &cache_key(path, stamp, bucket));
                if let Err(e) = write_atomic(&file, &thumb) {
                    // キャッシュはベストエフォート (書けなくても配信は続ける)。
                    eprintln!("artwork thumb cache write failed: {e}");
                }
            }
            Some((thumb, thumb_mime.to_string()))
        }
        None => Some((original, mime)),
    }
}

/// 重い処理 (抽出・デコード・エンコード) の同時実行数を絞るセマフォ。
/// 論理 CPU 数の半分 (2〜4) にして、再生やUIのスレッドを圧迫しないようにする。
fn heavy_permits() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map(|n| n.get() / 2)
            .unwrap_or(2)
            .clamp(2, 4);
        tokio::sync::Semaphore::new(n)
    })
}

/// `artwork://` の 1 リクエストを処理して `(バイト列, MIME)` を返す。カバー無しは `None`。
/// - `bucket` が `None` なら原本 (後方互換)。
/// - `cache_dir` が `None` (キャッシュ dir を解決できない) ならキャッシュせず毎回縮小する。
///
/// ブロッキング I/O は `spawn_blocking` に逃がし、重い処理だけセマフォで絞る。
pub async fn load(
    path: String,
    bucket: Option<u32>,
    cache_dir: Option<PathBuf>,
) -> Option<(Vec<u8>, String)> {
    let (p, d) = (path.clone(), cache_dir.clone());
    let fast = tauri::async_runtime::spawn_blocking(move || lookup(&p, bucket, d.as_deref()))
        .await
        .ok()?;
    let stamp = match fast {
        Lookup::Hit(bytes, mime) => return Some((bytes, mime.to_string())),
        Lookup::NoArt => return None,
        Lookup::Miss(stamp) => stamp,
    };
    let _permit = heavy_permits().acquire().await.ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        produce(&path, stamp, bucket, cache_dir.as_deref())
    })
    .await
    .ok()?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(mtime_ns: u128, len: u64) -> FileStamp {
        FileStamp { mtime_ns, len }
    }

    #[test]
    fn snap_bucket_rounds_up_to_fixed_steps() {
        assert_eq!(snap_bucket(0), None);
        assert_eq!(snap_bucket(1), Some(64));
        assert_eq!(snap_bucket(64), Some(64));
        assert_eq!(snap_bucket(65), Some(128));
        assert_eq!(snap_bucket(200), Some(256));
        assert_eq!(snap_bucket(512), Some(512));
        assert_eq!(snap_bucket(1024), Some(1024));
        // 最大段階を超えたら原本。
        assert_eq!(snap_bucket(1025), None);
        assert_eq!(snap_bucket(u32::MAX), None);
    }

    #[test]
    fn parse_size_query_reads_s_and_ignores_others() {
        assert_eq!(parse_size_query(None), None);
        assert_eq!(parse_size_query(Some("")), None);
        assert_eq!(parse_size_query(Some("v=3")), None);
        assert_eq!(parse_size_query(Some("s=100")), Some(128));
        assert_eq!(parse_size_query(Some("v=3&s=48")), Some(64));
        assert_eq!(parse_size_query(Some("s=abc&v=1")), None);
        assert_eq!(parse_size_query(Some("s=-1")), None);
        assert_eq!(parse_size_query(Some("s=4096")), None);
        // `ss=` のような別名には反応しない。
        assert_eq!(parse_size_query(Some("ss=64")), None);
    }

    #[test]
    fn cache_key_changes_with_file_and_bucket() {
        let base = cache_key("/music/a.flac", stamp(1, 100), 128);
        assert_eq!(base.len(), 64);
        assert_eq!(base, cache_key("/music/a.flac", stamp(1, 100), 128));
        assert_ne!(base, cache_key("/music/b.flac", stamp(1, 100), 128));
        assert_ne!(base, cache_key("/music/a.flac", stamp(2, 100), 128));
        assert_ne!(base, cache_key("/music/a.flac", stamp(1, 101), 128));
        assert_ne!(base, cache_key("/music/a.flac", stamp(1, 100), 256));
    }

    #[test]
    fn cache_file_is_sharded_by_key_prefix() {
        let key = cache_key("/x.mp3", stamp(0, 0), 64);
        let p = cache_file(Path::new("/c"), &key);
        assert_eq!(
            p,
            Path::new("/c").join(&key[..2]).join(format!("{key}.img"))
        );
    }

    fn png_bytes(img: image::DynamicImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn make_thumb_shrinks_opaque_image_to_jpeg() {
        let src = png_bytes(image::DynamicImage::new_rgb8(1000, 500));
        let (bytes, mime) = make_thumb(&src, 256).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(sniff_mime(&bytes), Some("image/jpeg"));
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (256, 128));
    }

    #[test]
    fn make_thumb_keeps_alpha_as_webp_and_never_upscales() {
        let src = png_bytes(image::DynamicImage::new_rgba8(40, 30));
        let (bytes, mime) = make_thumb(&src, 512).unwrap();
        assert_eq!(mime, "image/webp");
        assert_eq!(sniff_mime(&bytes), Some("image/webp"));
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (40, 30));
    }

    #[test]
    fn make_thumb_rejects_garbage() {
        assert!(make_thumb(b"not an image", 128).is_none());
    }

    #[test]
    fn write_atomic_then_lookup_hits_cache() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        std::fs::write(&audio, b"dummy").unwrap();
        let audio_s = audio.to_string_lossy().into_owned();
        let cache = dir.path().join(CACHE_DIR_NAME);

        // キャッシュが空なら Miss。
        let st = match lookup(&audio_s, Some(64), Some(&cache)) {
            Lookup::Miss(st) => st,
            other => panic!("expected Miss, got {other:?}"),
        };
        let (thumb, _) =
            make_thumb(&png_bytes(image::DynamicImage::new_rgb8(300, 300)), 64).unwrap();
        write_atomic(&cache_file(&cache, &cache_key(&audio_s, st, 64)), &thumb).unwrap();

        match lookup(&audio_s, Some(64), Some(&cache)) {
            Lookup::Hit(bytes, mime) => {
                assert_eq!(bytes, thumb);
                assert_eq!(mime, "image/jpeg");
            }
            other => panic!("expected Hit, got {other:?}"),
        }
        // 別段階 / 段階なし (原本) はヒットしない。
        assert!(matches!(
            lookup(&audio_s, Some(128), Some(&cache)),
            Lookup::Miss(_)
        ));
        assert!(matches!(
            lookup(&audio_s, None, Some(&cache)),
            Lookup::Miss(_)
        ));
        // ファイルが無ければ NoArt。
        assert!(matches!(
            lookup(
                &dir.path().join("missing.mp3").to_string_lossy(),
                Some(64),
                Some(&cache)
            ),
            Lookup::NoArt
        ));
    }

    #[test]
    fn no_art_is_remembered_per_stamp() {
        let dir = tempfile::tempdir().unwrap();
        // タグも画像も無いファイル: extract_picture が None を返す。
        let audio = dir.path().join("noart.mp3");
        std::fs::write(&audio, b"not really audio").unwrap();
        let audio_s = audio.to_string_lossy().into_owned();
        let st = FileStamp::of(&audio).unwrap();

        assert!(produce(&audio_s, st, Some(64), None).is_none());
        assert!(matches!(lookup(&audio_s, Some(64), None), Lookup::NoArt));
        // スタンプが変われば (= ファイルが書き換わった) 負キャッシュは効かない。
        assert!(!is_known_no_art(&audio_s, stamp(st.mtime_ns + 1, st.len)));
    }
}
