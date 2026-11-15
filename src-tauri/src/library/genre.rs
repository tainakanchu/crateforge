//! ジャンルタグの一括追加・削除 (GUI の右クリック「Genre tags」/ Get Info と
//! `POST /api/tracks/genre-tags/{add,remove}` の共通手順)。
//!
//! 規則は docs/genre/design.md §2: どの経路でも **DB と実ファイルのタグの両方** を更新する。
//! ファイル書き込みはベストエフォート (ファイルが無ければスキップ、失敗は件数で返す)。

use std::fmt;

use crate::db::tracks::GenreTagEdit;
use crate::db::Database;
use crate::organizer;

/// [`edit_genre_tags`] を始められなかった理由 (何も書き換えていない)。
#[derive(Debug, PartialEq, Eq)]
pub enum GenreTagError {
    /// 空 (空白のみ) のタグが含まれている。API は 400。
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

/// [`edit_genre_tags`] の結果。
#[derive(Debug, Default)]
pub struct GenreTagOutcome {
    /// genre が実際に変わった曲数。足すタグが既に付いていた / 外すタグがもともと無かった曲、
    /// 存在しない track_id は数えない (その曲は DB もファイルも書かない)。
    pub updated: usize,
    /// ファイルへの書き込みを試みて失敗した曲数 (ファイルが無い曲は試みないので数えない)。
    pub file_write_failed: usize,
    /// DB の更新に失敗した曲と、そのエラー (その曲はファイルも書かない。ほかの曲は続ける)。
    ///
    /// 扱いはアダプタで違う (従来の挙動をそれぞれ保っている):
    /// - API: 無視する。その曲が `updated` に入らないだけで、レスポンスは 200。
    /// - GUI コマンド: 全曲を処理し終えてから、最初のエラーを `Err` で返す (失敗トーストになる)。
    pub db_errors: Vec<(i64, rusqlite::Error)>,
}

/// `track_ids` の各曲の genre (空白区切りのタグ集合) に `add` のタグを足し、`remove` のタグを外す。
///
/// 曲ごとに、タグの集合が変わるときだけ DB を 1 回更新し、**更新後の genre だけ** を実ファイルの
/// タグへ 1 回書き戻す (ほかのタグ項目は触らない。タグの数だけ書き直すことはしない)。
/// 外した結果 genre が空になったら、ファイルの genre も空にする。
/// 変わらない曲 (と存在しない id) は DB にもファイルにも触らない。
/// 整理 (フォルダ移動) はしない (genre は整理先のパスに関わらない)。
pub fn edit_genre_tags(
    db: &Database,
    track_ids: &[i64],
    add: &[&str],
    remove: &[&str],
) -> Result<GenreTagOutcome, GenreTagError> {
    let trimmed = |tags: &[&str]| -> Result<Vec<String>, GenreTagError> {
        tags.iter()
            .map(|tag| match tag.trim() {
                "" => Err(GenreTagError::EmptyTag),
                tag => Ok(tag.to_string()),
            })
            .collect()
    };
    let add = trimmed(add)?;
    let remove = trimmed(remove)?;
    let add: Vec<&str> = add.iter().map(String::as_str).collect();
    let remove: Vec<&str> = remove.iter().map(String::as_str).collect();

    let mut outcome = GenreTagOutcome::default();
    if add.is_empty() && remove.is_empty() {
        return Ok(outcome);
    }
    for &id in track_ids {
        let genre = match db.edit_genre_tags(id, &add, &remove) {
            Ok(GenreTagEdit::Changed(genre)) => genre,
            Ok(GenreTagEdit::Unchanged | GenreTagEdit::NotFound) => continue,
            Err(e) => {
                outcome.db_errors.push((id, e));
                continue;
            }
        };
        outcome.updated += 1;
        let location = db
            .get_track_by_track_id(id)
            .ok()
            .flatten()
            .and_then(|track| track.location_path);
        let w = organizer::TagWrite {
            // タグが無くなったらファイルの genre も空文字で上書きする (None だと「触らない」になる)。
            genre: Some(genre.as_deref().unwrap_or("")),
            ..Default::default()
        };
        if organizer::write_tags_to_location(location.as_deref(), &w) {
            outcome.file_write_failed += 1;
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

        let out = edit_genre_tags(&db, &[1, 2], &[" Techno "], &[]).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (2, 0));
        assert!(out.db_errors.is_empty());
        assert_eq!(genre(&db, 1).as_deref(), Some("House Techno"));
        assert_eq!(genre(&db, 2).as_deref(), Some("Techno"));

        let out = edit_genre_tags(&db, &[1, 2], &[], &["techno"]).unwrap();
        assert_eq!(out.updated, 2);
        assert_eq!(genre(&db, 1).as_deref(), Some("House"));
        assert_eq!(genre(&db, 2), None);
    }

    /// 変わらない曲・存在しない id は数えず、何も書かない。
    #[test]
    fn unchanged_and_missing_tracks_are_not_counted() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some("House"), None);
        add_track(&db, 2, None, None);

