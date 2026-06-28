import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Track,
  AlbumRow,
  Playlist,
  PlaybackState,
  ViewMode,
  DisplayMode,
  CoverSize,
  RailTab,
  FieldKey,
  SortField,
  SortOrder,
  RepeatMode,
  TrackAnalysis,
  EncodeFormat,
} from "../types";
import { DEFAULT_FIELDS, ALBUM_SORT_FIELDS } from "../types";

// グローバルトースト（成功/失敗/情報の一時通知）。永続化しない。
export type ToastKind = "success" | "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  // 自動で消えるまでのミリ秒。0 以下なら自動で消えない。
  durationMs: number;
}

// CD リッピング進捗 — セッション専用・永続化しない
export type RipPhase = "ripping" | "done" | "error";
export interface RipStatus {
  phase: RipPhase;
  current: number;
  total: number;
  label: string;
  percent?: number;
  log: string[];
  addedTracks?: number;
  error?: string;
}

interface PersistedSettings {
  fields: FieldKey[];
  // 列ごとのユーザー指定幅 (px)。未指定の列は FIELD_DEFS の既定幅を使う。
  fieldWidths: Partial<Record<FieldKey, number>>;
  // 曲名(Track)列のユーザー指定幅 (px)。null なら従来どおり残り幅いっぱい(flex:1)。
  nameColWidth: number | null;
  // 右ペイン(RightRail)を表示するか。false でテーブルを全幅に広げる。
  rightRailVisible: boolean;
  // プレーヤーの時間表示を「残り時間(−)」にするか。false なら経過時間。
  showRemainingTime: boolean;
  rowH: number;
  coverSize: CoverSize;
  displayMode: DisplayMode;
  sortField: SortField;
  sortOrder: SortOrder;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  // ReplayGain（音量正規化）を有効にするか
  replayGain: boolean;
  // 直近に「プレイリストへ追加」したプレイリストID（新しい順 / 最大 MAX_RECENT_PLAYLISTS 件）
  recentPlaylistIds: number[];
  // たたんでいるプレイリストフォルダの playlistId
  collapsedFolders: number[];
  // iTunes 互換 XML の自動エクスポート
  autoExportEnabled: boolean;
  autoExportPath: string | null;
  ripFormat: EncodeFormat;
  ripOutputDir: string | null;
}

// 「前回入れたプレイリスト」ショートカットで保持する件数
const MAX_RECENT_PLAYLISTS = 3;

interface AppState extends PersistedSettings {
  // View
  viewMode: ViewMode;
  selectedPlaylistId: number | null;
  searchQuery: string;
  // ジャンル等の絞り込みチップ（フリーテキスト検索と AND 結合、セッション内のみ）
  filterTags: string[];

  // Data
  tracks: Track[];
  playlists: Playlist[];
  selectedTrackIds: Set<number>;
  isLoading: boolean;
  hasMore: boolean;
  albums: AlbumRow[];
  albumsHasMore: boolean;

  // Playback
  playback: PlaybackState;

  // Staging Crate (DJ 選曲) — セッション内のみ、永続化しない
  crate: Track[];
  railTab: RailTab;

  // 音声解析 (BPM/key/energy) のキャッシュと進捗 — セッション内のみ、永続化しない
  analysisByTrack: Map<number, TrackAnalysis>;
  analysisActive: { done: number; total: number } | null;
  // Similar タブの基準トラック。null なら再生中の曲を基準にする。
  similarBaseTrackId: number | null;
  // 「閉じるときに更新」が予約されていれば、そのインストーラ URL とバージョン。
  pendingUpdate: { url: string; version: string } | null;

  // グローバルトースト — セッション内のみ、永続化しない。
  toasts: Toast[];

  // Actions
  setViewMode: (mode: ViewMode) => void;
  setSelectedPlaylistId: (id: number | null) => void;
  setSearchQuery: (query: string) => void;
  addFilterTag: (tag: string) => void;
  removeFilterTag: (tag: string) => void;
  clearFilterTags: () => void;
  setTracks: (tracks: Track[]) => void;
  appendTracks: (tracks: Track[]) => void;
  setAlbums: (albums: AlbumRow[]) => void;
  appendAlbums: (albums: AlbumRow[]) => void;
  setAlbumsHasMore: (hasMore: boolean) => void;
  setPlaylists: (playlists: Playlist[]) => void;
  setIsLoading: (loading: boolean) => void;
  setHasMore: (hasMore: boolean) => void;
  setPlayback: (state: PlaybackState) => void;
  setSelectedTrackIds: (ids: Set<number>) => void;
  toggleTrackSelection: (id: number, additive: boolean) => void;
  clearTrackSelection: () => void;

