//! federation Phase 3: follow 再同期、eviction、容量表示。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::writeback::{
    classify_field, field_value, has_local_changes, track_json, FieldDiff, WRITEBACK_FIELDS,
};
use super::{required_pid, MasterClient, SyncError, SyncFailure, SyncProgress, SyncedTrackState};
use crate::db::sync::{SyncSelectionRecord, SyncSource};
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
    pub failures: Vec<SyncFailure>,
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

/// follow 選択を母艦の曲順へ追従させる。母艦への書き込みは一切行わない。
pub async fn resync<F>(
    db: Database,
    source: SyncSource,
    progress: F,
) -> Result<ResyncSummary, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    let client = MasterClient::from_source(&source)?;
    let selections = db.list_sync_selection_records(source.id)?;
    let remote = client
        .playlists()
        .await?
        .into_iter()
        .filter_map(|playlist| playlist.persistent_id.clone().map(|pid| (pid, playlist)))
        .collect::<HashMap<_, _>>();
    let mut summary = ResyncSummary::default();
    let mut added = HashSet::new();
    let mut updated = HashSet::new();
    let mut refreshed = HashSet::new();

    progress(SyncProgress {
        phase: "resyncing".to_string(),
        current: 0,
        total: selections.len(),
        track_name: None,
    });

    for (index, selection) in selections.iter().enumerate() {
        if selection.policy != "follow" {
            summary.selections_skipped += 1;
            progress(SyncProgress {
                phase: "resyncing".to_string(),
                current: index + 1,
                total: selections.len(),
                track_name: Some(selection.name.clone()),
            });
            continue;
        }
        let Some(master_playlist) = remote.get(&selection.remote_pid) else {
            summary.failures.push(selection_failure(
                selection,
                "母艦側にプレイリストがありません",
            ));
            progress(SyncProgress {
                phase: "resyncing".to_string(),
                current: index + 1,
                total: selections.len(),
                track_name: Some(selection.name.clone()),
            });
            continue;
        };
        let master_tracks = match client.playlist_tracks(master_playlist.playlist_id).await {
            Ok(tracks) => tracks,
            Err(error @ SyncError::Authentication(_)) => return Err(error),
            Err(error) => {
                summary.failures.push(selection_failure(selection, error));
                continue;
            }
        };
        let master_pids = master_tracks
            .iter()
            .filter_map(|track| required_pid(track).ok().map(str::to_string))
            .collect::<Vec<_>>();
        if master_pids.len() != master_tracks.len() {
            summary.failures.push(selection_failure(
                selection,
                "persistentId が不正な曲があるためプレイリストを更新しませんでした",
            ));
            continue;
        }
        let local_playlist = db.get_playlist_by_persistent_id(&selection.remote_pid)?;
        let local_tracks = match &local_playlist {
            Some(playlist) => {
                db.get_playlist_tracks(playlist.playlist_id, i64::MAX, 0, None, None)?
            }
            None => Vec::new(),
        };
        let local_pids = local_tracks
            .iter()
            .filter_map(|track| track.persistent_id.clone())
            .collect::<Vec<_>>();
        let local_pid_set = local_pids.iter().cloned().collect::<HashSet<_>>();
        let new_tracks = master_tracks
            .iter()
            .filter(|track| {
                track
                    .persistent_id
                    .as_ref()
                    .is_some_and(|pid| !local_pid_set.contains(pid))
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

        // 同じ曲が複数選択にあっても三者比較は一度だけ行う。
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
            if pulls.len() > skipped.len() {
                updated.insert(pid.to_string());
            }
        }

        let membership = db.synced_track_ids(&master_pids)?;
        if selection_failed || membership.iter().any(Option::is_none) {
            summary.failures.push(selection_failure(
                selection,
                "未取得の曲があるためプレイリストを更新しませんでした",
            ));
            continue;
        }
        let membership = membership.into_iter().flatten().collect::<Vec<_>>();
        if local_pids != master_pids {
            db.create_or_replace_playlist_with_pid(master_playlist, &membership)?;
            summary.membership_replaced += 1;
        } else if local_playlist
            .as_ref()
            .is_some_and(|playlist| playlist.name != master_playlist.name)
        {
            db.create_or_replace_playlist_with_pid(master_playlist, &membership)?;
        }
        db.record_sync_selection_with_root(
            source.id,
            &selection.remote_pid,
            &master_playlist.name,
            landing_root.as_deref(),
        )?;
        summary.selections_synced += 1;
        progress(SyncProgress {
            phase: "resyncing".to_string(),
            current: index + 1,
            total: selections.len(),
            track_name: Some(master_playlist.name.clone()),
        });
    }

    summary.tracks_added = added.len();
    summary.tracks_updated = updated.len();
    summary.eviction_candidates = compute_eviction_candidates(&db, source.id)?.len();
    db.touch_sync_source(source.id)?;
    progress(SyncProgress {
        phase: "resyncing".to_string(),
        current: selections.len(),
        total: selections.len(),
        track_name: None,
    });
    Ok(summary)
}

