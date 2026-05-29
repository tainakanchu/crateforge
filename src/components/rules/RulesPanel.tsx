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
namespace: "_Generated"

options:
  removeExistingNamespace: true
  failOnMissingPlaylist: false
  dedupeTrackIds: true
  caseSensitiveContains: false

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
        "Apply rules to the library?\n\nThis will create the namespace folder and all generated playlists in your library. If `removeExistingNamespace` is true (default), the existing namespace subtree will be replaced.",
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
              {errorMsg}
            </div>
          )}

          {applyResult && (
            <div className="rules-msg ok">
              ✅ Applied: {applyResult.generatedPlaylistCount} playlists, {applyResult.generatedFolderCount} folders
              {applyResult.removedExisting && " (replaced existing namespace)"}
            </div>
          )}

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
                  <div className="rules-stats">
                    <span><strong>{preview.playlistCount}</strong> playlists</span>
                    <span>·</span>
                    <span><strong>{preview.folderCount}</strong> folders</span>
                    <span>·</span>
                    <span><strong>{preview.referencedTrackCount}</strong> tracks</span>
                  </div>
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
