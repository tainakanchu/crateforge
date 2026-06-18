//! `/api` 以下の各エンドポイントのハンドラ。
//!
//! 既存の Tauri コマンド (`commands/*`) と同じ DB メソッドを呼ぶが、
//! 別ブランチ WIP と衝突させないため `commands` 側は一切触らず、
//! 必要なロジック (構造化フィルタ・類似度計算の中核) はここに薄く複製する。
//! 各ハンドラはリクエスト毎に `state.db()` で新しい `Database::open` を行う
//! (rusqlite + WAL なので別コネクションでも安全)。

use axum::extract::{Json as ExtractJson, Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::error::ApiError;
use super::ApiState;
use crate::analyzer::similarity::{rank_similar, SimilarOpts};
use crate::models::{GenreTagCount, LibraryStats, Playlist, SimilarHit, Track, TrackAnalysis};

/// `get_tracks` / `search_tracks` は `limit: i64` を直値で要求する。
/// 「全件取得してから Rust 側で絞り込む」方針なので、実質的に無制限な上限を渡す。
const ALL_ROWS: i64 = i64::MAX;

// ===== 読み取り =====

/// `GET /api/health` — サーバーの素性 + 現在の曲数を返す。
pub async fn health(State(state): State<ApiState>) -> Result<Json<Value>, ApiError> {
    let db = state.db()?;
    let stats = db.library_stats()?;
    Ok(Json(json!({
        "name": "crateforge",
        "version": env!("CARGO_PKG_VERSION"),
        "trackCount": stats.track_count,
    })))
}

/// `GET /api/tracks` のクエリパラメータ (すべて任意, camelCase)。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracksQuery {
    /// フリーテキスト検索 (search_tracks のトークン構文をそのまま使う)。
    pub q: Option<String>,
    /// rating 下限 (0-100 スケール。star4 = 80)。
    pub rating_min: Option<i64>,
    /// rating 上限 (0-100 スケール)。
    pub rating_max: Option<i64>,
    /// genre 部分一致 (小文字化して比較)。
    pub genre: Option<String>,
    /// year 下限。
    pub year_from: Option<i64>,
    /// year 上限。
    pub year_to: Option<i64>,
    /// true なら解析済みのみ、false なら未解析のみ。
    pub analyzed: Option<bool>,
    /// offset/limit は Rust 側でスライスする。
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// 並び替えフィールド / 方向 (DB の sort_field/sort_order に渡す)。
    pub sort: Option<String>,
    pub order: Option<String>,
}

/// `GET /api/tracks` — DB から取得 (q 有無で search/get を切替) → 構造化フィルタ → offset/limit。
pub async fn list_tracks(
    State(state): State<ApiState>,
    Query(q): Query<TracksQuery>,
) -> Result<Json<Vec<Track>>, ApiError> {
    let db = state.db()?;

    // 1. 取得: q があればトークン検索、無ければ全件取得 (どちらも sort/order は DB に委譲)。
    //    構造化フィルタは DB を触らず Rust 側で適用するため、ここでは「全件」を引く。
    let sort = q.sort.as_deref();
    let order = q.order.as_deref();
    let mut tracks = match q.q.as_deref() {
        Some(query) if !query.trim().is_empty() => {
            db.search_tracks(query, ALL_ROWS, 0, sort, order)?
        }
        _ => db.get_tracks(ALL_ROWS, 0, sort, order)?,
    };

    // 2. 構造化フィルタを Rust 側で適用 (指定された条件のみ判定する)。
    // rating: 0-100 スケール。指定された側のみ範囲判定する。
    if let Some(min) = q.rating_min {
        tracks.retain(|t| t.rating.unwrap_or(0) >= min);
    }
    if let Some(max) = q.rating_max {
        tracks.retain(|t| t.rating.unwrap_or(0) <= max);
    }
    // genre: 小文字化して部分一致。
    if let Some(genre) = q.genre.as_deref() {
        let needle = genre.to_lowercase();
        tracks.retain(|t| {
            t.genre
                .as_deref()
                .map(|g| g.to_lowercase().contains(&needle))
                .unwrap_or(false)
        });
    }
    // year: [year_from, year_to]。year が無い曲は範囲指定時に除外する。
    if let Some(from) = q.year_from {
        tracks.retain(|t| t.year.map(|y| y >= from).unwrap_or(false));
    }
    if let Some(to) = q.year_to {
        tracks.retain(|t| t.year.map(|y| y <= to).unwrap_or(false));
    }
    // analyzed: 解析済み track_id 集合との包含で絞り込む。
    if let Some(want_analyzed) = q.analyzed {
        let analyzed_ids: std::collections::HashSet<i64> = db
            .get_all_analysis()?
            .into_iter()
            .map(|a| a.track_id)
            .collect();
        tracks.retain(|t| analyzed_ids.contains(&t.track_id) == want_analyzed);
    }

    // 3. offset/limit を Rust 側でスライス (offset 既定 0、limit 既定なし=全件)。
    let offset = q.offset.unwrap_or(0).max(0) as usize;
    let sliced: Vec<Track> = if offset >= tracks.len() {
        Vec::new()
    } else {
        let rest = &tracks[offset..];
        match q.limit {
            Some(lim) if lim >= 0 => rest.iter().take(lim as usize).cloned().collect(),
            _ => rest.to_vec(),
        }
    };
    Ok(Json(sliced))
}

