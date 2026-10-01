//! 取り込んだ音声ファイルを `<root>/<AlbumArtist>/<Album>/<ファイル名>` へ物理整理する。
//!
//! フォルダ規則・サニタイズ規則は、実際に iTunes で整理済みの
//! `iTunes Media/Music/` ディレクトリ構造 (約 32,000 曲) を分析して確定した:
//!
//! - 階層は `<artist>/<album>/<file>` の 2 段。
//! - artist ディレクトリの出所: `Compilation` フラグ → `Compilations`、
//!   なければ Album Artist、なければ Artist、どちらも無ければ `Unknown Artist`。
//!   (実測: album_artist 31,326 / artist 284 / Compilations 192 / unknown 1)
//! - 禁止文字は **除去ではなく `_` へ置換** する (実測: 置換 1,291 / 除去 0)。
//!   例: `5/10` → `5_10`、`Eutopia / EMOTION` → `Eutopia _ EMOTION`。
//! - 末尾ドットは Windows で不可なため、末尾の `.` 1 個を `_` に置換する。
//!   例: `God knows...` → `God knows.._`、`e.p.` → `e.p_`。
//!
//! このモジュールは tauri / DB に依存しないため単体テスト可能。

use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag, TagType};

/// Windows / iTunes が許さないパス文字。各々 `_` に置換する。
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Windows の予約デバイス名 (拡張子の有無を問わず使えない)。
fn is_reserved(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or(&upper);
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1..9 / LPT1..9
    stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9')
}

/// パスコンポーネント (artist / album) 用サニタイズ。
///
/// 実 iTunes の挙動に合わせて、禁止文字は **除去せず `_` に置換** する。
pub fn sanitize_component(name: &str) -> String {
    // 1. 禁止文字を _ に置換。
    let replaced: String = name
        .chars()
        .map(|c| if FORBIDDEN.contains(&c) { '_' } else { c })
        .collect();

    // 2. 前後の空白を除去 (Windows は末尾の空白を許さない)。
    let mut result = replaced.trim().to_string();

    // `.` / `..` を含むドットだけの名前はパス要素として解釈させない。
    if !result.is_empty() && result.chars().all(|c| c == '.') {
        return "_".to_string();
    }

    // 3. 末尾ドットを _ に置換 (Windows は末尾ドットを許さない)。
    //    iTunes は末尾の "." 1 個だけを "_" にする ("a.." → "a._")。
    if result.ends_with('.') {
        result.pop();
        result.push('_');
    }

    // 4. 予約デバイス名は末尾に _ を付与。
    if is_reserved(&result) {
        result.push('_');
    }

    // 5. 空になったらプレースホルダ。
    if result.is_empty() {
        "_".to_string()
    } else {
        result
    }
}

/// artist ディレクトリ名を決める。
/// Compilation → `Compilations`、なければ Album Artist、なければ Artist、
/// どちらも空なら `Unknown Artist`。
fn pick_artist(artist: Option<&str>, album_artist: Option<&str>, compilation: bool) -> String {
    if compilation {
        return "Compilations".to_string();
    }
    let aa = album_artist.map(str::trim).filter(|s| !s.is_empty());
    let a = artist.map(str::trim).filter(|s| !s.is_empty());
    aa.or(a).unwrap_or("Unknown Artist").to_string()
}

