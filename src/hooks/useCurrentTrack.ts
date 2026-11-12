import { useEffect, useState } from "react";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import type { Track } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 再生中の曲。表示中の一覧 (tracks) にあればそれを使い、無いとき (起動時に復元した曲 #159 /
 * 別ビュー・別ページの曲) は ID で取り直す。PlayerBar と右ペインの Now Playing で共用する。
 */
export function useCurrentTrack(): Track | null {
  const currentTrackId = useStore((s) => s.playback.currentTrackId);
  const tracks = useStore((s) => s.tracks);
  const [fetchedTrack, setFetchedTrack] = useState<Track | null>(null);
  const listedTrack =
    currentTrackId != null ? (tracks.find((t) => t.trackId === currentTrackId) ?? null) : null;
  useEffect(() => {
    const id = currentTrackId;
    if (id == null || listedTrack || !isTauri) return;
    if (fetchedTrack?.trackId === id) return;
    let alive = true;
    libraryApi
      .getTracksByIds([id])
      .then((r) => {
        if (alive) setFetchedTrack(r[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [currentTrackId, listedTrack, fetchedTrack]);
  return (
    listedTrack ?? (fetchedTrack && fetchedTrack.trackId === currentTrackId ? fetchedTrack : null)
  );
}
