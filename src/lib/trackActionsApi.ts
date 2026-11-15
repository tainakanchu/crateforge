import * as playbackApi from "../api/playback";
import * as libraryApi from "../api/library";
import * as playlistsApi from "../api/playlists";
import * as audition from "./audition";
import type { PlayApi, PlaylistApi, QueueApi, RatingApi } from "./trackActions";

/** lib/trackActions.ts の関数へ渡す実 API (Tauri コマンド)。 */
export const trackApi: PlayApi & QueueApi & RatingApi & PlaylistApi = {
  ensureNormalPlay: audition.ensureNormalPlay,
  setQueue: playbackApi.setQueue,
  playTrack: playbackApi.playTrack,
  enqueueTrack: playbackApi.enqueueTrack,
  enqueueTrackNext: playbackApi.enqueueTrackNext,
  setTrackRating: libraryApi.setTrackRating,
  addTracksToPlaylist: playlistsApi.addTracksToPlaylist,
};
