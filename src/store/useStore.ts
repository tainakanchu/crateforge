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
  SetMeta,
  CrateAnchors,
  CrateSection,
  AnchorKind,
} from "../types";
import {
  DEFAULT_FIELDS,
  ALBUM_SORT_FIELDS,
  ARTIST_SORT_FIELDS,
  DEFAULT_SET_META,
} from "../types";
import {
  loadSetWorkspacePersist,
  saveSetWorkspacePersist,
  newSectionId,
} from "../lib/setWorkspacePersist";

// グローバルトースト（成功/失敗/情報の一時通知）。永続化しない。
export type ToastKind = "success" | "error" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  // 自動で消えるまでのミリ秒。0 以下なら自動で消えない。
  durationMs: number;
}

// Similar (dig) タブの絞り込み条件。セッションをまたいで保持する (#151)。
/** BPM 許容（サーバー opts）。null = off。 */
export type BpmTolOpt = 0.04 | 0.08 | 0.12 | null;
export interface SimilarFilters {
  harmonic: boolean;
  bpmTol: BpmTolOpt;
  energyClose: boolean;
  excludeInCrate: boolean;
  excludeSameArtist: boolean;
  ratingMinOn: boolean;
}
export const DEFAULT_SIMILAR_FILTERS: SimilarFilters = {
  harmonic: true,
  bpmTol: 0.08,
  energyClose: false,
  excludeInCrate: true,
  excludeSameArtist: false,
  ratingMinOn: false,
};

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
  // 右ペイン幅 (px)。リサイズ可能・永続化。既定 348、範囲 280–560。
  rightRailWidth: number;
  // Crate と Similar を上下分割表示するか（選曲ワークベンチ）。
  railSplit: boolean;
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
  // サーバーから取り寄せる際に最後に選んだ保存先。
  lastSyncDestRoot: string | null;
  // Similar タブの絞り込み条件 (#151)。
  similarFilters: SimilarFilters;
}

// 「前回入れたプレイリスト」ショートカットで保持する件数
/// Artists ビューでしか意味を持たないソートフィールド (他ビューでは name に倒す)。
const ARTIST_ONLY_SORT_FIELDS: SortField[] = ARTIST_SORT_FIELDS.filter(
  (f) => f !== "name",
);

const MAX_RECENT_PLAYLISTS = 3;

// 右ペイン幅の既定・範囲（選曲ワークベンチ #117）
export const RIGHT_RAIL_WIDTH_DEFAULT = 348;
export const RIGHT_RAIL_WIDTH_MIN = 280;
export const RIGHT_RAIL_WIDTH_MAX = 560;

// App シェルの他カラム幅（#146）。.app の grid-template-columns (styles.css) と対応させる。
// サイドバー固定幅 + センター（トラック表）が潰れないための最小幅。
export const SIDEBAR_WIDTH = 202;
export const CENTER_MIN_WIDTH = 420;

function clampRightRailWidth(w: number): number {
  if (!Number.isFinite(w)) return RIGHT_RAIL_WIDTH_DEFAULT;
  return Math.min(RIGHT_RAIL_WIDTH_MAX, Math.max(RIGHT_RAIL_WIDTH_MIN, Math.round(w)));
}

/**
 * 右ペイン幅をウィンドウ幅に応じてクランプする（#146）。
 * サイドバー(SIDEBAR_WIDTH) とセンター最小幅(CENTER_MIN_WIDTH) を確保した残りを
 * 上限とし、RIGHT_RAIL_WIDTH_MIN/MAX の範囲内に収める。
 * 常に RIGHT_RAIL_WIDTH_MIN 以上は返す（ウィンドウが極端に狭い場合はセンターが
 * その分圧迫される）。viewportWidth 省略時は window.innerWidth を使い、
 * window が無い環境（テスト等）では従来どおり MIN/MAX のみでクランプする。
 */
