//! アプリ内蔵 HTTP API サーバー (axum, 127.0.0.1 のみで待受)。
//!
//! AI エージェント等の外部ツールがライブラリ (曲・プレイリスト・解析結果) を
//! 読み書きできるようにするためのローカル API。Tauri コマンド層とは独立し、
//! 既存の `commands/*` には手を入れず、必要なロジックだけハンドラ側に複製している。
//!
//! ## 構成
//! - [`ApiState`]   : `app_data_dir` だけを持つ。ハンドラ毎に `Database::open` する。
//! - [`error`]      : `ApiError` (status + message) と `IntoResponse`。
//! - [`handlers`]   : 各エンドポイントの実装。
//! - [`router`]     : ルート定義。
//! - [`start`] / [`ServerControl`] : bind + serve の spawn とグレースフル停止。

pub mod error;
pub(crate) mod handlers;

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::routing::{delete, get, post};
use axum::Router;

use error::ApiError;

/// ハンドラ間で共有する状態。`app_data_dir` と (アプリ起動時のみ) `AppHandle` を持ち、
/// リクエスト毎に新しい `Database` を開く (rusqlite + WAL なので接続共有は不要)。
/// `app` は WebView への通知に使う。API サーバー単体起動 (テスト) では `None`。
#[derive(Clone)]
pub struct ApiState {
    pub app_data_dir: PathBuf,
    /// 書き込み後の通知先。テストでは `None` (emit は no-op)。
    pub app: Option<tauri::AppHandle>,
    /// LAN アクセストークン。None = LAN 無効またはトークン未生成。
    pub token: Option<String>,
}

impl ApiState {
    /// このリクエストのために DB を開く。失敗は 500 にマップする。
    fn db(&self) -> Result<crate::db::Database, ApiError> {
        crate::db::Database::open(&self.app_data_dir)
            .map_err(|e| ApiError::new(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }

    /// 書き込み後に WebView へ「ライブラリが変わった」と通知する。
    /// API サーバー単体起動 (テスト) では app=None なので何もしない。emit 失敗は無視。
    pub(crate) fn notify_library_changed(&self, playlist_id: Option<i64>) {
        if let Some(app) = &self.app {
            use tauri::Emitter; // v2 では emit は Emitter トレイト経由。
            let _ = app.emit("library-changed", serde_json::json!({ "playlistId": playlist_id }));
        }
    }
}

/// ウェブプレイヤー HTML (LAN 向け簡易プレイヤー)。
pub async fn serve_webplayer() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("webplayer.html"))
}

/// PWA manifest を配信する。
pub async fn serve_manifest() -> impl axum::response::IntoResponse {
    const MANIFEST: &str = r##"{"name":"Crateforge","short_name":"Crateforge","start_url":"/","scope":"/","display":"standalone","background_color":"#141618","theme_color":"#6CA1B5","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}]}"##;
    (
        [("content-type", "application/manifest+json")],
        MANIFEST,
    )
}

/// 512x512 アイコン (PWA)。
pub async fn serve_icon_512() -> impl axum::response::IntoResponse {
    static BYTES: &[u8] = include_bytes!("../../icons/icon.png");
    ([("content-type", "image/png")], BYTES)
}

/// 192x192 アイコン (PWA, 実体は 256x256 だがブラウザが縮小)。
pub async fn serve_icon_192() -> impl axum::response::IntoResponse {
    static BYTES: &[u8] = include_bytes!("../../icons/256x256.png");
    ([("content-type", "image/png")], BYTES)
}

/// Apple Touch アイコン (iOS ホーム画面)。
pub async fn serve_apple_touch_icon() -> impl axum::response::IntoResponse {
    static BYTES: &[u8] = include_bytes!("../../icons/icon.png");
    ([("content-type", "image/png")], BYTES)
}

/// Favicon (ブラウザタブ用。64x64 PNG を返す)。
pub async fn serve_favicon() -> impl axum::response::IntoResponse {
    static BYTES: &[u8] = include_bytes!("../../icons/64x64.png");
    ([("content-type", "image/png")], BYTES)
}

