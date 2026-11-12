import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as playlistsApi from "../api/playlists";
import { useStore } from "../store/useStore";
import { Icon } from "./Icon";
import type {
  Playlist,
  SmartCriteria,
  SmartGroup,
  SmartOp,
  SmartRule,
  SmartSortKey,
} from "../types";

interface SmartPlaylistEditorProps {
  /// null = 新規作成、数値 = 既存スマートプレイリストの編集。
  playlistId: number | null;
  initialName?: string;
  onClose: () => void;
  onSaved: () => void;
}

type FieldType = "str" | "num" | "date" | "playlist";

const FIELDS: { value: string; label: string; type: FieldType }[] = [
  { value: "artist", label: "アーティスト", type: "str" },
  { value: "albumArtist", label: "アルバムアーティスト", type: "str" },
  { value: "album", label: "アルバム", type: "str" },
  { value: "name", label: "曲名", type: "str" },
  { value: "genre", label: "ジャンル", type: "str" },
  { value: "grouping", label: "グループ", type: "str" },
  { value: "composer", label: "作曲者", type: "str" },
  { value: "comments", label: "コメント", type: "str" },
  { value: "key", label: "Key (Camelot)", type: "str" },
  // 別のプレイリスト (スマート・フォルダも可) に含まれるか。値は参照先の persistentId。
  { value: "playlist", label: "プレイリスト", type: "playlist" },
  { value: "year", label: "年", type: "num" },
  { value: "bpm", label: "BPM", type: "num" },
  { value: "rating", label: "評価 (0–5, 0.5 刻み)", type: "num" },
  { value: "energy", label: "Energy (0–1)", type: "num" },
  { value: "playCount", label: "再生回数", type: "num" },
  { value: "skipCount", label: "スキップ回数", type: "num" },
  { value: "trackNumber", label: "曲番号", type: "num" },
  { value: "discNumber", label: "ディスク番号", type: "num" },
  { value: "trackId", label: "曲 ID", type: "num" },
  // bool は 1 / 0 で比較する (Rules の equals: true は is 1 になる)。
  { value: "compilation", label: "コンピレーション (1/0)", type: "num" },
  { value: "disabled", label: "無効 (1/0)", type: "num" },
  { value: "kind", label: "種類", type: "str" },
  { value: "location", label: "ファイルの場所", type: "str" },
  // 技術メタデータ (#171)。codec は "MP3" / "AAC" / "ALAC" / "FLAC" などの表示名。
  { value: "bitrate", label: "ビットレート (kbps)", type: "num" },
  { value: "sampleRate", label: "サンプルレート (Hz)", type: "num" },
  { value: "bitDepth", label: "ビット深度", type: "num" },
  { value: "codec", label: "コーデック", type: "str" },
  { value: "dateAdded", label: "追加日", type: "date" },
  { value: "dateModified", label: "更新日", type: "date" },
  { value: "lastPlayed", label: "最終再生", type: "date" },
];

const STR_OPS: { value: SmartOp; label: string }[] = [
  { value: "contains", label: "が次を含む" },
  { value: "notContains", label: "が次を含まない" },
  { value: "is", label: "が次と一致" },
  { value: "isNot", label: "が次と一致しない" },
  { value: "startsWith", label: "が次で始まる" },
  { value: "endsWith", label: "が次で終わる" },
  { value: "exists", label: "が空でない" },
  { value: "notExists", label: "が空" },
];
const NUM_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "=" },
  { value: "isNot", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "exists", label: "が空でない" },
  { value: "notExists", label: "が空" },
];
const PLAYLIST_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "に含まれる" },
  { value: "isNot", label: "に含まれない" },
];

const SORTS = [
  ["", "既定"],
  ["dateAdded", "追加日"],
  ["lastPlayed", "最終再生"],
  ["playCount", "再生回数"],
  ["rating", "評価"],
  ["bpm", "BPM"],
  ["bitrate", "ビットレート"],
  ["artist", "アーティスト"],
  ["album", "アルバム"],
  ["name", "曲名"],
] as const;

/// 並び替えフィールドの表示名 (選択肢に無いもの = Rules 由来などはフィールド名のまま)。
function sortLabel(field: string): string {
  return (
    SORTS.find(([v]) => v === field)?.[1] ??
    FIELDS.find((f) => f.value === field)?.label ??
    field
  );
}

