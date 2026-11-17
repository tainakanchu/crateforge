//! ドラッグ＆ドロップされた zip を展開して取り込み対象にする。
//!
//! 仕様 (docs/ui-spec.md「ドラッグ＆ドロップ取り込み」):
//! - 整理 OFF (ライブラリルート未設定): zip と同じフォルダの `<zip 名>/` に展開し、
//!   その場で参照する。同名フォルダがあれば `<zip 名> (2)`, `(3)`, … にする
//!   (既存フォルダへの上書き・混ぜ込みはしない)。
//! - 整理 ON: アプリのキャッシュ領域の一時フォルダ (`import-staging/`) に展開し、
//!   通常どおりルート配下へコピーして取り込む。一時フォルダは取り込み完了 / キャンセル後に
//!   消し、起動時にも残骸を消す。
//! - 元の zip は変更も削除もしない。
//! - 展開するのは対応オーディオ形式 (`is_audio_file`) だけ。`__MACOSX/`、`.` 始まりの
//!   ファイル / フォルダ、フォルダエントリ、シンボリックリンクは展開しない。
//!   zip 内のフォルダ構成はそのまま保つ。
//! - パストラバーサル (zip slip) を含む zip は丸ごと拒否する。
//! - 展開後サイズの合計が [`MAX_TOTAL_UNCOMPRESSED_BYTES`] を超える zip は拒否する
//!   (zip bomb 対策。ヘッダの申告値で事前に確認し、実際の書き込み量でも止める)。
//! - パスワード付き / 壊れた zip はエラーメッセージを返して何も残さない。
//! - UTF-8 フラグの無いエントリ名 (Windows で作られた日本語 zip の CP932 など) は、
//!   生のバイト列が UTF-8 として正しければ UTF-8、そうでなければ Shift_JIS として読む。
//!   どちらでもなければ zip クレートの既定 (CP437) の解釈を使う。

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use zip::result::ZipError;
use zip::ZipArchive;

use super::is_audio_file;

/// 1 つの zip から展開できる合計サイズの上限 (8 GiB)。
/// ハイレゾのボックスセットでも収まり、zip bomb でディスクを埋め尽くさない程度の値。
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 整理 ON のときの一時展開先 (アプリのキャッシュフォルダ直下)。
pub const STAGING_DIR_NAME: &str = "import-staging";

/// 拡張子が `.zip` (大文字小文字は無視) の実在ファイルか。
pub fn is_zip_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
        && path.is_file()
}

/// エントリ名のバイト列を文字列にする。
///
/// UTF-8 フラグ付き / Unicode Path 拡張フィールド付きのエントリは zip クレートが
/// UTF-8 のバイト列を返すので、最初の分岐でそのまま通る。
fn decode_entry_name(raw: &[u8], crate_default: &str) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    let (s, _, had_errors) = encoding_rs::SHIFT_JIS.decode(raw);
    if !had_errors {
        return s.into_owned();
    }
    crate_default.to_string()
}

/// エントリ名の判定結果。
#[derive(Debug, PartialEq, Eq)]
enum EntryPath {
    /// 展開してよい相対パス。
    Safe(PathBuf),
    /// `__MACOSX` / 隠しファイル / 空名など、黙って読み飛ばすもの。
    Skip,
    /// zip の外へ出るパス (絶対パス / `..` / ドライブ指定)。zip ごと拒否する。
    Unsafe,
}

/// Windows でファイル名に使えない文字を `_` に置き換える (全 OS で同じ結果にする)。
fn sanitize_component(c: &str) -> String {
    let replaced: String = c
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    // Windows は末尾の空白 / ドットを落とすので、別名衝突を避けるため先に落としておく。
    replaced.trim_end_matches([' ', '.']).to_string()
}

