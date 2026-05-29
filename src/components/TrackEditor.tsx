import { useCallback, useState } from "react";
import * as libraryApi from "../api/library";
import { Icon, Stars } from "./Icon";
import type { Track, TrackEdit } from "../types";

interface TrackEditorProps {
  track: Track;
  onClose: () => void;
  onSaved: () => void;
}

function parseInt2(v: string): number | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

export function TrackEditor({ track, onClose, onSaved }: TrackEditorProps) {
  const [form, setForm] = useState({
    name: track.name ?? "",
    artist: track.artist ?? "",
    albumArtist: track.albumArtist ?? "",
    album: track.album ?? "",
    composer: track.composer ?? "",
    genre: track.genre ?? "",
    year: track.year != null ? String(track.year) : "",
    bpm: track.bpm != null ? String(track.bpm) : "",
    trackNumber: track.trackNumber != null ? String(track.trackNumber) : "",
    trackCount: track.trackCount != null ? String(track.trackCount) : "",
    discNumber: track.discNumber != null ? String(track.discNumber) : "",
    discCount: track.discCount != null ? String(track.discCount) : "",
    comments: track.comments ?? "",
    rating: track.rating ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = useCallback(
    <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const edits: TrackEdit = {
        name: form.name,
        artist: form.artist,
        albumArtist: form.albumArtist,
        album: form.album,
        composer: form.composer,
        genre: form.genre,
        comments: form.comments,
        year: parseInt2(form.year),
        bpm: parseInt2(form.bpm),
        trackNumber: parseInt2(form.trackNumber),
        trackCount: parseInt2(form.trackCount),
        discNumber: parseInt2(form.discNumber),
        discCount: parseInt2(form.discCount),
        rating: form.rating,
      };
      await libraryApi.updateTrack(track.trackId, edits);
      onSaved();
      onClose();
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [form, track.trackId, onSaved, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal track-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <Icon name="info" size={16} /> Track Info
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body track-editor-body">
          <Field label="Name">
            <input
              className="rip-input"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </Field>
          <Field label="Artist">
            <input
              className="rip-input"
              value={form.artist}
              onChange={(e) => update("artist", e.target.value)}
            />
          </Field>
          <Field label="Album Artist">
            <input
              className="rip-input"
              value={form.albumArtist}
              onChange={(e) => update("albumArtist", e.target.value)}
            />
          </Field>
          <Field label="Album">
            <input
              className="rip-input"
              value={form.album}
              onChange={(e) => update("album", e.target.value)}
            />
          </Field>
          <Field label="Composer">
            <input
              className="rip-input"
              value={form.composer}
              onChange={(e) => update("composer", e.target.value)}
            />
          </Field>
          <Field label="Genre (space-separated tags)">
            <input
              className="rip-input"
              value={form.genre}
              onChange={(e) => update("genre", e.target.value)}
              placeholder="e.g. House Techno Electronic"
            />
          </Field>

          <div className="track-editor-row">
            <Field label="Year">
              <input
                className="rip-input"
                type="number"
                value={form.year}
                onChange={(e) => update("year", e.target.value)}
              />
            </Field>
            <Field label="BPM">
              <input
                className="rip-input"
                type="number"
                value={form.bpm}
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
                onChange={(e) => update("trackNumber", e.target.value)}
              />
            </Field>
            <Field label="Of">
              <input
                className="rip-input"
                type="number"
                value={form.trackCount}
                onChange={(e) => update("trackCount", e.target.value)}
              />
            </Field>
            <Field label="Disc #">
              <input
                className="rip-input"
                type="number"
                value={form.discNumber}
                onChange={(e) => update("discNumber", e.target.value)}
              />
            </Field>
            <Field label="Of">
              <input
                className="rip-input"
                type="number"
                value={form.discCount}
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
            </div>
          </Field>

          <Field label="Comments">
            <textarea
              className="rip-input"
              rows={4}
              value={form.comments}
              onChange={(e) => update("comments", e.target.value)}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          {track.locationPath && (
            <Field label="Location">
              <div className="track-editor-readonly">{track.locationPath}</div>
            </Field>
          )}

          {error && <div className="rip-error">{error}</div>}

          <div className="rip-actions">
            <button className="toolbar-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="toolbar-btn primary" onClick={handleSave} disabled={busy}>
              {busy ? "Saving..." : "Save"}
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
