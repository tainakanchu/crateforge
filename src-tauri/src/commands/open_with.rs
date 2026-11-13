//! 「このアプリで開く」で渡されたファイルの再生と、一時再生曲のライブラリ取り込み。
//! 受け取り (argv / single-instance / macOS の Opened) は `crate::open_with`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioPlayer;
use crate::commands::library::open_db;
use crate::commands::playback::{emit_queue_changed, AdvancePayload, PreviewMode};
use crate::db::Database;
use crate::models::Track;
use crate::open_with::{self, PathStyle};
use crate::playback_target::PlaybackCoordinator;
use crate::transient::{is_transient_id, TransientTracks};

/// `play_opened_files` の結果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFilesResult {
    /// 置き換えたキュー (開いた順)。ライブラリの曲は実 ID、それ以外は一時再生の負の ID。
    pub track_ids: Vec<i64>,
    /// 再生を始めた曲。
    pub playing_track_id: Option<i64>,
    /// ライブラリに既にあった曲の数。
    pub library_count: usize,
    /// ライブラリ外 (一時再生) の曲の数。
    pub transient_count: usize,
}

/// 比較キー → ライブラリの track_id。同じファイルを指す行が複数あれば最小の ID を使う。
fn library_path_index(rows: Vec<(i64, String)>, style: PathStyle) -> HashMap<String, i64> {
    let mut index = HashMap::with_capacity(rows.len());
    // rows は track_id 昇順なので、先に入った (小さい) ID を残す。
    for (track_id, path) in rows {
        index
            .entry(open_with::path_key(&path, style))
            .or_insert(track_id);
    }
    index
}

/// 開いたファイルがライブラリの曲ならその track_id。
fn library_track_for(
    index: &HashMap<String, i64>,
    path: &Path,
    style: PathStyle,
) -> Option<i64> {
    open_with::candidate_keys(path, style)
        .iter()
        .find_map(|k| index.get(k).copied())
}

/// 開いたファイル群を再生用の track_id 列にする。ライブラリにあればその ID、
/// 無ければ `register` で一時再生曲として登録した ID。
fn resolve_track_ids(
    paths: &[PathBuf],
    index: &HashMap<String, i64>,
    style: PathStyle,
    mut register: impl FnMut(&Path) -> i64,
) -> Vec<i64> {
    paths
        .iter()
        .map(|p| library_track_for(index, p, style).unwrap_or_else(|| register(p)))
        .collect()
}

fn load_index(db: &Database) -> Result<HashMap<String, i64>, String> {
    let rows = db.track_location_paths().map_err(|e| e.to_string())?;
    Ok(library_path_index(rows, PathStyle::current()))
}

/// フロントのマウント時に、起動前 / 準備前に届いていたファイルを取り出す。
/// これ以降に届いたファイルは `open-files` イベントで渡す。
#[tauri::command]
pub fn take_pending_open_files(pending: tauri::State<'_, open_with::PendingOpen>) -> Vec<String> {
    pending
        .take_for_frontend()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// 開いたファイルでキューを置き換え (開いた順)、先頭から再生する。
/// ライブラリにある曲は通常の曲として、無い曲は DB に追加せず一時再生曲として再生する。
/// 先頭が再生できなければ (ファイル破損など) 次へ進む。全滅ならエラー。
#[tauri::command]
pub async fn play_opened_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<OpenedFilesResult, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let paths = open_with::keep_openable(paths);
    if paths.is_empty() {
        return Err("再生できる音声ファイルがありません".to_string());
    }

    let style = PathStyle::current();
    let index = load_index(&open_db(&app)?)?;
    let transient = app.state::<TransientTracks>();
    let track_ids = resolve_track_ids(&paths, &index, style, |p| transient.register(p));
    let transient_count = track_ids.iter().filter(|&&id| is_transient_id(id)).count();

    // 「開く」は通常の再生。試聴 (Preview) 中なら抜ける (フロントも exitPreview する)。
    app.state::<PreviewMode>().set(false);

    let player = app.state::<Mutex<AudioPlayer>>();
    player
        .lock()
        .map_err(|e| e.to_string())?
        .set_queue(track_ids.clone(), 0);
    emit_queue_changed(&app);

    let coord = app.state::<PlaybackCoordinator>().inner().clone();
    let mut played: Option<i64> = None;
    let mut last_err: Option<String> = None;
    for _ in 0..track_ids.len() {
        let Some(id) = player
            .lock()
            .map_err(|e| e.to_string())?
            .current_track_id_in_order()
        else {
            break;
        };
        match coord.play_track(id, false).await {
            Ok(()) => {
                played = Some(id);
                break;
            }
            Err(e) => {
                let skip = e.is_track_specific();
                last_err = Some(String::from(e));
                if !skip {
                    break;
                }
            }
        }
        let next = player.lock().map_err(|e| e.to_string())?.advance_next(false);
        if next.is_none() {
            break;
        }
    }
    if played.is_none() {
        // 全滅: 前の曲を鳴らし続けないよう止める (自動送りの全滅時と同じ)。
        let _ = coord.stop().await;
    }

    // キューから外れた一時再生曲を捨てる (再生中の曲は残す)。
    let current = coord.get_state().current_track_id;
    transient.retain(|id| track_ids.contains(&id) || Some(id) == current);

    emit_queue_changed(&app);
    let _ = app.emit("playback-advanced", AdvancePayload { track_id: played });

    let Some(playing) = played else {
        return Err(last_err.unwrap_or_else(|| "再生できませんでした".to_string()));
    };
    // ライブラリの曲は通常どおり裏で解析しておく (一時再生曲は Analyzer 側で除外される)。
    app.state::<crate::analyzer::Analyzer>()
        .submit(vec![playing], false);

    Ok(OpenedFilesResult {
        library_count: track_ids.len() - transient_count,
        transient_count,
        track_ids,
        playing_track_id: Some(playing),
    })
}

