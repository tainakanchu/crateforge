import { useCallback, useEffect, useRef, useState } from "react";
import {
  useStore,
  RIGHT_RAIL_WIDTH_DEFAULT,
  RIGHT_RAIL_WIDTH_MIN,
  RIGHT_RAIL_WIDTH_MAX,
} from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon, Stars } from "./Icon";
import { Cover, ArtworkImg } from "./Cover";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { RailTab, Track, SimilarHit } from "../types";

interface RightRailProps {
  onPlaylistsChanged: () => void;
}

/// Up Next の 1 行。order(再生順) 上の絶対位置を併せ持つ。
interface QueueItem {
  track: Track;
  orderIndex: number;
}

const SIMILAR_DRAG_MIME = "application/x-crateforge-track-id";

function clampRailWidth(w: number): number {
  return Math.min(
    RIGHT_RAIL_WIDTH_MAX,
    Math.max(RIGHT_RAIL_WIDTH_MIN, Math.round(w)),
  );
}

function applyRailWidthCss(width: number) {
  const app = document.querySelector(".app") as HTMLElement | null;
  if (app) app.style.setProperty("--rail-w", `${width}px`);
}

function ratingToStars(rating: number | null): number {
  if (!rating) return 0;
  return Math.round(rating / 20);
}

