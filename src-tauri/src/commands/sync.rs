//! federation slave 側の Tauri コマンド。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::sync::{SyncSelectionRecord, SyncSource};
use crate::db::Database;
use crate::models::Playlist;
use crate::sync::writeback::{ConflictResolution, WritebackPlan, WritebackSummary};
use crate::sync::{
    EvictionCandidate, EvictionSummary, PairedSource, PairingStart, PlaylistSizeEstimate,
    ProvisionSummary, PushAnalysesSummary, PushTracksSummary, PushableTrack, ResyncSummary,
    StorageUsage, SyncProgress,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionStatus {
    pub state: String,
    pub summary: Option<ProvisionSummary>,
    pub error: Option<String>,
}

impl Default for ProvisionStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            summary: None,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct SyncRuntime {
    pending_pairings: Mutex<HashMap<String, String>>,
    provision: Mutex<ProvisionStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionStarted {
    pub started: bool,
}

fn open_db(app: &AppHandle) -> Result<Database, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to get app data dir: {err}"))?;
    Database::open(&app_dir).map_err(|err| format!("Failed to open database: {err}"))
}

/// 母艦とのやり取りで出るエラーを利用者向けの日本語にする。
/// 原因の切り分けに要る技術詳細（status や母艦の応答）は括弧に残す。
fn sync_error(error: crate::sync::SyncError) -> String {
    use crate::sync::SyncError;
    match error {
        SyncError::InvalidUrl(detail) => {
            format!("母艦のアドレスが正しくありません（{detail}）")
        }
        SyncError::Authentication(status) => {
            format!("母艦側でこのデバイスに sync 権限が必要です ({status})")
        }
        SyncError::Unreachable(detail) => {
            format!("母艦に接続できません。電源とネットワークを確認してください（{detail}）")
        }
        SyncError::Http { status, message } => {
            let detail = message.trim();
            if detail.is_empty() {
                format!("母艦がエラーを返しました ({status})")
            } else {
                format!("母艦がエラーを返しました ({status}): {detail}")
            }
        }
        SyncError::PairingExpired => {
            "ペアリングの有効期限が切れました。母艦でコードを出し直してください".to_string()
        }
        SyncError::InvalidResponse(detail) => {
            format!("母艦の応答を解釈できません（{detail}）")
        }
        SyncError::Database(error) => {
            format!("手元のデータベース操作に失敗しました（{error}）")
        }
        SyncError::File(detail) => format!("ファイル操作に失敗しました（{detail}）"),
        error => error.to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackApplyError {
    pub code: String,
    pub message: String,
}

impl WritebackApplyError {
    fn general(message: impl Into<String>) -> Self {
        Self {
            code: "writebackFailed".to_string(),
            message: message.into(),
        }
    }

    fn from_sync(error: crate::sync::SyncError) -> Self {
        let code = if matches!(&error, crate::sync::SyncError::StaleWritebackPlan) {
            "stalePlan"
        } else {
            "writebackFailed"
        };
        Self {
            code: code.to_string(),
            message: sync_error(error),
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_pair_start(
    base_url: String,
    device_name: String,
    runtime: tauri::State<'_, SyncRuntime>,
) -> Result<PairingStart, String> {
    let result = crate::sync::pair_with_master(&base_url, &device_name)
        .await
        .map_err(sync_error)?;
    runtime
        .pending_pairings
        .lock()
        .map_err(|_| "sync pairing state is poisoned".to_string())?
        .insert(result.session_id.clone(), base_url);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_pair_poll(
    app: AppHandle,
    session_id: String,
    runtime: tauri::State<'_, SyncRuntime>,
) -> Result<Option<PairedSource>, String> {
    let base_url = runtime
        .pending_pairings
        .lock()
        .map_err(|_| "sync pairing state is poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "unknown pairing session".to_string())?;
    let db = open_db(&app)?;
    let result = crate::sync::poll_pairing(db, &base_url, &session_id)
        .await
        .map_err(sync_error)?;
    if result.is_some() {
        runtime
            .pending_pairings
            .lock()
            .map_err(|_| "sync pairing state is poisoned".to_string())?
            .remove(&session_id);
    }
    Ok(result)
}

#[tauri::command]
pub fn sync_list_sources(app: AppHandle) -> Result<Vec<SyncSource>, String> {
    open_db(&app)?
        .list_sync_sources()
        .map_err(|err| err.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_list_selections(
    app: AppHandle,
    source_id: i64,
) -> Result<Vec<SyncSelectionRecord>, String> {
    let db = open_db(&app)?;
    db.get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    db.list_sync_selection_records(source_id)
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_set_selection_policy(
    app: AppHandle,
    selection_id: i64,
    policy: String,
) -> Result<(), String> {
    open_db(&app)?
        .set_sync_selection_policy(selection_id, &policy)
        .map_err(|error| error.to_string())
}

/// selection の参照を外す。孤立した曲は次の eviction candidate 一覧で扱う。
/// `deleteLocalPlaylist` を立てるとローカルプレイリストも消し、所属曲を候補へ戻す。
/// 省略時は従来どおりプレイリストを残す。
#[tauri::command(rename_all = "camelCase")]
pub fn sync_remove_selection(
    app: AppHandle,
    selection_id: i64,
    delete_local_playlist: Option<bool>,
) -> Result<bool, String> {
    let delete_local_playlist = delete_local_playlist.unwrap_or(false);
    let removed = open_db(&app)?
        .remove_sync_selection(selection_id, delete_local_playlist)
        .map_err(|error| error.to_string())?;
    if removed && delete_local_playlist {
        let _ = app.emit("library-changed", serde_json::json!({ "playlistId": null }));
    }
    Ok(removed)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_list_remote_playlists(
    app: AppHandle,
    source_id: i64,
) -> Result<Vec<Playlist>, String> {
    let source = open_db(&app)?
        .get_sync_source(source_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    crate::sync::list_remote_playlists(&source)
        .await
        .map_err(sync_error)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_playlist_size_estimate(
    app: AppHandle,
    source_id: i64,
    playlist_id: i64,
) -> Result<PlaylistSizeEstimate, String> {
    let source = open_db(&app)?
        .get_sync_source(source_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    crate::sync::playlist_size_estimate(&source, playlist_id)
        .await
        .map_err(sync_error)
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_provision(
    app: AppHandle,
    source_id: i64,
    remote_pids: Vec<String>,
    dest_root: String,
    runtime: tauri::State<'_, SyncRuntime>,
) -> Result<ProvisionStarted, String> {
    if remote_pids.is_empty() {
        return Err("at least one remote playlist persistent ID is required".to_string());
    }
    if dest_root.trim().is_empty() {
        return Err("destination root is required".to_string());
    }
    let source = open_db(&app)?
        .get_sync_source(source_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    {
        let mut status = runtime
            .provision
            .lock()
            .map_err(|_| "sync provision state is poisoned".to_string())?;
        if status.state == "running" {
            return Err("a sync provision job is already running".to_string());
        }
        *status = ProvisionStatus {
            state: "running".to_string(),
            summary: None,
            error: None,
        };
    }
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to get app data dir: {err}"))?;
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match Database::open(&app_dir) {
            Ok(db) => {
                let event_app = task_app.clone();
                crate::sync::provision(
                    db,
                    source,
                    remote_pids,
                    PathBuf::from(dest_root),
                    move |progress: SyncProgress| {
                        let _ = event_app.emit("sync-progress", progress);
                    },
                )
                .await
            }
            Err(err) => Err(crate::sync::SyncError::Database(err)),
        };
        let state = task_app.state::<SyncRuntime>();
        match result {
            Ok(summary) => {
                if let Ok(mut status) = state.provision.lock() {
                    *status = ProvisionStatus {
                        state: "complete".to_string(),
                        summary: Some(summary.clone()),
                        error: None,
                    };
                }
                let _ = task_app.emit("sync-complete", summary);
                let _ = task_app.emit("library-changed", serde_json::json!({ "playlistId": null }));
            }
            Err(error) => {
                let message = sync_error(error);
                if let Ok(mut status) = state.provision.lock() {
                    *status = ProvisionStatus {
                        state: "failed".to_string(),
                        summary: None,
                        error: Some(message.clone()),
                    };
                }
                let _ = task_app.emit("sync-error", serde_json::json!({ "error": message }));
            }
        }
    });
    Ok(ProvisionStarted { started: true })
}

#[tauri::command]
pub fn sync_provision_status(
    runtime: tauri::State<'_, SyncRuntime>,
) -> Result<ProvisionStatus, String> {
    runtime
        .provision
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "sync provision state is poisoned".to_string())
}

/// WRITE-BACK 前の確認画面用。DB や母艦は変更しない。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_writeback_plan(app: AppHandle, source_id: i64) -> Result<WritebackPlan, String> {
    let db = open_db(&app)?;
    let source = db
        .get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    let event_app = app.clone();
    crate::sync::writeback::plan(db, source, move |progress| {
        let _ = event_app.emit("sync-progress", progress);
    })
    .await
    .map_err(sync_error)
}

/// 確認済み plan を現在値から再計算し、一致した場合だけ適用する。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_writeback_apply(
    app: AppHandle,
    source_id: i64,
    plan_id: String,
    resolutions: Vec<ConflictResolution>,
) -> Result<WritebackSummary, WritebackApplyError> {
    let db = open_db(&app).map_err(WritebackApplyError::general)?;
    let source = db
        .get_sync_source(source_id)
        .map_err(|error| WritebackApplyError::general(error.to_string()))?
        .ok_or_else(|| WritebackApplyError::general("sync source not found"))?;
    let event_app = app.clone();
    let summary =
        crate::sync::writeback::apply(db, source, plan_id, resolutions, move |progress| {
            let _ = event_app.emit("sync-progress", progress);
        })
        .await
        .map_err(WritebackApplyError::from_sync)?;
    let _ = app.emit("writeback-complete", summary.clone());
    let _ = app.emit("library-changed", serde_json::json!({ "playlistId": null }));
    Ok(summary)
}

/// follow policy の選択だけを母艦へ追従させる pull-only 再同期。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_resync(app: AppHandle, source_id: i64) -> Result<ResyncSummary, String> {
    let db = open_db(&app)?;
    let source = db
        .get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    let event_app = app.clone();
    let summary = crate::sync::resync(db, source, move |progress| {
        let _ = event_app.emit("sync-progress", progress);
    })
    .await
    .map_err(sync_error)?;
    let _ = app.emit("resync-complete", summary.clone());
    if summary.mutations_committed {
        let _ = app.emit("library-changed", serde_json::json!({ "playlistId": null }));
    }
    Ok(summary)
}

/// sourceId 省略時は全同期元の candidate をまとめて返す。
#[tauri::command(rename_all = "camelCase")]
pub fn sync_eviction_candidates(
    app: AppHandle,
    source_id: Option<i64>,
) -> Result<Vec<EvictionCandidate>, String> {
    let db = open_db(&app)?;
    let sources = match source_id {
        Some(source_id) => vec![db
            .get_sync_source(source_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "sync source not found".to_string())?],
        None => db.list_sync_sources().map_err(|error| error.to_string())?,
    };
    let mut candidates = Vec::new();
    for source in sources {
        candidates.extend(
            crate::sync::compute_eviction_candidates(&db, source.id)
                .map_err(|error| error.to_string())?,
        );
    }
    candidates.sort_by(|left, right| left.persistent_id.cmp(&right.persistent_id));
    candidates.dedup_by(|left, right| left.persistent_id == right.persistent_id);
    Ok(candidates)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn sync_evict(
    app: AppHandle,
    persistent_ids: Vec<String>,
) -> Result<EvictionSummary, String> {
    let mut db = open_db(&app)?;
    let summary = crate::sync::evict(&mut db, &persistent_ids)
        .await
        .map_err(|error| error.to_string())?;
    if summary.evicted > 0 {
        let _ = app.emit("library-changed", serde_json::json!({ "playlistId": null }));
    }
    Ok(summary)
}

#[tauri::command(rename_all = "camelCase")]
pub fn sync_storage_usage(app: AppHandle, source_id: i64) -> Result<StorageUsage, String> {
    let db = open_db(&app)?;
    db.get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    crate::sync::storage_usage(&db, source_id).map_err(|error| error.to_string())
}

/// master へ送れるローカル由来曲（どの sync_track にも未所属）を返す。
#[tauri::command(rename_all = "camelCase")]
pub fn sync_list_pushable(app: AppHandle, source_id: i64) -> Result<Vec<PushableTrack>, String> {
    crate::sync::list_pushable(&open_db(&app)?, source_id).map_err(|error| error.to_string())
}

/// 選択曲を master へ upload し、成功分をこの source の sync_track へ編入する。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_push_tracks(
    app: AppHandle,
    source_id: i64,
    persistent_ids: Vec<String>,
) -> Result<PushTracksSummary, String> {
    let db = open_db(&app)?;
    let source = db
        .get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    let event_app = app.clone();
    let summary = crate::sync::push_tracks(db, source, persistent_ids, move |progress| {
        let _ = event_app.emit("sync-progress", progress);
    })
    .await
    .map_err(sync_error)?;
    let _ = app.emit("push-complete", summary.clone());
    Ok(summary)
}

/// 編入済み曲の現行解析のうち、master に無い/古いものだけを送る。
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_push_analyses(
    app: AppHandle,
    source_id: i64,
) -> Result<PushAnalysesSummary, String> {
    let db = open_db(&app)?;
    let source = db
        .get_sync_source(source_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "sync source not found".to_string())?;
    crate::sync::push_analyses(db, source)
        .await
        .map_err(sync_error)
}

#[cfg(test)]
mod tests {
    use super::sync_error;
    use crate::sync::SyncError;

    /// ペアリング〜取り寄せの導線で出るエラーは、生英語のまま UI へ出さない。
    #[test]
    fn master_errors_are_translated_for_users() {
        let cases = [
            (
                SyncError::InvalidUrl("relative URL without a base".to_string()),
                "母艦のアドレス",
            ),
            (
                SyncError::Authentication(reqwest::StatusCode::UNAUTHORIZED),
                "sync 権限",
            ),
            (
                SyncError::Unreachable("connection refused".to_string()),
                "母艦に接続できません",
            ),
            (
                SyncError::Http {
                    status: reqwest::StatusCode::CONFLICT,
                    message: "persistent_id が母艦の別の曲と衝突しています".to_string(),
                },
                "母艦がエラーを返しました (409 Conflict)",
            ),
            (SyncError::PairingExpired, "ペアリングの有効期限"),
        ];
        for (error, expected) in cases {
            let message = sync_error(error);
            assert!(message.contains(expected), "{message}");
            assert!(!message.contains("master"), "{message}");
        }
    }
}
