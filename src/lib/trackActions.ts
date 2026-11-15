// 曲に対する操作 (再生 / キュー追加 / 次に再生 / レーティング / プレイリスト追加) の手順。
//
// ビュー (TracksView / AlbumsView / ArtistsView / TrackTable) ごとに同じ手順を書いていたものを
// まとめる。対象 ID の決め方 (選択・右クリック対象・アルバム全曲) と、失敗時の通知は
// ビュー側に残す: ここの関数は失敗をそのまま throw する
// (通知方針の一本化は docs/refactor/design.md フェーズ 2 の A3)。
//
// API は引数で受ける (テストで差し替えるため。実体は lib/trackActionsApi.ts)。

export interface PlayApi {
  /** 試聴 (プレビュー) 中なら抜けて通常再生に戻す。 */
  ensureNormalPlay: () => Promise<unknown>;
  setQueue: (trackIds: number[], startIndex: number) => Promise<unknown>;
  playTrack: (trackId: number) => Promise<unknown>;
}

export interface QueueApi {
  enqueueTrack: (trackId: number) => Promise<unknown>;
  enqueueTrackNext: (trackId: number) => Promise<unknown>;
}

export interface RatingApi {
  setTrackRating: (trackId: number, rating: number) => Promise<unknown>;
}

export interface PlaylistApi {
  addTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<number>;
}

interface PlayableTrack {
  trackId: number;
  fileExists: boolean;
}

/** 再生できる (ファイルが存在する) 曲の ID を並び順のまま返す。 */
export function playableIds(tracks: readonly PlayableTrack[]): number[] {
  return tracks.filter((t) => t.fileExists).map((t) => t.trackId);
}

/**
 * ids を再生キューにして startIndex から再生する。
 * playId を渡すとキューの位置とは別にその曲を再生する (一覧でクリックした曲そのものを鳴らす用)。
 */
export async function playQueueFrom(
  api: PlayApi,
  ids: number[],
  startIndex: number,
  playId: number = ids[startIndex],
): Promise<void> {
  await api.ensureNormalPlay();
  await api.setQueue(ids, startIndex);
  await api.playTrack(playId);
}

/**
 * tracks のうち再生できる曲をキューにして、startId の曲 (無ければ先頭) から再生する。
 * 再生できる曲が無ければ何もせず false を返す。
 */
export async function playTracks(
  api: PlayApi,
  tracks: readonly PlayableTrack[],
  startId?: number,
): Promise<boolean> {
  const ids = playableIds(tracks);
  if (ids.length === 0) return false;
  const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
  await playQueueFrom(api, ids, start);
  return true;
}

/** ids をキューの末尾へ順に追加する。 */
export async function enqueueTracks(api: QueueApi, ids: readonly number[]): Promise<void> {
  for (const id of ids) await api.enqueueTrack(id);
}

/**
 * ids を「次に再生」へ入れる (現在曲の直後に、ids の順で並ぶ)。
 *
 * enqueueTrackNext は 1 曲ずつ現在曲の直後へ挿入するので、そのままの順で回すと後の曲ほど
 * 前に来て逆順になる。反転してから入れると最終的な並びが ids の順になる。
 */
export async function playNextTracks(api: QueueApi, ids: readonly number[]): Promise<void> {
  for (const id of [...ids].reverse()) await api.enqueueTrackNext(id);
}

/** ids の全曲に同じ rating (0〜100) を付ける。途中で失敗したらそこで止めて throw する。 */
export async function setRatingForTracks(
  api: RatingApi,
  ids: readonly number[],
  rating: number,
): Promise<void> {
  for (const id of ids) await api.setTrackRating(id, rating);
}

/**
 * ids をプレイリストへ追加し、通知に使う情報 (実際に追加された曲数とプレイリスト名) を返す。
 */
export async function addTracksToPlaylist(
  api: PlaylistApi,
  playlists: readonly { playlistId: number; name: string }[],
  playlistId: number,
  ids: readonly number[],
): Promise<{ added: number; name: string }> {
  const added = await api.addTracksToPlaylist(playlistId, [...ids]);
  const name = playlists.find((p) => p.playlistId === playlistId)?.name ?? "プレイリスト";
  return { added, name };
}

/** プレイリスト追加の成功トーストの文言。 */
export function addedToPlaylistMessage(result: { added: number; name: string }): string {
  return `「${result.name}」に ${result.added} 曲を追加しました`;
}