export function clampRailWidthToViewport(
  w: number,
  viewportWidth: number = typeof window !== "undefined" ? window.innerWidth : Infinity,
): number {
  const width = Number.isFinite(w) ? w : RIGHT_RAIL_WIDTH_DEFAULT;
  const dynamicMax = viewportWidth - SIDEBAR_WIDTH - CENTER_MIN_WIDTH;
  const effectiveMax = Math.max(
    RIGHT_RAIL_WIDTH_MIN,
    Math.min(RIGHT_RAIL_WIDTH_MAX, dynamicMax),
  );
  return Math.min(effectiveMax, Math.max(RIGHT_RAIL_WIDTH_MIN, Math.round(width)));
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
  albums: AlbumRow[];
  albumsHasMore: boolean;

  // Playback
  playback: PlaybackState;

  // Staging Crate (DJ 選曲) — track 本体はセッション。trackIds は Set Workspace と共に localStorage。
  crate: Track[];
  railTab: RailTab;

  // Set Workspace (#121) — meta/anchors/sections + crateTrackIds を localStorage (crateforge-set-workspace)
  setMeta: SetMeta;
  crateAnchors: CrateAnchors;
  crateSections: CrateSection[];

  // 音声解析 (BPM/key/energy) のキャッシュと進捗 — セッション内のみ、永続化しない
  analysisByTrack: Map<number, TrackAnalysis>;
  analysisActive: { done: number; total: number } | null;
  // Similar タブの基準トラック。null なら再生中の曲を基準にする。
  similarBaseTrackId: number | null;
  // 「閉じるときに更新」が予約されていれば、そのインストーラ URL とバージョン。
  pendingUpdate: { url: string; version: string } | null;

  // Audition モード (波形強調・ジャンプキー) — セッション状態。
  // 起動ごとに OFF から始める（永続化すると解除口が分からず閉じ込められる #150）。
  auditionMode: boolean;

  // Audition Preview セッション — 永続化しない。
  // previewActive: 単曲プレビュー中 (Esc で復帰可能)
  // previewReturn: プレビュー開始前の曲・位置
  previewActive: boolean;
  previewReturn: { trackId: number | null; positionMs: number } | null;

  // Inbox / Triage (#118) — セッション状態。done/later は localStorage (crateforge-triage)。
  triageMode: boolean;
  triageIndex: number;
  /** サイドバーバッジ用。Inbox ロード / 処理後に更新。 */
  inboxCount: number;

  // グローバルトースト — セッション内のみ、永続化しない。
  toasts: Toast[];
  // アートワーク差し替え時のキャッシュバスト用エポック（揮発・非永続）
  artworkEpoch: number;

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
  /** 複数曲を 1 回の更新で Crate に追加する (重複は Set で O(N) 除去)。 */
  addTracksToCrate: (tracks: Track[]) => void;
  removeFromCrate: (trackId: number) => void;
  reorderCrate: (from: number, to: number) => void;
  setCrateOrder: (ids: number[]) => void;
  clearCrate: () => void;
  /**
   * 永続 ID 列から crate を復元する。
   * 既に曲がある場合は永続順を優先し、再水和中に足された曲は末尾へマージする。
   */
  restoreCrateTracks: (tracks: Track[]) => void;

  // Set Workspace
  setSetMeta: (partial: Partial<SetMeta>) => void;
  setTrackAnchor: (trackId: number, kind: AnchorKind | null) => void;
  setSections: (sections: CrateSection[]) => void;
  addSection: (startTrackId: number, name: string) => void;
  renameSection: (sectionId: string, name: string) => void;
  removeSection: (sectionId: string) => void;
  clearSetMeta: () => void;

  // Persisted settings
  setDisplayMode: (mode: DisplayMode) => void;
  setFields: (fields: FieldKey[]) => void;
  toggleField: (key: FieldKey) => void;
  reorderFields: (from: number, to: number) => void;
  setFieldWidth: (key: FieldKey, width: number) => void;
  setNameColWidth: (width: number | null) => void;
  setRightRailVisible: (visible: boolean) => void;
  toggleRightRail: () => void;
  setRightRailWidth: (width: number) => void;
  setRailSplit: (split: boolean) => void;
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
  setLastSyncDestRoot: (dir: string | null) => void;

  // Analysis
  setAnalyses: (list: TrackAnalysis[]) => void;
  setAnalysisActive: (v: { done: number; total: number } | null) => void;
  // Rip progress
  ripStatus: RipStatus | null;
  setRipStatus: (s: RipStatus | null) => void;
  appendRipLog: (line: string) => void;
  clearRipStatus: () => void;
  /**
   * Similar の基準曲を設定する。
   * focus: true のときだけ右ペインを Similar タブへ切り替える
   * (コンテキストメニューの「Find similar」など明示的な操作のみ)。
   */
  setSimilarBase: (trackId: number | null, opts?: { focus?: boolean }) => void;
  setSimilarFilters: (patch: Partial<SimilarFilters>) => void;
  setPendingUpdate: (v: { url: string; version: string } | null) => void;

  // Audition / Preview
  setAuditionMode: (on: boolean) => void;
  enterPreview: (ret: { trackId: number | null; positionMs: number }) => void;
  /** セッション状態だけクリア (バックエンド flag / 再生復帰は lib/audition.ts 側)。 */
  exitPreviewSession: () => void;

  // Inbox / Triage
  setTriageMode: (on: boolean) => void;
  setTriageIndex: (i: number) => void;
  setInboxCount: (n: number) => void;
  enterTriage: (startIndex?: number) => void;
  exitTriage: () => void;

  // Toasts
  pushToast: (kind: ToastKind, message: string, durationMs?: number) => number;
  dismissToast: (id: number) => void;
  bumpArtworkEpoch: () => void;
}

