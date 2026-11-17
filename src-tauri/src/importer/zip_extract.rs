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
//! - アートワーク: zip 内の画像 (jpg / jpeg / png) から各オーディオのジャケットを選び
//!   ([`choose_artwork`])、縮小して一時フォルダに置く (zip の隣の展開先には書かない)。
//!   取り込み後に [`embed_drop_artwork`] で、今回取り込んだ / 置き換えた曲のうち
//!   埋め込みアートワークが無いものにだけ埋め込む。

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use zip::result::ZipError;
use zip::ZipArchive;

use super::is_audio_file;
use crate::artwork;
use crate::db::Database;
use crate::models::{ImportActionResult, ItemAction};

/// 1 つの zip から展開できる合計サイズの上限 (8 GiB)。
/// ハイレゾのボックスセットでも収まり、zip bomb でディスクを埋め尽くさない程度の値。
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 整理 ON のときの一時展開先 (アプリのキャッシュフォルダ直下)。
pub const STAGING_DIR_NAME: &str = "import-staging";

/// アートワーク候補にする画像の拡張子 (小文字)。
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];

/// アートワーク候補にする画像 1 枚の上限 (50 MiB)。これより大きい画像は候補にしない。
pub const MAX_IMAGE_ENTRY_BYTES: u64 = 50 * 1024 * 1024;

/// アートワークの選択で優先するファイル名 (拡張子を除く・大文字小文字は無視)。前ほど優先。
const ARTWORK_NAME_PRIORITY: &[&str] = &["cover", "folder", "front", "album", "artwork"];

/// 一時フォルダ内の、埋め込み用に縮小した画像の置き場。`.` 始まりなので
/// zip の展開先フォルダ (`.` 始まりにならない) と衝突せず、取り込みの走査にも入らない。
const ARTWORK_DIR_NAME: &str = ".artwork";

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

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

/// zip の中身の確認結果。
struct Plan {
    /// 展開する対応オーディオ。
    audio: Vec<PlannedEntry>,
    /// アートワーク候補の画像 (ディスクには展開しない)。
    images: Vec<PlannedEntry>,
}

/// zip の中身を確認し、展開するエントリとアートワーク候補を選ぶ (まだ何も書き込まない)。
fn plan_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    limit: u64,
) -> Result<Plan, String> {
    let mut plan = Plan {
        audio: Vec::new(),
        images: Vec::new(),
    };
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
        if entry.is_dir() || entry.is_symlink() {
            continue;
        }
        if is_image_file(&rel) {
            // 画像は候補にするだけ。パスワード付き・大きすぎるものは黙って候補から外す。
            if !entry.encrypted() && entry.size() <= MAX_IMAGE_ENTRY_BYTES {
                plan.images.push(PlannedEntry { index, rel });
            }
            continue;
        }
        if !is_audio_file(&rel) {
            continue;
        }
        if entry.encrypted() {
            return Err("パスワード付きの zip には対応していません".to_string());
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > limit {
            return Err(size_limit_message(limit));
        }
        plan.audio.push(PlannedEntry { index, rel });
    }
    Ok(plan)
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

/// 画像エントリをメモリに読む ([`MAX_IMAGE_ENTRY_BYTES`] を超えたら諦める)。
fn read_image_entry<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_index(index).map_err(|e| zip_error_message(&e))?;
    let mut buf = Vec::new();
    (&mut entry)
        .take(MAX_IMAGE_ENTRY_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("画像を読み込めません: {e}"))?;
    if buf.len() as u64 > MAX_IMAGE_ENTRY_BYTES {
        return Err("画像が大きすぎます".to_string());
    }
    Ok(buf)
}

/// ファイル名 (拡張子を除く・小文字) が `word` と一致 / `word` で始まるか。
fn stem_matches(rel: &Path, word: &str, exact: bool) -> bool {
    let stem = rel
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if exact {
        stem == word
    } else {
        stem.len() > word.len() && stem.starts_with(word)
    }
}

