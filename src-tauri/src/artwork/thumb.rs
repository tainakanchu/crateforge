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
//! - ディスク使用量は [`CACHE_CAP_BYTES`] を上限とし、超えたら mtime の古い順 (≒ LRU) に
//!   [`TRIM_TARGET_BYTES`] まで削る。ヒット時に mtime を (1 日に 1 回まで) 更新して
//!   「最近使った」を表す (atime は noatime/relatime で当てにならないため)。
//!   掃除は起動時に 1 回 + 書き込みで概算使用量が上限を超えたときにバックグラウンドで走る。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// ディスクキャッシュの容量上限 (バイト)。
pub const CACHE_CAP_BYTES: u64 = 256 * 1024 * 1024;

/// 上限超えで掃除するときの目標 (上限の 80%)。書き込みのたびに掃除が走らないよう余裕を残す。
pub const TRIM_TARGET_BYTES: u64 = CACHE_CAP_BYTES / 5 * 4;

/// ヒット時に mtime を更新する間隔。毎回書くと I/O が増えるので、これより古いときだけ更新する。
const TOUCH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// 書き込み途中で落ちた一時ファイル等 (`<64hex>.img` 以外) を消すまでの猶予。
/// 書き込み中のものを消さないよう十分長めに取る。
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

/// 起動時の掃除を始めるまでの待ち時間 (起動直後の I/O と競合させない)。
const STARTUP_TRIM_DELAY: Duration = Duration::from_secs(15);

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

// ===== 容量上限と LRU 掃除 =====

/// ディスクキャッシュの概算使用量と掃除の実行状態。
/// 使用量は掃除 (起動時のスキャン) で実測値に置き換え、以降は書き込み成功ごとに加算する。
/// 同一キーの重複書き込み等で多少ずれるが、次の掃除で実測値に戻るので概算で十分。
struct Budget {
    used: AtomicU64,
    trimming: AtomicBool,
    cap: u64,
    target: u64,
}

impl Budget {
    const fn new(cap: u64, target: u64) -> Self {
        Self {
            used: AtomicU64::new(0),
            trimming: AtomicBool::new(false),
            cap,
            target,
        }
    }

    /// 書き込んだバイト数を加算し、上限を超えたら `true`。
    fn add(&self, bytes: u64) -> bool {
        self.used
            .fetch_add(bytes, Ordering::Relaxed)
            .saturating_add(bytes)
            > self.cap
    }

    /// 掃除の実行権を取る (同時に 1 つだけ)。取れたらガードを返す。
    fn try_begin_trim(&self) -> Option<TrimGuard<'_>> {
        self.trimming
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| TrimGuard(self))
    }
}

/// 掃除の実行権。drop で解放する (途中で抜けても実行中フラグが残らないように)。
struct TrimGuard<'a>(&'a Budget);

impl Drop for TrimGuard<'_> {
    fn drop(&mut self) {
        self.0.trimming.store(false, Ordering::Release);
    }
}

static BUDGET: Budget = Budget::new(CACHE_CAP_BYTES, TRIM_TARGET_BYTES);

/// 掃除の結果。
#[derive(Debug, Default, PartialEq, Eq)]
struct TrimStats {
    /// 掃除後に残ったキャッシュの合計バイト数。
    remaining_bytes: u64,
    /// LRU で消したエントリ数 / バイト数。
    evicted_files: usize,
    evicted_bytes: u64,
    /// 消した古い一時ファイル (`<64hex>.img` 以外) の数。
    stale_temps: usize,
}

