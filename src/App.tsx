import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { TrackTable } from "./components/TrackTable";
import { AlbumsView } from "./components/AlbumsView";
import { TracksView } from "./components/TracksView";
import { ArtistsView } from "./components/ArtistsView";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Toolbar } from "./components/Toolbar";
import { TrackEditor } from "./components/TrackEditor";
import { RipDialog } from "./components/ripper/RipDialog";
import { ImportDuplicatesDialog } from "./components/ImportDuplicatesDialog";
import { RulesPanel } from "./components/rules/RulesPanel";
import { ConvertDialog } from "./components/ConvertDialog";
import { SmartPlaylistEditor } from "./components/SmartPlaylistEditor";
import { SettingsDialog } from "./components/SettingsDialog";
import { PairingApprovalDialog } from "./components/PairingApprovalDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { DiscDetectedDialog } from "./components/DiscDetectedDialog";
import { Toaster } from "./components/Toaster";
import { RipStatusBar } from "./components/RipStatusBar";
import { DropImportOverlay } from "./components/DropImportOverlay";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { SyncProvisionDialog } from "./components/SyncProvisionDialog";
import { UsbExportDialog } from "./components/UsbExportDialog";
import { UsbExportStatusBar } from "./components/UsbExportStatusBar";
import { TriagePanel } from "./components/TriagePanel";
import { SetHistoryView } from "./components/SetHistoryView";
import { useStore, markSetWorkspaceHydrationDone } from "./store/useStore";
import { useTrackListQuery } from "./hooks/useTrackList";
import { useCurrentTrack } from "./hooks/useCurrentTrack";
import { selectionTooLargeMessage } from "./lib/selectionLimit";
import { useDiscWatcher } from "./hooks/useDiscWatcher";
import { useUsbExportEvents } from "./hooks/useUsbExportEvents";
import * as libraryApi from "./api/library";
import * as playlistsApi from "./api/playlists";
import * as playbackApi from "./api/playback";
import * as castApi from "./api/cast";
import * as openWithApi from "./api/openWith";
import * as systemApi from "./api/system";
import * as analysisApi from "./api/analysis";
import * as ripperApi from "./api/ripper";
import * as fontsApi from "./api/fonts";
import * as audition from "./lib/audition";
import { playOpenedFiles } from "./lib/openWith";
import {
  INBOX_FETCH_LIMIT,
  loadTriagePersist,
  mergeInboxSources,
} from "./lib/triage";
import { loadSetWorkspacePersist } from "./lib/setWorkspacePersist";
import type { ConvertMode, DiscToc, PlaybackState, RepeatMode, Track } from "./types";
import { isTauri } from "./lib/env";
import { useTauriEvent } from "./hooks/useTauriEvent";

// 窓の幅がこれ未満なら右ペインを自動で畳む (最小 1024px でも曲名列が潰れないように)。
const RAIL_AUTO_HIDE_WIDTH = 1200;


/// Rust プレイヤー側の「フロントのストアと二重管理になっている値」。
type RemotePlayerState = { shuffle: boolean; repeat: RepeatMode; volume: number };

/// f32 で往復するので音量は誤差を許容して比較する。
const VOLUME_EPS = 0.005;

/// 解析進捗 (analysis-progress の item) をストアへ反映する最短間隔 (ms)。
const ANALYSIS_PROGRESS_THROTTLE_MS = 250;

/// Rust プレイヤーの shuffle / repeat / volume をストアへ逆同期する。
/// リモート API (/api/remote/shuffle など) や別クライアントからの変更を拾うのが目的。
/// ローカル操作は backend 完了後にストアへ書くので基本的に食い違わないが、
/// 念のため「2 回続けて同じ値がストアと違う」ときだけ反映して取り合いを防ぐ。
function reconcilePlayerState(
  state: PlaybackState,
  lastRemoteRef: { current: RemotePlayerState | null },
) {
  const remote: RemotePlayerState = {
    shuffle: state.shuffle,
    repeat: state.repeat,
    volume: state.volume,
  };
  const prev = lastRemoteRef.current;
  lastRemoteRef.current = remote;
  if (!prev) return;
  const store = useStore.getState();
  if (prev.shuffle === remote.shuffle && remote.shuffle !== store.shuffle) {
    store.setShuffle(remote.shuffle);
  }
  if (prev.repeat === remote.repeat && remote.repeat !== store.repeat) {
    store.setRepeat(remote.repeat);
  }
  if (
    Math.abs(prev.volume - remote.volume) <= VOLUME_EPS &&
    Math.abs(remote.volume - store.volume) > VOLUME_EPS
  ) {
    store.setVolume(remote.volume);
  }
}