/// デコード済みのエントリ名を検査し、展開先からの相対パスにする。
///
/// zip クレートの `enclosed_name()` はクレート自身のデコード (CP437) を元に判定するため、
/// Shift_JIS の 2 バイト目が `\` (0x5C) の文字 (「ソ」「表」など) を区切りと誤認しうる。
/// ここではデコード後の名前に対して同等の検査 (絶対パス・`..`・ドライブ指定・NUL の拒否)
/// を行い、`/` と `\` の両方を区切りとして扱う。
fn classify_entry_path(name: &str) -> EntryPath {
    if name.contains('\0') {
        return EntryPath::Unsafe;
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return EntryPath::Unsafe;
    }
    let mut out = PathBuf::new();
    for (i, comp) in normalized.split('/').enumerate() {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            return EntryPath::Unsafe;
        }
        // `C:` のようなドライブ指定で始まる名前。
        if i == 0 && comp.len() >= 2 && comp.as_bytes()[1] == b':' {
            return EntryPath::Unsafe;
        }
        if comp.eq_ignore_ascii_case("__MACOSX") || comp.starts_with('.') {
            return EntryPath::Skip;
        }
        let clean = sanitize_component(comp);
        if clean.is_empty() {
            return EntryPath::Skip;
        }
        out.push(clean);
    }
    // 念のため組み立て結果も確認する (通常の名前以外が混ざっていないこと)。
    if out.as_os_str().is_empty() {
        return EntryPath::Skip;
    }
    if !out.components().all(|c| matches!(c, Component::Normal(_))) {
        return EntryPath::Unsafe;
    }
    EntryPath::Safe(out)
}

fn zip_error_message(e: &ZipError) -> String {
    match e {
        ZipError::UnsupportedArchive(msg) if *msg == ZipError::PASSWORD_REQUIRED => {
            "パスワード付きの zip には対応していません".to_string()
        }
        ZipError::UnsupportedArchive(msg) => format!("対応していない zip 形式です: {msg}"),
        ZipError::Io(err) => format!("zip を読み込めません（壊れている可能性があります）: {err}"),
        other => format!("zip が壊れています: {other}"),
    }
}

fn format_limit(bytes: u64) -> String {
    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;
    if bytes >= GIB && bytes.is_multiple_of(GIB) {
        format!("{} GB", bytes / GIB)
    } else if bytes >= MIB {
        format!("{} MB", bytes / MIB)
    } else {
        format!("{bytes} バイト")
    }
}

fn size_limit_message(limit: u64) -> String {
    format!(
        "zip の展開後のサイズが上限（{}）を超えるため取り込みません",
        format_limit(limit)
    )
}

/// 展開する 1 エントリ。
struct PlannedEntry {
    index: usize,
    rel: PathBuf,
}

/// zip の中身を確認し、展開するエントリを選ぶ (まだ何も書き込まない)。
fn plan_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    limit: u64,
) -> Result<Vec<PlannedEntry>, String> {
    let mut planned = Vec::new();
    let mut declared_total: u64 = 0;
    for index in 0..archive.len() {
        // 中身は読まないので raw で開く (パスワード付きでもメタデータは読める)。
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| zip_error_message(&e))?;
        let name = decode_entry_name(entry.name_raw(), entry.name());
        let rel = match classify_entry_path(&name) {
            EntryPath::Unsafe => {
                return Err(format!(
                    "zip に展開先の外を指す不正なパスが含まれているため展開しません: {name}"
                ))
            }
            EntryPath::Skip => continue,
            EntryPath::Safe(rel) => rel,
        };
        // フォルダエントリとシンボリックリンクは展開しない (リンクは辿らない)。
        if entry.is_dir() || entry.is_symlink() || !is_audio_file(&rel) {
            continue;
        }
        if entry.encrypted() {
            return Err("パスワード付きの zip には対応していません".to_string());
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > limit {
            return Err(size_limit_message(limit));
        }
        planned.push(PlannedEntry { index, rel });
    }
    Ok(planned)
}

