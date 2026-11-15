//! ジャンルタグの一括追加・削除 (GUI の右クリック「Genre tags」/ Get Info と
//! `POST /api/tracks/genre-tags/{add,remove}` の共通手順)。
//!
//! 規則は docs/genre/design.md §2: どの経路でも **DB と実ファイルのタグの両方** を更新する。
//! ファイル書き込みはベストエフォート (ファイルが無ければスキップ、失敗は件数で返す)。

use std::fmt;

use crate::db::Database;
use crate::organizer;

/// タグを足すか外すか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenreTagOp {
    Add,
    Remove,
}

/// [`edit_genre_tag`] を始められなかった理由 (何も書き換えていない)。
#[derive(Debug, PartialEq, Eq)]
pub enum GenreTagError {
    /// タグが空 (空白のみ)。API は 400。
    EmptyTag,
}

impl fmt::Display for GenreTagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GenreTagError::EmptyTag => f.write_str("tag is empty"),
        }
    }
}

impl std::error::Error for GenreTagError {}

/// [`edit_genre_tag`] の結果。
#[derive(Debug, Default)]
pub struct GenreTagOutcome {
    /// DB を更新できた曲数 (もともとタグが付いていた / 無かった曲も数える。従来の API と同じ)。
    pub updated: usize,
    /// ファイルへの書き込みを試みて失敗した曲数 (ファイルが無い曲は試みないので数えない)。
    pub file_write_failed: usize,
    /// DB の更新に失敗した曲と、そのエラー (その曲はファイルも書かない。ほかの曲は続ける)。
    pub db_errors: Vec<(i64, rusqlite::Error)>,
}

/// `track_ids` の各曲の genre (空白区切りのタグ集合) に `tag` を 1 つ足す / 外す。
///
/// 曲ごとに DB を更新し、**更新後の genre だけ** を実ファイルのタグへ書き戻す (ほかのタグ項目は
/// 触らない)。外した結果 genre が空になったら、ファイルの genre も空にする。
/// 整理 (フォルダ移動) はしない (genre は整理先のパスに関わらない)。
pub fn edit_genre_tag(
    db: &Database,
    track_ids: &[i64],
    tag: &str,
    op: GenreTagOp,
) -> Result<GenreTagOutcome, GenreTagError> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Err(GenreTagError::EmptyTag);
    }
    let mut outcome = GenreTagOutcome::default();
    for &id in track_ids {
        let result = match op {
            GenreTagOp::Add => db.add_genre_tag(id, tag),
            GenreTagOp::Remove => db.remove_genre_tag(id, tag),
        };
        if let Err(e) = result {
            outcome.db_errors.push((id, e));
            continue;
        }
        outcome.updated += 1;
        if let Ok(Some(track)) = db.get_track_by_track_id(id) {
            let genre = match op {
                GenreTagOp::Add => track.genre.as_deref(),
                // 空になったらファイルのタグも空文字で上書きする (None だと「触らない」になる)。
                GenreTagOp::Remove => Some(track.genre.as_deref().unwrap_or("")),
            };
            let w = organizer::TagWrite {
                genre,
                ..Default::default()
            };
            if organizer::write_tags_to_location(track.location_path.as_deref(), &w) {
                outcome.file_write_failed += 1;
            }
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_track(db: &Database, track_id: i64, genre: Option<&str>, path: Option<&str>) {
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, name, genre, location_path, file_exists)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                rusqlite::params![track_id, format!("T{track_id}"), genre, path],
            )
            .unwrap();
    }

    fn genre(db: &Database, track_id: i64) -> Option<String> {
        db.get_track_by_track_id(track_id).unwrap().unwrap().genre
    }

    #[test]
    fn add_and_remove_update_db() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some("House"), None);
        add_track(&db, 2, None, None);

        let out = edit_genre_tag(&db, &[1, 2], " Techno ", GenreTagOp::Add).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (2, 0));
        assert!(out.db_errors.is_empty());
        assert_eq!(genre(&db, 1).as_deref(), Some("House Techno"));
        assert_eq!(genre(&db, 2).as_deref(), Some("Techno"));

        let out = edit_genre_tag(&db, &[1, 2], "techno", GenreTagOp::Remove).unwrap();
        assert_eq!(out.updated, 2);
        assert_eq!(genre(&db, 1).as_deref(), Some("House"));
        assert_eq!(genre(&db, 2), None);
    }

    #[test]
    fn empty_tag_is_rejected() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some("House"), None);
        for op in [GenreTagOp::Add, GenreTagOp::Remove] {
            assert_eq!(
                edit_genre_tag(&db, &[1], "   ", op).unwrap_err(),
                GenreTagError::EmptyTag
            );
        }
        assert_eq!(genre(&db, 1).as_deref(), Some("House"));
    }

    /// ファイルへも書く: 実在するがタグを書けないファイルは fileWriteFailed に数える。
    /// 存在しないファイル・場所の無い曲は書き込みを試みないので数えない。
    #[test]
    fn file_write_is_attempted_and_failures_are_counted() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("not-audio.mp3");
        std::fs::write(&broken, b"this is not an audio file").unwrap();
        let missing = dir.path().join("missing.mp3");
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, None, Some(&broken.to_string_lossy()));
        add_track(&db, 2, None, Some(&missing.to_string_lossy()));
        add_track(&db, 3, None, None);

        let out = edit_genre_tag(&db, &[1, 2, 3], "House", GenreTagOp::Add).unwrap();
        assert_eq!(out.updated, 3);
        assert_eq!(out.file_write_failed, 1);
        // DB は 3 曲とも更新されている。
        for id in [1, 2, 3] {
            assert_eq!(genre(&db, id).as_deref(), Some("House"));
        }

        let out = edit_genre_tag(&db, &[1, 2, 3], "House", GenreTagOp::Remove).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (3, 1));
    }
}
