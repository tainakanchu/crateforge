// オフラインダウンロード管理ストア（zustand）。
// expo-file-system の新 API（File/Directory/Paths）で document/downloads/ 配下に音源を保存し、
// index.json にメタ（DownloadEntry）を永続化する。曲は track.trackId で扱う（CRITICAL id rule）。
//
// 設計メモ:
// - ファイル名は `${trackId}.${ext}`。ext は original は track のロケーションから推定、
//   それ以外（圧縮DL）はサーバが ADTS AAC を返すので aac。
// - fs 操作はすべて try/catch で握りつぶし、エラーは downloading マップ解除のみ行う（UI を壊さない）。
//   ただしダウンロード失敗は原因切り分けのため console.warn でログだけは残す。
// - 新規エントリ/プレイリストには接続中サーバーの serverId を記録する（Android Auto の
//   ネイティブカタログが libraryScope に使う。旧データは serverId 無し＝legacy 扱い）。
// - index.json / playlists.json を書き出した後は persist リスナーへ通知する。core は
//   ネイティブモジュールを import しないので、同期の配線はアプリ側が setDownloadsPersistListener で行う。

import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";

import type { ApiClient } from "../lib/api/client";
import type { DownloadedPlaylist, DownloadEntry, DownloadQuality, Track } from "../lib/types";
import { useConnection } from "./connection";
import { useSettings } from "./settings";

/** ダウンロード保存先ディレクトリ（document/downloads）。 */
function downloadsDir(): Directory {
  return new Directory(Paths.document, "downloads");
}

/** 保存先ディレクトリを保証する（無ければ作る）。 */
function ensureDir(): Directory {
  const dir = downloadsDir();
  try {
    if (!dir.exists) dir.create();
  } catch {
    // 既存/権限などは無視（後続の fs 操作側で再度ハンドリング）。
  }
  return dir;
}

/** index.json の File。 */
function indexFile(): File {
  return new File(downloadsDir(), "index.json");
}

/** プレイリストコレクションの永続化先 File（playlists.json）。 */
function playlistsFile(): File {
  return new File(downloadsDir(), "playlists.json");
}

/** original 保存時の拡張子を track のロケーションから推定（不明なら m4a）。 */
function inferExt(track: Track): string {
  const path = track.locationPath ?? track.locationRaw ?? "";
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "m4a";
}

/** quality に応じた保存拡張子。 */
function extFor(track: Track, quality: DownloadQuality): string {
  // 非 original（圧縮DL）はサーバが ADTS AAC を返す。.m4a だと端末で再生不可になるため .aac で保存する。
  return quality === "original" ? inferExt(track) : "aac";
}

/** アートワーク保存先サブディレクトリ（document/downloads/art）。 */
function artDir(): Directory {
  return new Directory(downloadsDir(), "art");
}

/** アートワーク保存用ディレクトリを保証する（無ければ作る）。 */
function ensureArtDir(): Directory {
  const dir = artDir();
  try {
    if (!dir.exists) dir.create();
  } catch {
    // 既存/権限などは無視。
  }
  return dir;
}

/**
 * アルバム単位でアートを重複排除するためのファイル名キー。
 * `albumArtist（またはartist）::album` を英数字とハイフン以外を `_` に置換した文字列。
 * 長すぎる場合に備え先頭128文字に切り詰める（衝突リスクは許容範囲）。
 */
function albumArtKey(track: Track): string {
  const artist = track.albumArtist ?? track.artist ?? "";
  const album = track.album ?? "";
  const raw = `${artist}::${album}`;
  // ファイル名安全化: 英数字・ハイフン・ドット以外を `_` に
  const safe = raw.replace(/[^a-zA-Z0-9\-\.]/g, "_");
  return safe.slice(0, 128);
}

export interface DownloadsState {
  /** trackId → ダウンロード済みエントリ。 */
  entries: Record<number, DownloadEntry>;
  /** trackId → ダウンロード進行中フラグ。 */
  downloading: Record<number, boolean>;
  /** playlistId → オフライン保存したプレイリスト。 */
  playlists: Record<number, DownloadedPlaylist>;