/// 計画どおり `dest` (作成済みの空フォルダ) へ書き出す。
fn write_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    planned: &[PlannedEntry],
    dest: &Path,
    limit: u64,
) -> Result<(), String> {
    let mut written_total: u64 = 0;
    for p in planned {
        let mut entry = archive
            .by_index(p.index)
            .map_err(|e| zip_error_message(&e))?;
        let out_path = dest.join(&p.rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("展開先フォルダを作成できません: {e}"))?;
        }
        let mut out = fs::File::create(&out_path)
            .map_err(|e| format!("展開先にファイルを作成できません: {e}"))?;
        // ヘッダの申告サイズは偽れるので、実際の書き込み量でも上限を確かめる。
        let remaining = limit - written_total;
        let n = io::copy(&mut (&mut entry).take(remaining + 1), &mut out)
            .map_err(|e| format!("zip を読み込めません（壊れている可能性があります）: {e}"))?;
        if n > remaining {
            return Err(size_limit_message(limit));
        }
        out.flush()
            .map_err(|e| format!("展開したファイルを書き込めません: {e}"))?;
        written_total += n;
    }
    Ok(())
}

/// zip から対応オーディオだけを展開する。
///
/// 展開するものがあれば `make_dest()` で展開先フォルダを作ってから書き出し、
/// `Ok(Some((展開先, ファイル数)))` を返す。対応オーディオが無ければフォルダを作らずに
/// `Ok(None)`。途中で失敗したら作った展開先フォルダを消してエラーを返す
/// (展開先は `make_dest` が新しく作ったフォルダなので、消しても他を巻き込まない)。
pub fn extract_audio(
    zip_path: &Path,
    make_dest: impl FnOnce() -> io::Result<PathBuf>,
    limit: u64,
) -> Result<Option<(PathBuf, usize)>, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("zip を開けません: {e}"))?;
    let mut archive = ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| format!("zip を開けません（壊れているか、zip 形式ではありません）: {e}"))?;
    let planned = plan_entries(&mut archive, limit)?;
    if planned.is_empty() {
        return Ok(None);
    }
    let dest = make_dest().map_err(|e| format!("展開先フォルダを作成できません: {e}"))?;
    if let Err(e) = write_entries(&mut archive, &planned, &dest, limit) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(Some((dest, planned.len())))
}

/// `parent/<stem>` を新しく作る。既にあれば `<stem> (2)`, `(3)`, … を試す。
/// `create_dir` (既存ならエラー) で作るので、既存フォルダを使い回すことはない。
pub fn create_unique_dir(parent: &Path, stem: &str) -> io::Result<PathBuf> {
    let stem = {
        let s = sanitize_component(stem);
        if s.is_empty() || s.starts_with('.') {
            format!("zip{s}")
        } else {
            s
        }
    };
    for n in 1..10_000u32 {
        let name = if n == 1 {
            stem.clone()
        } else {
            format!("{stem} ({n})")
        };
        let candidate = parent.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "同じ名前のフォルダが多すぎます",
    ))
}

fn zip_stem(zip_path: &Path) -> String {
    zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "zip".to_string())
}

/// 1 つの zip の展開エラー。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipDropError {
    pub path: String,
    pub message: String,
}

/// `prepare_drop_paths` の結果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDrop {
    /// 取り込みに渡すパス (zip は展開先フォルダに置き換え済み。zip 以外はそのまま)。
    pub paths: Vec<String>,
    /// 整理 ON で一時フォルダを使った場合、その場所 (取り込み後に `cleanup_staging` で消す)。
    pub staging: Option<String>,
    /// 展開できなかった zip。
    pub errors: Vec<ZipDropError>,
}

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_staging_dir(staging_root: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(staging_root)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    create_unique_dir(
        staging_root,
        &format!("{millis}-{}-{seq}", std::process::id()),
    )
}

