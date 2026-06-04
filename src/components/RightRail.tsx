import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as playlistsApi from "../api/playlists";
import { Icon } from "./Icon";
import { Cover, ArtworkImg } from "./Cover";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { Track } from "../types";

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
    removeFromCrate,
    reorderCrate,
    clearCrate,
    shuffle,
    repeat,
  } = useStore();

  const [queueTracks, setQueueTracks] = useState<QueueItem[]>([]);
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const now = playback.currentTrackId
    ? tracks.find((t) => t.trackId === playback.currentTrackId) ?? null
    : null;

  // Up Next: バックエンドのキューを解決（現在ロード済み tracks から）。
  // Up Next タブを開いているときだけ取得する。
  useEffect(() => {
    if (railTab !== "next") return;
    let alive = true;
    const load = async () => {
      try {
        const q = await playbackApi.getQueue();
        if (!alive) return;
        const byId = new Map(tracks.map((t) => [t.trackId, t]));
        const startAt = q.currentIndex != null ? q.currentIndex + 1 : 0;
        // order(再生順) 上の絶対位置を保持。Up Next からの頭出しに使う。
        const upcoming = q.trackIds
          .slice(startAt)
          .map((id, idx) => {
            const track = byId.get(id);
            return track ? { track, orderIndex: startAt + idx } : null;
          })
          .filter((x): x is QueueItem => !!x);
        setQueueTracks(upcoming);
      } catch {
        if (alive) setQueueTracks([]);
      }
    };
    load();
    // enqueue や曲の自動遷移を反映するため、表示中は定期的に取り直す。
    const iv = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // shuffle / repeat 変更で再生順が変わるので Up Next を取り直す。
  }, [railTab, playback.currentTrackId, tracks, shuffle, repeat]);

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

  const handleSaveAsPlaylist = useCallback(async () => {
    if (crate.length === 0) return;
    const name = window.prompt("Save crate as playlist — name:");
    if (!name?.trim()) return;
    try {
      const pl = await playlistsApi.createPlaylist(name.trim(), null, false);
      await playlistsApi.addTracksToPlaylist(
        pl.playlistId,
        crate.map((t) => t.trackId),
      );
      clearCrate();
      onPlaylistsChanged();
    } catch (err) {
      alert(`Failed to save playlist: ${err}`);
    }
  }, [crate, clearCrate, onPlaylistsChanged]);

  const handlePlayCrate = useCallback(async () => {
    if (crate.length === 0) return;
    const ids = crate.map((t) => t.trackId);
    await playbackApi.setQueue(ids, 0);
    await playbackApi.playTrack(ids[0]);
  }, [crate]);

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
                  <span style={{ color: "var(--ac)" }}>{ratingToStars(now.rating)}★</span>
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
      </div>

      {/* Now Playing details */}
      {railTab === "now" && (
        <div className="cb-cratelist">
          {now ? (
            <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: 8 }}>
              <NowRow label="Album" value={now.album} />
              <NowRow label="Artist" value={now.artist} />
              <NowRow label="Genre" value={now.genre} />
              <NowRow label="BPM" value={now.bpm != null ? String(now.bpm) : null} />
              <NowRow label="Plays" value={now.playCount != null ? String(now.playCount) : null} />
            </div>
          ) : (
            <div className="cb-rail-empty">再生中のトラックはありません。</div>
          )}
        </div>
      )}

      {/* Up Next */}
      {railTab === "next" && (
        <div className="cb-cratelist">
          {queueTracks.length === 0 ? (
            <div className="cb-rail-empty">キューは空です。トラックをダブルクリックで再生開始。</div>
          ) : (
            queueTracks.map(({ track: t, orderIndex }) => (
              <div
                key={`${orderIndex}-${t.id}`}
                className={"cb-cnode" + (!t.fileExists ? " missing" : "")}
                onDoubleClick={() => playFromQueue(orderIndex, t)}
                title={t.fileExists ? "Double-click to play" : "File not found"}
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
                    {t.bpm != null && (
                      <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span>
                    )}
                    <span>{t.artist || ""}</span>
                  </div>
                </div>
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
              {crate.length > 0 && (
                <button className="cb-clear" onClick={clearCrate} title="Clear crate">
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
          <div className="cb-cratefoot">
            <button className="cb-big" onClick={handleSaveAsPlaylist} disabled={crate.length === 0}>
              <Icon name="check" size={15} /> Save as Playlist
            </button>
            <button
              className="cb-ghost"
              title="Play crate"
              onClick={handlePlayCrate}
              disabled={crate.length === 0}
            >
              <Icon name="play" size={15} fill="currentColor" stroke={0} />
            </button>
          </div>
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
