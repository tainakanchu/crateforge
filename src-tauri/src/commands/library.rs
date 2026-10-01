use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioPlayer;

use crate::db::Database;
use crate::importer;
use crate::itunes_xml::{parser, writer};
use crate::models::{
    AlbumRow, ArtistRow, ExportResult, GenreTagCount, ImportFileResult, ImportResult,
    ImportSummary, LibraryStats, Track, TrackEdit,
};
use crate::organizer;

fn get_db(app: &AppHandle) -> Result<Database, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Database::open(&app_dir).map_err(|e| format!("Failed to open database: {}", e))
}

#[tauri::command]
pub fn import_library(app: AppHandle, xml_path: String) -> Result<ImportResult, String> {
    let db = get_db(&app)?;
    let (track_count, playlist_count, missing_files) = parser::import_library(&xml_path, &db)?;

    db.set_state("last_xml_path", &xml_path)
        .map_err(|e| e.to_string())?;

    Ok(ImportResult {
        track_count,
        playlist_count,
        missing_files,
    })
}

#[tauri::command]
pub fn export_library(app: AppHandle, output_path: String) -> Result<ExportResult, String> {
    let db = get_db(&app)?;
    writer::export_library(&db, &output_path)
}

#[tauri::command]
pub fn import_files(app: AppHandle, paths: Vec<String>) -> Result<ImportFileResult, String> {
    let db = get_db(&app)?;
    Ok(importer::import_files(&db, &paths))
}