/// ドロップされたパスのうち zip を展開し、取り込みに渡すパスへ置き換える。
///
/// - `organize = false`: zip の隣の `<zip 名>/` (衝突時は ` (2)` …) に展開する。
/// - `organize = true`: `staging_root` 配下の一時フォルダに展開する。
///
/// 対応オーディオを含まない zip は結果から外す (フォルダも作らない)。
/// zip 以外のパスは順番どおりそのまま残す。
pub fn prepare_drop_paths(
    paths: &[String],
    organize: bool,
    staging_root: &Path,
    limit: u64,
) -> PreparedDrop {
    let mut result = PreparedDrop::default();
    let mut staging: Option<PathBuf> = None;
    let mut staging_used = false;

    for raw in paths {
        let path = Path::new(raw);
        if !is_zip_file(path) {
            result.paths.push(raw.clone());
            continue;
        }
        let stem = zip_stem(path);
        let outcome = if organize {
            let staging_dir = match &staging {
                Some(d) => d.clone(),
                None => match new_staging_dir(staging_root) {
                    Ok(d) => {
                        staging = Some(d.clone());
                        d
                    }
                    Err(e) => {
                        result.errors.push(ZipDropError {
                            path: raw.clone(),
                            message: format!("一時フォルダを作成できません: {e}"),
                        });
                        continue;
                    }
                },
            };
            extract_audio(path, || create_unique_dir(&staging_dir, &stem), limit)
        } else {
            match path.parent() {
                Some(parent) => extract_audio(path, || create_unique_dir(parent, &stem), limit),
                None => Err("zip のフォルダを特定できません".to_string()),
            }
        };
        match outcome {
            Ok(Some((dir, _count))) => {
                if organize {
                    staging_used = true;
                }
                result.paths.push(dir.to_string_lossy().into_owned());
            }
            Ok(None) => {}
            Err(message) => result.errors.push(ZipDropError {
                path: raw.clone(),
                message,
            }),
        }
    }

    if let Some(dir) = staging {
        if staging_used {
            result.staging = Some(dir.to_string_lossy().into_owned());
        } else {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    result
}

/// `prepare_drop_paths` が作った一時フォルダを消す。
/// `staging_root` の内側 (root 自身は除く) 以外は消さない (フロントから渡るパスの保険)。
pub fn cleanup_staging(staging_root: &Path, staging: &Path) -> Result<(), String> {
    let Ok(root) = fs::canonicalize(staging_root) else {
        return Ok(()); // root が無ければ消すものも無い
    };
    let target = match fs::canonicalize(staging) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("一時フォルダを確認できません: {e}")),
    };
    if target == root || !target.starts_with(&root) {
        return Err("取り込み用の一時フォルダではありません".to_string());
    }
    fs::remove_dir_all(&target).map_err(|e| format!("一時フォルダを削除できません: {e}"))
}

