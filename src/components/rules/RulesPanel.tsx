import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import * as rulesApi from "../../api/rules";
import { Icon } from "../Icon";
import type {
  ApplyResult,
  EvaluationResult,
  FolderNodeOut,
  TreeNodeOut,
} from "../../types";

const DEFAULT_TEMPLATE = `# Declarative playlist rules
# Spec: https://github.com/tainakanchu/itunes-playlist-builder/blob/master/doc.md
# Each rule becomes a smart playlist under the namespace folder. Re-applying updates
# them in place (same path = same playlist), so references keep working.
namespace: "_Generated"

options:
  # Remove playlists/folders under the namespace that are no longer in the rules.
  removeExistingNamespace: true
  failOnMissingPlaylist: false

playlists:
  - name: "Base/Favorites/4stars+"
    description: "4 stars or higher"
    match:
      all:
        - field: rating
          gte: 80
    sort:
      - field: artist
        order: asc
      - field: album
        order: asc

  - name: "Genre/House/Favorites"
    match:
      all:
        - inPlaylist:
            source: generated
            name: "Base/Favorites/4stars+"
        - field: genre
          contains: "House"
    sort:
      - field: bpm
        order: asc

generators:
  - type: bpmRange
    basePath: "BPM/Favorites"
    sourcePlaylist:
      source: generated
      name: "Base/Favorites/4stars+"
    from: 80
    to: 180
    step: 5
    pad: 3
    sort:
      - field: bpm
        order: asc
`;

interface RulesPanelProps {
  open: boolean;
  onClose: () => void;
  onLibraryChanged: () => void;
}