/// `GET /api/tracks/:trackId` — 1 曲取得。見つからなければ 404。
pub async fn get_track(
    State(state): State<ApiState>,
    Path(track_id): Path<i64>,
) -> Result<Json<Track>, ApiError> {
    let db = state.db()?;
    let found = db.get_tracks_by_ids(&[track_id])?;
    match found.into_iter().next() {
        Some(track) => Ok(Json(track)),
        None => Err(ApiError::not_found("track not found")),
    }
}

/// `POST /api/tracks/by-ids` のボディ。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByIdsBody {
    pub track_ids: Vec<i64>,
}

/// `POST /api/tracks/by-ids` — ID 列を入力順のまま Track へ解決する。
pub async fn tracks_by_ids(
    State(state): State<ApiState>,
    ExtractJson(body): ExtractJson<ByIdsBody>,
) -> Result<Json<Vec<Track>>, ApiError> {
    let db = state.db()?;
    let tracks = db.get_tracks_by_ids(&body.track_ids)?;
    Ok(Json(tracks))
}

/// `GET /api/tracks/:trackId/analysis` — 解析結果 (未解析なら JSON null, 200)。
pub async fn get_track_analysis(
    State(state): State<ApiState>,
    Path(track_id): Path<i64>,
) -> Result<Json<Option<TrackAnalysis>>, ApiError> {
    let db = state.db()?;
    let analysis = db.get_analysis(track_id)?;
    Ok(Json(analysis))
}

/// `GET /api/tracks/:trackId/similar` のクエリ。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarQuery {
    pub limit: Option<usize>,
    /// BPM 許容差 (base BPM に対する割合)。
    pub bpm_tol: Option<f64>,
    /// Camelot 互換キーのみに絞るか。
    pub key_compatible: Option<bool>,
    /// エネルギー許容差 (0..1 の絶対差)。
    pub energy_tol: Option<f64>,
}

/// `GET /api/tracks/:trackId/similar` — `commands::analysis::get_similar` の中核を複製。
/// 基準曲が未解析 (ベクトル空) なら空配列を返す。
pub async fn get_similar_tracks(
    State(state): State<ApiState>,
    Path(track_id): Path<i64>,
    Query(q): Query<SimilarQuery>,
) -> Result<Json<Vec<SimilarHit>>, ApiError> {
    let db = state.db()?;
    // 基準曲が未解析 / ベクトル空なら類似なし。
    let base = match db.get_analysis(track_id)? {
        Some(b) if !b.vector.is_empty() => b,
        _ => return Ok(Json(Vec::new())),
    };
    let all = db.get_all_analysis()?;
    let opts = SimilarOpts {
        bpm_tol: q.bpm_tol,
        key_compatible: q.key_compatible.unwrap_or(false),
        energy_tol: q.energy_tol,
    };
    let ranked = rank_similar(&base, &all, &opts, q.limit.unwrap_or(25));

    let mut hits = Vec::with_capacity(ranked.len());
    for (tid, distance) in ranked {
        if let Ok(Some(track)) = db.get_track_by_track_id(tid) {
            hits.push(SimilarHit { track, distance });
        }
    }
    Ok(Json(hits))
}

/// `GET /api/stats` — ライブラリ統計。
pub async fn get_stats(State(state): State<ApiState>) -> Result<Json<LibraryStats>, ApiError> {
    let db = state.db()?;
    Ok(Json(db.library_stats()?))
}

