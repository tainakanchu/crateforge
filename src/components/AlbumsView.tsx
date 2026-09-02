import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as audition from "../lib/audition";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { DeleteTracksDialog } from "./DeleteTracksDialog";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import { ALBUM_SORT_FIELDS } from "../types";
import type { Track, Playlist, AlbumRow, SortField, SortOrder } from "../types";

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46; // カード下のアルバム名・曲数ラベルのおよその高さ
const SORT_LINE_H = 15; // ソートキー表示行 (.cov-meta .ls) のおよその高さ

interface AlbumsViewProps {
  onLoadMore: () => void;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[]) => void;
}

// 描画用に正規化したアルバム1枚分の情報。ライブラリスコープ (サーバ集約 AlbumRow) と
// スコープ外 (クライアント束ね) の2系統入力を1本化する。
interface AlbumVM {
  key: string;
  album: string;
  albumArtist: string; // コンピは "Various Artists"
  isCompilation: boolean;
  trackCount: number;
  coverTrackId: number | null;
  coverPath: string | null; // file_exists でなければ null
  totalTimeMs: number;
  // ソート/表示に使うアルバム粒度の集約値。サーバ集約 (AlbumRow) と同じ意味になるよう
  // クライアント束ねでも year=MIN(非 null), dateAdded=MAX, rating=MAX, playCount=SUM で揃える。
  year: number | null;
  dateAdded: string | null;
  rating: number | null;
  playCount: number;
  bpmMin: number | null;
  bpmMax: number | null;
  // null = 未取得 (ライブラリ; 展開・操作時に getAlbumTracks で遅延取得)、
  // 配列 = 取得済み (スコープ外のクライアント束ね)。
  tracks: Track[] | null;
}

interface CoversCtxMenu {
  x: number;
  y: number;
  albumKey: string;
  tracks: Track[];
  trackIds: number[];
  primary: Track;
  headerLabel: string;
}