  /** 起動時に index.json を読み込む（無ければ何もしない）。 */
  hydrate: () => Promise<void>;

  isDownloaded: (trackId: number) => boolean;
  getLocalUri: (trackId: number) => string | null;
  /** ローカル保存済みアルバムアートの file:// URI を返す。未取得なら null。 */
  getLocalArtworkUri: (trackId: number) => string | null;

  /**
   * 1 曲をダウンロードして保存・記録する。接続中の client を使い、音質は quality 省略時に
   * 設定の既定音質。既にダウンロード済みなら何もしない。
   */
  downloadTrack: (track: Track, quality?: DownloadQuality) => Promise<void>;
  /**
   * ダウンロード済みの曲を指定音質で取り直す（端末非対応の原本を AAC に置き換える救済導線）。
   * 新しいファイルの保存に成功してから旧ファイルを消すので、失敗しても既存の保存は残る。
   * 戻り値は置き換えに成功したか（未保存・未接続・取得失敗は false）。
   */
  redownloadTrack: (trackId: number, quality: DownloadQuality) => Promise<boolean>;
  /** 複数曲を順番にダウンロード（既にあるものはスキップ）。 */
  downloadMany: (tracks: Track[]) => Promise<void>;
  /** album 名でライブラリから曲を引いて一括ダウンロード。 */
  downloadAlbum: (albumName: string) => Promise<void>;
  /** プレイリストをコレクションとして記録しつつ、曲を一括ダウンロードする。 */
  downloadPlaylist: (
    playlistId: number,
    name: string,
    tracks: Track[],
    pinned?: boolean,
  ) => Promise<void>;
  /** 保存済みプレイリストを削除。pin は他の pin が参照しない曲ファイルも削除する。 */
  removeDownloadedPlaylist: (playlistId: number) => Promise<void>;
  /** 保存済みプレイリストを取得（無ければ null）。 */
  getDownloadedPlaylist: (playlistId: number) => DownloadedPlaylist | null;
  /** pin 済みか。 */
  isPlaylistPinned: (playlistId: number) => boolean;
  /** pin 済みプレイリストをサーバーの現在メンバーと差分同期する。 */
  syncPinnedPlaylists: (
    fetchMembers: (playlistId: number) => Promise<Track[]>,
  ) => Promise<void>;

  /** ファイルとエントリを削除する。 */
  removeDownload: (trackId: number) => Promise<void>;
  /** 全削除（ファイル＋エントリ）。 */
  clearAll: () => Promise<void>;

  totalBytes: () => number;
  /** 1 プレイリストが参照する実ファイルの合計 bytes（重複 trackId は一度だけ）。 */
  playlistBytes: (playlistId: number) => number;
  count: () => number;
}

/** index.json / playlists.json の書き出し成功後に呼ぶリスナー（アプリ側が登録）。 */
let persistListener: (() => void) | null = null;

/**
 * index.json / playlists.json を書き出した直後に呼ばれるリスナーを登録する（null で解除）。
 * Android ではネイティブカタログへの変更通知（notifyDownloadsChanged）を配線するのに使う。
 */
export function setDownloadsPersistListener(fn: (() => void) | null): void {
  persistListener = fn;
}

/** persist リスナーへ通知する。リスナーの例外で永続化側を壊さない。 */
function notifyPersisted(): void {
  try {
    persistListener?.();
  } catch (e) {
    console.warn("[downloads] persist listener failed:", e);
  }
}

/** entries を index.json に書き出す（失敗は無視）。 */
function persist(entries: Record<number, DownloadEntry>): void {
  try {
    ensureDir();
    const f = indexFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(Object.values(entries)));
  } catch {
    // 永続化失敗はメモリ上の状態で継続。
    return;
  }
  notifyPersisted();
}

/** playlists を playlists.json に書き出す（失敗は無視）。 */
function persistPlaylists(playlists: Record<number, DownloadedPlaylist>): void {
  try {
    ensureDir();
    const f = playlistsFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(Object.values(playlists)));
  } catch {
    // 永続化失敗はメモリ上の状態で継続。
    return;
  }
  notifyPersisted();
}

