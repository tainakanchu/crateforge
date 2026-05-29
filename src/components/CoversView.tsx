import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import { Icon } from "./Icon";
import { artGradient, bpmColor, leadingGlyph } from "../lib/art";
import type { Track } from "../types";

const GAP = 18;
const PAD_X = 20;
const MIN_CARD = 150;

interface CoversViewProps {
  onLoadMore: () => void;
}

/// アート前面のブラウズビュー。1 トラック 1 カードで仮想化（行単位）。
export function CoversView({ onLoadMore }: CoversViewProps) {
  const { tracks, isLoading, hasMore, playback, crate, addToCrate } = useStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

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

  const inner = Math.max(0, width - PAD_X * 2);
  const cols = Math.max(2, Math.floor((inner + GAP) / (MIN_CARD + GAP)) || 2);
  const cardW = Math.max(60, inner > 0 ? (inner - GAP * (cols - 1)) / cols : MIN_CARD);
  const rowCount = Math.ceil(tracks.length / cols);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardW + GAP,
    overscan: 4,
    paddingStart: 18,
    paddingEnd: 18,
  });

  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardW, cols]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || isLoading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
  }, [isLoading, hasMore, onLoadMore]);

  const playTrack = useCallback(
    async (track: Track) => {
      if (!track.fileExists) return;
      try {
        const ids = tracks.map((t) => t.trackId);
        const startIndex = ids.indexOf(track.trackId);
        await playbackApi.setQueue(ids, Math.max(0, startIndex));
        await playbackApi.playTrack(track.trackId);
      } catch (err) {
        console.error("Failed to play:", err);
      }
    },
    [tracks],
  );

  if (tracks.length === 0 && !isLoading) {
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
          const start = vRow.index * cols;
          const rowTracks = tracks.slice(start, start + cols);
          return (
            <div
              key={vRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${vRow.size}px`,
                transform: `translateY(${vRow.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: GAP,
                padding: `0 ${PAD_X}px`,
              }}
            >
              {rowTracks.map((t) => {
                const isIn = crate.some((c) => c.trackId === t.trackId);
                const isCurrent = playback.currentTrackId === t.trackId;
                return (
                  <div
                    key={t.id}
                    className="cb-cardwrap"
                    onDoubleClick={() => playTrack(t)}
                  >
                    <div
                      className={
                        "cb-card" + (isIn ? " incrate" : "") + (isCurrent ? " playing" : "")
                      }
                      style={{ background: artGradient(t.album) }}
                    >
                      <span className="glyph">{leadingGlyph(t.name)}</span>
                      <span className="grad" />
                      <div className="kbtag">
                        {t.bpm != null && (
                          <span style={{ color: bpmColor(t.bpm) }}>{t.bpm}</span>
                        )}
                      </div>
                      {isIn ? (
                        <span
                          className="addbtn"
                          style={{ opacity: 1, transform: "none" }}
                          title="In crate"
                        >
                          <Icon name="check" size={17} />
                        </span>
                      ) : (
                        <button
                          className="addbtn"
                          title="Add to crate"
                          onClick={(e) => {
                            e.stopPropagation();
                            addToCrate(t);
                          }}
                        >
                          <Icon name="plus" size={17} />
                        </button>
                      )}
                      <div className="ov">
                        <div className="cj">{t.name || "(unknown)"}</div>
                        <div className="la">{t.artist || ""}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {isLoading && <div className="cb-loading">Loading…</div>}
    </div>
  );
}
