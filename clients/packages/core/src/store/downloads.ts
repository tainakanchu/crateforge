// オフラインダウンロード管理ストア（zustand）。
// expo-file-system の新 API（File/Directory/Paths）で document/downloads/ 配下に音源を保存し、
// index.json にメタ（DownloadEntry）を永続化する。曲は track.trackId で扱う（CRITICAL id rule）。
//
// 設計メモ:
// - ファイル名は `${trackId}.${ext}`。ext は original は track のロケーションから推定、
//   それ以外（圧縮DL）はサーバが ADTS AAC を返すので aac。
// - fs 操作はすべて try/catch で握りつぶし、エラーは downloading マップ解除のみ行う（UI を壊さない）。
//   ただしダウンロード失敗は原因切り分けのため console.warn でログだけは残す。

import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";

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

  /** 1 曲をダウンロードして保存・記録する。接続中の client と既定音質を使う。 */
  downloadTrack: (track: Track) => Promise<void>;
  /** 複数曲を順番にダウンロード（既にあるものはスキップ）。 */
  downloadMany: (tracks: Track[]) => Promise<void>;
  /** album 名でライブラリから曲を引いて一括ダウンロード。 */
  downloadAlbum: (albumName: string) => Promise<void>;
  /** プレイリストをコレクションとして記録しつつ、曲を一括ダウンロードする。 */
  downloadPlaylist: (playlistId: number, name: string, tracks: Track[]) => Promise<void>;
  /** 保存済みプレイリストのコレクション記録を削除する（曲ファイルは消さない）。 */
  removeDownloadedPlaylist: (playlistId: number) => void;
  /** 保存済みプレイリストを取得（無ければ null）。 */
  getDownloadedPlaylist: (playlistId: number) => DownloadedPlaylist | null;

  /** ファイルとエントリを削除する。 */
  removeDownload: (trackId: number) => Promise<void>;
  /** 全削除（ファイル＋エントリ）。 */
  clearAll: () => Promise<void>;

  totalBytes: () => number;
  count: () => number;
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
  }
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
  }
}

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

  downloadTrack: async (track) => {
    if (get().isDownloaded(track.trackId)) return;
    const client = useConnection.getState().client;
    if (!client) return;
    const quality = useSettings.getState().downloadQuality;

    set((s) => ({ downloading: { ...s.downloading, [track.trackId]: true } }));
    try {
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

  downloadPlaylist: async (playlistId, name, tracks) => {
    // 先にコレクションを記録（DL途中でも一覧に出るように）。
    set((s) => {
      const playlists = {
        ...s.playlists,
        [playlistId]: { playlistId, name, trackIds: tracks.map((t) => t.trackId), createdAt: Date.now() },
      };
      persistPlaylists(playlists);
      return { playlists };
    });
    await get().downloadMany(tracks);
  },

  removeDownloadedPlaylist: (playlistId) => {
    set((s) => {
      const playlists = { ...s.playlists };
      delete playlists[playlistId];
      persistPlaylists(playlists);
      return { playlists };
    });
  },

  getDownloadedPlaylist: (playlistId) => get().playlists[playlistId] ?? null,

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
  count: () => Object.keys(get().entries).length,
}));
