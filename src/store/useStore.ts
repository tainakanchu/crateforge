import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Track,
  Playlist,
  PlaybackState,
  ViewMode,
  ColumnKey,
  SortField,
  SortOrder,
  RepeatMode,
} from "../types";
import { COLUMNS } from "../types";

interface PersistedSettings {
  visibleColumns: ColumnKey[];
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

  // Data
  tracks: Track[];
  playlists: Playlist[];
  selectedTrackIds: Set<number>;
  isLoading: boolean;
  hasMore: boolean;

  // Playback
  playback: PlaybackState;

  // Actions
  setViewMode: (mode: ViewMode) => void;
  setSelectedPlaylistId: (id: number | null) => void;
  setSearchQuery: (query: string) => void;
  setTracks: (tracks: Track[]) => void;
  appendTracks: (tracks: Track[]) => void;
  setPlaylists: (playlists: Playlist[]) => void;
  setIsLoading: (loading: boolean) => void;
  setHasMore: (hasMore: boolean) => void;
  setPlayback: (state: PlaybackState) => void;
  setSelectedTrackIds: (ids: Set<number>) => void;
  toggleTrackSelection: (id: number, additive: boolean) => void;
  clearTrackSelection: () => void;

  // Persisted settings
  toggleColumn: (key: ColumnKey) => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  toggleSort: (field: SortField) => void;
  setVolume: (v: number) => void;
  setShuffle: (on: boolean) => void;
  setRepeat: (mode: RepeatMode) => void;
}

const defaultVisibleColumns: ColumnKey[] = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      viewMode: "library",
      selectedPlaylistId: null,
      searchQuery: "",
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

      // Persisted
      visibleColumns: defaultVisibleColumns,
      sortField: "name",
      sortOrder: "asc",
      volume: 1.0,
      shuffle: false,
      repeat: "off",

      setViewMode: (mode) => set({ viewMode: mode }),
      setSelectedPlaylistId: (id) => set({ selectedPlaylistId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
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

      toggleColumn: (key) =>
        set((state) => {
          const has = state.visibleColumns.includes(key);
          return {
            visibleColumns: has
              ? state.visibleColumns.filter((k) => k !== key)
              : [...state.visibleColumns, key],
          };
        }),
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
      partialize: (state) =>
        ({
          visibleColumns: state.visibleColumns,
          sortField: state.sortField,
          sortOrder: state.sortOrder,
          volume: state.volume,
          shuffle: state.shuffle,
          repeat: state.repeat,
        }) satisfies PersistedSettings,
    },
  ),
);