  // Crate
  setRailTab: (tab: RailTab) => void;
  addToCrate: (track: Track) => void;
  removeFromCrate: (trackId: number) => void;
  reorderCrate: (from: number, to: number) => void;
  setCrateOrder: (ids: number[]) => void;
  clearCrate: () => void;

  // Persisted settings
  setDisplayMode: (mode: DisplayMode) => void;
  setFields: (fields: FieldKey[]) => void;
  toggleField: (key: FieldKey) => void;
  reorderFields: (from: number, to: number) => void;
  setFieldWidth: (key: FieldKey, width: number) => void;
  setNameColWidth: (width: number | null) => void;
  setRightRailVisible: (visible: boolean) => void;
  toggleRightRail: () => void;
  setShowRemainingTime: (show: boolean) => void;
  toggleRemainingTime: () => void;
  setRowH: (h: number) => void;
  setCoverSize: (s: CoverSize) => void;
  resetColumns: () => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  toggleSort: (field: SortField) => void;
  setVolume: (v: number) => void;
  setShuffle: (on: boolean) => void;
  setRepeat: (mode: RepeatMode) => void;
  setReplayGain: (on: boolean) => void;
  pushRecentPlaylist: (id: number) => void;
  toggleFolder: (id: number) => void;
  setAutoExport: (enabled: boolean, path: string | null) => void;
  setRipFormat: (f: EncodeFormat) => void;
  setRipOutputDir: (dir: string | null) => void;

  // Analysis
  setAnalyses: (list: TrackAnalysis[]) => void;
  setAnalysisActive: (v: { done: number; total: number } | null) => void;
  // Rip progress
  ripStatus: RipStatus | null;
  setRipStatus: (s: RipStatus | null) => void;
  appendRipLog: (line: string) => void;
  clearRipStatus: () => void;
  setSimilarBase: (trackId: number | null) => void;
  setPendingUpdate: (v: { url: string; version: string } | null) => void;

  // Toasts
  pushToast: (kind: ToastKind, message: string, durationMs?: number) => number;
  dismissToast: (id: number) => void;
}

