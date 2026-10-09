//! Traktor `collection.nml` の読み取り (USB 書き出し時のキュー / ビートグリッド取り込み用)。
//!
//! crateforge はキューやグリッドを DB に持たない。USB 書き出しの **その時だけ** ユーザーの
//! Traktor コレクションを読み、ファイルパスで crateforge の曲と突き合わせて、
//! rbx-cli の汎用 `cues` / `beatGrid` へ変換する (`mapping.rs`)。メタデータは使わない
//! (タイトル等は crateforge の DB が常に優先)。
//!
//! - NML は数十 MB になり得るので quick-xml でストリーミング解析し、必要な要素
//!   (`COLLECTION/ENTRY` の `LOCATION` / `INFO` / `TEMPO` / `CUE_V2`) だけ拾う。
//! - 解析結果は「パス + mtime + サイズ」をキーにセッション中メモリへキャッシュする。
//! - 既定の場所は `~/Documents/Native Instruments/Traktor */collection.nml` の最新版。

pub mod mapping;
pub mod path;

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

pub use path::{MatchKind, NmlIndex};

/// コレクションの 1 曲 (必要な属性だけ)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NmlEntry {
    /// `LOCATION@VOLUME` (macOS はボリューム名、Windows は `C:` 等)。
    pub volume: String,
    /// `LOCATION@DIR` (`/:` 区切り、例 `/:Users/:me/:Music/:`)。
    pub dir: String,
    /// `LOCATION@FILE`。
    pub file: String,
    /// `INFO@FILESIZE` (KB 単位)。
    pub file_size_kb: Option<u64>,
    /// `TEMPO@BPM`。
    pub bpm: Option<f64>,
    pub cues: Vec<NmlCue>,
}

/// `CUE_V2` 1 個。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NmlCue {
    pub name: String,
    /// 0 cue / 1 fade-in / 2 fade-out / 3 load / 4 grid / 5 loop。
    pub kind: i32,
    pub start_ms: f64,
    pub len_ms: f64,
    /// 0..7 = ホットキュー 1..8、-1 = ホットキュー無し (メモリーキュー扱い)。
    pub hotcue: i32,
}

/// NML 全体をストリーミングで読み、`COLLECTION` 直下の `ENTRY` を返す。
/// PLAYLISTS 内の `ENTRY` (PRIMARYKEY 参照) は無視する。
pub fn parse_reader<R: BufRead>(reader: R) -> Result<Vec<NmlEntry>, String> {
    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);
    let mut buf = Vec::with_capacity(4096);
    let mut entries = Vec::new();
    let mut in_collection = false;
    let mut current: Option<NmlEntry> = None;
    loop {
        let event = xml.read_event_into(&mut buf).map_err(|e| {
            format!(
                "NML の解析に失敗しました (位置 {}): {e}",
                xml.buffer_position()
            )
        })?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(event, Event::Empty(_));
                match e.name().as_ref() {
                    b"COLLECTION" if !is_empty => in_collection = true,
                    b"ENTRY" if in_collection && current.is_none() => {
                        if is_empty {
                            entries.push(NmlEntry::default());
                        } else {
                            current = Some(NmlEntry::default());
                        }
                    }
                    name => {
                        if let Some(entry) = current.as_mut() {
                            read_child(entry, name, e);
                        }
                    }
                }
            }
            Event::End(ref e) => match e.name().as_ref() {
                b"COLLECTION" => in_collection = false,
                b"ENTRY" => {
                    if let Some(entry) = current.take() {
                        entries.push(entry);
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(entries)
}

/// 文字列から読む (テスト用・小さい NML 用)。
#[allow(dead_code)]
pub fn parse_str(text: &str) -> Result<Vec<NmlEntry>, String> {
    parse_reader(text.as_bytes())
}

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
}

fn attr_f64(e: &BytesStart, key: &[u8]) -> Option<f64> {
    attr(e, key)
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn read_child(entry: &mut NmlEntry, name: &[u8], e: &BytesStart) {
    match name {
        b"LOCATION" => {
            entry.volume = attr(e, b"VOLUME").unwrap_or_default();
            entry.dir = attr(e, b"DIR").unwrap_or_default();
            entry.file = attr(e, b"FILE").unwrap_or_default();
        }
        b"INFO" => {
            entry.file_size_kb = attr(e, b"FILESIZE").and_then(|v| v.trim().parse::<u64>().ok());
        }
        b"TEMPO" => {
            entry.bpm = attr_f64(e, b"BPM").filter(|b| *b > 0.0);
        }
        b"CUE_V2" => {
            let Some(start_ms) = attr_f64(e, b"START") else {
                return;
            };
            entry.cues.push(NmlCue {
                name: attr(e, b"NAME").unwrap_or_default(),
                kind: attr(e, b"TYPE")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0),
                start_ms,
                len_ms: attr_f64(e, b"LEN").unwrap_or(0.0),
                hotcue: attr(e, b"HOTCUE")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(-1),
            });
        }
        _ => {}
    }
}

// ============================================================ cache

#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheKey {
    path: PathBuf,
    modified: Option<SystemTime>,
    size: u64,
}