/// ファイル名 (拡張子前の stem) 用サニタイズ。
///
/// ディレクトリ用の [`sanitize_component`] と違い、**末尾ドットは置換しない**。
/// ファイル名では後ろに拡張子が続くため末尾ドットにならず、実 iTunes も
/// `God knows....mp3` のようにタイトルのドットを保持している。
pub fn sanitize_title(name: &str) -> String {
    let result = name
        .chars()
        .map(|c| if FORBIDDEN.contains(&c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    // 拡張子が無い入力でもファイル名が `.` / `..` にならないよう防ぐ。
    if !result.is_empty() && result.chars().all(|c| c == '.') {
        "_".to_string()
    } else {
        result
    }
}

/// 整理対象トラックのメタデータ。`target_path` に渡す。
#[derive(Default)]
pub struct TrackMeta<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album_artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub compilation: bool,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub disc_count: Option<i64>,
}

/// iTunes 準拠のファイル名を組み立てる (拡張子は元ファイルから維持)。
///
/// 実ライブラリ約 32,000 曲の分析で確定した規則:
/// - トラック番号あり: `NN Title.ext` (2 桁ゼロ埋め、100 以上は自然桁)
/// - マルチディスク: `D-NN Title.ext`
///   (マルチディスク = Disc Number があり、かつ Disc Count が 1 でない)
/// - トラック番号なし: `Title.ext`
/// - タイトルが空なら元ファイル名の stem にフォールバック
pub fn build_file_name(
    title: Option<&str>,
    track_number: Option<i64>,
    disc_number: Option<i64>,
    disc_count: Option<i64>,
    source: &Path,
) -> String {
    let ext = source.extension().map(|s| s.to_string_lossy().to_string());

    let title_part = title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(sanitize_title)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            source
                .file_stem()
                .map(|s| sanitize_title(&s.to_string_lossy()))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "track".to_string());

    // マルチディスク = Disc Number があり、かつ Disc Count が 1 でない。
    // (Disc Count==1 の単一ディスクはプレフィックスを付けない、が実測の挙動)
    let multi_disc = disc_number.is_some() && disc_count != Some(1);

    let stem = match track_number {
        Some(n) if n > 0 => {
            if multi_disc {
                let d = disc_number.unwrap_or(1);
                format!("{}-{:02} {}", d, n, title_part)
            } else {
                format!("{:02} {}", n, title_part)
            }
        }
        _ => title_part,
    };

    match ext {
        Some(e) => format!("{}.{}", stem, e),
        None => stem,
    }
}

/// `<root>/<artist>/<album>/<iTunes 準拠ファイル名>` を組み立てる。
pub fn target_path(root: &Path, meta: &TrackMeta, source: &Path) -> PathBuf {
    let artist_dir = sanitize_component(&pick_artist(
        meta.artist,
        meta.album_artist,
        meta.compilation,
    ));
    let album_dir = sanitize_component(
        meta.album
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Unknown Album"),
    );
    let file_name = build_file_name(
        meta.title,
        meta.track_number,
        meta.disc_number,
        meta.disc_count,
        source,
    );
    root.join(artist_dir).join(album_dir).join(file_name)
}

/// 整理先ルートが設定されているときだけ relocate 先パスを返す。
///
/// 「タグをファイルへ書き戻す」ことと「ファイルを整理先へ移動する」ことを
/// 分離するための判定関数 (#163)。ルート未設定 (`None` / 空白のみ) は
/// 「整理しない」を意味する `None` を返し、呼び出し側はファイルを移動せず
/// タグ書き戻しだけを行う。
pub fn organize_target(root: Option<&str>, meta: &TrackMeta, source: &Path) -> Option<PathBuf> {
    let root = root.map(str::trim).filter(|s| !s.is_empty())?;
    Some(target_path(Path::new(root), meta, source))
}

/// 既存の別ファイルと衝突する場合 ` (2)` などを付けて回避する。
pub(crate) fn resolve_collision(target: &Path, source: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    // 同一ファイル (移動元 == 移動先) なら衝突ではない。
    if let (Ok(a), Ok(b)) = (target.canonicalize(), source.canonicalize()) {
        if a == b {
            return target.to_path_buf();
        }
    }
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = target.extension().map(|s| s.to_string_lossy().to_string());
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    for i in 2..10_000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    target.to_path_buf()
}

/// relocate のモード。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// 元ファイルを残す (インポート / D&D 時)。
    Copy,
    /// 元ファイルを移動する (メタデータ編集時)。
    Move,
}

/// ファイルを `target` へ relocate する。戻り値は実際の配置先パス (衝突回避後)。
pub fn relocate(source: &Path, target: &Path, mode: Mode) -> Result<PathBuf, String> {
    // 同一パスなら何もしない。
    if source == target {
        return Ok(target.to_path_buf());
    }
    let final_target = resolve_collision(target, source);
    if final_target == source {
        return Ok(final_target);
    }
    if let Some(parent) = final_target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    match mode {
        Mode::Copy => {
            std::fs::copy(source, &final_target).map_err(|e| format!("copy failed: {e}"))?;
        }
        Mode::Move => {
            // rename は同一デバイス内のみ成功。失敗したら copy + remove にフォールバック。
            if std::fs::rename(source, &final_target).is_err() {
                std::fs::copy(source, &final_target).map_err(|e| format!("copy failed: {e}"))?;
                std::fs::remove_file(source).map_err(|e| format!("remove failed: {e}"))?;
            }
        }
    }
    Ok(final_target)
}

