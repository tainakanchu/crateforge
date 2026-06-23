import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import * as libraryApi from "../api/library";
import * as analysisApi from "../api/analysis";
import { Icon, Stars } from "./Icon";
import { Cover, ArtworkImg } from "./Cover";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { Track, SimilarHit } from "../types";

interface RightRailProps {
  onPlaylistsChanged: () => void;
}

/// Up Next の 1 行。order(再生順) 上の絶対位置を併せ持つ。
interface QueueItem {
  track: Track;
  orderIndex: number;
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
    removeFromCrate,
    reorderCrate,
    setCrateOrder,
    clearCrate,
    shuffle,
    repeat,
    similarBaseTrackId,
    analysisByTrack,
    pushToast,
  } = useStore();

  const [queueTracks, setQueueTracks] = useState<QueueItem[]>([]);
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

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

  // Similar タブ: 基準は similarBaseTrackId、無ければ再生中の曲。
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [harmonic, setHarmonic] = useState(true);
  const [simLoading, setSimLoading] = useState(false);
  const similarBaseId = similarBaseTrackId ?? playback.currentTrackId;
  const similarBase = similarBaseId != null
    ? tracks.find((t) => t.trackId === similarBaseId) ?? null
    : null;
  const baseAnalyzed = similarBaseId != null && analysisByTrack.has(similarBaseId);

  const now = playback.currentTrackId
    ? tracks.find((t) => t.trackId === playback.currentTrackId) ?? null
    : null;

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
    if (railTab !== "next") return;
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
  }, [railTab, playback.currentTrackId, shuffle, repeat, loadQueue]);

  // Similar: 基準曲が解析済みなら似た曲を取得（harmonic で BPM/Key 互換に絞る）。
  useEffect(() => {
    if (railTab !== "similar") return;
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
  }, [railTab, similarBaseId, harmonic, baseAnalyzed, analysisByTrack]);

  const onDragStart = (i: number) => {
    dragIdx.current = i;
  };
  const onDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
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

  return (
    <aside className="cb-rail">
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

      {/* Tabs */}
      <div className="cb-railtabs">
        <button
          className={"cb-tab" + (railTab === "now" ? " on" : "")}
          onClick={() => setRailTab("now")}
        >
          Now Playing
        </button>
        <button
          className={"cb-tab" + (railTab === "next" ? " on" : "")}
          onClick={() => setRailTab("next")}
        >
          Up Next
        </button>
        <button
          className={"cb-tab" + (railTab === "crate" ? " on" : "")}
          onClick={() => setRailTab("crate")}
        >
          Crate
        </button>
        <button
          className={"cb-tab" + (railTab === "similar" ? " on" : "")}
          onClick={() => setRailTab("similar")}
        >
          Similar
        </button>
      </div>

      {/* Now Playing details */}
      {railTab === "now" && (
        <div className="cb-cratelist">
          {now ? (() => {
            // analysisByTrack から再生中トラックの解析結果を取得
            const na = now.trackId != null ? analysisByTrack.get(now.trackId) : null;
            return (
              <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
                <NowRow label="Album" value={now.album} />
                <NowRow label="Artist" value={now.artist} />
                <NowRow label="Genre" value={now.genre} />
                <NowRow label="BPM" value={now.bpm != null ? String(now.bpm) : null} />
                {/* Key: analysisByTrack から取得（null なら行ごと非表示）*/}
                {na?.keyCamelot != null && (
                  <NowRow label="Key" value={na.keyCamelot} />
                )}
                {/* Energy: analysisByTrack から取得（null なら行ごと非表示）*/}
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
      {railTab === "next" && (
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
            {/* shuffle ON バッジ */}
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
      {railTab === "next" && (
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

      {/* Crate */}
      {railTab === "crate" && (
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
                    // 非永続なので曲数を明示して確認
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
          <div className="cb-cratelist">
            {crate.length === 0 ? (
              <div className="cb-rail-empty">
                曲リストやカバーの「＋」でクレートに追加。並べ替えて Playlist として保存できます。
              </div>
            ) : (
              crate.map((t, i) => (
                <div
                  key={t.id}
                  className={
                    "cb-cnode" +
                    (overIdx === i ? " dragover" : "") +
                    (playback.currentTrackId === t.trackId ? " playing" : "")
                  }
                  draggable
                  onDragStart={() => onDragStart(i)}
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
                  size={42}
                  radius={8}
                />
                  <div className="cb-cmetawrap">
                    <div className="cj">{t.name || "(unknown)"}</div>
                    <div className="la">
                      {t.bpm != null && (
                        <b style={{ color: bpmColor(t.bpm) }}>{t.bpm}</b>
                      )}
                      <span>{t.artist || ""}</span>
                    </div>
                  </div>
                  <button
                    className="cb-cx"
                    title="Remove from crate"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromCrate(t.trackId);
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="cb-cratefoot" style={{ flexDirection: "column", gap: 4 }}>
            {/* インライン名前入力（表示中のみ） */}
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
        </>
      )}

      {/* Similar (harmonic / vibe suggestions) */}
      {railTab === "similar" && (
        <>
          <div className="cb-cratehd">
            <b>Similar</b>
            <span className="cb-cmeta">
              {similarBase?.name ? (
                <span className="ell" style={{ maxWidth: 130 }}>
                  ↳ {similarBase.name}
                </span>
              ) : null}
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
          <div className="cb-cratelist">
            {similarBaseId == null ? (
              <div className="cb-rail-empty">
                曲を再生するか、リストで右クリック →「Find similar」で基準曲を選んでください。
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
                    onDoubleClick={() => playSingle(t)}
                  >
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
                        {a?.keyCamelot && (
                          <b style={{ color: "var(--ac)" }}>{a.keyCamelot}</b>
                        )}
                        {aBpm != null && (
                          <span style={{ color: bpmColor(aBpm) }}>{Math.round(aBpm)}</span>
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
            // similar 候補がすべて crate 済みかどうかチェック
            const allInCrate = similar.every((h) =>
              crate.some((c) => c.trackId === h.track.trackId)
            );
            return (
              <div className="cb-cratefoot">
                <button
                  className="cb-big"
                  onClick={() => similar.forEach((h) => addToCrate(h.track))}
                  disabled={allInCrate}
                >
                  <Icon name="layers" size={15} />
                  {allInCrate ? " All added" : " Add all to Crate"}
                </button>
              </div>
            );
          })()}
        </>
      )}
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
