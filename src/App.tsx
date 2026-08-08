import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { TrackTable } from "./components/TrackTable";
import { AlbumsView } from "./components/AlbumsView";
import { TracksView } from "./components/TracksView";
import { AlbumView } from "./components/AlbumView";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Toolbar } from "./components/Toolbar";
import { TrackEditor } from "./components/TrackEditor";
import { RipDialog } from "./components/ripper/RipDialog";
import { RulesPanel } from "./components/rules/RulesPanel";
import { ConvertDialog } from "./components/ConvertDialog";
import { SmartPlaylistEditor } from "./components/SmartPlaylistEditor";
import { SettingsDialog } from "./components/SettingsDialog";
import { PairingApprovalDialog } from "./components/PairingApprovalDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { DiscDetectedBanner } from "./components/DiscDetectedBanner";
import { Toaster } from "./components/Toaster";
import { RipStatusBar } from "./components/RipStatusBar";
import { DropImportOverlay } from "./components/DropImportOverlay";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { SyncProvisionDialog } from "./components/SyncProvisionDialog";
import { TriagePanel } from "./components/TriagePanel";
import { useStore } from "./store/useStore";
import { useDiscWatcher } from "./hooks/useDiscWatcher";
import * as libraryApi from "./api/library";
import * as playlistsApi from "./api/playlists";
import * as playbackApi from "./api/playback";
import * as systemApi from "./api/system";
import * as analysisApi from "./api/analysis";
import * as ripperApi from "./api/ripper";
import * as fontsApi from "./api/fonts";
import * as audition from "./lib/audition";
import {
  filterInboxTracks,
  INBOX_FETCH_LIMIT,
  loadTriagePersist,
} from "./lib/triage";
import type { Track } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;