        // 1 は既に House を持つ。2 だけが変わる。999 は存在しない。
        let out = edit_genre_tags(&db, &[1, 2, 999], &["house"], &[]).unwrap();
        assert_eq!(out.updated, 1);
        assert_eq!(genre(&db, 1).as_deref(), Some("House"));
        assert_eq!(genre(&db, 2).as_deref(), Some("house"));

        // どの曲にも無いタグの削除は 0 件。
        let out = edit_genre_tags(&db, &[1, 2, 999], &[], &["Trance"]).unwrap();
        assert_eq!(out.updated, 0);
        // 追加も削除も指定しなければ何もしない。
        let out = edit_genre_tags(&db, &[1, 2], &[], &[]).unwrap();
        assert_eq!(out.updated, 0);
    }

    /// 複数のタグの追加・削除は 1 回の呼び出しでまとめて反映する。
    #[test]
    fn multiple_tags_in_one_call() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some("House Techno"), None);
        add_track(&db, 2, Some("Techno"), None);

        let out = edit_genre_tags(&db, &[1, 2], &["Acid", "Dub"], &["Techno"]).unwrap();
        assert_eq!(out.updated, 2);
        assert_eq!(genre(&db, 1).as_deref(), Some("House Acid Dub"));
        assert_eq!(genre(&db, 2).as_deref(), Some("Acid Dub"));
    }

    #[test]
    fn empty_tag_is_rejected() {
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, Some("House"), None);
        assert_eq!(
            edit_genre_tags(&db, &[1], &["   "], &[]).unwrap_err(),
            GenreTagError::EmptyTag
        );
        assert_eq!(
            edit_genre_tags(&db, &[1], &["Techno"], &[""]).unwrap_err(),
            GenreTagError::EmptyTag
        );
        // 一部が不正なら何も書かない。
        assert_eq!(genre(&db, 1).as_deref(), Some("House"));
    }

    /// ファイルへも書く: 実在するがタグを書けないファイルは fileWriteFailed に数える。
    /// 存在しないファイル・場所の無い曲は書き込みを試みないので数えない。
    /// genre が変わらない曲はファイルにも触らない (空の genre で上書きしない)。
    #[test]
    fn file_write_is_attempted_only_for_changed_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("not-audio.mp3");
        std::fs::write(&broken, b"this is not an audio file").unwrap();
        let missing = dir.path().join("missing.mp3");
        let db = Database::open_memory().unwrap();
        add_track(&db, 1, None, Some(&broken.to_string_lossy()));
        add_track(&db, 2, None, Some(&missing.to_string_lossy()));
        add_track(&db, 3, None, None);

        // genre が NULL の曲から無いタグを外しても、DB もファイルも書かない。
        let out = edit_genre_tags(&db, &[1, 2, 3], &[], &["House"]).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (0, 0));

        let out = edit_genre_tags(&db, &[1, 2, 3], &["House"], &[]).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (3, 1));
        for id in [1, 2, 3] {
            assert_eq!(genre(&db, id).as_deref(), Some("House"));
        }
        // 同じタグをもう一度足しても、ファイルへの書き込みは試みない。
        let out = edit_genre_tags(&db, &[1, 2, 3], &["House"], &[]).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (0, 0));

        let out = edit_genre_tags(&db, &[1, 2, 3], &[], &["House"]).unwrap();
        assert_eq!((out.updated, out.file_write_failed), (3, 1));
    }
}
