use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioPlayer;

use crate::db::Database;
use crate::importer;
use crate::itunes_xml::{parser, writer};
use crate::models::{
    AlbumRow, ArtistRow, ExportResult, FileCheckSummary, GenreTagCount, ImportFileResult,
    ImportResult, ImportSummary, LibraryStats, Tag, TagCount, TechMetaRefreshSummary, Track,
    TrackEdit,
};

/// アプリのデータディレクトリにある DB を開く。Tauri コマンドはすべてこれを使う
/// (開けなかったときの文言を 1 か所にするため)。
pub(crate) fn open_db(app: &AppHandle) -> Result<Database, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Database::open(&app_dir).map_err(|e| format!("Failed to open database: {}", e))
}

#[tauri::command]
pub fn import_library(app: AppHandle, xml_path: String) -> Result<ImportResult, String> {
    let db = open_db(&app)?;
    let (track_count, playlist_count, missing_files) = parser::import_library(&xml_path, &db)?;

    db.set_state("last_xml_path", &xml_path)
        .map_err(|e| e.to_string())?;

    Ok(ImportResult {
        track_count,
        playlist_count,
        missing_files,
    })
}

#[tauri::command(async)]
pub fn export_library(app: AppHandle, output_path: String) -> Result<ExportResult, String> {
    let db = open_db(&app)?;
    writer::export_library(&db, &output_path)
}

#[tauri::command]
pub fn import_files(app: AppHandle, paths: Vec<String>) -> Result<ImportFileResult, String> {
    let db = open_db(&app)?;
    Ok(importer::import_files(&db, &paths))
}

