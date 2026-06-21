// オフラインダウンロード管理ストア（zustand）。
// expo-file-system の新 API（File/Directory/Paths）で document/downloads/ 配下に音源を保存し、
// index.json にメタ（DownloadEntry）を永続化する。曲は track.trackId で扱う（CRITICAL id rule）。
//
// 設計メモ:
// - ファイル名は `${trackId}.${ext}`。ext は original は track のロケーションから推定、それ以外は m4a。
// - fs 操作はすべて try/catch で握りつぶし、エラーは downloading マップ解除のみ行う（UI を壊さない）。

import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";

import type { DownloadEntry, DownloadQuality, Track } from "../lib/types";
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

/** original 保存時の拡張子を track のロケーションから推定（不明なら m4a）。 */
function inferExt(track: Track): string {
  const path = track.locationPath ?? track.locationRaw ?? "";
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "m4a";
}

/** quality に応じた保存拡張子。 */
function extFor(track: Track, quality: DownloadQuality): string {
  return quality === "original" ? inferExt(track) : "m4a";
}

export interface DownloadsState {
  /** trackId → ダウンロード済みエントリ。 */
  entries: Record<number, DownloadEntry>;
  /** trackId → ダウンロード進行中フラグ。 */
  downloading: Record<number, boolean>;

  /** 起動時に index.json を読み込む（無ければ何もしない）。 */
  hydrate: () => Promise<void>;

  isDownloaded: (trackId: number) => boolean;
  getLocalUri: (trackId: number) => string | null;

  /** 1 曲をダウンロードして保存・記録する。接続中の client と既定音質を使う。 */
  downloadTrack: (track: Track) => Promise<void>;
  /** 複数曲を順番にダウンロード（既にあるものはスキップ）。 */
  downloadMany: (tracks: Track[]) => Promise<void>;
  /** album 名でライブラリから曲を引いて一括ダウンロード。 */
  downloadAlbum: (albumName: string) => Promise<void>;

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

export const useDownloads = create<DownloadsState>((set, get) => ({
  entries: {},
  downloading: {},

  hydrate: async () => {
    try {
      const f = indexFile();
      if (!f.exists) return;
      const text = await f.text();
      if (!text) return;
      const parsed = JSON.parse(text) as DownloadEntry[];
      if (!Array.isArray(parsed)) return;
      const entries: Record<number, DownloadEntry> = {};
      for (const e of parsed) {
        if (e && typeof e.trackId === "number") entries[e.trackId] = e;
      }
      set({ entries });
    } catch {
      // index.json 不在・破損は空のまま起動。
    }
  },

  isDownloaded: (trackId) => get().entries[trackId] != null,
  getLocalUri: (trackId) => get().entries[trackId]?.localUri ?? null,

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
      const entry: DownloadEntry = {
        trackId: track.trackId,
        track,
        localUri: f.uri,
        quality,
        bytes: f.size ?? 0,
        createdAt: Date.now(),
      };
      set((s) => {
        const entries = { ...s.entries, [track.trackId]: entry };
        persist(entries);
        const downloading = { ...s.downloading };
        delete downloading[track.trackId];
        return { entries, downloading };
      });
    } catch {
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
    const empty: Record<number, DownloadEntry> = {};
    persist(empty);
    set({ entries: empty });
  },

  totalBytes: () =>
    Object.values(get().entries).reduce((sum, e) => sum + (e.bytes || 0), 0),
  count: () => Object.keys(get().entries).length,
}));
