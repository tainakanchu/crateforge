//! API ハンドラ共通のエラー型。
//!
//! ハンドラは `Result<T, ApiError>` を返し、エラーは
//! `(status, Json({ "error": msg }))` の形で JSON レスポンスへ変換される。
//! 409 (前提条件の不一致) だけは、取り違えに気付けるよう実際の曲情報 `track` を添える。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// HTTP ステータスコードとメッセージを束ねた API エラー。
/// 3 つ目は応答 JSON に追加するフィールド (`{ "error": msg, ...extra }`)。通常は `None`。
#[derive(Debug)]
pub struct ApiError(
    pub StatusCode,
    pub String,
    pub Option<serde_json::Map<String, serde_json::Value>>,
);

impl ApiError {
    /// 任意のステータスとメッセージでエラーを作る。
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        ApiError(status, msg.into(), None)
    }

    /// 404 (リソースが見つからない) を作るショートカット。
    pub fn not_found(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::NOT_FOUND, msg.into(), None)
    }

    /// 409 (前提条件の不一致) を作る。`extra` のフィールドを応答 JSON に足す
    /// (例: 実際に指していた曲 `track`)。
    pub fn conflict(
        msg: impl Into<String>,
        extra: serde_json::Map<String, serde_json::Value>,
    ) -> Self {
        ApiError(StatusCode::CONFLICT, msg.into(), Some(extra))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let ApiError(status, msg, extra) = self;
        let mut body = extra.unwrap_or_default();
        body.insert("error".to_string(), json!(msg));
        (status, Json(serde_json::Value::Object(body))).into_response()
    }
}

/// 既存コマンド層が返す `String` エラーはすべて 500 として扱う。
impl From<String> for ApiError {
    fn from(msg: String) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg, None)
    }
}

/// 曲の編集 (`library::edit`) のエラー。入力の誤り (不正な Camelot キー・範囲外の rating) は 400、
/// DB 障害は 500。
impl From<crate::library::edit::EditError> for ApiError {
    fn from(e: crate::library::edit::EditError) -> Self {
        use crate::library::edit::EditError;
        let status = match &e {
            EditError::Invalid(_) => StatusCode::BAD_REQUEST,
            EditError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError::new(status, e.to_string())
    }
}

/// プレイリストの曲目編集 (`library::playlists`) のエラー。
/// スマートプレイリストは 409、プレイリスト無しは 404、ライブラリに無い曲は 400、DB 障害は 500。
impl From<crate::library::playlists::PlaylistEditError> for ApiError {
    fn from(e: crate::library::playlists::PlaylistEditError) -> Self {
        use crate::library::playlists::PlaylistEditError;
        let status = match &e {
            PlaylistEditError::Smart => StatusCode::CONFLICT,
            PlaylistEditError::NotFound => StatusCode::NOT_FOUND,
            PlaylistEditError::TrackNotFound(_) => StatusCode::BAD_REQUEST,
            PlaylistEditError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError::new(status, e.to_string())
    }
}

/// rusqlite のエラーも 500 にマップする (DB 障害は内部エラー)。
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string(), None)
    }
}
