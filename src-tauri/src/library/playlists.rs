//! プレイリストの曲目の編集 (GUI のコマンドと `/api/playlists/:id/tracks` の共通手順)。
//!
//! どの操作も最初に [`ensure_tracks_editable`] を通す。スマートプレイリストの曲目は条件の
//! ライブ評価で決まり、`playlist_tracks` に書いても無視されるため、黙って成功させない。

use std::fmt;

use crate::db::playlists::{ReplacePlaylistTracksResult, SMART_PLAYLIST_EDIT_ERROR};
use crate::db::Database;

/// プレイリストの曲目を編集できなかった理由。
#[derive(Debug)]
pub enum PlaylistEditError {
    /// スマートプレイリスト (曲目は条件で決まる)。API は 409。
    Smart,
    /// プレイリストが無い。API は 404。
    NotFound,
    /// 指定した曲がライブラリに無い (全置換のみ。既存の所属・順序は変更していない)。API は 400。
    TrackNotFound(i64),
    /// DB の読み書きに失敗した。
    Db(rusqlite::Error),
}

impl fmt::Display for PlaylistEditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlaylistEditError::Smart => f.write_str(SMART_PLAYLIST_EDIT_ERROR),
            PlaylistEditError::NotFound => f.write_str("playlist not found"),
            PlaylistEditError::TrackNotFound(track_id) => write!(f, "track not found: {track_id}"),
            PlaylistEditError::Db(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for PlaylistEditError {}

impl From<rusqlite::Error> for PlaylistEditError {
    fn from(e: rusqlite::Error) -> Self {
        PlaylistEditError::Db(e)
    }
}

/// 曲目を直接編集できるプレイリストか。スマート条件を持つなら [`PlaylistEditError::Smart`]。
/// (プレイリストの存在はここでは確かめない。)
pub fn ensure_tracks_editable(db: &Database, playlist_id: i64) -> Result<(), PlaylistEditError> {
    if db.has_smart_criteria(playlist_id)? {
        return Err(PlaylistEditError::Smart);
    }
    Ok(())
}

/// 曲を末尾に追加する。追加した行数を返す (同じ曲を重ねて入れられる)。
pub fn add_tracks(
    db: &Database,
    playlist_id: i64,
    track_ids: &[i64],
) -> Result<usize, PlaylistEditError> {
    ensure_tracks_editable(db, playlist_id)?;
    Ok(db.add_tracks_to_playlist(playlist_id, track_ids)?)
}

/// 曲を 1 件外す (同じ曲が複数回入っていれば最初の 1 行だけ)。入っていなければ何もしない。
pub fn remove_track(
    db: &Database,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), PlaylistEditError> {
    ensure_tracks_editable(db, playlist_id)?;
    Ok(db.remove_track_from_playlist(playlist_id, track_id)?)
}

/// 複数曲をまとめて外す (1 トランザクション)。外した行数を返す。
pub fn remove_tracks(
    db: &Database,
    playlist_id: i64,
    track_ids: &[i64],
) -> Result<usize, PlaylistEditError> {
    ensure_tracks_editable(db, playlist_id)?;
    Ok(db.remove_tracks_from_playlist(playlist_id, track_ids)?)
}

/// 曲目を `ordered_track_ids` の順に並べ替える (GUI のドラッグ並べ替え)。
/// プレイリスト・曲の存在は確かめない ([`replace_tracks`] との違い)。
pub fn reorder_tracks(
    db: &Database,
    playlist_id: i64,
    ordered_track_ids: &[i64],
) -> Result<(), PlaylistEditError> {
    ensure_tracks_editable(db, playlist_id)?;
    Ok(db.reorder_playlist_tracks(playlist_id, ordered_track_ids)?)
}

/// 曲目を入力順どおりに全置換する (`PUT /api/playlists/:id/tracks`)。
/// プレイリストが無ければ [`PlaylistEditError::NotFound`]、ライブラリに無い曲が 1 件でもあれば
/// [`PlaylistEditError::TrackNotFound`] で、その場合は既存の所属・順序を変更しない。
pub fn replace_tracks(
    db: &Database,
    playlist_id: i64,
    ordered_track_ids: &[i64],
) -> Result<(), PlaylistEditError> {
    ensure_tracks_editable(db, playlist_id)?;
    match db.replace_playlist_tracks(playlist_id, ordered_track_ids)? {
        ReplacePlaylistTracksResult::Replaced => Ok(()),
        ReplacePlaylistTracksResult::PlaylistNotFound => Err(PlaylistEditError::NotFound),
        ReplacePlaylistTracksResult::TrackNotFound(track_id) => {
            Err(PlaylistEditError::TrackNotFound(track_id))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SmartCriteria;

    fn empty_criteria() -> SmartCriteria {
        SmartCriteria {
            match_all: true,
            rules: vec![],
            groups: vec![],
            limit: None,
            sort_by: None,
            sort_desc: false,
            then_by: Vec::new(),
        }
    }

    fn db_with_tracks(ids: &[i64]) -> Database {
        let db = Database::open_memory().unwrap();
        for id in ids {
            db.conn
                .execute(
                    "INSERT INTO tracks (track_id, name, file_exists) VALUES (?1, ?2, 1)",
                    rusqlite::params![id, format!("T{id}")],
                )
                .unwrap();
        }
        db
    }

    fn member_ids(db: &Database, playlist_id: i64) -> Vec<i64> {
        let mut stmt = db
            .conn
            .prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY sort_index",
            )
            .unwrap();
        let rows = stmt.query_map([playlist_id], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    /// スマート条件のあるプレイリストは曲目の編集をすべて拒否する。通常プレイリストは通す。
    #[test]
    fn smart_playlist_tracks_are_not_editable() {
        let db = db_with_tracks(&[1, 2]);
        let normal = db.create_playlist("Normal", None, false).unwrap().playlist_id;
        let smart = db
            .create_smart_playlist("Smart", &empty_criteria())
            .unwrap()
            .playlist_id;

        assert!(ensure_tracks_editable(&db, normal).is_ok());
        assert!(matches!(
            ensure_tracks_editable(&db, smart),
            Err(PlaylistEditError::Smart)
        ));
        // コマンド層へはこの文言のまま届く。
        assert_eq!(PlaylistEditError::Smart.to_string(), SMART_PLAYLIST_EDIT_ERROR);

        let rejected = [
            add_tracks(&db, smart, &[1]).map(|_| ()),
            remove_track(&db, smart, 1),
            remove_tracks(&db, smart, &[1]).map(|_| ()),
            reorder_tracks(&db, smart, &[2, 1]),
            replace_tracks(&db, smart, &[2, 1]),
        ];
        for r in rejected {
            assert!(matches!(r, Err(PlaylistEditError::Smart)), "{r:?}");
        }
        assert!(member_ids(&db, smart).is_empty());
    }

    #[test]
    fn add_remove_reorder_on_normal_playlist() {
        let db = db_with_tracks(&[1, 2, 3]);
        let pl = db.create_playlist("P", None, false).unwrap().playlist_id;

        assert_eq!(add_tracks(&db, pl, &[1, 2, 3, 1]).unwrap(), 4);
        assert_eq!(member_ids(&db, pl), vec![1, 2, 3, 1]);

        remove_track(&db, pl, 1).unwrap();
        assert_eq!(member_ids(&db, pl), vec![2, 3, 1]);
        assert_eq!(remove_tracks(&db, pl, &[2, 99]).unwrap(), 1);
        assert_eq!(member_ids(&db, pl), vec![3, 1]);

        reorder_tracks(&db, pl, &[1, 3]).unwrap();
        assert_eq!(member_ids(&db, pl), vec![1, 3]);
    }

    /// 全置換はプレイリスト・曲の存在を確かめ、失敗時は元の曲目を保つ。
    #[test]
    fn replace_checks_playlist_and_tracks() {
        let db = db_with_tracks(&[1, 2]);
        let pl = db.create_playlist("P", None, false).unwrap().playlist_id;
        add_tracks(&db, pl, &[1]).unwrap();

        assert!(matches!(
            replace_tracks(&db, 9999, &[1]),
            Err(PlaylistEditError::NotFound)
        ));
        assert!(matches!(
            replace_tracks(&db, pl, &[2, 77]),
            Err(PlaylistEditError::TrackNotFound(77))
        ));
        assert_eq!(member_ids(&db, pl), vec![1]);

        replace_tracks(&db, pl, &[2, 1, 2]).unwrap();
        assert_eq!(member_ids(&db, pl), vec![2, 1, 2]);
    }
}