/** 接続中サーバーの serverId（不明なら undefined＝JSON にキーを出さない）。 */
function currentServerId(): string | undefined {
  return useConnection.getState().serverId ?? undefined;
}

/**
 * 音源とアルバムアートを取得し、記録用のエントリを作る（state/永続化には触れない）。
 * downloadTrack と redownloadTrack の共通部分。失敗は例外。
 */
async function fetchTrackFiles(
  client: ApiClient,
  track: Track,
  quality: DownloadQuality,
): Promise<DownloadEntry> {
  ensureDir();
  const url = client.downloadUrl(track.trackId, quality);
  const ext = extFor(track, quality);
  const dest = new File(downloadsDir(), `${track.trackId}.${ext}`);
  const f = await File.downloadFileAsync(url, dest, { idempotent: true });

  // アルバムアートをサムネとして保存（失敗しても音源DLは成功扱い）。
  let artworkUri: string | null = null;
  try {
    ensureArtDir();
    const key = albumArtKey(track);
    const artFile = new File(artDir(), `${key}.webp`);
    if (artFile.exists) {
      // 同アルバムの既存ファイルを再利用（DLしない）。
      artworkUri = artFile.uri;
    } else {
      const baseArtUrl = client.artworkUrl(track.trackId);
      const artUrl =
        baseArtUrl + (baseArtUrl.includes("?") ? "&" : "?") + "size=256&format=webp";
      const artF = await File.downloadFileAsync(artUrl, artFile, { idempotent: true });
      artworkUri = artF.uri;
    }
  } catch {
    // アート取得失敗は artworkUri を null のまま続行。
  }

  const entry: DownloadEntry = {
    trackId: track.trackId,
    track,
    localUri: f.uri,
    quality,
    bytes: f.size ?? 0,
    createdAt: Date.now(),
    artworkUri,
  };
  const serverId = currentServerId();
  if (serverId) entry.serverId = serverId;
  return entry;
}

/**
 * ダウンロード済み全プレイリスト（pin/非pin問わず）が参照する trackId の集合を作る。
 * 一括DL（非pin）と pin が同じ曲を共有していても孤立曲として誤削除しないよう、
 * 参照カウントは pinned に絞らず全プレイリストを対象にする。
 */
function referencedTrackIds(playlists: Record<number, DownloadedPlaylist>): Set<number> {
  return new Set(Object.values(playlists).flatMap((p) => p.trackIds));
}

/** syncPinnedPlaylists の再入防止用 in-flight Promise（モジュールスコープ、zustand state ではない）。 */
let syncInFlight: Promise<void> | null = null;