/// 同じフォルダの候補から 1 枚を選ぶ。決めきれなければ `None`。
///
/// 1. ファイル名 (拡張子を除く) が優先語と完全一致するもの (`cover` > `folder` > `front`
///    > `album` > `artwork`)。
/// 2. 優先語で始まるもの (`cover_front`, `Folder (1)` など)。同じ順で見る。
/// 3. 候補が 1 枚だけならそれ。
///
/// どの段階でも同じ語に 2 枚以上当たったら曖昧なので選ばない (大きさなどで推測しない)。
/// 完全一致を先に全語で見るのは、`cover_back` (裏ジャケ) が `front` より優先されないようにするため。
fn pick_in_dir(cands: &[(usize, &Path)]) -> Option<usize> {
    for exact in [true, false] {
        for word in ARTWORK_NAME_PRIORITY {
            let hits: Vec<usize> = cands
                .iter()
                .filter(|(_, rel)| stem_matches(rel, word, exact))
                .map(|(i, _)| *i)
                .collect();
            match hits.len() {
                0 => continue,
                1 => return Some(hits[0]),
                _ => return None,
            }
        }
    }
    if cands.len() == 1 {
        Some(cands[0].0)
    } else {
        None
    }
}

/// zip 内のオーディオ (`audio_rel`) に使うアートワークを `images` から選び、その添字を返す。
///
/// オーディオと同じフォルダから zip のルートへ向かって親フォルダをたどり、画像のある
/// いちばん近いフォルダだけで選ぶ ([`pick_in_dir`])。そこで決まらなければ選ばない
/// (さらに上のフォルダへは進まない)。
fn choose_artwork(audio_rel: &Path, images: &[&Path]) -> Option<usize> {
    let mut dir = audio_rel.parent().unwrap_or(Path::new(""));
    loop {
        let cands: Vec<(usize, &Path)> = images
            .iter()
            .enumerate()
            .filter(|(_, img)| img.parent().unwrap_or(Path::new("")) == dir)
            .map(|(i, img)| (i, *img))
            .collect();
        if !cands.is_empty() {
            return pick_in_dir(&cands);
        }
        dir = dir.parent()?;
    }
}

/// 1 つの zip の展開結果。
pub struct Extracted {
    /// 展開先フォルダ。
    pub dir: PathBuf,
    /// アートワークを選べたオーディオと、その画像 (`images` の添字)。
    pub artwork: Vec<(PathBuf, usize)>,
    /// 選ばれた画像の生データ (zip から読んだまま。展開先には書かない)。
    pub images: Vec<Vec<u8>>,
}

/// zip から対応オーディオだけを展開し、各オーディオに使うアートワーク画像も選んで読む。
///
/// 展開するものがあれば `make_dest()` で展開先フォルダを作ってから書き出す。
/// 対応オーディオが無ければフォルダを作らずに `Ok(None)`。途中で失敗したら作った
/// 展開先フォルダを消してエラーを返す (展開先は `make_dest` が新しく作ったフォルダなので、
/// 消しても他を巻き込まない)。画像が読めないのはエラーにせず、その画像を使わないだけ。
pub fn extract_audio(
    zip_path: &Path,
    make_dest: impl FnOnce() -> io::Result<PathBuf>,
    limit: u64,
) -> Result<Option<Extracted>, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("zip を開けません: {e}"))?;
    let mut archive = ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| format!("zip を開けません（壊れているか、zip 形式ではありません）: {e}"))?;
    let plan = plan_entries(&mut archive, limit)?;
    if plan.audio.is_empty() {
        return Ok(None);
    }
    let dest = make_dest().map_err(|e| format!("展開先フォルダを作成できません: {e}"))?;
    if let Err(e) = write_entries(&mut archive, &plan.audio, &dest, limit) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }

    let image_rels: Vec<&Path> = plan.images.iter().map(|p| p.rel.as_path()).collect();
    // plan.images の添字 → 読み込んだ画像 (images) の添字。読めなかったものは None。
    let mut loaded: Vec<Option<Option<usize>>> = vec![None; plan.images.len()];
    let mut images = Vec::new();
    let mut artwork = Vec::new();
    for a in &plan.audio {
        let abs = dest.join(&a.rel);
        if let Some(pi) = choose_artwork(&a.rel, &image_rels) {
            let slot = *loaded[pi].get_or_insert_with(|| {
                match read_image_entry(&mut archive, plan.images[pi].index) {
                    Ok(bytes) => {
                        images.push(bytes);
                        Some(images.len() - 1)
                    }
                    Err(e) => {
                        crate::logging::write_line(
                            "warn",
                            &format!(
                                "zip artwork: {} の {} を読めません ({e})",
                                zip_path.display(),
                                plan.images[pi].rel.display()
                            ),
                        );
                        None
                    }
                }
            });
            if let Some(ii) = slot {
                artwork.push((abs, ii));
            }
        }
    }
    Ok(Some(Extracted {
        dir: dest,
        artwork,
        images,
    }))
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

