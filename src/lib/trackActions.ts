// 曲に対する操作 (再生 / キュー追加 / 次に再生 / レーティング / プレイリスト追加) の手順。
//
// ビュー (TracksView / AlbumsView / ArtistsView / TrackTable) ごとに同じ手順を書いていたものを
// まとめる。対象 ID の決め方 (選択・右クリック対象・アルバム全曲) はビュー側に残す。
//
// 手順の関数は失敗をそのまま throw する。失敗の通知は runTrackAction の 1 か所で行う
// (docs/ui-spec.md §4.4「曲操作の失敗」: どのビューでも失敗はトーストで知らせる)。
//
// API は引数で受ける (テストで差し替えるため。実体は lib/trackActionsApi.ts)。

import { errorMessage } from "./errors.ts";

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

// ---- 失敗の通知 ----

/** 曲操作の種類 (失敗トーストの文言を決める)。 */
export type TrackActionKind =
  | "play"
  | "enqueue"
  | "playNext"
  | "rating"
  | "addToPlaylist"
  | "removeFromPlaylist"
  | "addTag"
  | "removeTag"
  | "saveGenre"
  | "analyze"
  | "reveal";

const FAILURE_LABEL: Record<TrackActionKind, string> = {
  play: "再生に失敗しました",
  enqueue: "キューへの追加に失敗しました",
  playNext: "「次に再生」への追加に失敗しました",
  rating: "レーティングを変更できませんでした",
  addToPlaylist: "追加に失敗しました",
  removeFromPlaylist: "削除に失敗しました",
  addTag: "タグの追加に失敗しました",
  removeTag: "タグの削除に失敗しました",
  saveGenre: "ジャンルの保存に失敗しました",
  analyze: "解析を開始できませんでした",
  reveal: "ファイルマネージャで表示できませんでした",
};

/**
 * 失敗トーストの文言 (`<何に失敗したか>: <理由>`)。
 * 再生で曲名が分かるときは、どの曲かを添える。
 */
export function trackActionFailureMessage(
  kind: TrackActionKind,
  error: unknown,
  trackName?: string,
): string {
  const what =
    kind === "play" && trackName ? `『${trackName}』を再生できませんでした` : FAILURE_LABEL[kind];
  return `${what}: ${errorMessage(error)}`;
}

/**
 * 曲操作を実行し、失敗したら notify (エラートースト) で知らせる。throw はしない。
 * 成功したら true、失敗したら false を返す (呼び出し元は後片付けを分けられる)。
 */
export async function runTrackAction(
  notify: (message: string) => void,
  kind: TrackActionKind,
  action: () => Promise<unknown>,
  trackName?: string,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    console.error(`Track action failed (${kind}):`, err);
    notify(trackActionFailureMessage(kind, err, trackName));
    return false;
  }
}
