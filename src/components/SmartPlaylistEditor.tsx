import { useCallback, useEffect, useRef, useState } from "react";
import * as playlistsApi from "../api/playlists";
import { Icon } from "./Icon";
import type { SmartCriteria, SmartOp, SmartRule } from "../types";

interface SmartPlaylistEditorProps {
  /// null = 新規作成、数値 = 既存スマートプレイリストの編集。
  playlistId: number | null;
  initialName?: string;
  onClose: () => void;
  onSaved: () => void;
}

type FieldType = "str" | "num" | "date";

const FIELDS: { value: string; label: string; type: FieldType }[] = [
  { value: "artist", label: "Artist", type: "str" },
  { value: "albumArtist", label: "Album Artist", type: "str" },
  { value: "album", label: "Album", type: "str" },
  { value: "name", label: "Name", type: "str" },
  { value: "genre", label: "Genre", type: "str" },
  { value: "composer", label: "Composer", type: "str" },
  { value: "comments", label: "Comments", type: "str" },
  { value: "key", label: "Key (Camelot)", type: "str" },
  { value: "year", label: "Year", type: "num" },
  { value: "bpm", label: "BPM", type: "num" },
  { value: "rating", label: "Rating (0–5)", type: "num" },
  { value: "energy", label: "Energy (0–1)", type: "num" },
  { value: "playCount", label: "Plays", type: "num" },
  { value: "skipCount", label: "Skips", type: "num" },
  { value: "dateAdded", label: "Date Added", type: "date" },
  { value: "lastPlayed", label: "Last Played", type: "date" },
];

const STR_OPS: { value: SmartOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "notContains", label: "doesn't contain" },
  { value: "is", label: "is" },
  { value: "isNot", label: "is not" },
  { value: "exists", label: "is present" },
  { value: "notExists", label: "is empty" },
];
const NUM_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "=" },
  { value: "isNot", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "exists", label: "is present" },
  { value: "notExists", label: "is empty" },
];

