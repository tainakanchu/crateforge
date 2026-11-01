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
      setErrorMsg("✓ Syntactically valid.");
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
    } catch (e) {
      setPreview(null);
      setErrorMsg(`${e}`);
    } finally {
      setBusy(false);
    }
  }, [yamlText]);

  const handleApply = useCallback(async () => {
    if (
      !confirm(
        "Apply rules to the library?\n\nEach rule is saved as a smart playlist under the namespace folder. Playlists at the same path are updated in place (their IDs and references are kept). If `removeExistingNamespace` is true (default), playlists and folders under the namespace that are not in the rules will be removed.",
      )
    ) {
      return;
    }
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
      setErrorMsg(`Loaded ${path}`);
    } catch (e) {
      setErrorMsg(`Failed to load: ${e}`);
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
      setErrorMsg(`Saved → ${path}`);
    } catch (e) {
      setErrorMsg(`Failed to save: ${e}`);
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
      setErrorMsg(`Saved → ${path}`);
    } catch (e) {
      setErrorMsg(`Failed to save: ${e}`);
    }
  }, [yamlText, currentPath]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rules-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name="settings" size={16} /> Playlist Rules
            {currentPath && <span className="rules-path"> — {currentPath}</span>}
          </h2>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body rules-body">
          <div className="rules-toolbar">
            <button className="toolbar-btn" onClick={handleOpen} disabled={busy}>
              <Icon name="folderOpen" size={14} /> Open
            </button>
            <button className="toolbar-btn" onClick={handleSave} disabled={busy}>
              <Icon name="save" size={14} /> Save
            </button>
            <button className="toolbar-btn" onClick={handleSaveAs} disabled={busy}>
              <Icon name="save" size={14} /> Save As…
            </button>
            <span className="rules-toolbar-sep" />
            <button className="toolbar-btn" onClick={handleValidate} disabled={busy}>
              <Icon name="check" size={14} /> Validate
            </button>
            <button className="toolbar-btn primary" onClick={handlePreview} disabled={busy}>
              <Icon name="eye" size={14} /> Preview
            </button>
            <button className="toolbar-btn" onClick={handleApply} disabled={busy || !preview}>
              <Icon name="play" size={14} fill="currentColor" stroke={0} /> Apply to Library
            </button>
          </div>

          {errorMsg && (
            <div className={`rules-msg ${errorMsg.startsWith("✓") || errorMsg.startsWith("Loaded") || errorMsg.startsWith("Saved") ? "ok" : "err"}`}>
              {errorMsg.startsWith("✓")
                ? <><Icon name="check" size={13} style={{ verticalAlign: "-2px" }} /> {errorMsg.slice(1).trimStart()}</>
                : errorMsg}
            </div>
          )}

          {applyResult && (
            <div className="rules-msg ok" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Icon name="checkCircle" size={14} style={{ flexShrink: 0 }} /> Applied: {applyResult.generatedPlaylistCount} smart playlists, {applyResult.generatedFolderCount} folders
              {" "}({formatChanges(applyResult)})
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
                  Click <strong>Preview</strong> to evaluate rules against the current library.
                </div>
              ) : (
                <>
                  <div className="rules-stats" style={{ flexWrap: "wrap" }}>
                    <span><strong>{preview.playlistCount}</strong> smart playlists</span>
                    <span>·</span>
                    <span><strong>{preview.folderCount}</strong> folders</span>
                    <span>·</span>
                    <span><strong>{preview.referencedTrackCount}</strong> tracks</span>
                    {!applyResult && (
                      <>
                        <span>·</span>
                        <span>Apply will {formatChanges(preview)}</span>
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
    </div>
  );
}

/// 作成 / 更新 / 削除の件数 ("2 created, 5 updated, 1 removed")。
function formatChanges(r: { createdCount: number; updatedCount: number; removedCount: number }): string {
  return `${r.createdCount} created, ${r.updatedCount} updated, ${r.removedCount} removed`;
}

/// 変換・適用時の警告 (スマート条件で再現しきれない指定など)。
function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rules-msg warn">
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Icon name="warning" size={13} style={{ flexShrink: 0 }} /> {warnings.length} warning{warnings.length > 1 ? "s" : ""}
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
