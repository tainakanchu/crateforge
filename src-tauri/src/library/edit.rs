//! 曲メタデータの編集 (GUI の `update_track` と `PATCH /api/tracks[/:id]` の共通手順)。

use std::fmt;

use crate::db::tracks::{CheckedTrackEdit, InvalidTrackEdit};
use crate::db::Database;
use crate::models::{Track, TrackEdit};
use crate::organizer;

/// [`apply_track_edit`] の失敗。
#[derive(Debug)]
pub enum EditError {
    /// 入力の誤り (不正な Camelot キー、0..=100 の外の rating)。何も書き換えていない。API は 400。
    Invalid(InvalidTrackEdit),
    /// DB の読み書きに失敗した。
    Db(rusqlite::Error),
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EditError::Invalid(e) => write!(f, "{e}"),
            EditError::Db(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EditError {}

impl From<InvalidTrackEdit> for EditError {
    fn from(e: InvalidTrackEdit) -> Self {
        EditError::Invalid(e)
    }
}

impl From<rusqlite::Error> for EditError {
    fn from(e: rusqlite::Error) -> Self {
        EditError::Db(e)
    }
}

/// [`apply_track_edit`] の結果。
#[derive(Debug)]
pub struct TrackEditOutcome {
    /// 更新後 (整理による移動後) の Track。
    pub track: Track,
    /// タグの書き込みを試みて失敗したか (ファイルが無い場合は試みないので false)。
    pub file_write_failed: bool,
    /// 整理 (フォルダ移動 + リネーム) を試みて失敗したか。
    pub relocate_failed: bool,
}

/// 1 曲に編集を適用する。
///
/// 0. 入力を検証する。不正な Camelot キー・0..=100 の外の rating は、何も書かずに
///    [`EditError::Invalid`]。
/// 1. DB を更新する (ここまでは必ず確定させる。Key と本体の UPDATE は 1 トランザクション)。
/// 2. **更新後の DB の値** を最終値として実ファイルのタグへ書き戻す (他アプリにも見えるように。
///    整理先フォルダの設定とは無関係に常に行う: #163)。最終値の導出はここ 1 か所。
/// 3. 整理先ルートが設定されていれば、同じ最終値でフォルダ移動 + リネームし DB の location を追従させる。
///
/// タグ書き戻し・移動の失敗は編集の失敗にせず、[`TrackEditOutcome`] のフラグで知らせる。
/// 対象が存在しない場合 (0 行更新) は `Ok(None)`。
pub fn apply_track_edit(
    db: &Database,
    track_id: i64,
    edit: &TrackEdit,
) -> Result<Option<TrackEditOutcome>, EditError> {
    apply_checked_edit(db, track_id, &check_edit(edit)?)
}

/// 編集内容を検証・正規化する (手順 0)。複数曲に同じ編集を当てるときは、これを **1 回だけ**
/// 先に呼んでから [`apply_checked_edit`] を曲ごとに呼ぶ。対象が 0 曲でも入力の誤りを返せ、
/// 途中の曲まで書いてから失敗することもない。
pub fn check_edit(edit: &TrackEdit) -> Result<CheckedTrackEdit, EditError> {
    Ok(CheckedTrackEdit::new(edit)?)
}

/// 検証済みの編集を 1 曲に適用する ([`apply_track_edit`] の手順 1 以降)。
pub fn apply_checked_edit(
    db: &Database,
    track_id: i64,
    edit: &CheckedTrackEdit,
) -> Result<Option<TrackEditOutcome>, EditError> {
    db.update_track(track_id, edit)?;
    // 更新後の Track を取得。存在しない id は 0 行更新なので空 → None。
    let Some(mut track) = db.get_tracks_by_ids(&[track_id])?.into_iter().next() else {
        return Ok(None);
    };

    // BPM / Key もファイルタグへ書く (#164)。BPM はトラック自身の値 (ユーザーが編集した
    // 可能性がある) を優先し、未設定なら解析結果へフォールバックする。Key は実効キー
    // (手動上書き ?? 解析値, #172) を DJ ソフトが読む音楽表記 ("Am" 等) に変換して InitialKey へ書く。
    let analysis = db.get_analysis(track_id).ok().flatten();
    let bpm = track
        .bpm
        .filter(|n| *n > 0)
        .map(|n| n as f64)
        .or_else(|| analysis.as_ref().and_then(|a| a.bpm));
    let key =
        organizer::effective_initial_key(track.key_camelot_user.as_deref(), analysis.as_ref());

    let file_write_failed = {
        let w = organizer::TagWrite {
            title: track.name.as_deref(),
            artist: track.artist.as_deref(),
            album_artist: track.album_artist.as_deref(),
            composer: track.composer.as_deref(),
            album: track.album.as_deref(),
            genre: track.genre.as_deref(),
            comments: track.comments.as_deref(),
            year: track.year,
            track_number: track.track_number,
            track_count: track.track_count,
            disc_number: track.disc_number,
            disc_count: track.disc_count,
            compilation: Some(track.compilation),
            bpm,
            key,
        };
        organizer::write_tags_to_location(track.location_path.as_deref(), &w)
    };

    // 整理 (フォルダ分け + iTunes 準拠リネーム) と DB location の追従。
    // 整理先未設定 / 無効なら移動しない。移動後の DB 更新失敗だけは Err。
    let relocated = {
        let meta = organizer::TrackMeta {
            title: track.name.as_deref(),
            artist: track.artist.as_deref(),
            album_artist: track.album_artist.as_deref(),
            album: track.album.as_deref(),
            compilation: track.compilation,
            track_number: track.track_number,
            disc_number: track.disc_number,
            disc_count: track.disc_count,
        };
        organizer::relocate_after_edit(db, track_id, track.location_path.as_deref(), &meta)?
    };
    let relocate_failed = relocated == organizer::RelocateOutcome::Failed;
    // 移動した場合は返す Track の locationPath / locationRaw を DB に書いた新パスへ揃える。
    if let organizer::RelocateOutcome::Moved { path, url } = relocated {
        track.location_path = Some(path);
        track.location_raw = Some(url);
    }
    Ok(Some(TrackEditOutcome {
        track,
        file_write_failed,
        relocate_failed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with_track(track_id: i64) -> Database {
        let db = Database::open_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, artist, album, bpm, file_exists)
                 VALUES (?1, 'AAAAAAAAAAAAAAAA', 'Old', 'Artist', 'Album', 120, 1)",
                [track_id],
            )
            .unwrap();
        db
    }

    /// 存在しない曲は None (GUI は成功扱い、API は 404 に写す)。
    #[test]
    fn missing_track_is_none() {
        let db = Database::open_memory().unwrap();
        let edit = TrackEdit {
            name: Some("X".into()),
            ..Default::default()
        };
        assert!(apply_track_edit(&db, 42, &edit).unwrap().is_none());
    }

    /// 返る Track は「edit の値、来なかった項目は旧値」= 更新後の DB の値。
    /// ファイルが無い曲は書き戻しも整理も試みないので、どちらの失敗フラグも立たない。
    #[test]
    fn outcome_track_is_post_update_row() {
        let db = db_with_track(1);
        let edit = TrackEdit {
            name: Some("New".into()),
            year: Some(Some(1999)),
            bpm: Some(None),
            key_camelot_user: Some(Some("8a".into())),
            ..Default::default()
        };
        let out = apply_track_edit(&db, 1, &edit).unwrap().unwrap();
        assert_eq!(out.track.name.as_deref(), Some("New"));
        assert_eq!(out.track.artist.as_deref(), Some("Artist"));
        assert_eq!(out.track.year, Some(1999));
        assert_eq!(out.track.bpm, None);
        // Key の上書きは DB 側で正規化された値を読み直す。
        assert_eq!(out.track.key_camelot_user.as_deref(), Some("8A"));
        assert!(!out.file_write_failed);
        assert!(!out.relocate_failed);
    }

    /// 不正な Camelot キーは Invalid(Key)。同じ edit の他の項目も含め、何も書き換えない。
    #[test]
    fn invalid_key_is_rejected_without_writing() {
        let db = db_with_track(1);
        let edit = TrackEdit {
            name: Some("New".into()),
            key_camelot_user: Some(Some("13Z".into())),
            ..Default::default()
        };
        let err = apply_track_edit(&db, 1, &edit).unwrap_err();
        assert!(matches!(err, EditError::Invalid(InvalidTrackEdit::Key(_))), "{err:?}");
        assert_eq!(err.to_string(), "invalid Camelot key: 13Z");
        let track = db.get_track_by_track_id(1).unwrap().unwrap();
        assert_eq!(track.name.as_deref(), Some("Old"));
        assert_eq!(track.key_camelot_user, None);
        // 存在しない曲でも入力の誤りが先 (404 ではなく 400 相当)。
        assert!(matches!(
            apply_track_edit(&db, 99, &edit),
            Err(EditError::Invalid(InvalidTrackEdit::Key(_)))
        ));
    }

    /// 範囲外の rating は Invalid(Rating)。同じ edit の他の項目も含め、何も書き換えない。
    #[test]
    fn out_of_range_rating_is_rejected_without_writing() {
        let db = db_with_track(1);
        for bad in [-1, 101] {
            let edit = TrackEdit {
                name: Some("New".into()),
                rating: Some(bad),
                ..Default::default()
            };
            let err = apply_track_edit(&db, 1, &edit).unwrap_err();
            assert!(
                matches!(err, EditError::Invalid(InvalidTrackEdit::Rating(v)) if v == bad),
                "{err:?}"
            );
            assert_eq!(
                err.to_string(),
                format!("rating must be between 0 and 100: {bad}")
            );
        }
        let track = db.get_track_by_track_id(1).unwrap().unwrap();
        assert_eq!(track.name.as_deref(), Some("Old"));
        assert_eq!(track.rating, None);
    }

    /// 空白のみ / null は上書き解除。
    #[test]
    fn blank_key_clears_override() {
        let db = db_with_track(1);
        let set = TrackEdit {
            key_camelot_user: Some(Some("08b".into())),
            ..Default::default()
        };
        let out = apply_track_edit(&db, 1, &set).unwrap().unwrap();
        assert_eq!(out.track.key_camelot_user.as_deref(), Some("8B"));
        for clear in [Some("  ".to_string()), None] {
            apply_track_edit(&db, 1, &set).unwrap();
            let edit = TrackEdit {
                key_camelot_user: Some(clear),
                ..Default::default()
            };
            let out = apply_track_edit(&db, 1, &edit).unwrap().unwrap();
            assert_eq!(out.track.key_camelot_user, None);
        }
    }
}