// トーストの連番 ID 発番用カウンタ。
let toastSeq = 0;

// Set Workspace 初期値（localStorage）。crate 本体は App 側で getTracksByIds 再水和。
const initialSetWorkspace = (() => {
  try {
    return loadSetWorkspacePersist();
  } catch {
    return {
      crateTrackIds: [] as number[],
      setMeta: { ...DEFAULT_SET_META },
      anchors: {} as CrateAnchors,
      sections: [] as CrateSection[],
    };
  }
})();

// 再水和完了前は localStorage へ書かない（空 crate で trackIds を消さないため）。
let setWorkspaceHydrationDone = false;
// API 失敗などで restore できなかった場合に、空 crate でも以前の ids を保持する。
let preservedCrateTrackIds: number[] | null = null;

/**
 * Set Workspace 再水和の完了を宣言する。
 * `preservePersistedTrackIds` 時は現在の localStorage crateTrackIds を退避し、
 * crate が空のままでも以降の persist で上書き消去しない。
 * 完了後に現在 state を一度 flush する（ゲート中に prune された anchors 等を LS へ反映）。
 */
export function markSetWorkspaceHydrationDone(options?: {
  preservePersistedTrackIds?: boolean;
}): void {
  if (options?.preservePersistedTrackIds) {
    try {
      preservedCrateTrackIds = loadSetWorkspacePersist().crateTrackIds;
    } catch {
      // load 失敗時は既存の preserved を触らない
    }
  }
  setWorkspaceHydrationDone = true;
  // 呼び出し時点ではモジュール初期化済み（useStore 定義後）であること。
  persistSetWorkspaceSlice(useStore.getState());
}

