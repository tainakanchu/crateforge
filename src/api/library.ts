import { invoke } from "@tauri-apps/api/core";
import type {
  Track,
  ImportResult,
  ExportResult,
  ImportFileResult,
  LibraryStats,
  TrackEdit,
  GenreTagCount,
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
): Promise<Track[]> {
  return invoke("get_tracks", { limit, offset });
}

export async function searchTracks(
  query: string,
  limit?: number,
  offset?: number,
): Promise<Track[]> {
  return invoke("search_tracks", { query, limit, offset });
}

export async function getLibraryStats(): Promise<LibraryStats> {
  return invoke("get_library_stats");
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
