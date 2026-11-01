//! フロントに返すシリアライズ用構造体。

use serde::Serialize;

/// 階層描画用のツリーノード (フォルダ or プレイリスト)。フロントにそのまま返す。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TreeNodeOut {
    Folder(FolderNodeOut),
    Playlist(PlaylistNodeOut),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNodeOut {
    pub name: String,
    pub full_path: String,
    pub parent_path: Option<String>,
    pub children: Vec<TreeNodeOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistNodeOut {
    pub name: String,
    pub full_path: String,
    pub parent_path: Option<String>,
    /// スマート条件のライブ評価結果 (適用時点のメンバー、条件の並び順)。
    pub track_ids: Vec<i64>,
}

/// Preview コマンドが返す結果。Apply と同じ処理をトランザクション内で実行してロールバック
/// したものなので、件数・メンバーは Apply した場合と一致する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub tree: FolderNodeOut,
    pub playlist_count: usize,
    pub folder_count: usize,
    /// プレイリストが参照しているユニークなトラック数。
    pub referenced_track_count: usize,
    /// Apply した場合に新規作成 / 再利用 / 削除されるノード数 (ルートフォルダを含む)。
    pub created_count: usize,
    pub updated_count: usize,
    pub removed_count: usize,
    pub warnings: Vec<String>,
}

/// Apply コマンドが返す結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub generated_playlist_count: usize,
    pub generated_folder_count: usize,
    /// 新規作成したノード数 (フォルダ + プレイリスト、ルートフォルダを含む)。
    pub created_count: usize,
    /// パスが一致して再利用 (ID を保ったまま条件を更新) したノード数。
    pub updated_count: usize,
    /// 削除したノード数 (prune・種類の入れ替えで消えた子孫も含む)。
    pub removed_count: usize,
    pub warnings: Vec<String>,
}
