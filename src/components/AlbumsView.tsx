import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon, Stars } from "./Icon";
import { ratingToStars, starsText, starsToRating } from "../lib/rating";
import { ArtworkImg } from "./Cover";
import { TrackContextMenu } from "./TrackContextMenu";
import { DeleteTracksDialog } from "./DeleteTracksDialog";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import { ALBUM_SORT_FIELDS } from "../types";
import type { ConvertMode, Track, Playlist, AlbumRow, SortField, SortOrder } from "../types";
import { EmptyState } from "./EmptyState";
import { ANALYZED_BPM_TITLE, effectiveBpm } from "../lib/bpm";
import { splitGenre } from "../lib/genre";
import { albumLabel } from "../lib/unknownLabels";
import {
  GRID_GAP as GAP,
  GRID_META_H as META_H,
  GRID_PAD_X as PAD_X,
  gridLayout,
  gridMetrics,
  relocateExpanded,
} from "../lib/gridRows";
import type { GridExpanded } from "../lib/gridRows";
import { useElementWidth } from "../hooks/useElementWidth";
import { useCardGridVirtualizer } from "../hooks/useCardGridVirtualizer";
import { useWindowedList } from "../hooks/useWindowedList";
import { useListCount } from "../hooks/useListCount";
import { albumScopeOf, resolveTrackListQuery } from "../lib/trackListQuery";
import { PlaceholderCard } from "./PlaceholderCard";
import { formatTotalTime, formatTrackTime } from "../lib/format";
import * as trackActions from "../lib/trackActions";
import { trackApi } from "../lib/trackActionsApi";
import { AddGenreTagDialog } from "./AddGenreTagDialog";
import { CovTrackRow } from "./CovTrackRow";
import { useTrackActionRunner } from "../hooks/useTrackActionRunner";
import { LoadRetry } from "./LoadRetry";

const SORT_LINE_H = 15; // ソートキー表示行 (.cov-meta .ls) のおよその高さ

interface AlbumsViewProps {
  /// ライブラリ変更 (import / rip / 編集) のたびに増える値。変わったら取り直す。
  reloadKey: number;
  onTracksChanged: () => void;
  onEditTrack: (tracks: Track[]) => void;
  onConvert: (trackIds: number[], mode?: ConvertMode) => void;
}

// 描画用に正規化したアルバム1枚分の情報。サーバ集約 (AlbumRow) と、メモリ上の一覧の
// クライアント束ねの2系統入力を1本化する。
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
  // null = 未取得 (サーバ集約; 展開・操作時に getAlbumTracks で遅延取得)、
  // 配列 = 取得済み (メモリ上の一覧のクライアント束ね)。
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



