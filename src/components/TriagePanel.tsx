// Inbox Triage Mode (#118) — 1 曲ずつキーボードで処理するフォーカス UI。

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as libraryApi from "../api/library";
import * as playbackApi from "../api/playback";
import * as audition from "../lib/audition";
import { persistMarkDone, persistMarkLater } from "../lib/triage";
import { useStore } from "../store/useStore";
import type { Track } from "../types";
import { Cover } from "./Cover";
import { Icon, Stars } from "./Icon";

const isTauri = "__TAURI_INTERNALS__" in window;

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface TriagePanelProps {
  tracks: Track[];
  /** done 後に store.tracks から外し、inboxCount を更新する */
  onRemoveFromInbox: (trackId: number) => void;
}

export function TriagePanel({
  tracks,
  onRemoveFromInbox,
}: TriagePanelProps) {
  const triageIndex = useStore((s) => s.triageIndex);
  const setTriageIndex = useStore((s) => s.setTriageIndex);
  const exitTriage = useStore((s) => s.exitTriage);
  const addToCrate = useStore((s) => s.addToCrate);
  const setRightRailVisible = useStore((s) => s.setRightRailVisible);
  const setRailTab = useStore((s) => s.setRailTab);
  const pushToast = useStore((s) => s.pushToast);
  const playback = useStore((s) => s.playback);
  const setTracks = useStore((s) => s.setTracks);

  const panelRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(triageIndex);
  indexRef.current = triageIndex;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const safeIndex =
    tracks.length === 0 ? 0 : Math.min(triageIndex, tracks.length - 1);
  const track = tracks.length > 0 ? tracks[safeIndex] : null;

  // インデックスが範囲外ならクランプ
  useEffect(() => {
    if (tracks.length === 0) return;
    if (triageIndex >= tracks.length) {
      setTriageIndex(Math.max(0, tracks.length - 1));
    } else if (triageIndex < 0) {
      setTriageIndex(0);
    }
  }, [tracks.length, triageIndex, setTriageIndex]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const goNext = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    setTriageIndex(Math.min(list.length - 1, indexRef.current + 1));
  }, [setTriageIndex]);

  const goPrev = useCallback(() => {
    setTriageIndex(Math.max(0, indexRef.current - 1));
  }, [setTriageIndex]);

  const advanceAfterRemove = useCallback(
    (removedId: number) => {
      const list = tracksRef.current;
      const idx = list.findIndex((t) => t.trackId === removedId);
      const nextList = list.filter((t) => t.trackId !== removedId);
      // store.tracks も同期（親 onRemove と二重になっても idempotent）
      setTracks(nextList);
      onRemoveFromInbox(removedId);
      if (nextList.length === 0) {
        setTriageIndex(0);
        return;
      }
      // 同じ位置に次の曲が来る。末尾なら 1 つ戻る。
      const nextIdx = idx < 0 ? 0 : Math.min(idx, nextList.length - 1);
      setTriageIndex(nextIdx);
    },
    [onRemoveFromInbox, setTracks, setTriageIndex],
  );

  const handleDone = useCallback(() => {
    const t = tracksRef.current[indexRef.current];
    if (!t) return;
    persistMarkDone(t.trackId);
    advanceAfterRemove(t.trackId);
  }, [advanceAfterRemove]);

  const handleLater = useCallback(() => {
    const t = tracksRef.current[indexRef.current];
    if (!t) return;
    persistMarkLater(t.trackId);
    // later は Inbox に残す。今回のパスではスキップして次へ。
    // 末尾なら 1 つ戻る（またはその場で完了扱いせず停止）。
    const list = tracksRef.current;
    const idx = indexRef.current;
    if (idx < list.length - 1) {
      setTriageIndex(idx + 1);
    } else {
      // 最後の曲を later → リストに残したまま終了メッセージは出さない
      pushToast("info", "あとで処理する曲として残しました");
    }
  }, [pushToast, setTriageIndex]);

  const handleRating = useCallback(
    async (stars: number) => {
      const t = tracksRef.current[indexRef.current];
      if (!t || !isTauri) return;
      const rating = stars * 20;
      try {
        await libraryApi.setTrackRating(t.trackId, rating);
        // await 中に Done で除外された場合は再導入しない（stale tracksRef で上書きしない）
        useStore.setState((s) => {
          if (!s.tracks.some((x) => x.trackId === t.trackId)) return s;
          return {
            tracks: s.tracks.map((x) =>
              x.trackId === t.trackId ? { ...x, rating } : x,
            ),
          };
        });
      } catch (err) {
        pushToast("error", `レーティングの保存に失敗: ${err}`);
      }
    },
    [pushToast],
  );

  const handleCrate = useCallback(() => {
    const t = tracksRef.current[indexRef.current];
    if (!t) return;
    addToCrate(t);
    setRightRailVisible(true);
    setRailTab("crate");
    pushToast("success", "Crate に追加しました");
  }, [addToCrate, pushToast, setRailTab, setRightRailVisible]);

  const handlePlayPause = useCallback(async () => {
    if (!isTauri) return;
    const t = tracksRef.current[indexRef.current];
    if (!t) return;
    try {
      const { playback: pb, previewActive } = useStore.getState();
      if (pb.isPlaying && pb.currentTrackId === t.trackId) {
        await playbackApi.pause();
        return;
      }
      if (!pb.isPlaying && pb.currentTrackId === t.trackId) {
        await playbackApi.resume();
        return;
      }
      // 別曲 or 未再生 → preview で聴く（stats を汚さない）
      if (previewActive && pb.currentTrackId === t.trackId) {
        await playbackApi.resume();
      } else {
        await audition.startPreview(t);
      }
    } catch (err) {
      pushToast("error", `再生に失敗: ${err}`);
    }
  }, [pushToast]);

  const handleExit = useCallback(() => {
    exitTriage();
  }, [exitTriage]);

  // capture でグローバル (J/K/S/Space 等) を奪う
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      const key = e.key;
      const lower = key.toLowerCase();
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd || e.altKey) return;

      let handled = false;

      if (key === "Escape") {
        handled = true;
        handleExit();
      } else if (key === " " || key === "Spacebar") {
        handled = true;
        void handlePlayPause();
      } else if (key === "ArrowDown" || lower === "j") {
        handled = true;
        goNext();
      } else if (key === "ArrowUp" || lower === "k") {
        handled = true;
        goPrev();
      } else if (key === "Enter" || lower === "d") {
        handled = true;
        handleDone();
      } else if (lower === "s") {
        handled = true;
        handleLater();
      } else if (lower === "c") {
        handled = true;
        handleCrate();
      } else if (key >= "1" && key <= "5" && !e.shiftKey) {
        handled = true;
        void handleRating(Number(key));
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    goNext,
    goPrev,
    handleCrate,
    handleDone,
    handleExit,
    handleLater,
    handlePlayPause,
    handleRating,
  ]);

  const progressLabel = useMemo(() => {
    if (tracks.length === 0) return "0 / 0";
    return `${safeIndex + 1} / ${tracks.length}`;
  }, [safeIndex, tracks.length]);

  const isPlayingThis =
    track != null &&
    playback.currentTrackId === track.trackId &&
    playback.isPlaying;

  if (tracks.length === 0) {
    return (
      <div className="triage-panel" ref={panelRef} tabIndex={-1} role="dialog" aria-label="Triage">
        <div className="triage-empty">
          <div className="triage-empty-emoji" aria-hidden>
            🎉
          </div>
          <h2>Inbox クリア</h2>
          <p>未処理の曲はありません。お疲れさまでした。</p>
          <button type="button" className="toolbar-btn primary" onClick={handleExit}>
            リストに戻る
          </button>
        </div>
      </div>
    );
  }

  if (!track) return null;

  return (
    <div
      className="triage-panel"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Triage"
    >
      <div className="triage-top">
        <div className="triage-progress">
          <Icon name="inbox" size={14} />
          <span>Triage</span>
          <span className="triage-progress-num">{progressLabel}</span>
        </div>
        <button
          type="button"
          className="toolbar-btn"
          onClick={handleExit}
          title="終了 (Esc)"
        >
          終了
        </button>
      </div>

      <div className="triage-body">
        <Cover
          seed={track.album || track.name}
          glyph={track.name}
          path={track.locationPath}
          size={220}
          radius={14}
          className="triage-cover"
        />
        <div className="triage-meta">
          <div className="triage-title">{track.name || "(unknown)"}</div>
          <div className="triage-artist">{track.artist || "—"}</div>
          <div className="triage-album">{track.album || "—"}</div>
          <div className="triage-sub">
            <span>{formatDuration(track.totalTimeMs)}</span>
            {track.genre && (
              <>
                <span className="triage-dot">·</span>
                <span>{track.genre}</span>
              </>
            )}
            {track.bpm != null && track.bpm > 0 && (
              <>
                <span className="triage-dot">·</span>
                <span>{track.bpm} BPM</span>
              </>
            )}
            <span className="triage-dot">·</span>
            <span>追加 {formatDate(track.dateAdded)}</span>
          </div>

          <div className="triage-rating">
            <Stars
              value={track.rating ? Math.round(track.rating / 20) : 0}
              size={22}
              onSet={(n) => void handleRating(n)}
            />
            <span className="triage-hint">1–5 で評価</span>
          </div>

          <div className="triage-actions">
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void handlePlayPause()}
              title="再生 / 一時停止 (Space)"
            >
              <Icon name={isPlayingThis ? "pause" : "play"} size={14} />
              {isPlayingThis ? "一時停止" : "プレビュー"}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={handleCrate}
              title="Crate に追加 (C)"
            >
              <Icon name="layers" size={14} />
              Crate
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={handleLater}
              title="あとで (S)"
            >
              <Icon name="clock" size={14} />
              あとで
            </button>
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={handleDone}
              title="処理済み (D / Enter)"
            >
              <Icon name="check" size={14} />
              処理済み
            </button>
          </div>
        </div>
      </div>

      <div className="triage-nav">
        <button
          type="button"
          className="toolbar-btn"
          onClick={goPrev}
          disabled={safeIndex <= 0}
          title="前へ (K / ↑)"
        >
          <Icon name="prev" size={14} />
          前へ
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={goNext}
          disabled={safeIndex >= tracks.length - 1}
          title="次へ (J / ↓)"
        >
          次へ
          <Icon name="next" size={14} />
        </button>
      </div>

      <div className="triage-cheat">
        <kbd>Space</kbd> 再生 · <kbd>J</kbd>/<kbd>↓</kbd> 次 · <kbd>K</kbd>/
        <kbd>↑</kbd> 前 · <kbd>1</kbd>–<kbd>5</kbd> 評価 · <kbd>C</kbd> Crate ·{" "}
        <kbd>D</kbd>/<kbd>Enter</kbd> 処理済み · <kbd>S</kbd> あとで ·{" "}
        <kbd>Esc</kbd> 終了
      </div>
    </div>
  );
}