/// グループの入れ子の上限 (バックエンドは任意の深さを受け付ける。UI は見やすさ優先で 3 段まで)。
const MAX_GROUP_DEPTH = 3;

/// 編集用の条件ツリー (groups を必須にしたもの)。
interface GroupNode {
  matchAll: boolean;
  rules: SmartRule[];
  groups: GroupNode[];
}

interface PlaylistOption {
  value: string;
  label: string;
}

const DEFAULT_RULE: SmartRule = { field: "genre", op: "contains", value: "" };

function fieldType(field: string): FieldType {
  return FIELDS.find((f) => f.value === field)?.type ?? "str";
}
function opsFor(field: string) {
  // date は内部的に str 演算子を流用する。
  const t = fieldType(field);
  if (t === "playlist") return PLAYLIST_OPS;
  return t === "num" ? NUM_OPS : STR_OPS;
}
function needsValue(op: SmartOp) {
  return op !== "exists" && op !== "notExists";
}

function toNode(g: SmartGroup): GroupNode {
  return {
    matchAll: g.matchAll,
    rules: g.rules ?? [],
    groups: (g.groups ?? []).map(toNode),
  };
}

/// 保存用: 実効的に空のグループを取り除く (評価側も読み飛ばすが、保存データを綺麗に保つ)。
function pruneGroups(groups: GroupNode[]): SmartGroup[] {
  return groups
    .map((g) => ({ matchAll: g.matchAll, rules: g.rules, groups: pruneGroups(g.groups) }))
    .filter((g) => g.rules.length > 0 || g.groups.length > 0);
}

/// ツリー中に値未選択のプレイリスト条件があるか。
function hasEmptyPlaylistRule(g: GroupNode): boolean {
  return (
    g.rules.some((r) => r.field === "playlist" && !r.value.trim()) ||
    g.groups.some(hasEmptyPlaylistRule)
  );
}

/// 階層名 ("親 / 子") でプレイリストの選択肢を作る (同名の区別用)。編集中の自身は除く。
function buildPlaylistOptions(playlists: Playlist[], selfPid: string | null): PlaylistOption[] {
  const byPid = new Map<string, Playlist>();
  for (const p of playlists) if (p.persistentId) byPid.set(p.persistentId, p);
  const pathOf = (p: Playlist): string => {
    const names = [p.name];
    let parent = p.parentPersistentId ? byPid.get(p.parentPersistentId) : undefined;
    // 壊れたデータで親が循環していても止まるよう深さを制限する。
    for (let i = 0; parent && i < 32; i++) {
      names.unshift(parent.name);
      parent = parent.parentPersistentId ? byPid.get(parent.parentPersistentId) : undefined;
    }
    return names.join(" / ");
  };
  return playlists
    .filter((p) => p.persistentId && p.persistentId !== selfPid)
    .map((p) => ({
      value: p.persistentId as string,
      label: (p.isFolder ? "📁 " : p.isSmart ? "⚙ " : "") + pathOf(p),
    }));
}

interface RuleRowProps {
  rule: SmartRule;
  onChange: (rule: SmartRule) => void;
  onRemove: () => void;
  removeDisabled: boolean;
  playlistOptions: PlaylistOption[];
}

function RuleRow({ rule, onChange, onRemove, removeDisabled, playlistOptions }: RuleRowProps) {
  const type = fieldType(rule.field);
  // 参照先が見つからない (削除済み・未解決の iTunes PID・自分自身) ものははっきり表示する。
  const missingRef =
    type === "playlist" &&
    rule.value.trim() !== "" &&
    !playlistOptions.some((o) => o.value === rule.value);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select
        className="rip-input"
        value={rule.field}
        onChange={(e) => {
          const field = e.target.value;
          const ops = opsFor(field);
          const op = ops.some((o) => o.value === rule.op) ? rule.op : ops[0].value;
          // プレイリスト条件との切り替えでは値の意味が変わるので空にする。
          const switchedKind = (fieldType(field) === "playlist") !== (type === "playlist");
          onChange({ field, op, value: switchedKind ? "" : rule.value });
        }}
        style={{ flex: "1 1 120px", minWidth: 0 }}
      >
        {FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
        {/* 選択肢に無いフィールド (Rules 由来など) も値を失わないよう表示する。 */}
        {!FIELDS.some((f) => f.value === rule.field) && (
          <option value={rule.field}>{rule.field}</option>
        )}
      </select>
      <select
        className="rip-input"
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value as SmartOp })}
        style={{ flex: "0 0 130px" }}
      >
        {opsFor(rule.field).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {type === "playlist" ? (
        <select
          className="rip-input"
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          title={missingRef ? `参照先のプレイリストが見つかりません (${rule.value})` : undefined}
          style={{
            flex: "1 1 140px",
            minWidth: 0,
            ...(missingRef ? { color: "var(--warn)", borderColor: "var(--warn)" } : {}),
          }}
        >
          <option value="">プレイリストを選択…</option>
          {missingRef && <option value={rule.value}>見つからない参照 ({rule.value})</option>}
          {playlistOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="rip-input"
          type={type === "date" ? "date" : "text"}
          value={rule.value}
          disabled={!needsValue(rule.op)}
          placeholder={needsValue(rule.op) ? (type === "date" ? "" : "値") : "—"}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          style={{ flex: "1 1 100px", minWidth: 0 }}
        />
      )}
      <button
        className="toolbar-btn"
        title="この条件を削除"
        onClick={onRemove}
        disabled={removeDisabled}
        style={{ flexShrink: 0 }}
      >
        <Icon name="minus" size={14} />
      </button>
    </div>
  );
}