type Cached = Option<(CacheKey, Arc<NmlIndex>)>;

static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();

/// NML を読み込んで照合用インデックスを返す。同じファイル (パス + mtime + サイズ) なら
/// 2 回目以降はセッション中のキャッシュを返す。
pub fn load_cached(nml: &Path) -> Result<Arc<NmlIndex>, String> {
    let meta = std::fs::metadata(nml).map_err(|e| {
        format!(
            "Traktor のコレクションを開けません ({}): {e}",
            nml.display()
        )
    })?;
    let key = CacheKey {
        path: nml.to_path_buf(),
        modified: meta.modified().ok(),
        size: meta.len(),
    };
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((k, index)) = cache.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *k == key {
            return Ok(index.clone());
        }
    }
    let file = File::open(nml).map_err(|e| {
        format!(
            "Traktor のコレクションを開けません ({}): {e}",
            nml.display()
        )
    })?;
    let entries = parse_reader(BufReader::with_capacity(256 * 1024, file))?;
    let index = Arc::new(NmlIndex::new(entries, path::PathStyle::native()));
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, index.clone()));
    Ok(index)
}

// ============================================================ auto-detect

/// `<Documents>/Native Instruments/Traktor <version>/collection.nml` のうち最新版を返す。
/// `documents` は候補の Documents フォルダ (先に見つかったものを優先)。
pub fn detect_default(documents: &[PathBuf]) -> Option<PathBuf> {
    for docs in documents {
        let ni = docs.join("Native Instruments");
        let Ok(read) = std::fs::read_dir(&ni) else {
            continue;
        };
        let mut best: Option<(Vec<u64>, PathBuf)> = None;
        for dirent in read.flatten() {
            let name = dirent.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix("Traktor") else {
                continue;
            };
            let nml = dirent.path().join("collection.nml");
            if !nml.is_file() {
                continue;
            }
            let version = parse_version(rest);
            if best.as_ref().is_none_or(|(v, _)| version > *v) {
                best = Some((version, nml));
            }
        }
        if let Some((_, nml)) = best {
            return Some(nml);
        }
    }
    None
}

