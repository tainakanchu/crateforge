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

// 複数曲の操作は 1 回の呼び出しで渡す。全選択 (数万曲) でも IPC は 1 往復で済み、
// レーティングは 1 トランザクションで全部変わるか何も変わらないかになる。
export interface QueueApi {
  /** trackIds をキューの末尾へ、渡した順で追加する。 */
  enqueueTracks: (trackIds: number[]) => Promise<unknown>;
  /** trackIds を現在曲の直後へ、渡した順で並ぶように割り込ませる。 */
  enqueueTracksNext: (trackIds: number[]) => Promise<unknown>;
}

export interface RatingApi {
  /** trackIds の全曲に同じ rating を付ける (1 トランザクション)。 */
  setTracksRating: (trackIds: number[], rating: number) => Promise<unknown>;
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

/** ids をキューの末尾へ順に追加する (1 回の呼び出し)。 */
export async function enqueueTracks(api: QueueApi, ids: readonly number[]): Promise<void> {
  if (ids.length > 0) await api.enqueueTracks([...ids]);
}

/** ids を「次に再生」へ入れる (現在曲の直後に、ids の順で並ぶ。1 回の呼び出し)。 */
export async function playNextTracks(api: QueueApi, ids: readonly number[]): Promise<void> {
  if (ids.length > 0) await api.enqueueTracksNext([...ids]);
}

/**
 * ids の全曲に同じ rating (0〜100) を付ける (1 回の呼び出し・1 トランザクション)。
 * 失敗したらどの曲も変わらない。
 */
export async function setRatingForTracks(
  api: RatingApi,
  ids: readonly number[],
  rating: number,
): Promise<void> {
  if (ids.length > 0) await api.setTracksRating([...ids], rating);
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

/**
 * ジャンルタグの追加・削除で、ファイルのタグへ書き込めなかった曲があるときのトーストの文言。
 * 無ければ null。ライブラリ (DB) は更新済みなので、操作自体の失敗 (runTrackAction) とは別に知らせる。
 */
export function genreFileWriteFailureMessage(result: { fileWriteFailed: number }): string | null {
  if (!(result.fileWriteFailed > 0)) return null;
  return `${result.fileWriteFailed} 曲のファイルにジャンルを書き込めませんでした (ライブラリは更新済みです)`;
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
  | "reveal"
  | "loadTracks"
  | "loadAlbums";

/** 操作ごとの失敗トーストの文言 (理由の前に付く部分)。 */
export const TRACK_ACTION_FAILURE_LABEL: Record<TrackActionKind, string> = {
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
  // 操作の前段 (アルバム / アーティストの曲を取りに行く) で失敗したとき。
  loadTracks: "曲を取得できませんでした",
  loadAlbums: "アルバムを取得できませんでした",
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
    kind === "play" && trackName ? `『${trackName}』を再生できませんでした` : TRACK_ACTION_FAILURE_LABEL[kind];
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

// ---- 複数の取得をまとめて行う操作 (アーティストの全アルバムの曲など) ----

/** `Promise.allSettled` の結果を、成功した項目 (順序を保って連結) と失敗の理由に分ける。 */
export function splitSettled<T>(
  results: readonly PromiseSettledResult<readonly T[]>[],
): { items: T[]; failures: unknown[] } {
  const items: T[] = [];
  const failures: unknown[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
    else failures.push(r.reason);
  }
  return { items, failures };
}

/**
 * アルバムの曲の取得が失敗したときの文言。何枚失敗しても通知は 1 回にまとめ、
 * 理由は最初の 1 件を添える (同じ原因で全部失敗することが多い)。失敗が無ければ null。
 */
export function albumLoadFailureMessage(failures: readonly unknown[]): string | null {
  if (failures.length === 0) return null;
  return `${failures.length} 枚のアルバムの曲を取得できませんでした: ${errorMessage(failures[0])}`;
}
