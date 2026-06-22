import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as analysisApi from "../api/analysis";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import { bpmColor } from "../lib/art";

// 残り時間を "-mm:ss" 形式でフォーマット。
function formatRemainingTime(positionMs: number, durationMs: number): string {
  const remaining = Math.max(0, durationMs - positionMs);
  const totalSec = Math.floor(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `-${min}:${sec.toString().padStart(2, "0")}`;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

const WAVE_N = 64;

export function PlayerBar() {
  const {
    playback,
    tracks,
    volume,
    shuffle,
    repeat,
    replayGain,
    setVolume,
    setShuffle,
    setRepeat,
    setReplayGain,
    setRailTab,
    showRemainingTime,
    toggleRemainingTime,
  } = useStore();

  // ミュート前の音量を保持（復帰用）。
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);

  const currentTrack = playback.currentTrackId
    ? tracks.find((t) => t.trackId === playback.currentTrackId)
    : null;

  // フォールバック用の決定的な波形バー（解析前/未解析時）。
  const waveHeights = useMemo(
    () =>
      Array.from({ length: WAVE_N }, (_, i) => 6 + Math.abs(Math.sin(i * 0.6) * 18) + (i % 3) * 2),
    [],
  );

  // 再生中トラックの実波形ピークを取得（無ければフォールバック）。
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    const id = playback.currentTrackId;
    if (id == null) {
      setPeaks([]);
      return;
    }
    let alive = true;
    analysisApi
      .getAnalysis(id)
      .then((a) => {
        if (alive) setPeaks(a?.peaks ?? []);
      })
      .catch(() => {
        if (alive) setPeaks([]);
      });
    return () => {
      alive = false;
    };
  }, [playback.currentTrackId]);

  const bars = peaks.length > 0 ? peaks.map((p) => 4 + p * 22) : waveHeights;

  const progress =
    playback.durationMs > 0 ? playback.positionMs / playback.durationMs : 0;

  const handlePlayPause = useCallback(async () => {
    if (playback.isPlaying) await playbackApi.pause();
    else if (playback.currentTrackId !== null) await playbackApi.resume();
  }, [playback.isPlaying, playback.currentTrackId]);

  const handleNext = useCallback(() => playbackApi.playNext(), []);
  const handlePrev = useCallback(() => playbackApi.playPrev(), []);

  const handleMuteToggle = useCallback(() => {
    if (volume > 0) {
      lastVolumeRef.current = volume;
      setVolume(0);
      playbackApi.setVolume(0);
    } else {
      const v = lastVolumeRef.current || 1;
      setVolume(v);
      playbackApi.setVolume(v);
    }
  }, [volume, setVolume]);

  const handleOpenQueue = useCallback(() => setRailTab("next"), [setRailTab]);

  // ドラッグシーク用: null=非ドラッグ中, 0〜1=ドラッグ中プレビュー位置。
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const waveRef = useRef<HTMLDivElement>(null);

  // バー上の clientX から 0〜1 の比率を計算。
  const getRatioFromX = useCallback((clientX: number): number => {
    if (!waveRef.current) return 0;
    const rect = waveRef.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const handleWavePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!currentTrack || playback.durationMs <= 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const ratio = getRatioFromX(e.clientX);
      setDragRatio(ratio);
    },
    [currentTrack, playback.durationMs, getRatioFromX],
  );

  const handleWavePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragRatio === null) return;
      setDragRatio(getRatioFromX(e.clientX));
    },
    [dragRatio, getRatioFromX],
  );

  const handleWavePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragRatio === null || playback.durationMs <= 0) return;
      const ratio = getRatioFromX(e.clientX);
      playbackApi.seek(Math.floor(ratio * playback.durationMs));
      setDragRatio(null);
    },
    [dragRatio, playback.durationMs, getRatioFromX],
  );

  const handleVolumeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      setVolume(ratio);
      playbackApi.setVolume(ratio);
    },
    [setVolume],
  );

  const handleShuffleToggle = useCallback(async () => {
    const next = !shuffle;
    setShuffle(next);
    await playbackApi.setShuffle(next);
  }, [shuffle, setShuffle]);

  const handleRepeatToggle = useCallback(async () => {
    const order = ["off", "all", "one"] as const;
    const next = order[(order.indexOf(repeat) + 1) % order.length];
    setRepeat(next);
    await playbackApi.setRepeat(next);
  }, [repeat, setRepeat]);

  const handleReplayGainToggle = useCallback(async () => {
    const next = !replayGain;
    setReplayGain(next);
    await playbackApi.setReplayGain(next);
  }, [replayGain, setReplayGain]);

  return (
    <div className="cb-player">
      {/* left: track info */}
      <div className="cb-pinfo">
        {currentTrack ? (
          <>
            <Cover
              seed={currentTrack.album}
              glyph={currentTrack.name}
              path={currentTrack.fileExists ? currentTrack.locationPath : null}
              size={48}
              radius={9}
            />
            <div className="cb-pa-meta">
              <div className="cj">{currentTrack.name || "(unknown)"}</div>
              <div className="la">
                {currentTrack.artist || ""}
                {currentTrack.bpm != null && (
                  <>
                    {currentTrack.artist ? " · " : ""}
                    <b style={{ color: bpmColor(currentTrack.bpm) }}>{currentTrack.bpm} BPM</b>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="cb-pa-meta">
            <div className="cj dim">No track playing</div>
          </div>
        )}
      </div>

      {/* center: controls + waveform */}
      <div className="cb-ctr">
        <div className="cb-ctrl">
          <button
            className={"cb-ctrl-btn cb-tg" + (shuffle ? " on" : "")}
            onClick={handleShuffleToggle}
            title="Shuffle (S)"
          >
            <Icon name="shuffle" size={16} />
          </button>
          <button className="cb-ctrl-btn" onClick={handlePrev} title="Previous (J)">
            <Icon name="prev" size={18} fill="currentColor" stroke={0} />
          </button>
          <button className="cb-pp" onClick={handlePlayPause} title="Play / Pause (Space)">
            <Icon
              name={playback.isPlaying ? "pause" : "play"}
              size={16}
              fill="currentColor"
              stroke={0}
            />
          </button>
          <button className="cb-ctrl-btn" onClick={handleNext} title="Next (K)">
            <Icon name="next" size={18} fill="currentColor" stroke={0} />
          </button>
          <button
            className={"cb-ctrl-btn cb-tg" + (repeat !== "off" ? " on" : "")}
            onClick={handleRepeatToggle}
            title={`Repeat: ${repeat} (R)`}
            style={{ position: "relative" }}
          >
            <Icon name="repeat" size={16} />
            {repeat === "one" && <span className="cb-repeat-badge">1</span>}
          </button>
        </div>
        <div className="cb-seek">
          <span>{formatTime(playback.positionMs)}</span>
          {/* ドラッグシーク対応: pointerDown/Move/Up + setPointerCapture でドラッグを捕捉 */}
          <div
            ref={waveRef}
            className="cb-wave"
            style={{ touchAction: "none", cursor: "pointer" }}
            onPointerDown={handleWavePointerDown}
            onPointerMove={handleWavePointerMove}
            onPointerUp={handleWavePointerUp}
            onPointerCancel={() => setDragRatio(null)}
          >
            {bars.map((h, i) => {
              // ドラッグ中はプレビュー位置、通常は再生位置で塗り分け。
              const activeRatio = dragRatio !== null ? dragRatio : progress;
              return (
                <i
                  key={i}
                  className={i / bars.length < activeRatio ? "on" : ""}
                  style={{ height: h }}
                />
              );
            })}
          </div>
          {/* クリックで経過時間 ↔ 残り時間をトグル */}
          <span
            onClick={toggleRemainingTime}
            style={{ cursor: "pointer", userSelect: "none" }}
            title="クリックで残り時間/経過時間を切替"
          >
            {showRemainingTime
              ? formatRemainingTime(playback.positionMs, playback.durationMs)
              : formatTime(playback.durationMs)}
          </span>
        </div>
      </div>

      {/* right: replaygain + queue + volume */}
      <div className="cb-pr">
        <button
          className={"cb-pr-btn cb-tg" + (replayGain ? " on" : "")}
          title={replayGain ? "ReplayGain on（音量を揃える）" : "ReplayGain off"}
          onClick={handleReplayGainToggle}
          style={{ fontSize: 11, fontWeight: 700 }}
        >
          RG
        </button>
        <button className="cb-pr-btn" title="Up Next" onClick={handleOpenQueue}>
          <Icon name="queue" size={16} />
        </button>
        <button
          className="cb-pr-btn"
          title={volume === 0 ? "Unmute" : "Mute"}
          onClick={handleMuteToggle}
        >
          <Icon name={volume === 0 ? "volumeX" : "volume"} size={16} />
        </button>
        {/* title に現在の音量 % を表示。サム（丸いつまみ）を絶対配置で追加 */}
        <div
          className="cb-vbar"
          onClick={handleVolumeClick}
          title={`Volume: ${Math.round(volume * 100)}% (Ctrl+↑/↓)`}
          style={{ position: "relative" }}
        >
          {/* 塗り済みバー */}
          <i style={{ right: `${(1 - volume) * 100}%` }} />
          {/* 丸いサム（つまみ） */}
          <span
            style={{
              position: "absolute",
              top: "50%",
              left: `${volume * 100}%`,
              transform: "translate(-50%, -50%)",
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "var(--ac)",
              pointerEvents: "none",
              boxShadow: "0 0 0 2px var(--bg3)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