export default function App() {
  const {
    viewMode,
    selectedPlaylistId,
    setTracks,
    setSelectedTrackIds,
    bumpLibraryRevision,
    setPlaylists,
    setIsLoading,
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
    setTriageIndex,
    setInboxCount,
    inboxCount,
  } = useStore();

  const ripStatus = useStore((s) => s.ripStatus);

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  // マウント時の push (永続値 → Rust) が終わるまでは逆同期しない。
  const mountSyncedRef = useRef(false);
  // 直前のポーリングで見えた Rust 側の shuffle / repeat / volume。
  const lastRemoteRef = useRef<RemotePlayerState | null>(null);
  // 自動 XML エクスポート用: ライブラリに変更があったか。
  const libraryDirtyRef = useRef(false);
  // デバウンス自動保存用。
  const autoExportTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoExportInFlightRef = useRef(false);
  // scheduleAutoExport から最新の runAutoExport を参照するための ref (循環依存回避)。
  const runAutoExportCallbackRef = useRef<() => Promise<void>>(async () => {});
  // ライブラリが変わるたびに増える値 (ストアに置き、各ビューが見て取り直す)。
  const reloadCount = useStore((s) => s.libraryRevision);
  const [ripOpen, setRipOpen] = useState(false);
  // 検出ダイアログから開いたときに RipDialog へ渡すディスク (検出元ドライブ + 読み取り済み TOC)。
  // RipDialog はこれを使ってドライブ選択・再検出なしで候補照会から始める。
  const [ripInitialDisc, setRipInitialDisc] = useState<DiscToc | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editorTracks, setEditorTracks] = useState<Track[] | null>(null);
  const [convertReq, setConvertReq] = useState<{ ids: number[]; mode: ConvertMode } | null>(null);
  const [smartEditor, setSmartEditor] = useState<{
    playlistId: number | null;
    name?: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncProvisionOpen, setSyncProvisionOpen] = useState(false);
  // USB 書き出しダイアログ (開いているときは初期選択のプレイリスト ID 群)。
  const [usbExportIds, setUsbExportIds] = useState<number[] | null>(null);
  // 書き出しの進捗はダイアログを閉じていても store に集める。
  useUsbExportEvents();
  const [helpOpen, setHelpOpen] = useState(false);
  const { detectedDisc, dismiss: dismissDisc } = useDiscWatcher({
    enabled: !ripOpen && ripStatus?.phase !== "ripping",
  });

  const reloadPlaylists = useCallback(async () => {
    if (!isTauri) return;
    try {
      const pls = await playlistsApi.getPlaylists();
      setPlaylists(pls);
      // 永続化された選択プレイリスト (#160) が、読み込んだ一覧に無ければ
      // （削除された／別ライブラリの ID など）Library 表示へフォールバックする。
      const st = useStore.getState();
      if (
        st.viewMode === "playlist" &&
        st.selectedPlaylistId !== null &&
        !pls.some((p) => p.playlistId === st.selectedPlaylistId)
      ) {
        setViewMode("library");
        setSelectedPlaylistId(null);
      }
    } catch (err) {
      console.error("Failed to load playlists:", err);
    }
  }, [setPlaylists, setViewMode, setSelectedPlaylistId]);

  // 表示中の曲の一覧。ライブラリ / 検索 / プレイリストは各ビューが件数と見えている範囲を取得する
  // (docs/library-list/design.md)。ここではメモリ上の一覧 (Inbox / 最近) だけを扱う。
  const { query: listQuery, group: listGroup } = useTrackListQuery();

  // 見ている一覧 (スコープ・検索) が変わったら選択を解除する。並び順の変更や一覧の取り直しでは
  // 残す (選択は trackId で持つ。一覧から消えた曲は TrackTable が取り直しのあとで外す)。
  useEffect(() => {
    setSelectedTrackIds(new Set());
  }, [listGroup, setSelectedTrackIds]);

  // メモリ上の一覧 (Inbox / 最近再生した曲) を組み立ててストアの tracks に置く。
  const memorySource = listQuery.kind === "memory" ? listQuery.source : null;
  const memoryLoadGenRef = useRef(0);
  const loadMemoryTracks = useCallback(async () => {
    // 一覧系コマンドはメインスレッド外で並行実行されるため (#213)、応答順が
    // 呼び出し順と一致しない。古い呼び出しの結果で新しい表示を上書きしないよう、
    // 最新の呼び出し以外の結果は捨てる。
    const gen = ++memoryLoadGenRef.current;
    const stale = () => gen !== memoryLoadGenRef.current;

    if (!isTauri || memorySource === null) {
      // ライブラリ / プレイリスト / 検索 / Set History は tracks を使わない。
      if (useStore.getState().tracks.length > 0) setTracks([]);
      setIsLoading(false);
      return;
    }

    // Triage 中の reload でフォーカス曲を失わないよう、fetch 前に trackId を捕捉
    const stBefore = useStore.getState();
    const focusedTrackId =
      stBefore.viewMode === "inbox" && stBefore.triageMode
        ? (stBefore.tracks[stBefore.triageIndex]?.trackId ?? null)
        : null;
    const prevTriageIndex = stBefore.triageIndex;

    setIsLoading(true);
    try {
      if (memorySource === "inbox") {
        // 直近 INBOX_FETCH_LIMIT 件 + laterIds 欠損分を getTracksByIds で合流。
        const persist = loadTriagePersist();
        const raw = await libraryApi.getTracks(INBOX_FETCH_LIMIT, 0, "dateAdded", "desc");
        const present = new Set(raw.map((t) => t.trackId));
        const missingLater = persist.laterIds.filter((id) => !present.has(id));
        const laterExtra =
          missingLater.length > 0 ? await libraryApi.getTracksByIds(missingLater) : [];
        if (stale()) return;
        const result = mergeInboxSources(raw, laterExtra, persist);
        setTracks(result);
        setInboxCount(result.length);
        // triage 中ならフォーカス曲の index を復元
        const stAfter = useStore.getState();
        if (stAfter.triageMode && focusedTrackId != null) {
          const idx = result.findIndex((t) => t.trackId === focusedTrackId);
          if (idx >= 0) {
            setTriageIndex(idx);
          } else {
            setTriageIndex(result.length === 0 ? 0 : Math.min(prevTriageIndex, result.length - 1));
          }
        }
      } else {
        const result = await playbackApi.getRecentTracks(200);
        if (stale()) return;
        setTracks(result);
      }
    } catch (err) {
      if (!stale()) console.error("Failed to load tracks:", err);
    } finally {
      if (!stale()) setIsLoading(false);
    }
  }, [memorySource, setTracks, setIsLoading, setInboxCount, setTriageIndex]);

  // サイドバーバッジ用: 起動時とライブラリ変更後に Inbox 件数を軽量更新。
  const refreshInboxCount = useCallback(async () => {
    if (!isTauri) {
      setInboxCount(0);
      return;
    }
    try {
      const persist = loadTriagePersist();
      const raw = await libraryApi.getTracks(
        INBOX_FETCH_LIMIT,
        0,
        "dateAdded",
        "desc",
      );
      const present = new Set(raw.map((t) => t.trackId));
      const missingLater = persist.laterIds.filter((id) => !present.has(id));
      const laterExtra =
        missingLater.length > 0
          ? await libraryApi.getTracksByIds(missingLater)
          : [];
      const inbox = mergeInboxSources(raw, laterExtra, persist);
      setInboxCount(inbox.length);
    } catch (err) {
      console.error("Failed to refresh inbox count:", err);
    }
  }, [setInboxCount]);

  useEffect(() => {
    void loadMemoryTracks();
  }, [loadMemoryTracks, reloadCount]);

  useEffect(() => {
    void refreshInboxCount();
  }, [reloadCount, refreshInboxCount]);

  useEffect(() => {
    reloadPlaylists();
  }, [reloadPlaylists]);

  // フォント設定の初期適用（保存済みフォント + CJK フォントの読み込み）。
  useEffect(() => {
    if (!isTauri) return;
    fontsApi.initFonts().catch(() => {});
  }, []);

  // マウント時に volume / shuffle / repeat を Rust プレイヤーと揃える。
  // - バックエンドが起動時に DB から再生状態を復元済み (#159) なら、そちらが正。
  //   ストアの値を押し込むと shuffle の順列を作り直してしまうので、逆にストアへ取り込む。
  // - 未保存 (初回起動) ならストアの永続値をプレイヤーへ押し込む。
  // ReplayGain は再生状態に含まれないので常にストアから押し込む。
  // 同期が終わるまでポーリング側の逆同期は保留する (mountSyncedRef)。
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlistenOpen: (() => void) | undefined;
    (async () => {
      let restored = false;
      try {
        restored = await playbackApi.getPlaybackRestored();
      } catch {
        restored = false;
      }
      if (restored) {
        try {
          const state = await playbackApi.getPlaybackState();
          const store = useStore.getState();
          store.setVolume(state.volume);
          store.setShuffle(state.shuffle);
          store.setRepeat(state.repeat);
          store.setPlayback(state);
        } catch {
          // ignore
        }
        await Promise.allSettled([playbackApi.setReplayGain(replayGain)]);
      } else {
        await Promise.allSettled([
          playbackApi.setVolume(volume),
          playbackApi.setShuffle(shuffle),
          playbackApi.setRepeat(repeat),
          playbackApi.setReplayGain(replayGain),
        ]);
      }
      mountSyncedRef.current = true;

      // OS の「このアプリで開く」で渡されたファイルを再生する。上の同期の後に始める
      // (先に再生すると shuffle の押し込みで開いた曲の再生順が組み直されるため)。
      // 先にイベントを購読してから、起動時 / 準備前に届いていた分を取り出す。
      // バックエンドはどちらか一方の経路でしか渡さないので、取りこぼしも二重再生も起きない。
      if (cancelled) return;
      const unlisten = await openWithApi.onOpenFiles((paths) => {
        void playOpenedFiles(paths);
      });
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenOpen = unlisten;
      try {
        const pending = await openWithApi.takePendingOpenFiles();
        if (pending.length > 0) await playOpenedFiles(pending);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
      unlistenOpen?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playback state poll.
  // Rust プレイヤーが持つ shuffle / repeat / volume はリモート API (/api/remote/*) から
  // 変わりうるので、ポーリングのたびにストアへ逆同期する。
  // ローカル操作 (PlayerBar / S・R キー) は backend 完了後にストアを更新するため、
  // 一過性の食い違いを掴まないよう「2 回続けて同じ値がストアと違う」ときだけ反映する。
  useEffect(() => {
    if (!isTauri) return;
    pollRef.current = setInterval(async () => {
      try {
        const state = await playbackApi.getPlaybackState();
        setPlayback(state);
        if (mountSyncedRef.current) reconcilePlayerState(state, lastRemoteRef);
      } catch {
        // ignore
      }
    }, 250);
    return () => clearInterval(pollRef.current);
  }, [setPlayback]);

  // Sync now-playing to SMTC + listen to media key events from the OS.
  // 再生中の曲のメタデータ (一覧に無い曲は ID で取り直す) は PlayerBar と同じ hook で引く。
  const smtcTrack = useCurrentTrack();
  const smtcTitle = smtcTrack?.name ?? "";
  const smtcArtist = smtcTrack?.artist ?? "";
  const smtcAlbum = smtcTrack?.album ?? "";
  // 最後に OS へ送った内容。再生中の位置は OS 側が進めてくれるので、
  // 250ms ごとではなく「曲・再生状態・メタデータが変わった」「シーク（想定位置から 2 秒超ずれた）」
  // のときと、念のための 5 秒おきの再同期だけ update_smtc を呼ぶ。
  const smtcLastRef = useRef<{ key: string; positionMs: number; at: number } | null>(null);
  useEffect(() => {
    if (!isTauri) return;

    const key = JSON.stringify([
      playback.currentTrackId,
      playback.isPlaying,
      playback.durationMs,
      smtcTitle,
      smtcArtist,
      smtcAlbum,
    ]);
    const now = Date.now();
    const last = smtcLastRef.current;
    if (last && last.key === key) {
      if (playback.isPlaying) {
        const expected = last.positionMs + (now - last.at);
        const drift = Math.abs(playback.positionMs - expected);
        if (drift <= 2000 && now - last.at < 5000) return;
      } else if (playback.positionMs === last.positionMs) {
        // 一時停止・停止中は位置が動いたとき（シーク）だけ送る。
        return;
      }
    }
    smtcLastRef.current = { key, positionMs: playback.positionMs, at: now };

    systemApi
      .updateSmtc(
        smtcTitle,
        smtcArtist,
        smtcAlbum,
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
    smtcTitle,
    smtcArtist,
    smtcAlbum,
  ]);

  useTauriEvent(() => {
    return systemApi.onSmtcButton((kind) => {
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
    // playback.isPlaying read inside handler is intentionally lagging
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解析結果の読み込み + 進捗購読 (BPM/Key/Energy)。
  // getAllAnalyses もメインスレッド外で並行実行されるので、最新の呼び出しの結果だけ反映する。
  const loadAnalysesGenRef = useRef(0);
  const loadAnalyses = useCallback(async () => {
    if (!isTauri) return;
    const gen = ++loadAnalysesGenRef.current;
    try {
      const all = await analysisApi.getAllAnalyses();
      if (gen === loadAnalysesGenRef.current) setAnalyses(all);
    } catch (err) {
      console.error("Failed to load analyses:", err);
    }
  }, [setAnalyses]);

  useEffect(() => {
    if (!isTauri) return;
    loadAnalyses();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // item 進捗は 1 曲ごとに来るので、ストア更新は最大 ANALYSIS_PROGRESS_THROTTLE_MS ごとに
    // 間引く (最後の値は必ず反映)。start / finished は即時反映し、保留中の item は捨てる (#213)。
    let pendingItem: { done: number; total: number } | null = null;
    let lastApplied = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flushItem = () => {
      timer = undefined;
      if (!pendingItem) return;
      lastApplied = Date.now();
      setAnalysisActive(pendingItem);
      pendingItem = null;
    };
    const dropPending = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pendingItem = null;
    };
    (async () => {
      const u = await analysisApi.onAnalysisProgress((p) => {
        if (p.kind === "start") {
          dropPending();
          lastApplied = Date.now();
          setAnalysisActive({ done: 0, total: p.total });
        } else if (p.kind === "item") {
          pendingItem = { done: p.done, total: p.total };
          // 最終アイテム (done === total) は待たずに反映する。
          if (p.done >= p.total) {
            if (timer !== undefined) clearTimeout(timer);
            flushItem();
            return;
          }
          if (timer !== undefined) return;
          const wait = Math.max(0, lastApplied + ANALYSIS_PROGRESS_THROTTLE_MS - Date.now());
          timer = setTimeout(flushItem, wait);
        } else if (p.kind === "finished") {
          dropPending();
          setAnalysisActive(null);
          loadAnalyses();
          // 解析完了を知らせる (失敗があればエラー扱いで残す)。
          if (p.analyzed + p.failed > 0) {
            useStore
              .getState()
              .pushToast(
                p.failed > 0 ? "error" : "success",
                p.failed > 0
                  ? `解析が完了しました（成功 ${p.analyzed} 曲 / 失敗 ${p.failed} 曲）`
                  : `解析が完了しました（${p.analyzed} 曲）`,
              );
          }
        }
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      dropPending();
      if (unlisten) unlisten();
    };
  }, [loadAnalyses, setAnalysisActive]);

  // Set Workspace (#121): 永続化した crate trackIds を再水和。
  // 再水和完了まで store subscribe は localStorage に書かない（レースで trackIds 消失を防ぐ）。
  useEffect(() => {
    if (!isTauri) {
      markSetWorkspaceHydrationDone();
      return;
    }
    let cancelled = false;
    (async () => {
      let preserve = false;
      try {
        const persisted = loadSetWorkspacePersist();
        if (persisted.crateTrackIds.length === 0) return;
        // crate が既にあっても fetch → merge restore する（再水和中の add レース対策）
        const resolved = await libraryApi.getTracksByIds(persisted.crateTrackIds);
        if (cancelled) return;
        const byId = new Map(resolved.map((t) => [t.trackId, t]));
        const ordered = persisted.crateTrackIds
          .map((id) => byId.get(id))
          .filter((t): t is Track => t != null);
        if (ordered.length > 0) {
          useStore.getState().restoreCrateTracks(ordered);
        }
      } catch (err) {
        console.error("Failed to restore set workspace crate:", err);
        preserve = true;
      } finally {
        if (!cancelled) {
          markSetWorkspaceHydrationDone(
            preserve ? { preservePersistedTrackIds: true } : undefined,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 「閉じるときに更新」: 閉じる要求を捕まえ、予約があればインストーラを起動してから閉じる。
  useTauriEvent(() => {
    const win = getCurrentWindow();
    return win.onCloseRequested(async (event) => {
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
          // stop ではなく pause: 停止すると永続化される再生状態から曲が消え、
          // 更新後の起動で復元できなくなる (#159)。
          await playbackApi.pause().catch(() => {});
          await systemApi.downloadAndRunUpdate(pending.url);
        } catch (e) {
          console.error("update on close failed:", e);
        }
      }
      await win.destroy();
    });
  }, []);

  // 曲送り(自動遷移)はバックエンドのワーカーが行う。
  // ポーリングはやめ、`playback-advanced` イベントを購読して即時に再生状態を反映する。
  // (250ms の状態ポーリングは位置表示用に残してあるが、それを待たずに UI を更新するため。)
  useTauriEvent(() => {
    return playbackApi.onPlaybackAdvanced(async () => {
      try {
        const state = await playbackApi.getPlaybackState();
        setPlayback(state);
      } catch {
        // ignore
      }
    });
  }, [setPlayback]);

  // プレビュー曲が終端に達したとき: ワーカーが auto-advance せず停止し preview-ended を発火する。
  // Esc と同じく元の曲・位置へ復帰する。
  useTauriEvent(() => {
    return playbackApi.onPreviewEnded(() => {
      const { previewActive } = useStore.getState();
      // バックエンドが先に PreviewMode を落としても、フロントの復帰先は残っている。
      if (previewActive || useStore.getState().previewReturn != null) {
        audition.exitPreview({ restore: true }).catch(() => {});
      }
    });
  }, []);

  // Google Cast 再生先の状態をストアへ反映する (初期取得 + cast-state-changed)。
  // キャスト中は Audition を落とし、接続断はトーストで知らせる (PC へ自動では戻さない)。
  useEffect(() => {
    if (!isTauri) return;
    let unlistenState: (() => void) | undefined;
    let unlistenDevices: (() => void) | undefined;
    let cancelled = false;
    const apply = (s: castApi.CastStatus) => {
      const st = useStore.getState();
      const prev = st.castStatus;
      st.setCastStatus(s);
      if (castApi.isCasting(s) && st.auditionMode) st.setAuditionMode(false);
      if (
        s.target.type === "googleCast" &&
        s.connectionState === "disconnected" &&
        prev.connectionState !== "disconnected"
      ) {
        st.pushToast(
          "error",
          `「${s.target.deviceName}」との接続が切れました。PC からは自動で再生しません — 再生先メニューから再接続するかローカルへ戻してください`,
          8000,
        );
      }
    };
    (async () => {
      try {
        const s = await castApi.getCastStatus();
        if (!cancelled) apply(s);
      } catch {
        /* バックエンド未対応 / 起動直後: 既定 (local) のまま */
      }
      const u1 = await castApi.onCastStateChanged(apply);
      const u2 = await castApi.onCastDevicesChanged((d) => useStore.getState().setCastDevices(d));
      if (cancelled) {
        u1();
        u2();
      } else {
        unlistenState = u1;
        unlistenDevices = u2;
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenState) unlistenState();
      if (unlistenDevices) unlistenDevices();
    };
  }, []);

  // 出力デバイスの通知 (#170): 起動時に保存済みデバイスが見つからなかった / 再生中に
  // 抜かれてシステム既定へ切り替えた、をトーストで知らせる (非ブロッキング)。
  // 起動直後の通知はイベントより先に積まれているので、マウント時にも取り出す。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const drain = async () => {
      try {
        const notices = await playbackApi.takeOutputDeviceNotices();
        for (const n of notices) {
          const to = n.active ? `「${n.active}」` : "システム既定";
          const msg =
            n.kind === "missing"
              ? `出力デバイス「${n.device ?? ""}」が見つからないため、${to}で再生します。`
              : `出力デバイス「${n.device ?? ""}」が切断されたため、${to}に切り替えました。`;
          useStore.getState().pushToast("info", msg, 6000);
        }
      } catch {
        // ignore
      }
    };
    (async () => {
      const u = await playbackApi.onOutputDeviceNotice(() => {
        void drain();
      });
      if (cancelled) u();
      else unlisten = u;
      void drain();
    })();
    return () => {
      cancelled = true;
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
      // XML の自動エクスポートに成功したタイミングで、あわせて library.db 自体も
      // バックアップする（解析結果・スキップ数・スマプレ条件・同期状態は XML に
      // 出ないため #167）。30分未満の直近バックアップがあればバックエンド側で
      // スキップされるので、失敗してもエクスポート自体は成功扱いのまま続行する。
      if (useStore.getState().autoBackupEnabled) {
        try {
          await libraryApi.backupLibrary();
        } catch (e) {
          console.error("auto-backup failed:", e);
        }
      }
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
  useTauriEvent(() => {
    return playlistsApi.onLibraryChanged((_playlistId, info) => {
      // アートワークが実際に変わりうる変更のときだけ epoch を進める。
      // 毎回進めると全 ArtworkImg が一斉に取り直してしまう (#213)。
      // アプリ内のアートワーク編集は TrackEditor が直接 bumpArtworkEpoch する。
      if (info.artworkChanged) useStore.getState().bumpArtworkEpoch();
      reloadPlaylists();
      bumpLibraryRevision();
      libraryDirtyRef.current = true;
      scheduleAutoExport();
    });
  }, [reloadPlaylists, scheduleAutoExport, bumpLibraryRevision]);

  const triggerReload = useCallback(() => {
    libraryDirtyRef.current = true; // 変更があったので次回の自動エクスポート対象。
    scheduleAutoExport();
    bumpLibraryRevision();
    reloadPlaylists();
  }, [reloadPlaylists, scheduleAutoExport, bumpLibraryRevision]);


  // 取り寄せ / 送信の完了後は、曲一覧に加えて解析結果 (BPM/Key/Energy) も読み直す
  // (取り寄せた解析値がリロードするまで一覧に出なかった: E3)。
  const reloadAfterSync = useCallback(() => {
    triggerReload();
    void loadAnalyses();
  }, [triggerReload, loadAnalyses]);

  // CD リッピング進捗のグローバル購読
  useTauriEvent(() => {
    return ripperApi.onRipProgress((p) => {
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
          percent: 0,
          stage: "reading",
        });
        appendRipLog(`[${p.index + 1}/${p.total}] ripping: ${p.label}`);
      } else if (p.kind === "trackProgress") {
        const cur = useStore.getState().ripStatus;
        // 遅れて届いた前トラックのイベントで表示を巻き戻さない。
        if (cur && cur.phase === "ripping" && cur.current === p.index + 1) {
          useStore.getState().setRipStatus({ ...cur, percent: p.percent, stage: p.stage });
        }
      } else if (p.kind === "trackDone") {
        appendRipLog(`  → ${p.outputPath}`);
      } else if (p.kind === "done") {
        const prev = useStore.getState().ripStatus;
        setRipStatus({
          phase: "done",
          current: prev?.total ?? p.writtenFiles.length,
          total: prev?.total ?? p.writtenFiles.length,
          label: prev?.label ?? "",
          log: [
            ...(prev?.log ?? []),
            ...(p.movedOldFiles ?? []).map((f) => `  置き換え前のファイルを移動: ${f}`),
            ...(p.replaceErrors ?? []).map((e) => `  置き換え失敗: ${e}`),
            `Done. ${p.writtenFiles.length} file(s), ${p.addedTracks} added` +
              (p.replacedTracks > 0 ? `, ${p.replacedTracks} replaced.` : "."),
          ],
          addedTracks: p.addedTracks,
        });
        triggerReload();
        pushToast(
          "success",
          `リッピング完了: ${p.addedTracks} 曲` +
            (p.replacedTracks > 0 ? `（置き換え ${p.replacedTracks} 曲）` : ""),
        );
        if ((p.replaceErrors ?? []).length > 0) {
          pushToast("error", `置き換えに失敗した曲があります（${p.replaceErrors.length} 曲）。ログを確認してください`, 6000);
        }
      }
    });
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
        // 選択中の曲は一覧に読み込まれているとは限らないので、ID で取り直す
        // (曲の情報を読み込むので、選択が大きすぎるときは行わない)。
        if (selectedTrackIds.size === 0) return;
        const tooLarge = selectionTooLargeMessage(selectedTrackIds.size, "編集");
        if (tooLarge) {
          pushToast("error", tooLarge);
          return;
        }
        libraryApi
          .getTracksByIds(Array.from(selectedTrackIds))
          .then((sel) => {
            if (sel.length > 0) setEditorTracks(sel);
          })
          .catch((err) => pushToast("error", `曲を取得できませんでした: ${err}`));
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
          // Ctrl/Cmd+Shift+S は明示的な「似た曲を探す」操作 (#151)
          setSimilarBase(first, { focus: true });
        }
        return;
      }
      if (cmd && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (selectedTrackIds.size === 0) return;
        // 選択中の曲は一覧に読み込まれているとは限らないので、ID で取り直す (選択した順)。
        const tooLarge = selectionTooLargeMessage(selectedTrackIds.size, " Crate に追加");
        if (tooLarge) {
          pushToast("error", tooLarge);
          return;
        }
        libraryApi
          .getTracksByIds(Array.from(selectedTrackIds))
          .then((selected) => addTracksToCrate(selected))
          .catch((err) => pushToast("error", `曲を取得できませんでした: ${err}`));
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
        // backend に反映してからストアを更新する (Up Next が古い順を読まないように)。
        const next = !shuffle;
        void (async () => {
          try {
            if (isTauri) await playbackApi.setShuffle(next);
            setShuffle(next);
          } catch {
            useStore.getState().pushToast("error", "シャッフルを切り替えられませんでした");
          }
        })();
      } else if (e.key.toLowerCase() === "r") {
        const order = ["off", "all", "one"] as const;
        const i = order.indexOf(repeat);
        const next = order[(i + 1) % order.length];
        void (async () => {
          try {
            if (isTauri) await playbackApi.setRepeat(next);
            setRepeat(next);
          } catch {
            useStore.getState().pushToast("error", "リピートを切り替えられませんでした");
          }
        })();
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

  const isArtistView = viewMode === "artists";

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

  // 狭い窓 (幅 < RAIL_AUTO_HIDE_WIDTH) では右ペインを自動で畳み、一覧 (曲名列) の幅を確保する。
  // 自動で畳んだ場合だけ、広げたときに戻す (利用者が自分で閉じた状態は変えない)。
  // 狭いまま利用者が開き直した場合は、そのまま尊重する。
  const railAutoHiddenRef = useRef(false);
  useEffect(() => {
    const check = () => {
      const narrow = window.innerWidth < RAIL_AUTO_HIDE_WIDTH;
      const st = useStore.getState();
      if (narrow && st.rightRailVisible && !railAutoHiddenRef.current) {
        railAutoHiddenRef.current = true;
        st.setRightRailVisible(false);
      } else if (!narrow && railAutoHiddenRef.current) {
        railAutoHiddenRef.current = false;
        if (!st.rightRailVisible) st.setRightRailVisible(true);
      }
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

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
        onUsbExport={(ids) => setUsbExportIds(ids)}
        reloadKey={reloadCount}
      />
      <div className="cb-main">
        <UpdateBanner />
        <Toolbar
          onLibraryChanged={triggerReload}
          onOpenRipDialog={() => setRipOpen(true)}
          onOpenRulesPanel={() => setRulesOpen(true)}
          onOpenSyncProvision={() => setSyncProvisionOpen(true)}
          onOpenUsbExport={() =>
            setUsbExportIds(
              viewMode === "playlist" && selectedPlaylistId != null ? [selectedPlaylistId] : [],
            )
          }
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
        {viewMode === "inbox" && !triageMode && (
          <div className="inbox-banner">
            <span className="inbox-banner-text">
              Inbox · {inboxCount.toLocaleString()} 曲
              （直近追加 {INBOX_FETCH_LIMIT.toLocaleString()} 件 + later）
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
        {viewMode === "history" ? (
          <SetHistoryView />
        ) : viewMode === "inbox" && triageMode ? (
          <TriagePanel
            tracks={tracks}
            onRemoveFromInbox={handleRemoveFromInbox}
          />
        ) : isArtistView ? (
          <ArtistsView reloadKey={reloadCount} />
        ) : displayMode === "albums" ? (
          <AlbumsView
            reloadKey={reloadCount}
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids, mode) => setConvertReq({ ids, mode: mode ?? "export" })}
          />
        ) : displayMode === "tracks" ? (
          <TracksView
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids, mode) => setConvertReq({ ids, mode: mode ?? "export" })}
          />
        ) : (
          <TrackTable
            onTracksChanged={triggerReload}
            onEditTrack={(ts) => setEditorTracks(ts)}
            onConvert={(ids, mode) => setConvertReq({ ids, mode: mode ?? "export" })}
          />
        )}
      </div>
      {rightRailVisible && (
        <RightRail
          onPlaylistsChanged={triggerReload}
          onOpenSync={() => setSyncProvisionOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      <PlayerBar />
      <RipStatusBar onOpenLog={() => setRipOpen(true)} />
      <UsbExportStatusBar
        hidden={usbExportIds != null}
        onOpen={() =>
          // 実行中 / 最後の書き出しの選択で開く (ダイアログ側も最後の設定を優先して表示する)。
          setUsbExportIds(useStore.getState().usbExportLastOptions?.playlistIds ?? [])
        }
      />
      <RipDialog
        open={ripOpen}
        initialDisc={ripInitialDisc}
        onClose={() => { setRipOpen(false); setRipInitialDisc(null); }}
        onLibraryChanged={triggerReload}
      />
      <ImportDuplicatesDialog />
      <RulesPanel open={rulesOpen} onClose={() => setRulesOpen(false)} onLibraryChanged={triggerReload} />
      {editorTracks && (
        <TrackEditor
          tracks={editorTracks}
          onClose={() => setEditorTracks(null)}
          onSaved={triggerReload}
        />
      )}
      {convertReq && (
        <ConvertDialog
          trackIds={convertReq.ids}
          initialMode={convertReq.mode}
          onClose={() => setConvertReq(null)}
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
          onLibraryChanged={reloadAfterSync}
        />
      )}
      {usbExportIds && (
        <UsbExportDialog
          initialPlaylistIds={usbExportIds}
          onClose={() => setUsbExportIds(null)}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {detectedDisc && (
        <DiscDetectedDialog
          disc={detectedDisc}
          onRip={() => {
            // 前回の取り込み結果 (完了/エラーのログ) を閉じずに CD を入れ替えると、RipDialog が
            // ripStatus を見て前回の結果ビューを出してしまう。新しいディスクなので片付けておく
            // (リッピング中はそもそも検出が止まっているので、ここに来るのは done / error のみ)。
            const st = useStore.getState();
            if (st.ripStatus && st.ripStatus.phase !== "ripping") st.clearRipStatus();
            setRipInitialDisc(detectedDisc);
            dismissDisc();
            setRipOpen(true);
          }}
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
