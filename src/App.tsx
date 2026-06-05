import { useEffect, useCallback, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TrackTable } from "./components/TrackTable";
import { CoversView } from "./components/CoversView";
import { AlbumView } from "./components/AlbumView";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Toolbar } from "./components/Toolbar";
import { TrackEditor } from "./components/TrackEditor";
import { RipDialog } from "./components/ripper/RipDialog";
import { RulesPanel } from "./components/rules/RulesPanel";
import { ConvertDialog } from "./components/ConvertDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { useStore } from "./store/useStore";
import * as libraryApi from "./api/library";
import * as playlistsApi from "./api/playlists";
import * as playbackApi from "./api/playback";
import * as systemApi from "./api/system";
import * as analysisApi from "./api/analysis";
import type { Track } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;

export default function App() {
  const {
    viewMode,
    selectedPlaylistId,
    searchQuery,
    filterTags,
    setTracks,
    appendTracks,
    setPlaylists,
    setIsLoading,
    setHasMore,
    setPlayback,
    tracks,
    playback,
    selectedTrackIds,
    setSearchQuery,
    setViewMode,
    setSelectedPlaylistId,
    volume,
    setVolume,
    shuffle,
    setShuffle,
    repeat,
    setRepeat,
    replayGain,
    sortField,
    sortOrder,
    displayMode,
    setAnalyses,
    setAnalysisActive,
  } = useStore();

  const PAGE_SIZE = 500;
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const advanceRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const [reloadCount, setReloadCount] = useState(0);
  const [ripOpen, setRipOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editorTrack, setEditorTrack] = useState<Track | null>(null);
  const [convertIds, setConvertIds] = useState<number[] | null>(null);

  const reloadPlaylists = useCallback(async () => {
    if (!isTauri) return;
    try {
      const pls = await playlistsApi.getPlaylists();
      setPlaylists(pls);
    } catch (err) {
      console.error("Failed to load playlists:", err);
    }
  }, [setPlaylists]);

  const loadTracks = useCallback(
    async (reset = true) => {
      if (!isTauri) {
        setTracks([]);
        setHasMore(false);
        return;
      }

      setIsLoading(true);
      try {
        const offset = reset ? 0 : tracks.length;
        // フリーテキスト検索 + ジャンル等の絞り込みチップを空白区切りで AND 結合。
        const combinedQuery = [searchQuery.trim(), ...filterTags]
          .filter(Boolean)
          .join(" ");
        let result;

        if (viewMode === "recent") {
          result = await playbackApi.getRecentTracks(200);
          setTracks(result);
          setHasMore(false);
        } else if (viewMode === "albums" || viewMode === "artists") {
          // Group views need everything in-memory to group consistently.
          result = await libraryApi.getTracks(50000, 0);
          setTracks(result);
          setHasMore(false);
        } else if (combinedQuery) {
          result = await libraryApi.searchTracks(
            combinedQuery,
            PAGE_SIZE,
            offset,
            sortField,
            sortOrder,
          );
          if (reset) setTracks(result);
          else appendTracks(result);
          setHasMore(result.length === PAGE_SIZE);
        } else if (viewMode === "playlist" && selectedPlaylistId !== null) {
          result = await playlistsApi.getPlaylistTracks(
            selectedPlaylistId,
            PAGE_SIZE,
            offset,
            sortField,
            sortOrder,
          );
          if (reset) setTracks(result);
          else appendTracks(result);
          setHasMore(result.length === PAGE_SIZE);
        } else {
          result = await libraryApi.getTracks(
            PAGE_SIZE,
            offset,
            sortField,
            sortOrder,
          );
          if (reset) setTracks(result);
          else appendTracks(result);
          setHasMore(result.length === PAGE_SIZE);
        }
      } catch (err) {
        console.error("Failed to load tracks:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [viewMode, selectedPlaylistId, searchQuery, filterTags, sortField, sortOrder, tracks.length, setTracks, appendTracks, setHasMore, setIsLoading],
  );

  useEffect(() => {
    loadTracks(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedPlaylistId, searchQuery, filterTags, sortField, sortOrder, reloadCount]);

  useEffect(() => {
    reloadPlaylists();
  }, [reloadPlaylists]);

  // Sync persisted volume / shuffle / repeat to the Rust player on mount.
  useEffect(() => {
    if (!isTauri) return;
    playbackApi.setVolume(volume).catch(() => {});
    playbackApi.setShuffle(shuffle).catch(() => {});
    playbackApi.setRepeat(repeat).catch(() => {});
    playbackApi.setReplayGain(replayGain).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playback state poll.
  useEffect(() => {
    if (!isTauri) return;
    pollRef.current = setInterval(async () => {
      try {
        const state = await playbackApi.getPlaybackState();
        setPlayback(state);
      } catch {
        // ignore
      }
    }, 250);
    return () => clearInterval(pollRef.current);
  }, [setPlayback]);

  // Sync now-playing to SMTC + listen to media key events from the OS.
  useEffect(() => {
    if (!isTauri) return;

    const current = playback.currentTrackId
      ? tracks.find((t) => t.trackId === playback.currentTrackId) ?? null
      : null;

    systemApi
      .updateSmtc(
        current?.name ?? "",
        current?.artist ?? "",
        current?.album ?? "",
        playback.isPlaying,
        playback.positionMs,
        playback.durationMs,
      )
      .catch(() => {});
  }, [
    playback.currentTrackId,
    playback.isPlaying,
    playback.positionMs,
    playback.durationMs,
    tracks,
  ]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await systemApi.onSmtcButton((kind) => {
        switch (kind) {
          case "play":
            playbackApi.resume().catch(() => {});
            break;
          case "pause":
            playbackApi.pause().catch(() => {});
            break;
          case "toggle":
            if (playback.isPlaying) playbackApi.pause();
            else playbackApi.resume();
            break;
          case "next":
            playbackApi.playNext();
            break;
          case "prev":
            playbackApi.playPrev();
            break;
          case "stop":
            playbackApi.stop();
            break;
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
    // playback.isPlaying read inside handler is intentionally lagging
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解析結果の読み込み + 進捗購読 (BPM/Key/Energy)。
  const loadAnalyses = useCallback(async () => {
    if (!isTauri) return;
    try {
      setAnalyses(await analysisApi.getAllAnalyses());
    } catch (err) {
      console.error("Failed to load analyses:", err);
    }
  }, [setAnalyses]);

  useEffect(() => {
    if (!isTauri) return;
    loadAnalyses();
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await analysisApi.onAnalysisProgress((p) => {
        if (p.kind === "start") setAnalysisActive({ done: 0, total: p.total });
        else if (p.kind === "item") setAnalysisActive({ done: p.done, total: p.total });
        else if (p.kind === "finished") {
          setAnalysisActive(null);
          loadAnalyses();
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [loadAnalyses, setAnalysisActive]);

  // Advance queue when current track finishes.
  useEffect(() => {
    if (!isTauri) return;
    advanceRef.current = setInterval(async () => {
      try {
        await playbackApi.checkAdvance();
      } catch {
        // ignore
      }
    }, 500);
    return () => clearInterval(advanceRef.current);
  }, []);

  const triggerReload = useCallback(() => {
    setReloadCount((c) => c + 1);
    reloadPlaylists();
  }, [reloadPlaylists]);

  const handleLoadMore = useCallback(() => {
    loadTracks(false);
  }, [loadTracks]);

  // Keyboard shortcuts (issue #1).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const isInput =
        tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
      const cmd = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd shortcuts work even inside inputs.
      if (cmd && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("search-input")?.focus();
        return;
      }
      if (cmd && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setViewMode("library");
        setSelectedPlaylistId(null);
        setSearchQuery("");
        return;
      }
      if (cmd && e.key.toLowerCase() === "i") {
        e.preventDefault();
        const first = selectedTrackIds.size > 0 ? Array.from(selectedTrackIds)[0] : null;
        const t = first != null ? tracks.find((x) => x.trackId === first) : null;
        if (t) setEditorTrack(t);
        return;
      }

      // Other shortcuts: skip when typing in an input.
      if (isInput) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("search-input")?.focus();
      } else if (e.key === " ") {
        e.preventDefault();
        if (isTauri) {
          if (playback.isPlaying) playbackApi.pause();
          else if (playback.currentTrackId !== null) playbackApi.resume();
        }
      } else if (e.key === "Enter") {
        // Play the first selected track.
        const first = selectedTrackIds.size > 0 ? Array.from(selectedTrackIds)[0] : null;
        if (first != null && isTauri) {
          playbackApi.playTrack(first).catch((err) => console.error(err));
        }
      } else if (e.key.toLowerCase() === "j") {
        if (isTauri) playbackApi.playPrev();
      } else if (e.key.toLowerCase() === "k") {
        if (isTauri) playbackApi.playNext();
      } else if (e.key.toLowerCase() === "s") {
        const next = !shuffle;
        setShuffle(next);
        if (isTauri) playbackApi.setShuffle(next);
      } else if (e.key.toLowerCase() === "r") {
        const order = ["off", "all", "one"] as const;
        const i = order.indexOf(repeat);
        const next = order[(i + 1) % order.length];
        setRepeat(next);
        if (isTauri) playbackApi.setRepeat(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const v = Math.min(1, volume + 0.05);
        setVolume(v);
        if (isTauri) playbackApi.setVolume(v);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const v = Math.max(0, volume - 0.05);
        setVolume(v);
        if (isTauri) playbackApi.setVolume(v);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    playback.isPlaying,
    playback.currentTrackId,
    selectedTrackIds,
    tracks,
    shuffle,
    repeat,
    volume,
    setShuffle,
    setRepeat,
    setVolume,
    setSearchQuery,
    setViewMode,
    setSelectedPlaylistId,
  ]);

  const isAlbumView = viewMode === "albums" || viewMode === "artists";

  return (
    <div className="app">
      <Sidebar onPlaylistsChanged={triggerReload} />
      <div className="cb-main">
        <UpdateBanner />
        <Toolbar
          onLibraryChanged={triggerReload}
          onOpenRipDialog={() => setRipOpen(true)}
          onOpenRulesPanel={() => setRulesOpen(true)}
        />
        {isAlbumView ? (
          <AlbumView
            mode={viewMode === "albums" ? "album" : "artist"}
            onTracksChanged={triggerReload}
          />
        ) : displayMode === "covers" ? (
          <CoversView onLoadMore={handleLoadMore} />
        ) : (
          <TrackTable
            onLoadMore={handleLoadMore}
            onTracksChanged={triggerReload}
            onEditTrack={(t) => setEditorTrack(t)}
            onConvert={(ids) => setConvertIds(ids)}
          />
        )}
      </div>
      <RightRail onPlaylistsChanged={triggerReload} />
      <PlayerBar />
      <RipDialog open={ripOpen} onClose={() => setRipOpen(false)} onLibraryChanged={triggerReload} />
      <RulesPanel open={rulesOpen} onClose={() => setRulesOpen(false)} onLibraryChanged={triggerReload} />
      {editorTrack && (
        <TrackEditor
          track={editorTrack}
          onClose={() => setEditorTrack(null)}
          onSaved={triggerReload}
        />
      )}
      {convertIds && (
        <ConvertDialog
          trackIds={convertIds}
          onClose={() => setConvertIds(null)}
          onLibraryChanged={triggerReload}
        />
      )}
    </div>
  );
}
