import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import * as libraryApi from "../api/library";
import { Icon, Stars } from "./Icon";
import { artworkUrl } from "./Cover";
import { artGradient, leadingGlyph } from "../lib/art";
import type { Track, TrackEdit } from "../types";

interface TrackEditorProps {
  /// 編集対象。1 曲なら通常編集、複数なら一括編集 (触ったフィールドのみ全曲へ適用)。
  tracks: Track[];
  onClose: () => void;
  onSaved: () => void;
}

function parseInt2(v: string): number | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/// 大きい Uint8Array を安全に base64 化する (引数スプレッドのスタック溢れを避ける)。
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function TrackEditor({ tracks, onClose, onSaved }: TrackEditorProps) {
  const single = tracks.length === 1;
  const trackIds = useMemo(() => tracks.map((t) => t.trackId), [tracks]);

  // 各フィールドの共通値と「混在しているか」を求める。
  const initial = useMemo(() => {
    const str = (g: (t: Track) => string | null | undefined) => {
      const vals = tracks.map((t) => g(t) ?? "");
      const same = vals.every((v) => v === vals[0]);
      return { value: same ? vals[0] : "", mixed: !same };
    };
    const num = (g: (t: Track) => number | null | undefined) => {
      const vals = tracks.map((t) => (g(t) != null ? String(g(t)) : ""));
      const same = vals.every((v) => v === vals[0]);
      return { value: same ? vals[0] : "", mixed: !same };
    };
    const ratingVals = tracks.map((t) => t.rating ?? 0);
    return {
      name: str((t) => t.name),
      artist: str((t) => t.artist),
      albumArtist: str((t) => t.albumArtist),
      album: str((t) => t.album),
      composer: str((t) => t.composer),
      genre: str((t) => t.genre),
      comments: str((t) => t.comments),
      year: num((t) => t.year),
      bpm: num((t) => t.bpm),
      trackNumber: num((t) => t.trackNumber),
      trackCount: num((t) => t.trackCount),
      discNumber: num((t) => t.discNumber),
      discCount: num((t) => t.discCount),
      rating: {
        value: ratingVals.every((v) => v === ratingVals[0]) ? ratingVals[0] : 0,
        mixed: !ratingVals.every((v) => v === ratingVals[0]),
      },
    };
  }, [tracks]);

  const [form, setForm] = useState(() => ({
    name: initial.name.value,
    artist: initial.artist.value,
    albumArtist: initial.albumArtist.value,
    album: initial.album.value,
    composer: initial.composer.value,
    genre: initial.genre.value,
    comments: initial.comments.value,
    year: initial.year.value,
    bpm: initial.bpm.value,
    trackNumber: initial.trackNumber.value,
    trackCount: initial.trackCount.value,
    discNumber: initial.discNumber.value,
    discCount: initial.discCount.value,
    rating: initial.rating.value,
  }));
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [artVersion, setArtVersion] = useState(0);
  const [artMsg, setArtMsg] = useState("");

  const update = useCallback(
    <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
      setDirty((d) => {
        const n = new Set(d);
        n.add(key as string);
        return n;
      });
    },
    [],
  );

  const ph = (mixed: boolean) => (mixed && !dirty.size ? "— 複数の値 —" : undefined);

  const handleSave = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const e: TrackEdit = {};
      if (dirty.has("name")) e.name = form.name;
      if (dirty.has("artist")) e.artist = form.artist;
      if (dirty.has("albumArtist")) e.albumArtist = form.albumArtist;
      if (dirty.has("album")) e.album = form.album;
      if (dirty.has("composer")) e.composer = form.composer;
      if (dirty.has("genre")) e.genre = form.genre;
      if (dirty.has("comments")) e.comments = form.comments;
      if (dirty.has("year")) e.year = parseInt2(form.year);
      if (dirty.has("bpm")) e.bpm = parseInt2(form.bpm);
      if (dirty.has("trackNumber")) e.trackNumber = parseInt2(form.trackNumber);
      if (dirty.has("trackCount")) e.trackCount = parseInt2(form.trackCount);
      if (dirty.has("discNumber")) e.discNumber = parseInt2(form.discNumber);
      if (dirty.has("discCount")) e.discCount = parseInt2(form.discCount);
      if (dirty.has("rating")) e.rating = form.rating;

      for (const id of trackIds) {
        await libraryApi.updateTrack(id, e);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }, [form, dirty, trackIds, onSaved, onClose]);

  const pasteArtwork = useCallback(async () => {
    setBusy(true);
    setArtMsg("");
    try {
      const img = await readImage();
      const { width, height } = await img.size();
      const rgba = await img.rgba();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
      if (!blob) throw new Error("PNG encode failed");
      const buf = new Uint8Array(await blob.arrayBuffer());
      const n = await libraryApi.setArtworkFromData(trackIds, toBase64(buf));
      setArtVersion((v) => v + 1);
      setArtMsg(`${n} 曲に設定しました`);
      onSaved();
    } catch (e) {
      setArtMsg(`クリップボードから画像を取得できませんでした (${e})`);
    } finally {
      setBusy(false);
    }
  }, [trackIds, onSaved]);

  const chooseArtwork = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setArtMsg("");
    try {
      const n = await libraryApi.setArtworkFromFile(trackIds, path);
      setArtVersion((v) => v + 1);
      setArtMsg(`${n} 曲に設定しました`);
      onSaved();
    } catch (e) {
      setArtMsg(`設定に失敗しました (${e})`);
    } finally {
      setBusy(false);
    }
  }, [trackIds, onSaved]);

  // 単曲のときだけ現在のジャケットをプレビュー (?v= でキャッシュバスト)。
  const baseArt = single ? artworkUrl(tracks[0].locationPath) : null;
  const artUrl = baseArt
    ? `${baseArt}${baseArt.includes("?") ? "&" : "?"}v=${artVersion}`
    : null;
  const seed = single ? tracks[0].album : "multi";
  const glyph = single ? tracks[0].name : `${tracks.length}`;

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal track-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="info" size={16} />{" "}
            {single ? "Track Info" : `${tracks.length} 曲を一括編集`}
          </h2>
          <button className="modal-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body track-editor-body">
          {/* Artwork */}
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 6 }}>
            <div
              style={{
                width: 88,
                height: 88,
                borderRadius: 10,
                flexShrink: 0,
                position: "relative",
                overflow: "hidden",
                background: artGradient(seed),
                display: "grid",
                placeItems: "center",
              }}
            >
              {artUrl ? (
                <img
                  src={artUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <span
                  style={{
                    fontSize: 34,
                    fontWeight: 800,
                    color: "rgba(255,255,255,.92)",
                    textShadow: "0 2px 8px rgba(0,0,0,.35)",
                  }}
                >
                  {single ? leadingGlyph(glyph) : `×${tracks.length}`}
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="toolbar-btn" onClick={pasteArtwork} disabled={busy}>
                  <Icon name="layers" size={14} /> クリップボードから貼付
                </button>
                <button className="toolbar-btn" onClick={chooseArtwork} disabled={busy}>
                  <Icon name="filePlus" size={14} /> ファイルから…
                </button>
              </div>
              {artMsg && <div style={{ fontSize: 12, color: "var(--mut)" }}>{artMsg}</div>}
              {!single && (
                <div style={{ fontSize: 12, color: "var(--mut)" }}>
                  アートワークは選択中の {tracks.length} 曲すべてに適用されます。
                </div>
              )}
            </div>
          </div>

          <Field label="Name">
            <input
              className="rip-input"
              value={form.name}
              placeholder={ph(initial.name.mixed)}
              onChange={(e) => update("name", e.target.value)}
            />
          </Field>
          <Field label="Artist">
            <input
              className="rip-input"
              value={form.artist}
              placeholder={ph(initial.artist.mixed)}
              onChange={(e) => update("artist", e.target.value)}
            />
          </Field>
          <Field label="Album Artist">
            <input
              className="rip-input"
              value={form.albumArtist}
              placeholder={ph(initial.albumArtist.mixed)}
              onChange={(e) => update("albumArtist", e.target.value)}
            />
          </Field>
          <Field label="Album">
            <input
              className="rip-input"
              value={form.album}
              placeholder={ph(initial.album.mixed)}
              onChange={(e) => update("album", e.target.value)}
            />
          </Field>
          <Field label="Composer">
            <input
              className="rip-input"
              value={form.composer}
              placeholder={ph(initial.composer.mixed)}
              onChange={(e) => update("composer", e.target.value)}
            />
          </Field>
          <Field label="Genre (space-separated tags)">
            <input
              className="rip-input"
              value={form.genre}
              placeholder={ph(initial.genre.mixed) ?? "e.g. House Techno Electronic"}
              onChange={(e) => update("genre", e.target.value)}
            />
          </Field>

          <div className="track-editor-row">
            <Field label="Year">
              <input
                className="rip-input"
                type="number"
                value={form.year}
                placeholder={ph(initial.year.mixed)}
                onChange={(e) => update("year", e.target.value)}
              />
            </Field>
            <Field label="BPM">
              <input
                className="rip-input"
                type="number"
                value={form.bpm}
                placeholder={ph(initial.bpm.mixed)}
                onChange={(e) => update("bpm", e.target.value)}
              />
            </Field>
          </div>

          <div className="track-editor-row">
            <Field label="Track #">
              <input
                className="rip-input"
                type="number"
                value={form.trackNumber}
                placeholder={ph(initial.trackNumber.mixed)}
                onChange={(e) => update("trackNumber", e.target.value)}
              />
            </Field>
            <Field label="Of">
              <input
                className="rip-input"
                type="number"
                value={form.trackCount}
                placeholder={ph(initial.trackCount.mixed)}
                onChange={(e) => update("trackCount", e.target.value)}
              />
            </Field>
            <Field label="Disc #">
              <input
                className="rip-input"
                type="number"
                value={form.discNumber}
                placeholder={ph(initial.discNumber.mixed)}
                onChange={(e) => update("discNumber", e.target.value)}
              />
            </Field>
            <Field label="Of">
              <input
                className="rip-input"
                type="number"
                value={form.discCount}
                placeholder={ph(initial.discCount.mixed)}
                onChange={(e) => update("discCount", e.target.value)}
              />
            </Field>
          </div>

          <Field label="Rating">
            <div className="track-editor-rating">
              <Stars
                value={Math.round(form.rating / 20)}
                size={18}
                onSet={(n) => update("rating", n * 20)}
              />
              <button
                type="button"
                className="track-editor-clear"
                onClick={() => update("rating", 0)}
              >
                clear
              </button>
              {initial.rating.mixed && !dirty.has("rating") && (
                <span style={{ fontSize: 12, color: "var(--mut)" }}>(複数の値)</span>
              )}
            </div>
          </Field>

          <Field label="Comments">
            <textarea
              className="rip-input"
              rows={4}
              value={form.comments}
              placeholder={ph(initial.comments.mixed)}
              onChange={(e) => update("comments", e.target.value)}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          {single && tracks[0].locationPath && (
            <Field label="Location">
              <div className="track-editor-readonly">{tracks[0].locationPath}</div>
            </Field>
          )}

          {error && <div className="rip-error">{error}</div>}

          <div className="rip-actions">
            <button className="toolbar-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="toolbar-btn primary" onClick={handleSave} disabled={busy}>
              {busy ? "Saving..." : single ? "Save" : `${tracks.length} 曲を保存`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="track-editor-field">
      <span className="track-editor-label">{label}</span>
      {children}
    </label>
  );
}