/// zip から展開したオーディオ 1 つと、埋め込むアートワーク (一時フォルダ内の縮小済み画像)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropArtwork {
    /// 展開したオーディオのパス (`plan_import` / `import_with_actions` の `path` と同じ表記)。
    pub audio_path: String,
    /// 埋め込む画像 (一時フォルダの `.artwork/` 内)。
    pub image: String,
}

/// `prepare_drop_paths` の結果。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDrop {
    /// 取り込みに渡すパス (zip は展開先フォルダに置き換え済み。zip 以外はそのまま)。
    pub paths: Vec<String>,
    /// 一時フォルダを使った場合 (整理 ON の展開先、またはアートワークの置き場)、その場所。
    /// 取り込み後 (キャンセル時も) に `cleanup_staging` で消す。
    pub staging: Option<String>,
    /// 展開できなかった zip。
    pub errors: Vec<ZipDropError>,
    /// 取り込み後に埋め込むアートワーク (zip 内に使える画像があったオーディオだけ)。
    pub artwork: Vec<DropArtwork>,
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

/// 一時フォルダを (まだなら) 作って返す。
fn ensure_staging(staging: &mut Option<PathBuf>, staging_root: &Path) -> io::Result<PathBuf> {
    if let Some(d) = staging {
        return Ok(d.clone());
    }
    let d = new_staging_dir(staging_root)?;
    *staging = Some(d.clone());
    Ok(d)
}

/// 選んだ画像を縮小して一時フォルダの `.artwork/` に書き、`DropArtwork` を積む。
/// 失敗はログに残すだけ (取り込み自体は止めない)。書いた枚数を返す。
fn stage_artwork(
    ex: &Extracted,
    staging: &mut Option<PathBuf>,
    staging_root: &Path,
    out: &mut Vec<DropArtwork>,
) -> usize {
    if ex.artwork.is_empty() {
        return 0;
    }
    let art_dir = match ensure_staging(staging, staging_root).and_then(|s| {
        let d = s.join(ARTWORK_DIR_NAME);
        fs::create_dir_all(&d).map(|_| d)
    }) {
        Ok(d) => d,
        Err(e) => {
            crate::logging::write_line(
                "warn",
                &format!("zip artwork: 一時フォルダを作成できません ({e})"),
            );
            return 0;
        }
    };
    let mut written: Vec<Option<PathBuf>> = Vec::with_capacity(ex.images.len());
    let mut count = 0;
    for bytes in &ex.images {
        let Some((data, ext)) = artwork::prepare_for_embed(bytes, artwork::EMBED_MAX_EDGE) else {
            crate::logging::write_line("warn", "zip artwork: 画像をデコードできません");
            written.push(None);
            continue;
        };
        let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = art_dir.join(format!("{seq}.{ext}"));
        match fs::write(&path, data) {
            Ok(()) => {
                count += 1;
                written.push(Some(path));
            }
            Err(e) => {
                crate::logging::write_line(
                    "warn",
                    &format!("zip artwork: 画像を書き込めません ({e})"),
                );
                written.push(None);
            }
        }
    }
    for (audio, ii) in &ex.artwork {
        if let Some(Some(img)) = written.get(*ii) {
            out.push(DropArtwork {
                audio_path: audio.to_string_lossy().into_owned(),
                image: img.to_string_lossy().into_owned(),
            });
        }
    }
    count
}