/// フォルダ (とファイル) をまとめて取り込む。フォルダは再帰的に走査し、
/// 対応拡張子のファイルだけを取り込む。既にライブラリにあるパスはスキップする。
/// 進行状況は `import-progress` イベント (`{done, total}`) で通知する。
#[tauri::command]
pub fn import_folders(app: AppHandle, paths: Vec<String>) -> Result<ImportSummary, String> {
    let db = open_db(&app)?;
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

/// 技術メタデータ一括再読み取りの多重起動ガード (#171)。
static TECH_META_REFRESH_RUNNING: AtomicBool = AtomicBool::new(false);

/// リンク切れ再チェックの多重起動ガード。
static FILE_CHECK_RUNNING: AtomicBool = AtomicBool::new(false);

/// 実行中フラグを確実に戻すための RAII ガード (panic 時も解除する)。
struct RunningGuard(&'static AtomicBool);
impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 既存ライブラリの技術メタデータ (bitrate / sample rate / size / codec 等, #171) のうち
/// 未取得 (NULL) の曲だけをファイルから読み直す。タグ由来のユーザー編集列には触れない。
/// ファイル I/O が重いのでワーカースレッドで実行し、進捗は `tech-meta-progress`
/// イベント (`{done, total}`) で通知する。完了後は `library-changed` を送る。
#[tauri::command]
pub async fn refresh_tech_metadata(app: AppHandle) -> Result<TechMetaRefreshSummary, String> {
    if TECH_META_REFRESH_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("技術情報の再読み取りは既に実行中です".to_string());
    }
    let worker_app = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = RunningGuard(&TECH_META_REFRESH_RUNNING);
        let db = open_db(&worker_app)?;
        let event_app = worker_app.clone();
        importer::refresh_missing_tech_meta(&db, move |done, total| {
            if done == 0 || done == total || done % 25 == 0 {
                let _ = event_app.emit(
                    "tech-meta-progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            }
        })
    })
    .await
    .map_err(|e| format!("tech meta task panicked: {}", e))??;
    if summary.updated > 0 {
        let _ = app.emit("library-changed", serde_json::json!({ "playlistId": null }));
    }
    Ok(summary)
}

/// ライブラリ全曲の実ファイル有無を確認し直し、`file_exists` を更新する (リンク切れ再チェック)。
/// 欠損 → 発見 / 発見 → 欠損の両方向を反映する。数万曲の stat になるのでワーカースレッドで
/// 実行し、進捗は `file-check-progress` イベント (`{done, total}`) で通知する。
/// 1 曲でも状態が変わったら `library-changed` を送る。
#[tauri::command]
pub async fn rescan_file_existence(app: AppHandle) -> Result<FileCheckSummary, String> {
    if FILE_CHECK_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("リンク切れの再チェックは既に実行中です".to_string());
    }
    let worker_app = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = RunningGuard(&FILE_CHECK_RUNNING);
        let db = open_db(&worker_app)?;
        let event_app = worker_app.clone();
        // stat は 1 件が軽いので、tech-meta (25 件ごと) より間引いて通知する。
        importer::rescan_file_existence(&db, move |done, total| {
            if done == 0 || done == total || done % 250 == 0 {
                let _ = event_app.emit(
                    "file-check-progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            }
        })
    })
    .await
    .map_err(|e| format!("file check task panicked: {}", e))??;
    if summary.newly_missing > 0 || summary.newly_found > 0 {
        // 見つかり直したファイルは埋め込みアートワークが取れるようになるので、
        // そのときだけ artworkChanged を立ててジャケットを取り直させる (#213)。
        let _ = app.emit(
            "library-changed",
            serde_json::json!({ "playlistId": null, "artworkChanged": summary.newly_found > 0 }),
        );
    }
    Ok(summary)
}

/// 曲の実ファイルの場所を手動で指定し直す (「ファイルの場所を指定…」)。
/// 指定パスが実在するファイルか検証してから location を書き換え、`file_exists = 1` にする。
/// 更新後の Track を返し、`library-changed` を送る (一覧・ジャケットを再読み込みさせる)。
#[tauri::command(async)]
pub fn relocate_track_file(app: AppHandle, track_id: i64, path: String) -> Result<Track, String> {
    let db = open_db(&app)?;
    let track = importer::relocate_track(&db, track_id, &path)?;
    // 参照先ファイルが変わり埋め込みアートワークも変わりうるので artworkChanged を立てる (#213)。
    let _ = app.emit(
        "library-changed",
        serde_json::json!({ "playlistId": null, "artworkChanged": true }),
    );
    Ok(track)
}

#[tauri::command(async)]
pub fn get_tracks(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
    db.get_tracks(
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        sort_field.as_deref(),
        sort_order.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn search_tracks(
    app: AppHandle,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sort_field: Option<String>,
    sort_order: Option<String>,
) -> Result<Vec<Track>, String> {
    let db = open_db(&app)?;
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
#[tauri::command(async)]
pub fn get_tracks_by_ids(app: AppHandle, track_ids: Vec<i64>) -> Result<Vec<Track>, String> {
    // ライブラリ外の一時再生曲 (負の ID) はレジストリから引く。PlayerBar / Up Next が
    // 再生中・キュー中の曲をこのコマンドで解決するので、表示はこれだけで追従する。
    if !track_ids
        .iter()
        .any(|&id| crate::transient::is_transient_id(id))
    {
        let db = open_db(&app)?;
        return db.get_tracks_by_ids(&track_ids).map_err(|e| e.to_string());
    }
    let transient = app.state::<crate::transient::TransientTracks>();
    let db_ids: Vec<i64> = track_ids
        .iter()
        .copied()
        .filter(|&id| !crate::transient::is_transient_id(id))
        .collect();
    let from_db: std::collections::HashMap<i64, Track> = if db_ids.is_empty() {
        Default::default()
    } else {
        open_db(&app)?
            .get_tracks_by_ids(&db_ids)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|t| (t.track_id, t))
            .collect()
    };
    // 入力順を保ち、見つからない ID は飛ばす (DB 版と同じ規約)。
    Ok(track_ids
        .iter()
        .filter_map(|&id| {
            if crate::transient::is_transient_id(id) {
                transient.get(id).map(|t| t.track)
            } else {
                from_db.get(&id).cloned()
            }
        })
        .collect())
}

#[tauri::command(async)]
pub fn get_library_stats(app: AppHandle) -> Result<LibraryStats, String> {
    let db = open_db(&app)?;
    db.library_stats().map_err(|e| e.to_string())
}

/// 曲のメタデータを編集する (Get Info)。手順は HTTP API の `PATCH /api/tracks/:id` と共通の
/// [`crate::library::edit::apply_track_edit`] (DB 更新 → タグ書き戻し → 整理)。
///
/// GUI では、対象の曲が無くても、タグ書き戻し・移動に失敗しても成功として返す
/// (失敗は警告ログに留め、編集自体は確定させる)。
#[tauri::command]
pub fn update_track(app: AppHandle, track_id: i64, mut edits: TrackEdit) -> Result<(), String> {
    let db = open_db(&app)?;
    // rating は星クリック (set_track_rating) と同じく 0..=100 に収める (GUI は範囲外を送らない)。
    edits.rating = edits.rating.map(crate::rating::clamp_rating);
    crate::library::edit::apply_track_edit(&db, track_id, &edits)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 整理先 (ライブラリルート) を取得する。未設定なら `None`。
#[tauri::command]
pub fn get_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = open_db(&app)?;
    db.get_state("library_root").map_err(|e| e.to_string())
}

/// 整理先 (ライブラリルート) を設定する。空文字を渡すと整理を無効化する。
#[tauri::command]
pub fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    let db = open_db(&app)?;
    db.set_state("library_root", &path)
        .map_err(|e| e.to_string())
}

/// 既存トラックのパスから整理先(ライブラリルート)を自動推定する。推定不可なら None。
/// 設定 UI の「自動検出」から呼ぶ(検出のみ。確定は呼び出し側で set_library_root)。
#[tauri::command]
pub fn detect_library_root(app: AppHandle) -> Result<Option<String>, String> {
    let db = open_db(&app)?;
    db.detect_library_root().map_err(|e| e.to_string())
}

/// 検索・スマプレの字体ゆれ吸収レベルを取得する。未設定なら "standard"。
#[tauri::command]
pub fn get_search_fold_level(app: AppHandle) -> Result<String, String> {
    let db = open_db(&app)?;
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
    let db = open_db(&app)?;
    db.set_state("search_fold_level", v)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_track_rating(app: AppHandle, track_id: i64, rating: i64) -> Result<(), String> {
    let db = open_db(&app)?;
    db.set_rating(track_id, rating).map_err(|e| e.to_string())
}

/// `add_genre_tag` / `remove_genre_tag` の結果 (`POST /api/tracks/genre-tags/*` と同じ形)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreTagResult {
    /// DB を更新した曲数。
    pub updated: usize,
    /// ファイルのタグへの書き込みを試みて失敗した曲数。
    pub file_write_failed: usize,
}

/// ジャンルタグの追加・削除。API と同じ [`crate::library::genre::edit_genre_tags`] を使い、
/// DB と実ファイルのタグの両方を更新する (docs/genre/design.md §2)。
/// DB の更新に失敗した曲があれば、残りの曲を処理したうえで最初のエラーを返す。
fn edit_genre_tags_blocking(
    app: &AppHandle,
    track_ids: &[i64],
    add: &[String],
    remove: &[String],
) -> Result<GenreTagResult, String> {
    let db = open_db(app)?;
    let add: Vec<&str> = add.iter().map(String::as_str).collect();
    let remove: Vec<&str> = remove.iter().map(String::as_str).collect();
    let outcome = crate::library::genre::edit_genre_tags(&db, track_ids, &add, &remove)
        .map_err(|e| e.to_string())?;
    if let Some((_, e)) = outcome.db_errors.first() {
        return Err(e.to_string());
    }
    Ok(GenreTagResult {
        updated: outcome.updated,
        file_write_failed: outcome.file_write_failed,
    })
}

// ジャンルタグのコマンドは曲ごとにファイルのタグを書き換える (曲数ぶんのファイル IO)。
// メインスレッドを塞がないよう `command(async)` でスレッドプール上で実行する。

#[tauri::command(async)]
pub fn add_genre_tag(
    app: AppHandle,
    track_ids: Vec<i64>,
    tag: String,
) -> Result<GenreTagResult, String> {
    edit_genre_tags_blocking(&app, &track_ids, &[tag], &[])
}

#[tauri::command(async)]
pub fn remove_genre_tag(
    app: AppHandle,
    track_ids: Vec<i64>,
    tag: String,
) -> Result<GenreTagResult, String> {
    edit_genre_tags_blocking(&app, &track_ids, &[], &[tag])
}

/// 複数のジャンルタグの追加・削除をまとめて適用する (Get Info の複数曲編集)。
/// 1 曲につき DB の更新とファイルの書き込みは 1 回ずつ (タグの数だけ書き直さない)。
#[tauri::command(async)]
pub fn edit_genre_tags(
    app: AppHandle,
    track_ids: Vec<i64>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<GenreTagResult, String> {
    edit_genre_tags_blocking(&app, &track_ids, &add, &remove)
}

#[tauri::command]
pub fn get_all_genre_tags(app: AppHandle) -> Result<Vec<GenreTagCount>, String> {
    let db = open_db(&app)?;
    db.get_all_genre_tags().map_err(|e| e.to_string())
}

/// ライブラリ内の first-class Tags を頻度つきで返す。
#[tauri::command]
pub fn get_all_tags(app: AppHandle) -> Result<Vec<TagCount>, String> {
    let db = open_db(&app)?;
    db.list_all_tags().map_err(|e| e.to_string())
}

/// 1 曲に付いている first-class Tags。
#[tauri::command]
pub fn get_track_tags(app: AppHandle, track_id: i64) -> Result<Vec<Tag>, String> {
    let db = open_db(&app)?;
    db.get_track_tags(track_id).map_err(|e| e.to_string())
}

/// 複数曲に同じ first-class Tag を付与 (`mood:dreamy` / free は `bridge`)。
#[tauri::command]
pub fn add_track_tags(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = open_db(&app)?;
    db.add_tag_to_tracks(&track_ids, &tag)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 複数曲から同じ first-class Tag を除去。
#[tauri::command]
pub fn remove_track_tags(app: AppHandle, track_ids: Vec<i64>, tag: String) -> Result<(), String> {
    let db = open_db(&app)?;
    db.remove_tag_from_tracks(&track_ids, &tag)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_albums(
    app: AppHandle,
    sort_field: Option<String>,
    sort_order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<AlbumRow>, String> {
    let db = open_db(&app)?;
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
    let db = open_db(&app)?;
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
    query: Option<String>,
) -> Result<Vec<ArtistRow>, String> {
    let db = open_db(&app)?;
    // query (検索ボックス + フィルタタグ) があれば一致する曲を持つアーティストだけ (D4)。
    db.get_artists_matching(
        sort_field.as_deref(),
        sort_order.as_deref(),
        limit.unwrap_or(500),
        offset.unwrap_or(0),
        query.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// 指定アーティストのアルバム一覧 (Artists ビューの展開表示用)。
#[tauri::command]
pub fn get_artist_albums(app: AppHandle, name: String) -> Result<Vec<AlbumRow>, String> {
    let db = open_db(&app)?;
    db.get_artist_albums(&name).map_err(|e| e.to_string())
}

/// 指定トラックをライブラリから削除する。実際に消えた曲数を返す。
///
/// DB・ファイルの削除は [`crate::library::delete::remove_tracks`] (ファイルも消すのは
/// `delete_files` が true のときだけ。ライブラリルート外のファイルが 1 件でもあれば何も消さない)。
/// 削除した曲が再生中 / キューに積まれていれば、再生を止めキューから外す。
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
    let db = open_db(&app)?;
    let removed = crate::library::delete::remove_tracks(&db, &track_ids, delete_files)
        .map_err(|e| e.to_string())?;

    // 再生中 / キューに残っている曲を落とす。対象は要求された id 全部 (消えた曲 removed を
    // 含む。DB に行が無かった id も、キューに古いまま残っていれば一緒に掃除する: 従来どおり)。
    let dropped: HashSet<i64> = track_ids.into_iter().collect();
    crate::commands::playback::drop_tracks_from_playback(&app, &player, &dropped);

    Ok(removed.track_ids.len())
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
