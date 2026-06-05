import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import { Icon } from "./Icon";
import { ArtworkImg } from "./Cover";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { Track } from "../types";

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;
const META_H = 46; // カード下のアルバム名・曲数ラベルのおよその高さ

interface CoversViewProps {
  onLoadMore: () => void;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string; // 表示用のアルバムアーティスト
  tracks: Track[];
  cover: Track; // アートワーク用の代表トラック
}

type Row =
  | { type: "grid"; albums: AlbumGroup[] }
  | { type: "expand"; album: AlbumGroup };

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// 同じアルバム（アルバムアーティスト＋アルバム名）のトラックを 1 グループへ。
// アルバム名が無い曲は 1 曲 1 カードとして扱う（巨大な「(unknown)」へ吸い込まれないように）。
function groupAlbums(tracks: Track[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  const order: string[] = [];
  for (const t of tracks) {
    const albumName = (t.album || "").trim();
    const aa = (t.albumArtist || t.artist || "").trim();
    const key = albumName
      ? `al:${aa.toLowerCase()}␟${albumName.toLowerCase()}`
      : `tr:${t.trackId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        album: albumName || t.name || "(unknown)",
        artist: aa || t.artist || "",
        tracks: [],
        cover: t,
      };
      map.set(key, g);
      order.push(key);
    }
    g.tracks.push(t);
    if (!g.cover.fileExists && t.fileExists) g.cover = t;
  }
  // アルバム内はトラック番号順（番号が無いものは元の順序を保持）。
  for (const g of map.values()) {
    g.tracks.sort((a, b) => (a.trackNumber ?? 1e9) - (b.trackNumber ?? 1e9));
  }
  return order.map((k) => map.get(k)!);
}

/// アート前面のブラウズビュー。アルバム単位でまとめ、クリックで曲一覧を展開する。
export function CoversView({ onLoadMore }: CoversViewProps) {
  const { tracks, isLoading, hasMore, playback, crate, addToCrate } = useStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const albums = useMemo(() => groupAlbums(tracks), [tracks]);
  const crateSet = useMemo(() => new Set(crate.map((t) => t.trackId)), [crate]);

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);

  // グリッド行（cols 枚ずつ）に、展開中アルバムの曲一覧行を差し込んだ仮想行リスト。
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < albums.length; i += cols) {
      const chunk = albums.slice(i, i + cols);
      out.push({ type: "grid", albums: chunk });
      for (const al of chunk) {
        if (expanded.has(al.key)) out.push({ type: "expand", album: al });
      }
    }
    return out;
  }, [albums, cols, expanded]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].type === "grid" ? cardW + META_H + GAP : 260),
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
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, hasMore, onLoadMore]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // アルバムを頭から（または指定トラックから）再生。
  const playAlbum = useCallback(async (album: AlbumGroup, startId?: number) => {
    const ids = album.tracks.filter((t) => t.fileExists).map((t) => t.trackId);
    if (ids.length === 0) return;
    const start = startId != null ? Math.max(0, ids.indexOf(startId)) : 0;
    try {
      await playbackApi.setQueue(ids, start);
      await playbackApi.playTrack(ids[start]);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  }, []);

  const addAlbumToCrate = useCallback(
    (album: AlbumGroup) => {
      for (const t of album.tracks) addToCrate(t);
    },
    [addToCrate],
  );

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
    <div className="cb-grid-wrap" ref={parentRef} onScroll={handleScroll}>
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
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gap: GAP,
                    padding: `0 ${PAD_X}px ${GAP}px`,
                  }}
                >
                  {row.albums.map((al) => {
                    const allIn = al.tracks.every((t) => crateSet.has(t.trackId));
                    const isCurrent = al.tracks.some(
                      (t) => playback.currentTrackId === t.trackId,
                    );
                    const isOpen = expanded.has(al.key);
                    return (
                      <div key={al.key} className="cb-cardwrap">
                        <div
                          className={
                            "cb-card" +
                            (allIn ? " incrate" : "") +
                            (isCurrent ? " playing" : "") +
                            (isOpen ? " opened" : "")
                          }
                          style={{ background: artGradient(al.album) }}
                          onClick={() => toggleExpand(al.key)}
                          onDoubleClick={() => playAlbum(al)}
                        >
                          <span className="glyph">{leadingGlyph(al.album)}</span>
                          <ArtworkImg path={al.cover.fileExists ? al.cover.locationPath : null} />
                          <span className="grad" />
                          <div className="kbtag">
                            {al.tracks.length > 1 && (
                              <span title={`${al.tracks.length} tracks`}>
                                {al.tracks.length}
                              </span>
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
                          onClick={() => toggleExpand(al.key)}
                          title={`${al.album} — ${al.artist}`}
                        >
                          <div className="cj">{al.album}</div>
                          <div className="la">{al.artist}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <AlbumExpansion
                  album={row.album}
                  crateSet={crateSet}
                  currentTrackId={playback.currentTrackId}
                  onPlayTrack={(id) => playAlbum(row.album, id)}
                  onAddTrack={addToCrate}
                  onClose={() => toggleExpand(row.album.key)}
                />
              )}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}
    </div>
  );
}

interface AlbumExpansionProps {
  album: AlbumGroup;
  crateSet: Set<number>;
  currentTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  onAddTrack: (track: Track) => void;
  onClose: () => void;
}

function AlbumExpansion({
  album,
  crateSet,
  currentTrackId,
  onPlayTrack,
  onAddTrack,
  onClose,
}: AlbumExpansionProps) {
  const totalMs = album.tracks.reduce((s, t) => s + (t.totalTimeMs ?? 0), 0);
  return (
    // ラッパの padding で行間を確保する（margin だと getBoundingClientRect の
    // 計測高さに含まれず、仮想行が重なってしまうため）。
    <div style={{ padding: `0 ${PAD_X}px ${GAP}px` }}>
      <div className="cov-exp">
      <div className="cov-exp-head">
        <div className="cov-exp-title">
          <span className="t">{album.album}</span>
          <span className="s">
            {album.artist} · {album.tracks.length} tracks · {formatTime(totalMs)}
          </span>
        </div>
        <button className="cov-exp-close" title="Collapse" onClick={onClose}>
          <Icon name="chevronD" size={16} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div className="cov-trks">
        {album.tracks.map((t, i) => {
          const isIn = crateSet.has(t.trackId);
          const isCurrent = currentTrackId === t.trackId;
          const showArtist = (t.artist || "") !== album.artist && !!t.artist;
          return (
            <div
              key={t.id}
              className={"cov-trk" + (isCurrent ? " play" : "") + (!t.fileExists ? " missing" : "")}
              onDoubleClick={() => onPlayTrack(t.trackId)}
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