/// 実ファイルに書き戻すタグ値。`None` のフィールドは触らない (既存タグを保持)。
#[derive(Default)]
pub struct TagWrite<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album_artist: Option<&'a str>,
    pub composer: Option<&'a str>,
    pub album: Option<&'a str>,
    pub genre: Option<&'a str>,
    pub comments: Option<&'a str>,
    pub year: Option<i64>,
    pub track_number: Option<i64>,
    pub track_count: Option<i64>,
    pub disc_number: Option<i64>,
    pub disc_count: Option<i64>,
    pub compilation: Option<bool>,
    /// BPM。整数へ丸めて書き込む (タグ側が整数しか持てないため)。
    pub bpm: Option<f64>,
    /// キー。音楽表記 ("Am" / "F#m" / "C") を `InitialKey` へ書く。
    /// Camelot ("8A") は DJ ソフトが解釈しないので書かない。
    /// 空文字を渡すとキーごと除去する (クリア)。
    pub key: Option<String>,
}

/// 解析結果の `key_name` ("A minor" / "F# major") を、DJ ソフトが読む
/// `InitialKey` の表記 ("Am" / "F#") へ変換する。解釈できなければ `None`。
///
/// rekordbox / Serato / Traktor は TKEY 等に入る **音楽表記** を読む。
/// Camelot ("8A") はそのまま書いても解釈されないため、この関数は
/// 音名で始まらない入力 (Camelot を含む) を `None` として弾く。
pub fn key_name_to_initial_key(key_name: &str) -> Option<String> {
    let s = key_name.trim();
    if s.is_empty() {
        return None;
    }
    let mut parts = s.split_whitespace();
    let tonic_raw = parts.next()?;
    let quality_raw = parts.next();
    // 3 語以上 ("A minor something") は解釈しない。
    if parts.next().is_some() {
        return None;
    }

    let mut chars = tonic_raw.chars();
    // 1 文字目は音名 A..G のみ。数字始まり (Camelot "8A") はここで弾かれる。
    let letter = chars.next()?.to_ascii_uppercase();
    if !letter.is_ascii_alphabetic() || !('A'..='G').contains(&letter) {
        return None;
    }
    let rest: Vec<char> = chars.collect();

    // 変化記号 (# / b、ユニコードの ♯ / ♭ も受ける)。
    let mut idx = 0;
    let accidental = match rest.first() {
        Some('#' | '\u{266f}') => {
            idx = 1;
            "#"
        }
        Some('b' | '\u{266d}') => {
            idx = 1;
            "b"
        }
        _ => "",
    };

    let minor = match quality_raw {
        // "A minor" 形式。残りは音名 + 変化記号だけのはず。
        Some(q) => {
            if rest.len() != idx {
                return None;
            }
            match q {
                "M" => false,
                _ => match q.to_ascii_lowercase().as_str() {
                    "minor" | "min" | "m" => true,
                    "major" | "maj" => false,
                    _ => return None,
                },
            }
        }
        // "Am" / "C" のような 1 語形式。
        None => match rest.get(idx) {
            None => false,
            Some('m' | 'M') if rest.len() == idx + 1 => rest[idx] == 'm',
            _ => return None,
        },
    };

    Some(format!(
        "{letter}{accidental}{}",
        if minor { "m" } else { "" }
    ))
}

