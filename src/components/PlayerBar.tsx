import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import * as playbackApi from "../api/playback";
import * as analysisApi from "../api/analysis";
import * as openWithApi from "../api/openWith";
import { Icon } from "./Icon";
import { Cover } from "./Cover";
import { CastDevicePicker } from "./CastDevicePicker";
import { WaveBars } from "./WaveBars";
import { useCurrentTrack } from "../hooks/useCurrentTrack";
import { bpmColor } from "../lib/art";
import { ANALYZED_BPM_TITLE, effectiveBpm } from "../lib/bpm";
import * as audition from "../lib/audition";

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

// ブラウザ (vite dev) では IPC が使えないので、ストア更新のみで動かす。
const isTauri = "__TAURI_INTERNALS__" in window;

const WAVE_N = 64;

const JUMP_MARKERS = [0.25, 0.5, 0.75] as const;

const REPEAT_LABEL: Record<string, string> = { off: "オフ", all: "全曲", one: "1 曲" };

// プレイヤーバーの幅 (右ペインを除いた実幅) に合わせて波形の幅を決める (D1)。
// 以前は 40vw (ウィンドウ幅基準) だったので、右ペイン表示中の狭い幅では左右の列が
// 潰れ、右端の音量スライダーが消えていた。左右の列にそれぞれ右端の操作群が収まる幅を残す。
const PLAYER_PAD_X = 22;
/** これ未満は .narrow (音量スライダー短縮・間隔を詰める)。 */
const PLAYER_NARROW_W = 900;
const SEEK_MIN = 180;
function seekWidthFor(playerW: number, audition: boolean): number {
  const narrow = playerW < PLAYER_NARROW_W;
  // 右端の操作群 (RG・キュー・キャスト・ミュート・音量) の幅 + 余裕。styles.css の
  // .cb-pr の gap / .cb-vbar の幅 (通常 92px・narrow 56px) と対応する。
  const sideMin = narrow ? 172 : 216;
  const gap = narrow ? 16 : 24;
  const max = audition ? 520 : 460;
  const pref = playerW * (audition ? 0.44 : 0.4) + 120;
  const room = playerW - PLAYER_PAD_X * 2 - gap * 2 - sideMin * 2;
  return Math.max(SEEK_MIN, Math.min(max, pref, room));
}