// サーバ集約の AlbumRow を描画用 AlbumVM へ。曲は展開時に遅延取得するので tracks=null。
function albumRowToVM(r: AlbumRow): AlbumVM {
  return {
    key: r.albumKey,
    // 不明なアルバム (unk:) は空文字のまま持ち、描画時に albumLabel でラベル付けする
    // (空のままにするとソートで方向によらず末尾へ置ける)。
    album: r.album,
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

// メモリ上の一覧 (Inbox / 最近再生した曲) の曲をクライアント側でアルバム単位に束ねる。
// 束ねキーの優先順位はサーバの ALBUM_KEY_EXPR と一致させる (album 空を先に判定):
//   album 空    → unk:                   (タグにアルバムが無い曲をまとめた 1 つの「不明なアルバム」)
//   compilation → cmp:<album>            (アルバムアーティストが違っても album だけで束ねる)
//   それ以外    → al:<albumArtist|artist>␟<album>
// アルバム内は disc→track 順 (multi-disc を正しく並べる)。
// 束ね後はサーバ集約 (ORDER BY) と同じ規則でグリッド順にソートする。
function groupAlbums(tracks: Track[], sortField: SortField, sortOrder: SortOrder): AlbumVM[] {
  const map = new Map<string, { vm: AlbumVM; cover: Track | null }>();
  const order: string[] = [];
  for (const t of tracks) {
    const albumName = (t.album || "").trim();
    const isCmp = t.compilation === true;
    const key = !albumName
      ? "unk:"
      : isCmp
        ? `cmp:${albumName.toLowerCase()}`
        : `al:${(t.albumArtist || t.artist || "").toLowerCase()}␟${albumName.toLowerCase()}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        vm: {
          key,
          album: albumName,
          albumArtist: isCmp && albumName ? "Various Artists" : t.albumArtist || t.artist || "",
          isCompilation: isCmp && !!albumName,
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
    if (key === "unk:") {
      // 不明なアルバムは寄せ集め: アーティストが 1 人ならその名前、複数なら空 (サーバ集約と同じ)。
      const artists = new Set(ts.map((t) => (t.albumArtist || t.artist || "").trim().toLowerCase()));
      if (artists.size > 1) vm.albumArtist = "";
    }
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
      return n > 0 ? starsText(n) : null;
    }
    case "playCount":
      return vm.playCount > 0 ? `${vm.playCount} play${vm.playCount === 1 ? "" : "s"}` : null;
    default:
      return null;
  }
}

/** key を除いた Set (含んでいなければ同じ Set を返し、再描画を起こさない)。 */
function withoutKey(set: Set<string>, key: string): Set<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** 展開中のアルバム。位置 (通し番号) と、展開行を描くためのアルバム本体を覚える。 */
type ExpandedAlbum = GridExpanded & { vm: AlbumVM };

/// アート前面のブラウズビュー。アルバム単位でまとめ、クリックで曲一覧を展開する。
/// スクロール範囲は最初からアルバム全件ぶん確保し、見えている範囲のアルバムだけを取得する
/// (docs/library-list/design.md)。入力は2系統:
///  - サーバ集約 (ライブラリ / プレイリスト / 検索): `get_albums` をその範囲で呼ぶ。
///    曲は展開・操作時に getAlbumTracks (同じ範囲) で遅延取得してキャッシュする。
///  - メモリ上の一覧 (Inbox / 最近再生した曲): ストアの tracks をクライアント束ねする。
export function AlbumsView({ reloadKey, onTracksChanged, onEditTrack, onConvert }: AlbumsViewProps) {
  const {
    tracks,
    isLoading,
    playback,
    crate,
    addToCrate,
    playlists,
    viewMode,
    selectedPlaylistId,
    searchQuery,
    searchScope,
    filterTags,
    recentPlaylistIds,
    pushRecentPlaylist,
    setSimilarBase,
    sortField,
    sortOrder,
  } = useStore();
  // グローバルトースト通知
  const pushToast = useStore((s) => s.pushToast);
  const run = useTrackActionRunner();
  // グリッドのスクロール要素。初回描画が空状態 (データ到着前) だと要素が無いので、
  // 付いた時点で幅計測を始められるよう callback ref で持つ (useElementWidth)。
  const { ref: setParentRef, elRef: parentRef, width } = useElementWidth<HTMLDivElement>();
  const [expanded, setExpanded] = useState<ExpandedAlbum | null>(null);
  const [contextMenu, setContextMenu] = useState<CoversCtxMenu | null>(null);
  // ジャンルタグ追加ダイアログの対象曲 (null で非表示)。メニューは項目を選んだ時点で閉じて
  // contextMenu が null になるので、対象は開くときにここへ控えておく。
  const [addTagTargetIds, setAddTagTargetIds] = useState<number[] | null>(null);
  const [newTag, setNewTag] = useState("");
  // 削除確認モーダルの対象曲（null で非表示）。
  const [deleteTargets, setDeleteTargets] = useState<Track[] | null>(null);
  // サーバ集約の遅延取得キャッシュ (albumKey → tracks)。
  const [trackCache, setTrackCache] = useState<Map<string, Track[]>>(new Map());
  // ライブラリが変わったあと、次に使うときに取り直すキャッシュ (albumKey)。
  // カードの「再生中」「Crate 済み」表示には古い内容のまま使い続ける。
  const staleTrackKeys = useRef(new Set<string>());

  // どの範囲のアルバムか。曲の一覧 (TrackTable) と同じ決め方をする。
  const playlistIsSmart =
    playlists.find((p) => p.playlistId === selectedPlaylistId)?.isSmart ?? false;
  const scope = useMemo(
    () =>
      albumScopeOf(
        resolveTrackListQuery({
          viewMode,
          selectedPlaylistId,
          playlistIsSmart,
          searchQuery,
          searchScope,
          filterTags,
          sortField,
          sortOrder,
        }),
      ),
    [viewMode, selectedPlaylistId, playlistIsSmart, searchQuery, searchScope, filterTags, sortField, sortOrder],
  );
  // メモリ上の一覧 (scope が null) はクライアントで束ねる。件数に上限があるので全件を持ってよい。
  const memoryAlbums = useMemo<AlbumVM[] | null>(
    () => (scope ? null : groupAlbums(tracks, sortField, sortOrder)),
    [scope, tracks, sortField, sortOrder],
  );
  // Albums は手動順を持たないので、通常ソートへ倒す。
  const albumSort: SortField = sortField === "playlistOrder" ? "albumArtist" : sortField;
  const listKey = scope
    ? JSON.stringify(["albums", scope.query, scope.playlistId, albumSort, sortOrder])
    : JSON.stringify(["albums-memory", viewMode, sortField, sortOrder]);

  const reportLoadError = useCallback(
    (err: unknown) => {
      console.error("Failed to load albums:", err);
      pushToast("error", `アルバムの取得に失敗しました: ${err}`);
    },
    [pushToast],
  );
  const serverCount = useListCount(
    listKey,
    reloadKey,
    scope ? () => libraryApi.countAlbums(scope) : null,
    reportLoadError,
  );
  const count = memoryAlbums ? memoryAlbums.length : serverCount;
  const fetchPage = useCallback(
    async (offset: number, limit: number): Promise<AlbumVM[]> => {
      if (memoryAlbums) return memoryAlbums.slice(offset, offset + limit);
      if (!scope) return [];
      const rows = await libraryApi.getAlbums(albumSort, sortOrder, limit, offset, scope);
      return rows.map(albumRowToVM);
    },
    [memoryAlbums, scope, albumSort, sortOrder],
  );
  const list = useWindowedList<AlbumVM>({
    key: listKey,
    revision: memoryAlbums ?? reloadKey,
    count: count ?? 0,
    fetchPage,
    onError: reportLoadError,
  });
  const loading = count === null || (memoryAlbums !== null && isLoading);

  // ソートキーがアルバム粒度で意味を持ち、かつカード本文と重複しないときだけ補助行を出す。
  const showSortLine =
    ALBUM_SORT_SET.has(sortField) && sortField !== "album" && sortField !== "albumArtist";
  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  // vm の曲が手元にあれば返す (クライアント束ね=常にあり、サーバ集約=取得済みならキャッシュから)。
  const knownTracks = useCallback(
    (vm: AlbumVM): Track[] | null => vm.tracks ?? trackCache.get(vm.key) ?? null,
    [trackCache],
  );

  // 曲の取得に失敗したアルバム (albumKey)。展開行が「Loading…」のまま止まらないようにする。
  const [loadFailedKeys, setLoadFailedKeys] = useState<Set<string>>(new Set());

  // サーバ集約のアルバムの曲を遅延取得してキャッシュする (取得する範囲はアルバム一覧と同じ)。
  const ensureTracks = useCallback(
    async (vm: AlbumVM): Promise<Track[]> => {
      if (vm.tracks) return vm.tracks;
      const cached = trackCache.get(vm.key);
      if (cached && !staleTrackKeys.current.has(vm.key)) return cached;
      // 取得に失敗したらトーストで知らせて空を返す (再生・キュー・メニューが黙って何もしない、を避ける)。
      // 展開行は失敗の表示 (再試行つき) に切り替える。再試行中は Loading… に戻す。
      setLoadFailedKeys((prev) => withoutKey(prev, vm.key));
      let ts: Track[] = [];
      const ok = await run("loadTracks", async () => {
        ts = await libraryApi.getAlbumTracks(vm.key, scope ?? undefined);
      });
      if (!ok) {
        setLoadFailedKeys((prev) => new Set(prev).add(vm.key));
        return [];
      }
      staleTrackKeys.current.delete(vm.key);
      setTrackCache((prev) => {
        const next = new Map(prev);
        next.set(vm.key, ts);
        return next;
      });
      return ts;
    },
    [trackCache, run, scope],
  );

  // 一覧が切り替わったら (範囲・並び順の変更) 先頭へ戻し、展開と曲のキャッシュを捨てる
  // (同じアルバムでも範囲が違えば曲が違う)。
  useEffect(() => {
    setExpanded(null);
    setTrackCache(new Map());
    staleTrackKeys.current = new Set();
    setLoadFailedKeys(new Set());
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [listKey, parentRef]);

  // ライブラリが変わったら、曲のキャッシュを「取り直し待ち」にし、展開中のアルバムはすぐ取り直す。
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const ensureTracksRef = useRef(ensureTracks);
  ensureTracksRef.current = ensureTracks;
  const trackCacheRef = useRef(trackCache);
  trackCacheRef.current = trackCache;
  useEffect(() => {
    staleTrackKeys.current = new Set(trackCacheRef.current.keys());
    const open = expandedRef.current;
    if (open && open.vm.tracks == null) void ensureTracksRef.current(open.vm);
  }, [reloadKey]);

  // 一覧を取り直したら、展開中のアルバムの位置を合わせ直す (無くなっていれば閉じる)。
  useEffect(() => {
    setExpanded((prev) => {
      if (!prev) return prev;
      const loadedKeys = (function* (): IterableIterator<[number, string]> {
        for (const [i, vm] of list.loaded()) yield [i, vm.key];
      })();
      const next = relocateExpanded(prev, list.count, (i) => list.get(i)?.key, loadedKeys);
      if (!next) return null;
      const vm = list.get(next.index) ?? prev.vm;
      return next === prev && vm === prev.vm ? prev : { ...next, vm };
    });
  }, [list]);

  const { cols, cardW } = gridMetrics(width);

  // カード行 (cols 枚ずつ) に、展開中アルバムの曲一覧行を差し込んだ仮想行の並び。
  const layout = useMemo(() => gridLayout(list.count, cols, expanded), [list.count, cols, expanded]);

  // 行キーの安定化と再計測の規則は useCardGridVirtualizer 側 (展開の開閉では measure() しない)。
  const rowVirtualizer = useCardGridVirtualizer({
    layout,
    scrollRef: parentRef,
    gridRowHeight: cardW + META_H + (showSortLine ? SORT_LINE_H : 0) + GAP,
    onVisibleItems: list.setVisibleRange,
  });

  // index はカードの通し番号 (展開行を差し込む位置を決める)。
  const toggleExpand = useCallback(
    (vm: AlbumVM, index: number) => {
      const willOpen = expanded?.key !== vm.key;
      setExpanded(willOpen ? { key: vm.key, index, vm } : null);
      // 開くなら曲を先取り (キャッシュ済みなら no-op)。
      if (willOpen && vm.tracks == null) void ensureTracks(vm);
    },
    [expanded, ensureTracks],
  );

  // 解決済みトラックを頭から (または指定トラックから) 再生。
  const playTracks = useCallback(async (ts: Track[], startId?: number) => {
    await run("play", () => trackActions.playTracks(trackApi, ts, startId));
  }, [run]);

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
        headerLabel: ts.length > 1 ? `${albumLabel(vm.album)} · ${ts.length} 曲` : albumLabel(vm.album),
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

  // 展開用キャッシュ (trackCache) の取り直しは次に使うときなので、レーティング変更は
  // キャッシュ側にもすぐ反映する (しないと展開中の一覧が取り直しまで古い星のまま残る)。
  const applyRating = useCallback(
    async (trackIds: number[], stars: number) => {
      const rating = starsToRating(stars);
      const ok = await run("rating", () =>
        trackActions.setRatingForTracks(trackApi, trackIds, rating),
      );
      const ids = new Set(trackIds);
      if (!ok) {
        // 複数曲の途中で失敗すると、先に成功した曲だけ値が変わっている。どの曲まで進んだかは
        // 分からないので、一覧と、対象を含む展開キャッシュを取り直して実際の値に合わせる。
        onTracksChanged();
        for (const [key, ts] of trackCache) {
          if (!ts.some((t) => ids.has(t.trackId))) continue;
          try {
            const fresh = await libraryApi.getAlbumTracks(key, scope ?? undefined);
            setTrackCache((prev) => new Map(prev).set(key, fresh));
          } catch (err) {
            console.error("Failed to reload album tracks:", err);
          }
        }
        return false;
      }
      setTrackCache((prev) => {
        let next: Map<string, Track[]> | null = null;
        for (const [key, ts] of prev) {
          if (!ts.some((t) => ids.has(t.trackId))) continue;
          next ??= new Map(prev);
          next.set(key, ts.map((t) => (ids.has(t.trackId) ? { ...t, rating } : t)));
        }
        return next ?? prev;
      });
      onTracksChanged();
      return true;
    },
    [onTracksChanged, run, trackCache, scope],
  );

  const handleSetRating = useCallback(
    async (stars: number) => {
      if (!contextMenu) return;
      const menu = contextMenu;
      // 星はメニューを開いたまま付け直せるが、失敗したら (プレビューの星が残らないよう) 閉じる。
      // 待っている間に別のメニューが開かれていたら、そちらは閉じない。
      if (!(await applyRating(menu.trackIds, stars))) {
        setContextMenu((cur) => (cur === menu ? null : cur));
      }
    },
    [contextMenu, applyRating],
  );

  // メニューの操作対象 (trackIds) だけを入れる。contextMenu.tracks はアルバム全曲なので、
  // 展開した曲一覧の 1 曲から開いたときにアルバムごと入ってしまわないよう絞り込む。
  const ctxTargetTracks = useCallback((): Track[] => {
    if (!contextMenu) return [];
    const ids = new Set(contextMenu.trackIds);
    const targets = contextMenu.tracks.filter((t) => ids.has(t.trackId));
    return targets.length > 0 ? targets : [contextMenu.primary];
  }, [contextMenu]);

  const handleAddToCrate = useCallback(() => {
    if (!contextMenu) return;
    ctxTargetTracks().forEach((t) => addToCrate(t));
    closeMenu();
  }, [contextMenu, ctxTargetTracks, addToCrate, closeMenu]);

  const handleEnqueue = useCallback(async () => {
    if (!contextMenu) return;
    const ids = contextMenu.trackIds;
    closeMenu();
    await run("enqueue", () => trackActions.enqueueTracks(trackApi, ids));
  }, [contextMenu, closeMenu, run]);

  // 「次に再生」: 現在曲の直後に選択順で並ぶ (挿入順の反転は playNextTracks 側)。
  const handlePlayNext = useCallback(async () => {
    if (!contextMenu) return;
    const ids = contextMenu.trackIds;
    closeMenu();
    await run("playNext", () => trackActions.playNextTracks(trackApi, ids));
  }, [contextMenu, closeMenu, run]);

  const handleAnalyze = useCallback(async () => {
    if (!contextMenu) return;
    const ids = contextMenu.trackIds;
    closeMenu();
    await run("analyze", () => analysisApi.analyzeTracks(ids, true));
  }, [contextMenu, closeMenu, run]);

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

  const handleConvertReplace = useCallback(() => {
    if (!contextMenu) return;
    onConvert(contextMenu.trackIds, "replace");
    closeMenu();
  }, [contextMenu, onConvert, closeMenu]);

  // Finder / エクスプローラで表示（単曲メニューのときのみ有効）。
  const handleReveal = useCallback(async () => {
    const path = contextMenu?.primary.locationPath;
    if (!path) return;
    closeMenu();
    await run("reveal", () => libraryApi.revealInFileManager(path));
  }, [contextMenu, closeMenu, run]);

  // 削除対象はメニューの操作対象 (trackIds) と揃える。
  // アルバムのカバーから開いた場合はアルバム全曲が対象になる。
  const handleDelete = useCallback(() => {
    if (!contextMenu) return;
    setDeleteTargets(ctxTargetTracks());
    closeMenu();
  }, [contextMenu, ctxTargetTracks, closeMenu]);

  // 編集対象も trackIds に揃える (単曲メニューなら 1 曲、アルバムのカバーからなら全曲)。
  const handleGetInfo = useCallback(() => {
    if (!contextMenu) return;
    onEditTrack(ctxTargetTracks());
    closeMenu();
  }, [contextMenu, ctxTargetTracks, onEditTrack, closeMenu]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: number) => {
      if (!contextMenu) return;
      const ids = contextMenu.trackIds;
      closeMenu();
      await run("addToPlaylist", async () => {
        const added = await trackActions.addTracksToPlaylist(trackApi, playlists, playlistId, ids);
        pushRecentPlaylist(playlistId);
        onTracksChanged();
        pushToast("success", trackActions.addedToPlaylistMessage(added));
      });
    },
    [contextMenu, pushRecentPlaylist, onTracksChanged, closeMenu, pushToast, playlists, run],
  );

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!contextMenu || viewMode !== "playlist" || selectedPlaylistId === null) return;
    const ids = contextMenu.trackIds;
    closeMenu();
    await run("removeFromPlaylist", async () => {
      // アルバムのカバーから開いた場合は全曲を 1 回の呼び出し (1 トランザクション) で外す。
      const removed = await playlistsApi.removeTracksFromPlaylist(selectedPlaylistId, ids);
      onTracksChanged();
      if (removed > 1) pushToast("success", `${removed} 曲をプレイリストから外しました`);
    });
  }, [contextMenu, viewMode, selectedPlaylistId, onTracksChanged, closeMenu, pushToast, run]);

  const handleApplyAddTag = useCallback(async () => {
    const tag = newTag.trim();
    const ids = addTagTargetIds;
    setAddTagTargetIds(null);
    if (!tag || !ids || ids.length === 0) return;
    setNewTag("");
    await run("addTag", async () => {
      const result = await libraryApi.addGenreTag(ids, tag);
      onTracksChanged();
      const warning = trackActions.genreFileWriteFailureMessage(result);
      if (warning) pushToast("error", warning);
    });
  }, [newTag, addTagTargetIds, onTracksChanged, run, pushToast]);

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!contextMenu) return;
      const ids = contextMenu.trackIds;
      closeMenu();
      await run("removeTag", async () => {
        const result = await libraryApi.removeGenreTag(ids, tag);
        onTracksChanged();
        const warning = trackActions.genreFileWriteFailureMessage(result);
        if (warning) pushToast("error", warning);
      });
    },
    [contextMenu, onTracksChanged, closeMenu, run, pushToast],
  );

  // メニュー表示用の派生値 (レーティングは最新の曲から引き直す: サーバ集約は展開キャッシュ、
  // メモリ上の一覧はストアの tracks)。
  const ctxPrimary = contextMenu
    ? ((trackCache.get(contextMenu.albumKey) ?? tracks).find(
        (t) => t.trackId === contextMenu.primary.trackId,
      ) ?? contextMenu.primary)
    : null;
  const activePlaylist =
    viewMode === "playlist" && selectedPlaylistId !== null
      ? playlists.find((p) => p.playlistId === selectedPlaylistId)
      : undefined;
  const targetPlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart);
  const recentPlaylists = recentPlaylistIds
    .map((id) => targetPlaylists.find((p) => p.playlistId === id))
    .filter((p): p is Playlist => Boolean(p));
  const ctxGenreTags = ctxPrimary?.genre ? splitGenre(ctxPrimary.genre) : [];

  if (list.count === 0 && !loading) {
    return (
      <div className="cb-grid-wrap">
        <EmptyState />
      </div>
    );
  }

  const items = rowVirtualizer.getVirtualItems();

  return (
    <div className="cb-grid-wrap" ref={setParentRef} onClick={closeMenu}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {items.map((vRow) => {
          const row = layout.rowAt(vRow.index);
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
                  {Array.from({ length: row.end - row.start }, (_, j) => {
                    const index = row.start + j;
                    const al = list.get(index);
                    // 未取得のアルバムは同じ高さのプレースホルダ (届いても行がずれない)。
                    if (!al) {
                      return (
                        <PlaceholderCard
                          key={`ph:${index}`}
                          size={cardW}
                          lines={showSortLine ? 3 : 2}
                        />
                      );
                    }
                    const kt = knownTracks(al);
                    const allIn = kt ? kt.length > 0 && kt.every((t) => crateSet.has(t.trackId)) : false;
                    const isCurrent = kt ? kt.some((t) => playback.currentTrackId === t.trackId) : false;
                    const isOpen = expanded?.key === al.key;
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
                          style={{ background: artGradient(albumLabel(al.album)), height: cardW }}
                          onClick={() => toggleExpand(al, index)}
                          onDoubleClick={() => playAlbum(al)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                        >
                          <span className="glyph">{leadingGlyph(albumLabel(al.album))}</span>
                          <ArtworkImg path={al.coverPath} size={cardW} />
                          <span className="grad" />
                          <div className="kbtag">
                            {al.trackCount > 1 && (
                              <span title={`${al.trackCount} tracks`}>{al.trackCount}</span>
                            )}
                          </div>
                          <button
                            className="cov-play"
                            title="アルバムを再生"
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
                              title="すべて Crate に追加済み"
                            >
                              <Icon name="check" size={17} />
                            </span>
                          ) : (
                            <button
                              className="addbtn"
                              title="アルバムを Crate に追加"
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
                          onClick={() => toggleExpand(al, index)}
                          onContextMenu={(e) => openAlbumMenu(e, al)}
                          title={
                            al.albumArtist
                              ? `${albumLabel(al.album)} — ${al.albumArtist}`
                              : albumLabel(al.album)
                          }
                        >
                          <div className="cj">{albumLabel(al.album)}</div>
                          <div className="la">{al.albumArtist}</div>
                          {showSortLine && <div className="ls cb-dim">{sortLabel ?? "—"}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                expanded && (
                  <AlbumExpansion
                    vm={expanded.vm}
                    tracks={knownTracks(expanded.vm)}
                    loadFailed={loadFailedKeys.has(expanded.key)}
                    onRetry={() => void ensureTracks(expanded.vm)}
                    crateSet={crateSet}
                    currentTrackId={playback.currentTrackId}
                    onPlayTrack={(id) => playAlbum(expanded.vm, id)}
                    onAddTrack={addToCrate}
                    onSetRating={(t, stars) => void applyRating([t.trackId], stars)}
                    onTrackContextMenu={(e, t) =>
                      openTrackMenu(e, knownTracks(expanded.vm) ?? [], expanded.key, t)
                    }
                    onClose={() => setExpanded(null)}
                  />
                )
              )}
            </div>
          );
        })}
      </div>
      {loading && <div className="cb-loading">Loading…</div>}

      {contextMenu && ctxPrimary && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          headerLabel={contextMenu.headerLabel}
          ratingStars={ratingToStars(ctxPrimary.rating)}
          genreTags={ctxGenreTags}
          playlists={playlists}
          recentPlaylists={recentPlaylists}
          showRemoveFromPlaylist={
            // スマート / フォルダは所属を直接持たないので「外す」は出さない。
            !!activePlaylist && !activePlaylist.isSmart && !activePlaylist.isFolder
          }
          revealPath={
            // 「表示」は単曲メニューのみ。アルバム全体・ファイル欠損時は無効表示。
            contextMenu.trackIds.length === 1 && ctxPrimary.fileExists
              ? ctxPrimary.locationPath
              : null
          }
          relocateTrack={
            // 「ファイルの場所を指定…」も単曲メニューのみ。
            contextMenu.trackIds.length === 1 ? ctxPrimary : null
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
          onConvertReplace={handleConvertReplace}
          onGetInfo={handleGetInfo}
          onRemoveFromPlaylist={handleRemoveFromPlaylist}
          onReveal={() => void handleReveal()}
          onDelete={handleDelete}
          onAddToPlaylist={handleAddToPlaylist}
          onAddTag={() => setAddTagTargetIds(contextMenu.trackIds)}
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

      {addTagTargetIds && (
        <AddGenreTagDialog
          value={newTag}
          onChange={setNewTag}
          onSubmit={() => void handleApplyAddTag()}
          onClose={() => setAddTagTargetIds(null)}
        />
      )}
    </div>
  );
}

interface AlbumExpansionProps {
  vm: AlbumVM;
  tracks: Track[] | null;
  /// 曲の取得に失敗している (tracks が null のとき、再試行の表示に切り替える)。
  loadFailed: boolean;
  onRetry: () => void;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  onAddTrack: (track: Track) => void;
  onSetRating: (track: Track, stars: number) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track) => void;
  onClose: () => void;
}

function AlbumExpansion({
  vm,
  tracks,
  loadFailed,
  onRetry,
  crateSet,
  currentTrackId,
  onPlayTrack,
  onAddTrack,
  onSetRating,
  onTrackContextMenu,
  onClose,
}: AlbumExpansionProps) {
  const analysisByTrack = useStore((s) => s.analysisByTrack);
  // ライブラリスコープでは曲を遅延取得中の場合がある。
  if (!tracks) {
    return (
      <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
        <div className="cov-exp">
          {loadFailed ? (
            <LoadRetry message="曲を取得できませんでした" onRetry={onRetry} />
          ) : (
            <div className="cb-loading">Loading…</div>
          )}
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
          <span className="t">{albumLabel(vm.album)}</span>
          <span className="s">
            {[vm.albumArtist, `${tracks.length} tracks`, totalMs > 0 ? formatTotalTime(totalMs) : ""]
              .filter(Boolean)
              .join(" · ")}
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
          // 実効 BPM (タグ ?? 解析値)。解析値は薄く表示する。
          const b = effectiveBpm(t, analysisByTrack.get(t.trackId));
          const stars = ratingToStars(t.rating);
          return (
            <CovTrackRow
              key={`${t.trackId}-${i}`}
              track={t}
              index={i}
              isCurrent={isCurrent}
              inCrate={isIn}
              showArtist={showArtist}
              time={formatTrackTime(t.totalTimeMs)}
              onPlay={() => onPlayTrack(t.trackId)}
              onContextMenu={(e) => onTrackContextMenu(e, t)}
              onAddToCrate={() => onAddTrack(t)}
              extra={
                <>
                  {b ? (
                    <span
                      className="bpm cb-fmono"
                      style={{ color: bpmColor(b.value), opacity: b.fromAnalysis ? 0.6 : undefined }}
                      title={b.fromAnalysis ? ANALYZED_BPM_TITLE : undefined}
                    >
                      {b.value}
                    </span>
                  ) : null}
                  {/* 未評価は行ホバー時だけ出す (全行に空の星が並ぶとうるさいため)。
                      ダブルクリックが行の再生に化けないよう止める。 */}
                  <span
                    className={"rt" + (stars > 0 ? "" : " empty")}
                    title="レーティング (左半分クリックで半星 / 同じ値で解除)"
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <Stars value={stars} size={12} onSet={(n) => onSetRating(t, n)} />
                  </span>
                </>
              }
            />
          );
        })}
      </div>
      </div>
    </div>
  );
}