/// lofty で実ファイルのプライマリタグを更新して保存する。
/// 他アプリ (rekordbox 等) でも編集後のメタデータが正しく見えるようにするため。
pub fn write_tags(path: &Path, w: &TagWrite) -> Result<(), String> {
    let mut tagged = Probe::open(path)
        .map_err(|e| format!("open failed: {e}"))?
        .read()
        .map_err(|e| format!("probe failed: {e}"))?;

    // プライマリタグが無ければファイル種別に応じて新規作成。
    if tagged.primary_tag_mut().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("no primary tag")?;

    if let Some(v) = w.title {
        tag.set_title(v.to_string());
    }
    if let Some(v) = w.artist {
        tag.set_artist(v.to_string());
    }
    if let Some(v) = w.album {
        tag.set_album(v.to_string());
    }
    if let Some(v) = w.genre {
        tag.set_genre(v.to_string());
    }
    if let Some(v) = w.album_artist {
        // Accessor に album_artist が無いので ItemKey で直接挿入。
        tag.insert_text(ItemKey::AlbumArtist, v.to_string());
    }
    if let Some(v) = w.composer {
        // Accessor が無いので ItemKey で直接操作。空文字はキーごと除去 (クリア)。
        if v.is_empty() {
            tag.remove_key(&ItemKey::Composer);
        } else {
            tag.insert_text(ItemKey::Composer, v.to_string());
        }
    }
    if let Some(v) = w.comments {
        // comments も同様。空文字はキーごと除去 (クリア)。
        if v.is_empty() {
            tag.remove_key(&ItemKey::Comment);
        } else {
            tag.insert_text(ItemKey::Comment, v.to_string());
        }
    }
    if let Some(y) = w.year {
        if y > 0 {
            tag.set_year(y as u32);
        }
    }
    if let Some(n) = w.track_number {
        if n > 0 {
            tag.set_track(n as u32);
        }
    }
    if let Some(n) = w.track_count {
        if n > 0 {
            tag.set_track_total(n as u32);
        }
    }
    if let Some(n) = w.disc_number {
        if n > 0 {
            tag.set_disk(n as u32);
        }
    }
    if let Some(n) = w.disc_count {
        if n > 0 {
            tag.set_disk_total(n as u32);
        }
    }
    if let Some(c) = w.compilation {
        // Accessor が無いので ItemKey で直接挿入 ("1"/"0")。他アプリの判定に合わせる。
        tag.insert_text(
            ItemKey::FlagCompilation,
            if c { "1" } else { "0" }.to_string(),
        );
    }

    if let Some(b) = w.bpm {
        // BPM の ItemKey はフォーマットで分かれる。ID3v2 (TBPM) / MP4 (tmpo) は
        // 整数の `IntegerBpm`、Vorbis Comments (FLAC/Ogg) は "BPM" に対応する `Bpm`。
        // lofty はマッピングの無い ItemKey を黙って捨てるため、タグ種別で選ぶ。
        let rounded = b.round();
        if rounded >= 1.0 {
            let key = match tag.tag_type() {
                TagType::VorbisComments => ItemKey::Bpm,
                _ => ItemKey::IntegerBpm,
            };
            tag.insert_text(key, format!("{}", rounded as i64));
        }
    }
    if let Some(ref k) = w.key {
        // rekordbox / Serato / Traktor が読む InitialKey
        // (ID3v2 TKEY / MP4 ----:com.apple.iTunes:initialkey / Vorbis INITIALKEY)。
        // 値は音楽表記 ("Am" 等)。空文字はキーごと除去 (クリア)。
        if k.is_empty() {
            tag.remove_key(&ItemKey::InitialKey);
        } else {
            tag.insert_text(ItemKey::InitialKey, k.clone());
        }
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("save tags failed: {e}"))?;
    Ok(())
}

