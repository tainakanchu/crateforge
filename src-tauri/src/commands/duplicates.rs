//! 取り込み済み検出 (iTunes の「すでにライブラリにあります」相当) と、
//! 検出結果に基づく取り込み (取り込む / スキップ / 置き換え) のコマンド。
//!
//! いずれもライブラリ全体の読み込みとファイル I/O (タグ読み・破損判定) を伴うので、
//! async コマンド + spawn_blocking でメインスレッドを塞がない。

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use crate::commands::library::open_db;
use crate::importer;
use crate::library_match::{self, MatchIndex, MatchQuery};
use crate::models::{
    ImportActionItem, ImportActionsSummary, ImportPlanItem, RipDuplicateQuery, RipTrackDuplicates,
};

/// 選んだリリースの各トラックについて、ライブラリにある同じ曲を探す。
#[tauri::command]
pub async fn find_rip_duplicates(
    app: AppHandle,
    query: RipDuplicateQuery,
) -> Result<Vec<RipTrackDuplicates>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_db(&app)?;
        let rows = db
            .library_match_rows()
            .map_err(|e| format!("query failed: {e}"))?;
        let index = MatchIndex::new(rows);
        let mut health = HashMap::new();
        let album_artist = query.album_artist.as_deref();
        Ok(query
            .tracks
            .iter()
            .map(|t| {
                // MusicBrainz のトラックアーティストが空ならアルバムアーティストで照合する。
                let artist = if t.artist.trim().is_empty() {
                    album_artist.unwrap_or("")
                } else {
                    t.artist.as_str()
                };
                let q = MatchQuery {
                    title: &t.title,
                    artist,
                    album_artist,
                    album: query.album.as_deref(),
                    track_number: Some(t.position as i64),
                    duration_ms: t.length_ms.map(|m| m as i64),
                };
                let hits = index.find(&q);
                RipTrackDuplicates {
                    position: t.position,
                    hits: library_match::to_duplicate_hits(&index, &hits, &mut health),
                }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("duplicate check panicked: {e}"))?
}

/// 取り込み前の計画: フォルダを展開してタグを読み、ライブラリと照合する。
/// 進捗は `import-plan-progress` (`{done, total}`) で通知する。
#[tauri::command]
pub async fn plan_import(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<ImportPlanItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_db(&app)?;
        let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        importer::plan_import(&db, &roots, |done, total| {
            if done == 0 || done == total || done % 25 == 0 {
                let _ = app.emit(
                    "import-plan-progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            }
        })
    })
    .await
    .map_err(|e| format!("import plan panicked: {e}"))?
}

/// 計画に対する指示どおりに取り込む。進捗は `import-progress` (`{done, total}`)。
/// 置き換えがあった場合は埋め込みアートワークも変わりうるので
/// `library-changed` に `artworkChanged: true` を載せて通知する。
#[tauri::command]
pub async fn import_with_actions(
    app: AppHandle,
    items: Vec<ImportActionItem>,
) -> Result<ImportActionsSummary, String> {
    let worker_app = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let db = open_db(&worker_app)?;
        Ok::<_, String>(importer::import_with_actions(&db, &items, |done, total| {
            if done == 0 || done == total || done % 25 == 0 {
                let _ = worker_app.emit(
                    "import-progress",
                    serde_json::json!({ "done": done, "total": total }),
                );
            }
        }))
    })
    .await
    .map_err(|e| format!("import task panicked: {e}"))??;
    if summary.replaced > 0 {
        let _ = app.emit(
            "library-changed",
            serde_json::json!({ "playlistId": null, "artworkChanged": true }),
        );
    }
    Ok(summary)
}