/// 正式なキャッシュエントリ名 (`<sha256 hex 64 桁>.img`) かどうか。
fn is_entry_name(name: &str) -> bool {
    name.strip_suffix(".img")
        .is_some_and(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// シャードディレクトリ名 (16 進 2 桁) かどうか。それ以外の場所には触らない。
fn is_shard_name(name: &str) -> bool {
    name.len() == 2 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `now - t` が `age` 以上か (時計が戻って未来の時刻になっているものは「新しい」扱い)。
fn older_than(t: SystemTime, now: SystemTime, age: Duration) -> bool {
    now.duration_since(t).is_ok_and(|d| d >= age)
}

/// ヒットしたエントリの mtime を「最近使った」印として更新する。
/// 毎回は書かず、[`TOUCH_INTERVAL`] より古いときだけ更新する。失敗は無視 (掃除の順序が多少ずれるだけ)。
fn touch_if_stale(file: &Path, now: SystemTime) {
    let stale = std::fs::metadata(file)
        .and_then(|m| m.modified())
        .is_ok_and(|t| older_than(t, now, TOUCH_INTERVAL));
    if stale {
        // Windows で set_modified には書き込み権限付きのハンドルが要る (truncate はしない)。
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(file) {
            let _ = f.set_modified(now);
        }
    }
}

/// キャッシュディレクトリを走査し、
/// 1) [`STALE_TEMP_AGE`] より古い一時ファイル等 (`<64hex>.img` 以外) を消す、
/// 2) 合計が `cap` を超えていれば mtime の古い順に `target` 以下まで消す、
/// 3) 空になったシャードディレクトリを消す。
///
/// I/O エラーは eprintln して続行する (panic しない)。
fn trim_dir(root: &Path, cap: u64, target: u64, now: SystemTime) -> TrimStats {
    let mut stats = TrimStats::default();
    let shards = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("artwork thumb cache scan failed: {e}");
            }
            return stats;
        }
    };

    // (mtime, size, path)
    let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    let mut shard_dirs: Vec<PathBuf> = Vec::new();
    for shard in shards.flatten() {
        let is_shard = shard.file_type().is_ok_and(|t| t.is_dir())
            && shard.file_name().to_str().is_some_and(is_shard_name);
        if !is_shard {
            continue;
        }
        let shard_path = shard.path();
        let files = match std::fs::read_dir(&shard_path) {
            Ok(rd) => rd,
            Err(e) => {
                eprintln!("artwork thumb cache scan failed: {e}");
                continue;
            }
        };
        for f in files.flatten() {
            let Ok(meta) = f.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            let path = f.path();
            if f.file_name().to_str().is_some_and(is_entry_name) {
                entries.push((mtime, meta.len(), path));
            } else if older_than(mtime, now, STALE_TEMP_AGE) {
                // クラッシュ等で残った一時ファイル。書き込み中の可能性がある新しいものは残す。
                match std::fs::remove_file(&path) {
                    Ok(()) => stats.stale_temps += 1,
                    Err(e) => eprintln!("artwork thumb cache: remove temp failed: {e}"),
                }
            }
        }
        shard_dirs.push(shard_path);
    }

    let mut total: u64 = entries.iter().map(|(_, len, _)| *len).sum();
    if total > cap {
        entries.sort_by_key(|(mtime, _, _)| *mtime);
        for (_, len, path) in &entries {
            if total <= target {
                break;
            }
            match std::fs::remove_file(path) {
                Ok(()) => {
                    total -= len;
                    stats.evicted_files += 1;
                    stats.evicted_bytes += len;
                }
                // 並行して消えた場合も「無くなった」ので減算する。
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => total -= len,
                Err(e) => eprintln!("artwork thumb cache: evict failed: {e}"),
            }
        }
    }

    // 空のシャードだけ消える (中身があれば remove_dir が失敗するので無視してよい)。
    for dir in shard_dirs {
        let _ = std::fs::remove_dir(dir);
    }

    stats.remaining_bytes = total;
    stats
}

/// 実行権が取れたら掃除する。取れなければ (実行中) `None`。
#[cfg(test)]
fn run_trim(budget: &Budget, root: &Path, now: SystemTime) -> Option<TrimStats> {
    let guard = budget.try_begin_trim()?;
    Some(trim_locked(&guard, root, now))
}

