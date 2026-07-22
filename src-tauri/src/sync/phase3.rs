//! federation Phase 3: follow 再同期、eviction、容量表示。

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::writeback::{
    classify_field, field_value, has_local_changes, track_json, FieldDiff, WRITEBACK_FIELDS,
};
use super::{required_pid, MasterClient, SyncError, SyncFailure, SyncProgress, SyncedTrackState};
use crate::db::sync::{SyncSelectionRecord, SyncSource, SyncedTrackFileRecord};
use crate::db::Database;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncSummary {
    pub selections_synced: usize,
    /// snapshot policy のため意図的に処理しなかった選択数。
    pub selections_skipped: usize,
    pub tracks_added: usize,
    pub tracks_updated: usize,
    pub membership_replaced: usize,
    pub eviction_candidates: usize,
    pub local_edits_preserved: Vec<SelectionMergeWarning>,
    pub membership_overwritten: Vec<SelectionMergeWarning>,
    pub dirty_excluded_note: Option<String>,
    pub failures: Vec<SyncFailure>,
    /// コマンド層の reload 通知判定用。IPC payload には含めない。
    #[serde(skip)]
    pub mutations_committed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionMergeWarning {
    pub persistent_id: String,
    pub playlist_name: String,
    /// `membership` / `name`。同じ playlist で両方なら2要素になる。
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvictionCandidate {
    pub persistent_id: String,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub file_path: Option<String>,
    pub bytes: u64,
    pub dirty: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictionSummary {
    pub evicted: usize,
    pub files_deleted: usize,
    /// 実際に削除できたファイルの合計サイズ（削除前に stat した値のみ加算）。
    pub freed_bytes: u64,
    pub dirty_excluded_note: Option<String>,
    pub failures: Vec<SyncFailure>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStorageUsage {
    pub selection_id: i64,
    pub name: String,
    pub track_count: usize,
    pub bytes: u64,
    pub missing_files: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageTotal {
    pub track_count: usize,
    pub bytes: u64,
    pub missing_files: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub selections: Vec<SelectionStorageUsage>,
    pub total: StorageUsageTotal,
}

fn failure(pid: Option<String>, name: Option<String>, error: impl ToString) -> SyncFailure {
    SyncFailure {
        persistent_id: pid,
        track_name: name,
        error: error.to_string(),
    }
}

fn selection_failure(selection: &SyncSelectionRecord, error: impl ToString) -> SyncFailure {
    failure(
        Some(selection.remote_pid.clone()),
        Some(selection.name.clone()),
        error,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectionMerge {
    ApplyMaster,
    PreserveLocal,
    OverwriteLocal,
}

fn classify_selection<T: PartialEq>(base: &T, local: &T, master: &T) -> SelectionMerge {
    if local == base {
        SelectionMerge::ApplyMaster
    } else if master == base {
        SelectionMerge::PreserveLocal
    } else {
        SelectionMerge::OverwriteLocal
    }
}

fn push_merge_warning(
    warnings: &mut Vec<SelectionMergeWarning>,
    selection: &SyncSelectionRecord,
    playlist_name: &str,
    change: &str,
) {
    if let Some(existing) = warnings
        .iter_mut()
        .find(|warning| warning.persistent_id == selection.remote_pid)
    {
        existing.changes.push(change.to_string());
    } else {
        warnings.push(SelectionMergeWarning {
            persistent_id: selection.remote_pid.clone(),
            playlist_name: playlist_name.to_string(),
            changes: vec![change.to_string()],
        });
    }
}

async fn resync_selection(
    db: &mut Database,
    source: &SyncSource,
    client: &MasterClient,
    selection: &SyncSelectionRecord,
    master_playlist: &crate::models::Playlist,
    summary: &mut ResyncSummary,
    added: &mut HashSet<String>,
    updated: &mut HashSet<String>,
    refreshed: &mut HashSet<String>,
) -> Result<(), SyncError> {
    let master_tracks = client.playlist_tracks(master_playlist.playlist_id).await?;
    let master_pids = master_tracks
        .iter()
        .map(|track| required_pid(track).map(str::to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let local_playlist = db.get_playlist_by_persistent_id(&selection.remote_pid)?;
    let local_tracks = match &local_playlist {
        Some(playlist) => db.get_playlist_tracks(playlist.playlist_id, i64::MAX, 0, None, None)?,
        None => Vec::new(),
    };
    let local_pids = local_tracks
        .iter()
        .filter_map(|track| track.persistent_id.clone())
        .collect::<Vec<_>>();
    // 旧DBには基準曲順がないため、初回だけ現在のローカル状態を基準として mirror する。
    let base_pids = selection.base_membership.as_ref().unwrap_or(&local_pids);
    let membership_merge = classify_selection(base_pids, &local_pids, &master_pids);
    let desired_pids = if membership_merge == SelectionMerge::PreserveLocal {
        local_pids.clone()
    } else {
        master_pids.clone()
    };

    let local_name = local_playlist
        .as_ref()
        .map(|playlist| playlist.name.clone())
        .unwrap_or_default();
    let base_name = selection.base_name.as_deref().unwrap_or(&selection.name);
    let name_merge = classify_selection(
        &base_name,
        &local_name.as_str(),
        &master_playlist.name.as_str(),
    );
    let desired_name = if name_merge == SelectionMerge::PreserveLocal {
        local_name.clone()
    } else {
        master_playlist.name.clone()
    };
    for (merge, change) in [(membership_merge, "membership"), (name_merge, "name")] {
        match merge {
            SelectionMerge::PreserveLocal => push_merge_warning(
                &mut summary.local_edits_preserved,
                selection,
                &desired_name,
                change,
            ),
            SelectionMerge::OverwriteLocal => push_merge_warning(
                &mut summary.membership_overwritten,
                selection,
                &master_playlist.name,
                change,
            ),
            SelectionMerge::ApplyMaster => {}
        }
    }

    let desired_pid_set = desired_pids.iter().cloned().collect::<HashSet<_>>();
    let local_pid_set = local_pids.iter().cloned().collect::<HashSet<_>>();
    let new_tracks = master_tracks
        .iter()
        .filter(|track| {
            track
                .persistent_id
                .as_ref()
                .is_some_and(|pid| desired_pid_set.contains(pid) && !local_pid_set.contains(pid))
        })
        .collect::<Vec<_>>();
    let to_download = new_tracks
        .iter()
        .filter(|track| {
            required_pid(track).is_ok_and(|pid| match db.synced_track_state(pid, source.id) {
                Ok(SyncedTrackState::Missing | SyncedTrackState::Owned(None)) => true,
                Ok(SyncedTrackState::Owned(Some(path))) => !Path::new(&path).is_file(),
                Ok(SyncedTrackState::Collision) | Err(_) => false,
            })
        })
        .map(|track| required_pid(track).unwrap().to_string())
        .collect::<Vec<_>>();
    let mut analyses = if to_download.is_empty() {
        HashMap::new()
    } else {
        client.analyses(&to_download).await?
    };
    let landing_root = selection.landing_root.as_deref().map(PathBuf::from);
    let mut selection_failed = false;
    for track in new_tracks {
        let pid = required_pid(track)?;
        match db.synced_track_state(pid, source.id)? {
            SyncedTrackState::Owned(Some(path)) if Path::new(&path).is_file() => {}
            SyncedTrackState::Collision => {
                summary.failures.push(failure(
                    Some(pid.to_string()),
                    track.name.clone(),
                    "別のサーバー由来の曲と persistent_id が衝突しています",
                ));
                selection_failed = true;
            }
            SyncedTrackState::Missing | SyncedTrackState::Owned(_) => {
                let Some(root) = landing_root.as_deref() else {
                    summary.failures.push(failure(
                        Some(pid.to_string()),
                        track.name.clone(),
                        "同期の着地ルートが記録されていないため追加曲を取得できません",
                    ));
                    selection_failed = true;
                    continue;
                };
                std::fs::create_dir_all(root)
                    .map_err(|error| SyncError::File(error.to_string()))?;
                let (landed, _) = match client.download_track(track, root).await {
                    Ok(value) => value,
                    Err(error @ SyncError::Authentication(_)) => return Err(error),
                    Err(error) => {
                        summary.failures.push(failure(
                            Some(pid.to_string()),
                            track.name.clone(),
                            error,
                        ));
                        selection_failed = true;
                        continue;
                    }
                };
                match db.upsert_synced_track(track, &landed, source.id)? {
                    Some(_) => {
                        if let Some(analysis) = analyses.remove(pid) {
                            db.upsert_analysis(pid, &analysis)?;
                        }
                        let base = serde_json::to_string(track)
                            .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
                        db.record_sync_track_with_root(pid, source.id, &base, Some(root))?;
                        added.insert(pid.to_string());
                        refreshed.insert(pid.to_string());
                        summary.mutations_committed = true;
                    }
                    None => {
                        selection_failed = true;
                        summary.failures.push(failure(
                            Some(pid.to_string()),
                            track.name.clone(),
                            "別のサーバー由来の曲と persistent_id が衝突しています",
                        ));
                    }
                }
            }
        }
    }

    // 同じ曲が複数選択にあっても metadata の三者比較は一度だけ行う。
    let snapshots = db
        .list_synced_track_snapshots(source.id)?
        .into_iter()
        .map(|row| (row.persistent_id.clone(), row))
        .collect::<HashMap<_, _>>();
    for master in &master_tracks {
        let pid = required_pid(master)?;
        if !refreshed.insert(pid.to_string()) {
            continue;
        }
        let Some(row) = snapshots.get(pid) else {
            continue;
        };
        let old_base: Value = match serde_json::from_str(&row.base_meta) {
            Ok(value) => value,
            Err(error) => {
                summary.failures.push(failure(
                    Some(pid.to_string()),
                    master.name.clone(),
                    format!("invalid base_meta: {error}"),
                ));
                continue;
            }
        };
        let local_json = track_json(&row.local)?;
        let master_json = track_json(master)?;
        let mut merged_base = old_base.clone();
        let mut pulls = Vec::new();
        let mut baseline_fields = HashSet::new();
        for field in WRITEBACK_FIELDS {
            match classify_field(
                field,
                field_value(&old_base, field),
                field_value(&local_json, field),
                field_value(&master_json, field),
                row.local.date_modified.as_deref(),
                master.date_modified.as_deref(),
            ) {
                FieldDiff::Unchanged | FieldDiff::BothSame => {
                    baseline_fields.insert(field.to_string());
                }
                FieldDiff::MasterOnly { value, previous } => {
                    pulls.push((field.to_string(), value, previous));
                }
                FieldDiff::LocalOnly { .. } | FieldDiff::Conflict { .. } => {}
            }
        }
        let skipped = db.apply_writeback_pull(pid, &pulls, master.date_modified.as_deref())?;
        for (field, _, _) in &pulls {
            if !skipped.contains(field) {
                baseline_fields.insert(field.clone());
            }
        }
        if let Some(base) = merged_base.as_object_mut() {
            for field in baseline_fields {
                base.insert(field.clone(), field_value(&master_json, &field));
            }
        }
        db.update_sync_track_base(
            pid,
            &serde_json::to_string(&merged_base)
                .map_err(|error| SyncError::InvalidResponse(error.to_string()))?,
        )?;
        summary.mutations_committed = true;
        if pulls.len() > skipped.len() {
            updated.insert(pid.to_string());
        }
    }

    let membership = db.synced_track_ids(&desired_pids)?;
    if selection_failed || membership.iter().any(Option::is_none) {
        return Err(SyncError::InvalidResponse(
            "未取得の曲があるためプレイリストを更新しませんでした".to_string(),
        ));
    }
    let membership = membership.into_iter().flatten().collect::<Vec<_>>();
    if local_pids != desired_pids || local_name != desired_name {
        let mut desired_playlist = master_playlist.clone();
        desired_playlist.name = desired_name;
        db.create_or_replace_playlist_with_pid(&desired_playlist, &membership)?;
        summary.mutations_committed = true;
        if local_pids != desired_pids {
            summary.membership_replaced += 1;
        }
    }
    db.record_sync_selection_baseline_with_root(
        source.id,
        &selection.remote_pid,
        &master_playlist.name,
        &master_pids,
        landing_root.as_deref(),
    )?;
    summary.mutations_committed = true;
    summary.selections_synced += 1;
    Ok(())
}

/// follow 選択を母艦へ追従させる。非認証エラーは選択単位で記録して継続する。
pub async fn resync<F>(
    mut db: Database,
    source: SyncSource,
    progress: F,
) -> Result<ResyncSummary, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    let _sync_guard = super::lock_mutating_sync().await;
    let mut summary = ResyncSummary::default();
    let client = match MasterClient::from_source(&source) {
        Ok(client) => client,
        Err(error) => {
            summary.failures.push(failure(None, None, error));
            return Ok(summary);
        }
    };
    let selections = match db.list_sync_selection_records(source.id) {
        Ok(selections) => selections,
        Err(error) => {
            summary.failures.push(failure(None, None, error));
            return Ok(summary);
        }
    };
    progress(SyncProgress {
        phase: "resyncing".to_string(),
        current: 0,
        total: selections.len(),
        track_name: None,
    });
    let remote = match client.playlists().await {
        Ok(playlists) => playlists
            .into_iter()
            .filter_map(|playlist| playlist.persistent_id.clone().map(|pid| (pid, playlist)))
            .collect::<HashMap<_, _>>(),
        Err(error @ SyncError::Authentication(_)) => return Err(error),
        Err(error) => {
            summary.failures.push(failure(None, None, error));
            return Ok(summary);
        }
    };
    let mut added = HashSet::new();
    let mut updated = HashSet::new();
    let mut refreshed = HashSet::new();

    for (index, selection) in selections.iter().enumerate() {
        if selection.policy != "follow" {
            summary.selections_skipped += 1;
        } else if let Some(master_playlist) = remote.get(&selection.remote_pid) {
            match resync_selection(
                &mut db,
                &source,
                &client,
                selection,
                master_playlist,
                &mut summary,
                &mut added,
                &mut updated,
                &mut refreshed,
            )
            .await
            {
                Ok(()) => {}
                Err(error @ SyncError::Authentication(_)) => return Err(error),
                Err(error) => summary.failures.push(selection_failure(selection, error)),
            }
        } else {
            summary.failures.push(selection_failure(
                selection,
                "母艦側にプレイリストがありません",
            ));
        }
        progress(SyncProgress {
            phase: "resyncing".to_string(),
            current: index + 1,
            total: selections.len(),
            track_name: Some(selection.name.clone()),
        });
    }

    summary.tracks_added = added.len();
    summary.tracks_updated = updated.len();
    match scan_eviction_candidates(&db, source.id) {
        Ok(scan) => {
            summary.eviction_candidates = scan.candidates.len();
            summary.dirty_excluded_note = dirty_excluded_note(scan.dirty_excluded);
        }
        Err(error) => summary.failures.push(failure(None, None, error)),
    }
    if let Err(error) = db.touch_sync_source(source.id) {
        summary.failures.push(failure(None, None, error));
    } else {
        summary.mutations_committed = true;
    }
    progress(SyncProgress {
        phase: "resyncing".to_string(),
        current: selections.len(),
        total: selections.len(),
        track_name: None,
    });
    Ok(summary)
}

#[derive(Debug)]
enum ValidatedLandedFile {
    Present {
        path: PathBuf,
        bytes: u64,
        mtime: i64,
    },
    Missing,
}

fn validate_recorded_file(record: &SyncedTrackFileRecord) -> Result<ValidatedLandedFile, String> {
    let path = record
        .location_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| "記録されたファイルパスがありません".to_string())?;
    let root = record
        .landing_root
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| "同期の着地ルートが記録されていません".to_string())?;
    if !path.is_absolute() || !root.is_absolute() {
        return Err("記録されたファイルパスまたは着地ルートが絶対パスではありません".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("着地ルートを確認できません: {error}"))?;
    if canonical_root != root {
        return Err("着地ルートにシンボリックリンクまたは非正規パスが含まれています".to_string());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err("記録されたパスが通常ファイルではありません".to_string());
            }
            let canonical_path = path
                .canonicalize()
                .map_err(|error| format!("ファイル境界を確認できません: {error}"))?;
            if canonical_path != path {
                return Err(
                    "記録されたファイルにシンボリックリンクまたは非正規パスが含まれています"
                        .to_string(),
                );
            }
            if !canonical_path.starts_with(&canonical_root) || canonical_path == canonical_root {
                return Err("記録されたファイルが同期の着地ルート外にあります".to_string());
            }
            let mtime = metadata
                .modified()
                .map_err(|error| format!("ファイル更新時刻を確認できません: {error}"))?
                .duration_since(UNIX_EPOCH)
                .map_err(|error| format!("ファイル更新時刻が不正です: {error}"))?
                .as_secs();
            let mtime =
                i64::try_from(mtime).map_err(|_| "ファイル更新時刻が範囲外です".to_string())?;
            Ok(ValidatedLandedFile::Present {
                path: canonical_path,
                bytes: metadata.len(),
                mtime,
            })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| "記録されたファイルの親ディレクトリがありません".to_string())?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|error| format!("ファイルの親ディレクトリを確認できません: {error}"))?;
            if canonical_parent != parent
                || !canonical_parent.starts_with(&canonical_root)
                || path == canonical_root
            {
                return Err("記録された欠損ファイルのパス境界を確認できません".to_string());
            }
            Ok(ValidatedLandedFile::Missing)
        }
        Err(error) => Err(format!("記録されたファイルを確認できません: {error}")),
    }
}

fn fingerprint_is_dirty(
    record: &SyncedTrackFileRecord,
) -> Result<(bool, ValidatedLandedFile), String> {
    let Some(landed_size) = record.landed_size else {
        return Err("着地時のファイルサイズが記録されていません".to_string());
    };
    let Some(landed_mtime) = record.landed_mtime else {
        return Err("着地時のファイル更新時刻が記録されていません".to_string());
    };
    let validated = validate_recorded_file(record)?;
    let dirty = match &validated {
        ValidatedLandedFile::Present { bytes, mtime, .. } => {
            i64::try_from(*bytes).ok() != Some(landed_size) || *mtime != landed_mtime
        }
        // 既に欠損しているファイルは DB の残骸だけ安全に片付けられる。
        ValidatedLandedFile::Missing => false,
    };
    Ok((dirty, validated))
}

#[derive(Default)]
struct EvictionScan {
    candidates: Vec<EvictionCandidate>,
    dirty_excluded: usize,
}

fn dirty_excluded_note(count: usize) -> Option<String> {
    (count > 0).then(|| {
        format!(
            "ローカル変更、ファイル差分、または着地時フィンガープリント欠損のため {count} 曲を候補から除外しました"
        )
    })
}

fn scan_eviction_candidates(db: &Database, source_id: i64) -> Result<EvictionScan, SyncError> {
    let mut scan = EvictionScan::default();
    for row in db.unreferenced_synced_track_snapshots(source_id)? {
        let record = db.synced_track_file_record(&row.persistent_id)?;
        let file_state = record
            .as_ref()
            .and_then(|record| fingerprint_is_dirty(record).ok());
        let dirty = has_local_changes(&row.base_meta, &row.local).unwrap_or(true)
            || !matches!(file_state, Some((false, _)));
        if dirty {
            scan.dirty_excluded += 1;
            continue;
        }
        let bytes = match file_state.as_ref().map(|(_, state)| state) {
            Some(ValidatedLandedFile::Present { bytes, .. }) => *bytes,
            _ => 0,
        };
        scan.candidates.push(EvictionCandidate {
            persistent_id: row.persistent_id,
            name: row.local.name,
            artist: row.local.artist,
            file_path: row.local.location_path,
            bytes,
            dirty: false,
        });
    }
    Ok(scan)
}

/// 同期所有・全 playlist から未参照・ローカル差分なし、の三条件を満たす曲だけを返す。
pub fn compute_eviction_candidates(
    db: &Database,
    source_id: i64,
) -> Result<Vec<EvictionCandidate>, SyncError> {
    Ok(scan_eviction_candidates(db, source_id)?.candidates)
}

/// ファイルを先に削除し、その後の IMMEDIATE transaction で eligibility を再確認する。
pub async fn evict(
    db: &mut Database,
    persistent_ids: &[String],
) -> Result<EvictionSummary, SyncError> {
    let _sync_guard = super::lock_mutating_sync().await;
    let mut allowed = HashSet::new();
    let mut dirty_excluded = 0;
    for source in db.list_sync_sources()? {
        let scan = scan_eviction_candidates(db, source.id)?;
        dirty_excluded += scan.dirty_excluded;
        allowed.extend(
            scan.candidates
                .into_iter()
                .map(|candidate| candidate.persistent_id),
        );
    }
    let mut summary = EvictionSummary {
        dirty_excluded_note: dirty_excluded_note(dirty_excluded),
        ..EvictionSummary::default()
    };
    let mut seen = HashSet::new();
    for persistent_id in persistent_ids {
        if !seen.insert(persistent_id.clone()) {
            continue;
        }
        if !allowed.contains(persistent_id) {
            summary.failures.push(failure(
                Some(persistent_id.clone()),
                None,
                "eviction candidate ではありません",
            ));
            continue;
        }
        let Some(record) = db.synced_track_file_record(persistent_id)? else {
            summary.failures.push(failure(
                Some(persistent_id.clone()),
                None,
                "同期所有の曲が見つかりません",
            ));
            continue;
        };
        let validated = match fingerprint_is_dirty(&record) {
            Ok((false, validated)) => validated,
            Ok((true, _)) => {
                summary.failures.push(failure(
                    Some(persistent_id.clone()),
                    None,
                    "ファイルが着地時から変更されているため削除しませんでした",
                ));
                continue;
            }
            Err(error) => {
                summary.failures.push(failure(
                    Some(persistent_id.clone()),
                    None,
                    format!("ファイルを安全に検証できないため削除しませんでした: {error}"),
                ));
                continue;
            }
        };
        if let ValidatedLandedFile::Present { path, bytes, .. } = validated {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    summary.files_deleted += 1;
                    summary.freed_bytes += bytes;
                }
                Err(error) => {
                    summary.failures.push(failure(
                        Some(persistent_id.clone()),
                        None,
                        format!("ファイルを削除できませんでした: {error}"),
                    ));
                    continue;
                }
            }
        }
        if !db.delete_synced_track_if_eligible(persistent_id)? {
            summary.failures.push(failure(
                Some(persistent_id.clone()),
                None,
                "削除直前の再検証で参照またはローカル変更が見つかりました",
            ));
            continue;
        }
        summary.evicted += 1;
    }
    Ok(summary)
}

pub fn storage_usage(db: &Database, source_id: i64) -> Result<StorageUsage, SyncError> {
    let mut usage = StorageUsage::default();
    let mut total_files = HashMap::<String, (u64, bool)>::new();
    for selection in db.list_sync_selection_records(source_id)? {
        let tracks = match db.get_playlist_by_persistent_id(&selection.remote_pid)? {
            Some(playlist) => {
                db.get_playlist_tracks(playlist.playlist_id, i64::MAX, 0, None, None)?
            }
            None => Vec::new(),
        };
        let mut row = SelectionStorageUsage {
            selection_id: selection.id,
            name: selection.name,
            track_count: tracks.len(),
            bytes: 0,
            missing_files: 0,
        };
        for track in tracks {
            let pid = track.persistent_id.clone();
            match track
                .location_path
                .as_deref()
                .and_then(|path| std::fs::metadata(path).ok())
                .filter(|metadata| metadata.is_file())
            {
                Some(metadata) => {
                    row.bytes += metadata.len();
                    if let Some(pid) = pid {
                        total_files.entry(pid).or_insert((metadata.len(), false));
                    }
                }
                None => {
                    row.missing_files += 1;
                    if let Some(pid) = pid {
                        total_files.entry(pid).or_insert((0, true));
                    }
                }
            }
        }
        usage.selections.push(row);
    }
    usage.total.track_count = total_files.len();
    usage.total.bytes = total_files.values().map(|(bytes, _)| bytes).sum();
    usage.total.missing_files = total_files.values().filter(|(_, missing)| *missing).count();
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{self, ApiState};
    use crate::devices::ValidTokens;
    use crate::models::{Playlist, Track, TrackAnalysis};
    use crate::pairing::PairingRegistry;
    use rusqlite::params;
    use tempfile::tempdir;

    fn track(pid: &str, name: &str, path: &Path) -> Track {
        Track {
            id: 1,
            track_id: 1,
            persistent_id: Some(pid.to_string()),
            name: Some(name.to_string()),
            artist: Some("Artist".to_string()),
            album_artist: None,
            composer: None,
            album: Some("Album".to_string()),
            genre: None,
            year: None,
            rating: Some(0),
            play_count: None,
            skip_count: None,
            total_time_ms: Some(1000),
            date_added: None,
            date_modified: None,
            bpm: None,
            comments: None,
            location_raw: None,
            location_path: Some(path.to_string_lossy().to_string()),
            track_type: Some("File".to_string()),
            disabled: false,
            compilation: false,
            disc_number: None,
            disc_count: None,
            track_number: None,
            track_count: None,
            file_exists: true,
            last_played: None,
        }
    }

    fn playlist(pid: &str, name: &str) -> Playlist {
        Playlist {
            id: 1,
            playlist_id: 1,
            persistent_id: Some(pid.to_string()),
            parent_persistent_id: None,
            name: name.to_string(),
            is_folder: false,
            is_smart: false,
            is_user_created: false,
            track_count: 0,
        }
    }

    #[test]
    fn selection_merge_covers_all_three_way_cases() {
        assert_eq!(
            classify_selection(&vec!["A"], &vec!["A"], &vec!["B"]),
            SelectionMerge::ApplyMaster
        );
        assert_eq!(
            classify_selection(&vec!["A"], &vec!["B"], &vec!["A"]),
            SelectionMerge::PreserveLocal
        );
        assert_eq!(
            classify_selection(&vec!["A"], &vec!["B"], &vec!["C"]),
            SelectionMerge::OverwriteLocal
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mutating_sync_mutex_serializes_operations() {
        let first = super::super::lock_mutating_sync().await;
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(10),
            super::super::lock_mutating_sync(),
        )
        .await;
        assert!(second.is_err());
        drop(first);
    }

    #[test]
    fn candidates_exclude_referenced_dirty_and_non_sync_tracks() {
        let db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let source = db
            .upsert_sync_source("server", Some("Server"), "http://server", "token")
            .unwrap();
        let selected = playlist("1111111111111111", "Selected");
        let pids = [
            "AAAAAAAAAAAAAAAA",
            "BBBBBBBBBBBBBBBB",
            "CCCCCCCCCCCCCCCC",
            "DDDDDDDDDDDDDDDD",
        ];
        let mut ids = Vec::new();
        for (index, pid) in pids.iter().enumerate() {
            let path = dir.path().join(format!("{pid}.mp3"));
            std::fs::write(&path, b"audio").unwrap();
            let value = track(pid, &format!("Track {index}"), &path);
            let id = db
                .upsert_synced_track(&value, &path, source.id)
                .unwrap()
                .unwrap();
            ids.push(id);
            if index < 3 {
                db.record_sync_track_with_root(
                    pid,
                    source.id,
                    &serde_json::to_string(&value).unwrap(),
                    Some(dir.path()),
                )
                .unwrap();
            }
        }
        db.create_or_replace_playlist_with_pid(&selected, &[ids[0]])
            .unwrap();
        db.record_sync_selection_with_root(
            source.id,
            selected.persistent_id.as_deref().unwrap(),
            &selected.name,
            Some(dir.path()),
        )
        .unwrap();
        db.conn
            .execute(
                "UPDATE tracks SET rating=80 WHERE persistent_id=?1",
                [pids[1]],
            )
            .unwrap();

        let candidates = compute_eviction_candidates(&db, source.id).unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.persistent_id.as_str())
                .collect::<Vec<_>>(),
            vec![pids[2]]
        );
    }

    #[test]
    fn candidate_referenced_by_another_sources_selection_is_preserved() {
        let db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let owner = db
            .upsert_sync_source("owner", Some("Owner"), "http://owner", "token")
            .unwrap();
        let other = db
            .upsert_sync_source("other", Some("Other"), "http://other", "token")
            .unwrap();
        let path = dir.path().join("shared.mp3");
        std::fs::write(&path, b"shared").unwrap();
        let value = track("EEEEEEEEEEEEEEEE", "Shared", &path);
        let track_id = db
            .upsert_synced_track(&value, &path, owner.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "EEEEEEEEEEEEEEEE",
            owner.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        let selected = playlist("2222222222222222", "Other selection");
        db.create_or_replace_playlist_with_pid(&selected, &[track_id])
            .unwrap();
        db.record_sync_selection_with_root(
            other.id,
            "2222222222222222",
            "Other selection",
            Some(dir.path()),
        )
        .unwrap();

        assert!(compute_eviction_candidates(&db, owner.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn remotely_removed_track_in_local_user_playlist_is_not_a_candidate() {
        let db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let source = db
            .upsert_sync_source("owner-local", Some("Owner"), "http://owner", "token")
            .unwrap();
        let path = dir.path().join("local-reference.mp3");
        std::fs::write(&path, b"shared").unwrap();
        let value = track("EFEFEFEFEFEFEFEF", "Local reference", &path);
        let track_id = db
            .upsert_synced_track(&value, &path, source.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "EFEFEFEFEFEFEFEF",
            source.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        db.conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (77, '7777777777777777', '手元のリスト', 0, 0, 1)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (77, ?1, 0)",
                [track_id],
            )
            .unwrap();

        assert!(compute_eviction_candidates(&db, source.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn changed_media_fingerprint_and_missing_legacy_fingerprint_are_excluded() {
        let db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let source = db
            .upsert_sync_source("fingerprint", Some("Fingerprint"), "http://fp", "token")
            .unwrap();
        let changed_path = dir.path().join("changed.mp3");
        let legacy_path = dir.path().join("legacy.mp3");
        std::fs::write(&changed_path, b"audio").unwrap();
        std::fs::write(&legacy_path, b"audio").unwrap();
        for (pid, path) in [
            ("FAFAFAFAFAFAFA01", &changed_path),
            ("FAFAFAFAFAFAFA02", &legacy_path),
        ] {
            let value = track(pid, pid, path);
            db.upsert_synced_track(&value, path, source.id).unwrap();
            db.record_sync_track_with_root(
                pid,
                source.id,
                &serde_json::to_string(&value).unwrap(),
                Some(dir.path()),
            )
            .unwrap();
        }
        std::fs::write(&changed_path, b"audio-modified").unwrap();
        db.conn
            .execute(
                "UPDATE sync_track SET landed_size=NULL, landed_mtime=NULL
                 WHERE persistent_id='FAFAFAFAFAFAFA02'",
                [],
            )
            .unwrap();

        let scan = scan_eviction_candidates(&db, source.id).unwrap();
        assert!(scan.candidates.is_empty());
        assert_eq!(scan.dirty_excluded, 2);
        assert!(dirty_excluded_note(scan.dirty_excluded)
            .unwrap()
            .contains("2 曲"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn eviction_fails_closed_for_unsafe_path_and_transaction_rechecks_references() {
        let mut db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = db
            .upsert_sync_source("fail-closed", Some("Fail closed"), "http://fc", "token")
            .unwrap();
        let path = outside.path().join("outside.mp3");
        std::fs::write(&path, b"audio").unwrap();
        let value = track("FCFCFCFCFCFCFC01", "Outside", &path);
        db.upsert_synced_track(&value, &path, source.id).unwrap();
        db.record_sync_track_with_root(
            "FCFCFCFCFCFCFC01",
            source.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        let summary = evict(&mut db, &["FCFCFCFCFCFCFC01".to_string()])
            .await
            .unwrap();
        assert_eq!(summary.evicted, 0);
        assert!(!summary.failures.is_empty());
        assert!(path.is_file());
        assert!(db
            .synced_track_file_record("FCFCFCFCFCFCFC01")
            .unwrap()
            .is_some());

        let inside = dir.path().join("inside.mp3");
        std::fs::write(&inside, b"inside").unwrap();
        let value = track("FCFCFCFCFCFCFC02", "Referenced", &inside);
        let track_id = db
            .upsert_synced_track(&value, &inside, source.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "FCFCFCFCFCFCFC02",
            source.id,
            &serde_json::to_string(&value).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        std::fs::remove_file(&inside).unwrap();
        db.conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (88, '8888888888888888', '競合', 0, 0, 1)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (88, ?1, 0)",
                [track_id],
            )
            .unwrap();
        assert!(!db
            .delete_synced_track_if_eligible("FCFCFCFCFCFCFC02")
            .unwrap());
        assert!(db
            .synced_track_file_record("FCFCFCFCFCFCFC02")
            .unwrap()
            .is_some());
    }

    #[test]
    fn storage_usage_counts_missing_files_as_zero_bytes() {
        let db = Database::open_memory().unwrap();
        let dir = tempdir().unwrap();
        let source = db
            .upsert_sync_source("storage", Some("Storage"), "http://storage", "token")
            .unwrap();
        let present_path = dir.path().join("present.mp3");
        let missing_path = dir.path().join("missing.mp3");
        std::fs::write(&present_path, b"1234567").unwrap();
        let present = track("ABABABABABABAB01", "Present", &present_path);
        let missing = track("ABABABABABABAB02", "Missing", &missing_path);
        let present_id = db
            .upsert_synced_track(&present, &present_path, source.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "ABABABABABABAB01",
            source.id,
            &serde_json::to_string(&present).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        let missing_id = db
            .upsert_synced_track(&missing, &missing_path, source.id)
            .unwrap()
            .unwrap();
        db.record_sync_track_with_root(
            "ABABABABABABAB02",
            source.id,
            &serde_json::to_string(&missing).unwrap(),
            Some(dir.path()),
        )
        .unwrap();
        let selected = playlist("3333333333333333", "Storage selection");
        db.create_or_replace_playlist_with_pid(&selected, &[present_id, missing_id])
            .unwrap();
        db.record_sync_selection_with_root(
            source.id,
            "3333333333333333",
            "Storage selection",
            Some(dir.path()),
        )
        .unwrap();
        let second = playlist("4444444444444444", "Same files twice");
        db.create_or_replace_playlist_with_pid(&second, &[missing_id, present_id])
            .unwrap();
        db.record_sync_selection_with_root(
            source.id,
            "4444444444444444",
            "Same files twice",
            Some(dir.path()),
        )
        .unwrap();

        let usage = storage_usage(&db, source.id).unwrap();
        assert_eq!(usage.selections.len(), 2);
        assert_eq!(usage.selections[0].track_count, 2);
        assert_eq!(usage.selections[0].bytes, 7);
        assert_eq!(usage.selections[0].missing_files, 1);
        assert_eq!(
            usage.total,
            StorageUsageTotal {
                track_count: 2,
                bytes: 7,
                missing_files: 1,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn router_follow_resync_then_evict_preserves_local_and_shared_state() {
        let master_dir = tempdir().unwrap();
        let media_dir = master_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let initial = [
            (1, "AAAAAAAAAAAA0001", "Removed", "removed"),
            (2, "AAAAAAAAAAAA0002", "Kept", "kept"),
            (3, "AAAAAAAAAAAA0003", "Shared removed", "shared"),
            (4, "AAAAAAAAAAAA0004", "Dirty removed", "dirty"),
        ];
        let master = Database::open(master_dir.path()).unwrap();
        for (track_id, pid, name, stem) in initial {
            let path = media_dir.join(format!("{stem}.mp3"));
            std::fs::write(&path, format!("ID3-{stem}-audio")).unwrap();
            let raw = url::Url::from_file_path(&path).unwrap().to_string();
            master
                .conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, persistent_id, name, artist, album, rating, comments,
                         location_raw, location_path, track_type, track_number, file_exists)
                     VALUES (?1, ?2, ?3, 'Artist', 'Album', 20, NULL, ?4, ?5, 'File', ?1, 1)",
                    params![track_id, pid, name, raw, path.to_string_lossy()],
                )
                .unwrap();
        }
        master
            .upsert_analysis(
                "AAAAAAAAAAAA0001",
                &TrackAnalysis {
                    track_id: 1,
                    version: 3,
                    analyzed_at: "2026-07-22T00:00:00Z".to_string(),
                    bpm: Some(120.0),
                    key_camelot: Some("8A".to_string()),
                    key_name: Some("A minor".to_string()),
                    energy: Some(0.5),
                    loudness_lufs: Some(-10.0),
                    replaygain_db: Some(-3.0),
                    vector: vec![0.1, 0.2],
                    peaks: vec![0.2, 0.8],
                },
            )
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (10, '1111222233334444', 'Follow List', 0, 0, 1)",
                [],
            )
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (10, 1, 0), (10, 2, 1), (10, 3, 2), (10, 4, 3)",
                [],
            )
            .unwrap();
        master.set_state("server_id", "phase3-master").unwrap();
        master.set_state("server_name", "Phase 3 Master").unwrap();
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

        let slave_dir = tempdir().unwrap();
        let landing = slave_dir.path().join("landing");
        let slave = Database::open(slave_dir.path()).unwrap();
        let source = slave
            .upsert_sync_source(
                "phase3-master",
                Some("Phase 3 Master"),
                &format!("http://{address}"),
                "test-token",
            )
            .unwrap();
        let provisioned = super::super::provision(
            slave,
            source.clone(),
            vec!["1111222233334444".to_string()],
            landing.clone(),
            |_| {},
        )
        .await
        .unwrap();
        assert!(provisioned.failures.is_empty());

        let slave = Database::open(slave_dir.path()).unwrap();
        slave
            .conn
            .execute(
                "UPDATE sync_selection SET policy='follow'
                 WHERE source_id=?1 AND remote_pid='1111222233334444'",
                [source.id],
            )
            .unwrap();
        slave
            .conn
            .execute(
                "UPDATE tracks SET comments='local note'
                 WHERE persistent_id='AAAAAAAAAAAA0002'",
                [],
            )
            .unwrap();
        slave
            .conn
            .execute(
                "UPDATE tracks SET comments='must survive eviction filtering'
                 WHERE persistent_id='AAAAAAAAAAAA0004'",
                [],
            )
            .unwrap();
        let shared_id: i64 = slave
            .conn
            .query_row(
                "SELECT track_id FROM tracks WHERE persistent_id='AAAAAAAAAAAA0003'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let other = slave
            .upsert_sync_source("other-source", Some("Other"), "http://other", "token")
            .unwrap();
        let other_playlist = playlist("9999000011112222", "Other selection");
        slave
            .create_or_replace_playlist_with_pid(&other_playlist, &[shared_id])
            .unwrap();
        slave
            .record_sync_selection_with_root(
                other.id,
                "9999000011112222",
                "Other selection",
                Some(&landing),
            )
            .unwrap();
        // 一つの selection が失敗しても、先に登録された follow selection は完遂する。
        slave
            .record_sync_selection_baseline_with_root(
                source.id,
                "DEADDEADDEADDEAD",
                "母艦から消えたリスト",
                &[],
                Some(&landing),
            )
            .unwrap();
        slave
            .conn
            .execute(
                "UPDATE sync_selection SET policy='follow'
                 WHERE source_id=?1 AND remote_pid='DEADDEADDEADDEAD'",
                [source.id],
            )
            .unwrap();
        drop(slave);

        let added_path = media_dir.join("added.mp3");
        std::fs::write(&added_path, b"ID3-added-audio").unwrap();
        let master = Database::open(master_dir.path()).unwrap();
        let raw = url::Url::from_file_path(&added_path).unwrap().to_string();
        master
            .conn
            .execute(
                "INSERT INTO tracks
                    (track_id, persistent_id, name, artist, album, rating, location_raw,
                     location_path, track_type, track_number, file_exists)
                 VALUES (5, 'AAAAAAAAAAAA0005', 'Added', 'Artist', 'Album', 20,
                         ?1, ?2, 'File', 5, 1)",
                params![raw, added_path.to_string_lossy()],
            )
            .unwrap();
        master
            .upsert_analysis(
                "AAAAAAAAAAAA0005",
                &TrackAnalysis {
                    track_id: 5,
                    version: 3,
                    analyzed_at: "2026-07-22T00:00:00Z".to_string(),
                    bpm: Some(126.0),
                    key_camelot: Some("9A".to_string()),
                    key_name: Some("E minor".to_string()),
                    energy: Some(0.8),
                    loudness_lufs: Some(-8.0),
                    replaygain_db: Some(-4.0),
                    vector: vec![0.2, 0.4],
                    peaks: vec![0.1, 0.9],
                },
            )
            .unwrap();
        master
            .conn
            .execute(
                "UPDATE tracks SET genre='Master Genre' WHERE track_id=2",
                [],
            )
            .unwrap();
        master
            .conn
            .execute("DELETE FROM playlist_tracks WHERE playlist_id=10", [])
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (10, 2, 0), (10, 5, 1)",
                [],
            )
            .unwrap();
        drop(master);

        let slave = Database::open(slave_dir.path()).unwrap();
        let summary = resync(slave, source.clone(), |_| {}).await.unwrap();
        assert_eq!(summary.selections_synced, 1);
        assert_eq!(summary.tracks_added, 1);
        assert_eq!(summary.tracks_updated, 1);
        assert_eq!(summary.membership_replaced, 1);
        assert_eq!(summary.eviction_candidates, 1);
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(
            summary.failures[0].persistent_id.as_deref(),
            Some("DEADDEADDEADDEAD")
        );
        assert!(summary.mutations_committed);

        let mut slave = Database::open(slave_dir.path()).unwrap();
        let playlist = slave
            .get_playlist_by_persistent_id("1111222233334444")
            .unwrap()
            .unwrap();
        let members = slave
            .get_playlist_tracks(playlist.playlist_id, i64::MAX, 0, None, None)
            .unwrap();
        assert_eq!(
            members
                .iter()
                .filter_map(|track| track.persistent_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["AAAAAAAAAAAA0002", "AAAAAAAAAAAA0005"]
        );
        assert_eq!(members[0].genre.as_deref(), Some("Master Genre"));
        assert_eq!(members[0].comments.as_deref(), Some("local note"));
        assert!(slave.get_analysis(members[1].track_id).unwrap().is_some());
        assert!(members[1]
            .location_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file()));

        let candidates = compute_eviction_candidates(&slave, source.id).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].persistent_id, "AAAAAAAAAAAA0001");
        let removed_track_id: i64 = slave
            .conn
            .query_row(
                "SELECT track_id FROM tracks WHERE persistent_id='AAAAAAAAAAAA0001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(slave.get_analysis(removed_track_id).unwrap().is_some());
        let removed_file = candidates[0].file_path.clone().unwrap();
        let evicted = evict(&mut slave, &["AAAAAAAAAAAA0001".to_string()])
            .await
            .unwrap();
        assert_eq!(evicted.evicted, 1);
        assert_eq!(evicted.files_deleted, 1);
        assert!(evicted.freed_bytes > 0);
        assert!(evicted.failures.is_empty());
        assert!(!Path::new(&removed_file).exists());
        for pid in ["AAAAAAAAAAAA0001"] {
            let counts: (i64, i64, i64) = slave
                .conn
                .query_row(
                    "SELECT
                       (SELECT COUNT(*) FROM tracks WHERE persistent_id=?1),
                       (SELECT COUNT(*) FROM track_analysis WHERE persistent_id=?1),
                       (SELECT COUNT(*) FROM sync_track WHERE persistent_id=?1)",
                    [pid],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(counts, (0, 0, 0));
        }
        for pid in ["AAAAAAAAAAAA0003", "AAAAAAAAAAAA0004"] {
            let exists: bool = slave
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM tracks WHERE persistent_id=?1)",
                    [pid],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "{pid} must be preserved");
        }

        // local-only: base と母艦は同じまま、手元だけ曲順・名前を変えたので保持する。
        let followed = slave
            .get_playlist_by_persistent_id("1111222233334444")
            .unwrap()
            .unwrap();
        let kept_id: i64 = slave
            .conn
            .query_row(
                "SELECT track_id FROM tracks WHERE persistent_id='AAAAAAAAAAAA0002'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        slave
            .conn
            .execute(
                "DELETE FROM playlist_tracks WHERE playlist_id=?1",
                [followed.playlist_id],
            )
            .unwrap();
        slave
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (?1, ?2, 0)",
                params![followed.playlist_id, kept_id],
            )
            .unwrap();
        slave
            .rename_playlist(followed.playlist_id, "手元の名前")
            .unwrap();
        drop(slave);

        let slave = Database::open(slave_dir.path()).unwrap();
        let preserved = resync(slave, source.clone(), |_| {}).await.unwrap();
        assert_eq!(preserved.local_edits_preserved.len(), 1);
        assert_eq!(
            preserved.local_edits_preserved[0].changes,
            vec!["membership", "name"]
        );
        let slave = Database::open(slave_dir.path()).unwrap();
        let followed = slave
            .get_playlist_by_persistent_id("1111222233334444")
            .unwrap()
            .unwrap();
        assert_eq!(followed.name, "手元の名前");
        let members = slave
            .get_playlist_tracks(followed.playlist_id, i64::MAX, 0, None, None)
            .unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(
            members[0].persistent_id.as_deref(),
            Some("AAAAAAAAAAAA0002")
        );
        drop(slave);

        // both-changed: 手元と母艦がともに base から変わったため母艦を適用し警告する。
        let master = Database::open(master_dir.path()).unwrap();
        master.rename_playlist(10, "母艦の名前").unwrap();
        master
            .conn
            .execute("DELETE FROM playlist_tracks WHERE playlist_id=10", [])
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (10, 5, 0)",
                [],
            )
            .unwrap();
        drop(master);

        let slave = Database::open(slave_dir.path()).unwrap();
        let overwritten = resync(slave, source.clone(), |_| {}).await.unwrap();
        assert_eq!(overwritten.membership_overwritten.len(), 1);
        assert_eq!(
            overwritten.membership_overwritten[0].changes,
            vec!["membership", "name"]
        );
        let slave = Database::open(slave_dir.path()).unwrap();
        let followed = slave
            .get_playlist_by_persistent_id("1111222233334444")
            .unwrap()
            .unwrap();
        assert_eq!(followed.name, "母艦の名前");
        let members = slave
            .get_playlist_tracks(followed.playlist_id, i64::MAX, 0, None, None)
            .unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(
            members[0].persistent_id.as_deref(),
            Some("AAAAAAAAAAAA0005")
        );
        server.abort();
    }
}