export const useDownloads = create<DownloadsState>((set, get) => ({
  entries: {},
  downloading: {},
  playlists: {},

  hydrate: async () => {
    try {
      const f = indexFile();
      if (f.exists) {
        const text = await f.text();
        if (text) {
          const parsed = JSON.parse(text) as DownloadEntry[];
          if (Array.isArray(parsed)) {
            const entries: Record<number, DownloadEntry> = {};
            for (const e of parsed) {
              if (e && typeof e.trackId === "number") entries[e.trackId] = e;
            }
            set({ entries });
          }
        }
      }
    } catch {
      // index.json 不在・破損は空のまま起動。
    }
    // プレイリストコレクションも復元（別ファイル、無ければ空）。
    try {
      const pf = playlistsFile();
      if (pf.exists) {
        const ptext = await pf.text();
        const pparsed = ptext ? (JSON.parse(ptext) as DownloadedPlaylist[]) : [];
        if (Array.isArray(pparsed)) {
          const playlists: Record<number, DownloadedPlaylist> = {};
          for (const p of pparsed) {
            if (p && typeof p.playlistId === "number") playlists[p.playlistId] = p;
          }
          set({ playlists });
        }
      }
    } catch {
      // playlists.json 不在・破損は空のまま。
    }
  },

  isDownloaded: (trackId) => get().entries[trackId] != null,
  getLocalUri: (trackId) => get().entries[trackId]?.localUri ?? null,
  getLocalArtworkUri: (trackId) => get().entries[trackId]?.artworkUri ?? null,

  downloadTrack: async (track, qualityOverride) => {
    if (get().isDownloaded(track.trackId)) return;
    const client = useConnection.getState().client;
    if (!client) return;
    const quality = qualityOverride ?? useSettings.getState().downloadQuality;

    set((s) => ({ downloading: { ...s.downloading, [track.trackId]: true } }));
    try {
      const entry = await fetchTrackFiles(client, track, quality);
      set((s) => {
        const entries = { ...s.entries, [track.trackId]: entry };
        persist(entries);
        const downloading = { ...s.downloading };
        delete downloading[track.trackId];
        return { entries, downloading };
      });
    } catch (e) {
      // 完全沈黙だとDL失敗が分からないので最低限ログだけ残す（UI は壊さない）。
      console.warn("[downloads] downloadTrack failed:", track.trackId, e);
      set((s) => {
        const downloading = { ...s.downloading };
        delete downloading[track.trackId];
        return { downloading };
      });
    }
  },

  redownloadTrack: async (trackId, quality) => {
    const old = get().entries[trackId];
    if (!old || get().downloading[trackId]) return false;
    const client = useConnection.getState().client;
    if (!client) return false;

    set((s) => ({ downloading: { ...s.downloading, [trackId]: true } }));
    try {
      const entry = await fetchTrackFiles(client, old.track, quality);
      // 新ファイルの保存に成功してから旧ファイルを消す（同じパスなら上書き済みなので残す）。
      if (old.localUri !== entry.localUri) {
        try {
          const f = new File(old.localUri);
          if (f.exists) f.delete();
        } catch {
          // 旧ファイルが既に無くても置き換えは成功扱い。
        }
      }
      set((s) => {
        const entries = { ...s.entries, [trackId]: entry };
        persist(entries);
        const downloading = { ...s.downloading };
        delete downloading[trackId];
        return { entries, downloading };
      });
      return true;
    } catch (e) {
      console.warn("[downloads] redownloadTrack failed:", trackId, e);
      set((s) => {
        const downloading = { ...s.downloading };
        delete downloading[trackId];
        return { downloading };
      });
      return false;
    }
  },

  downloadMany: async (tracks) => {
    for (const t of tracks) {
      if (get().isDownloaded(t.trackId)) continue;
      await get().downloadTrack(t);
    }
  },

  downloadAlbum: async (albumName) => {
    const client = useConnection.getState().client;
    if (!client) return;
    try {
      const tracks = await client.listTracks({ album: albumName });
      await get().downloadMany(tracks);
    } catch {
      // 取得失敗は何もしない。
    }
  },

  downloadPlaylist: async (playlistId, name, tracks, pinned = false) => {
    // 先にコレクションを記録（DL途中でも一覧に出るように）。
    set((s) => {
      const current = s.playlists[playlistId];
      const record: DownloadedPlaylist = {
        playlistId,
        name,
        trackIds: tracks.map((t) => t.trackId),
        createdAt: current?.createdAt ?? Date.now(),
        // 通常の一括DLで既存 pin を解除しない。解除は明示的な remove だけで行う。
        pinned: pinned || current?.pinned === true,
      };
      // serverId は接続中のものを優先し、不明なら既存の記録を引き継ぐ。
      const serverId = currentServerId() ?? current?.serverId;
      if (serverId) record.serverId = serverId;
      const playlists = { ...s.playlists, [playlistId]: record };
      persistPlaylists(playlists);
      return { playlists };
    });
    await get().downloadMany(tracks);
  },

  removeDownloadedPlaylist: async (playlistId) => {
    const removed = get().playlists[playlistId];
    if (!removed) return;

    const playlists = { ...get().playlists };
    delete playlists[playlistId];
    persistPlaylists(playlists);
    set({ playlists });

    // one-shot の保存解除は従来どおり曲を残す。pin 解除時だけ、他のプレイリストが
    // 参照しない曲を消す（削除対象自身は既に playlists から除かれている）。
    if (removed.pinned !== true) return;
    const referenced = referencedTrackIds(playlists);
    for (const trackId of new Set(removed.trackIds)) {
      if (!referenced.has(trackId)) await get().removeDownload(trackId);
    }
  },

  getDownloadedPlaylist: (playlistId) => get().playlists[playlistId] ?? null,
  isPlaylistPinned: (playlistId) => get().playlists[playlistId]?.pinned === true,

  syncPinnedPlaylists: (fetchMembers) => {
    // 再入防止: 接続復帰が短時間に複数回起きても実行は 1 本化する（coalesce）。
    // 2 本目以降は新規に走らせず、進行中の Promise をそのまま返す。進行中の run が
    // 完了した時点で get().playlists は最新化されているため、後から来た呼び出し側も
    // その Promise を await すれば整合した状態を得られる。
    if (syncInFlight) return syncInFlight;

    const run = async () => {
      const pinned = Object.values(get().playlists).filter((p) => p.pinned === true);
      if (pinned.length === 0) return;

      // 先に全 pin の現在メンバーを取得し、A から削除・B に追加された共有曲を不要に消さない。
      const fetched = await Promise.all(
        pinned.map(async (playlist) => {
          try {
            return { playlist, tracks: await fetchMembers(playlist.playlistId) };
          } catch (e) {
            // 1 件の取得失敗で他の pin の同期まで止めない。失敗した pin は旧メンバーを保持する。
            console.warn("[downloads] syncPinnedPlaylists failed:", playlist.playlistId, e);
            return null;
          }
        }),
      );

      const removedCandidates = new Set<number>();
      const nextPlaylists = { ...get().playlists };
      const successful: Track[][] = [];
      for (const result of fetched) {
        if (!result) continue;
        const current = nextPlaylists[result.playlist.playlistId];
        // 取得中にユーザーが pin 解除した場合は復活させない。
        if (current?.pinned !== true) continue;
        const nextIds = result.tracks.map((track) => track.trackId);
        const nextIdSet = new Set(nextIds);
        for (const oldId of current.trackIds) {
          if (!nextIdSet.has(oldId)) removedCandidates.add(oldId);
        }
        nextPlaylists[current.playlistId] = { ...current, trackIds: nextIds };
        successful.push(result.tracks);
      }
      persistPlaylists(nextPlaylists);
      set({ playlists: nextPlaylists });

      // 新規メンバーだけ downloadTrack 内の既存判定を抜けて、記憶済みの設定音質で保存される。
      for (const tracks of successful) await get().downloadMany(tracks);

      const referenced = referencedTrackIds(get().playlists);
      for (const trackId of removedCandidates) {
        if (!referenced.has(trackId)) await get().removeDownload(trackId);
      }
    };

    syncInFlight = run().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  },

  removeDownload: async (trackId) => {
    const entry = get().entries[trackId];
    if (!entry) return;
    try {
      const f = new File(entry.localUri);
      if (f.exists) f.delete();
    } catch {
      // ファイルが既に無くてもエントリは消す。
    }
    set((s) => {
      const entries = { ...s.entries };
      delete entries[trackId];
      persist(entries);
      return { entries };
    });
  },

  clearAll: async () => {
    const { entries } = get();
    for (const e of Object.values(entries)) {
      try {
        const f = new File(e.localUri);
        if (f.exists) f.delete();
      } catch {
        // 個別失敗は無視して続行。
      }
    }
    // art ディレクトリごと削除（アルバム共有のためまとめて消す）。
    try {
      const dir = artDir();
      if (dir.exists) dir.delete();
    } catch {
      // 削除失敗は無視。
    }
    const empty: Record<number, DownloadEntry> = {};
    persist(empty);
    persistPlaylists({});
    set({ entries: empty, playlists: {} });
  },

  totalBytes: () =>
    Object.values(get().entries).reduce((sum, e) => sum + (e.bytes || 0), 0),
  playlistBytes: (playlistId) => {
    const playlist = get().playlists[playlistId];
    if (!playlist) return 0;
    return [...new Set(playlist.trackIds)].reduce(
      (sum, trackId) => sum + (get().entries[trackId]?.bytes || 0),
      0,
    );
  },
  count: () => Object.keys(get().entries).length,
}));
