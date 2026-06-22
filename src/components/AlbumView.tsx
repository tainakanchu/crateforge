import { useCallback, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import type { Track } from "../types";

type Group = "album" | "artist";

interface GroupedItem {
  key: string;
  label: string;
  sublabel: string | null;
  seed: string;
  tracks: Track[];
}

/// グループの代表アートワーク用に、実ファイルを持つ先頭トラックのパスを返す。
function repPath(tracks: Track[]): string | null {
  const t = tracks.find((x) => x.fileExists && x.locationPath);
  return t?.locationPath ?? null;
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function groupTracks(tracks: Track[], mode: Group): GroupedItem[] {
  const map = new Map<string, GroupedItem>();
  for (const t of tracks) {
    let key: string;
    let label: string;
    let sublabel: string | null;
    let seed: string;
    if (mode === "album") {
      const album = t.album || "(Unknown Album)";
      const aa = t.albumArtist || t.artist || "(Unknown Artist)";
      key = `${album} ${aa}`;
      label = album;
      sublabel = aa;
      seed = album;
    } else {
      const artist = t.albumArtist || t.artist || "(Unknown Artist)";
      key = artist;
      label = artist;
      sublabel = null;
      seed = artist;
    }
    const existing = map.get(key);
    if (existing) existing.tracks.push(t);
    else map.set(key, { key, label, sublabel, seed, tracks: [t] });
  }
  // 各グループ内の曲を disc 番号昇順 → track 番号昇順に並べ替え。
  for (const g of map.values()) {
    g.tracks.sort(
      (a, b) =>
        (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
        (a.trackNumber ?? 0) - (b.trackNumber ?? 0),
    );
  }
  return Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

interface AlbumViewProps {
  mode: Group;
  onTracksChanged: () => void;
}

export function AlbumView({ mode }: AlbumViewProps) {
  const { tracks, playback } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useMemo(() => groupTracks(tracks, mode), [tracks, mode]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => (prev === key ? null : key));
  }, []);

  const playAll = useCallback(async (g: GroupedItem) => {
    const ids = g.tracks.map((t) => t.trackId);
    await playbackApi.setQueue(ids, 0);
    if (ids.length > 0) await playbackApi.playTrack(ids[0]);
  }, []);

  const playOne = useCallback(async (g: GroupedItem, track: Track) => {
    const ids = g.tracks.map((t) => t.trackId);
    const startIndex = ids.indexOf(track.trackId);
    await playbackApi.setQueue(ids, Math.max(0, startIndex));
    await playbackApi.playTrack(track.trackId);
  }, []);

  if (tracks.length === 0) {
    return (
      <div className="cb-empty">
        No tracks. Switch to “All Tracks” and import something to populate.
      </div>
    );
  }

  return (
    <div className="album-view">
      <div className="album-grid">
        {groups.map((g) => {
          const isOpen = expanded === g.key;
          const totalMs = g.tracks.reduce((sum, t) => sum + (t.totalTimeMs ?? 0), 0);
          return (
            <div key={g.key} className={`album-card ${isOpen ? "open" : ""}`}>
              <div className="album-card-header" onClick={() => toggle(g.key)}>
                <Cover
                  seed={g.seed}
                  glyph={g.label}
                  path={repPath(g.tracks)}
                  size={56}
                  radius={10}
                />
                <div className="album-meta">
                  <div className="album-title" title={g.label}>
                    {g.label}
                  </div>
                  {g.sublabel && (
                    <div className="album-sub" title={g.sublabel}>
                      {g.sublabel}
                    </div>
                  )}
                  <div className="album-stats">
                    {g.tracks.length} track{g.tracks.length === 1 ? "" : "s"}
                    {totalMs > 0 ? ` · ${formatTime(totalMs)}` : ""}
                  </div>
                </div>
                <button
                  className="album-play-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    playAll(g);
                  }}
                  title="Play"
                >
                  <Icon name="play" size={14} fill="currentColor" stroke={0} />
                </button>
              </div>
              {isOpen && (
                <div className="album-tracklist">
                  {g.tracks.map((t) => {
                    const isCurrent = playback.currentTrackId === t.trackId;
                    return (
                      <div
                        key={t.id}
                        className={`album-track-row ${isCurrent ? "playing" : ""} ${
                          !t.fileExists ? "missing" : ""
                        }`}
                        onDoubleClick={() => playOne(g, t)}
                      >
                        <span className="album-track-num">
                          {isCurrent ? (
                            <Icon name="play" size={10} fill="currentColor" stroke={0} />
                          ) : (
                            (t.trackNumber ?? "")
                          )}
                        </span>
                        <span className="album-track-name">{t.name || "(unknown)"}</span>
                        {mode === "artist" && t.album && (
                          <span className="album-track-album">{t.album}</span>
                        )}
                        <span className="album-track-time">{formatTime(t.totalTimeMs)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