/// 一時再生曲をライブラリへ取り込み、キュー / 再生中の曲をライブラリの曲に付け替える。
/// 再生は止めずにそのまま続く (以降の再生実績はライブラリの曲として数える)。
/// 取り込んだ曲を返す。
#[tauri::command(async)]
pub fn import_transient_track(app: AppHandle, track_id: i64) -> Result<Track, String> {
    if !is_transient_id(track_id) {
        return Err("この曲は既にライブラリにあります".to_string());
    }
    let transient = app.state::<TransientTracks>();
    let entry = transient
        .get(track_id)
        .ok_or("この曲の情報が見つかりません (もう一度ファイルを開いてください)")?;
    let path = PathBuf::from(&entry.path);

    let db = open_db(&app)?;
    // 開いた後に別の経路で取り込まれていれば、二重に追加せずそれを使う。
    let index = load_index(&db)?;
    let new_id = match library_track_for(&index, &path, PathStyle::current()) {
        Some(id) => id,
        None => crate::importer::import_file(&db, &path)?,
    };

    app.state::<Mutex<AudioPlayer>>()
        .lock()
        .map_err(|e| e.to_string())?
        .replace_track_id(track_id, new_id);
    transient.remove(track_id);

    let _ = app.emit(
        "library-changed",
        serde_json::json!({ "playlistId": null }),
    );
    emit_queue_changed(&app);
    let current = app
        .state::<PlaybackCoordinator>()
        .get_state()
        .current_track_id;
    let _ = app.emit("playback-advanced", AdvancePayload { track_id: current });
    app.state::<crate::analyzer::Analyzer>()
        .submit(vec![new_id], false);

    db.get_track_by_track_id(new_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "取り込んだ曲が見つかりません".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_match_uses_normalized_paths_and_registers_the_rest() {
        let rows = vec![
            (3, r"C:\Music\Artist\Song.mp3".to_string()),
            (5, r"C:\Music\Other.flac".to_string()),
            // 同じファイルを指す重複行は小さい ID を使う。
            (9, r"c:\music\artist\song.mp3".to_string()),
        ];
        let index = library_path_index(rows, PathStyle::Windows);
        let paths = vec![
            PathBuf::from("c:/music/artist/SONG.MP3"),
            PathBuf::from(r"C:\Downloads\new.mp3"),
            PathBuf::from(r"\\?\C:\Music\Other.flac"),
            PathBuf::from(r"C:\Downloads\new2.wav"),
        ];
        let mut next = 0;
        let mut registered = Vec::new();
        let ids = resolve_track_ids(&paths, &index, PathStyle::Windows, |p| {
            next -= 1;
            registered.push(p.to_path_buf());
            next
        });
        assert_eq!(ids, vec![3, -1, 5, -2]);
        assert_eq!(
            registered,
            vec![
                PathBuf::from(r"C:\Downloads\new.mp3"),
                PathBuf::from(r"C:\Downloads\new2.wav")
            ]
        );
    }

    #[test]
    fn posix_library_match_is_case_sensitive() {
        let index = library_path_index(
            vec![(1, "/music/Song.mp3".to_string())],
            PathStyle::Posix,
        );
        assert_eq!(
            library_track_for(&index, Path::new("/music/Song.mp3"), PathStyle::Posix),
            Some(1)
        );
        assert_eq!(
            library_track_for(&index, Path::new("/music/song.mp3"), PathStyle::Posix),
            None
        );
    }

    #[test]
    fn library_match_follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.mp3");
        std::fs::write(&real, b"x").unwrap();
        let real = std::fs::canonicalize(&real).unwrap();
        let index = library_path_index(
            vec![(4, real.to_string_lossy().into_owned())],
            PathStyle::Posix,
        );
        #[cfg(unix)]
        {
            let link = dir.path().join("link.mp3");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(library_track_for(&index, &link, PathStyle::Posix), Some(4));
        }
        assert_eq!(library_track_for(&index, &real, PathStyle::Posix), Some(4));
    }
}