const SORTS = [
  ["", "Default"],
  ["dateAdded", "Date Added"],
  ["lastPlayed", "Last Played"],
  ["playCount", "Plays"],
  ["rating", "Rating"],
  ["bpm", "BPM"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["name", "Name"],
] as const;

function fieldType(field: string): FieldType {
  return FIELDS.find((f) => f.value === field)?.type ?? "str";
}
function opsFor(field: string) {
  // date は内部的に str 演算子を流用する。
  return fieldType(field) === "num" ? NUM_OPS : STR_OPS;
}
function needsValue(op: SmartOp) {
  return op !== "exists" && op !== "notExists";
}

export function SmartPlaylistEditor({
  playlistId,
  initialName,
  onClose,
  onSaved,
}: SmartPlaylistEditorProps) {
  const creating = playlistId === null;
  const [name, setName] = useState(initialName ?? "");
  const [matchAll, setMatchAll] = useState(true);
  const [rules, setRules] = useState<SmartRule[]>([
    { field: "genre", op: "contains", value: "" },
  ]);
  const [limit, setLimit] = useState<string>("");
  const [sortBy, setSortBy] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 編集モード時に最初のフォーカスを当てる参照。
  const firstFocusRef = useRef<HTMLSelectElement>(null);

  // 編集モードなら既存条件を読み込む。
  useEffect(() => {
    if (playlistId === null) return;
    let alive = true;
    playlistsApi
      .getSmartCriteria(playlistId)
      .then((c) => {
        if (!alive || !c) return;
        setMatchAll(c.matchAll);
        setRules(c.rules.length ? c.rules : [{ field: "genre", op: "contains", value: "" }]);
        setLimit(c.limit != null ? String(c.limit) : "");
        setSortBy(c.sortBy ?? "");
        setSortDesc(c.sortDesc);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [playlistId]);

  // 編集モード: 初期フォーカスを match-all セレクトに当てる。
  useEffect(() => {
    if (!creating) {
      firstFocusRef.current?.focus();
    }
  }, [creating]);

  const setRule = useCallback((i: number, patch: Partial<SmartRule>) => {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }, []);
  const addRule = useCallback(() => {
    setRules((rs) => [...rs, { field: "artist", op: "contains", value: "" }]);
  }, []);
  const removeRule = useCallback((i: number) => {
    setRules((rs) => (rs.length <= 1 ? rs : rs.filter((_, idx) => idx !== i)));
  }, []);

  const handleSave = useCallback(async () => {
    if (creating && !name.trim()) {
      setError("名前を入力してください");
      return;
    }
    setBusy(true);
    setError("");
    const criteria: SmartCriteria = {
      matchAll,
      rules,
      limit: limit.trim() ? Math.max(0, parseInt(limit, 10) || 0) || null : null,
      sortBy: sortBy || null,
      sortDesc,
    };
    try {
      if (creating) {
        await playlistsApi.createSmartPlaylist(name.trim(), criteria);
      } else {
        await playlistsApi.updateSmartCriteria(playlistId, criteria);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [creating, name, matchAll, rules, limit, sortBy, sortDesc, playlistId, onSaved, onClose]);

  // Esc で閉じる / Ctrl+Enter または Cmd+Enter で保存（handleSave 定義後に登録）。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // IME 変換中は無視。
      if (e.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, handleSave]);

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="sliders" size={16} />{" "}
            {creating ? "New Smart Playlist" : "Edit Smart Playlist"}
          </h2>
          <button className="modal-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {creating && (
            <input
              className="rip-input"
              placeholder="プレイリスト名"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span>条件:</span>
            <select
              className="rip-input"
              ref={firstFocusRef}
              value={matchAll ? "all" : "any"}
              onChange={(e) => setMatchAll(e.target.value === "all")}
              style={{ width: 160 }}
            >
              <option value="all">すべてに一致 (AND)</option>
              <option value="any">いずれかに一致 (OR)</option>
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rules.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select
                  className="rip-input"
                  value={r.field}
                  onChange={(e) => {
                    const field = e.target.value;
                    const ops = opsFor(field);
                    const op = ops.some((o) => o.value === r.op) ? r.op : ops[0].value;
                    setRule(i, { field, op });
                  }}
                  style={{ flex: "1 1 130px", minWidth: 0 }}
                >
                  {FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  className="rip-input"
                  value={r.op}
                  onChange={(e) => setRule(i, { op: e.target.value as SmartOp })}
                  style={{ flex: "0 0 140px" }}
                >
                  {opsFor(r.field).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  className="rip-input"
                  type={fieldType(r.field) === "date" ? "date" : "text"}
                  value={r.value}
                  disabled={!needsValue(r.op)}
                  placeholder={needsValue(r.op) ? (fieldType(r.field) === "date" ? "" : "値") : "—"}
                  onChange={(e) => setRule(i, { value: e.target.value })}
                  style={{ flex: "1 1 100px", minWidth: 0 }}
                />
                <button
                  className="toolbar-btn"
                  title="この条件を削除"
                  onClick={() => removeRule(i)}
                  disabled={rules.length <= 1}
                  style={{ flexShrink: 0 }}
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            ))}
            <button className="toolbar-btn" onClick={addRule} style={{ alignSelf: "flex-start" }}>
              <Icon name="plus" size={14} /> 条件を追加
            </button>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              並び替え:
              <select
                className="rip-input"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                {SORTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={sortDesc}
                onChange={(e) => setSortDesc(e.target.checked)}
              />
              降順
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              上限:
              <input
                className="rip-input"
                type="number"
                placeholder="∞"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                style={{ width: 80 }}
              />
              曲
            </label>
          </div>

          {error && <div className="rip-error">{error}</div>}

          <div className="rip-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="toolbar-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="toolbar-btn primary" onClick={handleSave} disabled={busy}>
              {busy ? "Saving…" : creating ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
