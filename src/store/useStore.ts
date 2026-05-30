import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Track,
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
} from "../types";
import { DEFAULT_FIELDS } from "../types";

interface PersistedSettings {
  fields: FieldKey[];
  rowH: number;
  coverSize: CoverSize;
  displayMode: DisplayMode;
  sortField: SortField;
  sortOrder: SortOrder;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

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

  // Playback
  playback: PlaybackState;

  // Staging Crate (DJ 選曲) — セッション内のみ、永続化しない
  crate: Track[];
  railTab: RailTab;

  // Actions
  setViewMode: (mode: ViewMode) => void;
  setSelectedPlaylistId: (id: number | null) => void;
  setSearchQuery: (query: string) => void;
  addFilterTag: (tag: string) => void;
  removeFilterTag: (tag: string) => void;
  clearFilterTags: () => void;
  setTracks: (tracks: Track[]) => void;
  appendTracks: (tracks: Track[]) => void;
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
  clearCrate: () => void;

  // Persisted settings
  setDisplayMode: (mode: DisplayMode) => void;
  setFields: (fields: FieldKey[]) => void;
  toggleField: (key: FieldKey) => void;
  reorderFields: (from: number, to: number) => void;
  setRowH: (h: number) => void;
  setCoverSize: (s: CoverSize) => void;
  resetColumns: () => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  toggleSort: (field: SortField) => void;
  setVolume: (v: number) => void;
  setShuffle: (on: boolean) => void;
  setRepeat: (mode: RepeatMode) => void;
}

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
      playback: {
        isPlaying: false,
        currentTrackId: null,
        positionMs: 0,
        durationMs: 0,
      },
      crate: [],
      railTab: "crate",

      // Persisted
      fields: DEFAULT_FIELDS,
      rowH: 40,
      coverSize: 20,
      displayMode: "list",
      sortField: "name",
      sortOrder: "asc",
      volume: 1.0,
      shuffle: false,
      repeat: "off",

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
      clearCrate: () => set({ crate: [] }),

      // Persisted settings
      setDisplayMode: (mode) => set({ displayMode: mode }),
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
      setRowH: (rowH) => set({ rowH }),
      setCoverSize: (coverSize) => set({ coverSize }),
      resetColumns: () =>
        set({ fields: DEFAULT_FIELDS, rowH: 40, coverSize: 20 }),
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
    }),
    {
      name: "itunes-viewer-settings",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      partialize: (state) =>
        ({
          fields: state.fields,
          rowH: state.rowH,
          coverSize: state.coverSize,
          displayMode: state.displayMode,
          sortField: state.sortField,
          sortOrder: state.sortOrder,
          volume: state.volume,
          shuffle: state.shuffle,
          repeat: state.repeat,
        }) satisfies PersistedSettings,
      // v1(visibleColumns) からの移行: 旧キーは破棄してデフォルトに倒す。
      migrate: (persisted, version) => {
        if (version < 2 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          delete p.visibleColumns;
          if (!Array.isArray(p.fields)) p.fields = DEFAULT_FIELDS;
          if (typeof p.rowH !== "number") p.rowH = 40;
          if (typeof p.coverSize !== "number") p.coverSize = 20;
          if (p.displayMode !== "covers") p.displayMode = "list";
        }
        return persisted as PersistedSettings;
      },
    },
  ),
);