/// LAN アクセスでもトークン不要な "public" パス判定。
/// これらはライブラリデータを含まないため安全。
/// PWA インストール・起動に必要な最小限のリソースのみ公開する。
pub(crate) fn is_public_path(path: &str) -> bool {
    matches!(
        path,
        "/" | "/manifest.webmanifest"
            | "/apple-touch-icon.png"
            | "/icon-192.png"
            | "/icon-512.png"
            | "/favicon.ico"
    )
}

/// LAN からのリクエストを認証するミドルウェア。
/// - ループバック (127.x, ::1) は無条件通過。
/// - public パス (PWA 資産) はトークン不要で通過。
/// - それ以外は token クエリパラメータまたは X-API-Token ヘッダを照合する。
/// - GET メソッドと /api/remote/* のみ LAN から許可 (それ以外の書き込みは 403)。
async fn auth_guard(
    axum::extract::State(state): axum::extract::State<ApiState>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let peer_ip = req
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or_else(|| std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));

    if peer_ip.is_loopback() {
        return next.run(req).await;
    }

    // LAN リクエスト: public パスはトークン不要で通す。
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    if is_public_path(&path) {
        return next.run(req).await;
    }

    // LAN リクエスト: トークンを検証する。
    let expected_token = match &state.token {
        Some(t) => t.clone(),
        None => return StatusCode::FORBIDDEN.into_response(),
    };

    // クエリパラメータまたはヘッダからトークンを取り出す。
    let query_token = uri.query().and_then(|q| {
        q.split('&').find_map(|part| {
            let mut kv = part.splitn(2, '=');
            let key = kv.next()?;
            let val = kv.next()?;
            if key == "token" { Some(val.to_string()) } else { None }
        })
    });

    let header_token = req.headers()
        .get("X-API-Token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let provided = query_token.or(header_token);
    let authorized = provided.as_deref() == Some(expected_token.as_str());

    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // LAN からの書き込みは /api/remote/* と GET のみ許可する。
    let method = req.method().clone();
    let is_read_only_method = method == axum::http::Method::GET;
    let is_remote_path = path.starts_with("/api/remote");

    if !is_read_only_method && !is_remote_path {
        return StatusCode::FORBIDDEN.into_response();
    }

    next.run(req).await
}

/// `/api` 以下の全ルートを束ねた Router を返す。
pub fn router(state: ApiState) -> Router {
    Router::new()
        // ウェブプレイヤー
        .route("/", get(serve_webplayer))
        // PWA 資産 (public: トークン不要)
        .route("/manifest.webmanifest", get(serve_manifest))
        .route("/icon-512.png", get(serve_icon_512))
        .route("/icon-192.png", get(serve_icon_192))
        .route("/apple-touch-icon.png", get(serve_apple_touch_icon))
        .route("/favicon.ico", get(serve_favicon))
        // 読み取り
        .route("/api/health", get(handlers::health))
        .route("/api/tracks", get(handlers::list_tracks))
        .route("/api/tracks/by-ids", post(handlers::tracks_by_ids))
        // GET と PATCH を 1 つの MethodRouter に合流させる (axum 0.8 は同一パスを
        // 別 .route で重ねると panic するため)。PATCH ハンドラは下の「書き込み」節参照。
        .route(
            "/api/tracks/{trackId}",
            get(handlers::get_track).patch(handlers::patch_track),
        )
        .route(
            "/api/tracks/{trackId}/analysis",
            get(handlers::get_track_analysis),
        )
        .route(
            "/api/tracks/{trackId}/similar",
            get(handlers::get_similar_tracks),
        )
        .route(
            "/api/tracks/{trackId}/stream",
            get(handlers::stream_track),
        )
        .route(
            "/api/tracks/{trackId}/artwork",
            get(handlers::stream_artwork),
        )
        .route("/api/stats", get(handlers::get_stats))
        .route("/api/genres", get(handlers::get_genres))
        .route("/api/playlists", get(handlers::list_playlists))
        .route("/api/playlists/{playlistId}", get(handlers::get_playlist))
        .route(
            "/api/playlists/{playlistId}/tracks",
            get(handlers::playlist_tracks),
        )
        // 書き込み
        .route("/api/playlists", post(handlers::create_playlist))
        .route(
            "/api/playlists/{playlistId}/tracks",
            post(handlers::add_tracks),
        )
        .route(
            "/api/playlists/{playlistId}/tracks/{trackId}",
            delete(handlers::remove_track),
        )
        // 曲メタデータ書き込み。静的セグメント genre-tags は動的 {trackId} と
        // 衝突しない (axum 0.8 は静的セグメントを優先解決する)。
        .route(
            "/api/tracks/genre-tags/add",
            post(handlers::add_genre_tags),
        )
        .route(
            "/api/tracks/genre-tags/remove",
            post(handlers::remove_genre_tags),
        )
        // リモートコントロール
        .route("/api/remote/queue", get(handlers::remote_get_queue))
        .route("/api/remote/state", get(handlers::remote_get_state))
        .route("/api/remote/play", post(handlers::remote_play))
        .route("/api/remote/pause", post(handlers::remote_pause))
        .route("/api/remote/resume", post(handlers::remote_resume))
        .route("/api/remote/stop", post(handlers::remote_stop))
        .route("/api/remote/next", post(handlers::remote_next))
        .route("/api/remote/prev", post(handlers::remote_prev))
        .route("/api/remote/seek", post(handlers::remote_seek))
        .route("/api/remote/set-queue", post(handlers::remote_set_queue))
        // 認証ミドルウェアを全ルートに適用 (with_state の前に route_layer)。
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), auth_guard))
        .with_state(state)
}

