import { invoke } from "@tauri-apps/api/core";
import type { Playlist, Track, SortField, SortOrder } from "../types";

export async function getPlaylists(): Promise<Playlist[]> {
  return invoke("get_playlists");
}

export async function getPlaylistTracks(
  playlistId: number,
  limit?: number,
  offset?: number,
  sortField?: SortField,
  sortOrder?: SortOrder,
): Promise<Track[]> {
  return invoke("get_playlist_tracks", {
    playlistId,
    limit,
    offset,
    sortField,
    sortOrder,
  });
}

export async function createPlaylist(
  name: string,
  parentPersistentId?: string | null,
  isFolder?: boolean,
): Promise<Playlist> {
  return invoke("create_playlist", {
    name,
    parentPersistentId: parentPersistentId ?? null,
    isFolder: isFolder ?? false,
  });
}

export async function renamePlaylist(
  playlistId: number,
  name: string,
): Promise<void> {
  return invoke("rename_playlist", { playlistId, name });
}

export async function deletePlaylist(playlistId: number): Promise<void> {
  return invoke("delete_playlist", { playlistId });
}

export async function addTracksToPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<number> {
  return invoke("add_tracks_to_playlist", { playlistId, trackIds });
}

export async function removeTrackFromPlaylist(
  playlistId: number,
  trackId: number,
): Promise<void> {
  return invoke("remove_track_from_playlist", { playlistId, trackId });
}

export async function reorderPlaylistTracks(
  playlistId: number,
  orderedTrackIds: number[],
): Promise<void> {
  return invoke("reorder_playlist_tracks", { playlistId, orderedTrackIds });
}