/// `" 3.11.1"` / `" Pro 2.6"` → `[3, 11, 1]` / `[2, 6]`。数字が無ければ空 (最も古い扱い)。
fn parse_version(text: &str) -> Vec<u64> {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    digits
        .split('.')
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<MUSICFOLDERS></MUSICFOLDERS>
<COLLECTION ENTRIES="3">
<ENTRY MODIFIED_DATE="2024/5/1" TITLE="Song &amp; Dance" ARTIST="Someone">
<LOCATION DIR="/:Users/:dj/:Music/:House/:" FILE="Song &amp; Dance.mp3" VOLUME="Macintosh HD" VOLUMEID="Macintosh HD"></LOCATION>
<ALBUM TRACK="1" TITLE="Album"></ALBUM>
<INFO BITRATE="320000" GENRE="House" PLAYTIME="300" FILESIZE="11720"></INFO>
<TEMPO BPM="124.000000" BPM_QUALITY="100.000000"></TEMPO>
<CUE_V2 NAME="AutoGrid" DISPL_ORDER="0" TYPE="4" START="35.123" LEN="0.000000" REPEATS="-1" HOTCUE="0"></CUE_V2>
<CUE_V2 NAME="Drop" DISPL_ORDER="0" TYPE="0" START="60000.5" LEN="0.000000" REPEATS="-1" HOTCUE="1"></CUE_V2>
<CUE_V2 NAME="n.n." DISPL_ORDER="0" TYPE="5" START="90000" LEN="7741.9" REPEATS="-1" HOTCUE="-1"></CUE_V2>
</ENTRY>
<ENTRY TITLE="No cues">
<LOCATION DIR="/:Music/:" FILE="b.flac" VOLUME="E:" VOLUMEID="1234"/>
<INFO FILESIZE="30000"/>
</ENTRY>
<ENTRY TITLE="Empty"/>
</COLLECTION>
<SETS ENTRIES="0"></SETS>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
<NODE TYPE="PLAYLIST" NAME="P"><PLAYLIST ENTRIES="1" TYPE="LIST" UUID="x">
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:Users/:dj/:Music/:House/:Song &amp; Dance.mp3"></PRIMARYKEY></ENTRY>
</PLAYLIST></NODE></SUBNODES></NODE></PLAYLISTS>
</NML>"#;

    #[test]
    fn parses_collection_entries_only() {
        let entries = parse_str(SAMPLE).unwrap();
        assert_eq!(entries.len(), 3, "playlist ENTRY elements must be ignored");
        let a = &entries[0];
        assert_eq!(a.volume, "Macintosh HD");
        assert_eq!(a.dir, "/:Users/:dj/:Music/:House/:");
        assert_eq!(a.file, "Song & Dance.mp3");
        assert_eq!(a.file_size_kb, Some(11720));
        assert_eq!(a.bpm, Some(124.0));
        assert_eq!(a.cues.len(), 3);
        assert_eq!(
            a.cues[0],
            NmlCue {
                name: "AutoGrid".into(),
                kind: 4,
                start_ms: 35.123,
                len_ms: 0.0,
                hotcue: 0
            }
        );
        assert_eq!(a.cues[2].kind, 5);
        assert_eq!(a.cues[2].len_ms, 7741.9);
        assert_eq!(a.cues[2].hotcue, -1);

        let b = &entries[1];
        assert_eq!(b.volume, "E:");
        assert_eq!(b.file, "b.flac");
        assert_eq!(b.bpm, None);
        assert!(b.cues.is_empty());
        assert_eq!(entries[2], NmlEntry::default());
    }

    #[test]
    fn malformed_xml_is_an_error() {
        let err = parse_str("<NML><COLLECTION><ENTRY></COLLECTION>").unwrap_err();
        assert!(err.contains("NML"), "{err}");
    }

    #[test]
    fn version_parsing_orders_traktor_folders() {
        assert_eq!(parse_version(" 3.11.1"), vec![3, 11, 1]);
        assert_eq!(parse_version(" Pro 2.6"), vec![2, 6]);
        assert!(parse_version(" 4.0") > parse_version(" 3.11.1"));
        assert!(parse_version(" 3.11.1") > parse_version(" 3.2.0"));
        assert_eq!(parse_version(""), Vec::<u64>::new());
    }

    #[test]
    fn detects_the_newest_collection() {
        let tmp = tempfile::tempdir().unwrap();
        let docs = tmp.path().join("Documents");
        for (dir, with_nml) in [
            ("Traktor 3.2.0", true),
            ("Traktor 3.11.1", true),
            ("Traktor 4.1.0", false),
            ("Maschine 2", true),
        ] {
            let d = docs.join("Native Instruments").join(dir);
            std::fs::create_dir_all(&d).unwrap();
            if with_nml {
                std::fs::write(d.join("collection.nml"), "<NML/>").unwrap();
            }
        }
        let found = detect_default(&[tmp.path().join("missing"), docs.clone()]).unwrap();
        assert!(
            found.ends_with("Traktor 3.11.1/collection.nml"),
            "{found:?}"
        );
        assert_eq!(detect_default(&[tmp.path().join("missing")]), None);
    }

    #[test]
    fn load_cached_reuses_until_the_file_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let nml = tmp.path().join("collection.nml");
        std::fs::write(&nml, SAMPLE).unwrap();
        let a = load_cached(&nml).unwrap();
        let b = load_cached(&nml).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(a.len(), 3);
        // サイズが変われば読み直す。
        std::fs::write(&nml, SAMPLE.replace("<ENTRY TITLE=\"Empty\"/>", "")).unwrap();
        let c = load_cached(&nml).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(c.len(), 2);
    }
}
