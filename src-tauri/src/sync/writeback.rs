//! federation slave 側の WRITE-BACK 計画・適用。

use std::collections::{HashMap, HashSet};

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::{MasterClient, SyncError, SyncFailure, SyncProgress, LOOKUP_CHUNK};
use crate::db::sync::{SyncSource, SyncedPlaylistSnapshot, SyncedTrackSnapshot};
use crate::db::Database;
use crate::models::{Playlist, Track};

pub(crate) const WRITEBACK_FIELDS: [&str; 15] = [
    "rating",
    "name",
    "artist",
    "albumArtist",
    "composer",
    "album",
    "genre",
    "comments",
    "year",
    "bpm",
    "trackNumber",
    "trackCount",
    "discNumber",
    "discCount",
    "compilation",
];

const STRING_FIELDS: [&str; 7] = [
    "name",
    "artist",
    "albumArtist",
    "composer",
    "album",
    "genre",
    "comments",
];

/// 1 フィールドの三者比較結果。UI 向け plan はこの結果を push/pull/conflict に分ける。
#[derive(Debug, Clone, PartialEq)]
pub enum FieldDiff {
    Unchanged,
    /// push 対象。`previous` は母艦上で上書きされる現在値（= base と同じ）。
    LocalOnly {
        value: Value,
        previous: Value,
    },
    /// pull 対象。`previous` は手元で上書きされる現在値（= base と同じ）。
    MasterOnly {
        value: Value,
        previous: Value,
    },
    BothSame,
    Conflict {
        local: Value,
        master: Value,
        local_newer: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldUpdate {
    pub field: String,
    pub value: Value,
    /// 上書きされる直前の値。push なら母艦の現在値、pull なら手元の現在値。UI の old→new 表示用。
    pub previous: Value,
}

/// 同じ曲への PATCH / local pull は fields をまとめて 1 回にする。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackChange {
    pub persistent_id: String,
    pub track_name: Option<String>,
    pub fields: Vec<FieldUpdate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackConflict {
    pub persistent_id: String,
    pub track_name: Option<String>,
    pub field: String,
    pub local: Value,
    pub master: Value,
    pub local_newer: bool,
}

/// UI 確認画面でそのまま列挙できる playlist 操作。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all_fields = "camelCase")]
pub enum PlaylistOp {
    #[serde(rename = "create")]
    Create {
        local_playlist_id: i64,
        persistent_id: String,
        name: String,
        track_persistent_ids: Vec<String>,
    },
    #[serde(rename = "rename")]
    Rename {
        persistent_id: String,
        master_playlist_id: i64,
        from: String,
        to: String,
    },
    #[serde(rename = "replaceTracks")]
    ReplaceTracks {
        persistent_id: String,
        master_playlist_id: i64,
        name: String,
        track_persistent_ids: Vec<String>,
        master_track_persistent_ids: Vec<String>,
        overwrites_master_ordering: bool,
    },
    #[serde(rename = "skippedDelete")]
    SkippedDelete {
        persistent_id: String,
        name: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackPlan {
    pub plan_id: String,
    pub track_changes: Vec<TrackChange>,
    pub conflicts: Vec<WritebackConflict>,
    pub playlist_ops: Vec<PlaylistOp>,
    pub pulls: Vec<TrackChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionChoice {
    Local,
    Master,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub persistent_id: String,
    pub field: String,
    pub choose: ResolutionChoice,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackSummary {
    /// PATCH に成功した曲数。
    pub pushed: usize,
    /// local pull-down に成功した曲数。
    pub pulled: usize,
    /// 成功した playlist 操作数（skippedDelete は含めない）。
    pub playlist_ops: usize,
    pub failures: Vec<SyncFailure>,
}

#[derive(Debug)]
struct LocalInput {
    tracks: Vec<SyncedTrackSnapshot>,
    playlists: Vec<SyncedPlaylistSnapshot>,
    selections: Vec<(String, String)>,
}

#[derive(Debug)]
struct RemoteInput {
    tracks: HashMap<String, Track>,
    playlists: HashMap<String, (Playlist, Vec<String>)>,
}

#[derive(Debug, Deserialize)]
struct PatchTrackResponse {
    track: Track,
}

impl MasterClient {
    async fn writeback_tracks(&self, persistent_ids: &[String]) -> Result<Vec<Track>, SyncError> {
        let mut tracks = Vec::new();
        for chunk in persistent_ids.chunks(LOOKUP_CHUNK) {
            let response = Self::checked(
                self.request(reqwest::Method::POST, "/api/tracks/lookup")
                    .json(&json!({ "persistentIds": chunk }))
                    .send()
                    .await,
            )
            .await?;
            let mut page = response
                .json::<Vec<Track>>()
                .await
                .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
            tracks.append(&mut page);
        }
        Ok(tracks)
    }

    async fn writeback_patch_track(
        &self,
        track_id: i64,
        fields: &[FieldUpdate],
    ) -> Result<Track, SyncError> {
        let mut body = Map::new();
        for update in fields {
            // TrackEdit の String は JSON null を「未指定」と解釈するため、NULL の push は空文字にする。
            let value = if STRING_FIELDS.contains(&update.field.as_str()) && update.value.is_null()
            {
                Value::String(String::new())
            } else {
                update.value.clone()
            };
            body.insert(update.field.clone(), value);
        }
        let response = Self::checked(
            self.request(reqwest::Method::PATCH, &format!("/api/tracks/{track_id}"))
                .json(&body)
                .send()
                .await,
        )
        .await?;
        response
            .json::<PatchTrackResponse>()
            .await
            .map(|body| body.track)
            .map_err(|error| SyncError::InvalidResponse(error.to_string()))
    }

    async fn writeback_create_playlist(
        &self,
        name: &str,
        persistent_id: &str,
    ) -> Result<Playlist, SyncError> {
        let response = Self::checked(
            self.request(reqwest::Method::POST, "/api/playlists")
                .json(&json!({
                    "name": name,
                    "persistentId": persistent_id,
                    "parentPersistentId": null,
                    "isFolder": false,
                }))
                .send()
                .await,
        )
        .await?;
        response
            .json::<Playlist>()
            .await
            .map_err(|error| SyncError::InvalidResponse(error.to_string()))
    }

    async fn writeback_rename_playlist(
        &self,
        playlist_id: i64,
        name: &str,
    ) -> Result<(), SyncError> {
        Self::checked(
            self.request(
                reqwest::Method::PATCH,
                &format!("/api/playlists/{playlist_id}"),
            )
            .json(&json!({ "name": name }))
            .send()
            .await,
        )
        .await?;
        Ok(())
    }

    async fn writeback_replace_playlist(
        &self,
        playlist_id: i64,
        track_ids: &[i64],
    ) -> Result<(), SyncError> {
        Self::checked(
            self.request(
                reqwest::Method::PUT,
                &format!("/api/playlists/{playlist_id}/tracks"),
            )
            .json(&json!({ "trackIds": track_ids }))
            .send()
            .await,
        )
        .await?;
        Ok(())
    }
}

fn collect_local(db: &Database, source_id: i64) -> Result<LocalInput, SyncError> {
    Ok(LocalInput {
        tracks: db.list_synced_track_snapshots(source_id)?,
        playlists: db.list_synced_playlist_snapshots(source_id)?,
        selections: db.list_sync_selections(source_id)?,
    })
}

async fn collect_remote(
    client: &MasterClient,
    local: &LocalInput,
) -> Result<RemoteInput, SyncError> {
    let persistent_ids = local
        .tracks
        .iter()
        .map(|row| row.persistent_id.clone())
        .collect::<Vec<_>>();
    let tracks = client
        .writeback_tracks(&persistent_ids)
        .await?
        .into_iter()
        .filter_map(|track| track.persistent_id.clone().map(|pid| (pid, track)))
        .collect::<HashMap<_, _>>();

    let wanted_playlist_pids = local
        .playlists
        .iter()
        .filter_map(|row| row.playlist.persistent_id.clone())
        .chain(local.selections.iter().map(|(pid, _)| pid.clone()))
        .collect::<HashSet<_>>();
    let mut playlists = HashMap::new();
    for playlist in client.playlists().await? {
        let Some(pid) = playlist.persistent_id.clone() else {
            continue;
        };
        if !wanted_playlist_pids.contains(&pid) {
            continue;
        }
        let membership = client
            .playlist_tracks(playlist.playlist_id)
            .await?
            .into_iter()
            .filter_map(|track| track.persistent_id)
            .collect();
        playlists.insert(pid, (playlist, membership));
    }
    Ok(RemoteInput { tracks, playlists })
}

/// 1 フィールドを base/local/master の三者で分類する純粋関数。
pub fn classify_field(
    field: &str,
    base: Value,
    local: Value,
    master: Value,
    local_date_modified: Option<&str>,
    master_date_modified: Option<&str>,
) -> FieldDiff {
    let local_changed = !field_values_equal(field, &local, &base);
    let master_changed = !field_values_equal(field, &master, &base);
    match (local_changed, master_changed) {
        (false, false) => FieldDiff::Unchanged,
        (true, false) => FieldDiff::LocalOnly {
            value: local,
            previous: master,
        },
        (false, true) => FieldDiff::MasterOnly {
            value: master,
            previous: local,
        },
        (true, true) if field_values_equal(field, &local, &master) => FieldDiff::BothSame,
        (true, true) => FieldDiff::Conflict {
            local,
            master,
            local_newer: is_local_newer(local_date_modified, master_date_modified),
        },
    }
}

fn field_values_equal(field: &str, left: &Value, right: &Value) -> bool {
    if STRING_FIELDS.contains(&field) {
        let blank = |value: &Value| value.is_null() || value.as_str() == Some("");
        (blank(left) && blank(right)) || left == right
    } else {
        left == right
    }
}

fn is_local_newer(local: Option<&str>, master: Option<&str>) -> bool {
    match (local, master) {
        (Some(local), Some(master)) => {
            match (
                DateTime::parse_from_rfc3339(local),
                DateTime::parse_from_rfc3339(master),
            ) {
                (Ok(local), Ok(master)) => local > master,
                _ => local > master,
            }
        }
        (Some(_), None) => true,
        _ => false,
    }
}

pub(crate) fn track_json(track: &Track) -> Result<Value, SyncError> {
    serde_json::to_value(track).map_err(|error| SyncError::InvalidResponse(error.to_string()))
}

pub(crate) fn field_value(track: &Value, field: &str) -> Value {
    track.get(field).cloned().unwrap_or(Value::Null)
}

/// eviction 用の軽量判定。母艦へ送る値または競合になり得るローカル差分があれば dirty。
pub(crate) fn has_local_changes(base_meta: &str, local: &Track) -> Result<bool, SyncError> {
    let base: Value = serde_json::from_str(base_meta)
        .map_err(|error| SyncError::InvalidResponse(format!("invalid base_meta: {error}")))?;
    let local = track_json(local)?;
    Ok(WRITEBACK_FIELDS.iter().any(|field| {
        !field_values_equal(
            field,
            &field_value(&base, field),
            &field_value(&local, field),
        )
    }))
}

fn overlay_updated_fields(base: &mut Value, updated: &Value, fields: &[FieldUpdate]) {
    let Some(base) = base.as_object_mut() else {
        return;
    };
    for field in fields {
        base.insert(field.field.clone(), field_value(updated, &field.field));
    }
}

fn verify_playlist_membership(current: &[String], planned: &[String]) -> Result<(), SyncError> {
    if current == planned {
        Ok(())
    } else {
        Err(SyncError::PlaylistChangedDuringWriteback)
    }
}

fn compute_plan(local: &LocalInput, remote: &RemoteInput) -> Result<WritebackPlan, SyncError> {
    let mut plan = WritebackPlan::default();
    for row in &local.tracks {
        let Some(master) = remote.tracks.get(&row.persistent_id) else {
            continue;
        };
        let base: Value = serde_json::from_str(&row.base_meta)
            .map_err(|error| SyncError::InvalidResponse(format!("invalid base_meta: {error}")))?;
        let local_json = track_json(&row.local)?;
        let master_json = track_json(master)?;
        let mut pushes = Vec::new();
        let mut pulls = Vec::new();
        for field in WRITEBACK_FIELDS {
            match classify_field(
                field,
                field_value(&base, field),
                field_value(&local_json, field),
                field_value(&master_json, field),
                row.local.date_modified.as_deref(),
                master.date_modified.as_deref(),
            ) {
                FieldDiff::Unchanged | FieldDiff::BothSame => {}
                FieldDiff::LocalOnly { value, previous } => pushes.push(FieldUpdate {
                    field: field.to_string(),
                    value,
                    previous,
                }),
                FieldDiff::MasterOnly { value, previous } => pulls.push(FieldUpdate {
                    field: field.to_string(),
                    value,
                    previous,
                }),
                FieldDiff::Conflict {
                    local,
                    master,
                    local_newer,
                } => plan.conflicts.push(WritebackConflict {
                    persistent_id: row.persistent_id.clone(),
                    track_name: row.local.name.clone(),
                    field: field.to_string(),
                    local,
                    master,
                    local_newer,
                }),
            }
        }
        if !pushes.is_empty() {
            plan.track_changes.push(TrackChange {
                persistent_id: row.persistent_id.clone(),
                track_name: row.local.name.clone(),
                fields: pushes,
            });
        }
        if !pulls.is_empty() {
            plan.pulls.push(TrackChange {
                persistent_id: row.persistent_id.clone(),
                track_name: row.local.name.clone(),
                fields: pulls,
            });
        }
    }

    let local_playlist_pids = local
        .playlists
        .iter()
        .filter_map(|row| row.playlist.persistent_id.clone())
        .collect::<HashSet<_>>();
    for row in &local.playlists {
        let Some(pid) = row.playlist.persistent_id.clone() else {
            continue;
        };
        match remote.playlists.get(&pid) {
            None if row.playlist.is_user_created => plan.playlist_ops.push(PlaylistOp::Create {
                local_playlist_id: row.playlist.playlist_id,
                persistent_id: pid,
                name: row.playlist.name.clone(),
                track_persistent_ids: row.track_persistent_ids.clone(),
            }),
            Some((master, membership)) => {
                if row.playlist.name != master.name {
                    plan.playlist_ops.push(PlaylistOp::Rename {
                        persistent_id: pid.clone(),
                        master_playlist_id: master.playlist_id,
                        from: master.name.clone(),
                        to: row.playlist.name.clone(),
                    });
                }
                if row.track_persistent_ids != *membership {
                    plan.playlist_ops.push(PlaylistOp::ReplaceTracks {
                        persistent_id: pid,
                        master_playlist_id: master.playlist_id,
                        name: row.playlist.name.clone(),
                        track_persistent_ids: row.track_persistent_ids.clone(),
                        master_track_persistent_ids: membership.clone(),
                        overwrites_master_ordering: true,
                    });
                }
            }
            None => {}
        }
    }
    for (pid, selected_name) in &local.selections {
        if local_playlist_pids.contains(pid) {
            continue;
        }
        if let Some((master, _)) = remote.playlists.get(pid) {
            plan.playlist_ops.push(PlaylistOp::SkippedDelete {
                persistent_id: pid.clone(),
                name: if master.name.is_empty() {
                    selected_name.clone()
                } else {
                    master.name.clone()
                },
                reason: "ローカル削除は安全のため母艦へ反映しません".to_string(),
            });
        }
    }
    plan.plan_id = plan_hash(&plan)?;
    Ok(plan)
}

fn plan_hash(plan: &WritebackPlan) -> Result<String, SyncError> {
    let mut hash_input = plan.clone();
    hash_input.plan_id.clear();
    let serialized = serde_json::to_vec(&hash_input)
        .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
    let digest = Sha256::digest(serialized);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub async fn plan<F>(
    db: Database,
    source: SyncSource,
    progress: F,
) -> Result<WritebackPlan, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    progress(SyncProgress {
        phase: "writebackPlanning".to_string(),
        current: 0,
        total: 1,
        track_name: None,
    });
    let local = collect_local(&db, source.id)?;
    let client = MasterClient::from_source(&source)?;
    let remote = collect_remote(&client, &local).await?;
    let plan = compute_plan(&local, &remote)?;
    progress(SyncProgress {
        phase: "writebackPlanning".to_string(),
        current: 1,
        total: 1,
        track_name: None,
    });
    Ok(plan)
}

fn merge_update(
    target: &mut Vec<TrackChange>,
    conflict: &WritebackConflict,
    value: Value,
    previous: Value,
) {
    if let Some(change) = target
        .iter_mut()
        .find(|change| change.persistent_id == conflict.persistent_id)
    {
        change.fields.push(FieldUpdate {
            field: conflict.field.clone(),
            value,
            previous,
        });
    } else {
        target.push(TrackChange {
            persistent_id: conflict.persistent_id.clone(),
            track_name: conflict.track_name.clone(),
            fields: vec![FieldUpdate {
                field: conflict.field.clone(),
                value,
                previous,
            }],
        });
    }
}

fn resolve_conflicts(
    plan: &mut WritebackPlan,
    resolutions: &[ConflictResolution],
) -> Result<(), SyncError> {
    let selected = resolutions
        .iter()
        .map(|resolution| {
            (
                (resolution.persistent_id.as_str(), resolution.field.as_str()),
                &resolution.choose,
            )
        })
        .collect::<HashMap<_, _>>();
    for conflict in &plan.conflicts {
        let choice = selected
            .get(&(conflict.persistent_id.as_str(), conflict.field.as_str()))
            .copied()
            .cloned()
            .ok_or(SyncError::StaleWritebackPlan)?;
        match choice {
            ResolutionChoice::Local => merge_update(
                &mut plan.track_changes,
                conflict,
                conflict.local.clone(),
                conflict.master.clone(),
            ),
            ResolutionChoice::Master => merge_update(
                &mut plan.pulls,
                conflict,
                conflict.master.clone(),
                conflict.local.clone(),
            ),
        }
    }
    Ok(())
}

fn failure(pid: Option<String>, name: Option<String>, error: impl ToString) -> SyncFailure {
    SyncFailure {
        persistent_id: pid,
        track_name: name,
        error: error.to_string(),
    }
}

fn auth_or_collect(
    result: Result<(), SyncError>,
    failures: &mut Vec<SyncFailure>,
    pid: Option<String>,
    name: Option<String>,
) -> Result<bool, SyncError> {
    match result {
        Ok(()) => Ok(true),
        Err(error @ SyncError::Authentication(_)) => Err(error),
        Err(error) => {
            failures.push(failure(pid, name, error));
            Ok(false)
        }
    }
}

pub async fn apply<F>(
    db: Database,
    source: SyncSource,
    plan_id: String,
    resolutions: Vec<ConflictResolution>,
    progress: F,
) -> Result<WritebackSummary, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    let local = collect_local(&db, source.id)?;
    let client = MasterClient::from_source(&source)?;
    let remote = collect_remote(&client, &local).await?;
    let mut plan = compute_plan(&local, &remote)?;
    if plan.plan_id != plan_id {
        return Err(SyncError::StaleWritebackPlan);
    }
    resolve_conflicts(&mut plan, &resolutions)?;
    let total = plan.track_changes.len() + plan.pulls.len() + plan.playlist_ops.len();
    progress(SyncProgress {
        phase: "writebackApplying".to_string(),
        current: 0,
        total,
        track_name: None,
    });

    let mut summary = WritebackSummary::default();
    let mut completed = 0usize;
    let mut failed_tracks = HashSet::new();
    let mut merged_baselines = remote
        .tracks
        .iter()
        .map(|(pid, track)| track_json(track).map(|json| (pid.clone(), json)))
        .collect::<Result<HashMap<_, _>, _>>()?;
    let mut current_master = remote.tracks;

    for change in &plan.track_changes {
        let Some(master) = current_master.get(&change.persistent_id) else {
            summary.failures.push(failure(
                Some(change.persistent_id.clone()),
                change.track_name.clone(),
                "母艦上の曲が見つかりません",
            ));
            failed_tracks.insert(change.persistent_id.clone());
            continue;
        };
        match client
            .writeback_patch_track(master.track_id, &change.fields)
            .await
        {
            Ok(updated) => {
                if let Some(base) = merged_baselines.get_mut(&change.persistent_id) {
                    let updated_json = track_json(&updated)?;
                    overlay_updated_fields(base, &updated_json, &change.fields);
                }
                current_master.insert(change.persistent_id.clone(), updated);
                summary.pushed += 1;
            }
            Err(error @ SyncError::Authentication(_)) => return Err(error),
            Err(error) => {
                failed_tracks.insert(change.persistent_id.clone());
                summary.failures.push(failure(
                    Some(change.persistent_id.clone()),
                    change.track_name.clone(),
                    error,
                ));
            }
        }
        completed += 1;
        progress(SyncProgress {
            phase: "writebackApplying".to_string(),
            current: completed,
            total,
            track_name: change.track_name.clone(),
        });
    }

    for change in &plan.pulls {
        let master_date = current_master
            .get(&change.persistent_id)
            .and_then(|track| track.date_modified.as_deref());
        let fields = change
            .fields
            .iter()
            .map(|field| {
                (
                    field.field.clone(),
                    field.value.clone(),
                    field.previous.clone(),
                )
            })
            .collect::<Vec<_>>();
        match db.apply_writeback_pull(&change.persistent_id, &fields, master_date) {
            Ok(skipped) => {
                if skipped.len() < fields.len() {
                    summary.pulled += 1;
                }
                if !skipped.is_empty() {
                    failed_tracks.insert(change.persistent_id.clone());
                    summary.failures.push(failure(
                        Some(change.persistent_id.clone()),
                        change.track_name.clone(),
                        "適用中に手元で変更されたため取り込みをスキップ",
                    ));
                }
            }
            Err(error) => {
                failed_tracks.insert(change.persistent_id.clone());
                summary.failures.push(failure(
                    Some(change.persistent_id.clone()),
                    change.track_name.clone(),
                    error,
                ));
            }
        }
        completed += 1;
        progress(SyncProgress {
            phase: "writebackApplying".to_string(),
            current: completed,
            total,
            track_name: change.track_name.clone(),
        });
    }

    for op in &plan.playlist_ops {
        let result = match op {
            PlaylistOp::Create {
                local_playlist_id,
                persistent_id,
                name,
                track_persistent_ids,
            } => match client.writeback_create_playlist(name, persistent_id).await {
                Ok(created) => match created.persistent_id.clone() {
                    None => Err(SyncError::InvalidResponse(
                        "created playlist omitted persistentId".to_string(),
                    )),
                    Some(master_pid) => match db.adopt_master_playlist_identity(
                        *local_playlist_id,
                        source.id,
                        &master_pid,
                        name,
                    ) {
                        Err(error) => Err(SyncError::Database(error)),
                        Ok(()) => {
                            let track_ids = track_persistent_ids
                                .iter()
                                .filter_map(|pid| {
                                    current_master.get(pid).map(|track| track.track_id)
                                })
                                .collect::<Vec<_>>();
                            if track_ids.len() != track_persistent_ids.len() {
                                Err(SyncError::InvalidResponse(
                                    "playlist contains a track missing on master".to_string(),
                                ))
                            } else {
                                let current = client
                                    .playlist_tracks(created.playlist_id)
                                    .await?
                                    .into_iter()
                                    .filter_map(|track| track.persistent_id)
                                    .collect::<Vec<_>>();
                                if let Err(error) = verify_playlist_membership(&current, &[]) {
                                    Err(error)
                                } else {
                                    // GET と PUT の間にはミリ秒単位の競合が残る。将来は ETag 付き conditional PUT で塞ぐ。
                                    client
                                        .writeback_replace_playlist(created.playlist_id, &track_ids)
                                        .await
                                }
                            }
                        }
                    },
                },
                Err(error) => Err(error),
            },
            PlaylistOp::Rename {
                master_playlist_id,
                to,
                ..
            } => {
                client
                    .writeback_rename_playlist(*master_playlist_id, to)
                    .await
            }
            PlaylistOp::ReplaceTracks {
                master_playlist_id,
                track_persistent_ids,
                master_track_persistent_ids,
                ..
            } => {
                let track_ids = track_persistent_ids
                    .iter()
                    .filter_map(|pid| current_master.get(pid).map(|track| track.track_id))
                    .collect::<Vec<_>>();
                if track_ids.len() != track_persistent_ids.len() {
                    Err(SyncError::InvalidResponse(
                        "playlist contains a track missing on master".to_string(),
                    ))
                } else {
                    let current = client
                        .playlist_tracks(*master_playlist_id)
                        .await?
                        .into_iter()
                        .filter_map(|track| track.persistent_id)
                        .collect::<Vec<_>>();
                    if let Err(error) =
                        verify_playlist_membership(&current, master_track_persistent_ids)
                    {
                        Err(error)
                    } else {
                        // GET と PUT の間にはミリ秒単位の競合が残る。将来は ETag 付き conditional PUT で塞ぐ。
                        client
                            .writeback_replace_playlist(*master_playlist_id, &track_ids)
                            .await
                    }
                }
            }
            PlaylistOp::SkippedDelete { .. } => {
                completed += 1;
                continue;
            }
        };
        let (pid, name) = match op {
            PlaylistOp::Create {
                persistent_id,
                name,
                ..
            }
            | PlaylistOp::ReplaceTracks {
                persistent_id,
                name,
                ..
            } => (Some(persistent_id.clone()), Some(name.clone())),
            PlaylistOp::Rename {
                persistent_id, to, ..
            } => (Some(persistent_id.clone()), Some(to.clone())),
            PlaylistOp::SkippedDelete { .. } => unreachable!(),
        };
        if auth_or_collect(result, &mut summary.failures, pid, name)? {
            summary.playlist_ops += 1;
        }
        completed += 1;
        progress(SyncProgress {
            phase: "writebackApplying".to_string(),
            current: completed,
            total,
            track_name: None,
        });
    }

    // plan 時点の母艦値へ成功した push だけを重ね、実際に成立したマージ状態を基準にする。
    for (pid, base) in merged_baselines {
        if failed_tracks.contains(&pid) {
            continue;
        }
        let base_meta = serde_json::to_string(&base)
            .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
        db.record_sync_track(&pid, source.id, &base_meta)?;
    }
    db.touch_sync_source(source.id)?;
    progress(SyncProgress {
        phase: "writebackApplying".to_string(),
        current: total,
        total,
        track_name: None,
    });
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{self, ApiState};
    use crate::devices::ValidTokens;
    use crate::models::TrackEdit;
    use crate::pairing::PairingRegistry;
    use rusqlite::params;

    fn value(value: impl Serialize) -> Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn classifies_all_three_way_states() {
        assert_eq!(
            classify_field("year", value(2024), value(2024), value(2024), None, None),
            FieldDiff::Unchanged
        );
        assert_eq!(
            classify_field("year", value(2024), value(2025), value(2024), None, None),
            FieldDiff::LocalOnly {
                value: value(2025),
                previous: value(2024),
            }
        );
        assert_eq!(
            classify_field("year", value(2024), value(2024), value(2026), None, None),
            FieldDiff::MasterOnly {
                value: value(2026),
                previous: value(2024),
            }
        );
        assert_eq!(
            classify_field("year", value(2024), value(2025), value(2025), None, None),
            FieldDiff::BothSame
        );
    }

    #[test]
    fn conflict_uses_track_date_modified_for_newer_side() {
        assert_eq!(
            classify_field(
                "name",
                value("Base"),
                value("Local"),
                value("Master"),
                Some("2026-07-22T02:00:00Z"),
                Some("2026-07-22T01:00:00Z"),
            ),
            FieldDiff::Conflict {
                local: value("Local"),
                master: value("Master"),
                local_newer: true,
            }
        );
        assert!(matches!(
            classify_field(
                "name",
                value("Base"),
                value("Local"),
                value("Master"),
                Some("2026-07-22T00:00:00Z"),
                Some("2026-07-22T01:00:00Z"),
            ),
            FieldDiff::Conflict {
                local_newer: false,
                ..
            }
        ));
    }

    #[test]
    fn rating_only_local_change_does_not_need_a_new_clock() {
        assert_eq!(
            classify_field(
                "rating",
                value(60),
                value(100),
                value(60),
                Some("2026-07-22T00:00:00Z"),
                Some("2026-07-22T00:00:00Z"),
            ),
            FieldDiff::LocalOnly {
                value: value(100),
                previous: value(60),
            }
        );
    }

    #[test]
    fn unresolved_conflict_is_rejected() {
        let mut local_newer = WritebackPlan {
            conflicts: vec![WritebackConflict {
                persistent_id: "AAAABBBBCCCCDDDD".to_string(),
                track_name: Some("Song".to_string()),
                field: "name".to_string(),
                local: value("Local"),
                master: value("Master"),
                local_newer: true,
            }],
            ..WritebackPlan::default()
        };
        assert!(matches!(
            resolve_conflicts(&mut local_newer, &[]),
            Err(SyncError::StaleWritebackPlan)
        ));
        resolve_conflicts(
            &mut local_newer,
            &[ConflictResolution {
                persistent_id: "AAAABBBBCCCCDDDD".to_string(),
                field: "name".to_string(),
                choose: ResolutionChoice::Local,
            }],
        )
        .unwrap();
        assert_eq!(local_newer.track_changes[0].fields[0].value, value("Local"));
        // push なので previous は上書きされる母艦側の現在値。
        assert_eq!(
            local_newer.track_changes[0].fields[0].previous,
            value("Master")
        );

        let mut master_newer = WritebackPlan {
            conflicts: vec![WritebackConflict {
                local_newer: false,
                ..local_newer.conflicts[0].clone()
            }],
            ..WritebackPlan::default()
        };
        resolve_conflicts(
            &mut master_newer,
            &[ConflictResolution {
                persistent_id: "AAAABBBBCCCCDDDD".to_string(),
                field: "name".to_string(),
                choose: ResolutionChoice::Master,
            }],
        )
        .unwrap();
        assert_eq!(master_newer.pulls[0].fields[0].value, value("Master"));
        // pull なので previous は上書きされる手元側の現在値。
        assert_eq!(master_newer.pulls[0].fields[0].previous, value("Local"));
    }

    #[test]
    fn null_and_empty_strings_are_the_same_blank_metadata() {
        assert_eq!(
            classify_field("comments", Value::Null, value(""), Value::Null, None, None),
            FieldDiff::Unchanged
        );
    }

    #[test]
    fn baseline_overlays_only_successful_push_fields() {
        let mut base = json!({
            "rating": 60,
            "album": "Plan-time Master",
            "playCount": 1
        });
        let patch_response = json!({
            "rating": 100,
            "album": "Drifted Master",
            "playCount": 999
        });
        overlay_updated_fields(
            &mut base,
            &patch_response,
            &[FieldUpdate {
                field: "rating".to_string(),
                value: value(100),
                previous: value(60),
            }],
        );

        assert_eq!(base["rating"], 100);
        assert_eq!(base["album"], "Plan-time Master");
        assert_eq!(base["playCount"], 1);
    }

    #[test]
    fn playlist_membership_drift_is_rejected() {
        assert!(verify_playlist_membership(
            &["AAAABBBBCCCC0001".to_string()],
            &["AAAABBBBCCCC0001".to_string()]
        )
        .is_ok());
        assert!(matches!(
            verify_playlist_membership(
                &["AAAABBBBCCCC0002".to_string()],
                &["AAAABBBBCCCC0001".to_string()]
            ),
            Err(SyncError::PlaylistChangedDuringWriteback)
        ));
    }

    #[test]
    fn serialized_plan_shape_is_stable_for_ui() {
        let mut plan = WritebackPlan {
            plan_id: String::new(),
            track_changes: vec![TrackChange {
                persistent_id: "AAAABBBBCCCCDDDD".to_string(),
                track_name: Some("Song".to_string()),
                fields: vec![FieldUpdate {
                    field: "rating".to_string(),
                    value: value(80),
                    previous: value(60),
                }],
            }],
            conflicts: Vec::new(),
            playlist_ops: vec![PlaylistOp::ReplaceTracks {
                persistent_id: "1111222233334444".to_string(),
                master_playlist_id: 9,
                name: "List".to_string(),
                track_persistent_ids: vec!["AAAABBBBCCCCDDDD".to_string()],
                master_track_persistent_ids: vec!["EEEEFFFF00001111".to_string()],
                overwrites_master_ordering: true,
            }],
            pulls: Vec::new(),
        };
        plan.plan_id = plan_hash(&plan).unwrap();
        assert_eq!(plan.plan_id.len(), 64);
        assert!(plan
            .plan_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        let mut same_payload = plan.clone();
        same_payload.plan_id = "ignored-when-hashing".to_string();
        assert_eq!(plan_hash(&same_payload).unwrap(), plan.plan_id);
        let json = serde_json::to_value(plan).unwrap();
        assert_eq!(json["trackChanges"][0]["persistentId"], "AAAABBBBCCCCDDDD");
        assert_eq!(json["planId"].as_str().unwrap().len(), 64);
        assert_eq!(json["trackChanges"][0]["fields"][0]["previous"], 60);
        assert_eq!(json["playlistOps"][0]["op"], "replaceTracks");
        assert_eq!(
            json["playlistOps"][0]["masterTrackPersistentIds"][0],
            "EEEEFFFF00001111"
        );
        assert_eq!(json["playlistOps"][0]["overwritesMasterOrdering"], true);
        assert!(json.get("pulls").is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn router_writeback_merges_resolves_playlists_and_is_idempotent() {
        let master_dir = tempfile::tempdir().unwrap();
        let media_dir = master_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let one = media_dir.join("one.mp3");
        let two = media_dir.join("two.mp3");
        std::fs::write(&one, b"ID3-master-one").unwrap();
        std::fs::write(&two, b"ID3-master-two").unwrap();

        let master = Database::open(master_dir.path()).unwrap();
        for (track_id, pid, name, path) in [
            (1, "AAAABBBBCCCC0001", "One", &one),
            (2, "AAAABBBBCCCC0002", "Two", &two),
        ] {
            master
                .conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, persistent_id, name, artist, album, rating, date_modified,
                         location_raw, location_path, track_type, track_number, file_exists)
                     VALUES (?1, ?2, ?3, 'Artist', 'Base Album', 60,
                             '2026-07-20T00:00:00Z', ?4, ?5, 'File', ?1, 1)",
                    params![
                        track_id,
                        pid,
                        name,
                        url::Url::from_file_path(path).unwrap().to_string(),
                        path.to_string_lossy(),
                    ],
                )
                .unwrap();
        }
        master
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (10, '111122223333AAAA', 'Provisioned', 0, 0, 1)",
                [],
            )
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (10, 1, 0), (10, 2, 1)",
                [],
            )
            .unwrap();
        master.set_state("server_id", "WRITEBACKMASTER1").unwrap();
        master.set_state("server_name", "Writeback Master").unwrap();
        drop(master);

        let app = api::router(ApiState {
            app_data_dir: master_dir.path().to_path_buf(),
            app: None,
            tokens: ValidTokens::default(),
            pairings: PairingRegistry::default(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let slave_dir = tempfile::tempdir().unwrap();
        let destination = slave_dir.path().join("library");
        let slave = Database::open(slave_dir.path()).unwrap();
        let source = slave
            .upsert_sync_source(
                "WRITEBACKMASTER1",
                Some("Writeback Master"),
                &format!("http://{address}"),
                "sync-token",
            )
            .unwrap();
        let provisioned = super::super::provision(
            slave,
            source.clone(),
            vec!["111122223333AAAA".to_string()],
            destination,
            |_| {},
        )
        .await
        .unwrap();
        assert!(provisioned.failures.is_empty());

        let slave = Database::open(slave_dir.path()).unwrap();
        let local_tracks = slave
            .get_tracks_by_persistent_ids(&[
                "AAAABBBBCCCC0001".to_string(),
                "AAAABBBBCCCC0002".to_string(),
            ])
            .unwrap();
        slave.set_rating(local_tracks[0].track_id, 100).unwrap();
        slave
            .conn
            .execute(
                "UPDATE tracks SET play_count=77, skip_count=8,
                     last_played='2026-07-22T03:00:00Z' WHERE track_id=?1",
                [local_tracks[0].track_id],
            )
            .unwrap();
        slave
            .update_track(
                local_tracks[0].track_id,
                &TrackEdit {
                    name: Some("Local Title".to_string()),
                    ..TrackEdit::default()
                },
            )
            .unwrap();
        let provisioned_playlist = slave
            .get_playlists()
            .unwrap()
            .into_iter()
            .find(|playlist| playlist.persistent_id.as_deref() == Some("111122223333AAAA"))
            .unwrap();
        slave
            .reorder_playlist_tracks(
                provisioned_playlist.playlist_id,
                &[local_tracks[1].track_id, local_tracks[0].track_id],
            )
            .unwrap();
        let local_playlist = slave.create_playlist("Slave Picks", None, false).unwrap();
        slave
            .add_tracks_to_playlist(
                local_playlist.playlist_id,
                &[local_tracks[0].track_id, local_tracks[1].track_id],
            )
            .unwrap();
        drop(slave);

        let master = Database::open(master_dir.path()).unwrap();
        master
            .update_track(
                1,
                &TrackEdit {
                    name: Some("Master Title".to_string()),
                    album: Some("Master Album".to_string()),
                    ..TrackEdit::default()
                },
            )
            .unwrap();
        master
            .conn
            .execute(
                "UPDATE tracks SET play_count=999, skip_count=999,
                     last_played='2026-07-22T04:00:00Z' WHERE track_id=1",
                [],
            )
            .unwrap();
        drop(master);

        let planned = plan(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            |_| {},
        )
        .await
        .unwrap();
        let pushed = planned
            .track_changes
            .iter()
            .find(|change| change.persistent_id == "AAAABBBBCCCC0001")
            .unwrap();
        let pushed_rating = pushed
            .fields
            .iter()
            .find(|field| field.field == "rating")
            .unwrap();
        assert_eq!(pushed_rating.value, value(100));
        // 母艦のレートは変更されていないので、previous は上書き前の母艦側の値。
        assert_eq!(pushed_rating.previous, value(60));
        assert!(planned.conflicts.iter().any(|conflict| {
            conflict.persistent_id == "AAAABBBBCCCC0001" && conflict.field == "name"
        }));
        let pulled_album = planned
            .pulls
            .iter()
            .find(|pull| pull.persistent_id == "AAAABBBBCCCC0001")
            .and_then(|pull| pull.fields.iter().find(|field| field.field == "album"))
            .unwrap();
        assert_eq!(pulled_album.value, value("Master Album"));
        // 手元のアルバムは変更されていないので、previous は上書き前の手元側の値。
        assert_eq!(pulled_album.previous, value("Base Album"));
        assert!(planned
            .playlist_ops
            .iter()
            .any(|op| matches!(op, PlaylistOp::Create { name, .. } if name == "Slave Picks")));
        assert!(planned.playlist_ops.iter().any(|op| matches!(
            op,
            PlaylistOp::ReplaceTracks {
                persistent_id,
                overwrites_master_ordering: true,
                ..
            } if persistent_id == "111122223333AAAA"
        )));

        // 確認後に手元が変わった plan は、母艦へ一切適用せず拒否する。
        let slave = Database::open(slave_dir.path()).unwrap();
        slave.set_rating(local_tracks[0].track_id, 80).unwrap();
        drop(slave);
        let stale = apply(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            planned.plan_id.clone(),
            vec![ConflictResolution {
                persistent_id: "AAAABBBBCCCC0001".to_string(),
                field: "name".to_string(),
                choose: ResolutionChoice::Local,
            }],
            |_| {},
        )
        .await;
        assert!(matches!(stale, Err(SyncError::StaleWritebackPlan)));
        let untouched = Database::open(master_dir.path()).unwrap();
        assert_eq!(
            untouched.get_track_by_track_id(1).unwrap().unwrap().rating,
            Some(60)
        );
        drop(untouched);
        let slave = Database::open(slave_dir.path()).unwrap();
        slave.set_rating(local_tracks[0].track_id, 100).unwrap();
        drop(slave);
        let planned = plan(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            |_| {},
        )
        .await
        .unwrap();

        let summary = apply(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            planned.plan_id.clone(),
            vec![ConflictResolution {
                persistent_id: "AAAABBBBCCCC0001".to_string(),
                field: "name".to_string(),
                choose: ResolutionChoice::Local,
            }],
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.pushed, 1);
        assert_eq!(summary.pulled, 1);
        assert_eq!(summary.playlist_ops, 2);
        assert!(summary.failures.is_empty());

        let client = MasterClient::from_source(&source).unwrap();
        let master_tracks = client
            .writeback_tracks(&["AAAABBBBCCCC0001".to_string()])
            .await
            .unwrap();
        assert_eq!(master_tracks[0].name.as_deref(), Some("Local Title"));
        assert_eq!(master_tracks[0].album.as_deref(), Some("Master Album"));
        assert_eq!(master_tracks[0].rating, Some(100));
        let remote_playlists = client.playlists().await.unwrap();
        let created = remote_playlists
            .iter()
            .find(|playlist| playlist.name == "Slave Picks")
            .unwrap();
        assert_eq!(created.persistent_id, local_playlist.persistent_id);
        assert_eq!(
            client
                .playlist_tracks(created.playlist_id)
                .await
                .unwrap()
                .len(),
            2
        );
        let retried = client
            .writeback_create_playlist(
                "Slave Picks",
                local_playlist.persistent_id.as_deref().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retried.playlist_id, created.playlist_id);
        assert_eq!(
            client
                .playlists()
                .await
                .unwrap()
                .iter()
                .filter(|playlist| playlist.persistent_id == local_playlist.persistent_id)
                .count(),
            1
        );
        let provisioned_members = client.playlist_tracks(10).await.unwrap();
        assert_eq!(
            provisioned_members
                .iter()
                .filter_map(|track| track.persistent_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["AAAABBBBCCCC0002", "AAAABBBBCCCC0001"]
        );

        let slave = Database::open(slave_dir.path()).unwrap();
        let local = slave
            .get_tracks_by_persistent_ids(&["AAAABBBBCCCC0001".to_string()])
            .unwrap();
        assert_eq!(local[0].album.as_deref(), Some("Master Album"));
        assert_eq!(local[0].play_count, Some(77));
        assert_eq!(local[0].skip_count, Some(8));
        assert_eq!(
            local[0].last_played.as_deref(),
            Some("2026-07-22T03:00:00Z")
        );
        let base_meta: String = slave
            .conn
            .query_row(
                "SELECT base_meta FROM sync_track WHERE persistent_id='AAAABBBBCCCC0001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let base: Track = serde_json::from_str(&base_meta).unwrap();
        assert_eq!(base.name.as_deref(), Some("Local Title"));
        assert_eq!(base.album.as_deref(), Some("Master Album"));
        assert_eq!(base.rating, Some(100));
        assert_eq!(base.play_count, Some(999));
        drop(slave);

        let second = plan(Database::open(slave_dir.path()).unwrap(), source, |_| {})
            .await
            .unwrap();
        assert!(second.track_changes.is_empty());
        assert!(second.conflicts.is_empty());
        assert!(second.pulls.is_empty());
        assert!(second.playlist_ops.is_empty());
        server.abort();
    }
}
