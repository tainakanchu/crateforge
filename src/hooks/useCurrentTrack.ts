import { useEffect, useState } from "react";
import * as libraryApi from "../api/library";
import { useStore } from "../store/useStore";
import type { Track } from "../types";
import { isTauri } from "../lib/env";

/**
 * 再生中の曲。メモリ上の一覧 (Inbox / 最近再生した曲の tracks) にあればそれを使い、無ければ
 * ID で取り直す (ライブラリ・プレイリストの一覧は見えている範囲しか持たないため。起動時に
 * 復元した曲 #159 / 別ビューの曲も同じ)。ライブラリが変わったら取り直すので、再生中の曲を
 * 編集した結果もすぐ反映される。PlayerBar・右ペインの Now Playing・OS のメディア表示で共用する。
 */
export function useCurrentTrack(): Track | null {
  const currentTrackId = useStore((s) => s.playback.currentTrackId);
  const tracks = useStore((s) => s.tracks);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const [fetched, setFetched] = useState<{ id: number; revision: number; track: Track | null } | null>(
    null,
  );
  const listedTrack =
    currentTrackId != null ? (tracks.find((t) => t.trackId === currentTrackId) ?? null) : null;
  useEffect(() => {
    const id = currentTrackId;
    if (id == null || listedTrack || !isTauri) return;
    if (fetched && fetched.id === id && fetched.revision === libraryRevision) return;
    let alive = true;
    libraryApi
      .getTracksByIds([id])
      .then((r) => {
        if (alive) setFetched({ id, revision: libraryRevision, track: r[0] ?? null });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [currentTrackId, listedTrack, fetched, libraryRevision]);
  return listedTrack ?? (fetched && fetched.id === currentTrackId ? fetched.track : null);
}
