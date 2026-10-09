//! NML の `LOCATION` → ネイティブパス変換と、crateforge の曲との突き合わせ。
//!
//! - `DIR` は `/:` 区切り (`/:Users/:me/:Music/:`)。
//! - macOS: `VOLUME` はボリューム名。起動ボリュームなら `/<dir>/<file>`、外部ボリュームなら
//!   `/Volumes/<VOLUME>/<dir>/<file>`。どちらか事前に断定せず **両方を候補** にして照合する
//!   (起動ボリューム名の判定が不要で、外付けの同名フォルダも取りこぼさない)。
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

/// `LOCATION` からネイティブパスの候補を作る (先頭ほど有力)。
pub fn native_candidates(volume: &str, dir: &str, file: &str, style: PathStyle) -> Vec<String> {
    if file.is_empty() {
        return Vec::new();
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
            vec![path]
        }
        PathStyle::Mac | PathStyle::Unix => {
            let mut rel = String::new();
            for p in &parts {
                rel.push('/');
                rel.push_str(p);
            }
            rel.push('/');
            rel.push_str(file);
            let mut out = vec![rel.clone()];
            if !volume.is_empty() {
                let on_volume = format!("/Volumes/{volume}{rel}");
                // 外部ボリューム上と分かっているなら (マウント済み) そちらを優先する。
                if style == PathStyle::Mac
                    && std::path::Path::new(&format!("/Volumes/{volume}"))
                        .symlink_metadata()
                        .is_ok_and(|m| m.is_dir())
                {
                    out.insert(0, on_volume);
                } else {
                    out.push(on_volume);
                }
            }
            out
        }
    }
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

/// 照合用インデックス。
#[derive(Debug)]
pub struct NmlIndex {
    entries: Vec<NmlEntry>,
    style: PathStyle,
    by_path: HashMap<String, usize>,
    by_name: HashMap<String, Vec<usize>>,
}

impl NmlIndex {
    pub fn new(entries: Vec<NmlEntry>, style: PathStyle) -> Self {
        let mut by_path = HashMap::with_capacity(entries.len() * 2);
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::with_capacity(entries.len());
        for (i, e) in entries.iter().enumerate() {
            if e.file.is_empty() {
                continue;
            }
            for candidate in native_candidates(&e.volume, &e.dir, &e.file, style) {
                by_path.entry(normalize_key(&candidate, style)).or_insert(i);
            }
            by_name
                .entry(normalize_key(&e.file, style))
                .or_default()
                .push(i);
        }
        Self {
            entries,
            style,
            by_path,
            by_name,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// crateforge の曲 (パス + 既知ならファイルサイズ) に対応する NML の曲を探す。
    pub fn find(&self, path: &str, size_bytes: Option<u64>) -> Option<(&NmlEntry, MatchKind)> {
        if let Some(&i) = self.by_path.get(&normalize_key(path, self.style)) {
            return Some((&self.entries[i], MatchKind::Path));
        }
        let bytes = size_bytes?;
        let name = normalize_key(file_name(path), self.style);
        let candidates = self.by_name.get(&name)?;
        let mut hits = candidates.iter().filter(|&&i| {
            self.entries[i]
                .file_size_kb
                .is_some_and(|kb| size_matches(kb, bytes))
        });
        let first = *hits.next()?;
        if hits.next().is_some() {
            return None; // 同名・同サイズが複数 → 曖昧なので採用しない
        }
        Some((&self.entries[first], MatchKind::NameSize))
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
    fn mac_location_yields_boot_and_volume_candidates() {
        let c = native_candidates(
            "Macintosh HD",
            "/:Users/:dj/:Music/:",
            "a.mp3",
            PathStyle::Unix,
        );
        assert_eq!(
            c,
            vec![
                "/Users/dj/Music/a.mp3".to_string(),
                "/Volumes/Macintosh HD/Users/dj/Music/a.mp3".to_string()
            ]
        );
        let ext = native_candidates("DJ DRIVE", "/:Crates/:", "b.wav", PathStyle::Unix);
        assert!(ext.contains(&"/Volumes/DJ DRIVE/Crates/b.wav".to_string()));
    }

    #[test]
    fn windows_location_uses_the_drive_letter() {
        assert_eq!(
            native_candidates("C:", "/:Users/:dj/:Music/:", "a.mp3", PathStyle::Windows),
            vec![r"C:\Users\dj\Music\a.mp3".to_string()]
        );
        assert_eq!(
            native_candidates("NAS", "/:share/:", "x.mp3", PathStyle::Windows),
            vec![r"\\NAS\share\x.mp3".to_string()]
        );
        assert!(native_candidates("C:", "/:", "", PathStyle::Windows).is_empty());
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
        let (e, kind) = idx.find("/Users/dj/Music/a.mp3", None).unwrap();
        assert_eq!(e.file, "a.mp3");
        assert_eq!(kind, MatchKind::Path);
        let (e, _) = idx
            .find("/Volumes/Macintosh HD/Users/dj/Music/a.mp3", None)
            .unwrap();
        assert_eq!(e.file, "a.mp3");
        assert!(idx.find("/Users/dj/Music/missing.mp3", None).is_none());
    }

    #[test]
    fn windows_paths_match_case_insensitively() {
        let idx = NmlIndex::new(
            vec![entry("C:", "/:Users/:DJ/:Music/:", "Track.MP3", None)],
            PathStyle::Windows,
        );
        assert!(idx.find(r"c:\users\dj\music\track.mp3", None).is_some());
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
        let (e, kind) = idx.find("/new/place/a.mp3", Some(12_001_000)).unwrap();
        assert_eq!(e.dir, "/:Music/:");
        assert_eq!(kind, MatchKind::NameSize);
        // サイズが違えば採用しない。
        assert!(idx.find("/new/place/a.mp3", Some(1_000)).is_none());
        // サイズ不明ならフォールバックしない。
        assert!(idx.find("/new/place/a.mp3", None).is_none());
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
        assert!(idx.find("/elsewhere/same.mp3", Some(10 * 1024)).is_none());
    }

    #[test]
    fn size_matching_tolerates_rounding() {
        assert!(size_matches(1, 1024));
        assert!(size_matches(1, 1500)); // round/ceil
        assert!(size_matches(2, 1500)); // ceil
        assert!(!size_matches(3, 1500));
    }
}