function fmtTotal(tracks: Track[]): string {
  const ms = tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function RightRail({ onPlaylistsChanged }: RightRailProps) {
  const {
    playback,
    tracks,
    crate,
    railTab,
    setRailTab,
    addToCrate,
    addTracksToCrate,
    removeFromCrate,
    reorderCrate,
    setCrateOrder,
    clearCrate,
    shuffle,
    repeat,
    similarBaseTrackId,
    setSimilarBase,
    analysisByTrack,
    pushToast,
    rightRailWidth,
    setRightRailWidth,
    railSplit,
    setRailSplit,
    selectedTrackIds,
  } = useStore();

  const [queueTracks, setQueueTracks] = useState<QueueItem[]>([]);
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [crateExternalOver, setCrateExternalOver] = useState(false);
  const [prevRailTab, setPrevRailTab] = useState<RailTab | null>(null);
  // Similar → Crate DnD 用。dragover では custom MIME が読めないブラウザ向けに ref も併用。
  const similarDragTrackId = useRef<number | null>(null);

  // Save as Playlist のインライン入力用
  const [saveNameInput, setSaveNameInput] = useState<string | null>(null);
  const saveInputRef = useRef<HTMLInputElement | null>(null);

  // Up Next のドラッグ並び替え用。Crate と違いバックエンドが正なので、
  // ドラッグ中はローカルの並びだけ動かし、drop 確定時に moveQueueItem を 1 回だけ呼ぶ。
  //
  // orderIndex は再生順(order)上の絶対位置で、move_order(from, to) は
  // order.remove(from); order.insert(to, v) という絶対インデックスの配列ムーブ。
  // Up Next 配列の k 番目は orderIndex = startAt + k(取得時点のバックエンド並び)。
  // よって from = ドラッグ対象の「元の orderIndex」、
  //       to   = startAt + ドロップ後の配列インデックス、で一意に決まる。
  const qDragIdx = useRef<number | null>(null); // ドラッグ対象の現在の配列インデックス
  const qFromOrder = useRef<number | null>(null); // ドラッグ対象の元 orderIndex(固定)
  const qStartAt = useRef<number>(0); // 取得時点の先頭 orderIndex(= startAt)
  const [qOverIdx, setQOverIdx] = useState<number | null>(null);
  // ポーリングによる再取得がドラッグ中のローカル並びを上書きしないよう抑止する。
  const draggingQueue = useRef(false);

  // リサイズハンドル
  // ドラッグ中は store / localStorage を触らず ref + CSS 変数だけ更新し、
  // pointerup で setRightRailWidth を 1 回呼んで確定する (毎 move の全体 re-render 回避)。
  const resizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(RIGHT_RAIL_WIDTH_DEFAULT);
  const resizeCurrentW = useRef(RIGHT_RAIL_WIDTH_DEFAULT);

  // Similar タブ: 基準は similarBaseTrackId、無ければ再生中の曲。
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [harmonic, setHarmonic] = useState(true);
  const [simLoading, setSimLoading] = useState(false);
  const similarBaseId = similarBaseTrackId ?? playback.currentTrackId;
  const similarBase = similarBaseId != null
    ? tracks.find((t) => t.trackId === similarBaseId) ?? null
    : null;
  const baseAnalyzed = similarBaseId != null && analysisByTrack.has(similarBaseId);
  const showRichMeta = rightRailWidth >= 420;

  // 分割表示: Crate/Similar タブ時に railSplit が ON なら両方を同時表示
  const workbenchSplit =
    railSplit && (railTab === "crate" || railTab === "similar");
  const showCrate = railTab === "crate" || workbenchSplit;
  const showSimilar = railTab === "similar" || workbenchSplit;
  const showNow = railTab === "now" && !workbenchSplit;
  const showNext = railTab === "next" && !workbenchSplit;

  const now = playback.currentTrackId
    ? tracks.find((t) => t.trackId === playback.currentTrackId) ?? null
    : null;

  const switchRailTab = useCallback(
    (tab: RailTab) => {
      setPrevRailTab(railTab);
      setRailTab(tab);
    },
    [railTab, setRailTab],
  );

  const goPrevRailTab = useCallback(() => {
    if (prevRailTab) {
      setRailTab(prevRailTab);
      setPrevRailTab(railTab);
    }
  }, [prevRailTab, railTab, setRailTab]);

  // Up Next: バックエンドのキューを解決する。曲名はロード済み tracks に依存せず
  // getTracksByIds で取り直すため、別ビュー/別ページの曲もタイトル表示できる。
  const aliveRef = useRef(false);
  const loadQueue = useCallback(async () => {
    // ドラッグ中はローカルの並びを正とし、取得結果で上書きしない。
    if (draggingQueue.current) return;
    try {
      const q = await playbackApi.getQueue();
      const startAt = q.currentIndex != null ? q.currentIndex + 1 : 0;
      const upcomingIds = q.trackIds.slice(startAt);
      // 入力順を保って解決(欠損 ID はスキップされる)。
      const resolved =
        upcomingIds.length > 0
          ? await libraryApi.getTracksByIds(upcomingIds)
          : [];
      if (!aliveRef.current || draggingQueue.current) return;
      const byId = new Map(resolved.map((t) => [t.trackId, t]));
      // order(再生順) 上の絶対位置を保持。Up Next からの頭出し/削除/並び替えに使う。
      const upcoming = upcomingIds
        .map((id, idx) => {
          const track = byId.get(id);
          return track ? { track, orderIndex: startAt + idx } : null;
        })
        .filter((x): x is QueueItem => !!x);
      setQueueTracks(upcoming);
    } catch {
      if (aliveRef.current) setQueueTracks([]);
    }
  }, []);

  // Up Next タブを開いているときだけ取得する。
  useEffect(() => {
    if (!showNext) return;
    aliveRef.current = true;
    loadQueue();
    // enqueue や曲の自動遷移を反映するため、表示中は定期的に取り直す。
    const iv = setInterval(loadQueue, 1000);
    // 曲の自動遷移(playback-advanced)で即座に取り直し、1 秒待たずに反映する。
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await playbackApi.onPlaybackAdvanced(() => loadQueue());
    })();
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
      if (unlisten) unlisten();
    };
    // shuffle / repeat 変更で再生順が変わるので Up Next を取り直す。
  }, [showNext, playback.currentTrackId, shuffle, repeat, loadQueue]);

  // Similar: 基準曲が解析済みなら似た曲を取得（harmonic で BPM/Key 互換に絞る）。
  useEffect(() => {
    if (!showSimilar) return;
    if (similarBaseId == null || !baseAnalyzed) {
      setSimilar([]);
      return;
    }
    let alive = true;
    setSimLoading(true);
    (async () => {
      try {
        const opts = harmonic
          ? { limit: 40, bpmTol: 0.08, keyCompatible: true }
          : { limit: 40 };
        const hits = await analysisApi.getSimilar(similarBaseId, opts);
        if (alive) setSimilar(hits);
      } catch {
        if (alive) setSimilar([]);
      } finally {
        if (alive) setSimLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [showSimilar, similarBaseId, harmonic, baseAnalyzed, analysisByTrack]);

  // ── リサイズ ──
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      resizing.current = true;
      resizeStartX.current = e.clientX;
      resizeStartW.current = rightRailWidth;
      resizeCurrentW.current = rightRailWidth;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [rightRailWidth],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return;
    // 左端ハンドル: マウスを左へ動かすと幅が増える
    const next = clampRailWidth(
      resizeStartW.current + (resizeStartX.current - e.clientX),
    );
    resizeCurrentW.current = next;
    applyRailWidthCss(next);
  }, []);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing.current) return;
      resizing.current = false;
      // ドラッグ確定時のみ store / localStorage に書き込む
      setRightRailWidth(resizeCurrentW.current);
      try {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [setRightRailWidth],
  );

  const onResizeDoubleClick = useCallback(() => {
    setRightRailWidth(RIGHT_RAIL_WIDTH_DEFAULT);
    applyRailWidthCss(RIGHT_RAIL_WIDTH_DEFAULT);
  }, [setRightRailWidth]);

  const isSimilarExternalDrag = (dt: DataTransfer) =>
    similarDragTrackId.current != null ||
    Array.from(dt.types as ArrayLike<string>).includes(SIMILAR_DRAG_MIME);

  const onDragStart = (i: number, e: React.DragEvent) => {
    dragIdx.current = i;
    similarDragTrackId.current = null;
    // Crate 並び替えと Similar からの外部 DnD を区別
    e.dataTransfer.setData("application/x-crateforge-crate-reorder", String(i));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    // 外部 (Similar) ドロップ中は並び替えしない
    if (isSimilarExternalDrag(e.dataTransfer)) return;
    const from = dragIdx.current;
    if (from === null || from === i) return;
    setOverIdx(i);
    reorderCrate(from, i);
    dragIdx.current = i;
  };
  const onDragEnd = () => {
    dragIdx.current = null;
    setOverIdx(null);
  };

  // Similar → Crate のドロップ
  const onCrateListDragOver = useCallback((e: React.DragEvent) => {
    if (
      similarDragTrackId.current != null ||
      Array.from(e.dataTransfer.types as ArrayLike<string>).includes(SIMILAR_DRAG_MIME)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setCrateExternalOver(true);
    }
  }, []);

  const onCrateListDragLeave = useCallback((e: React.DragEvent) => {
    // 子要素への移動ではクリアしない
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setCrateExternalOver(false);
  }, []);

  const onCrateListDrop = useCallback(
    async (e: React.DragEvent) => {
      setCrateExternalOver(false);
      const raw =
        e.dataTransfer.getData(SIMILAR_DRAG_MIME) ||
        (similarDragTrackId.current != null
          ? String(similarDragTrackId.current)
          : "");
      similarDragTrackId.current = null;
      if (!raw) return;
      e.preventDefault();
      const trackId = Number(raw);
      if (!Number.isFinite(trackId)) return;
      if (crate.some((c) => c.trackId === trackId)) return;
      // まず similar ヒットや tracks から解決、無ければ API
      const fromSim = similar.find((h) => h.track.trackId === trackId)?.track;
      const fromTracks = tracks.find((t) => t.trackId === trackId);
      let track = fromSim ?? fromTracks ?? null;
      if (!track) {
        try {
          const resolved = await libraryApi.getTracksByIds([trackId]);
          track = resolved[0] ?? null;
        } catch {
          track = null;
        }
      }
      if (track) addToCrate(track);
    },
    [crate, similar, tracks, addToCrate],
  );

  // Save as Playlist ボタン → インライン入力を表示
  const handleSaveAsPlaylistOpen = useCallback(() => {
    if (crate.length === 0) return;
    setSaveNameInput("");
    // 次のフレームで input にフォーカス
    setTimeout(() => saveInputRef.current?.focus(), 0);
  }, [crate]);

  // インライン入力で Enter 確定 or 明示的呼び出し
  const handleSaveAsPlaylistCommit = useCallback(async (name: string) => {
    if (!name.trim()) return;
    setSaveNameInput(null);
    try {
      const pl = await playlistsApi.createPlaylist(name.trim(), null, false);
      await playlistsApi.addTracksToPlaylist(
        pl.playlistId,
        crate.map((t) => t.trackId),
      );
      clearCrate();
      onPlaylistsChanged();
      pushToast("success", `「${name.trim()}」として保存しました`);
    } catch (err) {
      pushToast("error", `プレイリストの保存に失敗しました: ${err}`);
    }
  }, [crate, clearCrate, onPlaylistsChanged, pushToast]);

  const handlePlayCrate = useCallback(async () => {
    if (crate.length === 0) return;
    const ids = crate.map((t) => t.trackId);
    await playbackApi.setQueue(ids, 0);
    await playbackApi.playTrack(ids[0]);
  }, [crate]);

  // 貪欲最近傍で crate を滑らかな並びへ (解析済みの曲が対象)。
  const handleSmoothOrder = useCallback(async () => {
    if (crate.length < 3) return;
    const total = crate.length;
    try {
      const ids = await analysisApi.buildSmoothOrder(crate.map((t) => t.trackId));
      setCrateOrder(ids);
      // 並び替えられた曲数（解析済みのもの）をフィードバック
      const arranged = ids.filter((id) => analysisByTrack.has(id)).length;
      pushToast("success", `${arranged}/${total} 曲をスムーズに並び替えました`);
    } catch (err) {
      console.error("Failed to build smooth order:", err);
      pushToast("error", `スムーズ並び替えに失敗しました: ${err}`);
    }
  }, [crate, setCrateOrder, analysisByTrack, pushToast]);

  // Crate の曲をダブルクリック: Crate 全体をキューにして、その曲から再生。
  const playFromCrate = useCallback(
    async (track: Track) => {
      if (!track.fileExists) return;
      const ids = crate.map((t) => t.trackId);
      const startIndex = ids.indexOf(track.trackId);
      await playbackApi.setQueue(ids, Math.max(0, startIndex));
      await playbackApi.playTrack(track.trackId);
    },
    [crate],
  );

  // Up Next の曲をダブルクリック: 再生順(order)を保ったまま、その位置へ頭出し。
  const playFromQueue = useCallback(async (orderIndex: number, track: Track) => {
    if (!track.fileExists) return;
    await playbackApi.playQueueAt(orderIndex);
  }, []);

  // Up Next の行を削除: 再生順(order)上の絶対位置で取り除き、成功したら取り直す。
  const removeFromQueue = useCallback(
    async (orderIndex: number) => {
      try {
        await playbackApi.removeQueueAt(orderIndex);
      } catch (err) {
        console.error("Failed to remove from queue:", err);
      }
      await loadQueue();
    },
    [loadQueue],
  );

  // ── Up Next のドラッグ並び替え ──
  // ドラッグ中はローカルの並び(queueTracks)だけを動かし、drop 確定時に
  // moveQueueItem(fromOrder, toOrder) を 1 回だけ呼ぶ(dragover ごとには呼ばない)。
  const onQueueDragStart = useCallback(
    (i: number) => {
      qDragIdx.current = i;
      qFromOrder.current = queueTracks[i]?.orderIndex ?? null;
      // 取得時点では orderIndex が startAt から連番なので、先頭の orderIndex が startAt。
      qStartAt.current = queueTracks[0]?.orderIndex ?? 0;
      draggingQueue.current = true;
    },
    [queueTracks],
  );

  const onQueueDragOver = useCallback((e: React.DragEvent, i: number) => {
    e.preventDefault();
    const from = qDragIdx.current;
    if (from === null || from === i) return;
    // ローカルの並びだけ動かす(invoke はしない)。
    setQueueTracks((prev) => {
      const next = [...prev];
      const [m] = next.splice(from, 1);
      next.splice(i, 0, m);
      return next;
    });
    qDragIdx.current = i;
    setQOverIdx(i);
  }, []);

  const onQueueDragEnd = useCallback(async () => {
    const finalIdx = qDragIdx.current;
    const fromOrder = qFromOrder.current;
    const startAt = qStartAt.current;
    qDragIdx.current = null;
    qFromOrder.current = null;
    setQOverIdx(null);
    draggingQueue.current = false;
    if (finalIdx === null || fromOrder === null) {
      await loadQueue();
      return;
    }
    // ドロップ後の配列位置 finalIdx に対応する絶対 orderIndex が移動先。
    const toOrder = startAt + finalIdx;
    if (toOrder !== fromOrder) {
      try {
        const ok = await playbackApi.moveQueueItem(fromOrder, toOrder);
        if (!ok) console.warn("moveQueueItem rejected", fromOrder, toOrder);
      } catch (err) {
        console.error("Failed to move queue item:", err);
      }
    }
    // 成功・失敗どちらでもバックエンドの正の並びへ整合させる(false 時の取り直し含む)。
    await loadQueue();
  }, [loadQueue]);

  // Similar の曲をダブルクリック: その曲だけを単発再生する (crate には影響しない)。
  const playSingle = useCallback(async (track: Track) => {
    if (!track.fileExists) return;
    await playbackApi.playTrack(track.trackId);
  }, []);

  const setBaseFromSelection = useCallback(() => {
    const first =
      selectedTrackIds.size > 0 ? Array.from(selectedTrackIds)[0] : null;
    if (first != null) setSimilarBase(first);
  }, [selectedTrackIds, setSimilarBase]);

  const setBaseFromNowPlaying = useCallback(() => {
    if (playback.currentTrackId != null) {
      setSimilarBase(playback.currentTrackId);
    }
  }, [playback.currentTrackId, setSimilarBase]);

  const onSimilarDragStart = useCallback(
    (e: React.DragEvent, trackId: number) => {
      similarDragTrackId.current = trackId;
      e.dataTransfer.setData(SIMILAR_DRAG_MIME, String(trackId));
      e.dataTransfer.effectAllowed = "copy";
    },
    [],
  );

  const onSimilarDragEnd = useCallback(() => {
    similarDragTrackId.current = null;
    setCrateExternalOver(false);
  }, []);

  const crateRowFindSimilar = useCallback(
    (trackId: number) => {
      setSimilarBase(trackId);
      if (!railSplit) switchRailTab("similar");
    },
    [setSimilarBase, railSplit, switchRailTab],
  );

  const crateRowPlayNext = useCallback(async (trackId: number) => {
    try {
      await playbackApi.enqueueTrackNext(trackId);
      pushToast("info", "次に再生へ追加しました");
    } catch (err) {
      pushToast("error", `次に再生に失敗: ${err}`);
    }
  }, [pushToast]);

  const toggleSplit = useCallback(() => {
    const next = !railSplit;
    setRailSplit(next);
    if (next && railTab !== "crate" && railTab !== "similar") {
      switchRailTab("crate");
    }
  }, [railSplit, setRailSplit, railTab, switchRailTab]);

  const renderCratePanel = (compact: boolean) => (
    <>
      <div className="cb-cratehd">
        <b>Staging Crate</b>
        <span className="cb-cmeta">
          <b>{crate.length}</b> tracks
          {crate.length > 0 && (
            <>
              {" · "}
              <b>{fmtTotal(crate)}</b>
            </>
          )}
          {crate.length >= 3 && (
            <button
              className="cb-clear"
              onClick={handleSmoothOrder}
              title="解析済みの曲を貪欲最近傍で滑らかな並びに"
            >
              {" "}
              smooth
            </button>
          )}
          {crate.length > 0 && (
            <button
              className="cb-clear"
              title="Clear crate"
              onClick={() => {
                if (window.confirm(`クレート ${crate.length} 曲をすべて外しますか？`)) {
                  clearCrate();
                }
              }}
            >
              {" "}
              clear
            </button>
          )}
        </span>
      </div>
      <div
        className={
          "cb-cratelist" +
          (crateExternalOver ? " cb-cratelist-drop" : "") +
          (compact ? " cb-cratelist-compact" : "")
        }
        onDragOver={onCrateListDragOver}
        onDragLeave={onCrateListDragLeave}
        onDrop={onCrateListDrop}
      >
        {crate.length === 0 ? (
          <div className="cb-rail-empty">
            曲リストやカバーの「＋」でクレートに追加。Similar からドラッグでも追加できます。
          </div>
        ) : (
          crate.map((t, i) => {
            const a = analysisByTrack.get(t.trackId);
            return (
              <div
                key={t.id}
                className={
                  "cb-cnode" +
                  (overIdx === i ? " dragover" : "") +
                  (playback.currentTrackId === t.trackId ? " playing" : "")
                }
                draggable
                onDragStart={(e) => onDragStart(i, e)}
                onDragOver={(e) => onDragOver(e, i)}
                onDragEnd={onDragEnd}
                onDoubleClick={() => playFromCrate(t)}
              >
                <span className="cb-cgrip">
                  <Icon name="dragHandle" size={15} />
                </span>
                <Cover
                  seed={t.album}
                  glyph={t.name}
                  path={t.fileExists ? t.locationPath : null}
                  size={compact ? 36 : 42}
                  radius={8}
                />
                <div className="cb-cmetawrap">
                  <div className="cj">{t.name || "(unknown)"}</div>
                  <div className="la">
                    {t.bpm != null && (
                      <b style={{ color: bpmColor(t.bpm) }}>{t.bpm}</b>
                    )}
                    {showRichMeta && a?.keyCamelot && (
                      <b style={{ color: "var(--ac)" }}>{a.keyCamelot}</b>
                    )}
                    {showRichMeta && a?.energy != null && (
                      <span>{Math.round(a.energy * 100)}%</span>
                    )}
                    <span>{t.artist || ""}</span>
                  </div>
                </div>
                <div className="cb-crow-actions">
                  <button
                    className="cb-cx cb-cact"
                    title="Find Similar / 似た曲"
                    onClick={(e) => {
                      e.stopPropagation();
                      crateRowFindSimilar(t.trackId);
                    }}
                  >
                    <Icon name="sparkle" size={13} />
                  </button>
                  <button
                    className="cb-cx cb-cact"
                    title="Play next / 次に再生"
                    onClick={(e) => {
                      e.stopPropagation();
                      crateRowPlayNext(t.trackId);
                    }}
                  >
                    <Icon name="queue" size={13} />
                  </button>
                  <button
                    className="cb-cx cb-cact"
                    title="Play from here / ここから再生"
                    onClick={(e) => {
                      e.stopPropagation();
                      playFromCrate(t);
                    }}
                  >
                    <Icon name="play" size={13} fill="currentColor" stroke={0} />
                  </button>
                  <button
                    className="cb-cx"
                    title="Remove from crate / クレートから外す"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromCrate(t.trackId);
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {!compact && (
        <div className="cb-cratefoot" style={{ flexDirection: "column", gap: 4 }}>
          {saveNameInput !== null ? (
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <input
                ref={saveInputRef}
                type="text"
                value={saveNameInput}
                onChange={(e) => setSaveNameInput(e.target.value)}
                placeholder="プレイリスト名を入力…"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--bd-strong)",
                  background: "var(--bg3)",
                  color: "var(--tx)",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveAsPlaylistCommit(saveNameInput);
                  if (e.key === "Escape") setSaveNameInput(null);
                }}
              />
              <button
                className="cb-big"
                style={{ flexShrink: 0, padding: "4px 10px" }}
                onClick={() => handleSaveAsPlaylistCommit(saveNameInput)}
                disabled={!saveNameInput.trim()}
              >
                <Icon name="check" size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <button
                className="cb-big"
                style={{ flex: 1 }}
                onClick={handleSaveAsPlaylistOpen}
                disabled={crate.length === 0}
              >
                <Icon name="check" size={15} /> Save as Playlist
              </button>
              <button
                className="cb-ghost"
                title="Play crate"
                onClick={handlePlayCrate}
                disabled={crate.length === 0}
                style={{ flexShrink: 0 }}
              >
                <Icon name="play" size={15} fill="currentColor" stroke={0} />
              </button>
            </div>
          )}
        </div>
      )}
      {compact && (
        <div className="cb-cratefoot cb-cratefoot-compact" style={{ flexDirection: "column", gap: 4 }}>
          {saveNameInput !== null ? (
            <div style={{ display: "flex", gap: 4, width: "100%" }}>
              <input
                ref={saveInputRef}
                type="text"
                value={saveNameInput}
                onChange={(e) => setSaveNameInput(e.target.value)}
                placeholder="プレイリスト名…"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--bd-strong)",
                  background: "var(--bg3)",
                  color: "var(--tx)",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveAsPlaylistCommit(saveNameInput);
                  if (e.key === "Escape") setSaveNameInput(null);
                }}
              />
              <button
                className="cb-big"
                style={{ flexShrink: 0, padding: "4px 10px", height: 28 }}
                onClick={() => handleSaveAsPlaylistCommit(saveNameInput)}
                disabled={!saveNameInput.trim()}
              >
                <Icon name="check" size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>
              <button
                className="cb-ghost"
                title="Play crate"
                onClick={handlePlayCrate}
                disabled={crate.length === 0}
                style={{ width: "auto", padding: "0 10px", height: 32 }}
              >
                <Icon name="play" size={14} fill="currentColor" stroke={0} />
              </button>
              <button
                className="cb-clear"
                onClick={handleSaveAsPlaylistOpen}
                disabled={crate.length === 0}
                title="Save as Playlist"
              >
                Save as Playlist…
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );

  const renderSimilarPanel = (compact: boolean) => (
    <>
      <div className="cb-cratehd">
        <b>Similar</b>
        <span className="cb-cmeta">
          <button
            className={"cb-tab" + (harmonic ? " on" : "")}
            onClick={() => setHarmonic((v) => !v)}
            title="Camelot 互換 + テンポ近接のみに絞る"
            style={{ padding: "2px 8px", marginLeft: 6 }}
          >
            Harmonic
          </button>
        </span>
      </div>
      {/* Sticky base track chip */}
      <div className="cb-sim-base">
        {similarBase ? (
          <>
            <Cover
              seed={similarBase.album}
              glyph={similarBase.name}
              path={similarBase.fileExists ? similarBase.locationPath : null}
              size={32}
              radius={6}
            />
            <div className="cb-sim-base-meta">
              <div className="cj ell" title={similarBase.name || ""}>
                {similarBase.name || "(unknown)"}
              </div>
              <div className="la ell">
                {similarBaseTrackId != null ? "Pin" : "Now Playing"}
                {similarBase.artist ? ` · ${similarBase.artist}` : ""}
              </div>
            </div>
          </>
        ) : (
          <div className="cb-sim-base-meta" style={{ flex: 1 }}>
            <div className="la">基準曲なし</div>
          </div>
        )}
        <div className="cb-sim-base-actions">
          <button
            className="cb-chip-btn"
            title="選択中の曲を基準に"
            disabled={selectedTrackIds.size === 0}
            onClick={setBaseFromSelection}
          >
            基準 ← 選択
          </button>
          <button
            className="cb-chip-btn"
            title="再生中の曲を基準に"
            disabled={playback.currentTrackId == null}
            onClick={setBaseFromNowPlaying}
          >
            基準 ← 再生中
          </button>
          {similarBaseTrackId != null && (
            <button
              className="cb-chip-btn"
              title="ピンを解除（再生中にフォールバック）"
              onClick={() => setSimilarBase(null)}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className={"cb-cratelist" + (compact ? " cb-cratelist-compact" : "")}>
        {similarBaseId == null ? (
          <div className="cb-rail-empty">
            曲を再生するか、「基準 ← 選択」で基準曲を選んでください。
          </div>
        ) : !baseAnalyzed ? (
          <div className="cb-rail-empty">
            基準曲が未解析です。右クリック →「Analyze」で BPM/Key/Energy を解析してください。
          </div>
        ) : simLoading ? (
          <div className="cb-rail-empty">探索中…</div>
        ) : similar.length === 0 ? (
          <div className="cb-rail-empty">
            似た曲が見つかりませんでした。{harmonic ? " Harmonic を切ると広がります。" : ""}
          </div>
        ) : (
          similar.map((h) => {
            const t = h.track;
            const a = analysisByTrack.get(t.trackId);
            const aBpm = a?.bpm;
            const inCrate = crate.some((c) => c.trackId === t.trackId);
            return (
              <div
                key={t.id}
                className="cb-cnode"
                draggable
                onDragStart={(e) => onSimilarDragStart(e, t.trackId)}
                onDragEnd={onSimilarDragEnd}
                onDoubleClick={() => playSingle(t)}
                title="ドラッグでクレートへ / ダブルクリックで再生"
              >
                <Cover
                  seed={t.album}
                  glyph={t.name}
                  path={t.fileExists ? t.locationPath : null}
                  size={compact ? 36 : 42}
                  radius={8}
                />
                <div className="cb-cmetawrap">
                  <div className="cj">{t.name || "(unknown)"}</div>
                  <div className="la">
                    {a?.keyCamelot && (
                      <b style={{ color: "var(--ac)" }}>{a.keyCamelot}</b>
                    )}
                    {aBpm != null && (
                      <span style={{ color: bpmColor(aBpm) }}>{Math.round(aBpm)}</span>
                    )}
                    {showRichMeta && a?.energy != null && (
                      <span>{Math.round(a.energy * 100)}%</span>
                    )}
                    <span>{t.artist || ""}</span>
                  </div>
                </div>
                <button
                  className="cb-cx"
                  title={inCrate ? "In crate" : "Add to crate"}
                  disabled={inCrate}
                  onClick={(e) => {
                    e.stopPropagation();
                    addToCrate(t);
                  }}
                >
                  <Icon name={inCrate ? "check" : "plus"} size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
      {similar.length > 0 && (() => {
        const allInCrate = similar.every((h) =>
          crate.some((c) => c.trackId === h.track.trackId)
        );
        return (
          <div className={"cb-cratefoot" + (compact ? " cb-cratefoot-compact" : "")}>
            <button
              className="cb-big"
              onClick={() => addTracksToCrate(similar.map((h) => h.track))}
              disabled={allInCrate}
              style={compact ? { height: 32, fontSize: 12 } : undefined}
            >
              <Icon name="layers" size={15} />
              {allInCrate ? " All added" : " Add all to Crate"}
            </button>
          </div>
        );
      })()}
    </>
  );

  return (
    <aside className="cb-rail">
      <div
        className="cb-rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="右ペイン幅を変更"
        title="ドラッグで幅変更 · ダブルクリックでリセット"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={onResizeDoubleClick}
      />

      {/* Now Playing hero (always visible) */}
      <div className="cb-now">
        {now ? (
          <>
            <div className="cb-nowart" style={{ background: artGradient(now.album) }}>
              <span className="g">{leadingGlyph(now.name)}</span>
              <ArtworkImg path={now.fileExists ? now.locationPath : null} />
              <div className="ov">
                {now.bpm != null && (
                  <span style={{ color: bpmColor(now.bpm) }}>{now.bpm} BPM</span>
                )}
                {now.rating != null && now.rating > 0 && (
                  <Stars value={ratingToStars(now.rating)} size={10} />
                )}
              </div>
            </div>
            <div className="cb-nowmeta">
              <div className="cj">{now.name || "(unknown)"}</div>
              <div className="ar">
                {now.artist || ""}
                {now.album ? ` — ${now.album}` : ""}
              </div>
            </div>
          </>
        ) : (
          <div className="cb-now-empty">
            <Icon name="music" size={28} />
          </div>
        )}
      </div>

      {/* Tabs: Now Playing | Up Next  ·  Crate | Similar + Split */}
      <div className="cb-railtabs">
        <div className="cb-tabgroup">
          <button
            className={"cb-tab" + (railTab === "now" && !workbenchSplit ? " on" : "")}
            onClick={() => switchRailTab("now")}
          >
            Now
          </button>
          <button
            className={"cb-tab" + (railTab === "next" && !workbenchSplit ? " on" : "")}
            onClick={() => switchRailTab("next")}
          >
            Up Next
          </button>
        </div>
        <span className="cb-tabsep" aria-hidden />
        <div className="cb-tabgroup">
          <button
            className={
              "cb-tab" +
              ((railTab === "crate" || workbenchSplit) ? " on" : "")
            }
            onClick={() => switchRailTab("crate")}
          >
            Crate
          </button>
          <button
            className={
              "cb-tab" +
              ((railTab === "similar" || workbenchSplit) ? " on" : "")
            }
            onClick={() => switchRailTab("similar")}
          >
            Similar
          </button>
        </div>
        <button
          className={"cb-tab cb-split-toggle" + (railSplit ? " on" : "")}
          onClick={toggleSplit}
          title="Crate と Similar を上下分割表示"
        >
          Split
        </button>
        {prevRailTab && (
          <button
            className="cb-tab cb-prev-tab"
            onClick={goPrevRailTab}
            title={`前のタブへ (${prevRailTab})`}
            style={{ flex: "0 0 auto", padding: "7px 6px" }}
          >
            <Icon name="chevronR" size={12} style={{ transform: "rotate(180deg)" }} />
          </button>
        )}
      </div>

      {/* Now Playing details */}
      {showNow && (
        <div className="cb-cratelist">
          {now ? (() => {
            const na = now.trackId != null ? analysisByTrack.get(now.trackId) : null;
            return (
              <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
                <NowRow label="Album" value={now.album} />
                <NowRow label="Artist" value={now.artist} />
                <NowRow label="Genre" value={now.genre} />
                <NowRow label="BPM" value={now.bpm != null ? String(now.bpm) : null} />
                {na?.keyCamelot != null && (
                  <NowRow label="Key" value={na.keyCamelot} />
                )}
                {na?.energy != null && (
                  <NowRow label="Energy" value={String(Math.round(na.energy * 100)) + "%"} />
                )}
                <NowRow label="Plays" value={now.playCount != null ? String(now.playCount) : null} />
              </div>
            );
          })() : (
            <div className="cb-rail-empty">再生中のトラックはありません。</div>
          )}
        </div>
      )}

      {/* Up Next */}
      {showNext && (
        <div className="cb-cratehd">
          <b>Up Next</b>
          <span className="cb-cmeta">
            {queueTracks.length > 0 && (
              <>
                <b>{queueTracks.length}</b> 曲
                {" · "}
                <b>{fmtTotal(queueTracks.map((q) => q.track))}</b>
              </>
            )}
            {shuffle && (
              <span
                style={{
                  marginLeft: 6,
                  padding: "1px 6px",
                  fontSize: 10,
                  borderRadius: 4,
                  background: "var(--ac)",
                  color: "#fff",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                }}
              >
                Shuffle
              </span>
            )}
          </span>
        </div>
      )}
      {showNext && (
        <div className="cb-cratelist">
          {queueTracks.length === 0 ? (
            <div className="cb-rail-empty">キューは空です。トラックをダブルクリックで再生開始。</div>
          ) : (
            queueTracks.map(({ track: t, orderIndex }, i) => (
              <div
                key={`${orderIndex}-${t.id}`}
                className={
                  "cb-cnode cb-qrow" +
                  (qOverIdx === i ? " dragover" : "") +
                  (!t.fileExists ? " missing" : "")
                }
                draggable
                onDragStart={() => onQueueDragStart(i)}
                onDragOver={(e) => onQueueDragOver(e, i)}
                onDragEnd={onQueueDragEnd}
                onDoubleClick={() => playFromQueue(orderIndex, t)}
                title={t.fileExists ? "Double-click to play / drag to reorder" : "File not found"}
              >
                <span className="cb-cgrip">
                  <Icon name="dragHandle" size={15} />
                </span>
                <Cover
                  seed={t.album}
                  glyph={t.name}
                  path={t.fileExists ? t.locationPath : null}
                  size={42}
                  radius={8}
                />
                <div className="cb-cmetawrap">
                  <div className="cj">{t.name || "(unknown)"}</div>
                  <div className="la">
                    {t.bpm != null && (
                      <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span>
                    )}
                    <span>{t.artist || ""}</span>
                  </div>
                </div>
                <button
                  className="cb-cx cb-qx"
                  title="Remove from queue"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromQueue(orderIndex);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Split workbench: Similar top + Crate bottom */}
      {workbenchSplit && (
        <div className="cb-rail-split">
          <div className="cb-rail-split-pane">{renderSimilarPanel(true)}</div>
          <div className="cb-rail-split-pane">{renderCratePanel(true)}</div>
        </div>
      )}

      {/* Crate (tabs mode) */}
      {showCrate && !workbenchSplit && renderCratePanel(false)}

      {/* Similar (tabs mode) */}
      {showSimilar && !workbenchSplit && renderSimilarPanel(false)}
    </aside>
  );
}

function NowRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
      <span style={{ color: "var(--mut)", width: 56, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: "var(--tx)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value || "—"}
      </span>
    </div>
  );
}