/// `GET /api/genres` — ジャンルタグの頻度一覧。
pub async fn get_genres(
    State(state): State<ApiState>,
) -> Result<Json<Vec<GenreTagCount>>, ApiError> {
    let db = state.db()?;
    Ok(Json(db.get_all_genre_tags()?))
}

/// `GET /api/playlists` — 全プレイリスト。
pub async fn list_playlists(State(state): State<ApiState>) -> Result<Json<Vec<Playlist>>, ApiError> {
    let db = state.db()?;
    Ok(Json(db.get_playlists()?))
}

/// `GET /api/playlists/:playlistId/tracks` のクエリ。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTracksQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub sort: Option<String>,
    pub order: Option<String>,
}

/// `GET /api/playlists/:playlistId/tracks` — プレイリスト内の曲。
pub async fn playlist_tracks(
    State(state): State<ApiState>,
    Path(playlist_id): Path<i64>,
    Query(q): Query<PlaylistTracksQuery>,
) -> Result<Json<Vec<Track>>, ApiError> {
    let db = state.db()?;
    // get_playlist_tracks の limit/offset は i64 直値。未指定はコマンド層の既定 (500/0) に合わせる。
    let tracks = db.get_playlist_tracks(
        playlist_id,
        q.limit.unwrap_or(500),
        q.offset.unwrap_or(0),
        q.sort.as_deref(),
        q.order.as_deref(),
    )?;
    Ok(Json(tracks))
}

// ===== 書き込み =====

/// `POST /api/playlists` のボディ。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlaylistBody {
    pub name: String,
    pub parent_persistent_id: Option<String>,
    pub is_folder: Option<bool>,
}

/// `POST /api/playlists` — 新規プレイリスト作成 → 201 + Playlist。
pub async fn create_playlist(
    State(state): State<ApiState>,
    ExtractJson(body): ExtractJson<CreatePlaylistBody>,
) -> Result<(StatusCode, Json<Playlist>), ApiError> {
    let db = state.db()?;
    // create_playlist は parent: Option<&str>, is_folder: bool を取る (Option ではない)。
    let playlist = db.create_playlist(
        &body.name,
        body.parent_persistent_id.as_deref(),
        body.is_folder.unwrap_or(false),
    )?;
    // 作成成功を WebView へ通知 (起動中アプリの UI に即時反映させる)。
    state.notify_library_changed(Some(playlist.playlist_id));
    Ok((StatusCode::CREATED, Json(playlist)))
}

/// `POST /api/playlists/:playlistId/tracks` — 曲を追加 → { added: n }。
pub async fn add_tracks(
    State(state): State<ApiState>,
    Path(playlist_id): Path<i64>,
    ExtractJson(body): ExtractJson<ByIdsBody>,
) -> Result<Json<Value>, ApiError> {
    let db = state.db()?;
    let added = db.add_tracks_to_playlist(playlist_id, &body.track_ids)?;
    // 追加成功を WebView へ通知 (起動中アプリの UI に即時反映させる)。
    state.notify_library_changed(Some(playlist_id));
    Ok(Json(json!({ "added": added })))
}