/// 起動時の保険: 前回の取り込みで残った一時フォルダをまとめて消す。
pub fn purge_staging_root(staging_root: &Path) {
    match fs::remove_dir_all(staging_root) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => eprintln!(
            "purge_staging_root: {} を削除できません ({e})",
            staging_root.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    /// (名前, 中身) の zip を作る。名前は UTF-8 で書かれる。
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, data) in entries {
            if name.ends_with('/') {
                w.add_directory(*name, opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    /// 書き出し済みの zip の中の (ASCII の) 名前を、同じ長さの生バイト列に置き換える。
    /// ZipWriter は名前を UTF-8 で書くので、UTF-8 フラグ無しの Shift_JIS 名や
    /// `..` を含む名前を作るのに使う (ローカルヘッダと中央ディレクトリの両方が置き換わる)。
    fn patch_bytes(mut buf: Vec<u8>, from: &[u8], to: &[u8]) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let mut i = 0;
        let mut hits = 0;
        while i + from.len() <= buf.len() {
            if &buf[i..i + from.len()] == from {
                buf[i..i + from.len()].copy_from_slice(to);
                hits += 1;
                i += from.len();
            } else {
                i += 1;
            }
        }
        assert!(hits >= 2, "placeholder not found in header + central dir");
        buf
    }

    fn write_zip(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    fn rel_files(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    let rel = p.strip_prefix(root).unwrap();
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn extracts_audio_keeping_nested_dirs_and_skips_others() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = build_zip(&[
            ("Artist/", b""),
            ("Artist/Album/", b""),
            ("Artist/Album/01 Intro.flac", b"flac-data"),
            ("Artist/Album/Disc 2/01 Outro.MP3", b"mp3-data"),
            ("Artist/Album/cover.jpg", b"jpg"),
            ("Artist/Album/notes.txt", b"txt"),
            ("__MACOSX/Artist/Album/._01 Intro.flac", b"rsrc"),
            ("Artist/.hidden/02.flac", b"hidden"),
            ("Artist/Album/.DS_Store", b"ds"),
            ("top.wav", b"wav"),
        ]);
        let zip = write_zip(tmp.path(), "Album.zip", &bytes);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("staging"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.staging, None);
        let out = tmp.path().join("Album");
        assert_eq!(r.paths, vec![out.to_string_lossy().into_owned()]);
        assert_eq!(
            rel_files(&out),
            vec![
                "Artist/Album/01 Intro.flac",
                "Artist/Album/Disc 2/01 Outro.MP3",
                "top.wav",
            ]
        );
        assert_eq!(
            fs::read(out.join("Artist/Album/01 Intro.flac")).unwrap(),
            b"flac-data"
        );
        // 元の zip はそのまま。
        assert_eq!(fs::read(&zip).unwrap(), bytes);
        assert!(!tmp.path().join("__MACOSX").exists());
    }

    #[test]
    fn existing_folder_gets_numbered_suffix() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_zip(tmp.path(), "Album.zip", &build_zip(&[("a.flac", b"1")]));
        fs::create_dir(tmp.path().join("Album")).unwrap();
        fs::write(tmp.path().join("Album/keep.txt"), b"x").unwrap();
        let args = [zip.to_string_lossy().into_owned()];
        let staging = tmp.path().join("staging");

        let r = prepare_drop_paths(&args, false, &staging, MAX_TOTAL_UNCOMPRESSED_BYTES);
        assert_eq!(
            r.paths,
            vec![tmp.path().join("Album (2)").to_string_lossy().into_owned()]
        );
        let r = prepare_drop_paths(&args, false, &staging, MAX_TOTAL_UNCOMPRESSED_BYTES);
        assert_eq!(
            r.paths,
            vec![tmp.path().join("Album (3)").to_string_lossy().into_owned()]
        );
        // 既存フォルダには何も混ぜない。
        assert_eq!(rel_files(&tmp.path().join("Album")), vec!["keep.txt"]);
    }

    #[test]
    fn zip_slip_entry_rejects_whole_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("drop");
        fs::create_dir(&sub).unwrap();
        let bytes = build_zip(&[("ok.flac", b"1"), ("QQ/evil.flac", b"2")]);
        let bytes = patch_bytes(bytes, b"QQ/evil", b"../evil");
        let zip = write_zip(&sub, "x.zip", &bytes);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("staging"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.paths.is_empty());
        assert_eq!(r.errors.len(), 1);
        assert!(
            r.errors[0].message.contains("不正なパス"),
            "{}",
            r.errors[0].message
        );
        assert!(!tmp.path().join("evil.flac").exists());
        assert!(!sub.join("x").exists());
    }

    #[test]
    fn classify_rejects_traversal_and_absolute_paths() {
        assert_eq!(classify_entry_path("../a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("a/../../a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("..\\a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("/etc/a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("\\a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("C:/a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("C:a.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("a\0.flac"), EntryPath::Unsafe);
        assert_eq!(classify_entry_path("__MACOSX/a.flac"), EntryPath::Skip);
        assert_eq!(classify_entry_path("a/.b.flac"), EntryPath::Skip);
        assert_eq!(
            classify_entry_path("a\\b/./c.flac"),
            EntryPath::Safe(PathBuf::from("a").join("b").join("c.flac"))
        );
        assert_eq!(
            classify_entry_path("a/b?.flac"),
            EntryPath::Safe(PathBuf::from("a").join("b_.flac"))
        );
    }

    #[test]
    fn shift_jis_names_without_utf8_flag_are_decoded() {
        let tmp = tempfile::tempdir().unwrap();
        // 「曲名/ソ.flac」: 「ソ」は 2 バイト目が 0x5C (`\`) の Shift_JIS 文字。
        let (sjis_dir, _, _) = encoding_rs::SHIFT_JIS.encode("曲名");
        let (sjis_file, _, _) = encoding_rs::SHIFT_JIS.encode("ソ");
        assert_eq!(sjis_dir.len(), 4);
        assert_eq!(sjis_file.len(), 2);
        let bytes = build_zip(&[("DDDD/FF.flac", b"x")]);
        let bytes = patch_bytes(
            bytes,
            b"DDDD/FF",
            &[&sjis_dir[..], b"/", &sjis_file[..]].concat(),
        );
        let zip = write_zip(tmp.path(), "sjis.zip", &bytes);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("staging"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(rel_files(&tmp.path().join("sjis")), vec!["曲名/ソ.flac"]);
    }

    #[test]
    fn decode_prefers_utf8_then_shift_jis_then_crate_default() {
        assert_eq!(decode_entry_name("曲.flac".as_bytes(), "x"), "曲.flac");
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("曲.flac");
        assert_eq!(decode_entry_name(&sjis, "x"), "曲.flac");
        // Shift_JIS としても不正 (0x81 の後に 0x20) → クレートの解釈。
        assert_eq!(
            decode_entry_name(&[0x81, 0x20, b'a'], "fallback"),
            "fallback"
        );
    }

    #[test]
    fn size_limit_is_enforced_and_leaves_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_zip(
            tmp.path(),
            "big.zip",
            &build_zip(&[("a.flac", &[0u8; 600]), ("b.flac", &[0u8; 600])]),
        );
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("staging"),
            1000,
        );
        assert!(r.paths.is_empty());
        assert_eq!(r.errors.len(), 1);
        assert!(
            r.errors[0].message.contains("上限"),
            "{}",
            r.errors[0].message
        );
        assert!(!tmp.path().join("big").exists());

        // 上限ちょうどまでは展開できる。
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("staging"),
            1200,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(rel_files(&tmp.path().join("big")), vec!["a.flac", "b.flac"]);
    }

    #[test]
    fn write_phase_stops_when_actual_size_exceeds_limit() {
        // ヘッダの申告値をすり抜けた場合の保険 (書き込み量での判定) を直接確かめる。
        let tmp = tempfile::tempdir().unwrap();
        let bytes = build_zip(&[("a.flac", &[1u8; 500])]);
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let planned = vec![PlannedEntry {
            index: 0,
            rel: PathBuf::from("a.flac"),
        }];
        let err = write_entries(&mut archive, &planned, tmp.path(), 100).unwrap_err();
        assert!(err.contains("上限"), "{err}");
    }

    #[test]
    fn zip_without_audio_creates_no_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = write_zip(
            tmp.path(),
            "docs.zip",
            &build_zip(&[("readme.txt", b"x"), ("art/cover.jpg", b"y")]),
        );
        let staging = tmp.path().join("staging");
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &staging,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.paths.is_empty());
        assert!(r.errors.is_empty());
        assert!(!tmp.path().join("docs").exists());

        // 整理 ON でも一時フォルダを残さない。
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            true,
            &staging,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.paths.is_empty());
        assert_eq!(r.staging, None);
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    }

    #[test]
    fn corrupt_zip_reports_error_and_others_pass_through() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = write_zip(tmp.path(), "bad.ZIP", b"not a zip at all");
        let folder = tmp.path().join("Folder");
        fs::create_dir(&folder).unwrap();
        let audio = tmp.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        let input = vec![
            folder.to_string_lossy().into_owned(),
            bad.to_string_lossy().into_owned(),
            audio.to_string_lossy().into_owned(),
        ];
        let r = prepare_drop_paths(
            &input,
            false,
            &tmp.path().join("s"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert_eq!(r.paths, vec![input[0].clone(), input[2].clone()]);
        assert_eq!(r.errors.len(), 1);
        assert!(
            r.errors[0].message.contains("zip を開けません"),
            "{}",
            r.errors[0].message
        );
        assert!(!tmp.path().join("bad").exists());
    }

    #[test]
    fn corrupt_entry_data_cleans_up_partial_output() {
        let tmp = tempfile::tempdir().unwrap();
        // 中身を書き換えて CRC を合わなくする (stored で書いて生データを直接いじる)。
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("a.flac", opts).unwrap();
        w.write_all(b"AAAAAAAAAAAAAAAA").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let bytes = patch_one(bytes, b"AAAAAAAAAAAAAAAA", b"BBBBBBBBBBBBBBBB");
        let zip = write_zip(tmp.path(), "crc.zip", &bytes);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("s"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.paths.is_empty());
        assert_eq!(r.errors.len(), 1, "{:?}", r);
        assert!(!tmp.path().join("crc").exists());
    }

    fn patch_one(mut buf: Vec<u8>, from: &[u8], to: &[u8]) -> Vec<u8> {
        let pos = buf
            .windows(from.len())
            .position(|w| w == from)
            .expect("pattern");
        buf[pos..pos + from.len()].copy_from_slice(to);
        buf
    }

    #[test]
    fn symlink_entries_are_not_extracted() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        w.add_symlink("link.flac", "/etc/passwd", opts).unwrap();
        w.start_file("real.flac", opts).unwrap();
        w.write_all(b"x").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let zip = write_zip(tmp.path(), "links.zip", &bytes);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &tmp.path().join("s"),
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(rel_files(&tmp.path().join("links")), vec!["real.flac"]);
    }

    #[test]
    fn organize_mode_uses_staging_and_cleanup_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let staging_root = tmp.path().join("cache").join(STAGING_DIR_NAME);
        let z1 = write_zip(tmp.path(), "Same.zip", &build_zip(&[("a.flac", b"1")]));
        let other = tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        let z2 = write_zip(&other, "same.zip", &build_zip(&[("b.flac", b"2")]));
        let r = prepare_drop_paths(
            &[
                z1.to_string_lossy().into_owned(),
                z2.to_string_lossy().into_owned(),
            ],
            true,
            &staging_root,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let staging = PathBuf::from(r.staging.clone().expect("staging"));
        assert!(staging.starts_with(&staging_root));
        assert_eq!(r.paths.len(), 2);
        for p in &r.paths {
            assert!(Path::new(p).starts_with(&staging), "{p}");
        }
        // zip の隣には何も作らない。
        assert!(!tmp.path().join("Same").exists());
        assert!(!other.join("same").exists());

        // staging root の外や root 自身は消さない。
        assert!(cleanup_staging(&staging_root, tmp.path()).is_err());
        assert!(cleanup_staging(&staging_root, &staging_root).is_err());
        assert!(staging.exists());

        cleanup_staging(&staging_root, &staging).unwrap();
        assert!(!staging.exists());
        // 2 回目 (既に無い) もエラーにしない。
        cleanup_staging(&staging_root, &staging).unwrap();
    }

    #[test]
    fn purge_removes_leftover_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(STAGING_DIR_NAME);
        fs::create_dir_all(root.join("old/Album")).unwrap();
        fs::write(root.join("old/Album/a.flac"), b"x").unwrap();
        purge_staging_root(&root);
        assert!(!root.exists());
        purge_staging_root(&root); // 無くても平気
    }

    #[test]
    fn is_zip_file_requires_real_file_and_zip_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let z = write_zip(tmp.path(), "A.Zip", &build_zip(&[("a.flac", b"1")]));
        assert!(is_zip_file(&z));
        let d = tmp.path().join("folder.zip");
        fs::create_dir(&d).unwrap();
        assert!(!is_zip_file(&d));
        assert!(!is_zip_file(&tmp.path().join("missing.zip")));
        let f = tmp.path().join("a.flac");
        fs::write(&f, b"x").unwrap();
        assert!(!is_zip_file(&f));
    }
}
