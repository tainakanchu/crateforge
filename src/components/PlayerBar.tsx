import { useCallback, useMemo, useRef } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import { bpmColor } from "../lib/art";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

const WAVE_N = 64;

export function PlayerBar() {
  const { playback, tracks, volume, shuffle, repeat, setVolume, setShuffle, setRepeat, setRailTab } =
    useStore();

  // ミュート前の音量を保持（復帰用）。
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);

  const currentTrack = playback.currentTrackId
    ? tracks.find((t) => t.trackId === playback.currentTrackId)
    : null;

  // 決定的な波形バー（インデックスから高さ算出）。
  const waveHeights = useMemo(
    () =>
      Array.from({ length: WAVE_N }, (_, i) => 6 + Math.abs(Math.sin(i * 0.6) * 18) + (i % 3) * 2),
    [],
  );

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

  const handleWaveSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!currentTrack || playback.durationMs <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      playbackApi.seek(Math.floor(ratio * playback.durationMs));
    },
    [currentTrack, playback.durationMs],
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
          <div className="cb-wave" onClick={handleWaveSeek}>
            {waveHeights.map((h, i) => (
              <i
                key={i}
                className={i / WAVE_N < progress ? "on" : ""}
                style={{ height: h }}
              />
            ))}
          </div>
          <span>{formatTime(playback.durationMs)}</span>
        </div>
      </div>

      {/* right: queue + volume */}
      <div className="cb-pr">
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
        <div className="cb-vbar" onClick={handleVolumeClick} title="Volume (↑/↓)">
          <i style={{ right: `${(1 - volume) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