interface GroupEditorProps {
  group: GroupNode;
  /// 0 = ルート。
  depth: number;
  onChange: (group: GroupNode) => void;
  /// 子グループのときだけ渡す (ルートは消せない)。
  onRemove?: () => void;
  playlistOptions: PlaylistOption[];
  matchSelectRef?: React.Ref<HTMLSelectElement>;
}

/// 条件グループ (再帰)。ルール列と子グループを「すべて / いずれか」で組み合わせる。
function GroupEditor({
  group,
  depth,
  onChange,
  onRemove,
  playlistOptions,
  matchSelectRef,
}: GroupEditorProps) {
  const childCount = group.rules.length + group.groups.length;
  const setRule = (i: number, rule: SmartRule) =>
    onChange({ ...group, rules: group.rules.map((r, idx) => (idx === i ? rule : r)) });
  const removeRule = (i: number) =>
    onChange({ ...group, rules: group.rules.filter((_, idx) => idx !== i) });
  const setChild = (i: number, child: GroupNode) =>
    onChange({ ...group, groups: group.groups.map((g, idx) => (idx === i ? child : g)) });
  const removeChild = (i: number) =>
    onChange({ ...group, groups: group.groups.filter((_, idx) => idx !== i) });

  const body = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span>{depth === 0 ? "条件:" : "グループ:"}</span>
        <select
          className="rip-input"
          ref={matchSelectRef}
          value={group.matchAll ? "all" : "any"}
          onChange={(e) => onChange({ ...group, matchAll: e.target.value === "all" })}
          style={{ width: 170 }}
        >
          <option value="all">すべてに一致 (AND)</option>
          <option value="any">いずれかに一致 (OR)</option>
        </select>
        {onRemove && (
          <button
            className="toolbar-btn"
            title="このグループを削除"
            onClick={onRemove}
            style={{ marginLeft: "auto" }}
          >
            <Icon name="x" size={14} /> グループを削除
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.rules.map((r, i) => (
          <RuleRow
            key={`r${i}`}
            rule={r}
            onChange={(rule) => setRule(i, rule)}
            onRemove={() => removeRule(i)}
            // 最後の 1 要素は消せない (子グループなら「グループを削除」で消す)。
            removeDisabled={childCount <= 1}
            playlistOptions={playlistOptions}
          />
        ))}
        {group.groups.map((g, i) => (
          <GroupEditor
            key={`g${i}`}
            group={g}
            depth={depth + 1}
            onChange={(child) => setChild(i, child)}
            onRemove={() => removeChild(i)}
            playlistOptions={playlistOptions}
          />
        ))}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="toolbar-btn"
            onClick={() =>
              onChange({
                ...group,
                rules: [...group.rules, { field: "artist", op: "contains", value: "" }],
              })
            }
          >
            <Icon name="plus" size={14} /> 条件を追加
          </button>
          <button
            className="toolbar-btn"
            onClick={() =>
              onChange({
                ...group,
                groups: [
                  ...group.groups,
                  // 親と逆の結合にしておくと「A かつ (B または C)」がすぐ作れる。
                  { matchAll: !group.matchAll, rules: [{ ...DEFAULT_RULE }], groups: [] },
                ],
              })
            }
            disabled={depth >= MAX_GROUP_DEPTH}
            title={
              depth >= MAX_GROUP_DEPTH
                ? `グループの入れ子は ${MAX_GROUP_DEPTH} 段までです`
                : "条件グループ (入れ子の AND / OR) を追加"
            }
          >
            <Icon name="plus" size={14} /> グループを追加
          </button>
        </div>
      </div>
    </>
  );

  if (depth === 0) {
    return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{body}</div>;
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 8,
        border: "1px solid var(--bd)",
        borderRadius: 6,
      }}
    >
      {body}
    </div>
  );
}