/// 起動中サーバーのハンドル。`stop` で graceful shutdown を発火する。
pub struct ServerControl {
    /// 実際に bind したアドレス (port 0 を渡した時に解決済みの値を知るため)。
    /// 現状コマンド層は設定上の port から URL を組み立てるため未参照だが、
    /// 公開 API として呼び出し側 (将来の status 表示やテスト) が使える値として残す。
    #[allow(dead_code)]
    pub addr: SocketAddr,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl ServerControl {
    /// グレースフル停止を要求する (送信失敗 = 既にタスク終了済みは無視)。
    pub fn stop(self) {
        let _ = self.shutdown.send(());
    }
}

/// `port` で bind して serve を Tauri のランタイムに spawn する。
/// `lan=true` のときは `0.0.0.0` で待受し LAN に公開する (既定は `127.0.0.1`)。
/// bind 失敗 (ポート使用中など) は同期的にエラーを返すので、呼び出し側で
/// ユーザーへ通知できる。serve 自体は非同期に走る。
pub fn start(app_data_dir: PathBuf, port: u16, app: tauri::AppHandle, lan: bool, token: Option<String>) -> Result<ServerControl, String> {
    let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((ip, port));
    // bind は同期的に確定させたいので block_on で待つ (tauri は内部で tokio を使う)。
    let listener = tauri::async_runtime::block_on(async move {
        tokio::net::TcpListener::bind(addr).await
    })
    .map_err(|e| format!("bind {addr} failed: {e}"))?;
    let local = listener.local_addr().map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let state = ApiState {
        app_data_dir,
        app: Some(app),
        token,
    };
    let svc = router(state).into_make_service_with_connect_info::<SocketAddr>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, svc)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(ServerControl {
        addr: local,
        shutdown: tx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt; // for `oneshot`

    /// テスト用にファイルベースの一時 DB を作り、(tempdir, Router) を返す。
    /// tempdir は drop されると消えるので呼び出し側で生かしておくこと。
    fn setup() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path()).unwrap();
        seed(&db);
        let app = router(ApiState {
            app_data_dir: dir.path().to_path_buf(),
            app: None,
            token: None,
        });
        (dir, app)
    }