/// DB の `location_path` が指す実ファイルへタグを書き戻す。
///
/// パスが無い / 空 / ファイルが存在しない場合は何もしない (= 失敗ではない)。
/// 書き込みを試みて失敗したときだけ `true` を返す (呼び出し側は
/// `fileWriteFailed` として利用者へ伝える)。
///
/// この関数は整理 (フォルダ移動) を一切行わない。移動は整理先ルートが
/// 設定されている場合にのみ [`organize_target`] + [`relocate`] で別途行う。
/// GUI コマンドと HTTP API の双方がこの 1 か所を呼ぶことで、
/// 「整理先未設定だとタグが書き戻されない」差異をなくす (#163)。
pub fn write_tags_to_location(loc: Option<&str>, w: &TagWrite) -> bool {
    let Some(loc) = loc else { return false };
    if loc.trim().is_empty() {
        return false;
    }
    let path = Path::new(loc);
    if !path.exists() {
        return false;
    }
    if let Err(e) = write_tags(path, w) {
        eprintln!("write_tags failed for {loc}: {e}");
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 依存を増やさず一意な一時ディレクトリを作る (tempfile クレート不使用)。
    fn unique_tmp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("organizer_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_replaces_forbidden_with_underscore() {
        // 実 iTunes は除去ではなく置換。
        assert_eq!(sanitize_component("5/10"), "5_10");
        assert_eq!(sanitize_component("Eutopia / EMOTION"), "Eutopia _ EMOTION");
        assert_eq!(
            sanitize_component(r#"a:b*c?d"e<f>g|h\i"#),
            "a_b_c_d_e_f_g_h_i"
        );
    }

    #[test]
    fn sanitize_handles_trailing_dot() {
        // 末尾の "." 1 個だけを "_" に。
        assert_eq!(sanitize_component("e.p."), "e.p_");
        assert_eq!(sanitize_component("God knows..."), "God knows.._");
        assert_eq!(sanitize_component("normal"), "normal");
    }

    #[test]
    fn sanitize_replaces_dot_only_components() {
        assert_eq!(sanitize_component("."), "_");
        assert_eq!(sanitize_component(".."), "_");
        assert_eq!(sanitize_component("..."), "_");
        assert_eq!(sanitize_component("  ..  "), "_");
        assert_eq!(sanitize_title("."), "_");
        assert_eq!(sanitize_title(".."), "_");
        assert_eq!(sanitize_title("..."), "_");
    }

    #[test]
    fn sanitize_trims_and_falls_back() {
        assert_eq!(sanitize_component("  spaced  "), "spaced");
        assert_eq!(sanitize_component("///"), "___");
        assert_eq!(sanitize_component(""), "_");
        assert_eq!(sanitize_component("   "), "_");
    }

    #[test]
    fn sanitize_reserved_names() {
        assert_eq!(sanitize_component("CON"), "CON_");
        assert_eq!(sanitize_component("nul"), "nul_");
        assert_eq!(sanitize_component("COM1"), "COM1_");
        assert_eq!(sanitize_component("LPT9"), "LPT9_");
        // 予約名でないものはそのまま。
        assert_eq!(sanitize_component("COM0"), "COM0");
        assert_eq!(sanitize_component("CONSOLE"), "CONSOLE");
    }

    #[test]
    fn sanitize_title_keeps_trailing_dot() {
        // ファイル名のタイトルは末尾ドットを保持 (拡張子が続くため)。
        assert_eq!(sanitize_title("God knows..."), "God knows...");
        assert_eq!(sanitize_title("5/10"), "5_10");
        assert_eq!(sanitize_title("  trim me  "), "trim me");
    }

    #[test]
    fn build_file_name_with_track_number() {
        let src = Path::new("/in/whatever.mp3");
        assert_eq!(
            build_file_name(Some("Psychopolis"), Some(1), None, None, src),
            "01 Psychopolis.mp3"
        );
        // 100 以上は自然桁。
        assert_eq!(
            build_file_name(Some("Tart"), Some(103), None, None, src),
            "103 Tart.mp3"
        );
    }

    #[test]
    fn build_file_name_multi_disc() {
        let src = Path::new("/in/x.flac");
        // Disc Number あり & Disc Count != 1 → D-NN プレフィックス。
        assert_eq!(
            build_file_name(Some("雨の日の噴水"), Some(1), Some(1), None, src),
            "1-01 雨の日の噴水.flac"
        );
        assert_eq!(
            build_file_name(Some("Track"), Some(2), Some(2), Some(2), src),
            "2-02 Track.flac"
        );
        // Disc Count==1 はプレフィックスを付けない。
        assert_eq!(
            build_file_name(Some("Track"), Some(5), Some(1), Some(1), src),
            "05 Track.flac"
        );
    }

    #[test]
    fn build_file_name_no_track_number() {
        let src = Path::new("/in/orig.m4a");
        assert_eq!(
            build_file_name(Some("Just A Title"), None, None, None, src),
            "Just A Title.m4a"
        );
        // タイトルが空なら元ファイル名 stem にフォールバック。
        assert_eq!(build_file_name(None, None, None, None, src), "orig.m4a");
        assert_eq!(
            build_file_name(Some("   "), Some(0), None, None, src),
            "orig.m4a"
        );
    }

    fn meta<'a>(
        title: Option<&'a str>,
        artist: Option<&'a str>,
        album_artist: Option<&'a str>,
        album: Option<&'a str>,
        compilation: bool,
        track_number: Option<i64>,
    ) -> TrackMeta<'a> {
        TrackMeta {
            title,
            artist,
            album_artist,
            album,
            compilation,
            track_number,
            disc_number: None,
            disc_count: None,
        }
    }

    #[test]
    fn target_path_prefers_album_artist() {
        let root = Path::new("/lib");
        let src = Path::new("/in/raw.mp3");
        let m = meta(
            Some("Song"),
            Some("Track Artist"),
            Some("Album Artist"),
            Some("My Album"),
            false,
            Some(1),
        );
        let p = target_path(root, &m, src);
        assert_eq!(p, Path::new("/lib/Album Artist/My Album/01 Song.mp3"));
    }

    #[test]
    fn target_path_falls_back_to_artist() {
        let root = Path::new("/lib");
        let src = Path::new("/in/raw.flac");
        let m = meta(
            Some("Tune"),
            Some("Just Artist"),
            None,
            Some("Alb"),
            false,
            None,
        );
        let p = target_path(root, &m, src);
        assert_eq!(p, Path::new("/lib/Just Artist/Alb/Tune.flac"));
    }

    #[test]
    fn target_path_keeps_dot_only_metadata_beneath_root() {
        let root = Path::new("/lib");
        let src = Path::new("/in/raw.flac");
        for artist in [".", ".."] {
            let m = meta(Some(".."), Some(artist), None, Some(".."), false, None);
            let path = target_path(root, &m, src);
            assert_eq!(path, Path::new("/lib/_/_/_.flac"));
            assert!(path.starts_with(root));
        }
    }

    #[test]
    fn target_path_unknown_fallbacks() {
        let root = Path::new("/lib");
        let src = Path::new("/in/x.mp3");
        let m = meta(None, None, None, None, false, None);
        let p = target_path(root, &m, src);
        // タイトル無し → 元 stem "x"。
        assert_eq!(p, Path::new("/lib/Unknown Artist/Unknown Album/x.mp3"));
        // 空文字も Unknown 扱い。
        let m2 = meta(Some("T"), Some(""), Some("  "), Some(""), false, None);
        let p2 = target_path(root, &m2, src);
        assert_eq!(p2, Path::new("/lib/Unknown Artist/Unknown Album/T.mp3"));
    }

    #[test]
    fn target_path_compilation_goes_to_compilations() {
        let root = Path::new("/lib");
        let src = Path::new("/in/x.mp3");
        // Compilation フラグは album_artist より優先される。
        let m = meta(
            Some("Hit"),
            Some("A"),
            Some("Various Artists"),
            Some("Hits"),
            true,
            Some(3),
        );
        let p = target_path(root, &m, src);
        assert_eq!(p, Path::new("/lib/Compilations/Hits/03 Hit.mp3"));
    }

    #[test]
    fn organize_target_is_none_without_root() {
        // #163: 整理先ルート未設定なら「移動しない」。
        // (タグ書き戻しはこの判定とは独立に常に行われる)
        let src = Path::new("/in/x.mp3");
        let m = meta(Some("Song"), Some("A"), None, Some("Alb"), false, Some(1));
        assert_eq!(organize_target(None, &m, src), None);
        assert_eq!(organize_target(Some(""), &m, src), None);
        assert_eq!(organize_target(Some("   "), &m, src), None);
    }

    #[test]
    fn organize_target_matches_target_path_with_root() {
        // ルートが設定されている場合の挙動は target_path と完全に同じ。
        let src = Path::new("/in/x.mp3");
        let m = meta(Some("Song"), Some("A"), None, Some("Alb"), false, Some(1));
        assert_eq!(
            organize_target(Some("/lib"), &m, src),
            Some(PathBuf::from("/lib/A/Alb/01 Song.mp3"))
        );
        // 前後の空白は落として扱う。
        assert_eq!(
            organize_target(Some(" /lib "), &m, src),
            Some(target_path(Path::new("/lib"), &m, src))
        );
    }

    #[test]
    fn key_name_to_initial_key_converts_analyzer_output() {
        // analyzer/features.rs の key_name は "<音名> <minor|major>" 形式。
        assert_eq!(key_name_to_initial_key("A minor").as_deref(), Some("Am"));
        assert_eq!(key_name_to_initial_key("C major").as_deref(), Some("C"));
        assert_eq!(key_name_to_initial_key("F# minor").as_deref(), Some("F#m"));
        assert_eq!(key_name_to_initial_key("D# major").as_deref(), Some("D#"));
        assert_eq!(key_name_to_initial_key(" G  minor ").as_deref(), Some("Gm"));
        // フラット表記も受ける。
        assert_eq!(key_name_to_initial_key("Bb minor").as_deref(), Some("Bbm"));
    }

    #[test]
    fn key_name_to_initial_key_accepts_compact_forms() {
        assert_eq!(key_name_to_initial_key("Am").as_deref(), Some("Am"));
        assert_eq!(key_name_to_initial_key("am").as_deref(), Some("Am"));
        assert_eq!(key_name_to_initial_key("C").as_deref(), Some("C"));
        assert_eq!(key_name_to_initial_key("f#m").as_deref(), Some("F#m"));
        assert_eq!(key_name_to_initial_key("Bb").as_deref(), Some("Bb"));
    }

    #[test]
    fn key_name_to_initial_key_rejects_camelot_and_garbage() {
        // Camelot は DJ ソフトが InitialKey として解釈しないので弾く。
        assert_eq!(key_name_to_initial_key("8A"), None);
        assert_eq!(key_name_to_initial_key("12B"), None);
        assert_eq!(key_name_to_initial_key(""), None);
        assert_eq!(key_name_to_initial_key("   "), None);
        assert_eq!(key_name_to_initial_key("Unknown"), None);
        assert_eq!(key_name_to_initial_key("H minor"), None);
        assert_eq!(key_name_to_initial_key("A dorian"), None);
        assert_eq!(key_name_to_initial_key("A minor ish"), None);
    }

    #[test]
    fn write_tags_to_location_skips_missing_paths() {
        // パス無し / 空 / 実体無し は「書き込み失敗」ではない。
        let w = TagWrite::default();
        assert!(!write_tags_to_location(None, &w));
        assert!(!write_tags_to_location(Some(""), &w));
        assert!(!write_tags_to_location(Some("   "), &w));
        let missing = unique_tmp_dir().join("nope.mp3");
        assert!(!write_tags_to_location(
            Some(&missing.to_string_lossy()),
            &w
        ));
    }

    #[test]
    fn relocate_copy_keeps_source() {
        let dir = unique_tmp_dir();
        let src = dir.join("src.txt");
        std::fs::write(&src, b"hello").unwrap();
        let target = dir.join("a/b/dst.txt");
        let dest = relocate(&src, &target, Mode::Copy).unwrap();
        assert_eq!(dest, target);
        assert!(src.exists(), "copy は元を残す");
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    #[test]
    fn relocate_move_removes_source() {
        let dir = unique_tmp_dir();
        let src = dir.join("src.txt");
        std::fs::write(&src, b"data").unwrap();
        let target = dir.join("artist/album/src.txt");
        let dest = relocate(&src, &target, Mode::Move).unwrap();
        assert_eq!(dest, target);
        assert!(!src.exists(), "move は元を消す");
        assert_eq!(std::fs::read(&dest).unwrap(), b"data");
    }

    #[test]
    fn relocate_resolves_collision() {
        let dir = unique_tmp_dir();
        let src = dir.join("src.mp3");
        std::fs::write(&src, b"new").unwrap();
        // 既に別ファイルがある所へコピー。
        let occupied = dir.join("out/song.mp3");
        std::fs::create_dir_all(occupied.parent().unwrap()).unwrap();
        std::fs::write(&occupied, b"existing").unwrap();
        let dest = relocate(&src, &occupied, Mode::Copy).unwrap();
        assert_eq!(dest, dir.join("out/song (2).mp3"));
        assert_eq!(
            std::fs::read(&occupied).unwrap(),
            b"existing",
            "既存は壊さない"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn relocate_same_path_is_noop() {
        let dir = unique_tmp_dir();
        let src = dir.join("same.txt");
        std::fs::write(&src, b"x").unwrap();
        let dest = relocate(&src, &src, Mode::Move).unwrap();
        assert_eq!(dest, src);
        assert!(src.exists());
    }
}