export function SmartPlaylistEditor({
  playlistId,
  initialName,
  onClose,
  onSaved,
}: SmartPlaylistEditorProps) {
  const creating = playlistId === null;
  const playlists = useStore((s) => s.playlists);
  const [name, setName] = useState(initialName ?? "");
  const [root, setRoot] = useState<GroupNode>({
    matchAll: true,
    rules: [{ ...DEFAULT_RULE }],
    groups: [],
  });
  const [limit, setLimit] = useState<string>("");
  const [sortBy, setSortBy] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  // 第 2 キー以降の並び替え (Rules 由来)。UI では編集しないが保存時にそのまま残す。
  const [thenBy, setThenBy] = useState<SmartSortKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 編集モード時に最初のフォーカスを当てる参照。
  const firstFocusRef = useRef<HTMLSelectElement>(null);

  // 参照先の候補 (編集中のプレイリスト自身は除く)。
  const selfPid = useMemo(
    () => playlists.find((p) => p.playlistId === playlistId)?.persistentId ?? null,
    [playlists, playlistId],
  );
  const playlistOptions = useMemo(
    () => buildPlaylistOptions(playlists, selfPid),
    [playlists, selfPid],
  );

  // 編集モードなら既存条件を読み込む。
  useEffect(() => {
    if (playlistId === null) return;
    let alive = true;
    playlistsApi
      .getSmartCriteria(playlistId)
      .then((c) => {
        if (!alive || !c) return;
        const node = toNode({ matchAll: c.matchAll, rules: c.rules, groups: c.groups });
        if (node.rules.length === 0 && node.groups.length === 0) {
          node.rules = [{ ...DEFAULT_RULE }];
        }
        setRoot(node);
        setLimit(c.limit != null ? String(c.limit) : "");
        setSortBy(c.sortBy ?? "");
        setSortDesc(c.sortDesc);
        setThenBy(c.thenBy ?? []);
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

  const handleSave = useCallback(async () => {
    if (creating && !name.trim()) {
      setError("名前を入力してください");
      return;
    }
    if (hasEmptyPlaylistRule(root)) {
      setError("参照するプレイリストを選択してください");
      return;
    }
    setBusy(true);
    setError("");
    const criteria: SmartCriteria = {
      matchAll: root.matchAll,
      rules: root.rules,
      groups: pruneGroups(root.groups),
      limit: limit.trim() ? Math.max(0, parseInt(limit, 10) || 0) || null : null,
      sortBy: sortBy || null,
      sortDesc,
      ...(thenBy.length > 0 ? { thenBy } : {}),
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
  }, [creating, name, root, limit, sortBy, sortDesc, thenBy, playlistId, onSaved, onClose]);

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
      <div
        className="modal"
        style={{ width: 680, maxWidth: "calc(100vw - 32px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <Icon name="sliders" size={16} />{" "}
            {creating ? "新規スマートプレイリスト" : "スマートプレイリストを編集"}
          </h2>
          <button className="modal-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          {creating && (
            <input
              className="rip-input"
              placeholder="プレイリスト名"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <GroupEditor
            group={root}
            depth={0}
            onChange={setRoot}
            playlistOptions={playlistOptions}
            matchSelectRef={firstFocusRef}
          />

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
                {sortBy && !SORTS.some(([v]) => v === sortBy) && (
                  <option value={sortBy}>{sortLabel(sortBy)}</option>
                )}
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
          {thenBy.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--tx2)" }}>
              同順位の並び:{" "}
              {thenBy.map((k) => `${sortLabel(k.field)} ${k.desc ? "↓" : "↑"}`).join(", ")}
            </div>
          )}

          {error && <div className="rip-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="toolbar-btn" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="toolbar-btn primary" onClick={handleSave} disabled={busy}>
            {busy ? "保存中…" : creating ? "作成" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