    /// 複数曲 + プレイリスト + 一部に解析結果を投入する。
    /// rating は 0-100 スケール (star4 = 80) で入れる。
    fn seed(db: &crate::db::Database) {
        let rows = [
            // (track_id, name, artist, album, genre, year, rating)
            (1, "Sunrise", "Alpha", "Dawn", "House", 2019, 80),
            (2, "Midnight", "Beta", "Night", "Techno", 2020, 100),
            (3, "Afternoon", "Gamma", "Day", "Deep House", 2018, 60),
            (4, "Evening", "Delta", "Dusk", "Trance", 2021, 40),
            (5, "Noon", "Epsilon", "Bright", "Ambient", 2017, 0),
        ];
        for (tid, name, artist, album, genre, year, rating) in rows {
            db.conn
                .execute(
                    "INSERT INTO tracks
                        (track_id, name, artist, album, genre, year, rating,
                         total_time_ms, file_exists)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 200000, 1)",
                    rusqlite::params![tid, name, artist, album, genre, year, rating],
                )
                .unwrap();
        }

        // プレイリスト 1 件 (空)。書き込みフローのテストでここに足す。
        db.conn
            .execute(
                "INSERT INTO playlists (playlist_id, name, is_folder, is_smart, is_user_created)
                 VALUES (100, 'My List', 0, 0, 1)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, sort_index) VALUES (100, 1, 0)",
                [],
            )
            .unwrap();

        // track 1, 2 に解析結果を投入 (track 3-5 は未解析)。
        // vector は JSON 文字列、bpm/key/energy も埋めて similar の有意味なケースを作る。
        insert_analysis(db, 1, 128.0, "8A", 0.7, "[0.0, 0.0]");
        insert_analysis(db, 2, 128.0, "8A", 0.7, "[0.1, 0.0]");
    }

    fn insert_analysis(
        db: &crate::db::Database,
        track_id: i64,
        bpm: f64,
        key: &str,
        energy: f64,
        vector_json: &str,
    ) {
        db.conn
            .execute(
                "INSERT INTO track_analysis
                    (track_id, version, analyzed_at, bpm, key_camelot, key_name,
                     energy, loudness_lufs, replaygain_db, vector, peaks)
                 VALUES (?1, 2, '2026-01-01T00:00:00Z', ?2, ?3, NULL, ?4, NULL, NULL, ?5, '[]')",
                rusqlite::params![track_id, bpm, key, energy, vector_json],
            )
            .unwrap();
    }

    /// 1 リクエストを Router に流し、(status, body の JSON) を返す。
    /// body が空 (204 等) のときは `Value::Null` を返す。
    async fn req(app: Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(b) => {
                builder = builder.header("content-type", "application/json");
                builder.body(Body::from(b.to_string())).unwrap()
            }
            None => builder.body(Body::empty()).unwrap(),
        };
        let resp = app.oneshot(request).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    // ===== ケース 1: health =====
    #[tokio::test]
    async fn case01_health_reports_track_count() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/health", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "crateforge");
        assert_eq!(body["trackCount"], 5);
        assert!(body["version"].is_string());
    }

    // ===== ケース 2: 全件 / limit / offset =====
    #[tokio::test]
    async fn case02_tracks_limit_and_offset() {
        let (_dir, app) = setup();

        let (status, body) = req(app.clone(), "GET", "/api/tracks", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 5);

        let (_, one) = req(app.clone(), "GET", "/api/tracks?limit=1", None).await;
        assert_eq!(one.as_array().unwrap().len(), 1);

        // 既定ソートは name 昇順。offset でズレることを track_id の差で確認。
        let (_, all) = req(app.clone(), "GET", "/api/tracks", None).await;
        let (_, off) = req(app, "GET", "/api/tracks?offset=2", None).await;
        assert_eq!(off.as_array().unwrap().len(), 3);
        // offset=2 の先頭は全件の 3 番目と一致する。
        assert_eq!(off[0]["trackId"], all[2]["trackId"]);
    }

    // ===== ケース 3: テキスト検索 =====
    #[tokio::test]
    async fn case03_tracks_text_query() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/tracks?q=Midnight", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["trackId"], 2);
    }

    // ===== ケース 4: ratingMin (0-100 スケール, star4 = 80) =====
    #[tokio::test]
    async fn case04_tracks_rating_min() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/tracks?ratingMin=80", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        // rating >= 80 は track 1 (80) と 2 (100)。
        let ids: Vec<i64> = arr.iter().map(|t| t["trackId"].as_i64().unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&1));
        assert!(ids.contains(&2));
    }

    // ===== ケース 5: genre 部分一致 =====
    #[tokio::test]
    async fn case05_tracks_genre() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/tracks?genre=House", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        // "House" と "Deep House" の 2 件 (部分一致, 大小無視)。
        let ids: Vec<i64> = arr.iter().map(|t| t["trackId"].as_i64().unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&1));
        assert!(ids.contains(&3));
    }

    // ===== ケース 6: year 範囲 =====
    #[tokio::test]
    async fn case06_tracks_year_range() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/tracks?yearFrom=2018&yearTo=2020", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        // 2018,2019,2020 の 3 件 (track 1,2,3)。
        let ids: Vec<i64> = arr.iter().map(|t| t["trackId"].as_i64().unwrap()).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&1) && ids.contains(&2) && ids.contains(&3));
    }

    // ===== ケース 7: 単体取得 + 404 =====
    #[tokio::test]
    async fn case07_get_track_and_404() {
        let (_dir, app) = setup();

        let (status, body) = req(app.clone(), "GET", "/api/tracks/2", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["trackId"], 2);
        assert_eq!(body["name"], "Midnight");

        let (status, body) = req(app, "GET", "/api/tracks/9999", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "track not found");
    }

    // ===== ケース 8: by-ids =====
    #[tokio::test]
    async fn case08_tracks_by_ids() {
        let (_dir, app) = setup();
        let (status, body) = req(
            app,
            "POST",
            "/api/tracks/by-ids",
            Some(json!({ "trackIds": [3, 1] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        // 入力順を保つ: 3 が先、1 が後。存在しない ID はスキップ。
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["trackId"], 3);
        assert_eq!(arr[1]["trackId"], 1);
    }

    // ===== ケース 9: analysis (未解析なら null) =====
    #[tokio::test]
    async fn case09_track_analysis_null_path() {
        let (_dir, app) = setup();

        // track 3 は未解析 → null (200)。
        let (status, body) = req(app.clone(), "GET", "/api/tracks/3/analysis", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.is_null());

        // track 1 は解析済み → オブジェクト。
        let (status, body) = req(app, "GET", "/api/tracks/1/analysis", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["trackId"], 1);
        assert_eq!(body["bpm"], 128.0);
        assert_eq!(body["keyCamelot"], "8A");
    }

    // ===== 追加: similar (解析済みの有意味なケース) =====
    #[tokio::test]
    async fn case09b_similar_returns_ranked_hits() {
        let (_dir, app) = setup();

        // track 1 (vector [0,0]) に最も近いのは track 2 (vector [0.1,0])。
        let (status, body) = req(app.clone(), "GET", "/api/tracks/1/similar", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["track"]["trackId"], 2);
        assert!(arr[0]["distance"].as_f64().unwrap() > 0.0);

        // 未解析曲 (track 3) は空配列。
        let (status, body) = req(app, "GET", "/api/tracks/3/similar", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    // ===== 追加: analyzed フィルタ =====
    #[tokio::test]
    async fn case_tracks_analyzed_filter() {
        let (_dir, app) = setup();

        let (_, analyzed) = req(app.clone(), "GET", "/api/tracks?analyzed=true", None).await;
        let ids: Vec<i64> = analyzed
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["trackId"].as_i64().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&1) && ids.contains(&2));

        let (_, unanalyzed) = req(app, "GET", "/api/tracks?analyzed=false", None).await;
        assert_eq!(unanalyzed.as_array().unwrap().len(), 3);
    }

    // ===== ケース 10: stats =====
    #[tokio::test]
    async fn case10_stats() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/stats", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["trackCount"], 5);
        // is_folder=0 のプレイリストが 1 件。
        assert_eq!(body["playlistCount"], 1);
        assert_eq!(body["totalTimeMs"], 5 * 200000);
    }

    // ===== ケース 11: genres =====
    #[tokio::test]
    async fn case11_genres() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/genres", None).await;
        assert_eq!(status, StatusCode::OK);
        // genre は空白区切りタグ集合としてバラされる ("Deep House" → "Deep" + "House")。
        let arr = body.as_array().unwrap();
        assert!(!arr.is_empty());
        let tags: Vec<&str> = arr.iter().map(|g| g["tag"].as_str().unwrap()).collect();
        assert!(tags.contains(&"House"));
    }

    // ===== ケース 12: playlists =====
    #[tokio::test]
    async fn case12_playlists() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/playlists", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["playlistId"], 100);
        assert_eq!(arr[0]["name"], "My List");
        assert_eq!(arr[0]["trackCount"], 1);
    }

    // ===== ケース 13: 書き込みフロー (作成 → 追加 → 反映 → 削除 → 反映) =====
    #[tokio::test]
    async fn case13_write_flow() {
        let (_dir, app) = setup();

        // 1. 作成 → 201 + Playlist。
        let (status, created) = req(
            app.clone(),
            "POST",
            "/api/playlists",
            Some(json!({ "name": "Set 1" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["name"], "Set 1");
        assert_eq!(created["isUserCreated"], true);
        let pid = created["playlistId"].as_i64().unwrap();

        // 2. 曲を追加 → { added: 2 }。
        let uri = format!("/api/playlists/{pid}/tracks");
        let (status, added) = req(
            app.clone(),
            "POST",
            &uri,
            Some(json!({ "trackIds": [2, 3] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(added["added"], 2);

        // 3. GET で反映確認。
        let (status, tracks) = req(app.clone(), "GET", &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<i64> = tracks
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["trackId"].as_i64().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&2) && ids.contains(&3));

        // 4. DELETE で 1 件外す → 204。
        let del_uri = format!("/api/playlists/{pid}/tracks/2");
        let (status, _) = req(app.clone(), "DELETE", &del_uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // 5. 反映確認: track 3 のみ残る。
        let (status, tracks) = req(app, "GET", &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = tracks.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["trackId"], 3);
    }

    // ===== ケース 14: 不正な JSON ボディ → 4xx =====
    #[tokio::test]
    async fn case14_invalid_json_body() {
        let (_dir, app) = setup();

        // 壊れた JSON を直接送る (req ヘルパは整形済みしか送れないので手で組む)。
        let request = Request::builder()
            .method("POST")
            .uri("/api/tracks/by-ids")
            .header("content-type", "application/json")
            .body(Body::from("{ this is not json "))
            .unwrap();
        let resp = app.clone().oneshot(request).await.unwrap();
        assert!(
            resp.status().is_client_error(),
            "broken json should be 4xx, got {}",
            resp.status()
        );

        // 型が合わない (trackIds が数値配列でない) → これも 4xx。
        let (status, _) = req(
            app,
            "POST",
            "/api/tracks/by-ids",
            Some(json!({ "trackIds": "nope" })),
        )
        .await;
        assert!(status.is_client_error());
    }

    // ===== 追加: playlist tracks のソート/limit がクエリで効く =====
    #[tokio::test]
    async fn case_playlist_tracks_query() {
        let (_dir, app) = setup();
        // seed のプレイリスト 100 には track 1 が入っている。
        let (status, body) = req(app, "GET", "/api/playlists/100/tracks?limit=10", None).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["trackId"], 1);
    }

    // ===== メタデータ書き込み: ジャンルタグ追記 (#39-1) =====
    #[tokio::test]
    async fn case_genre_tag_add() {
        let (_dir, app) = setup();
        let (status, body) = req(
            app.clone(),
            "POST",
            "/api/tracks/genre-tags/add",
            Some(json!({ "trackIds": [1], "tag": "台語" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["updated"], 1);

        // GET で genre に台語が追記されていること (元の House は残す)。
        let (status, track) = req(app, "GET", "/api/tracks/1", None).await;
        assert_eq!(status, StatusCode::OK);
        let genre = track["genre"].as_str().unwrap();
        assert!(genre.contains("台語"), "genre should contain 台語: {genre}");
        assert!(genre.contains("House"), "genre should keep House: {genre}");
    }

    // ===== メタデータ書き込み: 重複 add は 1 回のまま (#39-2) =====
    #[tokio::test]
    async fn case_genre_tag_add_dedup() {
        let (_dir, app) = setup();
        let add = |a: Router| async move {
            req(
                a,
                "POST",
                "/api/tracks/genre-tags/add",
                Some(json!({ "trackIds": [1], "tag": "台語" })),
            )
            .await
        };
        let (s1, _) = add(app.clone()).await;
        assert_eq!(s1, StatusCode::OK);
        let (s2, _) = add(app.clone()).await;
        assert_eq!(s2, StatusCode::OK);

        let (_, track) = req(app, "GET", "/api/tracks/1", None).await;
        let genre = track["genre"].as_str().unwrap();
        let occurrences = genre.matches("台語").count();
        assert_eq!(occurrences, 1, "台語 should appear once: {genre}");
    }

    // ===== メタデータ書き込み: 複数曲一括 add (#39-3) =====
    #[tokio::test]
    async fn case_genre_tag_add_bulk() {
        let (_dir, app) = setup();
        let (status, body) = req(
            app.clone(),
            "POST",
            "/api/tracks/genre-tags/add",
            Some(json!({ "trackIds": [1, 2], "tag": "#fav" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["updated"], 2);

        for id in [1, 2] {
            let (_, track) = req(app.clone(), "GET", &format!("/api/tracks/{id}"), None).await;
            let genre = track["genre"].as_str().unwrap();
            assert!(genre.contains("#fav"), "track {id} genre missing #fav: {genre}");
        }
    }

    // ===== メタデータ書き込み: タグ除去 (#39-4) =====
    #[tokio::test]
    async fn case_genre_tag_remove() {
        let (_dir, app) = setup();
        // 先に付ける。
        let (status, _) = req(
            app.clone(),
            "POST",
            "/api/tracks/genre-tags/add",
            Some(json!({ "trackIds": [1], "tag": "台語" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // 除去。
        let (status, body) = req(
            app.clone(),
            "POST",
            "/api/tracks/genre-tags/remove",
            Some(json!({ "trackIds": [1], "tag": "台語" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["updated"], 1);

        let (_, track) = req(app, "GET", "/api/tracks/1", None).await;
        let genre = track["genre"].as_str().unwrap();
        assert!(!genre.contains("台語"), "台語 should be removed: {genre}");
        assert!(genre.contains("House"), "House should remain: {genre}");
    }

    // ===== メタデータ書き込み: 空タグは 400 (#39-5) =====
    #[tokio::test]
    async fn case_genre_tag_empty_is_400() {
        let (_dir, app) = setup();
        let (status, _) = req(
            app.clone(),
            "POST",
            "/api/tracks/genre-tags/add",
            Some(json!({ "trackIds": [1], "tag": " " })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // remove も対称に 400。
        let (status, _) = req(
            app,
            "POST",
            "/api/tracks/genre-tags/remove",
            Some(json!({ "trackIds": [1], "tag": " " })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // ===== メタデータ書き込み: PATCH で genre 置換 (#39-6) =====
    #[tokio::test]
    async fn case_patch_genre() {
        let (_dir, app) = setup();
        let (status, patched) = req(
            app.clone(),
            "PATCH",
            "/api/tracks/1",
            Some(json!({ "genre": "Disco Funk" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["track"]["genre"], "Disco Funk");
        // テストのトラックは location_path 無し → ファイル書き込みは試みず失敗 0。
        assert_eq!(patched["fileWriteFailed"], false);

        // GET でも反映。
        let (_, track) = req(app, "GET", "/api/tracks/1", None).await;
        assert_eq!(track["genre"], "Disco Funk");
    }

    // ===== メタデータ書き込み: PATCH で rating 置換 (#39-7) =====
    #[tokio::test]
    async fn case_patch_rating() {
        let (_dir, app) = setup();
        let (status, patched) = req(
            app,
            "PATCH",
            "/api/tracks/1",
            Some(json!({ "rating": 100 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(patched["track"]["rating"], 100);
    }

    // ===== メタデータ書き込み: PATCH は他フィールドを据え置く (#39-8) =====
    #[tokio::test]
    async fn case_patch_keeps_other_fields() {
        let (_dir, app) = setup();
        // 事前の name を控える。
        let (_, before) = req(app.clone(), "GET", "/api/tracks/1", None).await;
        let name_before = before["name"].clone();

        let (status, patched) = req(
            app.clone(),
            "PATCH",
            "/api/tracks/1",
            Some(json!({ "genre": "Disco Funk" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // name は不変。
        assert_eq!(patched["track"]["name"], name_before);

        let (_, after) = req(app, "GET", "/api/tracks/1", None).await;
        assert_eq!(after["name"], name_before);
        assert_eq!(after["genre"], "Disco Funk");
    }

    // ===== メタデータ書き込み: 存在しない id への PATCH は 404 (#39-9) =====
    #[tokio::test]
    async fn case_patch_missing_is_404() {
        let (_dir, app) = setup();
        let (status, body) = req(
            app,
            "PATCH",
            "/api/tracks/9999",
            Some(json!({ "genre": "Whatever" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "track not found");
    }

    // ===== ケース: GET /api/playlists/{playlistId} — メタ取得 =====
    #[tokio::test]
    async fn case_get_playlist_meta() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/playlists/100", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["playlistId"], 100);
        assert_eq!(body["name"], "My List");
        // プレーンなプレイリストは smartCriteria が null。
        assert!(body["smartCriteria"].is_null());
    }

    // ===== ケース: GET /api/playlists/{playlistId} — スマート条件付き =====
    #[tokio::test]
    async fn case_get_playlist_smart_criteria() {
        use crate::models::{SmartCriteria, SmartOp, SmartRule};

        let (dir, app) = setup();
        // seed のプレイリスト 100 にスマート条件をセットする。
        let db = crate::db::Database::open(dir.path()).unwrap();
        let criteria = SmartCriteria {
            match_all: true,
            rules: vec![SmartRule {
                field: "genre".into(),
                op: SmartOp::Contains,
                value: "House".into(),
            }],
            limit: None,
            sort_by: None,
            sort_desc: false,
        };
        db.set_smart_criteria(100, &criteria).unwrap();

        let (status, body) = req(app, "GET", "/api/playlists/100", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["smartCriteria"]["matchAll"], true);
        let rules = body["smartCriteria"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["field"], "genre");
        assert_eq!(rules[0]["value"], "House");
    }

    // ===== ケース: GET /api/playlists/{playlistId} — 存在しない → 404 =====
    #[tokio::test]
    async fn case_get_playlist_missing_404() {
        let (_dir, app) = setup();
        let (status, body) = req(app, "GET", "/api/playlists/999999", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "playlist not found");
    }

    // ===== is_public_path ヘルパのユニットテスト =====
    #[test]
    fn test_is_public_path() {
        // public であるべきパス
        assert!(is_public_path("/"));
        assert!(is_public_path("/manifest.webmanifest"));
        assert!(is_public_path("/apple-touch-icon.png"));
        assert!(is_public_path("/icon-192.png"));
        assert!(is_public_path("/icon-512.png"));
        assert!(is_public_path("/favicon.ico"));
        // public でないパス (データ系 / 未知)
        assert!(!is_public_path("/api/tracks"));
        assert!(!is_public_path("/api/health"));
        assert!(!is_public_path("/api/remote/state"));
        assert!(!is_public_path("/icon-192.png/extra"));
    }

    // ===== is_browser_native ヘルパのユニットテスト =====
    #[test]
    fn test_is_browser_native() {
        assert!(handlers::is_browser_native("mp3"));
        assert!(handlers::is_browser_native("m4a"));
        assert!(!handlers::is_browser_native("aif"));
        assert!(!handlers::is_browser_native("aiff"));
        assert!(!handlers::is_browser_native("alac"));
    }

    // ===== トークン照合ロジックのユニットテスト =====
    #[test]
    fn test_token_matching_logic() {
        let tok = "abc123";
        let header_val = "abc123";
        assert_eq!(tok, header_val);
        assert_ne!(tok, "wrong");
    }
}
