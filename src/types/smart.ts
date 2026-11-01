export type SmartOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "exists"
  | "notExists";

/// 1 条件。`field: "playlist"` は「プレイリストに含まれる (is) / 含まれない (isNot)」で、
/// `value` に参照先プレイリストの persistentId を入れる。
export interface SmartRule {
  field: string;
  op: SmartOp;
  value: string;
}

/// 入れ子の条件グループ。自身の rules と子 groups を matchAll で組み合わせる。
export interface SmartGroup {
  matchAll: boolean;
  rules: SmartRule[];
  groups?: SmartGroup[];
}

/// 並び替えの 1 キー (第 2 キー以降)。
export interface SmartSortKey {
  field: string;
  desc: boolean;
}

export interface SmartCriteria {
  matchAll: boolean;
  rules: SmartRule[];
  /// 入れ子の条件グループ (旧データには無い)。
  groups?: SmartGroup[];
  limit: number | null;
  sortBy: string | null;
  sortDesc: boolean;
  /// sortBy で同順位のときに順に使う第 2 キー以降 (Rules の複数キーソート由来。空なら省略される)。
  thenBy?: SmartSortKey[];
}

// ===== iTunes XML からのスマートプレイリスト復元 =====

export type SmartRestoreStatus = "converted" | "skippedExisting" | "failed" | "folderIgnored";

export interface SmartRestoreEntry {
  name: string;
  persistentId: string;
  status: SmartRestoreStatus;
  message: string | null;
  warnings: string[];
}

export interface UnresolvedSmartRef {
  /// 参照を含むプレイリストの名前。
  playlistName: string;
  /// 参照先の PID (条件にはこのまま残る)。
  persistentId: string;
  refName: string | null;
}

export interface SmartRestoreReport {
  converted: number;
  skippedExisting: number;
  failed: number;
  foldersIgnored: number;
  /// XML のスマートプレイリストのうち、同じ PID のプレイリストが無かった数。
  noMatchingPlaylist: number;
  /// XML の Grouping で埋めた曲数。
  groupingBackfilled: number;
  playlists: SmartRestoreEntry[];
  unresolvedRefs: UnresolvedSmartRef[];
}