/// フォルダ (とファイル) をまとめて取り込む。フォルダは再帰的に走査し、
/// 対応拡張子のファイルだけを取り込む。既にライブラリにあるパスはスキップする。
/// 進行状況は `import-progress` イベント (`{done, total}`) で通知する。
#[tauri::command]
pub fn import_folders(app: AppHandle, paths: Vec<String>) -> Result<ImportSummary, String> {
    let db = get_db(&app)?;
    let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let event_app = app.clone();
    // 大量ファイルでイベントを流しすぎないよう、最初・最後・25件ごとだけ通知する。
    let summary = importer::import_folders(&db, &roots, move |done, total| {
        if done == 0 || done == total || done % 25 == 0 {
            let _ = event_app.emit(
                "import-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        }
    });
    Ok(summary)
}

#[tauri::command]
pub fn get_tracks(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.get_tracks(
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_tracks(
    app: AppHandle,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.search_tracks(
        &query,
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// track_id 列を入力順のまま Track へ解決する。見つからない ID はスキップ。
/// Up Next がフロントのロード済みページ (500件) を超える曲も表示できるようにするためのもの。
#[tauri::command]
pub fn get_tracks_by_ids(app: AppHandle, track_ids: Vec<i64>) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    let db = get_db(&app)?;
    db.library_stats().map_err(|e| e.to_string())
}

/// `Option<Option<i64>>` のパッチを最終値へ解決する。
/// `Some(Some(v))`=設定 / `Some(None)`=クリア / `None`=旧値を維持。
fn resolve_int(edit: &Option<Option<i64>>, before: Option<i64>) -> Option<i64> {
    match edit {
        Some(v) => *v,
        None => before,
    }
}

#[tauri::command]
pub fn update_track(app: AppHandle, track_id: i64, edits: TrackEdit) -> Result<(), String> {
    let db = get_db(&app)?;

    // 1. 編集前のトラックを取得 (旧 location / 非編集フィールドの保持に使う)。
    let before = db
        .get_track_by_track_id(track_id)
        .map_err(|e| e.to_string())?;

    // 2. DB を更新 (ここまでは必ず確定させる)。
    db.update_track(track_id, &edits)
        .map_err(|e| e.to_string())?;

    // 3. 書き戻しのガード: 旧トラックや実ファイルが無いなら DB 更新だけで終了。
    //    タグ書き戻し・移動の失敗は警告に留め、編集自体は成功扱いとする。
    let Some(before) = before else { return Ok(()) };
    let loc = before.location_path.clone();

    // 4. 最終値を確定 (edits 優先、来なかった項目は旧値)。
    let name = edits.name.clone().or(before.name.clone());
    let artist = edits.artist.clone().or(before.artist.clone());
    let album_artist = edits.album_artist.clone().or(before.album_artist.clone());
    let composer = edits.composer.clone().or(before.composer.clone());
    let album = edits.album.clone().or(before.album.clone());
    let genre = edits.genre.clone().or(before.genre.clone());
    let comments = edits.comments.clone().or(before.comments.clone());
    let year = resolve_int(&edits.year, before.year);
    let track_number = resolve_int(&edits.track_number, before.track_number);
    let track_count = resolve_int(&edits.track_count, before.track_count);
    let disc_number = resolve_int(&edits.disc_number, before.disc_number);
    let disc_count = resolve_int(&edits.disc_count, before.disc_count);
    // Compilation は編集された場合は新値、なければ旧値を引き継ぐ。
    let compilation = edits.compilation.unwrap_or(before.compilation);

    // BPM / Key もファイルタグへ書く (#164)。
    // BPM はトラック自身の値 (ユーザーが編集した可能性がある) を優先し、
    // 未設定なら解析結果へフォールバックする。Key は解析結果の key_name のみ。
    let analysis = db.get_analysis(track_id).ok().flatten();
    let bpm = resolve_int(&edits.bpm, before.bpm)
        .filter(|n| *n > 0)
        .map(|n| n as f64)
        .or_else(|| analysis.as_ref().and_then(|a| a.bpm));
    let key = analysis
        .as_ref()
        .and_then(|a| a.key_name.as_deref())
        .and_then(organizer::key_name_to_initial_key);

    // 5. 実ファイルのタグを書き戻す (他アプリでも編集内容が見えるように)。
    //    #163: これは整理先フォルダの設定とは無関係に常に行う。
    //    HTTP API (PATCH /api/tracks/:id) と同じ organizer 側の関数を使う。
    let w = organizer::TagWrite {
        title: name.as_deref(),
        artist: artist.as_deref(),
        album_artist: album_artist.as_deref(),
        composer: composer.as_deref(),
        album: album.as_deref(),
        genre: genre.as_deref(),
        comments: comments.as_deref(),
        year,
        track_number,
        track_count,
        disc_number,
        disc_count,
        compilation: Some(compilation),
        bpm,
        key,
    };
    organizer::write_tags_to_location(loc.as_deref(), &w);

    // 6. 整理 (フォルダ分け + iTunes 準拠リネーム) は整理先ルートが設定されている
    //    ときだけ行う。未設定なら移動せずここで終了 (タグは 5 で書き戻し済み)。
    let Some(loc) = loc else { return Ok(()) };
    let src = Path::new(&loc);
    if !src.exists() {
        return Ok(());
    }
    let meta = organizer::TrackMeta {
        title: name.as_deref(),
        artist: artist.as_deref(),
        album_artist: album_artist.as_deref(),
        album: album.as_deref(),
        compilation,
        track_number,
        disc_number,
        disc_count,
    };
    let Some(target) = organizer::organize_target(db.organize_root().as_deref(), &meta, src) else {
        return Ok(());
    };
    // 7. 新ターゲットへ移動し、DB の location を追従させる。
    match organizer::relocate(src, &target, organizer::Mode::Move) {
        Ok(dest) if dest != src => {
            let dest_str = dest.to_string_lossy().to_string();
            let url = writer::path_to_file_url(&dest_str);
            db.set_track_location(track_id, &dest_str, &url)
                .map_err(|e| e.to_string())?;
        }
        Ok(_) => {}
        Err(e) => eprintln!("relocate failed for {}: {}", loc, e),
    }
    Ok(())
}

/// 整理先 (ライブラリルート) を取得する。未設定なら `None`。
#[tauri::command]
pub fn get_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = get_db(&app)?;
    db.get_state("library_root").map_err(|e| e.to_string())
}

/// 整理先 (ライブラリルート) を設定する。空文字を渡すと整理を無効化する。
#[tauri::command]
pub fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_state("library_root", &path)
        .map_err(|e| e.to_string())
}

/// 既存トラックのパスから整理先(ライブラリルート)を自動推定する。推定不可なら None。
/// 設定 UI の「自動検出」から呼ぶ(検出のみ。確定は呼び出し側で set_library_root)。
#[tauri::command]
pub fn detect_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = get_db(&app)?;
    db.detect_library_root().map_err(|e| e.to_string())
}

/// 検索・スマプレの字体ゆれ吸収レベルを取得する。未設定なら "standard"。
#[tauri::command]
pub fn get_search_fold_level(app: AppHandle) -> Result<String, String> {
    let db = get_db(&app)?;
    Ok(db
        .get_state("search_fold_level")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "standard".to_string()))
}

/// 検索・スマプレの字体ゆれ吸収レベルを設定する。受理値は off/light/standard。
/// 不正値は standard に正規化する。
#[tauri::command]
pub fn set_search_fold_level(app: AppHandle, level: String) -> Result<(), String> {
    let v = match level.as_str() {
        "off" => "off",
        "light" => "light",
        _ => "standard",
    };
    let db = get_db(&app)?;
    db.set_state("search_fold_level", v)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_track_rating(app: AppHandle, track_id: i64, rating: i64) -> Result<(), String> {
    let db = get_db(&app)?;
    db.set_rating(track_id, rating).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_genre_tag(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = get_db(&app)?;
    for tid in track_ids {
        db.add_genre_tag(tid, &tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_genre_tag(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = get_db(&app)?;
    for tid in track_ids {
        db.remove_genre_tag(tid, &tag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_all_genre_tags(app: AppHandle) -> Result<Vec<GenreTagCount>, String> {
    let db = get_db(&app)?;
    db.get_all_genre_tags().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_albums(
    app: AppHandle,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AlbumRow>, String> {
    let db = get_db(&app)?;
    db.get_albums(
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit.unwrap_or(500),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_album_tracks(app: AppHandle, album_key: String) -> Result<Vec<Track>, String> {
    let db = get_db(&app)?;
    db.get_album_tracks(&album_key).map_err(|e| e.to_string())
}

/// Artists ビュー用のサーバ集約。sort_field は name / trackCount / albumCount のみ有効で、
/// それ以外は name に倒す (db 側 artist_order_by)。
#[tauri::command]
pub fn get_artists(
    app: AppHandle,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ArtistRow>, String> {
    let db = get_db(&app)?;
    db.get_artists(
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit.unwrap_or(500),
        offset.unwrap_or(0),
    )
    .map_err(|e| e.to_string())
}

/// 指定アーティストのアルバム一覧 (Artists ビューの展開表示用)。
#[tauri::command]
pub fn get_artist_albums(app: AppHandle, name: String) -> Result<Vec<AlbumRow>, String> {
    let db = get_db(&app)?;
    db.get_artist_albums(&name).map_err(|e| e.to_string())
}

/// 削除対象の実ファイルが「整理ルート配下」にあることを検証し、正規化パスを返す。
///
/// `trash` クレートを依存に持たないため OS のゴミ箱へは送れず、削除は復元不能になる。
/// そのためアプリが管理するライブラリルート配下に限って実削除を許可し、
/// それ以外 (外部参照のファイル) は消さずにエラーで返す。
/// symlink でルート外を指すファイルも弾けるよう、両者 canonicalize してから比較する。
fn ensure_inside_root(root: &Path, file: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(file)
        .map_err(|e| format!("{} のパスを解決できませんでした: {}", file.display(), e))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "{} はライブラリルート ({}) の外にあるため、安全のためファイルを削除しません。\
             「ファイルも削除する」のチェックを外せば、ライブラリ (DB) からの削除だけを行えます。",
            file.display(),
            root.display()
        ));
    }
    Ok(canonical)
}

/// 指定トラックをライブラリから削除する。実際に消えた曲数を返す。
///
/// - DB からはトラック行と依存行 (プレイリスト所属 / 再生履歴 / 解析結果 / 同期メタ) を消す。
/// - `delete_files` が true のときだけ実ファイルも削除する。ゴミ箱へ送れない
///   (`trash` クレート非依存) ため、ライブラリルート配下のファイルに限定し、
///   1 件でもルート外があれば **何も消さずに** エラーを返す。
/// - 削除した曲が再生中 / キューに積まれていれば、再生を止めキューから外す。
#[tauri::command]
pub fn delete_tracks(
    app: AppHandle,
    track_ids: Vec<i64>,
    delete_files: bool,
    player: tauri::State<'_, Mutex<AudioPlayer>>,
) -> Result<usize, String> {
    if track_ids.is_empty() {
        return Ok(0);
    }
    let db = get_db(&app)?;

    // 1. ファイル削除は「全件検証 → まとめて実行」にして、途中失敗で
    //    DB とファイルがちぐはぐになるのを防ぐ。
    let mut files: Vec<PathBuf> = Vec::new();
    if delete_files {
        let root = db.organize_root().ok_or_else(|| {
            "ファイルを削除するにはライブラリルート (整理先) の設定が必要です。\
             設定でルートを指定するか、ライブラリ (DB) からの削除だけを行ってください。"
                .to_string()
        })?;
        let root = std::fs::canonicalize(&root)
            .map_err(|e| format!("ライブラリルート ({}) を解決できませんでした: {}", root, e))?;
        for track in db
            .get_tracks_by_ids(&track_ids)
            .map_err(|e| e.to_string())?
        {
            let Some(loc) = track.location_path.filter(|p| !p.is_empty()) else {
                continue;
            };
            let path = Path::new(&loc);
            // 既に存在しないファイルは検証せずスキップ (DB の掃除だけ行う)。
            if !path.exists() {
                continue;
            }
            files.push(ensure_inside_root(&root, path)?);
        }
    }

    // 2. DB から削除 (1 トランザクション)。
    let deleted = db.delete_tracks(&track_ids).map_err(|e| e.to_string())?;

    // 3. 検証済みファイルを削除する。個別の失敗 (権限など) は警告に留め、
    //    DB 側の削除は確定させる (再試行しても DB に行は残っていない)。
    for path in files {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("remove_file failed for {}: {}", path.display(), e);
            crate::logging::write_line(
                "warn",
                &format!("failed to delete file {}: {}", path.display(), e),
            );
        }
    }

    // 4. 再生中 / キューに残っている曲を落とす。
    let removed: HashSet<i64> = track_ids.into_iter().collect();
    crate::commands::playback::drop_tracks_from_playback(&app, &player, &removed);

    Ok(deleted)
}

/// OS のファイルマネージャでファイルを表示する (Finder / エクスプローラで表示)。
///
/// `tauri-plugin-shell` の Rust 側 API (`shell().command()`) を使う。こちらは
/// フロントの `shell:allow-execute` スコープを通らない (ACL は IPC 経由の呼び出しにのみ効く)
/// ため capabilities の追加は不要で、実行するプログラムと引数はこの関数が固定する。
#[tauri::command]
pub fn reveal_in_file_manager(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("ファイルが見つかりません: {}", path));
    }
    let shell = app.shell();

    #[cfg(target_os = "macos")]
    let cmd = shell.command("open").args(["-R", path.as_str()]);

    // explorer は `/select,<path>` を 1 引数として受け取る。
    #[cfg(target_os = "windows")]
    let cmd = shell.command("explorer").arg(format!("/select,{}", path));

    // Linux にはファイルを選択状態で開く共通の方法が無いので、親ディレクトリを開く。
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = {
        let dir = target
            .parent()
            .ok_or_else(|| format!("親ディレクトリを特定できません: {}", path))?;
        shell
            .command("xdg-open")
            .arg(dir.to_string_lossy().to_string())
    };

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("ファイルマネージャを起動できませんでした: {}", e))
}

pub(crate) fn open_db(app: &AppHandle) -> Result<Database, String> {
    get_db(app)
}
