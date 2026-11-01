export interface PlaylistNodeOut {
  type: "playlist";
  name: string;
  fullPath: string;
  parentPath: string | null;
  trackIds: number[];
}

export interface FolderNodeOut {
  type: "folder";
  name: string;
  fullPath: string;
  parentPath: string | null;
  children: TreeNodeOut[];
}

export type TreeNodeOut = FolderNodeOut | PlaylistNodeOut;

/// Preview の結果。Apply と同じ処理を DB トランザクション内で実行してロールバックした
/// ものなので、件数・メンバーは Apply した場合と一致する。
export interface EvaluationResult {
  tree: FolderNodeOut;
  playlistCount: number;
  folderCount: number;
  referencedTrackCount: number;
  /// Apply した場合に新規作成 / 再利用 / 削除されるノード数 (ルートフォルダを含む)。
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  warnings: string[];
}

export interface ApplyResult {
  generatedPlaylistCount: number;
  generatedFolderCount: number;
  /// 新規作成したノード数 (フォルダ + プレイリスト、ルートフォルダを含む)。
  createdCount: number;
  /// パスが一致して再利用 (ID を保ったまま条件を更新) したノード数。
  updatedCount: number;
  /// 削除したノード数 (prune・種類の入れ替えで消えた子孫も含む)。
  removedCount: number;
  warnings: string[];
}
