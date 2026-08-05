//! federation slave 側のペアリング・参照・snapshot provisioning。

pub mod phase3;
pub mod writeback;

pub use phase3::{
    compute_eviction_candidates, evict, resync, storage_usage, EvictionCandidate, EvictionSummary,
    ResyncSummary, StorageUsage,
};

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

use crate::db::sync::{SyncSource, SyncedTrackState};
use crate::db::Database;
use crate::models::{Playlist, Track, TrackAnalysis};
use crate::organizer::{self, Mode, TrackMeta};

const LOOKUP_CHUNK: usize = 200;
const PLAYLIST_PAGE: i64 = 1_000;
const DOWNLOAD_ATTEMPTS: usize = 3;

// SQLite の transaction 境界だけでは HTTP/ファイル操作をまたぐ同期処理同士を防げないため、
// このプロセス内の mutating sync は一本ずつ実行する。
static MUTATING_SYNC_MUTEX: AsyncMutex<()> = AsyncMutex::const_new(());

pub(crate) async fn lock_mutating_sync() -> AsyncMutexGuard<'static, ()> {
    MUTATING_SYNC_MUTEX.lock().await
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("invalid master URL: {0}")]
    InvalidUrl(String),
    #[error("master authentication failed ({0})")]
    Authentication(StatusCode),
    #[error("master is unreachable: {0}")]
    Unreachable(String),
    #[error("master returned {status}: {message}")]
    Http { status: StatusCode, message: String },
    #[error("pairing session expired or was not found")]
    PairingExpired,
    #[error("invalid master response: {0}")]
    InvalidResponse(String),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("file operation failed: {0}")]
    File(String),
    #[error("母艦または手元の状態が変わりました。内容を確認し直してください")]
    StaleWritebackPlan,
    #[error("母艦側でプレイリストが変更されたため置換をスキップしました")]
    PlaylistChangedDuringWriteback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStart {
    pub session_id: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedSource {
    pub source_id: i64,
    pub server_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub name: String,
    pub server_id: String,
    pub version: String,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSizeEstimate {
    pub track_count: usize,
    pub total_bytes: u64,
    pub missing_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub track_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailure {
    pub persistent_id: Option<String>,
    pub track_name: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionSummary {
    pub tracks: usize,
    pub playlists: usize,
    pub bytes: u64,
    pub failures: Vec<SyncFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStartResponse {
    session: String,
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairPollResponse {
    status: String,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisItem {
    persistent_id: String,
    track_id: i64,
    version: i64,
    analyzed_at: String,
    bpm: Option<f64>,
    key_camelot: Option<String>,
    key_name: Option<String>,
    energy: Option<f64>,
    loudness_lufs: Option<f64>,
    replaygain_db: Option<f64>,
    #[serde(default)]
    vector: Vec<f64>,
    #[serde(default)]
    peaks: Vec<f32>,
}

impl AnalysisItem {
    fn into_analysis(self) -> TrackAnalysis {
        TrackAnalysis {
            track_id: self.track_id,
            version: self.version,
            analyzed_at: self.analyzed_at,
            bpm: self.bpm,
            key_camelot: self.key_camelot,
            key_name: self.key_name,
            energy: self.energy,
            loudness_lufs: self.loudness_lufs,
            replaygain_db: self.replaygain_db,
            vector: self.vector,
            peaks: self.peaks,
        }
    }
}

struct PulledPlaylist {
    playlist: Playlist,
    tracks: Vec<Track>,
}

#[derive(Clone)]
pub struct MasterClient {
    client: Client,
    base_url: String,
    token: Option<String>,
}

impl MasterClient {
    pub fn unauthenticated(base_url: &str) -> Result<Self, SyncError> {
        Self::build(base_url, None)
    }

    pub fn from_source(source: &SyncSource) -> Result<Self, SyncError> {
        Self::build(&source.base_url, Some(source.token.clone()))
    }

    fn build(base_url: &str, token: Option<String>) -> Result<Self, SyncError> {
        let parsed =
            reqwest::Url::parse(base_url).map_err(|err| SyncError::InvalidUrl(err.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(SyncError::InvalidUrl(
                "only http and https URLs are supported".to_string(),
            ));
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // Streaming downloads deliberately have no client-wide timeout.
            .build()
            .map_err(|err| SyncError::Unreachable(err.to_string()))?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self.client.request(method, self.url(path));
        match &self.token {
            Some(token) => builder.header("X-API-Token", token),
            None => builder,
        }
    }

    async fn checked(response: Result<Response, reqwest::Error>) -> Result<Response, SyncError> {
        let response = response.map_err(|err| SyncError::Unreachable(err.to_string()))?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(SyncError::Authentication(status));
        }
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(SyncError::Http { status, message });
        }
        Ok(response)
    }

    pub async fn pair_start(&self, device_name: &str) -> Result<PairingStart, SyncError> {
        let response = Self::checked(
            self.request(reqwest::Method::POST, "/api/pair/start")
                .timeout(Duration::from_secs(15))
                .json(&serde_json::json!({
                    "deviceName": device_name,
                    "platform": std::env::consts::OS,
                }))
                .send()
                .await,
        )
        .await?;
        let body: PairStartResponse = response
            .json()
            .await
            .map_err(|err| SyncError::InvalidResponse(err.to_string()))?;
        Ok(PairingStart {
            session_id: body.session,
            code: body.code,
        })
    }

    pub async fn pair_poll(&self, session_id: &str) -> Result<Option<String>, SyncError> {
        let response = self
            .request(reqwest::Method::GET, "/api/pair/poll")
            .timeout(Duration::from_secs(15))
            .query(&[("session", session_id)])
            .send()
            .await
            .map_err(|err| SyncError::Unreachable(err.to_string()))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(SyncError::PairingExpired);
        }
        let response = Self::checked(Ok(response)).await?;
        let body: PairPollResponse = response
            .json()
            .await
            .map_err(|err| SyncError::InvalidResponse(err.to_string()))?;
        match body.status.as_str() {
            "pending" => Ok(None),
            "approved" => body.token.map(Some).ok_or_else(|| {
                SyncError::InvalidResponse("approved pairing omitted token".to_string())
            }),
            other => Err(SyncError::InvalidResponse(format!(
                "unknown pairing status {other}"
            ))),
        }
    }

    pub async fn health(&self) -> Result<Health, SyncError> {
        self.get_json("/api/health").await
    }

    pub async fn playlists(&self) -> Result<Vec<Playlist>, SyncError> {
        self.get_json("/api/playlists").await
    }

    pub async fn playlist_size_estimate(
        &self,
        playlist_id: i64,
    ) -> Result<PlaylistSizeEstimate, SyncError> {
        self.get_json(&format!("/api/playlists/{playlist_id}/size-estimate"))
            .await
    }

    async fn playlist_tracks(&self, playlist_id: i64) -> Result<Vec<Track>, SyncError> {
        let mut tracks = Vec::new();
        loop {
            let path = format!(
                "/api/playlists/{playlist_id}/tracks?limit={PLAYLIST_PAGE}&offset={}",
                tracks.len()
            );
            let page: Vec<Track> = self.get_json(&path).await?;
            let page_len = page.len();
            tracks.extend(page);
            if page_len < PLAYLIST_PAGE as usize {
                return Ok(tracks);
            }
        }
    }

    async fn analyses(
        &self,
        persistent_ids: &[String],
    ) -> Result<HashMap<String, TrackAnalysis>, SyncError> {
        let mut output = HashMap::new();
        for chunk in lookup_chunks(persistent_ids) {
            let response = Self::checked(
                self.request(reqwest::Method::POST, "/api/analysis/lookup")
                    .timeout(Duration::from_secs(30))
                    .json(&serde_json::json!({
                        "persistentIds": chunk,
                        "includePeaks": true,
                    }))
                    .send()
                    .await,
            )
            .await?;
            let rows: Vec<AnalysisItem> = response
                .json()
                .await
                .map_err(|err| SyncError::InvalidResponse(err.to_string()))?;
            for row in rows {
                output.insert(row.persistent_id.clone(), row.into_analysis());
            }
        }
        Ok(output)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, SyncError> {
        let response = Self::checked(
            self.request(reqwest::Method::GET, path)
                .timeout(Duration::from_secs(30))
                .send()
                .await,
        )
        .await?;
        response
            .json()
            .await
            .map_err(|err| SyncError::InvalidResponse(err.to_string()))
    }

    async fn download_track(
        &self,
        track: &Track,
        dest_root: &Path,
    ) -> Result<(PathBuf, u64), SyncError> {
        let persistent_id = required_pid(track)?;
        let hinted_extension = track_extension(track);
        let mut temp_path = hinted_extension
            .as_deref()
            .map(|ext| part_path(dest_root, persistent_id, ext));
        let mut last_error = None;

        for _ in 0..DOWNLOAD_ATTEMPTS {
            let resume_at = temp_path
                .as_deref()
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let mut request = self.request(
                reqwest::Method::GET,
                &format!("/api/tracks/{}/stream?original=true", track.track_id),
            );
            if resume_at > 0 {
                request = request.header(RANGE, format!("bytes={resume_at}-"));
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(err) => {
                    last_error = Some(SyncError::Unreachable(err.to_string()));
                    continue;
                }
            };
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(SyncError::Authentication(status));
            }
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                delete_partial(temp_path.as_deref())?;
                last_error = Some(SyncError::Http {
                    status,
                    message: "partial download range was not satisfiable".to_string(),
                });
                continue;
            }
            if !status.is_success() {
                let retryable = status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS;
                let message = response.text().await.unwrap_or_default();
                let error = SyncError::Http { status, message };
                if retryable {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }

            let extension = hinted_extension.clone().unwrap_or_else(|| {
                extension_for_content_type(
                    response
                        .headers()
                        .get(CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok()),
                )
                .to_string()
            });
            let current_part = temp_path
                .get_or_insert_with(|| part_path(dest_root, persistent_id, &extension))
                .clone();
            let append = resume_at > 0 && status == StatusCode::PARTIAL_CONTENT;
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range);
            if status == StatusCode::PARTIAL_CONTENT
                && content_range.as_ref().and_then(|range| range.start) != Some(resume_at)
            {
                delete_partial(Some(&current_part))?;
                last_error = Some(SyncError::InvalidResponse(format!(
                    "Content-Range start does not match partial file size ({resume_at})"
                )));
                continue;
            }
            let content_length = response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            let expected_size = content_range
                .as_ref()
                .and_then(|range| range.total)
                .or_else(|| {
                    content_length.map(|length| if append { resume_at + length } else { length })
                });
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&current_part)
                .map_err(|err| SyncError::File(err.to_string()))?;
            let mut response = response;
            let mut body_failed = None;
            loop {
                match response.chunk().await {
                    Ok(Some(bytes)) => {
                        if let Err(err) = file.write_all(&bytes) {
                            return Err(SyncError::File(err.to_string()));
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        body_failed = Some(SyncError::Unreachable(err.to_string()));
                        break;
                    }
                }
            }
            if let Some(error) = body_failed {
                last_error = Some(error);
                continue;
            }
            file.flush()
                .map_err(|err| SyncError::File(err.to_string()))?;
            let bytes = std::fs::metadata(&current_part)
                .map_err(|err| SyncError::File(err.to_string()))?
                .len();
            if expected_size.is_some_and(|expected| expected != bytes) {
                drop(file);
                delete_partial(Some(&current_part))?;
                last_error = Some(SyncError::InvalidResponse(format!(
                    "downloaded file size mismatch (expected {}, got {bytes})",
                    expected_size.unwrap()
                )));
                continue;
            }
            let target = organizer::target_path(dest_root, &track_meta(track), &current_part);
            let landed =
                organizer::relocate(&current_part, &target, Mode::Move).map_err(SyncError::File)?;
            return Ok((landed, bytes));
        }

        Err(last_error.unwrap_or_else(|| {
            SyncError::Unreachable("download failed after three attempts".to_string())
        }))
    }
}

pub async fn pair_with_master(
    base_url: &str,
    device_name: &str,
) -> Result<PairingStart, SyncError> {
    MasterClient::unauthenticated(base_url)?
        .pair_start(device_name)
        .await
}

pub async fn poll_pairing(
    db: Database,
    base_url: &str,
    session_id: &str,
) -> Result<Option<PairedSource>, SyncError> {
    let public_client = MasterClient::unauthenticated(base_url)?;
    let Some(token) = public_client.pair_poll(session_id).await? else {
        return Ok(None);
    };
    let authenticated = MasterClient::build(base_url, Some(token.clone()))?;
    let health = authenticated.health().await?;
    let source = db.upsert_sync_source(
        &health.server_id,
        Some(&health.name),
        base_url.trim_end_matches('/'),
        &token,
    )?;
    Ok(Some(PairedSource {
        source_id: source.id,
        server_id: health.server_id,
        name: health.name,
    }))
}

pub async fn list_remote_playlists(source: &SyncSource) -> Result<Vec<Playlist>, SyncError> {
    MasterClient::from_source(source)?.playlists().await
}

pub async fn playlist_size_estimate(
    source: &SyncSource,
    playlist_id: i64,
) -> Result<PlaylistSizeEstimate, SyncError> {
    MasterClient::from_source(source)?
        .playlist_size_estimate(playlist_id)
        .await
}

pub async fn provision<F>(
    db: Database,
    source: SyncSource,
    remote_pids: Vec<String>,
    dest_root: PathBuf,
    progress: F,
) -> Result<ProvisionSummary, SyncError>
where
    F: Fn(SyncProgress) + Send + Sync,
{
    let _sync_guard = lock_mutating_sync().await;
    std::fs::create_dir_all(&dest_root).map_err(|err| SyncError::File(err.to_string()))?;
    let client = MasterClient::from_source(&source)?;
    let remote = client.playlists().await?;
    let mut summary = ProvisionSummary::default();
    let mut wanted = HashSet::new();
    for pid in &remote_pids {
        if valid_persistent_id(pid) {
            wanted.insert(pid.clone());
        } else {
            summary.failures.push(SyncFailure {
                persistent_id: Some(pid.clone()),
                track_name: None,
                error: "プレイリストの persistentId が不正です".to_string(),
            });
        }
    }
    let selected: Vec<Playlist> = remote
        .into_iter()
        .filter(|playlist| {
            playlist
                .persistent_id
                .as_deref()
                .is_some_and(|pid| wanted.contains(pid))
        })
        .collect();
    let found: HashSet<&str> = selected
        .iter()
        .filter_map(|playlist| playlist.persistent_id.as_deref())
        .collect();
    for missing in wanted.iter().filter(|pid| !found.contains(pid.as_str())) {
        summary.failures.push(SyncFailure {
            persistent_id: Some(missing.clone()),
            track_name: None,
            error: "remote playlist not found".to_string(),
        });
    }

    progress(SyncProgress {
        phase: "fetchingPlaylists".to_string(),
        current: 0,
        total: selected.len(),
        track_name: None,
    });
    let selected_total = selected.len();
    let mut pulled = Vec::with_capacity(selected_total);
    for (index, playlist) in selected.into_iter().enumerate() {
        let tracks = client.playlist_tracks(playlist.playlist_id).await?;
        pulled.push(PulledPlaylist { playlist, tracks });
        progress(SyncProgress {
            phase: "fetchingPlaylists".to_string(),
            current: index + 1,
            total: selected_total,
            track_name: None,
        });
    }

    let mut unique_pids = Vec::new();
    let mut unique_tracks = Vec::new();
    let mut seen = HashSet::new();
    for track in pulled.iter().flat_map(|playlist| &playlist.tracks) {
        match required_pid(track) {
            Ok(pid) => {
                if seen.insert(pid.to_string()) {
                    unique_pids.push(pid.to_string());
                    unique_tracks.push(track);
                }
            }
            Err(error) => {
                summary.failures.push(SyncFailure {
                    persistent_id: track.persistent_id.clone(),
                    track_name: track.name.clone(),
                    error: error.to_string(),
                });
            }
        }
    }
    progress(SyncProgress {
        phase: "fetchingAnalysis".to_string(),
        current: 0,
        total: unique_pids.len(),
        track_name: None,
    });
    let mut analyses = client.analyses(&unique_pids).await?;
    progress(SyncProgress {
        phase: "fetchingAnalysis".to_string(),
        current: unique_pids.len(),
        total: unique_pids.len(),
        track_name: None,
    });

    let mut local_ids = HashMap::new();
    let mut processed = 0usize;
    for track in unique_tracks {
        let pid = required_pid(track)?;
        progress(SyncProgress {
            phase: "downloading".to_string(),
            current: processed,
            total: unique_pids.len(),
            track_name: track.name.clone(),
        });
        let existing_path = match db.synced_track_state(pid, source.id)? {
            SyncedTrackState::Missing => None,
            SyncedTrackState::Owned(path) => path.map(PathBuf::from).filter(|path| path.is_file()),
            SyncedTrackState::Collision => {
                summary.failures.push(SyncFailure {
                    persistent_id: Some(pid.to_string()),
                    track_name: track.name.clone(),
                    error: "別のサーバー由来の曲と persistent_id が衝突しています".to_string(),
                });
                processed += 1;
                continue;
            }
        };
        let (landed, downloaded_bytes, downloaded) = match existing_path {
            Some(path) => (path, 0, false),
            None => match client.download_track(track, &dest_root).await {
                Ok((path, bytes)) => (path, bytes, true),
                Err(error @ SyncError::Authentication(_)) => return Err(error),
                Err(error) => {
                    summary.failures.push(SyncFailure {
                        persistent_id: Some(pid.to_string()),
                        track_name: track.name.clone(),
                        error: error.to_string(),
                    });
                    processed += 1;
                    continue;
                }
            },
        };

        match db.upsert_synced_track(track, &landed, source.id) {
            Ok(Some(track_id)) => {
                if let Some(analysis) = analyses.remove(pid) {
                    db.upsert_analysis(pid, &analysis)?;
                }
                let base_meta = serde_json::to_string(track)
                    .map_err(|err| SyncError::InvalidResponse(err.to_string()))?;
                db.record_sync_track_with_root(
                    pid,
                    source.id,
                    &base_meta,
                    downloaded.then_some(dest_root.as_path()),
                )?;
                local_ids.insert(pid.to_string(), track_id);
                summary.tracks += 1;
                summary.bytes += downloaded_bytes;
            }
            Ok(None) => summary.failures.push(SyncFailure {
                persistent_id: Some(pid.to_string()),
                track_name: track.name.clone(),
                error: "別のサーバー由来の曲と persistent_id が衝突しています".to_string(),
            }),
            Err(error) => summary.failures.push(SyncFailure {
                persistent_id: Some(pid.to_string()),
                track_name: track.name.clone(),
                error: error.to_string(),
            }),
        }
        processed += 1;
        progress(SyncProgress {
            phase: "downloading".to_string(),
            current: processed,
            total: unique_pids.len(),
            track_name: track.name.clone(),
        });
    }

    progress(SyncProgress {
        phase: "playlists".to_string(),
        current: 0,
        total: pulled.len(),
        track_name: None,
    });
    for (index, item) in pulled.iter().enumerate() {
        let mut membership = Vec::with_capacity(item.tracks.len());
        let mut failed_members = 0usize;
        for track in &item.tracks {
            match required_pid(track)
                .ok()
                .and_then(|pid| local_ids.get(pid).copied())
            {
                Some(track_id) => membership.push(track_id),
                None => failed_members += 1,
            }
        }
        if failed_members > 0 {
            summary.failures.push(SyncFailure {
                persistent_id: item.playlist.persistent_id.clone(),
                track_name: Some(item.playlist.name.clone()),
                error: format!(
                    "未取得の曲があるためプレイリストを更新しませんでした ({failed_members}件失敗)"
                ),
            });
            progress(SyncProgress {
                phase: "playlists".to_string(),
                current: index + 1,
                total: pulled.len(),
                track_name: None,
            });
            continue;
        }
        db.create_or_replace_playlist_with_pid(&item.playlist, &membership)?;
        let base_membership = item
            .tracks
            .iter()
            .map(required_pid)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        db.record_sync_selection_baseline_with_root(
            source.id,
            required_playlist_pid(&item.playlist)?,
            &item.playlist.name,
            &base_membership,
            Some(&dest_root),
        )?;
        summary.playlists += 1;
        progress(SyncProgress {
            phase: "playlists".to_string(),
            current: index + 1,
            total: pulled.len(),
            track_name: None,
        });
    }
    db.touch_sync_source(source.id)?;
    progress(SyncProgress {
        phase: "complete".to_string(),
        current: summary.tracks,
        total: unique_pids.len(),
        track_name: None,
    });
    Ok(summary)
}

fn required_pid(track: &Track) -> Result<&str, SyncError> {
    track
        .persistent_id
        .as_deref()
        .filter(|pid| valid_persistent_id(pid))
        .ok_or_else(|| {
            SyncError::InvalidResponse(
                "track persistentId must be 16-character uppercase hexadecimal".to_string(),
            )
        })
}

fn lookup_chunks(persistent_ids: &[String]) -> std::slice::Chunks<'_, String> {
    persistent_ids.chunks(LOOKUP_CHUNK)
}

fn required_playlist_pid(playlist: &Playlist) -> Result<&str, SyncError> {
    playlist
        .persistent_id
        .as_deref()
        .filter(|pid| valid_persistent_id(pid))
        .ok_or_else(|| {
            SyncError::InvalidResponse(
                "playlist persistentId must be 16-character uppercase hexadecimal".to_string(),
            )
        })
}

fn valid_persistent_id(persistent_id: &str) -> bool {
    persistent_id.len() == 16
        && persistent_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn track_meta(track: &Track) -> TrackMeta<'_> {
    TrackMeta {
        title: track.name.as_deref(),
        artist: track.artist.as_deref(),
        album_artist: track.album_artist.as_deref(),
        album: track.album.as_deref(),
        compilation: track.compilation,
        track_number: track.track_number,
        disc_number: track.disc_number,
        disc_count: track.disc_count,
    }
}

fn track_extension(track: &Track) -> Option<String> {
    for value in [
        track.location_path.as_deref(),
        track.location_raw.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let path = url::Url::parse(value)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .unwrap_or_else(|| PathBuf::from(value));
        if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
            let extension = extension.trim_start_matches('.');
            if !extension.is_empty()
                && extension.len() <= 10
                && extension.chars().all(|char| char.is_ascii_alphanumeric())
            {
                return Some(extension.to_ascii_lowercase());
            }
        }
    }
    None
}

fn extension_for_content_type(content_type: Option<&str>) -> &'static str {
    match content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
    {
        "audio/mpeg" => "mp3",
        "audio/mp4" | "audio/aac" | "audio/x-m4a" => "m4a",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        _ => "audio",
    }
}

fn part_path(root: &Path, persistent_id: &str, extension: &str) -> PathBuf {
    root.join(format!(".{persistent_id}.part.{extension}"))
}

#[derive(Debug)]
struct ParsedContentRange {
    start: Option<u64>,
    total: Option<u64>,
}

fn parse_content_range(value: &str) -> Option<ParsedContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    if range == "*" {
        return Some(ParsedContentRange { start: None, total });
    }
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    Some(ParsedContentRange {
        start: Some(start),
        total,
    })
}

fn delete_partial(path: Option<&Path>) -> Result<(), SyncError> {
    let Some(path) = path else {
        return Ok(());
    };
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SyncError::File(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{self, ApiState};
    use crate::devices::ValidTokens;
    use crate::pairing::PairingRegistry;
    use axum::body::Body;
    use axum::http::{HeaderMap, Response as HttpResponse};
    use axum::routing::get;
    use axum::Router;
    use rusqlite::params;
    use std::sync::{Arc, Mutex};

    fn remote_track(pid: &str, name: &str) -> Track {
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
            rating: None,
            play_count: None,
            skip_count: None,
            total_time_ms: None,
            date_added: None,
            date_modified: None,
            bpm: None,
            comments: None,
            location_raw: Some("file:///master/song.mp3".to_string()),
            location_path: Some("/master/song.mp3".to_string()),
            track_type: Some("File".to_string()),
            disabled: false,
            compilation: false,
            disc_number: None,
            disc_count: None,
            track_number: Some(1),
            track_count: None,
            file_exists: true,
            last_played: None,
        }
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn persistent_id_validation_requires_uppercase_hex() {
        assert!(valid_persistent_id("0123456789ABCDEF"));
        assert!(!valid_persistent_id("0123456789abcdef"));
        assert!(!valid_persistent_id("0123456789ABCDE"));
        assert!(!valid_persistent_id("0123456789ABCDEG"));
        assert!(!valid_persistent_id("../../0123456789AB"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resume_offset_mismatch_deletes_partial_and_restarts() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler_requests = requests.clone();
        let app = Router::new().route(
            "/api/tracks/{track_id}/stream",
            get(move |headers: HeaderMap| {
                let requests = handler_requests.clone();
                async move {
                    let range = headers
                        .get(RANGE)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    let mut requests = requests.lock().unwrap();
                    requests.push(range);
                    if requests.len() == 1 {
                        HttpResponse::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(CONTENT_RANGE, "bytes 2-5/6")
                            .body(Body::from("xxxx"))
                            .unwrap()
                    } else {
                        HttpResponse::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, "6")
                            .header(CONTENT_TYPE, "audio/mpeg")
                            .body(Body::from("abcdef"))
                            .unwrap()
                    }
                }
            }),
        );
        let (base_url, server) = serve(app).await;
        let destination = tempfile::tempdir().unwrap();
        let pid = "0123456789ABCDEF";
        let partial = part_path(destination.path(), pid, "mp3");
        std::fs::write(&partial, b"part").unwrap();

        let client = MasterClient::build(&base_url, Some("token".to_string())).unwrap();
        let (landed, bytes) = client
            .download_track(&remote_track(pid, "Song"), destination.path())
            .await
            .unwrap();

        assert_eq!(std::fs::read(landed).unwrap(), b"abcdef");
        assert_eq!(bytes, 6);
        assert!(!partial.exists());
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            &[Some("bytes=4-".to_string()), None]
        );
        server.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn downloaded_size_mismatch_fails_after_retries_and_deletes_partial() {
        let request_count = Arc::new(Mutex::new(0usize));
        let handler_count = request_count.clone();
        let app = Router::new().route(
            "/api/tracks/{track_id}/stream",
            get(move || {
                let request_count = handler_count.clone();
                async move {
                    *request_count.lock().unwrap() += 1;
                    HttpResponse::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(CONTENT_RANGE, "bytes 0-4/10")
                        .header(CONTENT_LENGTH, "5")
                        .header(CONTENT_TYPE, "audio/mpeg")
                        .body(Body::from("short"))
                        .unwrap()
                }
            }),
        );
        let (base_url, server) = serve(app).await;
        let destination = tempfile::tempdir().unwrap();
        let pid = "FEDCBA9876543210";
        let partial = part_path(destination.path(), pid, "mp3");
        let client = MasterClient::build(&base_url, Some("token".to_string())).unwrap();

        let error = client
            .download_track(&remote_track(pid, "Short"), destination.path())
            .await
            .unwrap_err();

        assert!(error.to_string().contains("downloaded file size mismatch"));
        assert_eq!(*request_count.lock().unwrap(), DOWNLOAD_ATTEMPTS);
        assert!(!partial.exists());
        server.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn provision_from_existing_router_is_idempotent() {
        let master_dir = tempfile::tempdir().unwrap();
        let media_dir = master_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let one = media_dir.join("one.mp3");
        let two = media_dir.join("two.mp3");
        std::fs::write(&one, b"ID3-master-audio-one").unwrap();
        std::fs::write(&two, b"ID3-master-audio-two-longer").unwrap();

        let master = Database::open(master_dir.path()).unwrap();
        for (track_id, pid, name, number, path) in [
            (1, "AAAABBBBCCCC0001", "One", 1, &one),
            (2, "AAAABBBBCCCC0002", "Two", 2, &two),
        ] {
            let raw = url::Url::from_file_path(path).unwrap().to_string();
            master
                .conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, persistent_id, name, artist, album, rating, play_count,
                         location_raw, location_path, track_type, track_number, file_exists)
                     VALUES (?1, ?2, ?3, 'Artist', 'Album', 80, 5, ?4, ?5, 'File', ?6, 1)",
                    params![track_id, pid, name, raw, path.to_string_lossy(), number],
                )
                .unwrap();
            master
                .upsert_analysis(
                    pid,
                    &TrackAnalysis {
                        track_id,
                        version: 2,
                        analyzed_at: "2026-07-22T00:00:00Z".to_string(),
                        bpm: Some(128.0),
                        key_camelot: Some("8A".to_string()),
                        key_name: Some("A minor".to_string()),
                        energy: Some(0.75),
                        loudness_lufs: Some(-9.0),
                        replaygain_db: Some(-5.0),
                        vector: vec![0.1, 0.2],
                        peaks: vec![0.25, 0.75],
                    },
                )
                .unwrap();
        }
        master
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, parent_persistent_id, name, is_folder, is_smart,
                     is_user_created)
                 VALUES (10, '111122223333AAAA', 'FFFFEEEEDDDDCCCC', 'Master List', 0, 0, 1)",
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
        master.set_state("server_id", "MASTERSERVER0001").unwrap();
        master.set_state("server_name", "Test Master").unwrap();
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
                "MASTERSERVER0001",
                Some("Test Master"),
                &format!("http://{address}"),
                "test-token",
            )
            .unwrap();
        let summary = provision(
            slave,
            source,
            vec!["111122223333AAAA".to_string()],
            destination.clone(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(summary.tracks, 2);
        assert_eq!(summary.playlists, 1);
        assert_eq!(summary.failures.len(), 0);
        assert!(summary.bytes > 0);
        assert!(destination.join("Artist/Album/01 One.mp3").is_file());
        assert!(destination.join("Artist/Album/02 Two.mp3").is_file());

        let slave = Database::open(slave_dir.path()).unwrap();
        let tracks = slave
            .get_tracks_by_persistent_ids(&[
                "AAAABBBBCCCC0001".to_string(),
                "AAAABBBBCCCC0002".to_string(),
            ])
            .unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].rating, Some(80));
        assert_eq!(tracks[0].play_count, Some(5));
        assert!(slave.get_analysis(tracks[0].track_id).unwrap().is_some());
        let playlist = slave
            .get_playlists()
            .unwrap()
            .into_iter()
            .find(|playlist| playlist.persistent_id.as_deref() == Some("111122223333AAAA"))
            .unwrap();
        assert_eq!(playlist.parent_persistent_id, None);
        assert_eq!(
            slave.get_playlist_track_ids(playlist.playlist_id).unwrap(),
            tracks
                .iter()
                .map(|track| track.track_id)
                .collect::<Vec<_>>()
        );
        let base_meta_count: i64 = slave
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sync_track WHERE base_meta IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(base_meta_count, 2);

        let source = slave.get_sync_source(1).unwrap().unwrap();
        let second = provision(
            slave,
            source,
            vec!["111122223333AAAA".to_string()],
            destination.clone(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(second.tracks, 2);
        assert_eq!(second.bytes, 0);
        assert!(second.failures.is_empty());
        let slave = Database::open(slave_dir.path()).unwrap();
        let track_count: i64 = slave
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(track_count, 2);
        assert!(!destination.join("Artist/Album/01 One (2).mp3").exists());
        server.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn partial_or_invalid_member_preserves_existing_playlist_and_reports_failure() {
        let master_dir = tempfile::tempdir().unwrap();
        let media_dir = master_dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let good = media_dir.join("good.mp3");
        let missing = media_dir.join("missing.mp3");
        std::fs::write(&good, b"ID3-good-audio").unwrap();

        let master = Database::open(master_dir.path()).unwrap();
        for (track_id, pid, name, path) in [
            (1, "AAAABBBBCCCC0001", "Good", &good),
            (2, "AAAABBBBCCCC0002", "Missing", &missing),
            (3, "bad/../persistent", "Invalid", &good),
        ] {
            let raw = url::Url::from_file_path(path).unwrap().to_string();
            master
                .conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, persistent_id, name, artist, album, location_raw, location_path,
                         track_type, track_number, file_exists)
                     VALUES (?1, ?2, ?3, 'Artist', 'Album', ?4, ?5, 'File', ?1, 1)",
                    params![track_id, pid, name, raw, path.to_string_lossy()],
                )
                .unwrap();
        }
        master
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (10, 'ABCDABCDABCDABCD', 'Remote Snapshot', 0, 0, 1)",
                [],
            )
            .unwrap();
        master
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (10, 1, 0), (10, 2, 1), (10, 3, 2)",
                [],
            )
            .unwrap();
        master.set_state("server_id", "server-partial").unwrap();
        master.set_state("server_name", "Partial Master").unwrap();
        drop(master);

        let app = api::router(ApiState {
            app_data_dir: master_dir.path().to_path_buf(),
            app: None,
            tokens: ValidTokens::default(),
            pairings: PairingRegistry::default(),
        });
        let (base_url, server) = serve(app).await;

        let slave_dir = tempfile::tempdir().unwrap();
        let destination = slave_dir.path().join("library");
        let slave = Database::open(slave_dir.path()).unwrap();
        slave
            .conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name)
                 VALUES (50, '0000000000000050', 'Existing Member')",
                [],
            )
            .unwrap();
        slave
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (20, 'ABCDABCDABCDABCD', 'Existing Snapshot', 0, 0, 0)",
                [],
            )
            .unwrap();
        slave
            .conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index)
                 VALUES (20, 50, 0)",
                [],
            )
            .unwrap();
        let source = slave
            .upsert_sync_source(
                "server-partial",
                Some("Partial Master"),
                &base_url,
                "test-token",
            )
            .unwrap();

        let summary = provision(
            slave,
            source,
            vec!["ABCDABCDABCDABCD".to_string()],
            destination,
            |_| {},
        )
        .await
        .unwrap();

        assert_eq!(summary.tracks, 1);
        assert_eq!(summary.playlists, 0);
        assert!(summary.failures.iter().any(|failure| {
            failure.persistent_id.as_deref() == Some("bad/../persistent")
                && failure.error.contains("persistentId")
        }));
        assert!(summary.failures.iter().any(|failure| {
            failure.track_name.as_deref() == Some("Remote Snapshot")
                && failure.error == "未取得の曲があるためプレイリストを更新しませんでした (2件失敗)"
        }));

        let slave = Database::open(slave_dir.path()).unwrap();
        let (name, parent): (String, Option<String>) = slave
            .conn
            .query_row(
                "SELECT name, parent_persistent_id FROM playlists WHERE playlist_id=20",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Existing Snapshot");
        assert_eq!(parent, None);
        assert_eq!(slave.get_playlist_track_ids(20).unwrap(), vec![50]);
        server.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_and_cross_source_collisions_are_skipped_and_reported() {
        let master_dir = tempfile::tempdir().unwrap();
        let master = Database::open(master_dir.path()).unwrap();
        for (track_id, pid, name) in [
            (1, "0000000000000001", "Remote Local Collision"),
            (2, "0000000000000002", "Remote Source Collision"),
        ] {
            master
                .conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, persistent_id, name, location_raw, location_path, track_type,
                         file_exists)
                     VALUES (?1, ?2, ?3, 'file:///master/song.mp3', '/master/song.mp3', 'File', 1)",
                    params![track_id, pid, name],
                )
                .unwrap();
        }
        master
            .conn
            .execute(
                "INSERT INTO playlists
                    (playlist_id, persistent_id, name, is_folder, is_smart, is_user_created)
                 VALUES (10, 'CCCCDDDDEEEEFFFF', 'Collision List', 0, 0, 1)",
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
        master.set_state("server_id", "server-current").unwrap();
        master.set_state("server_name", "Current Master").unwrap();
        drop(master);

        let app = api::router(ApiState {
            app_data_dir: master_dir.path().to_path_buf(),
            app: None,
            tokens: ValidTokens::default(),
            pairings: PairingRegistry::default(),
        });
        let (base_url, server) = serve(app).await;

        let slave_dir = tempfile::tempdir().unwrap();
        let destination = slave_dir.path().join("library");
        let slave = Database::open(slave_dir.path()).unwrap();
        let other_source = slave
            .upsert_sync_source("server-other", Some("Other"), "http://other", "other-token")
            .unwrap();
        let source = slave
            .upsert_sync_source(
                "server-current",
                Some("Current Master"),
                &base_url,
                "test-token",
            )
            .unwrap();
        slave
            .conn
            .execute(
                "INSERT INTO tracks (track_id, persistent_id, name, location_path)
                 VALUES (1, '0000000000000001', 'Local Original', '/local/original.mp3'),
                        (2, '0000000000000002', 'Other Original', '/other/original.mp3')",
                [],
            )
            .unwrap();
        slave
            .record_sync_track("0000000000000002", other_source.id, "{}")
            .unwrap();

        let summary = provision(
            slave,
            source,
            vec!["CCCCDDDDEEEEFFFF".to_string()],
            destination.clone(),
            |_| {},
        )
        .await
        .unwrap();

        assert_eq!(summary.tracks, 0);
        assert_eq!(summary.playlists, 0);
        assert_eq!(
            summary
                .failures
                .iter()
                .filter(|failure| {
                    failure.error == "別のサーバー由来の曲と persistent_id が衝突しています"
                })
                .count(),
            2
        );
        assert!(!destination.exists() || std::fs::read_dir(&destination).unwrap().next().is_none());

        let slave = Database::open(slave_dir.path()).unwrap();
        let names = slave
            .get_tracks_by_persistent_ids(&[
                "0000000000000001".to_string(),
                "0000000000000002".to_string(),
            ])
            .unwrap()
            .into_iter()
            .map(|track| track.name.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Local Original", "Other Original"]);
        server.abort();
    }

    #[test]
    fn pairing_and_content_type_shapes_parse() {
        let start: PairStartResponse =
            serde_json::from_str(r#"{"session":"abc","code":"ABC234"}"#).unwrap();
        assert_eq!(start.session, "abc");
        assert_eq!(start.code, "ABC234");
        let poll: PairPollResponse =
            serde_json::from_str(r#"{"status":"approved","token":"secret"}"#).unwrap();
        assert_eq!(poll.status, "approved");
        assert_eq!(poll.token.as_deref(), Some("secret"));
        assert_eq!(
            serde_json::to_value(PairedSource {
                source_id: 7,
                server_id: "server-id".to_string(),
                name: "Server".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "sourceId": 7,
                "serverId": "server-id",
                "name": "Server",
            })
        );
        assert_eq!(extension_for_content_type(Some("audio/flac")), "flac");
        assert_eq!(
            extension_for_content_type(Some("audio/mpeg; charset=binary")),
            "mp3"
        );

        let ids = (0..401).map(|index| index.to_string()).collect::<Vec<_>>();
        let sizes = lookup_chunks(&ids)
            .map(|chunk| chunk.len())
            .collect::<Vec<_>>();
        assert_eq!(sizes, vec![200, 200, 1]);
    }
}
