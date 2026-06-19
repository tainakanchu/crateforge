import { invoke } from "@tauri-apps/api/core";
import type {
  Track,
  ImportResult,
  ExportResult,
  ImportFileResult,
  LibraryStats,
  TrackEdit,
  GenreTagCount,
  SortField,
  SortOrder,
} from "../types";

export async function importLibrary(xmlPath: string): Promise<ImportResult> {
  return invoke("import_library", { xmlPath });
}

export async function exportLibrary(outputPath: string): Promise<ExportResult> {
  return invoke("export_library", { outputPath });
}

export async function importFiles(paths: string[]): Promise<ImportFileResult> {
  return invoke("import_files", { paths });
}

export async function getTracks(
  limit?: number,
  offset?: number,
  sortField?: SortField,
  sortOrder?: SortOrder,
): Promise<Track[]> {
  return invoke("get_tracks", { limit, offset, sortField, sortOrder });
}

export async function searchTracks(
  query: string,
  limit?: number,
  offset?: number,
  sortField?: SortField,
  sortOrder?: SortOrder,
): Promise<Track[]> {
  return invoke("search_tracks", {
    query,
    limit,
    offset,
    sortField,
    sortOrder,
  });
}

export async function getLibraryStats(): Promise<LibraryStats> {
  return invoke("get_library_stats");
}

/// 指定 ID のトラックを入力順を保って取得（欠損 ID はスキップ）。
export async function getTracksByIds(trackIds: number[]): Promise<Track[]> {
  return invoke("get_tracks_by_ids", { trackIds });
}

export async function updateTrack(trackId: number, edits: TrackEdit): Promise<void> {
  return invoke("update_track", { trackId, edits });
}

export async function setTrackRating(trackId: number, rating: number): Promise<void> {
  return invoke("set_track_rating", { trackId, rating });
}

export async function addGenreTag(trackIds: number[], tag: string): Promise<void> {
  return invoke("add_genre_tag", { trackIds, tag });
}

export async function removeGenreTag(trackIds: number[], tag: string): Promise<void> {
  return invoke("remove_genre_tag", { trackIds, tag });
}

export async function getAllGenreTags(): Promise<GenreTagCount[]> {
  return invoke("get_all_genre_tags");
}

/// 整理先 (ライブラリルート) を取得。未設定なら null。
export async function getLibraryRoot(): Promise<string | null> {
  return invoke("get_library_root");
}

/// 整理先 (ライブラリルート) を設定。空文字で整理を無効化。
export async function setLibraryRoot(path: string): Promise<void> {
  return invoke("set_library_root", { path });
}

/// 既存トラックのパスから整理先を自動推定。推定不可なら null。
export async function detectLibraryRoot(): Promise<string | null> {
  return invoke("detect_library_root");
}

/// 検索・スマートプレイリストの CJK 字体ゆれ吸収レベルを取得。未設定時は "standard"。
export async function getSearchFoldLevel(): Promise<string> {
  return invoke("get_search_fold_level");
}

/// 検索・スマートプレイリストの CJK 字体ゆれ吸収レベルを設定。受理値: off / light / standard。
export async function setSearchFoldLevel(level: string): Promise<void> {
  return invoke("set_search_fold_level", { level });
}

/// base64 画像データ (クリップボード等) を指定トラックのカバーアートに設定。成功件数を返す。
export async function setArtworkFromData(
  trackIds: number[],
  dataBase64: string,
): Promise<number> {
  return invoke("set_artwork_from_data", { trackIds, dataBase64 });
}

/// 画像ファイルを指定トラックのカバーアートに設定。成功件数を返す。
export async function setArtworkFromFile(
  trackIds: number[],
  path: string,
): Promise<number> {
  return invoke("set_artwork_from_file", { trackIds, path });
}
