//! NML の `LOCATION` → ネイティブパス変換と、crateforge の曲との突き合わせ。
//!
//! - `DIR` は `/:` 区切り (`/:Users/:me/:Music/:`)。
//! - macOS: `VOLUME` はボリューム名。外部ボリュームなら `/Volumes/<VOLUME>/<dir>/<file>`、
//!   起動ボリュームなら `/<dir>/<file>`。ボリューム付きのキーを優先して照合し、ボリュームを
//!   含まない `/<dir>/<file>` (bare キー) は補助として使う。クローン / バックアップ用の
//!   ボリュームが同じフォルダ構成を持つと bare キーが複数のボリュームで重なるので、その場合は
//!   起動ボリューム (実行時に `/Volumes/<v>` のうち `/` を指すものから判定) のエントリが
//!   あればそれを、無ければ **曖昧として対応付けない** (レポートに出す)。
//! - Windows: `VOLUME` はドライブ (`C:`) → `C:\<dir>\<file>`。
//! - 照合キーは Unicode NFC + 区切り `/` 統一 + (macOS / Windows は) 小文字化。
//! - パスが一致しなければ「ファイル名 + サイズ」(NML の `FILESIZE` は KB) で一意に決まる
//!   場合だけフォールバックで採用する。

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

use super::NmlEntry;

/// パスの流儀 (テストで OS を差し替えられるよう明示する)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathStyle {
    Mac,
    Windows,
    /// Linux 等 (Traktor は無いが開発・テスト用。macOS と同じ規則で大文字小文字を区別)。
    Unix,
}

impl PathStyle {
    pub fn native() -> Self {
        if cfg!(target_os = "macos") {
            PathStyle::Mac
        } else if cfg!(target_os = "windows") {
            PathStyle::Windows
        } else {
            PathStyle::Unix
        }
    }

    /// ファイルシステムが (既定で) 大文字小文字を区別しないか。
    pub fn case_insensitive(self) -> bool {
        matches!(self, PathStyle::Mac | PathStyle::Windows)
    }
}

fn dir_components(dir: &str) -> Vec<&str> {
    dir.split("/:")
        .flat_map(|part| part.split('/'))
        .filter(|p| !p.is_empty())
        .collect()
}

/// `LOCATION` から作るネイティブパスの候補。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidates {
    /// ボリュームまで含むパス (macOS は `/Volumes/<VOLUME>/…`、Windows はドライブ / UNC 付き)。
    pub qualified: Option<String>,
    /// ボリュームを含まないパス `/<dir>/<file>` (macOS / Unix のみ。起動ボリューム上ならこれ)。
    pub bare: Option<String>,
}

/// `LOCATION` からネイティブパスの候補を作る。
pub fn native_candidates(volume: &str, dir: &str, file: &str, style: PathStyle) -> Candidates {
    if file.is_empty() {
        return Candidates {
            qualified: None,
            bare: None,
        };
    }
    let parts = dir_components(dir);
    match style {
        PathStyle::Windows => {
            let mut path = String::new();
            if volume.ends_with(':') {
                path.push_str(volume);
            } else if !volume.is_empty() {
                // ドライブ文字以外 (ネットワーク共有名など) は UNC として扱う。
                path.push_str("\\\\");
                path.push_str(volume);
            }
            for p in &parts {
                path.push('\\');
                path.push_str(p);
            }
            path.push('\\');
            path.push_str(file);
            Candidates {
                qualified: Some(path),
                bare: None,
            }
        }
        PathStyle::Mac | PathStyle::Unix => {
            let mut rel = String::new();
            for p in &parts {
                rel.push('/');
                rel.push_str(p);
            }
            rel.push('/');
            rel.push_str(file);
            Candidates {
                qualified: (!volume.is_empty()).then(|| format!("/Volumes/{volume}{rel}")),
                bare: Some(rel),
            }
        }
    }
}

/// 起動ボリュームの名前 (macOS: `/Volumes/<v>` のうち `/` を指すもの)。他の OS / 不明なら None。
pub fn boot_volume_name() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let root = std::fs::canonicalize("/").ok()?;
    std::fs::read_dir("/Volumes").ok()?.flatten().find_map(|e| {
        let resolved = std::fs::canonicalize(e.path()).ok()?;
        (resolved == root).then(|| e.file_name().to_string_lossy().into_owned())
    })
}