export function PlayerBar() {
  const {
    playback,
    volume,
    shuffle,
    repeat,
    replayGain,
    setVolume,
    setShuffle,
    setRepeat,
    setReplayGain,
    setRailTab,
    pushToast,
    showRemainingTime,
    toggleRemainingTime,
    auditionMode,
    previewActive,
    analysisByTrack,
  } = useStore();

  // ミュート前の音量を保持（復帰用）。
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);

  // プレイヤーバーの実幅 (右ペインの表示・リサイズに追従)。
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerW, setPlayerW] = useState(0);
  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    setPlayerW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPlayerW(e.contentRect.width + PLAYER_PAD_X * 2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 再生中の曲 (表示中の一覧 (tracks) に無いときは ID で取り直す #159)。
  const currentTrack = useCurrentTrack();

  // 実効 BPM (タグ ?? 解析値)。
  const currentBpm = currentTrack
    ? effectiveBpm(currentTrack, analysisByTrack.get(currentTrack.trackId))
    : null;

  // 「このアプリで開く」で再生中のライブラリ外ファイル (一時再生曲) をライブラリへ取り込む。
  // 再生は止まらず、取り込み後はキュー / 再生中の曲がライブラリの曲に付け替わる。
  const isTransient = currentTrack != null && openWithApi.isTransientTrackId(currentTrack.trackId);
  const [importingTransient, setImportingTransient] = useState(false);
  const handleAddTransientToLibrary = useCallback(async () => {
    if (!currentTrack || !openWithApi.isTransientTrackId(currentTrack.trackId)) return;
    setImportingTransient(true);
    try {
      const t = await openWithApi.importTransientTrack(currentTrack.trackId);
      pushToast("success", `「${t.name ?? "(unknown)"}」をライブラリに追加しました`);
      useStore.getState().setPlayback(await playbackApi.getPlaybackState());
    } catch (e) {
      pushToast("error", `ライブラリに追加できませんでした: ${e}`, 5200);
    } finally {
      setImportingTransient(false);
    }
  }, [currentTrack, pushToast]);

  // 未解析時のフォールバック: 実波形と見間違えないよう、低く平坦なバーにする
  // (「未解析」と分かる見た目。ツールチップでも知らせる)。
  const waveHeights = useMemo(() => Array.from({ length: WAVE_N }, () => 3), []);

  // 再生中トラックの実波形ピークを取得（無ければフォールバック）。
  // 再生中に解析が終わったら (analysisByTrack に載ったら) 取り直す。
  const currentAnalyzed =
    playback.currentTrackId != null && analysisByTrack.has(playback.currentTrackId);
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
  }, [playback.currentTrackId, currentAnalyzed]);

  // 参照が変わると波形 canvas を描き直すので、peaks / waveHeights が変わるときだけ作り直す。
  const bars = useMemo(
    () => (peaks.length > 0 ? peaks.map((p) => 4 + p * 22) : waveHeights),
    [peaks, waveHeights],
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

  // Rust 側プレイヤーに反映してからストアを更新する。
  // 先にストアを更新すると Up Next の取り直し (RightRail) が古い再生順を読んでしまう。
  // IPC は ~1ms なので体感は変わらない。失敗時はストアを変えずトーストで知らせる。
  const handleShuffleToggle = useCallback(async () => {
    const next = !shuffle;
    try {
      if (isTauri) await playbackApi.setShuffle(next);
      setShuffle(next);
    } catch {
      pushToast("error", "シャッフルを切り替えられませんでした");
    }
  }, [shuffle, setShuffle, pushToast]);

  const handleRepeatToggle = useCallback(async () => {
    const order = ["off", "all", "one"] as const;
    const next = order[(order.indexOf(repeat) + 1) % order.length];
    try {
      if (isTauri) await playbackApi.setRepeat(next);
      setRepeat(next);
    } catch {
      pushToast("error", "リピートを切り替えられませんでした");
    }
  }, [repeat, setRepeat, pushToast]);

  const handleReplayGainToggle = useCallback(async () => {
    const next = !replayGain;
    setReplayGain(next);
    await playbackApi.setReplayGain(next);
  }, [replayGain, setReplayGain]);

  const seekToRatio = useCallback(
    (ratio: number) => {
      if (playback.durationMs <= 0) return;
      const r = Math.min(1, Math.max(0, ratio));
      playbackApi.seek(Math.floor(r * playback.durationMs));
    },
    [playback.durationMs],
  );

  return (
    <div
      ref={playerRef}
      className={
        "cb-player" +
        (auditionMode ? " audition" : "") +
        (previewActive ? " preview" : "") +
        (playerW > 0 && playerW < PLAYER_NARROW_W ? " narrow" : "")
      }
      style={
        playerW > 0
          ? ({ "--seek-w": `${seekWidthFor(playerW, auditionMode)}px` } as React.CSSProperties)
          : undefined
      }
    >
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
              {isTransient && (
                <button
                  type="button"
                  className="cb-transient-add"
                  onClick={handleAddTransientToLibrary}
                  disabled={importingTransient}
                  title="ライブラリ外のファイルを一時再生中です (再生回数などは記録されません)。クリックでライブラリに取り込みます"
                >
                  <Icon name="plus" size={11} />
                  {importingTransient ? "追加中…" : "ライブラリに追加"}
                </button>
              )}
              <div className="la">
                {currentTrack.artist || ""}
                {currentBpm && (
                  <>
                    {currentTrack.artist ? " · " : ""}
                    <b
                      style={{
                        color: bpmColor(currentBpm.value),
                        opacity: currentBpm.fromAnalysis ? 0.6 : undefined,
                      }}
                      title={currentBpm.fromAnalysis ? ANALYZED_BPM_TITLE : undefined}
                    >
                      {currentBpm.value} BPM
                    </b>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="cb-pa-meta">
            <div className="cj dim">再生していません</div>
          </div>
        )}
      </div>

      {/* center: controls + waveform */}
      <div className="cb-ctr">
        <div className="cb-ctrl">
          <button
            className={"cb-ctrl-btn cb-tg" + (shuffle ? " on" : "")}
            onClick={handleShuffleToggle}
            title={shuffle ? "シャッフル: オン (S)" : "シャッフル: オフ (S)"}
          >
            <Icon name="shuffle" size={16} />
          </button>
          <button className="cb-ctrl-btn" onClick={handlePrev} title="前の曲 (J)">
            <Icon name="prev" size={18} fill="currentColor" stroke={0} />
          </button>
          <button className="cb-pp" onClick={handlePlayPause} title="再生 / 一時停止 (Space)">
            <Icon
              name={playback.isPlaying ? "pause" : "play"}
              size={16}
              fill="currentColor"
              stroke={0}
            />
          </button>
          <button className="cb-ctrl-btn" onClick={handleNext} title="次の曲 (K)">
            <Icon name="next" size={18} fill="currentColor" stroke={0} />
          </button>
          <button
            className={"cb-ctrl-btn cb-tg" + (repeat !== "off" ? " on" : "")}
            onClick={handleRepeatToggle}
            title={`リピート: ${REPEAT_LABEL[repeat] ?? repeat} (R)`}
            style={{ position: "relative" }}
          >
            <Icon name="repeat" size={16} />
            {repeat === "one" && <span className="cb-repeat-badge">1</span>}
          </button>
          {auditionMode && (
            <button
              type="button"
              className="cb-audition-badge"
              onClick={() => audition.toggleAuditionMode()}
              title="試聴モード — クリックで解除 (A) · 1/2/3 で 25/50/75% へ"
            >
              AUDITION
            </button>
          )}
          {previewActive && (
            <button
              type="button"
              className="cb-preview-badge"
              onClick={() => {
                audition.exitPreview({ restore: true }).catch(() => {});
              }}
              title="試聴中 — クリックで元に戻す (Esc)"
            >
              PREVIEW
            </button>
          )}
        </div>
        <div className="cb-seek">
          <span>{formatTime(playback.positionMs)}</span>
          {/* ドラッグシーク対応: pointerDown/Move/Up + setPointerCapture でドラッグを捕捉 */}
          <div
            ref={waveRef}
            className={
              "cb-wave" +
              (auditionMode ? " audition" : "") +
              (playback.currentTrackId != null && peaks.length === 0 ? " unanalyzed" : "")
            }
            style={{ touchAction: "none", cursor: "pointer" }}
            title={
              playback.currentTrackId != null && peaks.length === 0
                ? "未解析のため波形はありません（右クリック →「解析」で表示されます）"
                : undefined
            }
            onPointerDown={handleWavePointerDown}
            onPointerMove={handleWavePointerMove}
            onPointerUp={handleWavePointerUp}
            onPointerCancel={() => setDragRatio(null)}
          >
            {/* ドラッグ中はプレビュー位置、通常は再生位置で塗り分け (canvas は再描画せず clip のみ更新)。 */}
            <WaveBars
              bars={bars}
              audition={auditionMode}
              ratio={dragRatio !== null ? dragRatio : progress}
            />
            {auditionMode &&
              JUMP_MARKERS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="cb-wave-mark"
                  style={{ left: `${r * 100}%` }}
                  title={`${Math.round(r * 100)}%`}
                  onPointerDown={(e) => {
                    // 波形ドラッグと競合しないようマーカー操作を独立させる
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekToRatio(r);
                  }}
                />
              ))}
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

      {/* right: replaygain + queue + 再生先 + volume */}
      <div className="cb-pr">
        <button
          className={"cb-pr-btn cb-tg" + (replayGain ? " on" : "")}
          title={replayGain ? "ReplayGain: オン（曲ごとの音量を揃える）" : "ReplayGain: オフ"}
          onClick={handleReplayGainToggle}
          style={{ fontSize: 11, fontWeight: 700 }}
        >
          RG
        </button>
        <button className="cb-pr-btn" title="次に再生 (キュー)" onClick={handleOpenQueue}>
          <Icon name="queue" size={16} />
        </button>
        <CastDevicePicker />
        <button
          className="cb-pr-btn"
          title={volume === 0 ? "ミュート解除" : "ミュート"}
          onClick={handleMuteToggle}
        >
          <Icon name={volume === 0 ? "volumeX" : "volume"} size={16} />
        </button>
        {/* title に現在の音量 % を表示。サム（丸いつまみ）を絶対配置で追加 */}
        <div
          className="cb-vbar"
          onClick={handleVolumeClick}
          title={`音量: ${Math.round(volume * 100)}% (Ctrl+↑/↓)`}
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