/// `DELETE /api/playlists/:playlistId/tracks/:trackId` — 曲を 1 件外す → 204。
pub async fn remove_track(
    State(state): State<ApiState>,
    Path((playlist_id, track_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let db = state.db()?;
    db.remove_track_from_playlist(playlist_id, track_id)?;
    // 削除成功を WebView へ通知 (起動中アプリの UI に即時反映させる)。
    state.notify_library_changed(Some(playlist_id));
    Ok(StatusCode::NO_CONTENT)
}

// ===== 曲メタデータ書き込み =====

/// 実ファイルのタグへ書き戻す。`location_path` が無い / ファイルが存在しない場合は
/// 何もしない (= 失敗ではない)。書き込みを試みて失敗したときだけ true を返す。
/// 整理 (フォルダ移動) はせず、その場でタグだけ更新する (rekordbox 等 他アプリへ反映)。
fn writeback(loc: Option<&str>, w: &crate::organizer::TagWrite) -> bool {
    let Some(loc) = loc else { return false };
    if loc.is_empty() {
        return false;
    }
    let path = std::path::Path::new(loc);
    if !path.exists() {
        return false;
    }
    crate::organizer::write_tags(path, w).is_err()
}

/// `POST /api/tracks/genre-tags/{add,remove}` のボディ。
/// genre を空白区切りタグ集合として扱い、複数曲に対し 1 つのタグを一括追記/除去する。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreTagBody {
    pub track_ids: Vec<i64>,
    pub tag: String,
}

/// `POST /api/tracks/genre-tags/add` — 指定タグを各曲の genre 末尾に一括追記 (重複回避)。
/// DB 更新後、その曲の genre のみを実ファイルにも書き戻す (他タグは保持)。空タグは 400。
/// 返り値 `{ "updated": n, "fileWriteFailed": m }`。
pub async fn add_genre_tags(
    State(state): State<ApiState>,
    ExtractJson(body): ExtractJson<GenreTagBody>,
) -> Result<Json<Value>, ApiError> {
    let tag = body.tag.trim();
    if tag.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "tag is empty"));
    }
    let db = state.db()?;
    let mut updated = 0_i64;
    let mut file_failed = 0_i64;
    for &id in &body.track_ids {
        // 存在しない id は db 側で 0 行更新 (エラーにならない)。Ok なら計上する。
        if db.add_genre_tag(id, tag).is_ok() {
            updated += 1;
            if let Ok(Some(t)) = db.get_track_by_track_id(id) {
                let w = crate::organizer::TagWrite {
                    genre: t.genre.as_deref(),
                    ..Default::default()
                };
                if writeback(t.location_path.as_deref(), &w) {
                    file_failed += 1;
                }
            }
        }
    }
    if updated > 0 {
        state.notify_library_changed(None);
    }
    Ok(Json(json!({ "updated": updated, "fileWriteFailed": file_failed })))
}

/// `POST /api/tracks/genre-tags/remove` — 指定タグを各曲の genre から一括除去。
/// `add_genre_tags` と対称 (除去後の genre をファイルへ反映、空なら空文字)。空タグは 400。
pub async fn remove_genre_tags(
    State(state): State<ApiState>,
    ExtractJson(body): ExtractJson<GenreTagBody>,
) -> Result<Json<Value>, ApiError> {
    let tag = body.tag.trim();
    if tag.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "tag is empty"));
    }
    let db = state.db()?;
    let mut updated = 0_i64;
    let mut file_failed = 0_i64;
    for &id in &body.track_ids {
        if db.remove_genre_tag(id, tag).is_ok() {
            updated += 1;
            if let Ok(Some(t)) = db.get_track_by_track_id(id) {
                let w = crate::organizer::TagWrite {
                    genre: Some(t.genre.as_deref().unwrap_or("")),
                    ..Default::default()
                };
                if writeback(t.location_path.as_deref(), &w) {
                    file_failed += 1;
                }
            }
        }
    }
    if updated > 0 {
        state.notify_library_changed(None);
    }
    Ok(Json(json!({ "updated": updated, "fileWriteFailed": file_failed })))
}

/// `PATCH /api/tracks/:trackId` — 指定フィールドを置換 (未指定は据え置き)、
/// 更新後の現在値を実ファイルのタグへも書き戻す。対象が存在しなければ 404。
/// 返り値 `{ "track": Track, "fileWriteFailed": bool }`。
pub async fn patch_track(
    State(state): State<ApiState>,
    Path(track_id): Path<i64>,
    ExtractJson(edit): ExtractJson<crate::models::TrackEdit>,
) -> Result<Json<Value>, ApiError> {
    let db = state.db()?;
    db.update_track(track_id, &edit)?;
    // 更新後の Track を取得。存在しない id は 0 行更新なので空 → 404。
    let track: Track = match db.get_tracks_by_ids(&[track_id])?.into_iter().next() {
        Some(t) => t,
        None => return Err(ApiError::not_found("track not found")),
    };
    let track_val = serde_json::to_value(&track)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // 現在の DB 値を実ファイルのタグへ書き戻す (GUI の update_track と同様、他アプリにも反映)。
    let file_failed = {
        let w = crate::organizer::TagWrite {
            title: track.name.as_deref(),
            artist: track.artist.as_deref(),
            album_artist: track.album_artist.as_deref(),
            album: track.album.as_deref(),
            genre: track.genre.as_deref(),
            year: track.year,
            track_number: track.track_number,
            track_count: track.track_count,
            disc_number: track.disc_number,
            disc_count: track.disc_count,
            compilation: Some(track.compilation),
        };
        writeback(track.location_path.as_deref(), &w)
    };
    state.notify_library_changed(None);
    Ok(Json(json!({ "track": track_val, "fileWriteFailed": file_failed })))
}