// トーストの連番 ID 発番用カウンタ。
let toastSeq = 0;

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      viewMode: "library",
      selectedPlaylistId: null,
      searchQuery: "",
      filterTags: [],
      tracks: [],
      playlists: [],
      selectedTrackIds: new Set(),
      isLoading: false,
      hasMore: true,
      albums: [],
      albumsHasMore: true,
      playback: {
        isPlaying: false,
        currentTrackId: null,
        positionMs: 0,
        durationMs: 0,
      },
      crate: [],
      railTab: "crate",
      analysisByTrack: new Map(),
      analysisActive: null,
      ripStatus: null,
      similarBaseTrackId: null,
      pendingUpdate: null,
      toasts: [],

      // Persisted
      fields: DEFAULT_FIELDS,
      fieldWidths: {},
      nameColWidth: null,
      rightRailVisible: true,
      showRemainingTime: false,
      rowH: 40,
      coverSize: 20,
      displayMode: "list",
      sortField: "name",
      sortOrder: "asc",
      volume: 1.0,
      shuffle: false,
      repeat: "off",
      replayGain: false,
      recentPlaylistIds: [],
      collapsedFolders: [],
      autoExportEnabled: false,
      autoExportPath: null,
      ripFormat: "alac",
      ripOutputDir: null,

      setViewMode: (mode) => set({ viewMode: mode }),
      setSelectedPlaylistId: (id) => set({ selectedPlaylistId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      addFilterTag: (tag) =>
        set((state) =>
          state.filterTags.includes(tag)
            ? {}
            : { filterTags: [...state.filterTags, tag] },
        ),
      removeFilterTag: (tag) =>
        set((state) => ({ filterTags: state.filterTags.filter((t) => t !== tag) })),
      clearFilterTags: () => set({ filterTags: [] }),
      setTracks: (tracks) => set({ tracks, selectedTrackIds: new Set() }),
      appendTracks: (tracks) =>
        set((state) => ({ tracks: [...state.tracks, ...tracks] })),
      setAlbums: (albums) => set({ albums }),
      appendAlbums: (albums) =>
        set((state) => ({ albums: [...state.albums, ...albums] })),
      setAlbumsHasMore: (albumsHasMore) => set({ albumsHasMore }),
      setPlaylists: (playlists) => set({ playlists }),
      setIsLoading: (loading) => set({ isLoading: loading }),
      setHasMore: (hasMore) => set({ hasMore }),
      setPlayback: (playback) => set({ playback }),
      setSelectedTrackIds: (ids) => set({ selectedTrackIds: ids }),
      toggleTrackSelection: (id, additive) =>
        set((state) => {
          const next = additive
            ? new Set(state.selectedTrackIds)
            : new Set<number>();
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedTrackIds: next };
        }),
      clearTrackSelection: () => set({ selectedTrackIds: new Set() }),

      // Crate
      setRailTab: (tab) => set({ railTab: tab }),
      addToCrate: (track) =>
        set((state) =>
          state.crate.some((t) => t.trackId === track.trackId)
            ? {}
            : { crate: [...state.crate, track], railTab: "crate" },
        ),
      removeFromCrate: (trackId) =>
        set((state) => ({
          crate: state.crate.filter((t) => t.trackId !== trackId),
        })),
      reorderCrate: (from, to) =>
        set((state) => {
          if (from === to) return {};
          const next = [...state.crate];
          const [m] = next.splice(from, 1);
          next.splice(to, 0, m);
          return { crate: next };
        }),
      // 与えられた id 順に crate を並べ替える (id に無い曲は元順で末尾に残す)。
      setCrateOrder: (ids) =>
        set((state) => {
          const byId = new Map(state.crate.map((t) => [t.trackId, t]));
          const seen = new Set(ids);
          const next: Track[] = [];
          for (const id of ids) {
            const t = byId.get(id);
            if (t) next.push(t);
          }
          for (const t of state.crate) {
            if (!seen.has(t.trackId)) next.push(t);
          }
          return { crate: next };
        }),
      clearCrate: () => set({ crate: [] }),

      // Persisted settings
      setDisplayMode: (mode) =>
        set((state) => {
          // Albums モードはアルバム粒度のソート語彙のみ。トラック専用フィールド
          // (BPM 等) のままだと無意味に散るので albumArtist 昇順へ正規化する。
          if (mode === "albums" && !ALBUM_SORT_FIELDS.includes(state.sortField)) {
            return { displayMode: mode, sortField: "albumArtist", sortOrder: "asc" };
          }
          return { displayMode: mode };
        }),
      setFields: (fields) => set({ fields }),
      toggleField: (key) =>
        set((state) => ({
          fields: state.fields.includes(key)
            ? state.fields.filter((k) => k !== key)
            : [...state.fields, key],
        })),
      reorderFields: (from, to) =>
        set((state) => {
          if (from === to) return {};
          const next = [...state.fields];
          const [m] = next.splice(from, 1);
          next.splice(to, 0, m);
          return { fields: next };
        }),
      setFieldWidth: (key, width) =>
        set((state) => ({ fieldWidths: { ...state.fieldWidths, [key]: width } })),
      setNameColWidth: (nameColWidth) => set({ nameColWidth }),
      setRightRailVisible: (rightRailVisible) => set({ rightRailVisible }),
      toggleRightRail: () =>
        set((state) => ({ rightRailVisible: !state.rightRailVisible })),
      setShowRemainingTime: (showRemainingTime) => set({ showRemainingTime }),
      toggleRemainingTime: () =>
        set((state) => ({ showRemainingTime: !state.showRemainingTime })),
      setRowH: (rowH) => set({ rowH }),
      setCoverSize: (coverSize) => set({ coverSize }),
      resetColumns: () =>
        set({ fields: DEFAULT_FIELDS, fieldWidths: {}, rowH: 40, coverSize: 20 }),
      setSortField: (field) => set({ sortField: field }),
      setSortOrder: (order) => set({ sortOrder: order }),
      toggleSort: (field) =>
        set((state) =>
          state.sortField === field
            ? { sortOrder: state.sortOrder === "asc" ? "desc" : "asc" }
            : { sortField: field, sortOrder: "asc" },
        ),
      setVolume: (volume) => set({ volume }),
      setShuffle: (shuffle) => set({ shuffle }),
      setRepeat: (repeat) => set({ repeat }),
      setReplayGain: (replayGain) => set({ replayGain }),
      pushRecentPlaylist: (id) =>
        set((state) => ({
          recentPlaylistIds: [
            id,
            ...state.recentPlaylistIds.filter((p) => p !== id),
          ].slice(0, MAX_RECENT_PLAYLISTS),
        })),
      toggleFolder: (id) =>
        set((state) => ({
          collapsedFolders: state.collapsedFolders.includes(id)
            ? state.collapsedFolders.filter((f) => f !== id)
            : [...state.collapsedFolders, id],
        })),
      setAutoExport: (autoExportEnabled, autoExportPath) =>
        set({ autoExportEnabled, autoExportPath }),
      setRipFormat: (ripFormat) => set({ ripFormat }),
      setRipOutputDir: (ripOutputDir) => set({ ripOutputDir }),

      setAnalyses: (list) =>
        set({ analysisByTrack: new Map(list.map((a) => [a.trackId, a])) }),
      setAnalysisActive: (v) => set({ analysisActive: v }),
      setRipStatus: (s) => set({ ripStatus: s }),
      appendRipLog: (line) =>
        set((state) => {
          if (!state.ripStatus) return {};
          return { ripStatus: { ...state.ripStatus, log: [...state.ripStatus.log, line] } };
        }),
      clearRipStatus: () => set({ ripStatus: null }),
      setSimilarBase: (trackId) =>
        set({ similarBaseTrackId: trackId, railTab: "similar" }),
      setPendingUpdate: (pendingUpdate) => set({ pendingUpdate }),

      pushToast: (kind, message, durationMs = 3200) => {
        const id = ++toastSeq;
        set((state) => ({
          toasts: [...state.toasts, { id, kind, message, durationMs }],
        }));
        return id;
      },
      dismissToast: (id) =>
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: "itunes-viewer-settings",
      storage: createJSONStorage(() => localStorage),
      version: 10,
      partialize: (state) =>
        ({
          fields: state.fields,
          fieldWidths: state.fieldWidths,
          nameColWidth: state.nameColWidth,
          rightRailVisible: state.rightRailVisible,
          showRemainingTime: state.showRemainingTime,
          rowH: state.rowH,
          coverSize: state.coverSize,
          displayMode: state.displayMode,
          sortField: state.sortField,
          sortOrder: state.sortOrder,
          volume: state.volume,
          shuffle: state.shuffle,
          repeat: state.repeat,
          replayGain: state.replayGain,
          recentPlaylistIds: state.recentPlaylistIds,
          collapsedFolders: state.collapsedFolders,
          autoExportEnabled: state.autoExportEnabled,
          autoExportPath: state.autoExportPath,
          ripFormat: state.ripFormat,
          ripOutputDir: state.ripOutputDir,
        }) satisfies PersistedSettings,
      // v1(visibleColumns) からの移行: 旧キーは破棄してデフォルトに倒す。
      // v3: recentPlaylistIds を追加（旧データには無いので配列で補完）。
      migrate: (persisted, version) => {
        if (version < 2 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          delete p.visibleColumns;
          if (!Array.isArray(p.fields)) p.fields = DEFAULT_FIELDS;
          if (typeof p.rowH !== "number") p.rowH = 40;
          if (typeof p.coverSize !== "number") p.coverSize = 20;
          if (p.displayMode !== "covers") p.displayMode = "list";
        }
        if (version < 3 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (!Array.isArray(p.recentPlaylistIds)) p.recentPlaylistIds = [];
        }
        if (version < 5 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (!Array.isArray(p.collapsedFolders)) p.collapsedFolders = [];
        }
        if (version < 6 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (typeof p.autoExportEnabled !== "boolean") p.autoExportEnabled = false;
          if (typeof p.autoExportPath !== "string") p.autoExportPath = null;
        }
        // v7: 列幅(fieldWidths) と 右ペイン表示(rightRailVisible) を追加。
        // 旧データには無いので空オブジェクト / true で補完する。
        if (version < 7 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (typeof p.fieldWidths !== "object" || p.fieldWidths === null) {
            p.fieldWidths = {};
          }
          if (typeof p.rightRailVisible !== "boolean") p.rightRailVisible = true;
        }
        // v8: 曲名列幅(nameColWidth) と 残り時間表示(showRemainingTime) を追加。
        // 旧データには無いので null / false で補完する。
        if (version < 8 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (typeof p.nameColWidth !== "number") p.nameColWidth = null;
          if (typeof p.showRemainingTime !== "boolean") p.showRemainingTime = false;
        }
        // v9: ripFormat と ripOutputDir を追加。
        if (version < 9 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (typeof p.ripFormat !== "string") p.ripFormat = "alac";
          if (p.ripOutputDir === undefined) p.ripOutputDir = null;
        }
        // v10: DisplayMode "covers" を廃止。旧 "covers" は "albums" に統合し、
        // 不正値は "list" に倒す。さらに Albums モードのソートをアルバム粒度に正規化する。
        if (version < 10 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (p.displayMode === "covers") p.displayMode = "albums";
          else if (
            p.displayMode !== "list" &&
            p.displayMode !== "albums" &&
            p.displayMode !== "tracks"
          ) {
            p.displayMode = "list";
          }
          if (
            p.displayMode === "albums" &&
            !ALBUM_SORT_FIELDS.includes(p.sortField as SortField)
          ) {
            p.sortField = "albumArtist";
            p.sortOrder = "asc";
          }
        }
        return persisted as PersistedSettings;
      },
    },
  ),
);
