//! ライブラリ外ファイルの一時再生 (transient track)。
//!
//! OS の「このアプリで開く」で渡されたファイルのうち、ライブラリに無いものは DB に
//! 追加せずに再生する。再生系 (キュー / `PlaybackState` / イベント / フロント) は全て
//! `i64` の track_id で動いているので、一時再生曲には **負の ID** を割り当て、
//! 実体 (パス・表示用メタデータ) はこのレジストリ (Tauri managed state) に置く。
//!
//! なぜ enum 等で型を分けないか: キュー (`AudioPlayer`)・永続化・Remote API・Cast・
//! フロントのストアまで track_id を素の数値として受け渡しており、型を分けると差分が
//! 全域に広がるため。DB の track_id は常に 1 以上 (`MAX(track_id) + 1` / iTunes の ID) なので
//! 負値とは衝突しない。判定は必ず [`is_transient_id`] を通す (直接 `< 0` を書かない)。
//!
//! 一時再生曲は次を行わない: 再生実績 (play/skip)・最近再生・解析・再生キューの永続化・Cast。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::itunes_xml::writer::path_to_file_url;
use crate::models::Track;

/// ライブラリ外の一時再生曲の ID か (DB の track_id は常に正)。
pub fn is_transient_id(track_id: i64) -> bool {
    track_id < 0
}

/// 一時再生曲 1 件。
#[derive(Debug, Clone)]
pub struct TransientTrack {
    /// 再生するファイルの絶対パス。
    pub path: String,
    /// 表示用 (PlayerBar / Up Next / SMTC)。`track_id` は負の ID。
    pub track: Track,
}

#[derive(Default)]
struct Inner {
    /// 次に割り当てる ID の絶対値 - 1 (割り当ては -1, -2, ... と減っていく)。
    issued: i64,
    by_id: HashMap<i64, TransientTrack>,
    /// 同じファイルを開き直したときは同じ ID を使う。
    by_path: HashMap<String, i64>,
}

/// 一時再生曲のレジストリ (Tauri managed state)。
#[derive(Default)]
pub struct TransientTracks {
    inner: Mutex<Inner>,
}

impl TransientTracks {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// ファイルを一時再生曲として登録し、負の ID を返す。登録済みのパスなら同じ ID。
    /// タグはここで読む (読めなくてもファイル名を曲名にして登録する: 再生できるかは
    /// デコーダ次第なので、タグの有無で弾かない)。
    pub fn register(&self, path: &Path) -> i64 {
        let key = path.to_string_lossy().into_owned();
        if let Some(&id) = self.lock().by_path.get(&key) {
            return id;
        }
        // タグ読み取り (ファイル I/O) はロックの外で行う。
        let track_fields = crate::importer::read_file_tags(path).unwrap_or_else(|e| {
            crate::logging::write_line(
                "warn",
                &format!("open-with: tag read failed ({}): {}", key, e),
            );
            crate::importer::FileTags {
                title: path.file_stem().map(|s| s.to_string_lossy().into_owned()),
                ..Default::default()
            }
        });
        let mut inner = self.lock();
        // ロックを外している間に同じパスが登録されていたらそちらを使う。
        if let Some(&id) = inner.by_path.get(&key) {
            return id;
        }
        inner.issued += 1;
        let id = -inner.issued;
        let track = build_track(id, &key, track_fields);
        inner.by_path.insert(key.clone(), id);
        inner.by_id.insert(id, TransientTrack { path: key, track });
        id
    }

    pub fn get(&self, track_id: i64) -> Option<TransientTrack> {
        self.lock().by_id.get(&track_id).cloned()
    }

    pub fn remove(&self, track_id: i64) -> Option<TransientTrack> {
        let mut inner = self.lock();
        let removed = inner.by_id.remove(&track_id)?;
        inner.by_path.remove(&removed.path);
        Some(removed)
    }

    /// `keep` に含まれない一時再生曲を捨てる (キューから外れたものの掃除)。
    pub fn retain(&self, keep: impl Fn(i64) -> bool) {
        let mut inner = self.lock();
        inner.by_id.retain(|id, _| keep(*id));
        let Inner { by_id, by_path, .. } = &mut *inner;
        by_path.retain(|_, id| by_id.contains_key(id));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().by_id.len()
    }
}

/// タグから表示用の `Track` を組み立てる (DB 行ではないので統計系は空)。
fn build_track(id: i64, path: &str, t: crate::importer::FileTags) -> Track {
    Track {
        id,
        track_id: id,
        persistent_id: None,
        name: t.title,
        album_artist: t.album_artist.or_else(|| t.artist.clone()),
        artist: t.artist,
        composer: None,
        album: t.album,
        genre: t.genre,
        year: t.year,
        rating: None,
        play_count: None,
        skip_count: None,
        total_time_ms: t.total_time_ms,
        date_added: None,
        date_modified: None,
        bpm: t.bpm,
        comments: None,
        location_raw: Some(path_to_file_url(path)),
        location_path: Some(path.to_string()),
        track_type: Some("File".to_string()),
        disabled: false,
        compilation: false,
        disc_number: t.disc_number,
        disc_count: t.disc_count,
        track_number: t.track_number,
        track_count: t.track_count,
        file_exists: true,
        last_played: None,
        bitrate_kbps: t.tech.bitrate_kbps,
        sample_rate_hz: t.tech.sample_rate_hz,
        bit_depth: t.tech.bit_depth,
        channels: t.tech.channels,
        file_size_bytes: t.tech.file_size_bytes,
        codec: t.tech.codec,
        key_camelot_user: None,
        grouping: t.grouping,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_ids_are_negative_and_db_ids_are_not() {
        assert!(is_transient_id(-1));
        assert!(!is_transient_id(0));
        assert!(!is_transient_id(1));
    }

    #[test]
    fn register_reuses_id_per_path_and_falls_back_to_file_name() {
        let dir = tempfile::tempdir().unwrap();
        // 中身が音声でないファイル: タグは読めないが登録自体はできる (曲名 = ファイル名)。
        let a = dir.path().join("Song A.mp3");
        let b = dir.path().join("Song B.flac");
        std::fs::write(&a, b"not audio").unwrap();
        std::fs::write(&b, b"not audio").unwrap();

        let reg = TransientTracks::default();
        let ia = reg.register(&a);
        let ib = reg.register(&b);
        assert!(is_transient_id(ia) && is_transient_id(ib));
        assert_ne!(ia, ib);
        assert_eq!(reg.register(&a), ia);

        let t = reg.get(ia).unwrap();
        assert_eq!(t.track.track_id, ia);
        assert_eq!(t.track.name.as_deref(), Some("Song A"));
        assert_eq!(t.track.location_path.as_deref(), a.to_str());
        assert!(t.track.file_exists);

        reg.retain(|id| id == ib);
        assert_eq!(reg.len(), 1);
        assert!(reg.get(ia).is_none());
        // 捨てたパスを開き直すと新しい ID になる (古い ID は再利用しない)。
        let ia2 = reg.register(&a);
        assert!(ia2 != ia && ia2 != ib);
        assert_eq!(reg.remove(ia2).map(|t| t.path), a.to_str().map(String::from));
        assert!(reg.get(ia2).is_none());
    }
}