/// 同期所有・全選択から未参照・ローカル差分なし、の三条件を満たす曲だけを返す。
pub fn compute_eviction_candidates(
    db: &Database,
    source_id: i64,
) -> Result<Vec<EvictionCandidate>, SyncError> {
    let mut candidates = Vec::new();
    for row in db.unreferenced_synced_track_snapshots(source_id)? {
        // 壊れた基準値は安全側に倒し、dirty と同様に eviction 対象外にする。
        if has_local_changes(&row.base_meta, &row.local).unwrap_or(true) {
            continue;
        }
        let bytes = row
            .local
            .location_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        candidates.push(EvictionCandidate {
            persistent_id: row.persistent_id,
            name: row.local.name,
            artist: row.local.artist,
            file_path: row.local.location_path,
            bytes,
            dirty: false,
        });
    }
    Ok(candidates)
}

fn path_is_within_landing_root(path: &Path, root: &Path) -> Result<bool, std::io::Error> {
    let path = path.canonicalize()?;
    let root = root.canonicalize()?;
    Ok(path.starts_with(&root) && path != root)
}

/// 現在も candidate の曲だけを削除する。ファイル失敗は DB rollback の理由にしない。
pub fn evict(db: &Database, persistent_ids: &[String]) -> Result<EvictionSummary, SyncError> {
    let mut allowed = HashSet::new();
    for source in db.list_sync_sources()? {
        allowed.extend(
            compute_eviction_candidates(db, source.id)?
                .into_iter()
                .map(|candidate| candidate.persistent_id),
        );
    }
    let mut summary = EvictionSummary::default();
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
        let file = record.location_path.as_deref().map(PathBuf::from);
        let root = record.landing_root.as_deref().map(PathBuf::from);
        let file_exists = file.as_deref().is_some_and(Path::exists);
        let safe_file = match (file.as_deref(), root.as_deref(), file_exists) {
            (_, _, false) => None,
            (Some(file), Some(root), true) => match path_is_within_landing_root(file, root) {
                Ok(true) => Some(file.to_path_buf()),
                Ok(false) => {
                    summary.failures.push(failure(
                        Some(record.persistent_id.clone()),
                        None,
                        "記録されたファイルが同期の着地ルート外にあるため削除しませんでした",
                    ));
                    None
                }
                Err(error) => {
                    summary.failures.push(failure(
                        Some(record.persistent_id.clone()),
                        None,
                        format!("ファイル境界を確認できません: {error}"),
                    ));
                    None
                }
            },
            (Some(_), None, true) => {
                summary.failures.push(failure(
                    Some(record.persistent_id.clone()),
                    None,
                    "同期の着地ルートが記録されていないためファイルを削除しませんでした",
                ));
                None
            }
            _ => None,
        };
        if !db.delete_synced_track(persistent_id)? {
            summary.failures.push(failure(
                Some(persistent_id.clone()),
                None,
                "同期所有の曲が見つかりません",
            ));
            continue;
        }
        summary.evicted += 1;
        if let Some(file) = safe_file {
            match std::fs::remove_file(&file) {
                Ok(()) => summary.files_deleted += 1,
                Err(error) => summary.failures.push(failure(
                    Some(persistent_id.clone()),
                    None,
                    format!("ファイルを削除できませんでした: {error}"),
                )),
            }
        }
    }
    Ok(summary)
}

pub fn storage_usage(db: &Database, source_id: i64) -> Result<StorageUsage, SyncError> {
    let mut usage = StorageUsage::default();
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
            match track
                .location_path
                .as_deref()
                .and_then(|path| std::fs::metadata(path).ok())
                .filter(|metadata| metadata.is_file())
            {
                Some(metadata) => row.bytes += metadata.len(),
                None => row.missing_files += 1,
            }
        }
        usage.total.track_count += row.track_count;
        usage.total.bytes += row.bytes;
        usage.total.missing_files += row.missing_files;
        usage.selections.push(row);
    }
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

        let usage = storage_usage(&db, source.id).unwrap();
        assert_eq!(usage.selections.len(), 1);
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
        assert!(summary.failures.is_empty());

        let slave = Database::open(slave_dir.path()).unwrap();
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
        let evicted = evict(&slave, &["AAAAAAAAAAAA0001".to_string()]).unwrap();
        assert_eq!(evicted.evicted, 1);
        assert_eq!(evicted.files_deleted, 1);
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
        server.abort();
    }
}
