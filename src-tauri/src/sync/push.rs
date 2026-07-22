//! federation Phase 4: slave 起点の音源 upload と解析 write-back。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use super::{
    lock_mutating_sync, valid_persistent_id, MasterClient, SyncError, SyncFailure, SyncProgress,
};
use crate::db::analysis::ANALYSIS_VERSION;
use crate::db::sync::SyncSource;
use crate::db::Database;
use crate::models::{Track, TrackAnalysis};

const UPLOAD_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushableTrack {
    pub persistent_id: String,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub bytes: u64,
    pub has_analysis: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTracksSummary {
    pub uploaded: usize,
    pub already_existed: usize,
    pub analyses_pushed: usize,
    pub failures: Vec<SyncFailure>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushAnalysesSummary {
    pub pushed: usize,
    pub skipped: usize,
    pub failures: Vec<SyncFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackUploadMetadata<'a> {
    persistent_id: &'a str,
    name: &'a Option<String>,
    artist: &'a Option<String>,
    album_artist: &'a Option<String>,
    album: &'a Option<String>,
    genre: &'a Option<String>,
    year: Option<i64>,
    bpm: Option<i64>,
    comments: &'a Option<String>,
    track_number: Option<i64>,
    track_count: Option<i64>,
    disc_number: Option<i64>,
    disc_count: Option<i64>,
    compilation: bool,
    rating: Option<i64>,
    total_time_ms: Option<i64>,
    file_name: &'a str,
    file_size: u64,
}

#[derive(Debug)]
struct TrackUploadOutcome {
    track: Track,
    already_existed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackUploadReady {
    upload_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisUploadRow {
    persistent_id: String,
    version: i64,
    analyzed_at: String,
    bpm: Option<f64>,
    key_camelot: Option<String>,
    key_name: Option<String>,
    energy: Option<f64>,
    loudness_lufs: Option<f64>,
    replaygain_db: Option<f64>,
    vector: Vec<f64>,
    peaks: Vec<f32>,
}

impl AnalysisUploadRow {
    fn new(persistent_id: String, analysis: TrackAnalysis) -> Self {
        Self {
            persistent_id,
            version: analysis.version,
            analyzed_at: analysis.analyzed_at,
            bpm: analysis.bpm,
            key_camelot: analysis.key_camelot,
            key_name: analysis.key_name,
            energy: analysis.energy,
            loudness_lufs: analysis.loudness_lufs,
            replaygain_db: analysis.replaygain_db,
            vector: analysis.vector,
            peaks: analysis.peaks,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisUploadResult {
    persistent_id: String,
    status: String,
}

impl MasterClient {
    async fn upload_local_track(
        &self,
        track: &Track,
        path: &Path,
    ) -> Result<TrackUploadOutcome, SyncError> {
        let persistent_id = track
            .persistent_id
            .as_deref()
            .filter(|value| valid_persistent_id(value))
            .ok_or_else(|| {
                SyncError::InvalidResponse(
                    "track persistentId must be 16-character uppercase hexadecimal".to_string(),
                )
            })?;
        let metadata =
            std::fs::metadata(path).map_err(|error| SyncError::File(error.to_string()))?;
        if !metadata.is_file() {
            return Err(SyncError::File(
                "local track path is not a file".to_string(),
            ));
        }
        let file_size = metadata.len();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                SyncError::File("local track file name is not valid UTF-8".to_string())
            })?;
        let upload_metadata = TrackUploadMetadata {
            persistent_id,
            name: &track.name,
            artist: &track.artist,
            album_artist: &track.album_artist,
            album: &track.album,
            genre: &track.genre,
            year: track.year,
            bpm: track.bpm,
            comments: &track.comments,
            track_number: track.track_number,
            track_count: track.track_count,
            disc_number: track.disc_number,
            disc_count: track.disc_count,
            compilation: track.compilation,
            rating: track.rating,
            total_time_ms: track.total_time_ms,
            file_name,
            file_size,
        };

        let mut last_network_error = None;
        let upload_id = loop {
            let mut response = None;
            for _ in 0..UPLOAD_ATTEMPTS {
                match self
                    .request(reqwest::Method::POST, "/api/tracks/upload")
                    .timeout(std::time::Duration::from_secs(30))
                    .json(&upload_metadata)
                    .send()
                    .await
                {
                    Ok(value) => {
                        response = Some(value);
                        break;
                    }
                    Err(error) => {
                        last_network_error = Some(SyncError::Unreachable(error.to_string()));
                    }
                }
            }
            let response = response.ok_or_else(|| {
                last_network_error.take().unwrap_or_else(|| {
                    SyncError::Unreachable(
                        "upload metadata failed after three attempts".to_string(),
                    )
                })
            })?;
            if response.status() == reqwest::StatusCode::OK {
                let track = response
                    .json::<Track>()
                    .await
                    .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
                return Ok(TrackUploadOutcome {
                    track,
                    already_existed: true,
                });
            }
            let response = Self::checked(Ok(response)).await?;
            let ready = response
                .json::<TrackUploadReady>()
                .await
                .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
            break ready.upload_id;
        };

        let mut last_network_error = None;
        for _ in 0..UPLOAD_ATTEMPTS {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|error| SyncError::File(error.to_string()))?;
            let audio = reqwest::Body::wrap_stream(ReaderStream::new(file));
            let response = match self
                .request(
                    reqwest::Method::PUT,
                    &format!("/api/tracks/upload/{upload_id}"),
                )
                .header(reqwest::header::CONTENT_LENGTH, file_size)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(audio)
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    last_network_error = Some(SyncError::Unreachable(error.to_string()));
                    continue;
                }
            };
            let status = response.status();
            let already_existed = status == reqwest::StatusCode::OK;
            let response = Self::checked(Ok(response)).await?;
            let track = response
                .json::<Track>()
                .await
                .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
            return Ok(TrackUploadOutcome {
                track,
                already_existed,
            });
        }
        Err(last_network_error.unwrap_or_else(|| {
            SyncError::Unreachable("upload failed after three attempts".to_string())
        }))
    }

    async fn upload_analysis_rows(
        &self,
        rows: &[AnalysisUploadRow],
    ) -> Result<Vec<AnalysisUploadResult>, SyncError> {
        let response = Self::checked(
            self.request(reqwest::Method::POST, "/api/analysis")
                .timeout(std::time::Duration::from_secs(60))
                .json(rows)
                .send()
                .await,
        )
        .await?;
        response
            .json()
            .await
            .map_err(|error| SyncError::InvalidResponse(error.to_string()))
    }
}

fn local_track_path(track: &Track) -> Option<PathBuf> {
    track
        .location_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

/// UI の選択一覧。source の存在は検証するが、ローカル由来判定は全 source 横断で行う。
pub fn list_pushable(db: &Database, source_id: i64) -> Result<Vec<PushableTrack>, SyncError> {
    db.get_sync_source(source_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let tracks = db.list_local_origin_tracks()?;
    let persistent_ids = tracks
        .iter()
        .filter_map(|track| track.persistent_id.clone())
        .collect::<Vec<_>>();
    let current_analysis = db
        .get_analysis_by_persistent_ids(&persistent_ids, false)?
        .into_iter()
        .filter(|(_, analysis)| analysis.version == ANALYSIS_VERSION)
        .map(|(persistent_id, _)| persistent_id)
        .collect::<HashSet<_>>();
    Ok(tracks
        .into_iter()
        .filter_map(|track| {
            let persistent_id = track.persistent_id.clone()?;
            if !valid_persistent_id(&persistent_id) {
                return None;
            }
            let path = local_track_path(&track)?;
            let bytes = std::fs::metadata(path).ok()?.len();
            Some(PushableTrack {
                has_analysis: current_analysis.contains(&persistent_id),
                persistent_id,
                name: track.name,
                artist: track.artist,
                album: track.album,
                bytes,
            })
        })
        .collect())
}

fn failure(track: Option<&Track>, persistent_id: &str, error: impl ToString) -> SyncFailure {
    SyncFailure {
        persistent_id: Some(persistent_id.to_string()),
        track_name: track.and_then(|track| track.name.clone()),
        error: error.to_string(),
    }
}

/// 選択したローカル曲を master へ送り、成功した曲を通常の sync_track に編入する。
pub async fn push_tracks<F>(
    db: Database,
    source: SyncSource,
    persistent_ids: Vec<String>,
    progress: F,
) -> Result<PushTracksSummary, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    let _sync_guard = lock_mutating_sync().await;
    let client = MasterClient::from_source(&source)?;
    let total = persistent_ids.len();
    let mut summary = PushTracksSummary::default();
    let mut seen = HashSet::new();
    progress(SyncProgress {
        phase: "pushing".to_string(),
        current: 0,
        total,
        track_name: None,
    });

    for (index, persistent_id) in persistent_ids.into_iter().enumerate() {
        let requested = [persistent_id.clone()];
        let track = db
            .get_tracks_by_persistent_ids(&requested)?
            .into_iter()
            .next();
        let track_name = track.as_ref().and_then(|track| track.name.clone());
        if !seen.insert(persistent_id.clone()) {
            summary.failures.push(failure(
                track.as_ref(),
                &persistent_id,
                "persistentId is duplicated in this push request",
            ));
        } else if !valid_persistent_id(&persistent_id) {
            summary.failures.push(failure(
                track.as_ref(),
                &persistent_id,
                "persistentId must be 16-character uppercase hexadecimal",
            ));
        } else if let Some(track) = track.as_ref() {
            let owner = db
                .conn
                .query_row(
                    "SELECT source_id FROM sync_track WHERE persistent_id = ?1",
                    [persistent_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if owner.is_some_and(|owner| owner != source.id) {
                summary.failures.push(failure(
                    Some(track),
                    &persistent_id,
                    "track belongs to another sync source",
                ));
            } else if let Some(path) = local_track_path(track) {
                match client.upload_local_track(track, &path).await {
                    Ok(outcome) => {
                        if outcome.already_existed {
                            summary.already_existed += 1;
                        } else {
                            summary.uploaded += 1;
                        }
                        if let Some(analysis) = db.get_analysis(track.track_id)? {
                            if analysis.version == ANALYSIS_VERSION {
                                let rows =
                                    [AnalysisUploadRow::new(persistent_id.clone(), analysis)];
                                match client.upload_analysis_rows(&rows).await {
                                    Ok(results)
                                        if results
                                            .first()
                                            .is_some_and(|result| result.status == "upserted") =>
                                    {
                                        summary.analyses_pushed += 1;
                                    }
                                    Ok(results)
                                        if results
                                            .first()
                                            .is_some_and(|result| result.status == "skipped") => {}
                                    Ok(_) => summary.failures.push(failure(
                                        Some(track),
                                        &persistent_id,
                                        "master rejected analysis",
                                    )),
                                    Err(error) => summary.failures.push(failure(
                                        Some(track),
                                        &persistent_id,
                                        format!("analysis upload failed: {error}"),
                                    )),
                                }
                            }
                        }
                        let base_meta = serde_json::to_string(&outcome.track)
                            .map_err(|error| SyncError::InvalidResponse(error.to_string()))?;
                        db.record_sync_track(&persistent_id, source.id, &base_meta)?;
                    }
                    Err(error) => {
                        summary
                            .failures
                            .push(failure(Some(track), &persistent_id, error))
                    }
                }
            } else {
                summary.failures.push(failure(
                    Some(track),
                    &persistent_id,
                    "local audio file is missing",
                ));
            }
        } else {
            summary
                .failures
                .push(failure(None, &persistent_id, "local track not found"));
        }
        progress(SyncProgress {
            phase: "pushing".to_string(),
            current: index + 1,
            total,
            track_name,
        });
    }
    db.touch_sync_source(source.id)?;
    Ok(summary)
}

/// 編入済み曲について、master が未保持または旧版の現行解析だけをまとめて送る。
pub async fn push_analyses(
    db: Database,
    source: SyncSource,
) -> Result<PushAnalysesSummary, SyncError> {
    let _sync_guard = lock_mutating_sync().await;
    let client = MasterClient::from_source(&source)?;
    let persistent_ids = db.list_sync_track_persistent_ids(source.id)?;
    let local = db
        .get_analysis_by_persistent_ids(&persistent_ids, true)?
        .into_iter()
        .collect::<HashMap<_, _>>();
    let master = client.analyses(&persistent_ids).await?;
    let mut summary = PushAnalysesSummary::default();
    let mut candidates = Vec::new();

    for persistent_id in persistent_ids {
        let Some(analysis) = local.get(&persistent_id) else {
            summary.skipped += 1;
            continue;
        };
        if analysis.version != ANALYSIS_VERSION {
            summary.skipped += 1;
            continue;
        }
        if master
            .get(&persistent_id)
            .is_some_and(|remote| remote.version >= analysis.version)
        {
            summary.skipped += 1;
            continue;
        }
        candidates.push(AnalysisUploadRow::new(persistent_id, analysis.clone()));
    }

    for chunk in candidates.chunks(super::LOOKUP_CHUNK) {
        match client.upload_analysis_rows(chunk).await {
            Ok(results) => {
                for result in results {
                    match result.status.as_str() {
                        "upserted" => summary.pushed += 1,
                        "skipped" => summary.skipped += 1,
                        _ => summary.failures.push(failure(
                            None,
                            &result.persistent_id,
                            "master rejected analysis",
                        )),
                    }
                }
            }
            Err(error) => {
                for row in chunk {
                    summary.failures.push(failure(
                        None,
                        &row.persistent_id,
                        format!("analysis upload failed: {error}"),
                    ));
                }
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{self, ApiState};
    use crate::devices::ValidTokens;
    use crate::pairing::PairingRegistry;

    #[tokio::test(flavor = "current_thread")]
    async fn router_push_enrolls_idempotently_and_repairs_missing_master_analysis() {
        let master_dir = tempfile::tempdir().unwrap();
        let master_library = master_dir.path().join("library");
        let master = Database::open(master_dir.path()).unwrap();
        master
            .set_state("library_root", &master_library.to_string_lossy())
            .unwrap();
        master.set_state("organize_enabled", "1").unwrap();
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
        let local_file = slave_dir.path().join("origin.flac");
        let audio = b"fLaC-local-origin-audio";
        std::fs::write(&local_file, audio).unwrap();
        let slave = Database::open(slave_dir.path()).unwrap();
        let location_path = local_file.to_string_lossy().to_string();
        let location_url = url::Url::from_file_path(&local_file).unwrap().to_string();
        let persistent_id = "DDDDEEEEFFFF0001";
        let track_id = slave
            .add_imported_track_with_persistent_id(
                persistent_id,
                Some("Origin Song"),
                Some("Origin Artist"),
                Some("Origin Album Artist"),
                Some("Origin Album"),
                Some("Techno"),
                Some(2026),
                Some(126),
                Some("from slave"),
                Some(1),
                Some(1),
                Some(1),
                Some(1),
                false,
                Some(100),
                Some(4567),
                &location_path,
                &location_url,
            )
            .unwrap();
        slave
            .upsert_analysis(
                persistent_id,
                &TrackAnalysis {
                    track_id,
                    version: ANALYSIS_VERSION,
                    analyzed_at: "2026-07-22T00:00:00Z".to_string(),
                    bpm: Some(126.5),
                    key_camelot: Some("7A".to_string()),
                    key_name: Some("D minor".to_string()),
                    energy: Some(0.8),
                    loudness_lufs: Some(-8.5),
                    replaygain_db: Some(-5.5),
                    vector: vec![0.1, 0.3],
                    peaks: vec![0.2, 0.9],
                },
            )
            .unwrap();
        let source = slave
            .upsert_sync_source(
                "PHASE4MASTER001",
                Some("Phase 4 Master"),
                &format!("http://{address}"),
                "sync-token",
            )
            .unwrap();

        let pushable = list_pushable(&slave, source.id).unwrap();
        assert_eq!(pushable.len(), 1);
        assert_eq!(pushable[0].persistent_id, persistent_id);
        assert_eq!(pushable[0].bytes, audio.len() as u64);
        assert!(pushable[0].has_analysis);
        drop(slave);

        let first = push_tracks(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            vec![persistent_id.to_string()],
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(first.uploaded, 1);
        assert_eq!(first.already_existed, 0);
        assert_eq!(first.analyses_pushed, 1);
        assert!(first.failures.is_empty());

        let master = Database::open(master_dir.path()).unwrap();
        let rows = master
            .get_tracks_by_persistent_ids(&[persistent_id.to_string()])
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name.as_deref(), Some("Origin Song"));
        let master_file = PathBuf::from(rows[0].location_path.as_ref().unwrap());
        assert!(master_file.starts_with(&master_library));
        assert_eq!(std::fs::read(master_file).unwrap(), audio);
        assert_eq!(
            master.get_analysis(rows[0].track_id).unwrap().unwrap().bpm,
            Some(126.5)
        );
        drop(master);

        let slave = Database::open(slave_dir.path()).unwrap();
        assert_eq!(
            slave.list_sync_track_persistent_ids(source.id).unwrap(),
            vec![persistent_id.to_string()]
        );
        assert!(list_pushable(&slave, source.id).unwrap().is_empty());
        drop(slave);

        let second = push_tracks(
            Database::open(slave_dir.path()).unwrap(),
            source.clone(),
            vec![persistent_id.to_string()],
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(second.uploaded, 0);
        assert_eq!(second.already_existed, 1);
        assert!(second.failures.is_empty());

        let master = Database::open(master_dir.path()).unwrap();
        master
            .conn
            .execute(
                "DELETE FROM track_analysis WHERE persistent_id=?1",
                [persistent_id],
            )
            .unwrap();
        drop(master);
        let repaired = push_analyses(Database::open(slave_dir.path()).unwrap(), source.clone())
            .await
            .unwrap();
        assert_eq!(repaired.pushed, 1);
        assert_eq!(repaired.skipped, 0);
        assert!(repaired.failures.is_empty());
        let master = Database::open(master_dir.path()).unwrap();
        let master_track = master
            .get_tracks_by_persistent_ids(&[persistent_id.to_string()])
            .unwrap()
            .remove(0);
        assert!(master
            .get_analysis(master_track.track_id)
            .unwrap()
            .is_some());

        server.abort();
    }
}