/// ドロップされたパスのうち zip を展開し、取り込みに渡すパスへ置き換える。
///
/// - `organize = false`: zip の隣の `<zip 名>/` (衝突時は ` (2)` …) に展開する。
/// - `organize = true`: `staging_root` 配下の一時フォルダに展開する。
///
/// どちらでも、zip 内のアートワーク画像は展開先には書かず、縮小して一時フォルダの
/// `.artwork/` に置く (取り込み後に [`embed_drop_artwork`] で埋め込む)。
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
            let staging_dir = match ensure_staging(&mut staging, staging_root) {
                Ok(d) => d,
                Err(e) => {
                    result.errors.push(ZipDropError {
                        path: raw.clone(),
                        message: format!("一時フォルダを作成できません: {e}"),
                    });
                    continue;
                }
            };
            extract_audio(path, || create_unique_dir(&staging_dir, &stem), limit)
        } else {
            match path.parent() {
                Some(parent) => extract_audio(path, || create_unique_dir(parent, &stem), limit),
                None => Err("zip のフォルダを特定できません".to_string()),
            }
        };
        match outcome {
            Ok(Some(ex)) => {
                if organize {
                    staging_used = true;
                }
                if stage_artwork(&ex, &mut staging, staging_root, &mut result.artwork) > 0 {
                    staging_used = true;
                }
                result.paths.push(ex.dir.to_string_lossy().into_owned());
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

/// [`embed_drop_artwork`] の結果。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkEmbedSummary {
    /// 埋め込んだ曲数。
    pub embedded: usize,
    /// 既にアートワークがあったので触らなかった曲数。
    pub kept: usize,
    /// 埋め込みに失敗した曲数 (ログに残す。取り込み自体は成功扱い)。
    pub failed: usize,
}

/// 2 つのパスが同じファイルを指すか (表記が同じ、または実体が同じ)。
fn same_file(a: &str, b: &str) -> bool {
    a == b
        || matches!(
            (fs::canonicalize(a), fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

/// zip から取り込んだ曲にアートワークを埋め込む。
///
/// - 対象は今回の取り込みで実際に「取り込む / 置き換え」に成功した曲だけ
///   (`results` の `ok` かつ `action != skip`、`track_id` あり) で、`artwork` に
///   画像が選ばれているもの。
/// - 書き込むのはライブラリが参照する実ファイル (整理 ON ならコピー先) で、既に埋め込み
///   アートワークがあれば触らない。
/// - 画像は `staging_root` の内側にあるものだけ使う (フロントから渡るパスの保険)。
/// - 書き込みは「アートワークを設定」(`commands::artwork`) と同じ `artwork::set_picture`。
///   サムネイルのキャッシュはファイルの mtime / サイズで自動的に無効になる。
pub fn embed_drop_artwork(
    db: &Database,
    staging_root: &Path,
    results: &[ImportActionResult],
    artwork_items: &[DropArtwork],
) -> ArtworkEmbedSummary {
    let mut summary = ArtworkEmbedSummary::default();
    let Ok(root) = fs::canonicalize(staging_root) else {
        return summary;
    };
    let mut cache: HashMap<String, Option<Vec<u8>>> = HashMap::new();

    for r in results {
        if !r.ok || r.action == ItemAction::Skip {
            continue;
        }
        let Some(track_id) = r.track_id else { continue };
        let Some(item) = artwork_items
            .iter()
            .find(|a| a.audio_path == r.path)
            .or_else(|| {
                artwork_items
                    .iter()
                    .find(|a| same_file(&a.audio_path, &r.path))
            })
        else {
            continue;
        };
        let image = cache.entry(item.image.clone()).or_insert_with(|| {
            match fs::canonicalize(&item.image) {
                Ok(p) if p.starts_with(&root) => fs::read(&p).ok(),
                _ => None,
            }
        });
        let Some(image) = image.clone() else {
            summary.failed += 1;
            crate::logging::write_line(
                "warn",
                &format!("zip artwork: 画像を読めません ({})", item.image),
            );
            continue;
        };
        let location = match db.get_track_by_track_id(track_id) {
            Ok(Some(t)) => t.location_path.filter(|p| !p.is_empty()),
            _ => None,
        };
        let Some(location) = location else {
            summary.failed += 1;
            continue;
        };
        if artwork::extract_picture(&location).is_some() {
            summary.kept += 1;
            continue;
        }
        match artwork::set_picture(&location, image) {
            Ok(()) => summary.embedded += 1,
            Err(e) => {
                summary.failed += 1;
                crate::logging::write_line(
                    "warn",
                    &format!("zip artwork: {location} に埋め込めません ({e})"),
                );
            }
        }
    }
    summary
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

    fn choose(audio: &str, images: &[&str]) -> Option<String> {
        let rels: Vec<PathBuf> = images.iter().map(PathBuf::from).collect();
        let refs: Vec<&Path> = rels.iter().map(|p| p.as_path()).collect();
        choose_artwork(Path::new(audio), &refs).map(|i| images[i].to_string())
    }

    #[test]
    fn artwork_name_priority() {
        let imgs = [
            "A/back.jpg",
            "A/artwork.png",
            "A/album.jpg",
            "A/front.jpg",
            "A/Folder.JPG",
            "A/COVER.jpeg",
        ];
        assert_eq!(choose("A/01.flac", &imgs).as_deref(), Some("A/COVER.jpeg"));
        assert_eq!(
            choose("A/01.flac", &imgs[..5]).as_deref(),
            Some("A/Folder.JPG")
        );
        assert_eq!(
            choose("A/01.flac", &imgs[..4]).as_deref(),
            Some("A/front.jpg")
        );
        assert_eq!(
            choose("A/01.flac", &imgs[..3]).as_deref(),
            Some("A/album.jpg")
        );
        assert_eq!(
            choose("A/01.flac", &imgs[..2]).as_deref(),
            Some("A/artwork.png")
        );
        // 「cover で始まる」も拾う。ただし完全一致 (front) が先。
        assert_eq!(
            choose("A/01.flac", &["A/cover_front.jpg", "A/booklet.jpg"]).as_deref(),
            Some("A/cover_front.jpg")
        );
        assert_eq!(
            choose("A/01.flac", &["A/cover_back.jpg", "A/front.jpg"]).as_deref(),
            Some("A/front.jpg")
        );
    }

    #[test]
    fn artwork_nearest_dir_wins_and_walks_up_to_root() {
        let imgs = ["cover.jpg", "Disc 1/scan.png"];
        // 同じフォルダに 1 枚だけ → それ (名前が優先語でなくても)。
        assert_eq!(
            choose("Disc 1/01.flac", &imgs).as_deref(),
            Some("Disc 1/scan.png")
        );
        // 同じフォルダに無ければ親 (ルート) へ。
        assert_eq!(
            choose("Disc 2/01.flac", &imgs).as_deref(),
            Some("cover.jpg")
        );
        assert_eq!(choose("a/b/c/01.flac", &imgs).as_deref(), Some("cover.jpg"));
        // 子フォルダの画像は使わない。
        assert_eq!(choose("01.flac", &["Disc 1/cover.jpg"]), None);
    }

    #[test]
    fn artwork_ambiguous_sets_nothing() {
        // 優先語に当たらない画像が 2 枚 → 選ばない (大きさなどで推測しない)。
        assert_eq!(choose("A/01.flac", &["A/scan1.jpg", "A/scan2.jpg"]), None);
        // 同じ優先語に 2 枚 → 選ばない。
        assert_eq!(choose("A/01.flac", &["A/cover.jpg", "A/Cover.png"]), None);
        // いちばん近いフォルダで曖昧なら、親の cover.jpg にも進まない。
        assert_eq!(
            choose("A/01.flac", &["cover.jpg", "A/x.jpg", "A/y.jpg"]),
            None
        );
        assert_eq!(choose("A/01.flac", &[]), None);
    }

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            w,
            h,
            image::Rgb([10, 20, 30]),
        ));
        artwork::encode_image(&img, artwork::ThumbFormat::Jpeg(90))
            .unwrap()
            .0
    }

    #[test]
    fn artwork_is_staged_not_extracted_and_macosx_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let cover = jpeg(2000, 1000);
        let bytes = build_zip(&[
            ("Album/01.flac", b"a"),
            ("Album/cover.jpg", &cover),
            ("__MACOSX/Album/._cover.jpg", &cover),
            ("Album/.folder.jpg", &cover),
            ("Other/02.flac", b"b"),
            ("Other/a.jpg", &cover),
            ("Other/b.jpg", &cover),
        ]);
        let zip = write_zip(tmp.path(), "Rel.zip", &bytes);
        let staging_root = tmp.path().join("cache").join(STAGING_DIR_NAME);
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &staging_root,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        // 展開先には音声だけ。
        assert_eq!(
            rel_files(&tmp.path().join("Rel")),
            vec!["Album/01.flac", "Other/02.flac"]
        );
        // 画像は一時フォルダに縮小して置かれる (Other は曖昧なので無し)。
        let staging = PathBuf::from(r.staging.expect("staging for artwork"));
        assert!(staging.starts_with(&staging_root));
        assert_eq!(r.artwork.len(), 1);
        let a = &r.artwork[0];
        assert_eq!(
            a.audio_path,
            tmp.path()
                .join("Rel")
                .join("Album")
                .join("01.flac")
                .to_string_lossy()
        );
        assert!(Path::new(&a.image).starts_with(&staging));
        let img = artwork::decode_image(&fs::read(&a.image).unwrap()).unwrap();
        assert_eq!((img.width(), img.height()), (1400, 700));
    }

    #[test]
    fn oversized_or_undecodable_images_are_skipped_without_error() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = build_zip(&[("01.flac", b"a"), ("cover.jpg", b"not really a jpeg")]);
        let zip = write_zip(tmp.path(), "x.zip", &bytes);
        let staging_root = tmp.path().join("s");
        let r = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            false,
            &staging_root,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(r.errors.is_empty());
        assert!(r.artwork.is_empty());
        assert_eq!(r.staging, None);
        assert_eq!(r.paths.len(), 1);
    }

    /// タグ付きの最小 WAV を作る (lofty で読み書きできる)。
    fn wav_bytes(title: &str) -> Vec<u8> {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.wav");
        crate::library_match::replace::tests::write_wav(&p, 1);
        let mut tagged = lofty::probe::Probe::open(&p).unwrap().read().unwrap();
        use lofty::file::TaggedFileExt;
        use lofty::tag::Accessor;
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(lofty::tag::Tag::new(tt));
        let tag = tagged.primary_tag_mut().unwrap();
        tag.set_title(title.to_string());
        tag.set_artist("Artist".to_string());
        tag.set_album("Album".to_string());
        use lofty::file::AudioFile;
        tagged
            .save_to_path(&p, lofty::config::WriteOptions::default())
            .unwrap();
        fs::read(&p).unwrap()
    }

    #[test]
    fn embeds_only_into_imported_tracks_without_art() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("lib");
        let db = Database::open_memory().unwrap();
        db.set_state("library_root", &lib.to_string_lossy())
            .unwrap();

        let has_art = {
            let p = tmp.path().join("pre.wav");
            fs::write(&p, wav_bytes("Has Art")).unwrap();
            artwork::set_picture(&p.to_string_lossy(), jpeg(8, 8)).unwrap();
            fs::read(&p).unwrap()
        };
        let bytes = build_zip(&[
            ("Album/01 New.wav", &wav_bytes("New")),
            ("Album/02 HasArt.wav", &has_art),
            ("Album/03 Skip.wav", &wav_bytes("Skip")),
            ("Album/cover.jpg", &jpeg(50, 50)),
        ]);
        let zip = write_zip(tmp.path(), "Album.zip", &bytes);
        let staging_root = tmp.path().join("cache").join(STAGING_DIR_NAME);
        let prepared = prepare_drop_paths(
            &[zip.to_string_lossy().into_owned()],
            true,
            &staging_root,
            MAX_TOTAL_UNCOMPRESSED_BYTES,
        );
        assert!(prepared.errors.is_empty(), "{:?}", prepared.errors);
        assert_eq!(prepared.artwork.len(), 3);

        // 取り込み計画の path がそのまま DropArtwork の audio_path と一致すること。
        let roots: Vec<PathBuf> = prepared.paths.iter().map(PathBuf::from).collect();
        let plan = crate::importer::plan_import(&db, &roots, |_, _| {}).unwrap();
        for p in &plan {
            assert!(
                prepared.artwork.iter().any(|a| a.audio_path == p.path),
                "{} not in artwork map",
                p.path
            );
        }
        let items: Vec<crate::models::ImportActionItem> = plan
            .iter()
            .map(|p| crate::models::ImportActionItem {
                path: p.path.clone(),
                action: if p.path.ends_with("03 Skip.wav") {
                    ItemAction::Skip
                } else {
                    ItemAction::Import
                },
                replace_track_id: None,
            })
            .collect();
        let summary = crate::importer::import_with_actions(&db, &items, |_, _| {});
        assert_eq!(summary.imported, 2);

        let s = embed_drop_artwork(&db, &staging_root, &summary.results, &prepared.artwork);
        assert_eq!(
            s,
            ArtworkEmbedSummary {
                embedded: 1,
                kept: 1,
                failed: 0
            }
        );

        let loc = |title: &str| -> String {
            db.get_all_tracks()
                .unwrap()
                .into_iter()
                .find(|t| t.name.as_deref() == Some(title))
                .and_then(|t| t.location_path)
                .unwrap()
        };
        // 整理先にコピーされた実ファイルに埋め込まれる (一時フォルダの方ではない)。
        let new_loc = loc("New");
        assert!(Path::new(&new_loc).starts_with(&lib), "{new_loc}");
        let (pic, _) = artwork::extract_picture(&new_loc).expect("embedded");
        assert_eq!(artwork::decode_image(&pic).unwrap().width(), 50);
        // 既存のアートワークは触らない (8x8 のまま)。
        let (pic, _) = artwork::extract_picture(&loc("Has Art")).unwrap();
        assert_eq!(artwork::decode_image(&pic).unwrap().width(), 8);

        // 一時フォルダの外の画像は使わない。
        let outside = tmp.path().join("evil.jpg");
        fs::write(&outside, jpeg(4, 4)).unwrap();
        let forged = vec![DropArtwork {
            audio_path: summary.results[0].path.clone(),
            image: outside.to_string_lossy().into_owned(),
        }];
        let s = embed_drop_artwork(&db, &staging_root, &summary.results, &forged);
        assert_eq!(s.embedded, 0);
    }
}