export default function App() {
  const {
    viewMode,
    selectedPlaylistId,
    playlists,
    searchQuery,
    filterTags,
    setTracks,
    appendTracks,
    setAlbums,
    appendAlbums,
    setAlbumsHasMore,
    setPlaylists,
    setIsLoading,
    setHasMore,
    setPlayback,
    tracks,
    albums,
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
    rightRailVisible,
    rightRailWidth,
    setRightRailVisible,
    setRailTab,
    setSimilarBase,
    addTracksToCrate,
    setAnalyses,
    setAnalysisActive,
    setRipStatus,
    appendRipLog,
    pushToast,
    triageMode,
    enterTriage,
    exitTriage,
    setInboxCount,
    inboxCount,
  } = useStore();

  const ripStatus = useStore((s) => s.ripStatus);

  const PAGE_SIZE = 500;
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  // 自動 XML エクスポート用: ライブラリに変更があったか。
  const libraryDirtyRef = useRef(false);
  // デバウンス自動保存用。
  const autoExportTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoExportInFlightRef = useRef(false);
  // scheduleAutoExport から最新の runAutoExport を参照するための ref (循環依存回避)。
  const runAutoExportCallbackRef = useRef<() => Promise<void>>(async () => {});
  const [reloadCount, setReloadCount] = useState(0);
  const [ripOpen, setRipOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editorTracks, setEditorTracks] = useState<Track[] | null>(null);
  const [convertIds, setConvertIds] = useState<number[] | null>(null);
  const [smartEditor, setSmartEditor] = useState<{
    playlistId: number | null;
    name?: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncProvisionOpen, setSyncProvisionOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { detectedDisc, dismiss: dismissDisc } = useDiscWatcher({
    enabled: !ripOpen && ripStatus?.phase !== "ripping",
  });

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

        if (viewMode === "inbox") {
          // dateAdded desc で直近を取り、クライアントで done/later/未評価フィルタ。
          const raw = await libraryApi.getTracks(
            INBOX_FETCH_LIMIT,
            0,
            "dateAdded",
            "desc",
          );
          result = filterInboxTracks(raw, loadTriagePersist());
          setTracks(result);
          setHasMore(false);
          setInboxCount(result.length);
        } else if (viewMode === "recent") {
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
          const pl = playlists.find((p) => p.playlistId === selectedPlaylistId);
          result = pl?.isSmart
            ? await playlistsApi.getSmartPlaylistTracks(
                selectedPlaylistId,
                PAGE_SIZE,
                offset,
                sortField,
                sortOrder,
              )
            : await playlistsApi.getPlaylistTracks(
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
    [
      viewMode,
      selectedPlaylistId,
      playlists,
      searchQuery,
      filterTags,
      sortField,
      sortOrder,
      tracks.length,
      setTracks,
      appendTracks,
      setHasMore,
      setIsLoading,
      setInboxCount,
    ],
  );

  // サイドバーバッジ用: 起動時とライブラリ変更後に Inbox 件数を軽量更新。
  const refreshInboxCount = useCallback(async () => {
    if (!isTauri) {
      setInboxCount(0);
      return;
    }
    try {
      const raw = await libraryApi.getTracks(
        INBOX_FETCH_LIMIT,
        0,
        "dateAdded",
        "desc",
      );
      const inbox = filterInboxTracks(raw, loadTriagePersist());
      setInboxCount(inbox.length);
    } catch (err) {
      console.error("Failed to refresh inbox count:", err);
    }
  }, [setInboxCount]);

  useEffect(() => {
    loadTracks(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedPlaylistId, searchQuery, filterTags, sortField, sortOrder, reloadCount]);

  useEffect(() => {
    void refreshInboxCount();
  }, [reloadCount, refreshInboxCount]);

  // Albums 表示モード用ローダ。ライブラリ全体 (検索なし) のときだけサーバ集約を使う。
  // スコープ外 (プレイリスト/検索/最近) は AlbumsView が tracks をクライアント束ねする。
  const loadAlbums = useCallback(
    async (reset = true) => {
      if (!isTauri) {
        setAlbums([]);
        setAlbumsHasMore(false);
        return;
      }
      const combinedQuery = [searchQuery.trim(), ...filterTags].filter(Boolean).join(" ");
      const isLibraryScope = viewMode === "library" && !combinedQuery;
      if (!isLibraryScope) return;
      setIsLoading(true);
      try {
        const offset = reset ? 0 : albums.length;
        const result = await libraryApi.getAlbums(sortField, sortOrder, PAGE_SIZE, offset);
        if (reset) setAlbums(result);
        else appendAlbums(result);
        setAlbumsHasMore(result.length === PAGE_SIZE);
      } catch (err) {
        console.error("Failed to load albums:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [viewMode, searchQuery, filterTags, sortField, sortOrder, albums.length, setAlbums, appendAlbums, setAlbumsHasMore, setIsLoading],
  );

  useEffect(() => {
    if (displayMode !== "albums") return;
    loadAlbums(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode, viewMode, searchQuery, filterTags, sortField, sortOrder, reloadCount]);

  useEffect(() => {
    reloadPlaylists();
  }, [reloadPlaylists]);

  // フォント設定の初期適用（保存済みフォント + CJK フォントの読み込み）。
  useEffect(() => {
    if (!isTauri) return;
    fontsApi.initFonts().catch(() => {});
  }, []);

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

  // 「閉じるときに更新」: 閉じる要求を捕まえ、予約があればインストーラを起動してから閉じる。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        const st = useStore.getState();
        const pending = st.pendingUpdate;
        const needsExport =
          st.autoExportEnabled && !!st.autoExportPath && libraryDirtyRef.current;
        if (!pending && !needsExport) return; // 何も無ければ通常どおり閉じる
        event.preventDefault();
        // 閉じる前に最新のライブラリを書き出しておく。
        if (needsExport && st.autoExportPath) {
          try {
            await libraryApi.exportLibrary(st.autoExportPath);
            libraryDirtyRef.current = false;
          } catch (e) {
            console.error("auto-export on close failed:", e);
          }
        }
        if (pending) {
          setInstalling(true);
          try {
            await playbackApi.stop().catch(() => {});
            await systemApi.downloadAndRunUpdate(pending.url);
          } catch (e) {
            console.error("update on close failed:", e);
          }
        }
        await win.destroy();
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 曲送り(自動遷移)はバックエンドのワーカーが行う。
  // ポーリングはやめ、`playback-advanced` イベントを購読して即時に再生状態を反映する。
  // (250ms の状態ポーリングは位置表示用に残してあるが、それを待たずに UI を更新するため。)
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await playbackApi.onPlaybackAdvanced(async () => {
        try {
          const state = await playbackApi.getPlaybackState();
          setPlayback(state);
        } catch {
          // ignore
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [setPlayback]);

  // プレビュー曲が終端に達したとき: ワーカーが auto-advance せず停止し preview-ended を発火する。
  // Esc と同じく元の曲・位置へ復帰する。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await playbackApi.onPreviewEnded(() => {
        const { previewActive } = useStore.getState();
        // バックエンドが先に PreviewMode を落としても、フロントの復帰先は残っている。
        if (previewActive || useStore.getState().previewReturn != null) {
          audition.exitPreview({ restore: true }).catch(() => {});
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const scheduleAutoExport = useCallback(() => {
    clearTimeout(autoExportTimerRef.current);
    autoExportTimerRef.current = setTimeout(() => {
      runAutoExportCallbackRef.current();
    }, 3000);
  }, []);

  const runAutoExport = useCallback(async () => {
    const { autoExportEnabled, autoExportPath } = useStore.getState();
    if (!autoExportEnabled || !autoExportPath || !libraryDirtyRef.current) return;
    if (autoExportInFlightRef.current) return;
    autoExportInFlightRef.current = true;
    libraryDirtyRef.current = false; // optimistic クリア
    try {
      await libraryApi.exportLibrary(autoExportPath);
    } catch (e) {
      libraryDirtyRef.current = true;
      console.error("auto-export failed:", e);
      useStore.getState().pushToast("error", "ライブラリの自動保存に失敗しました");
      scheduleAutoExport();
    } finally {
      autoExportInFlightRef.current = false;
      if (libraryDirtyRef.current) scheduleAutoExport();
    }
  }, [scheduleAutoExport]);
  // ref を最新の実装で更新する。
  runAutoExportCallbackRef.current = runAutoExport;

  // 内蔵 API 経由の変更（プレイリスト作成・曲追加/削除）を即時反映する。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await playlistsApi.onLibraryChanged(() => {
        useStore.getState().bumpArtworkEpoch();
        reloadPlaylists();
        setReloadCount((c) => c + 1);
        libraryDirtyRef.current = true;
        scheduleAutoExport();
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [reloadPlaylists, scheduleAutoExport]);

  const triggerReload = useCallback(() => {
    libraryDirtyRef.current = true; // 変更があったので次回の自動エクスポート対象。
    scheduleAutoExport();
    setReloadCount((c) => c + 1);
    reloadPlaylists();
  }, [reloadPlaylists, scheduleAutoExport]);

  // CD リッピング進捗のグローバル購読
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await ripperApi.onRipProgress((p) => {
        if (p.kind === "start") {
          setRipStatus({
            phase: "ripping",
            current: 0,
            total: p.total,
            label: "",
            log: [`Starting rip (${p.total} tracks)`],
          });
        } else if (p.kind === "trackStart") {
          const prev = useStore.getState().ripStatus;
          setRipStatus({
            phase: "ripping",
            current: p.index + 1,
            total: p.total,
            label: p.label,
            log: prev?.log ?? [],
            addedTracks: prev?.addedTracks,
          });
          appendRipLog(`[${p.index + 1}/${p.total}] ripping: ${p.label}`);
        } else if (p.kind === "trackProgress") {
          const cur = useStore.getState().ripStatus;
          if (cur) useStore.getState().setRipStatus({ ...cur, percent: p.percent });
        } else if (p.kind === "trackDone") {
          appendRipLog(`  → ${p.outputPath}`);
        } else if (p.kind === "done") {
          const prev = useStore.getState().ripStatus;
          setRipStatus({
            phase: "done",
            current: prev?.total ?? p.writtenFiles.length,
            total: prev?.total ?? p.writtenFiles.length,
            label: prev?.label ?? "",
            log: [...(prev?.log ?? []), `Done. ${p.writtenFiles.length} file(s), ${p.addedTracks} added.`],
            addedTracks: p.addedTracks,
          });
          triggerReload();
          pushToast("success", `リッピング完了: ${p.addedTracks} 曲`);
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [setRipStatus, appendRipLog, pushToast, triggerReload]);

  // iTunes 互換 XML の自動エクスポート: デバウンスで3秒後に保存。5分インターバルはセーフティネット。
  useEffect(() => {
    if (!isTauri) return;
    const INTERVAL_MS = 5 * 60 * 1000; // 5 分 (セーフティネット)
    const id = setInterval(() => {
      runAutoExport();
    }, INTERVAL_MS);
    return () => {
      clearInterval(id);
      clearTimeout(autoExportTimerRef.current);
    };
  }, [runAutoExport]);

  const handleLoadMore = useCallback(() => {
    if (displayMode === "albums") {
      const combinedQuery = [searchQuery.trim(), ...filterTags].filter(Boolean).join(" ");
      const isLibraryScope = viewMode === "library" && !combinedQuery;
      if (isLibraryScope) {
        loadAlbums(false);
        return;
      }
    }
    loadTracks(false);
  }, [displayMode, viewMode, searchQuery, filterTags, loadAlbums, loadTracks]);

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
        exitTriage();
        setViewMode("library");
        setSelectedPlaylistId(null);
        setSearchQuery("");
        return;
      }
      if (cmd && e.key.toLowerCase() === "i") {
        e.preventDefault();
        const sel = tracks.filter((x) => selectedTrackIds.has(x.trackId));
        if (sel.length > 0) setEditorTracks(sel);
        return;
      }
      // Ctrl/Cmd+↑/↓ で音量 ±0.05(0〜1 にクランプ)。input にフォーカス中でも効く。
      if (cmd && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? 0.05 : -0.05;
        const next = Math.min(1, Math.max(0, volume + delta));
        setVolume(next);
        if (isTauri) playbackApi.setVolume(next).catch(() => {});
        return;
      }

      // 選曲ワークベンチ (#117): Ctrl/Cmd 系は入力中でも効かせる。
      if (cmd && e.key === "]") {
        e.preventDefault();
        setRightRailVisible(true);
        return;
      }
      if (cmd && !e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")) {
        e.preventDefault();
        setRightRailVisible(true);
        const tab =
          e.key === "1" ? "now" : e.key === "2" ? "next" : e.key === "3" ? "crate" : "similar";
        setRailTab(tab);
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const first =
          selectedTrackIds.size > 0 ? Array.from(selectedTrackIds)[0] : null;
        if (first != null) {
          setRightRailVisible(true);
          setSimilarBase(first);
        }
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (selectedTrackIds.size === 0) return;
        // 選択 id から Map 引きで解決 (tracks 全走査の filter を避ける)
        const byId = new Map(tracks.map((t) => [t.trackId, t]));
        const selected: typeof tracks = [];
        for (const id of selectedTrackIds) {
          const t = byId.get(id);
          if (t) selected.push(t);
        }
        addTracksToCrate(selected);
        setRightRailVisible(true);
        setRailTab("crate");
        return;
      }

      // Other shortcuts: skip when typing in an input.
      if (isInput) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }

      // Triage 中は専用ショートカットが capture で処理する。ここでは触らない。
      if (useStore.getState().triageMode) return;

      // Inbox リストで T → Triage 開始
      if (
        e.key.toLowerCase() === "t" &&
        !cmd &&
        !e.altKey &&
        !e.shiftKey &&
        useStore.getState().viewMode === "inbox"
      ) {
        e.preventDefault();
        if (useStore.getState().tracks.length > 0) {
          enterTriage(0);
        }
        return;
      }

      // Preview セッション中の Esc: 元の曲・位置へ復帰 (入力フォーカス外のみ)。
      if (e.key === "Escape") {
        const { previewActive } = useStore.getState();
        if (previewActive) {
          e.preventDefault();
          if (isTauri) audition.exitPreview({ restore: true }).catch(() => {});
          return;
        }
      }

      // Audition: Alt+←/→ で ±15 秒 (audition ON 時)。
      if (
        e.altKey &&
        !e.shiftKey &&
        !cmd &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        const { auditionMode } = useStore.getState();
        if (auditionMode) {
          e.preventDefault();
          if (isTauri) {
            const delta = e.key === "ArrowRight" ? 15_000 : -15_000;
            audition.seekRelative(delta).catch(() => {});
          }
          return;
        }
      }

      // Shift+←/→ で ±5 秒シーク（位置・長さは最新の state から読む）。
      if (e.shiftKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const { playback: pb } = useStore.getState();
        if (pb.currentTrackId === null) return;
        const delta = e.key === "ArrowRight" ? 5000 : -5000;
        const next = Math.min(
          pb.durationMs || Number.MAX_SAFE_INTEGER,
          Math.max(0, pb.positionMs + delta),
        );
        if (isTauri) playbackApi.seek(next).catch(() => {});
        return;
      }
      // ? でショートカット一覧オーバーレイをトグル。
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
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
        // Play the first selected track (通常再生: preview を閉じる)。
        const first = selectedTrackIds.size > 0 ? Array.from(selectedTrackIds)[0] : null;
        if (first != null && isTauri) {
          audition
            .ensureNormalPlay()
            .then(() => playbackApi.playTrack(first))
            .catch((err) => console.error(err));
        }
      } else if (e.key.toLowerCase() === "a" && !e.shiftKey && !e.altKey && !cmd) {
        // Audition モード トグル
        e.preventDefault();
        audition.toggleAuditionMode();
      } else if (e.key === "1" || e.key === "2" || e.key === "3") {
        // 曲内ジャンプ 25% / 50% / 75% (Audition ON 時、修飾キーなし)
        const { auditionMode } = useStore.getState();
        if (auditionMode && !cmd && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          const ratio = e.key === "1" ? 0.25 : e.key === "2" ? 0.5 : 0.75;
          if (isTauri) audition.seekRatio(ratio).catch(() => {});
        }
      } else if (e.key === "Home") {
        const { auditionMode, playback: pb } = useStore.getState();
        if (auditionMode && pb.currentTrackId != null) {
          e.preventDefault();
          if (isTauri) playbackApi.seek(0).catch(() => {});
        }
      } else if (e.key === "End") {
        const { auditionMode, playback: pb } = useStore.getState();
        if (auditionMode && pb.currentTrackId != null && pb.durationMs > 0) {
          e.preventDefault();
          const pos = Math.max(0, pb.durationMs - 3000);
          if (isTauri) playbackApi.seek(pos).catch(() => {});
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
      }
      // 矢印キーは TrackTable の選択移動に使うのでここでは扱わない。
      // 音量は PlayerBar の +/- とスライダーで調整できる。
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
    setVolume,
    setShuffle,
    setRepeat,
    setSearchQuery,
    setViewMode,
    setSelectedPlaylistId,
    setRightRailVisible,
    setRailTab,
    setSimilarBase,
    addTracksToCrate,
    enterTriage,
    exitTriage,
  ]);

  const isAlbumView = viewMode === "albums" || viewMode === "artists";

  // 右ペイン幅の CSS 変数は React style ではなく effect で同期する。
  // リサイズ中は RightRail が DOM を直接更新し、store は pointerup まで触らないため、
  // ここは rightRailWidth が変わったときだけ上書きする (他の store 更新では触らない)。
  const appRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = appRef.current;
    if (!el) return;
    if (rightRailVisible) {
      el.style.setProperty("--rail-w", `${rightRailWidth}px`);
    } else {
      el.style.removeProperty("--rail-w");
    }
  }, [rightRailVisible, rightRailWidth]);

  const handleRemoveFromInbox = useCallback(
    (_trackId: number) => {
      // TriagePanel が先に setTracks 済み。現在の tracks 件数をバッジへ反映。
      const n = useStore.getState().tracks.length;
      setInboxCount(Math.max(0, n));
    },
    [setInboxCount],
  );

  return (
    <div
      ref={appRef}
      className={"app" + (rightRailVisible ? "" : " no-rail")}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        // 入力欄ではコピー&ペースト用のメニューを残す
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        e.preventDefault();
      }}
    >
      <Sidebar
        onPlaylistsChanged={triggerReload}
        onEditSmart={(id, name) => setSmartEditor({ playlistId: id, name })}
      />
      <div className="cb-main">
        <UpdateBanner />
        <Toolbar
          onLibraryChanged={triggerReload}
          onOpenRipDialog={() => setRipOpen(true)}
          onOpenRulesPanel={() => setRulesOpen(true)}
          onOpenSyncProvision={() => setSyncProvisionOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {viewMode === "inbox" && !triageMode && (
          <div className="inbox-banner">
            <span className="inbox-banner-text">
              Inbox · {inboxCount.toLocaleString()} 曲未処理
            </span>
            <button
              type="button"
              className="toolbar-btn primary"
              disabled={tracks.length === 0}
              onClick={() => enterTriage(0)}
              title="Triage を開始 (T)"
            >
              Triage 開始
            </button>
            {tracks.length === 0 && (
              <span className="inbox-banner-empty">クリア済み 🎉</span>
            )}
          </div>
        )}
        {viewMode === "inbox" && triageMode ? (
          <TriagePanel
            tracks={tracks}
            onRemoveFromInbox={handleRemoveFromInbox}
          />
        ) : isAlbumView ? (
          <AlbumView
            mode={viewMode === "albums" ? "album" : "artist"}
            onTracksChanged={triggerReload}
          />
        ) : displayMode === "albums" ? (
          <AlbumsView
            onLoadMore={handleLoadMore}
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids) => setConvertIds(ids)}
          />
        ) : displayMode === "tracks" ? (
          <TracksView
            onLoadMore={handleLoadMore}
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids) => setConvertIds(ids)}
          />
        ) : (
          <TrackTable
            onLoadMore={handleLoadMore}
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids) => setConvertIds(ids)}
          />
        )}
      </div>
      {rightRailVisible && <RightRail onPlaylistsChanged={triggerReload} />}
      <PlayerBar />
      <RipStatusBar onOpenLog={() => setRipOpen(true)} />
      <RipDialog open={ripOpen} onClose={() => setRipOpen(false)} onLibraryChanged={triggerReload} />
      <RulesPanel open={rulesOpen} onClose={() => setRulesOpen(false)} onLibraryChanged={triggerReload} />
      {editorTracks && (
        <TrackEditor
          tracks={editorTracks}
          onClose={() => setEditorTracks(null)}
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
      {smartEditor && (
        <SmartPlaylistEditor
          playlistId={smartEditor.playlistId}
          initialName={smartEditor.name}
          onClose={() => setSmartEditor(null)}
          onSaved={triggerReload}
        />
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {syncProvisionOpen && (
        <SyncProvisionDialog
          onClose={() => setSyncProvisionOpen(false)}
          onLibraryChanged={triggerReload}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {detectedDisc && (
        <DiscDetectedBanner
          disc={detectedDisc}
          onRip={() => { dismissDisc(); setRipOpen(true); }}
          onDismiss={dismissDisc}
        />
      )}
      {/* クライアント接続時のプッシュ承認ポップアップ（常設マウント）。 */}
      <PairingApprovalDialog />
      <Toaster />
      {/* エクスプローラー/Finder からのドラッグ&ドロップ取り込み（issue #70） */}
      {isTauri && <DropImportOverlay onImported={triggerReload} />}
      {installing && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 380, padding: 28, textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              アップデートを準備しています…
            </div>
            <div style={{ fontSize: 13, color: "var(--mut)" }}>
              インストーラをダウンロードして起動します。そのままお待ちください。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