function persistSetWorkspaceSlice(state: {
  crate: Track[];
  setMeta: SetMeta;
  crateAnchors: CrateAnchors;
  crateSections: CrateSection[];
}): void {
  let crateTrackIds: number[];
  if (state.crate.length > 0) {
    crateTrackIds = state.crate.map((t) => t.trackId);
    preservedCrateTrackIds = null;
  } else if (preservedCrateTrackIds != null) {
    crateTrackIds = preservedCrateTrackIds;
  } else {
    crateTrackIds = [];
  }
  saveSetWorkspacePersist({
    crateTrackIds,
    setMeta: state.setMeta,
    anchors: state.crateAnchors,
    sections: state.crateSections,
  });
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
      albums: [],
      albumsHasMore: true,
      playback: {
        isPlaying: false,
        currentTrackId: null,
        positionMs: 0,
        durationMs: 0,
        shuffle: false,
        repeat: "off",
        volume: 1.0,
      },
      crate: [],
      railTab: "crate",
      setMeta: { ...initialSetWorkspace.setMeta },
      crateAnchors: { ...initialSetWorkspace.anchors },
      crateSections: [...initialSetWorkspace.sections],
      analysisByTrack: new Map(),
      analysisActive: null,
      ripStatus: null,
      similarBaseTrackId: null,
      pendingUpdate: null,
      previewActive: false,
      previewReturn: null,
      triageMode: false,
      triageIndex: 0,
      inboxCount: 0,
      toasts: [],
      artworkEpoch: 0,

      // Persisted
      fields: DEFAULT_FIELDS,
      fieldWidths: {},
      nameColWidth: null,
      rightRailVisible: true,
      rightRailWidth: RIGHT_RAIL_WIDTH_DEFAULT,
      railSplit: false,
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
      lastSyncDestRoot: null,
      similarFilters: DEFAULT_SIMILAR_FILTERS,
      auditionMode: false,

      // Artists ビューはアーティスト粒度のソート語彙 (name/trackCount/albumCount) のみ。
      // 出入りのたびに sortField を正規化し、どちらのビューでも「効かないソート」が
      // 残らないようにする (setDisplayMode の Albums 正規化と同じ考え方)。
      setViewMode: (mode) =>
        set((state) => {
          const enteringArtists = mode === "artists";
          const valid = enteringArtists
            ? ARTIST_SORT_FIELDS.includes(state.sortField)
            : !ARTIST_ONLY_SORT_FIELDS.includes(state.sortField);
          if (valid) return { viewMode: mode };
          return { viewMode: mode, sortField: "name", sortOrder: "asc" };
        }),
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
      // クレート追加はタブを切り替えない (#151)。
      // 「入った」ことは Crate タブの件数バッジで示す。
      addToCrate: (track) =>
        set((state) =>
          state.crate.some((t) => t.trackId === track.trackId)
            ? {}
            : { crate: [...state.crate, track] },
        ),
      addTracksToCrate: (tracks) =>
        set((state) => {
          if (tracks.length === 0) return {};
          const seen = new Set(state.crate.map((t) => t.trackId));
          const added: Track[] = [];
          for (const track of tracks) {
            if (seen.has(track.trackId)) continue;
            seen.add(track.trackId);
            added.push(track);
          }
          if (added.length === 0) return {};
          return { crate: [...state.crate, ...added] };
        }),
      removeFromCrate: (trackId) =>
        set((state) => {
          const nextAnchors = { ...state.crateAnchors };
          delete nextAnchors[trackId];
          return {
            crate: state.crate.filter((t) => t.trackId !== trackId),
            crateAnchors: nextAnchors,
            crateSections: state.crateSections.filter(
              (s) => s.startTrackId !== trackId,
            ),
          };
        }),
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
      // ステージング set を空にする。旧 set の title/notes が空 crate に残らないよう setMeta も初期化する。
      clearCrate: () => {
        preservedCrateTrackIds = null;
        set({
          crate: [],
          crateAnchors: {},
          crateSections: [],
          setMeta: { ...DEFAULT_SET_META },
        });
      },
      restoreCrateTracks: (tracks) =>
        set((state) => {
          if (tracks.length === 0) return {};
          const restoredIds = new Set(tracks.map((t) => t.trackId));
          // 永続化された順を優先。再水和中にユーザーが足した曲は末尾に残す。
          const extras = state.crate.filter((t) => !restoredIds.has(t.trackId));
          const merged =
            state.crate.length === 0 ? tracks : [...tracks, ...extras];
          const ids = new Set(merged.map((t) => t.trackId));
          // 部分 restore 時に欠落 track の orphan anchors/sections を落とす
          const nextAnchors: CrateAnchors = {};
          for (const [k, v] of Object.entries(state.crateAnchors)) {
            const id = Number(k);
            if (ids.has(id)) nextAnchors[id] = v;
          }
          const nextSections = state.crateSections.filter((s) =>
            ids.has(s.startTrackId),
          );
          return {
            crate: merged,
            crateAnchors: nextAnchors,
            crateSections: nextSections,
          };
        }),

      // Set Workspace
      setSetMeta: (partial) =>
        set((state) => ({
          setMeta: { ...state.setMeta, ...partial },
        })),
      setTrackAnchor: (trackId, kind) =>
        set((state) => {
          const next = { ...state.crateAnchors };
          if (kind == null) delete next[trackId];
          else next[trackId] = kind;
          return { crateAnchors: next };
        }),
      setSections: (sections) => set({ crateSections: sections }),
      addSection: (startTrackId, name) =>
        set((state) => {
          const trimmed = name.trim() || "Section";
          // 同じ startTrackId があればリネーム
          const existing = state.crateSections.find(
            (s) => s.startTrackId === startTrackId,
          );
          if (existing) {
            return {
              crateSections: state.crateSections.map((s) =>
                s.id === existing.id ? { ...s, name: trimmed } : s,
              ),
            };
          }
          return {
            crateSections: [
              ...state.crateSections,
              {
                id: newSectionId(),
                name: trimmed,
                startTrackId,
              },
            ],
          };
        }),
      renameSection: (sectionId, name) =>
        set((state) => ({
          crateSections: state.crateSections.map((s) =>
            s.id === sectionId ? { ...s, name: name.trim() || s.name } : s,
          ),
        })),
      removeSection: (sectionId) =>
        set((state) => ({
          crateSections: state.crateSections.filter((s) => s.id !== sectionId),
        })),
      clearSetMeta: () => set({ setMeta: { ...DEFAULT_SET_META } }),

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
      setRightRailWidth: (width) =>
        set({ rightRailWidth: clampRailWidthToViewport(width) }),
      setRailSplit: (railSplit) => set({ railSplit }),
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
      setLastSyncDestRoot: (lastSyncDestRoot) => set({ lastSyncDestRoot }),

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
      // 既定ではタブを切り替えない (#151)。Similar タブのインジケータで示す。
      // focus: true は「Find similar」など、そこへ行きたいことが明らかな操作だけ。
      setSimilarBase: (trackId, opts) =>
        set(
          trackId != null
            ? opts?.focus
              ? { similarBaseTrackId: trackId, railTab: "similar" as const }
              : { similarBaseTrackId: trackId }
            : { similarBaseTrackId: null },
        ),
      setSimilarFilters: (patch) =>
        set((state) => ({ similarFilters: { ...state.similarFilters, ...patch } })),
      setPendingUpdate: (pendingUpdate) => set({ pendingUpdate }),

      setAuditionMode: (auditionMode) => set({ auditionMode }),
      enterPreview: (previewReturn) =>
        set({ previewActive: true, previewReturn }),
      exitPreviewSession: () =>
        set({ previewActive: false, previewReturn: null }),

      setTriageMode: (triageMode) => set({ triageMode }),
      setTriageIndex: (triageIndex) => set({ triageIndex }),
      setInboxCount: (inboxCount) => set({ inboxCount }),
      enterTriage: (startIndex = 0) =>
        set({ triageMode: true, triageIndex: Math.max(0, startIndex) }),
      exitTriage: () => set({ triageMode: false, triageIndex: 0 }),

      pushToast: (kind, message, durationMs = 3200) => {
        const id = ++toastSeq;
        set((state) => ({
          toasts: [...state.toasts, { id, kind, message, durationMs }],
        }));
        return id;
      },
      dismissToast: (id) =>
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
      bumpArtworkEpoch: () => set((s) => ({ artworkEpoch: s.artworkEpoch + 1 })),
    }),
    {
      name: "itunes-viewer-settings",
      storage: createJSONStorage(() => localStorage),
      version: 16,
      partialize: (state) =>
        ({
          fields: state.fields,
          fieldWidths: state.fieldWidths,
          nameColWidth: state.nameColWidth,
          rightRailVisible: state.rightRailVisible,
          rightRailWidth: state.rightRailWidth,
          railSplit: state.railSplit,
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
          lastSyncDestRoot: state.lastSyncDestRoot,
          similarFilters: state.similarFilters,
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
        // v11: サーバー取り寄せの前回保存先を追加。
        if (version < 11 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (p.lastSyncDestRoot === undefined) p.lastSyncDestRoot = null;
        }
        // v12: 選曲ワークベンチ — 右ペイン幅と Crate/Similar 分割表示。
        if (version < 12 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (typeof p.rightRailWidth !== "number") {
            p.rightRailWidth = RIGHT_RAIL_WIDTH_DEFAULT;
          } else {
            p.rightRailWidth = clampRightRailWidth(p.rightRailWidth as number);
          }
          if (typeof p.railSplit !== "boolean") p.railSplit = false;
        }
        // v13: Audition モード設定。
        // v14 で永続化をやめたため、ここでは何もしない（下の v14 で破棄する）。
        // v14: Audition モードは永続化しない (#150)。旧データのキーを破棄して
        // 起動ごとに OFF から始める。
        if (version < 14 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          delete p.auditionMode;
        }
        // v15: Similar タブの絞り込み条件を永続化 (#151)。旧データには無いので既定で補完。
        if (version < 15 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          const f = p.similarFilters;
          p.similarFilters = {
            ...DEFAULT_SIMILAR_FILTERS,
            ...(typeof f === "object" && f !== null ? f : {}),
          };
        }
        // v16: Artists ビュー専用のソート (trackCount/albumCount) を追加 (#155)。
        // viewMode は永続化しないので、Artists ビューで終了した設定のまま起動すると
        // List ビューで効かないソートになる。旧データは name 昇順へ戻す。
        if (version < 16 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if (ARTIST_ONLY_SORT_FIELDS.includes(p.sortField as SortField)) {
            p.sortField = "name";
            p.sortOrder = "asc";
          }
        }
        return persisted as PersistedSettings;
      },
    },
  ),
);