/// 実行権を持った状態で掃除し、概算使用量を実測値に置き換える。
fn trim_locked(guard: &TrimGuard<'_>, root: &Path, now: SystemTime) -> TrimStats {
    let budget = guard.0;
    let stats = trim_dir(root, budget.cap, budget.target, now);
    budget.used.store(stats.remaining_bytes, Ordering::Relaxed);
    if stats.evicted_files > 0 || stats.stale_temps > 0 {
        eprintln!(
            "artwork thumb cache trimmed: evicted {} files ({} bytes), {} stale temps, {} bytes remain",
            stats.evicted_files, stats.evicted_bytes, stats.stale_temps, stats.remaining_bytes
        );
    }
    stats
}

/// バックグラウンドスレッドで掃除する。既に実行中なら何もしない。
/// 実行権はスレッドを立てる前に取る (上限超えの書き込みが続いてもスレッドは 1 本だけ)。
fn spawn_trim(budget: &'static Budget, root: PathBuf, delay: Duration) {
    let Some(guard) = budget.try_begin_trim() else {
        return;
    };
    // spawn に失敗した場合はクロージャごと guard が drop され、実行権は解放される。
    let spawned = std::thread::Builder::new()
        .name("artwork-thumb-trim".into())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            trim_locked(&guard, &root, SystemTime::now());
        });
    if let Err(e) = spawned {
        eprintln!("artwork thumb cache: failed to spawn trim thread: {e}");
    }
}