function ratingToStars(rating: number | null): number {
  if (!rating) return 0;
  return Math.round(rating / 20);
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// サーバ集約の AlbumRow を描画用 AlbumVM へ。曲は展開時に遅延取得するので tracks=null。
function albumRowToVM(r: AlbumRow): AlbumVM {
  return {
    key: r.albumKey,
    album: r.album || "(unknown)",
    albumArtist: r.albumArtist,
    isCompilation: r.isCompilation,
    trackCount: r.trackCount,
    coverTrackId: r.coverTrackId,
    coverPath: r.coverFileExists ? r.coverLocationPath : null,
    totalTimeMs: r.totalTimeMs,
    year: r.year,
    dateAdded: r.dateAdded,
    rating: r.rating,
    playCount: r.playCount,
    bpmMin: r.bpmMin,
    bpmMax: r.bpmMax,
    tracks: null,
  };
}

const ALBUM_SORT_SET = new Set<string>(ALBUM_SORT_FIELDS);

// 文字列比較。空 (null/空白のみ) は方向によらず末尾に置き、sign は非空同士にだけ効かせる。
function cmpText(a: string | null, b: string | null, sign = 1): number {
  const av = (a ?? "").trim();
  const bv = (b ?? "").trim();
  if (!av || !bv) return av === bv ? 0 : av ? -1 : 1;
  return sign * av.localeCompare(bv, undefined, { sensitivity: "base", numeric: true });
}

// null を方向によらず末尾に置く比較 (サーバの `(x IS NULL), x {dir}` と同じ挙動)。
function cmpNullsLast<T>(
  a: T | null,
  b: T | null,
  sign: number,
  cmp: (x: T, y: T) => number,
): number {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1;
  return sign * cmp(a, b);
}

const cmpNum = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
const cmpIso = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/// Albums グリッドの比較関数。ALBUM_SORT_FIELDS 外の sortField (List ビュー由来の
/// bpm/trackNumber 等) はアルバム粒度で意味を持たないので albumArtist→album に倒す。
/// 二次キーはサーバの album_order_by と同じ並び、最後は albumKey で必ず安定させる。
function albumComparator(
  sortField: SortField,
  sortOrder: SortOrder,
): (a: AlbumVM, b: AlbumVM) => number {
  const field = ALBUM_SORT_SET.has(sortField) ? sortField : "albumArtist";
  const sign = sortOrder === "desc" ? -1 : 1;
  return (a, b) => {
    let c = 0;
    switch (field) {
      case "album":
        c = cmpText(a.album, b.album, sign) || cmpText(a.albumArtist, b.albumArtist);
        break;
      case "year":
        c =
          cmpNullsLast(a.year, b.year, sign, cmpNum) ||
          cmpText(a.albumArtist, b.albumArtist) ||
          cmpText(a.album, b.album);
        break;
      case "dateAdded":
        c =
          cmpNullsLast(a.dateAdded || null, b.dateAdded || null, sign, cmpIso) ||
          cmpText(a.albumArtist, b.albumArtist) ||
          cmpText(a.album, b.album);
        break;
      case "rating":
        c =
          cmpNullsLast(a.rating, b.rating, sign, cmpNum) ||
          cmpText(a.albumArtist, b.albumArtist) ||
          cmpText(a.album, b.album);
        break;
      case "playCount":
        c =
          sign * cmpNum(a.playCount, b.playCount) ||
          cmpText(a.albumArtist, b.albumArtist) ||
          cmpText(a.album, b.album);
        break;
      default: // albumArtist
        c = cmpText(a.albumArtist, b.albumArtist, sign) || cmpText(a.album, b.album);
        break;
    }
    // 最終タイブレーク: 束ねキー (安定化)。
    return c || (a.key === b.key ? 0 : a.key < b.key ? -1 : 1);
  };
}

// ロード済みトラックをクライアント側でアルバム単位に束ねる (スコープ外: プレイリスト/検索/最近)。
// 束ねキーの優先順位はサーバの ALBUM_KEY_EXPR と一致させる (album 空を先に判定):
//   album 空    → tr:<trackId>           (巨大な「(unknown)」へ吸い込まれないように)
//   compilation → cmp:<album>            (アルバムアーティストが違っても album だけで束ねる)
//   それ以外    → al:<albumArtist|artist>␟<album>
// アルバム内は disc→track 順 (multi-disc を正しく並べる)。
// 束ね後はライブラリスコープ (サーバ ORDER BY) と同じ規則でグリッド順にソートする。
function groupAlbums(tracks: Track[], sortField: SortField, sortOrder: SortOrder): AlbumVM[] {
  const map = new Map<string, { vm: AlbumVM; cover: Track | null }>();
  const order: string[] = [];
  for (const t of tracks) {
    const albumName = (t.album || "").trim();
    const isCmp = t.compilation === true;
    const key = !albumName
      ? `tr:${t.trackId}`
      : isCmp
        ? `cmp:${albumName.toLowerCase()}`
        : `al:${(t.albumArtist || t.artist || "").toLowerCase()}␟${albumName.toLowerCase()}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        vm: {
          key,
          album: albumName || t.name || "(unknown)",
          albumArtist: isCmp ? "Various Artists" : t.albumArtist || t.artist || "",
          isCompilation: isCmp,
          trackCount: 0,
          coverTrackId: null,
          coverPath: null,
          totalTimeMs: 0,
          year: null,
          dateAdded: null,
          rating: null,
          playCount: 0,
          bpmMin: null,
          bpmMax: null,
          tracks: [],
        },
        cover: null,
      };
      map.set(key, entry);
      order.push(key);
    }
    entry.vm.tracks!.push(t);
    // カバー代表曲は file_exists を優先 (先頭曲 → 最初の実在曲へ昇格)。
    if (!entry.cover || (!entry.cover.fileExists && t.fileExists)) entry.cover = t;
  }
  const out: AlbumVM[] = [];
  for (const key of order) {
    const { vm, cover } = map.get(key)!;
    const ts = vm.tracks!;
    // disc→track 順。番号が無いものは末尾へ。
    ts.sort((a, b) => {
      const av = (a.discNumber ?? 0) * 100000 + (a.trackNumber ?? 1e9);
      const bv = (b.discNumber ?? 0) * 100000 + (b.trackNumber ?? 1e9);
      return av - bv;
    });
    vm.trackCount = ts.length;
    vm.totalTimeMs = ts.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
    const bpms = ts.map((t) => t.bpm).filter((b): b is number => b != null);
    vm.bpmMin = bpms.length ? Math.min(...bpms) : null;
    vm.bpmMax = bpms.length ? Math.max(...bpms) : null;
    // サーバ集約と同じ意味づけ: year=MIN(非 null) / dateAdded=MAX / rating=MAX / playCount=SUM。
    const years = ts.map((t) => t.year).filter((y): y is number => y != null);
    vm.year = years.length ? Math.min(...years) : null;
    const dates = ts.map((t) => t.dateAdded).filter((d): d is string => !!d);
    vm.dateAdded = dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
    const ratings = ts.map((t) => t.rating).filter((r): r is number => r != null);
    vm.rating = ratings.length ? Math.max(...ratings) : null;
    vm.playCount = ts.reduce((s, t) => s + (t.playCount ?? 0), 0);
    vm.coverTrackId = cover?.trackId ?? null;
    vm.coverPath = cover && cover.fileExists ? cover.locationPath : null;
    out.push(vm);
  }
  out.sort(albumComparator(sortField, sortOrder));
  return out;
}

/// カード下に出す「今のソートキーの値」ラベル。album/albumArtist はカード本文と
/// 重複するので出さない (null を返す)。
function sortKeyLabel(vm: AlbumVM, sortField: SortField): string | null {
  switch (sortField) {
    case "year":
      return vm.year != null ? String(vm.year) : null;
    case "dateAdded":
      return vm.dateAdded ? `Added ${vm.dateAdded.slice(0, 10)}` : null;
    case "rating": {
      const n = ratingToStars(vm.rating);
      return n > 0 ? "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n)) : null;
    }
    case "playCount":
      return vm.playCount > 0 ? `${vm.playCount} play${vm.playCount === 1 ? "" : "s"}` : null;
    default:
      return null;
  }
}

type Row = { type: "grid"; albums: AlbumVM[] } | { type: "expand"; album: AlbumVM };

/// アート前面のブラウズビュー。アルバム単位でまとめ、クリックで曲一覧を展開する。
/// 入力は2系統:
///  - ライブラリスコープ (検索なしの全ライブラリ): store.albums (サーバ集約) を表示し、
///    曲は展開・操作時に getAlbumTracks で遅延取得してキャッシュする。
///  - スコープ外 (プレイリスト/検索/最近): ロード済み tracks をクライアント束ねする。
export function AlbumsView({ onLoadMore, onTracksChanged, onEditTrack, onConvert }: AlbumsViewProps) {
  const {
    tracks,
    albums: storeAlbums,
    albumsHasMore,
    hasMore,
    isLoading,
    playback,
    crate,
    addToCrate,
    playlists,
    viewMode,
    selectedPlaylistId,
    searchQuery,
    filterTags,
    recentPlaylistIds,
    pushRecentPlaylist,
    setSimilarBase,
    sortField,
    sortOrder,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CoversCtxMenu | null>(null);
  const [showAddTagDialog, setShowAddTagDialog] = useState(false);
  const [newTag, setNewTag] = useState("");
  // 削除確認モーダルの対象曲（null で非表示）。
  const [deleteTargets, setDeleteTargets] = useState<Track[] | null>(null);
  // ライブラリスコープの遅延取得キャッシュ (albumKey → tracks)。
  const [trackCache, setTrackCache] = useState<Map<string, Track[]>>(new Map());

  // スコープ判定: 検索なしのライブラリ全体ならサーバ集約 (store.albums) を使う。
  const combinedQuery = [searchQuery.trim(), ...filterTags].filter(Boolean).join(" ");
  const isLibraryScope = viewMode === "library" && !combinedQuery;

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ライブラリスコープはサーバ ORDER BY 済み。スコープ外は同じ規則でクライアントソートする。
  const albums = useMemo<AlbumVM[]>(
    () =>
      isLibraryScope
        ? storeAlbums.map(albumRowToVM)
        : groupAlbums(tracks, sortField, sortOrder),
    [isLibraryScope, storeAlbums, tracks, sortField, sortOrder],
  );
  // ソートキーがアルバム粒度で意味を持ち、かつカード本文と重複しないときだけ補助行を出す。
  const showSortLine =
    ALBUM_SORT_SET.has(sortField) && sortField !== "album" && sortField !== "albumArtist";
  const moreAvailable = isLibraryScope ? albumsHasMore : hasMore;
  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  // vm の曲が手元にあれば返す (クライアント束ね=常にあり、ライブラリ=取得済みならキャッシュから)。
  const knownTracks = useCallback(
    (vm: AlbumVM): Track[] | null => vm.tracks ?? trackCache.get(vm.key) ?? null,
    [trackCache],
  );

  // ライブラリスコープのアルバムの曲を遅延取得してキャッシュする。
  const ensureTracks = useCallback(
    async (vm: AlbumVM): Promise<Track[]> => {
      if (vm.tracks) return vm.tracks;
      const cached = trackCache.get(vm.key);
      if (cached) return cached;
      try {
        const ts = await libraryApi.getAlbumTracks(vm.key);
        setTrackCache((prev) => {
          const next = new Map(prev);
          next.set(vm.key, ts);
          return next;
        });
        return ts;
      } catch (err) {
        console.error("Failed to load album tracks:", err);
        return [];
      }
    },
    [trackCache],
  );

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  // グリッド行 (cols 枚ずつ) に、展開中アルバムの曲一覧行を差し込んだ仮想行リスト。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < albums.length; i += cols) {
      const chunk = albums.slice(i, i + cols);
      out.push({ type: "grid", albums: chunk });
      for (const al of chunk) {
        if (expanded === al.key) out.push({ type: "expand", album: al });
      }
    }
    return out;
  }, [albums, cols, expanded]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) =>
      rows[i].type === "grid" ? cardW + META_H + (showSortLine ? SORT_LINE_H : 0) + GAP : 260,
    overscan: 6,
    paddingStart: 18,
    paddingEnd: 18,
  });

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardW, cols, expanded, rows.length]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !moreAvailable) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, moreAvailable, onLoadMore]);

  const toggleExpand = useCallback(
    (vm: AlbumVM) => {
      const willOpen = expanded !== vm.key;
      setExpanded(willOpen ? vm.key : null);
      // 開くなら曲を先取り (キャッシュ済みなら no-op)。
      if (willOpen && vm.tracks == null) void ensureTracks(vm);
    },
    [expanded, ensureTracks],
  );

  // 解決済みトラックを頭から (または指定トラックから) 再生。
  const playTracks = useCallback(async (ts: Track[], startId?: number) => {
    const ids = ts.filter((t) => t.fileExists).map((t) => t.trackId);
    if (ids.length === 0) return;
    const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
    try {
      await audition.ensureNormalPlay();
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(ids[start]);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  }, []);

  // アルバムを再生 (必要なら曲を取得してから)。
  const playAlbum = useCallback(
    async (vm: AlbumVM, startId?: number) => {
      const ts = await ensureTracks(vm);
      await playTracks(ts, startId);
    },
    [ensureTracks, playTracks],
  );

  const addAlbumToCrate = useCallback(
    async (vm: AlbumVM) => {
      const ts = await ensureTracks(vm);
      for (const t of ts) addToCrate(t);
    },
    [ensureTracks, addToCrate],
  );

  // ---- 右クリックメニュー ----
  const closeMenu = useCallback(() => setContextMenu(null), []);

  const openAlbumMenu = useCallback(
    async (e: React.MouseEvent, vm: AlbumVM) => {
      e.preventDefault();
      e.stopPropagation();
      // await をまたぐので座標は先に取り出しておく。
      const x = e.clientX;
      const y = e.clientY;
      const ts = await ensureTracks(vm);
      if (ts.length === 0) return;
      setContextMenu({
        x,
        y,
        albumKey: vm.key,
        tracks: ts,
        trackIds: ts.map((t) => t.trackId),
        primary: ts[0],
        headerLabel: ts.length > 1 ? `${vm.album} · ${ts.length} tracks` : vm.album,
      });
    },
    [ensureTracks],
  );

  const openTrackMenu = useCallback(
    (e: React.MouseEvent, albumTracks: Track[], albumKey: string, track: Track) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        albumKey,
        tracks: albumTracks,
        trackIds: [track.trackId],
        primary: track,
        headerLabel: track.name || "(unknown)",
      });
    },
    [],
  );

  const handleSetRating = useCallback(
    async (stars: number) => {
      if (!contextMenu) return;
      const rating = stars * 20;
      try {
        for (const id of contextMenu.trackIds) await libraryApi.setTrackRating(id, rating);
        onTracksChanged();
      } catch (err) {
        console.error("Failed to set rating:", err);
      }
    },
    [contextMenu, onTracksChanged],
  );

  const handleAddToCrate = useCallback(() => {
    if (!contextMenu) return;
    contextMenu.tracks.forEach((t) => addToCrate(t));
    closeMenu();
  }, [contextMenu, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    for (const id of contextMenu.trackIds) await playbackApi.enqueueTrack(id);
    closeMenu();
  }, [contextMenu, closeMenu]);

  // 「次に再生」: enqueueTrackNext は現在曲の直後へ1曲ずつ挿入するため、
  // 反転してから入れると最終的な並びが選択順どおりになる。
  const handlePlayNext = useCallback(async () => {
    if (!contextMenu) return;
    for (const id of [...contextMenu.trackIds].reverse()) {
      await playbackApi.enqueueTrackNext(id);
    }
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleAnalyze = useCallback(async () => {
    if (!contextMenu) return;
    try {
      await analysisApi.analyzeTracks(contextMenu.trackIds, true);
    } catch (err) {
      console.error("Failed to queue analysis:", err);
    }
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleFindSimilar = useCallback(() => {
    if (!contextMenu) return;
    // 明示的な「Find similar」なので Similar タブへフォーカスする (#151)
    setSimilarBase(contextMenu.primary.trackId, { focus: true });
    closeMenu();
  }, [contextMenu, setSimilarBase, closeMenu]);

  const handleConvert = useCallback(() => {
    if (!contextMenu) return;
    onConvert(contextMenu.trackIds);
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  // Finder / エクスプローラで表示（単曲メニューのときのみ有効）。
  const handleReveal = useCallback(async () => {
    const path = contextMenu?.primary.locationPath;
    if (!path) return;
    try {
      await libraryApi.revealInFileManager(path);
    } catch (err) {
      pushToast("error", `ファイルマネージャで表示できませんでした: ${err}`);
    }
    closeMenu();
  }, [contextMenu, closeMenu, pushToast]);

  // 削除対象はメニューの操作対象 (trackIds) と揃える。
  // アルバムのカバーから開いた場合はアルバム全曲が対象になる。
  const handleDelete = useCallback(() => {
    if (!contextMenu) return;
    const ids = new Set(contextMenu.trackIds);
    const targets = contextMenu.tracks.filter((t) => ids.has(t.trackId));
    setDeleteTargets(targets.length > 0 ? targets : [contextMenu.primary]);
    closeMenu();
  }, [contextMenu, closeMenu]);

  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack(contextMenu.tracks.length > 0 ? contextMenu.tracks : [contextMenu.primary]);
    closeMenu();
  }, [contextMenu, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      if (!contextMenu) return;
      try {
        await playlistsApi.addTracksToPlaylist(playlistId, contextMenu.trackIds);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
      } catch (err) {
        pushToast("error", `追加に失敗しました: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu, pushToast],
  );

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    try {
      for (const id of contextMenu.trackIds) {
        await playlistsApi.removeTrackFromPlaylist(selectedPlaylistId, id);
      }
      onTracksChanged();
    } catch (err) {
      pushToast("error", `削除に失敗しました: ${err}`);
    }
    closeMenu();
  }, [contextMenu, viewMode, selectedPlaylistId, onTracksChanged, closeMenu, pushToast]);

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    if (!tag || !contextMenu) {
      setShowAddTagDialog(false);
      return;
    }
    try {
      await libraryApi.addGenreTag(contextMenu.trackIds, tag);
      onTracksChanged();
    } catch (err) {
      pushToast("error", `タグの追加に失敗しました: ${err}`);
    }
    setShowAddTagDialog(false);
    setNewTag("");
    closeMenu();
  }, [newTag, contextMenu, onTracksChanged, closeMenu, pushToast]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!contextMenu) return;
      try {
        await libraryApi.removeGenreTag(contextMenu.trackIds, tag);
        onTracksChanged();
      } catch (err) {
        pushToast("error", `タグの削除に失敗しました: ${err}`);
      }
      closeMenu();
    },
    [contextMenu, onTracksChanged, closeMenu, pushToast],
  );

  // メニュー表示用の派生値 (レーティングは最新の tracks から引き直す)。
  const ctxPrimary = contextMenu
    ? tracks.find((t) => t.trackId === contextMenu.primary.trackId) ?? contextMenu.primary
    : null;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxPrimary?.genre ? ctxPrimary.genre.split(/\s+/).filter(Boolean) : [];

  if (albums.length === 0 && !isLoading) {
    return (
      <div className="cb-grid-wrap">
        <div className="cb-empty">
          No tracks. Import an iTunes Library XML, rip a CD, or add files to get started.
        </div>
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={parentRef} onScroll={handleScroll} onClick={closeMenu}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((vRow) => {
          const row = rows[vRow.index];
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {row.type === "grid" ? (
                <div
                  style={{
                    display: "grid",
                    // minmax(0,1fr): 列がコンテンツ最小幅で膨張する grid blowout を防ぐ
                    // （アルバム名ラベルの折り返さない CJK 文字で起きていた）。
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gap: GAP,
                    padding: `0 ${PAD_X}px ${GAP}px`,
                  }}
                >
                  {row.albums.map((al) => {
                    const kt = knownTracks(al);
                    const allIn = kt ? kt.length > 0 && kt.every((t) => crateSet.has(t.trackId)) : false;
                    const isCurrent = kt ? kt.some((t) => playback.currentTrackId === t.trackId) : false;
                    const isOpen = expanded === al.key;
                    const sortLabel = showSortLine ? sortKeyLabel(al, sortField) : null;
                    return (
                      <div key={al.key} className="cb-cardwrap">
                        <div
                          className={
                            "cb-card" +
                            (allIn ? " incrate" : "") +
                            (isCurrent ? " playing" : "") +
                            (isOpen ? " opened" : "")
                          }
                          style={{ background: artGradient(al.album), height: cardW }}
                          onClick={() => toggleExpand(al)}
                          onDoubleClick={() => playAlbum(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                        >
                          <span className="glyph">{leadingGlyph(al.album)}</span>
                          <ArtworkImg path={al.coverPath} />
                          <span className="grad" />
                          <div className="kbtag">
                            {al.trackCount > 1 && (
                              <span title={`${al.trackCount} tracks`}>{al.trackCount}</span>
                            )}
                          </div>
                          <button
                            className="cov-play"
                            title="Play album"
                            onClick={(e) => {
                              e.stopPropagation();
                              playAlbum(al);
                            }}
                          >
                            <Icon name="play" size={20} fill="currentColor" stroke={0} />
                          </button>
                          {allIn ? (
                            <span
                              className="addbtn"
                              style={{ opacity: 1, transform: "none" }}
                              title="All in crate"
                            >
                              <Icon name="check" size={17} />
                            </span>
                          ) : (
                            <button
                              className="addbtn"
                              title="Add album to crate"
                              onClick={(e) => {
                                e.stopPropagation();
                                addAlbumToCrate(al);
                              }}
                            >
                              <Icon name="plus" size={17} />
                            </button>
                          )}
                          <span className="cov-chev" data-open={isOpen ? "1" : "0"}>
                            <Icon name="chevronD" size={15} />
                          </span>
                        </div>
                        <div
                          className="cov-meta"
                          onClick={() => toggleExpand(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                          title={`${al.album} — ${al.albumArtist}`}
                        >
                          <div className="cj">{al.album}</div>
                          <div className="la">{al.albumArtist}</div>
                          {showSortLine && <div className="ls cb-dim">{sortLabel ?? "—"}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <AlbumExpansion
                  vm={row.album}
                  tracks={knownTracks(row.album)}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onPlayTrack={(id) => playAlbum(row.album, id)}
                  onAddTrack={addToCrate}
                  onTrackContextMenu={(e, t) =>
                    openTrackMenu(e, knownTracks(row.album) ?? [], row.album.key, t)
                  }
                  onClose={() => toggleExpand(row.album)}
                />
              )}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}

      {contextMenu && ctxPrimary && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          headerLabel={contextMenu.headerLabel}
          ratingStars={ratingToStars(ctxPrimary.rating)}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={viewMode === "playlist"}
          revealPath={
            // 「表示」は単曲メニューのみ。アルバム全体・ファイル欠損時は無効表示。
            contextMenu.trackIds.length === 1 && ctxPrimary.fileExists
              ? ctxPrimary.locationPath
              : null
          }
          deleteCount={contextMenu.trackIds.length}
          onClose={closeMenu}
          onPlay={() => {
            void playTracks(contextMenu.tracks, contextMenu.primary.trackId);
            closeMenu();
          }}
          onSetRating={handleSetRating}
          onAddToCrate={handleAddToCrate}
          onPlayNext={handlePlayNext}
          onEnqueue={handleEnqueue}
          onAnalyze={handleAnalyze}
          onFindSimilar={handleFindSimilar}
          onConvert={handleConvert}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
          onReveal={() => void handleReveal()}
          onDelete={handleDelete}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => setShowAddTagDialog(true)}
          onRemoveTag={handleRemoveTag}
        />
      )}

      {deleteTargets && (
        <DeleteTracksDialog
          tracks={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDeleted={() => {
            // アルバム展開のキャッシュに消えた曲が残らないよう捨てる。
            setTrackCache(new Map());
            onTracksChanged();
          }}
        />
      )}

      {showAddTagDialog && (
        <div className="modal-overlay" onClick={() => setShowAddTagDialog(false)}>
          <div className="modal" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <Icon name="tag" size={16} /> Add genre tag
              </h2>
              <button className="modal-close" onClick={() => setShowAddTagDialog(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: 16 }}>
              <input
                autoFocus
                type="text"
                className="rip-input"
                placeholder="e.g. House"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleApplyAddTag();
                  if (e.key === "Escape") setShowAddTagDialog(false);
                }}
                style={{ width: "100%" }}
              />
              <div
                style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}
              >
                <button className="toolbar-btn" onClick={() => setShowAddTagDialog(false)}>
                  Cancel
                </button>
                <button className="toolbar-btn primary" onClick={handleApplyAddTag}>
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AlbumExpansionProps {
  vm: AlbumVM;
  tracks: Track[] | null;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  onAddTrack: (track: Track) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
  onClose: () => void;
}

function AlbumExpansion({
  vm,
  tracks,
  crateSet,
  currentTrackId,
  onPlayTrack,
  onAddTrack,
  onTrackContextMenu,
  onClose,
}: AlbumExpansionProps) {
  // ライブラリスコープでは曲を遅延取得中の場合がある。
  if (!tracks) {
    return (
      <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
        <div className="cov-exp">
          <div className="cb-loading">Loading…</div>
        </div>
      </div>
    );
  }
  const totalMs = tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
  return (
    // ラッパの padding で行間を確保する（margin だと getBoundingClientRect の
    // 計測高さに含まれず、仮想行が重なってしまうため）。
    <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
      <div className="cov-exp">
      <div className="cov-exp-head">
        <div className="cov-exp-title">
          <span className="t">{vm.album}</span>
          <span className="s">
            {vm.albumArtist} · {tracks.length} tracks · {formatTime(totalMs)}
          </span>
        </div>
        <button className="cov-exp-close" title="Collapse" onClick={onClose}>
          <Icon name="chevronD" size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div className="cov-trks">
        {tracks.map((t, i) => {
          const isIn = crateSet.has(t.trackId);
          const isCurrent = currentTrackId === t.trackId;
          const showArtist = (t.artist || "") !== vm.albumArtist && !!t.artist;
          return (
            <div
              key={t.id}
              className={"cov-trk" + (isCurrent ? " play" : "") + (!t.fileExists ? " missing" : "")}
              onDoubleClick={() => onPlayTrack(t.trackId)}
              onContextMenu={(e) => onTrackContextMenu(e, t)}
            >
              <span className="n">{t.trackNumber ?? i + 1}</span>
              <span className="nm">
                {isCurrent && (
                  <span className="cov-now">
                    <Icon name="play" size={9} fill="currentColor" stroke={0} />
                  </span>
                )}
                {!t.fileExists && (
                  <span className="cb-warn" title="File not found">
                    <Icon name="warning" size={11} />
                  </span>
                )}
                <span className="ell">{t.name || "(unknown)"}</span>
                {showArtist && <span className="sub"> — {t.artist}</span>}
              </span>
              {t.bpm != null && (
                <span className="bpm cb-fmono" style={{ color: bpmColor(t.bpm) }}>
                  {t.bpm}
                </span>
              )}
              <span className="tm cb-fmono">{formatTime(t.totalTimeMs)}</span>
              {isIn ? (
                <span className="cov-trk-add in" title="In crate">
                  <Icon name="check" size={15} />
                </span>
              ) : (
                <button
                  className="cov-trk-add"
                  title="Add to crate"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddTrack(t);
                  }}
                >
                  <Icon name="plus" size={15} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