// 右ペイン幅をウィンドウ幅でクランプする（#146）。
// - 起動時（永続化設定のハイドレーション直後）に一度実行。
// - window resize のたびに rAF で間引きながら再実行。
// センターペインが極端に狭い状態で開かれる/リサイズされることを防ぐ。
if (typeof window !== "undefined") {
  const syncRailWidthToViewport = () => {
    const { rightRailWidth } = useStore.getState();
    const clamped = clampRailWidthToViewport(rightRailWidth, window.innerWidth);
    if (clamped !== rightRailWidth) {
      useStore.setState({ rightRailWidth: clamped });
    }
  };
  // create() 完了時点で localStorage からの同期ハイドレーションは済んでいるため、
  // ここで一度呼べば「マウント時」のクランプになる。
  syncRailWidthToViewport();

  let resizeRaf: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeRaf != null) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = null;
      syncRailWidthToViewport();
    });
  });
}

// Set Workspace を localStorage へ同期（crate trackIds + meta/anchors/sections）。
useStore.subscribe((state, prev) => {
  // 再水和完了前は書かない（空 crate のまま persist して trackIds を消すレースを防ぐ）
  if (!setWorkspaceHydrationDone) return;
  if (
    state.crate === prev.crate &&
    state.setMeta === prev.setMeta &&
    state.crateAnchors === prev.crateAnchors &&
    state.crateSections === prev.crateSections
  ) {
    return;
  }
  persistSetWorkspaceSlice(state);
});