/// 起動時の掃除をバックグラウンドで始める (setup から呼ぶ。起動はブロックしない)。
/// 少し待ってから走査し、概算使用量を実測値で初期化する。
pub fn spawn_startup_trim(cache_dir: PathBuf) {
    spawn_trim(&BUDGET, cache_dir, STARTUP_TRIM_DELAY);
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
                touch_if_stale(&file, SystemTime::now());
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
                match write_atomic(&file, &thumb) {
                    Ok(()) => {
                        // 概算使用量が上限を超えたらバックグラウンドで掃除する。
                        if BUDGET.add(thumb.len() as u64) {
                            spawn_trim(&BUDGET, dir.to_path_buf(), Duration::ZERO);
                        }
                    }
                    // キャッシュはベストエフォート (書けなくても配信は続ける)。
                    Err(e) => eprintln!("artwork thumb cache write failed: {e}"),
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

    // ===== 容量上限と LRU 掃除 =====

    const HOUR: Duration = Duration::from_secs(60 * 60);

    /// `<root>/<shard>/<name>` に `len` バイト書き、mtime を `mtime` にする。
    fn put(root: &Path, name: &str, len: usize, mtime: SystemTime) -> PathBuf {
        let p = if is_entry_name(name) {
            cache_file(root, name.strip_suffix(".img").unwrap())
        } else {
            root.join("ab").join(name)
        };
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![0u8; len]).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        p
    }

    /// i 番目のダミーキー (64 桁 hex) のエントリ名。シャードが散るよう先頭も変える。
    fn entry(i: u8) -> String {
        format!("{:02x}{}.img", i, "0".repeat(62))
    }

    #[test]
    fn entry_and_shard_names() {
        assert!(is_entry_name(&entry(1)));
        assert!(is_entry_name(&format!(
            "{}.img",
            cache_key("/a", stamp(0, 0), 64)
        )));
        assert!(!is_entry_name("abc.img"));
        assert!(!is_entry_name(&format!("{}.tmp", "0".repeat(64))));
        assert!(!is_entry_name(".tmpXYZ123"));
        assert!(is_shard_name("0f"));
        assert!(!is_shard_name("0g"));
        assert!(!is_shard_name("abc"));
    }

    #[test]
    fn trim_evicts_oldest_first_down_to_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = SystemTime::now();
        // 古い順に 0..5、各 100 バイト = 合計 500。
        let paths: Vec<PathBuf> = (0..5u8)
            .map(|i| put(root, &entry(i), 100, now - HOUR * (10 - u32::from(i))))
            .collect();

        // 上限 450 を超えている → 目標 250 以下まで古い順に消す (3 件消えて 200 残る)。
        let stats = trim_dir(root, 450, 250, now);
        assert_eq!(stats.evicted_files, 3);
        assert_eq!(stats.evicted_bytes, 300);
        assert_eq!(stats.remaining_bytes, 200);
        for p in &paths[..3] {
            assert!(!p.exists(), "古いエントリは消える: {p:?}");
        }
        for p in &paths[3..] {
            assert!(p.exists(), "新しいエントリは残る: {p:?}");
        }
        // 空になったシャードは消え、残りのシャードは残る。
        assert!(!paths[0].parent().unwrap().exists());
        assert!(paths[4].parent().unwrap().exists());
    }

    #[test]
    fn trim_under_cap_keeps_entries_but_reports_total() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        put(dir.path(), &entry(1), 100, now);
        put(dir.path(), &entry(2), 100, now);
        // 上限ちょうどは超えていないので消さない (ヒステリシス)。
        let stats = trim_dir(dir.path(), 200, 100, now);
        assert_eq!(stats.evicted_files, 0);
        assert_eq!(stats.remaining_bytes, 200);
    }

    #[test]
    fn trim_removes_only_stale_temp_files_and_does_not_count_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = SystemTime::now();
        let keep = put(root, &entry(0xab), 100, now);
        let stale = put(root, ".tmpOLD123", 5000, now - HOUR * 2);
        let fresh = put(root, ".tmpNEW456", 5000, now);
        // シャード外 (ルート直下) のファイルには触らない。
        let outside = root.join("README");
        std::fs::write(&outside, b"x").unwrap();

        let stats = trim_dir(root, 1000, 800, now);
        assert_eq!(stats.stale_temps, 1);
        assert_eq!(stats.evicted_files, 0);
        // 一時ファイルは合計に含めない。
        assert_eq!(stats.remaining_bytes, 100);
        assert!(keep.exists());
        assert!(!stale.exists());
        assert!(
            fresh.exists(),
            "書き込み中かもしれない新しい一時ファイルは残す"
        );
        assert!(outside.exists());
    }

    #[test]
    fn trim_missing_dir_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let stats = trim_dir(&dir.path().join("nope"), 10, 5, SystemTime::now());
        assert_eq!(stats, TrimStats::default());
    }

    #[test]
    fn budget_counts_writes_and_allows_one_trim_at_a_time() {
        let b = Budget::new(100, 80);
        assert!(!b.add(60));
        assert!(!b.add(40)); // ちょうど上限は超えていない
        assert!(b.add(1));

        let g = b.try_begin_trim().expect("最初の掃除は実行権を取れる");
        assert!(b.try_begin_trim().is_none(), "実行中は 2 本目を走らせない");
        drop(g);
        assert!(b.try_begin_trim().is_some(), "終われば再び取れる");
    }

    #[test]
    fn run_trim_resets_counter_to_measured_size() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        for i in 0..4u8 {
            put(dir.path(), &entry(i), 100, now - HOUR * (5 - u32::from(i)));
        }
        let b = Budget::new(300, 200);
        // 書き込みの概算が実際とずれていても、掃除後は実測値になる。
        b.add(10_000);
        let stats = run_trim(&b, dir.path(), now).unwrap();
        assert_eq!(stats.remaining_bytes, 200);
        assert_eq!(b.used.load(Ordering::Relaxed), 200);
        assert!(!b.trimming.load(Ordering::Relaxed));
        // 実行中なら走らない。
        let _g = b.try_begin_trim().unwrap();
        assert!(run_trim(&b, dir.path(), now).is_none());
    }

    #[test]
    fn touch_updates_mtime_only_when_stale() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let mtime = |p: &Path| std::fs::metadata(p).unwrap().modified().unwrap();

        let old = put(dir.path(), &entry(1), 10, now - HOUR * 48);
        touch_if_stale(&old, now);
        // FS の時刻精度 (NTFS は 100ns 等) で丸まるので幅を持たせて比べる。
        assert!(!older_than(mtime(&old), now, Duration::from_secs(60)));

        let recent = put(dir.path(), &entry(2), 10, now - HOUR);
        touch_if_stale(&recent, now);
        assert!(
            older_than(mtime(&recent), now, HOUR / 2),
            "1 日以内なら書かない"
        );
    }
}