export function RulesPanel({ open: isOpen, onClose, onLibraryChanged }: RulesPanelProps) {
  const [yamlText, setYamlText] = useState(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<EvaluationResult | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // Preview した時点の YAML。編集後は再 Preview するまで Apply させない。
  const [previewYaml, setPreviewYaml] = useState<string | null>(null);
  // Apply 前の確認 (アプリ内ダイアログ)。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const previewStale = preview != null && previewYaml !== yamlText;
  const applyDisabledReason = !preview
    ? "先に「プレビュー」で結果を確認してください"
    : previewStale
      ? "YAML が変更されました。もう一度「プレビュー」してください"
      : null;

  // Esc で閉じる (確認ダイアログが開いていればそちらだけ閉じる)。
  // エディタが Esc を使った (補完を閉じた等で preventDefault 済み) ときは閉じない。
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (confirmOpen) setConfirmOpen(false);
      else if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, confirmOpen, busy, onClose]);

  // Restore last YAML across opens (session-local).
  useEffect(() => {
    if (!isOpen) return;
    const saved = sessionStorage.getItem("rules-yaml-draft");
    if (saved) setYamlText(saved);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      sessionStorage.setItem("rules-yaml-draft", yamlText);
    }
  }, [yamlText, isOpen]);

  const handleValidate = useCallback(async () => {
    setBusy(true);
    setErrorMsg("");
    try {
      await rulesApi.validateRules(yamlText);
      setErrorMsg("✓ 構文に問題はありません。");
    } catch (e) {
      setErrorMsg(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [yamlText]);

  const handlePreview = useCallback(async () => {
    setBusy(true);
    setErrorMsg("");
    setApplyResult(null);
    try {
      const result = await rulesApi.previewRules(yamlText);
      setPreview(result);
      setPreviewYaml(yamlText);
    } catch (e) {
      setPreview(null);
      setPreviewYaml(null);
      setErrorMsg(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [yamlText]);

  const handleApply = useCallback(async () => {
    setConfirmOpen(false);
    setBusy(true);
    setErrorMsg("");
    try {
      const result = await rulesApi.applyRules(yamlText);
      setApplyResult(result);
      onLibraryChanged();
    } catch (e) {
      setErrorMsg(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [yamlText, onLibraryChanged]);

  const handleOpen = useCallback(async () => {
    const path = await open({
      filters: [{ name: "Rules YAML", extensions: ["yml", "yaml"] }],
    });
    if (!path || typeof path !== "string") return;
    try {
      const content = await rulesApi.readTextFile(path);
      setYamlText(content);
      setCurrentPath(path);
      setErrorMsg(`読み込みました: ${path}`);
    } catch (e) {
      setErrorMsg(`読み込みに失敗しました: ${e}`);
    }
  }, []);

  const handleSave = useCallback(async () => {
    const path = currentPath
      ? currentPath
      : await save({
          filters: [{ name: "Rules YAML", extensions: ["yml", "yaml"] }],
          defaultPath: "rules.yml",
        });
    if (!path) return;
    try {
      await rulesApi.writeTextFile(path, yamlText);
      setCurrentPath(path);
      setErrorMsg(`保存しました: ${path}`);
    } catch (e) {
      setErrorMsg(`保存に失敗しました: ${e}`);
    }
  }, [yamlText, currentPath]);

  const handleSaveAs = useCallback(async () => {
    const path = await save({
      filters: [{ name: "Rules YAML", extensions: ["yml", "yaml"] }],
      defaultPath: currentPath ?? "rules.yml",
    });
    if (!path) return;
    try {
      await rulesApi.writeTextFile(path, yamlText);
      setCurrentPath(path);
      setErrorMsg(`保存しました: ${path}`);
    } catch (e) {
      setErrorMsg(`保存に失敗しました: ${e}`);
    }
  }, [yamlText, currentPath]);

  if (!isOpen) return null;

  const isOkMsg = (m: string) =>
    m.startsWith("✓") || m.startsWith("読み込みました") || m.startsWith("保存しました");

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal rules-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="settings" size={16} /> プレイリストルール (Rules)
            {currentPath && <span className="rules-path"> — {currentPath}</span>}
          </h2>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body rules-body">
          <div className="rules-toolbar">
            <button className="toolbar-btn" onClick={handleOpen} disabled={busy}>
              <Icon name="folderOpen" size={14} /> 開く
            </button>
            <button className="toolbar-btn" onClick={handleSave} disabled={busy}>
              <Icon name="save" size={14} /> 保存
            </button>
            <button className="toolbar-btn" onClick={handleSaveAs} disabled={busy}>
              <Icon name="save" size={14} /> 名前を付けて保存…
            </button>
            <span className="rules-toolbar-sep" />
            <button className="toolbar-btn" onClick={handleValidate} disabled={busy}>
              <Icon name="check" size={14} /> 構文チェック
            </button>
            <button className="toolbar-btn primary" onClick={handlePreview} disabled={busy}>
              <Icon name="eye" size={14} /> プレビュー
            </button>
            <button
              className="toolbar-btn"
              onClick={() => setConfirmOpen(true)}
              disabled={busy || applyDisabledReason != null}
              title={applyDisabledReason ?? "プレビューの内容でライブラリに適用する"}
            >
              <Icon name="play" size={14} fill="currentColor" stroke={0} /> ライブラリに適用…
            </button>
            {applyDisabledReason && (
              <span className="rules-apply-hint">{applyDisabledReason}</span>
            )}
          </div>

          <div className="rules-help">
            各ルールは namespace フォルダの下にスマートプレイリストとして保存されます。
            <code>rating</code> は 0–100 で指定します（★1 = 20、★3 = 60、★4 = 80、★5 = 100。半星は 10 刻み）。
            <code>bpm</code> はタグの BPM、無ければ解析値で判定します。
          </div>

          {errorMsg && (
            <div className={`rules-msg ${isOkMsg(errorMsg) ? "ok" : "err"}`}>
              {errorMsg.startsWith("✓")
                ? <><Icon name="check" size={13} style={{ verticalAlign: "-2px" }} /> {errorMsg.slice(1).trimStart()}</>
                : errorMsg}
            </div>
          )}

          {applyResult && (
            <div className="rules-msg ok" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Icon name="checkCircle" size={14} style={{ flexShrink: 0 }} /> 適用しました: スマートプレイリスト {applyResult.generatedPlaylistCount} 件・フォルダ {applyResult.generatedFolderCount} 件（名前空間を除く）
              {" "}（{formatChanges(applyResult)}）
            </div>
          )}
          {applyResult && <Warnings warnings={applyResult.warnings} />}

          <div className="rules-split">
            <div className="rules-editor">
              <CodeMirror
                value={yamlText}
                height="100%"
                theme="dark"
                extensions={[yaml()]}
                onChange={(v) => setYamlText(v)}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  bracketMatching: true,
                  foldGutter: true,
                  autocompletion: true,
                }}
              />
            </div>

            <div className="rules-preview">
              {!preview ? (
                <div className="rules-preview-empty">
                  <strong>プレビュー</strong> を押すと、今のライブラリでルールを評価した結果をここに表示します。
                </div>
              ) : (
                <>
                  {previewStale && (
                    <div className="rules-msg warn">
                      YAML が変更されています。この結果は変更前のものです。もう一度プレビューしてください。
                    </div>
                  )}
                  <div className="rules-stats" style={{ flexWrap: "wrap" }}>
                    <span>スマートプレイリスト <strong>{preview.playlistCount}</strong></span>
                    <span>·</span>
                    {/* 件数の数え方を確認ダイアログと揃えて明示する (D9): フォルダ数は名前空間フォルダを除く。
                        作成・更新・削除は名前空間フォルダも含めたプレイリスト / フォルダの合計。 */}
                    <span title="名前空間フォルダ (namespace) 自体は含みません">
                      フォルダ <strong>{preview.folderCount}</strong>（名前空間を除く）
                    </span>
                    <span>·</span>
                    <span>曲 <strong>{preview.referencedTrackCount}</strong></span>
                    {!applyResult && (
                      <>
                        <span>·</span>
                        <span title="名前空間フォルダ・フォルダ・スマートプレイリストの合計">
                          適用すると {formatChanges(preview)}
                        </span>
                      </>
                    )}
                  </div>
                  {!applyResult && <Warnings warnings={preview.warnings} />}
                  <pre className="rules-tree">{renderTree(preview.tree)}</pre>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmOpen && preview && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(false);
          }}
        >
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <Icon name="play" size={16} /> ライブラリに適用
              </h2>
              <button className="modal-close" onClick={() => setConfirmOpen(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div
              className="modal-body"
              style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div>プレビューの内容でライブラリに適用します。</div>
              <ul className="rules-confirm-counts">
                <li>
                  新規作成 <strong>{preview.createdCount}</strong> 件
                  <span style={{ color: "var(--tx2)", fontSize: 12 }}>
                    （名前空間フォルダ・フォルダ・スマートプレイリストの合計）
                  </span>
                </li>
                <li>
                  更新 <strong>{preview.updatedCount}</strong> 件（ID・参照はそのまま）
                </li>
                <li className={preview.removedCount > 0 ? "danger" : undefined}>
                  削除 <strong>{preview.removedCount}</strong> 件
                </li>
              </ul>
              {preview.removedCount > 0 && (
                <div style={{ fontSize: 12, color: "#ef9d9d" }}>
                  namespace フォルダ配下で、ルールに無いプレイリスト / フォルダは削除されます
                  （<code>removeExistingNamespace: false</code> で残せます）。
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="toolbar-btn" onClick={() => setConfirmOpen(false)}>
                  キャンセル
                </button>
                <button
                  className={"toolbar-btn " + (preview.removedCount > 0 ? "danger" : "primary")}
                  onClick={() => void handleApply()}
                  autoFocus
                >
                  適用する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/// 作成 / 更新 / 削除の件数 ("作成 2・更新 5・削除 1")。
function formatChanges(r: { createdCount: number; updatedCount: number; removedCount: number }): string {
  return `作成 ${r.createdCount}・更新 ${r.updatedCount}・削除 ${r.removedCount}`;
}

/// 変換・適用時の警告 (スマート条件で再現しきれない指定など)。
function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rules-msg warn">
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Icon name="warning" size={13} style={{ flexShrink: 0 }} /> 警告 {warnings.length} 件
      </div>
      <ul className="rules-warnings">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function renderTree(root: FolderNodeOut): string {
  const lines: string[] = [root.name];
  function walk(node: TreeNodeOut, prefix: string, isLast: boolean): void {
    const connector = isLast ? "└ " : "├ ";
    if (node.type === "folder") {
      lines.push(`${prefix}${connector}${node.name}`);
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      node.children.forEach((c, i) => walk(c, childPrefix, i === node.children.length - 1));
    } else {
      lines.push(`${prefix}${connector}${node.name} (${node.trackIds.length})`);
    }
  }
  root.children.forEach((c, i) => walk(c, " ", i === root.children.length - 1));
  return lines.join("\n");
}