/// 照合キー: NFC + 区切り統一 + (大文字小文字を区別しない FS なら) 小文字化。
pub fn normalize_key(path: &str, style: PathStyle) -> String {
    let nfc: String = path.nfc().collect();
    let unified = nfc.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/').to_string();
    if style.case_insensitive() {
        trimmed.to_lowercase()
    } else {
        trimmed
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// NML の KB サイズとバイトサイズが一致するか (切り捨て・四捨五入・切り上げを許す)。
fn size_matches(kb: u64, bytes: u64) -> bool {
    let floor = bytes / 1024;
    let round = (bytes + 512) / 1024;
    let ceil = bytes.div_ceil(1024);
    kb == floor || kb == round || kb == ceil
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    /// パスが一致。
    Path,
    /// パス不一致だが、ファイル名 + サイズで一意に決まった。
    NameSize,
}

/// 照合の結果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Lookup<'a> {
    Match(&'a NmlEntry, MatchKind),
    /// 候補が複数あり決められない (別ボリュームの同じパス / 同名・同サイズ)。
    Ambiguous,
    NotFound,
}

/// 照合用インデックス。
#[derive(Debug)]
pub struct NmlIndex {
    entries: Vec<NmlEntry>,
    style: PathStyle,
    /// ボリューム付きのキー → エントリ (同じキーは先勝ち。同じボリュームの同じパスなので同じ曲)。
    by_qualified: HashMap<String, usize>,
    /// ボリュームを含まないキー → エントリ群 (別ボリュームで重なり得る)。
    by_bare: HashMap<String, Vec<usize>>,
    by_name: HashMap<String, Vec<usize>>,
    /// 起動ボリューム名 (照合キーと同じ正規化済み)。
    boot_volume: Option<String>,
}

impl NmlIndex {
    /// 起動ボリュームは実行時に判定する (macOS 以外は無し)。
    pub fn new(entries: Vec<NmlEntry>, style: PathStyle) -> Self {
        let boot = match style {
            PathStyle::Mac => boot_volume_name(),
            _ => None,
        };
        Self::with_boot_volume(entries, style, boot.as_deref())
    }

    pub fn with_boot_volume(entries: Vec<NmlEntry>, style: PathStyle, boot: Option<&str>) -> Self {
        let mut by_qualified = HashMap::with_capacity(entries.len());
        let mut by_bare: HashMap<String, Vec<usize>> = HashMap::with_capacity(entries.len());
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::with_capacity(entries.len());
        for (i, e) in entries.iter().enumerate() {
            if e.file.is_empty() {
                continue;
            }
            let c = native_candidates(&e.volume, &e.dir, &e.file, style);
            if let Some(q) = c.qualified {
                by_qualified.entry(normalize_key(&q, style)).or_insert(i);
            }
            if let Some(b) = c.bare {
                by_bare.entry(normalize_key(&b, style)).or_default().push(i);
            }
            by_name
                .entry(normalize_key(&e.file, style))
                .or_default()
                .push(i);
        }
        Self {
            entries,
            style,
            by_qualified,
            by_bare,
            by_name,
            boot_volume: boot
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| normalize_key(v, style)),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    fn volume_key(&self, i: usize) -> String {
        normalize_key(&self.entries[i].volume, self.style)
    }

    /// bare キーの候補から 1 つに決める。全部同じボリュームならその先頭、別ボリュームが
    /// 混ざるなら起動ボリュームのものだけ (無ければ曖昧)。
    fn pick_bare(&self, hits: &[usize]) -> Option<usize> {
        let first = *hits.first()?;
        let v0 = self.volume_key(first);
        if hits.iter().all(|&i| self.volume_key(i) == v0) {
            return Some(first);
        }
        let boot = self.boot_volume.as_ref()?;
        hits.iter().copied().find(|&i| self.volume_key(i) == *boot)
    }

    /// crateforge の曲 (パス + 既知ならファイルサイズ) に対応する NML の曲を探す。
    pub fn find(&self, path: &str, size_bytes: Option<u64>) -> Lookup<'_> {
        let key = normalize_key(path, self.style);
        if let Some(&i) = self.by_qualified.get(&key) {
            return Lookup::Match(&self.entries[i], MatchKind::Path);
        }
        if let Some(hits) = self.by_bare.get(&key) {
            return match self.pick_bare(hits) {
                Some(i) => Lookup::Match(&self.entries[i], MatchKind::Path),
                None => Lookup::Ambiguous,
            };
        }
        let Some(bytes) = size_bytes else {
            return Lookup::NotFound;
        };
        let name = normalize_key(file_name(path), self.style);
        let Some(candidates) = self.by_name.get(&name) else {
            return Lookup::NotFound;
        };
        let mut hits = candidates.iter().filter(|&&i| {
            self.entries[i]
                .file_size_kb
                .is_some_and(|kb| size_matches(kb, bytes))
        });
        let Some(&first) = hits.next() else {
            return Lookup::NotFound;
        };
        if hits.next().is_some() {
            return Lookup::Ambiguous; // 同名・同サイズが複数 → 曖昧なので採用しない
        }
        Lookup::Match(&self.entries[first], MatchKind::NameSize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(volume: &str, dir: &str, file: &str, kb: Option<u64>) -> NmlEntry {
        NmlEntry {
            volume: volume.into(),
            dir: dir.into(),
            file: file.into(),
            file_size_kb: kb,
            ..Default::default()
        }
    }

    #[test]
    fn mac_location_yields_volume_and_bare_candidates() {
        let c = native_candidates(
            "Macintosh HD",
            "/:Users/:dj/:Music/:",
            "a.mp3",
            PathStyle::Unix,
        );
        assert_eq!(
            c,
            Candidates {
                qualified: Some("/Volumes/Macintosh HD/Users/dj/Music/a.mp3".into()),
                bare: Some("/Users/dj/Music/a.mp3".into()),
            }
        );
        let no_volume = native_candidates("", "/:Crates/:", "b.wav", PathStyle::Unix);
        assert_eq!(no_volume.qualified, None);
        assert_eq!(no_volume.bare.as_deref(), Some("/Crates/b.wav"));
    }

    #[test]
    fn windows_location_uses_the_drive_letter() {
        let c = native_candidates("C:", "/:Users/:dj/:Music/:", "a.mp3", PathStyle::Windows);
        assert_eq!(c.qualified.as_deref(), Some(r"C:\Users\dj\Music\a.mp3"));
        assert_eq!(c.bare, None);
        assert_eq!(
            native_candidates("NAS", "/:share/:", "x.mp3", PathStyle::Windows)
                .qualified
                .as_deref(),
            Some(r"\\NAS\share\x.mp3")
        );
        let empty = native_candidates("C:", "/:", "", PathStyle::Windows);
        assert_eq!((empty.qualified, empty.bare), (None, None));
    }

    #[test]
    fn normalization_folds_unicode_case_and_separators() {
        // NFD (macOS のファイル名で典型) と NFC が同じキーになる。
        let nfd = "/Music/Cafe\u{301}.mp3";
        let nfc = "/Music/Caf\u{e9}.mp3";
        assert_eq!(
            normalize_key(nfd, PathStyle::Unix),
            normalize_key(nfc, PathStyle::Unix)
        );
        assert_eq!(
            normalize_key(r"C:\Music\A.MP3", PathStyle::Windows),
            "c:/music/a.mp3"
        );
        assert_ne!(
            normalize_key("/Music/A.mp3", PathStyle::Unix),
            normalize_key("/Music/a.mp3", PathStyle::Unix)
        );
        assert_eq!(
            normalize_key("/Music/A.mp3", PathStyle::Mac),
            normalize_key("/music/a.MP3", PathStyle::Mac)
        );
    }

    #[test]
    fn finds_by_exact_path() {
        let idx = NmlIndex::new(
            vec![
                entry("Macintosh HD", "/:Users/:dj/:Music/:", "a.mp3", Some(100)),
                entry("E:", "/:Music/:", "b.mp3", Some(200)),
            ],
            PathStyle::Unix,
        );
        let Lookup::Match(e, kind) = idx.find("/Users/dj/Music/a.mp3", None) else {
            panic!("bare path should match");
        };
        assert_eq!(e.file, "a.mp3");
        assert_eq!(kind, MatchKind::Path);
        let Lookup::Match(e, _) = idx.find("/Volumes/Macintosh HD/Users/dj/Music/a.mp3", None)
        else {
            panic!("volume path should match");
        };
        assert_eq!(e.file, "a.mp3");
        assert_eq!(
            idx.find("/Users/dj/Music/missing.mp3", None),
            Lookup::NotFound
        );
    }

    #[test]
    fn windows_paths_match_case_insensitively() {
        let idx = NmlIndex::new(
            vec![entry("C:", "/:Users/:DJ/:Music/:", "Track.MP3", None)],
            PathStyle::Windows,
        );
        assert!(matches!(
            idx.find(r"c:\users\dj\music\track.mp3", None),
            Lookup::Match(..)
        ));
    }

    #[test]
    fn falls_back_to_name_and_size_when_unique() {
        let idx = NmlIndex::new(
            vec![
                entry("Old Drive", "/:Music/:", "a.mp3", Some(11720)),
                entry("Old Drive", "/:Other/:", "b.mp3", Some(5)),
            ],
            PathStyle::Unix,
        );
        // 11720 KB = 12_001_280 bytes 前後なら一致。
        let Lookup::Match(e, kind) = idx.find("/new/place/a.mp3", Some(12_001_000)) else {
            panic!("name + size should match");
        };
        assert_eq!(e.dir, "/:Music/:");
        assert_eq!(kind, MatchKind::NameSize);
        // サイズが違えば採用しない。
        assert_eq!(idx.find("/new/place/a.mp3", Some(1_000)), Lookup::NotFound);
        // サイズ不明ならフォールバックしない。
        assert_eq!(idx.find("/new/place/a.mp3", None), Lookup::NotFound);
    }

    #[test]
    fn ambiguous_name_and_size_is_not_matched() {
        let idx = NmlIndex::new(
            vec![
                entry("V", "/:A/:", "same.mp3", Some(10)),
                entry("V", "/:B/:", "same.mp3", Some(10)),
            ],
            PathStyle::Unix,
        );
        assert_eq!(
            idx.find("/elsewhere/same.mp3", Some(10 * 1024)),
            Lookup::Ambiguous
        );
    }

    /// クローン / バックアップ用ボリュームが同じフォルダ構成を持つコレクション。
    fn cloned_volumes() -> Vec<NmlEntry> {
        let mut main = entry("Macintosh HD", "/:Users/:dj/:Music/:", "a.mp3", Some(1));
        main.bpm = Some(120.0);
        let mut backup = entry("Backup", "/:Users/:dj/:Music/:", "a.mp3", Some(1));
        backup.bpm = Some(128.0);
        // 先頭が backup (ファイル内で先に出る方が勝つ実装だと backup を選んでしまう)。
        vec![backup, main]
    }

    #[test]
    fn volume_qualified_keys_win() {
        let idx = NmlIndex::with_boot_volume(cloned_volumes(), PathStyle::Unix, None);
        let Lookup::Match(e, _) = idx.find("/Volumes/Backup/Users/dj/Music/a.mp3", None) else {
            panic!("qualified path should match");
        };
        assert_eq!(e.volume, "Backup");
        let Lookup::Match(e, _) = idx.find("/Volumes/Macintosh HD/Users/dj/Music/a.mp3", None)
        else {
            panic!("qualified path should match");
        };
        assert_eq!(e.volume, "Macintosh HD");
    }

    #[test]
    fn a_bare_key_shared_by_several_volumes_is_ambiguous_without_the_boot_volume() {
        let idx = NmlIndex::with_boot_volume(cloned_volumes(), PathStyle::Unix, None);
        assert_eq!(idx.find("/Users/dj/Music/a.mp3", None), Lookup::Ambiguous);
        // 起動ボリュームが分からない / どちらでもないときも曖昧。
        let idx = NmlIndex::with_boot_volume(cloned_volumes(), PathStyle::Unix, Some("Other"));
        assert_eq!(idx.find("/Users/dj/Music/a.mp3", None), Lookup::Ambiguous);
    }

    #[test]
    fn a_bare_key_resolves_to_the_boot_volume_entry() {
        let idx =
            NmlIndex::with_boot_volume(cloned_volumes(), PathStyle::Unix, Some("Macintosh HD"));
        let Lookup::Match(e, kind) = idx.find("/Users/dj/Music/a.mp3", None) else {
            panic!("boot volume entry should match");
        };
        assert_eq!(e.volume, "Macintosh HD");
        assert_eq!(e.bpm, Some(120.0));
        assert_eq!(kind, MatchKind::Path);
        // macOS はボリューム名も大文字小文字を区別しない。
        let idx =
            NmlIndex::with_boot_volume(cloned_volumes(), PathStyle::Mac, Some("macintosh hd"));
        let Lookup::Match(e, _) = idx.find("/users/DJ/music/A.mp3", None) else {
            panic!("boot volume entry should match");
        };
        assert_eq!(e.volume, "Macintosh HD");
    }

    #[test]
    fn a_bare_key_from_a_single_volume_still_matches() {
        // 起動ボリューム名が分からなくても、重なりが無ければ従来どおり一致させる。
        let idx = NmlIndex::with_boot_volume(
            vec![entry("Backup", "/:Users/:dj/:", "b.mp3", None)],
            PathStyle::Unix,
            None,
        );
        assert!(matches!(
            idx.find("/Users/dj/b.mp3", None),
            Lookup::Match(_, MatchKind::Path)
        ));
    }

    #[test]
    fn boot_volume_detection_is_macos_only() {
        if !cfg!(target_os = "macos") {
            assert_eq!(boot_volume_name(), None);
        }
    }

    #[test]
    fn size_matching_tolerates_rounding() {
        assert!(size_matches(1, 1024));
        assert!(size_matches(1, 1500)); // round/ceil
        assert!(size_matches(2, 1500)); // ceil
        assert!(!size_matches(3, 1500));
    }
}
